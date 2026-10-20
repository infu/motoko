#!/usr/bin/env python3
"""Inspect generated Wasm codec policy without a disassembler dependency.

This is a deliberately bounded binary decoder, not a Wasm validator. Unknown
sections, types, element encodings and instructions fail closed. Direct-call
reachability is exact syntactic reachability (including dead branches), not a
claim that every edge executes. Indirect calls are reported separately: their
possible targets cannot establish an endpoint's policy. In particular, a table
index materialized as an integer is not treated as a proven callback edge.

Usage: wasm_policy.py [--export 'canister_*'] [-o report.json] MODULE.wasm ...
"""

import argparse
from collections import Counter
import fnmatch
import hashlib
import json
from pathlib import Path
import re
import sys


class DecodeError(ValueError):
    pass


class Reader:
    def __init__(self, data, base=0):
        self.data = data
        self.pos = 0
        self.base = base

    def fail(self, message):
        raise DecodeError(f"byte {self.base + self.pos}: {message}")

    def take(self, count):
        if count < 0 or self.pos + count > len(self.data):
            self.fail(f"truncated input reading {count} bytes")
        value = self.data[self.pos:self.pos + count]
        self.pos += count
        return value

    def byte(self):
        return self.take(1)[0]

    def integer(self, bits=32, signed=False):
        value = 0
        shift = 0
        while shift < bits:
            byte = self.byte()
            value |= (byte & 0x7f) << shift
            shift += 7
            if not byte & 0x80:
                if signed and byte & 0x40:
                    value -= 1 << shift
                lo = -(1 << (bits - 1)) if signed else 0
                hi = (1 << (bits - int(signed))) - 1
                if not lo <= value <= hi:
                    self.fail(f"out-of-range {'signed' if signed else 'unsigned'} LEB{bits}")
                return value
        self.fail(f"overlong LEB{bits}")

    def text(self):
        try:
            return self.take(self.integer()).decode("utf-8")
        except UnicodeDecodeError:
            self.fail("invalid UTF-8 name")

    def vector(self, read):
        return [read() for _ in range(self.integer())]

    def subreader(self, count):
        base = self.base + self.pos
        return Reader(self.take(count), base)

    def done(self):
        if self.pos != len(self.data):
            self.fail(f"{len(self.data) - self.pos} unconsumed bytes")


VALUE_TYPES = {
    0x7f: "i32", 0x7e: "i64", 0x7d: "f32", 0x7c: "f64",
    0x7b: "v128", 0x70: "funcref", 0x6f: "externref",
}


def value_type(reader):
    byte = reader.byte()
    if byte in VALUE_TYPES:
        return VALUE_TYPES[byte]
    if byte in (0x63, 0x64):
        return {"ref": reader.integer(33, True), "nullable": byte == 0x63}
    reader.fail(f"unsupported value type 0x{byte:02x}")


def limits(reader):
    flags = reader.integer()
    if flags & ~7:
        reader.fail(f"unsupported limits flags {flags}")
    bits = 64 if flags & 4 else 32
    return {"flags": flags, "min": reader.integer(bits),
            "max": reader.integer(bits) if flags & 1 else None}


def table_type(reader):
    return {"element_type": value_type(reader), "limits": limits(reader)}


def global_type(reader):
    typ = value_type(reader)
    mutable = reader.byte()
    if mutable not in (0, 1):
        reader.fail("invalid global mutability")
    return {"type": typ, "mutable": bool(mutable)}


