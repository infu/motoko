#!/usr/bin/env python3
"""Run field semantics through interpreters and the compiled Wasm engine."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

source = Path(__file__).resolve().parent
output = Path(os.environ['FIELD_TEST_BUILD']).resolve()
logs = output / 'engines'
logs.mkdir(parents=True, exist_ok=True)
digest = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()
compiler = os.environ['TRIPWIRE']
wasmtime = shutil.which(os.environ.get('WASMTIME', 'wasmtime'))
validator = shutil.which(os.environ.get('WASM_VALIDATE', 'wasm-validate'))
assert wasmtime and validator, 'Run engines.py in the compiler build environment'
sdk = Path(compiler).absolute().parent.parent
inputs = [Path(compiler), sdk / 'src/_build/default/exes/moc.exe',
          sdk / 'rts/mo-rts.wasm', sdk / 'rts/mo-rts-debug.wasm',
          source / 'pure.mo', source / 'cases.mo', Path(wasmtime), Path(validator)]
report = {'status': 'running', 'inputs': {str(path): digest(path) for path in inputs},
          'commands': [], 'passed': []}


def run(name, arguments, result=False):
    target = logs / f'{name}.log'
    with target.open('w') as stream:
        process = subprocess.run(arguments, cwd=source, stdout=stream,
                                 stderr=subprocess.STDOUT, timeout=180)
    text = target.read_text()
    record = {'name': name, 'command': arguments, 'exit_code': process.returncode,
              'log': str(target), 'sha256': digest(target)}
    report['commands'].append(record)
    assert process.returncode == 0, record
    assert not re.search(r'warning\s*\[M\d+\]', text, re.IGNORECASE), record
    if result:
        assert 'object-field-probe: passed' in text, record
        assert not re.search(r'execution error|assertion failure', text,
                             re.IGNORECASE), record
        report['passed'].append(name)


try:
    for name, flags in [('source', ['-r']),
                        ('ir', ['-r', '-iR', '-no-async', '-no-await']),
                        ('lowered', ['-r', '-iR'])]:
        run(name, [compiler, '-Werror', *flags, str(source / 'pure.mo')], True)
    target = logs / 'pure.wasm'
    run('compile', [compiler, '-Werror', '-g', '-wasi-system-api', '-c',
                    str(source / 'pure.mo'), '-o', str(target)])
    run('validate', [validator, '--enable-memory64', '--enable-multi-memory',
                     str(target)])
    run('wasi', [wasmtime, 'run', '-C', 'cache=n', '-W',
                 'nan-canonicalization=y', '-W', 'memory64', '-W',
                 'multi-memory', '-W', 'bulk-memory', str(target)], True)
    report['wasm'] = {'path': str(target), 'sha256': digest(target)}
    assert report['inputs'] == {str(path): digest(path) for path in inputs}
    report['inputs_unchanged'] = True
    report['status'] = 'passed'
finally:
    (output / 'engines-results.json').write_text(json.dumps(report, indent=2) + '\n')
