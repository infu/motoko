#!/usr/bin/env python3
"""Execute the lowered memory32 unit fixture with memory64 disabled."""

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess


def test_cases():
    cases = []

    def case(name, args=(), expected=None, trap=False):
        cases.append({
            "export": name,
            "args": [str(value) for value in args],
            "expected": expected,
            "trap": trap,
        })

    case("self_check", expected=1)
    case("size", expected=1)
    case("load", [0], expected=0)
    for name, args in [
        ("store", [0, 7]), ("copy", [8, 0, 8]),
        ("fill", [0, 255, 8]), ("init", [0, 0, 3]),
        ("store8", [0, 255]),
    ]:
        case(name, args)
    for name in ["load8u", "load8s"]:
        case(name, [0], expected=0)
    for value, expected in [
        (0, 1), (1, 1), (65534, 1), (65535, -1), (65536, -1),
        (2**31, -1), (2**32, -1), (-1, -1),
    ]:
        case("grow", [value], expected=expected)
    for address in [2**32, 2**32 + 16, -1, 2**63 - 1]:
        for name, args in [
            ("load", [address]), ("store", [address, 1]),
            ("load8u", [address]), ("load8s", [address]),
            ("store8", [address, 1]), ("copy", [address, 0, 1]),
            ("copy", [0, address, 1]), ("fill", [address, 1, 1]),
            ("init", [address, 0, 1]),
        ]:
            case(name, args, trap=True)
    for name, args in [
        ("load", [65535]), ("load", [65536]), ("store", [65535, 1]),
        ("copy", [0, 0, 2**32]), ("copy", [0, 0, -1]),
        ("fill", [0, 1, 2**32]), ("fill", [0, 1, -1]),
        ("init", [0, 0, 4]), ("init", [0, 4, 0]),
        ("load_offset_max", [0]), ("load_offset_max", [1]),
        ("load_offset_over", [0]),
    ]:
        case(name, args, trap=True)
    return cases


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wasm", type=Path, required=True,
                        help="fixture from MEMORY32_TEST_WASM")
    parser.add_argument("--wasmtime", default="wasmtime",
                        help="Wasmtime executable, resolved through PATH")
    parser.add_argument("--output", type=Path,
                        help="write the full JSON result to this file")
    args = parser.parse_args()
    wasm = args.wasm.resolve(strict=True)
    executable = shutil.which(args.wasmtime)
    if executable is None:
        parser.error("Wasmtime not found; set --wasmtime or PATH")
    engine = Path(executable).resolve(strict=True)
    if args.output and args.output.resolve() == wasm:
        parser.error("--output must differ from --wasm")
    rows = []
    for test in test_cases():
        command = [
            str(engine), "run", "-C", "cache=n", "-W", "memory64=n",
            "--invoke", test["export"], "--", str(wasm), *test["args"],
        ]
        result = subprocess.run(command, capture_output=True, text=True)
        if test["trap"]:
            passed = result.returncode != 0 and "wasm trap:" in result.stderr
        elif test["expected"] is None:
            passed = result.returncode == 0 and not result.stdout.strip()
        else:
            passed = (result.returncode == 0
                      and result.stdout.strip() == str(test["expected"]))
        rows.append({
            **test, "command": command, "exit_code": result.returncode,
            "stdout": result.stdout, "stderr": result.stderr, "pass": passed,
        })
    report = {
        "verified": all(row["pass"] for row in rows),
        "engine": str(engine), "engine_sha256": digest(engine),
        "engine_version": subprocess.check_output(
            [str(engine), "--version"], text=True).strip(),
        "module": str(wasm), "module_sha256": digest(wasm),
        "memory64_explicitly_disabled": True,
        "cases": len(rows), "passed": sum(row["pass"] for row in rows),
        "records": rows,
    }
    encoded = json.dumps(report, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded)
        print(json.dumps({
            "verified": report["verified"], "cases": report["cases"],
            "passed": report["passed"], "output": str(args.output),
        }))
    else:
        print(encoded, end="")
    return 0 if report["verified"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