SIMPLE_NAMES = {
    0x00: "unreachable", 0x01: "nop", 0x02: "block", 0x03: "loop",
    0x04: "if", 0x05: "else", 0x0b: "end", 0x0c: "br", 0x0d: "br_if",
    0x0e: "br_table", 0x0f: "return", 0x10: "call", 0x11: "call_indirect",
    0x12: "return_call", 0x13: "return_call_indirect", 0x14: "call_ref",
    0x15: "return_call_ref", 0x1a: "drop", 0x1b: "select",
    0x1c: "select_typed", 0x20: "local.get", 0x21: "local.set",
    0x22: "local.tee", 0x23: "global.get", 0x24: "global.set",
    0x25: "table.get", 0x26: "table.set", 0x3f: "memory.size",
    0x40: "memory.grow", 0x41: "i32.const", 0x42: "i64.const",
    0x43: "f32.const", 0x44: "f64.const", 0xd0: "ref.null",
    0xd1: "ref.is_null", 0xd2: "ref.func", 0xd3: "ref.eq",
    0xd4: "ref.as_non_null", 0xd5: "br_on_null", 0xd6: "br_on_non_null",
}
BULK_NAMES = {
    8: "memory.init", 9: "data.drop", 10: "memory.copy",
    11: "memory.fill", 12: "table.init", 13: "elem.drop",
    14: "table.copy", 15: "table.grow", 16: "table.size", 17: "table.fill",
}


def expression(reader):
    """Decode through the matching end; retain all call and table evidence."""
    stack = ["expression"]
    calls = []
    indirect = []
    references = []
    table_mutations = []
    integer_constants = []
    histogram = Counter()
    while stack:
        offset = reader.base + reader.pos
        op = reader.byte()
        name = SIMPLE_NAMES.get(op, f"0x{op:02x}")
        if op in (0x02, 0x03, 0x04):
            block_type = reader.integer(33, True)
            # ref null/ref shorthand uses an extra heap-type immediate.
            if block_type in (-29, -28):
                reader.integer(33, True)
            elif block_type < 0 and block_type not in (
                    -64, -1, -2, -3, -4, -5, -16, -17):
                reader.fail(f"unsupported block type {block_type}")
            stack.append(name)
        elif op == 0x05:
            if stack[-1] != "if":
                reader.fail("else outside an if, or duplicate else")
            stack[-1] = "else"
        elif op == 0x0b:
            stack.pop()
        elif op in (0x0c, 0x0d, 0xd5, 0xd6):
            reader.integer()
        elif op == 0x0e:
            reader.vector(reader.integer)
            reader.integer()
        elif op in (0x10, 0x12):
            calls.append({"offset": offset, "function": reader.integer(),
                          "tail": op == 0x12})
        elif op in (0x11, 0x13):
            indirect.append({"offset": offset, "type": reader.integer(),
                             "table": reader.integer(), "tail": op == 0x13})
        elif op in (0x14, 0x15):
            indirect.append({"offset": offset, "type": reader.integer(),
                             "table": None, "tail": op == 0x15,
                             "reference_call": True})
        elif op == 0x1c:
            reader.vector(lambda: value_type(reader))
        elif 0x20 <= op <= 0x26:
            index = reader.integer()
            if op == 0x26:
                table_mutations.append({"offset": offset, "operation": name,
                                        "table": index})
        elif 0x28 <= op <= 0x3e:
            alignment = reader.integer()
            if alignment & ~0x3f:
                reader.fail("multi-memory memarg is unsupported")
            reader.integer(64)  # offsets may be memory64 even with small values
        elif op in (0x3f, 0x40):
            reader.integer()
        elif op in (0x41, 0x42):
            integer_constants.append({"offset": offset,
                                      "type": "i32" if op == 0x41 else "i64",
                                      "value": reader.integer(32 if op == 0x41 else 64, True)})
        elif op in (0x43, 0x44):
            reader.take(4 if op == 0x43 else 8)
        elif op == 0xd0:
            reader.integer(33, True)
        elif op == 0xd2:
            references.append({"offset": offset, "function": reader.integer()})
        elif op == 0xfc:
            sub = reader.integer()
            name = BULK_NAMES.get(sub, f"0xfc:{sub}")
            if 0 <= sub <= 7:  # saturating float conversions
                pass
            elif sub in (8, 10, 12, 14):
                first, second = reader.integer(), reader.integer()
                if sub in (12, 14):
                    table_mutations.append({"offset": offset,
                                            "operation": name,
                                            "indices": [first, second]})
            elif sub in (9, 11, 13, 15, 16, 17):
                index = reader.integer()
                if sub in (15, 17):
                    table_mutations.append({"offset": offset,
                                            "operation": name, "table": index})
            else:
                reader.fail(f"unsupported 0xfc instruction {sub}")
        elif op in (0x00, 0x01, 0x0f, 0x1a, 0x1b, 0xd1, 0xd3, 0xd4):
            pass
        elif 0x45 <= op <= 0xc4:  # numeric operators, conversions, sign extension
            pass
        else:
            reader.fail(f"unsupported instruction 0x{op:02x} at byte {offset}")
        histogram[name] += 1
    return {"instruction_count": sum(histogram.values()),
            "instruction_histogram": dict(sorted(histogram.items())),
            "direct_call_sites": calls, "indirect_call_sites": indirect,
            "function_references": references,
            "table_mutations": table_mutations,
            "integer_constants": integer_constants}


