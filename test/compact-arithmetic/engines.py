#!/usr/bin/env python3
"""Check the generated arithmetic oracle with all four execution engines."""

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def executable(name, override=None):
    requested = os.environ.get(override, name) if override else name
    found = shutil.which(requested)
    if not found:
        raise RuntimeError(f"Missing executable {requested}; use the build environment")
    return str(Path(found).absolute())


def main():
    source = Path(__file__).resolve().parent
    output = Path(os.environ.get("COMPACT_TEST_BUILD", source / "_build")).resolve()
    logs = output / "engines"
    logs.mkdir(parents=True, exist_ok=True)
    result_file = output / "engines-results.json"
    timeout = float(os.environ.get("COMPACT_ENGINE_TIMEOUT", "180"))
    manifest = {
        "passed": False,
        "runner_sha256": digest(__file__),
        "sources": {},
        "tools": {},
        "artifacts": {},
        "commands": [],
        "checks": [],
        "ir_trap_exit_behavior": (
            "The existing IR interpreters print execution errors but return 0; "
            "their exact arithmetic-overflow diagnostic is required. See "
            "test/trap/ok/subNat64-slow.run-{ir,low}.ok."
        ),
    }
    tracked = {}

    def track(path):
        resolved = Path(path).resolve()
        tracked[str(resolved)] = digest(resolved)
        return {"path": str(resolved), "sha256": tracked[str(resolved)]}

    def run(name, command, expected=0, diagnostic=None):
        stdout = logs / f"{name}.stdout.log"
        stderr = logs / f"{name}.stderr.log"
        record = {
            "name": name,
            "command": command,
            "cwd": str(source),
            "stdout": str(stdout),
            "stderr": str(stderr),
            "expected": expected,
        }
        manifest["commands"].append(record)
        start = time.monotonic()
        print(name, flush=True)
        with stdout.open("wb") as out, stderr.open("wb") as err:
            try:
                process = subprocess.run(
                    command, cwd=source, stdout=out, stderr=err,
                    timeout=timeout, check=False,
                )
                record["returncode"] = process.returncode
            except subprocess.TimeoutExpired:
                record["timed_out"] = True
                raise RuntimeError(f"{name} timed out after {timeout}s") from None
            finally:
                record["seconds"] = time.monotonic() - start
        text = stdout.read_text(errors="replace") + stderr.read_text(errors="replace")
        record["stdout_sha256"] = digest(stdout)
        record["stderr_sha256"] = digest(stderr)
        if re.search(r"\bwarning\s*\[M\d+\]", text, re.IGNORECASE):
            raise RuntimeError(f"{name} emitted a compiler warning; see {stderr}")
        if expected == "nonzero":
            valid = process.returncode > 0
        else:
            valid = process.returncode == expected
        if not valid:
            raise RuntimeError(
                f"{name}: expected {expected}, got {process.returncode}; see {stderr}"
            )
        if diagnostic and not re.search(diagnostic, text, re.IGNORECASE):
            raise RuntimeError(f"{name}: missing Nat-underflow diagnostic; see {stderr}")
        record["passed"] = True
        return text.strip()

    try:
        compiler = executable(os.environ["TRIPWIRE"])
        wasmtime = executable("wasmtime", "WASMTIME")
        validator = executable("wasm-validate", "WASM_VALIDATE")
        for name, tool in (("compiler", compiler), ("wasmtime", wasmtime),
                           ("wasm-validate", validator)):
            manifest["tools"][name] = track(tool)
            manifest["tools"][name]["command"] = tool
            manifest["tools"][name]["version"] = run(
                f"version-{name}", [tool, "--version"]
            )

        sdk = Path(compiler).parent.parent
        native = sdk / "src/moc"
        if native.is_file():
            manifest["tools"]["compiler"]["native"] = track(native)
        for name, variable in (("release_rts", "MOC_RELEASE_RTS"),
                               ("debug_rts", "MOC_DEBUG_RTS")):
            candidate = sdk / "rts" / (
                "mo-rts-debug.wasm" if name == "debug_rts" else "mo-rts.wasm"
            )
            if candidate.is_file():
                manifest["tools"][name] = track(candidate)
            elif os.environ.get(variable):
                manifest["tools"][name] = track(os.environ[variable])

        fixtures = {}
        for case in ("success", "underflow"):
            path = output / f"oracle-{case}.mo"
            if not path.is_file():
                path = source / path.name
            if not path.is_file():
                raise RuntimeError(f"Missing generated oracle fixture: {path}")
            fixtures[case] = str(path)
            manifest["sources"][case] = track(path)
            run(f"check-{case}", [compiler, "--check", "-Werror", str(path)])

        engines = {
            "source": ["-r"],
            "ir": ["-r", "-iR", "-no-async", "-no-await"],
            "lowered": ["-r", "-iR"],
        }
        for engine, flags in engines.items():
            for case, fixture in fixtures.items():
                is_underflow = case == "underflow"
                run(
                    f"{engine}-{case}",
                    [compiler, "-Werror", *flags, fixture],
                    expected=("nonzero" if is_underflow and engine == "source"
                              else 0),
                    diagnostic=(r"execution error,\s*arithmetic overflow"
                                if is_underflow else None),
                )
                manifest["checks"].append({
                    "engine": engine, "case": case, "passed": True,
                })

        for case, fixture in fixtures.items():
            wasm = logs / f"oracle-{case}.wasm"
            run(f"wasi-compile-{case}", [
                compiler, "-Werror", "-g", "-wasi-system-api", "-c",
                fixture, "-o", str(wasm),
            ])
            manifest["artifacts"][case] = track(wasm)
            run(f"wasi-validate-{case}", [
                validator, "--enable-memory64", "--enable-multi-memory", str(wasm),
            ])
            is_underflow = case == "underflow"
            run(
                f"wasi-{case}", [
                    wasmtime, "run", "-C", "cache=n", "-W",
                    "nan-canonicalization=y", "-W", "memory64", "-W",
                    "multi-memory", "-W", "bulk-memory", str(wasm),
                ],
                expected="nonzero" if is_underflow else 0,
                diagnostic=r"Natural subtraction underflow" if is_underflow else None,
            )
            manifest["checks"].append({
                "engine": "wasi", "case": case, "passed": True,
            })

        changed = [path for path, before in tracked.items() if digest(path) != before]
        if changed:
            raise RuntimeError(f"Inputs changed during execution: {changed}")
        manifest["inputs_unchanged"] = True
        manifest["passed"] = True
    except (OSError, KeyError, RuntimeError, ValueError) as error:
        manifest["error"] = str(error)
        print(error, file=sys.stderr)
    finally:
        result_file.write_text(json.dumps(manifest, indent=2) + "\n")
        print(result_file, flush=True)
    return 0 if manifest["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