def policy(name):
    if name.startswith("@icwire_"):
        return "compact" if re.search(r"_compact(?:_|<|$)", name) else "speed"
    if name.startswith("@callback_icwire"):
        return "compact" if name.startswith("@callback_icwire_compact") else "speed"
    return None


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def inspect(path, export_patterns, include_constants=False):
    data = path.read_bytes()
    reader = Reader(data)
    if reader.take(8) != b"\0asm\x01\0\0\0":
        reader.fail("expected a version 1 WebAssembly module")
    types, functions, imports, exports, tables, elements = [], [], [], [], [], []
    bodies, function_names, sections = [], {}, []
    seen = set()
    while reader.pos < len(data):
        section_id = reader.byte()
        section = reader.subreader(reader.integer())
        sections.append({"id": section_id, "offset": section.base,
                         "size_bytes": len(section.data)})
        if section_id and section_id in seen:
            section.fail(f"duplicate section {section_id}")
        seen.add(section_id)
        if section_id == 0:
            custom_name = section.text()
            sections[-1]["name"] = custom_name
            if custom_name == "name":
                while section.pos < len(section.data):
                    subsection_id = section.byte()
                    subsection = section.subreader(section.integer())
                    if subsection_id == 1:
                        for _ in range(subsection.integer()):
                            index, name = subsection.integer(), subsection.text()
                            if index in function_names:
                                subsection.fail(f"duplicate function name index {index}")
                            function_names[index] = name
                    else:
                        subsection.take(len(subsection.data))
                    subsection.done()
            else:
                section.take(len(section.data) - section.pos)
        elif section_id == 1:
            for _ in range(section.integer()):
                if section.byte() != 0x60:
                    section.fail("only plain function types are supported")
                types.append({"params": section.vector(lambda: value_type(section)),
                              "results": section.vector(lambda: value_type(section))})
        elif section_id == 2:
            for _ in range(section.integer()):
                module, name, kind = section.text(), section.text(), section.byte()
                item = {"module": module, "name": name, "kind": kind}
                if kind == 0:
                    item["function"] = len(functions)
                    item["type"] = section.integer()
                    functions.append({"index": len(functions), "type": item["type"],
                                      "import": {"module": module, "name": name}})
                elif kind == 1:
                    item["table"] = len(tables)
                    tables.append({"index": len(tables), "imported": True,
                                   **table_type(section)})
                elif kind == 2:
                    item["memory"] = limits(section)
                elif kind == 3:
                    item["global"] = global_type(section)
                elif kind == 4:
                    item["tag"] = [section.byte(), section.integer()]
                else:
                    section.fail(f"unknown import kind {kind}")
                imports.append(item)
        elif section_id == 3:
            for typ in section.vector(section.integer):
                functions.append({"index": len(functions), "type": typ})
        elif section_id == 4:
            for _ in range(section.integer()):
                tables.append({"index": len(tables), "imported": False,
                               **table_type(section)})
        elif section_id == 5:
            section.vector(lambda: limits(section))
        elif section_id == 6:
            for _ in range(section.integer()):
                global_type(section)
                expression(section)
        elif section_id == 7:
            for _ in range(section.integer()):
                exports.append({"name": section.text(), "kind": section.byte(),
                                "index": section.integer()})
        elif section_id == 8:
            sections[-1]["start_function"] = section.integer()
        elif section_id == 9:
            for _ in range(section.integer()):
                flags = section.integer()
                if flags > 7:
                    section.fail(f"unsupported element flags {flags}")
                active = flags in (0, 2, 4, 6)
                table = section.integer() if flags in (2, 6) else 0 if active else None
                offset = expression(section) if active else None
                if flags in (1, 2, 3):
                    if section.byte() != 0:
                        section.fail("unsupported element kind")
                elif flags in (5, 6, 7):
                    value_type(section)
                if flags <= 3:
                    entries = section.vector(section.integer)
                else:
                    entries = []
                    for _ in range(section.integer()):
                        expr = expression(section)
                        refs = expr["function_references"]
                        if len(refs) == 1 and expr["instruction_count"] == 2:
                            entries.append(refs[0]["function"])
                        elif expr["instruction_histogram"] == {"end": 1, "ref.null": 1}:
                            entries.append(None)
                        else:
                            section.fail("unsupported element initializer expression")
                constants = offset["integer_constants"] if offset else []
                known_offset = (constants[0]["value"] if offset and
                                offset["instruction_count"] == 2 and
                                len(constants) == 1 else None)
                elements.append({"index": len(elements), "flags": flags,
                                 "active": active, "table": table,
                                 "known_offset": known_offset,
                                 "offset_expression": offset, "functions": entries})
        elif section_id == 10:
            for _ in range(section.integer()):
                body = section.subreader(section.integer())
                body_bytes = body.data
                locals_ = []
                for _ in range(body.integer()):
                    locals_.append({"count": body.integer(), "type": value_type(body)})
                body_result = expression(body)
                body.done()
                bodies.append({"body_offset": body.base,
                               "body_size_bytes": len(body_bytes),
                               "body_sha256": sha256(body_bytes),
                               "locals": locals_, **body_result})
        elif section_id == 11:
            for _ in range(section.integer()):
                flags = section.integer()
                if flags == 0:
                    expression(section)
                elif flags == 2:
                    section.integer()
                    expression(section)
                elif flags != 1:
                    section.fail(f"unsupported data flags {flags}")
                section.take(section.integer())
        elif section_id == 12:
            sections[-1]["data_count"] = section.integer()
        elif section_id == 13:
            section.vector(lambda: [section.byte(), section.integer()])
        else:
            section.fail(f"unsupported section {section_id}")
        section.done()

    defined = [item for item in functions if "import" not in item]
    if len(defined) != len(bodies):
        reader.fail("function and code section lengths differ")
    for function, body in zip(defined, bodies):
        function.update(body)
    for function in functions:
        index = function["index"]
        function["name"] = function_names.get(index, f"func[{index}]")
        function["codec_policy"] = policy(function["name"])
        function["codec_kind"] = ("callback" if function["name"].startswith("@callback_icwire")
                                  else "helper" if function["codec_policy"] else None)
        if function["type"] >= len(types):
            reader.fail(f"function {index} has missing type {function['type']}")
        for call in function.get("direct_call_sites", []) + function.get("function_references", []):
            if call["function"] >= len(functions):
                reader.fail(f"function {index} refers to missing function {call['function']}")
        for call in function.get("indirect_call_sites", []):
            if call["type"] >= len(types) or (call["table"] is not None and call["table"] >= len(tables)):
                reader.fail(f"function {index} has invalid indirect call target")
        function["direct_calls"] = sorted({call["function"] for call in function.get("direct_call_sites", [])})
        if not include_constants:
            function.pop("integer_constants", None)
    for element in elements:
        if element["table"] is not None and element["table"] >= len(tables):
            reader.fail("element refers to missing table")
        for index in element["functions"]:
            if index is not None and index >= len(functions):
                reader.fail("element refers to missing function")
    if set(function_names) - set(range(len(functions))):
        reader.fail("name section refers to missing function")

    def brief(index):
        fun = functions[index]
        return {"index": index, "name": fun["name"],
                "codec_policy": fun["codec_policy"],
                "codec_kind": fun["codec_kind"],
                "body_sha256": fun.get("body_sha256")}

    def reachable(start):
        visited, pending = set(), [start]
        while pending:
            index = pending.pop()
            if index not in visited:
                visited.add(index)
                pending.extend(functions[index]["direct_calls"])
        return sorted(visited)

    # Preserve segment order: a later active segment can overwrite a slot.
    # These are initial contents only; table mutation sites remain visible.
    initial_slots = {}
    for element in elements:
        if element["active"] and element["known_offset"] is not None:
            for relative, target in enumerate(element["functions"]):
                initial_slots[(element["table"], element["known_offset"] + relative)] = target
    table_initializers = [
        {"table": table, "slot": slot,
         "function": brief(target) if target is not None else None}
        for (table, slot), target in sorted(initial_slots.items())]
    callbacks = [brief(f["index"]) for f in functions
                 if f["codec_kind"] == "callback"]
    callback_slots = [entry for entry in table_initializers
                      if entry["function"] and
                      entry["function"]["codec_kind"] == "callback"]

    export_evidence = []
    for export in exports:
        if export["kind"] != 0 or (export_patterns and not any(
                fnmatch.fnmatchcase(export["name"], pat) for pat in export_patterns)):
            continue
        index = export["index"]
        if index >= len(functions):
            reader.fail("export refers to missing function")
        reached = reachable(index)
        indirect_sites = []
        referenced = set()
        for source in reached:
            fun = functions[source]
            referenced.update(item["function"] for item in fun.get("function_references", []))
            for call in fun.get("indirect_call_sites", []):
                # A mutable or imported table can contain other matching functions.
                # Therefore list signature-compatible functions, not only initializers.
                candidates = [f["index"] for f in functions
                              if types[f["type"]] == types[call["type"]]]
                indirect_sites.append({"source_function": source, **call,
                                       "signature_compatible_candidates": candidates,
                                       "proves_actual_target": False})
        codec_functions = [brief(i) for i in reached if functions[i]["codec_policy"]]
        export_evidence.append({**export, "function": brief(index),
                                "direct_reachable_functions": reached,
                                "direct_reachable_count": len(reached),
                                "direct_reachable_codec_functions": codec_functions,
                                "direct_reachable_codec_policy_counts": dict(Counter(
                                    item["codec_policy"] for item in codec_functions)),
                                "referenced_functions": [brief(i) for i in sorted(referenced)],
                                "indirect_calls": indirect_sites,
                                "has_unresolved_indirect_calls": bool(indirect_sites)})
    name_counts = Counter(function["name"] for function in functions)
    return {"path": str(path.resolve()), "size_bytes": len(data),
            "sha256": sha256(data), "sections": sections, "types": types,
            "imports": imports, "exports": exports, "tables": tables,
            "elements": elements, "initial_table_slots": table_initializers,
            "functions": functions, "codec_callbacks": callbacks,
            "initial_codec_callback_slots": callback_slots,
            "codec_functions": [brief(f["index"]) for f in functions if f["codec_policy"]],
            "duplicate_function_names": {name: count for name, count in name_counts.items() if count > 1},
            "export_evidence": export_evidence}


def assert_icwire_fixture(module, variant):
    """Assert the named runtime.mo corpus, without resolving indirect calls.

    Export wrappers prove entry decoding; the separately named topLevel proves
    its own encoder choice. Callback decoder bodies and both policy-specific
    identities prove that mixed policies did not reuse the first callback.
    Method-body/reply/async closure target selection still needs runtime tests
    or a separate closure-flow proof; matching signatures are not that proof.
    """
    variant = variant.removesuffix("-reversed")
    if variant not in {"default", "speed", "compact", "query",
                       "query-override", "mixed-hot", "mixed-cold"}:
        raise DecodeError(f"unknown ICWire runtime fixture variant {variant!r}")
    compact = "compact"
    speed = "speed"
    global_policy = compact if variant in {"compact", "query", "mixed-hot"} else speed
    selected = {name: global_policy for name in (
        "hot", "cold", "queryValue", "compositeValue", "forwardHot", "forwardCold")}
    if variant in {"query", "query-override", "mixed-hot"}:
        selected.update(queryValue=speed, compositeValue=speed)
    if variant == "mixed-hot":
        selected.update(hot=speed, forwardHot=speed, queryValue=compact)
    if variant == "mixed-cold":
        selected.update(cold=compact, forwardCold=compact, compositeValue=compact)
    functions = module["functions"]
    checks = []

    def check(index, expected, purpose):
        visited, pending = set(), [index]
        while pending:
            target = pending.pop()
            if target not in visited:
                visited.add(target)
                pending.extend(functions[target]["direct_calls"])
        codecs = [functions[i] for i in sorted(visited) if functions[i]["codec_policy"]]
        policies = {fun["codec_policy"] for fun in codecs}
        if policies != {expected}:
            raise DecodeError(f"{variant} {purpose}: expected only {expected} helpers, got {sorted(policies)}")
        if "decoder" in purpose and not any(
                fun["codec_kind"] == "helper" and "decode" in fun["name"]
                for fun in codecs):
            raise DecodeError(f"{variant} {purpose}: no reachable decoder helper")
        checks.append({"purpose": purpose, "root_function": index,
                       "expected_policy": expected,
                       "reachable_codec_functions": [fun["index"] for fun in codecs],
                       "passed": True})

    for name, expected in selected.items():
        roots = [item["index"] for item in module["exports"]
                 if item["kind"] == 0 and item["name"].endswith(" " + name)]
        if len(roots) != 1:
            raise DecodeError(f"{variant}: expected exactly one exported {name}")
        check(roots[0], expected, f"{name} entry decoder")
    top_level = [fun["index"] for fun in functions if fun["name"] == "topLevel"]
    if len(top_level) != 1:
        raise DecodeError(f"{variant}: expected one topLevel helper")
    check(top_level[0], global_policy, "topLevel encoder follows global policy")

    callback_schemas = {}
    for callback in module["codec_callbacks"]:
        name = callback["name"]
        if "<" not in name:
            raise DecodeError(f"callback name has no schema: {name}")
        schema = name[name.index("<"):]
        callback_schemas.setdefault(schema, {}).setdefault(callback["codec_policy"], []).append(callback["index"])
        check(callback["index"], callback["codec_policy"], f"{name} callback decoder")
    expected_callbacks = {speed, compact} if variant in {"query", "mixed-hot", "mixed-cold"} else {global_policy}
    if not callback_schemas:
        raise DecodeError(f"{variant}: no ICWire callbacks found")
    for schema, by_policy in callback_schemas.items():
        if set(by_policy) != expected_callbacks or any(len(indices) != 1 for indices in by_policy.values()):
            raise DecodeError(f"{variant}: callback cache identity mismatch for {schema}: {by_policy}")
    module["fixture_assertions"] = {
        "variant": variant, "passed": True, "checks": checks,
        "callback_schemas": callback_schemas,
        "scope": "entry decoders, named top-level encoder, callback identities and decoder bodies",
        "unproven_statically": "indirect method-body, reply and async closure target selection",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wasm", type=Path, nargs="+")
    parser.add_argument("--export", action="append", default=[],
                        help="fnmatch pattern for exported function evidence (repeatable)")
    parser.add_argument("--include-integer-constants", action="store_true",
                        help="retain constants to investigate callback-table slot materialization")
    parser.add_argument("--assert-icwire-fixture", action="store_true",
                        help="assert runtime.mo policies using each input's standard variant filename")
    parser.add_argument("-o", "--output", type=Path)
    args = parser.parse_args()
    try:
        modules = [inspect(path, args.export, args.include_integer_constants) for path in args.wasm]
        if args.assert_icwire_fixture:
            for path, module in zip(args.wasm, modules):
                assert_icwire_fixture(module, path.stem)
    except (OSError, DecodeError) as error:
        print(f"wasm_policy: {error}", file=sys.stderr)
        return 1
    result = {"format_version": 1, "decoder_sha256": sha256(Path(__file__).read_bytes()),
              "analysis": "syntactic direct calls; indirect calls explicitly unresolved",
              "modules": modules}
    encoded = json.dumps(result, indent=2, ensure_ascii=False) + "\n"
    if args.output:
        args.output.write_text(encoded)
    else:
        sys.stdout.write(encoded)
    return 0


if __name__ == "__main__":
    sys.exit(main())
