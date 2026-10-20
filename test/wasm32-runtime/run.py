#!/usr/bin/env python3
"""Compile memory targets and retain actual process exits for runtime checks."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
SDK = HERE.parent.parent
OUT = Path(os.environ['WASM32_RUNTIME_BUILD']).resolve()
OUT.mkdir(parents=True, exist_ok=True)
if (OUT / 'process-results.json').exists():
    raise FileExistsError(f'Use a fresh evidence directory: {OUT}')
COMPILER = Path(os.environ['TRIPWIRE']).resolve()
PLUGIN = Path(os.environ['ICWIRE_PLUGIN']).resolve()
SANITY = os.environ.get('WASM32_RUNTIME_SANITY', '1')
if SANITY not in {'0', '1'}:
    raise ValueError('WASM32_RUNTIME_SANITY must be 0 or 1')
ENV = os.environ.copy()
ENV.setdefault('MOC_RELEASE_RTS', str(SDK / 'rts/mo-rts.wasm'))
ENV.setdefault('MOC_DEBUG_RTS', str(SDK / 'rts/mo-rts-debug.wasm'))
digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
inputs = [COMPILER, Path(ENV['MOC_RELEASE_RTS']),
          Path(ENV['MOC_DEBUG_RTS'])]
inputs += sorted(p for p in PLUGIN.rglob('*') if p.is_file())
inputs += sorted(p for p in HERE.iterdir() if p.is_file())
report = {'passed': False, 'sanityChecks': SANITY == '1',
          'processes': [], 'artifacts': {},
          'inputs': {str(p): digest(p) for p in inputs}}


def save():
    (OUT / 'process-results.json').write_text(
        json.dumps(report, indent=2) + '\n')


def run(name, command):
    result = subprocess.run(command, env=ENV, capture_output=True, check=False)
    stdout, stderr = OUT / f'{name}.stdout', OUT / f'{name}.stderr'
    stdout.write_bytes(result.stdout)
    stderr.write_bytes(result.stderr)
    report['processes'].append({'name': name, 'command': command,
        'returncode': result.returncode, 'stdout': stdout.name,
        'stderr': stderr.name, 'stdoutSha256': digest(stdout),
        'stderrSha256': digest(stderr)})
    save()
    if result.returncode:
        raise RuntimeError(f'{name} exited {result.returncode}; see {stderr}')


try:
    for name, flags in [('default', []), ('wasm32', ['--wasm32']),
                        ('wasm64', ['--wasm64'])]:
        wasm = OUT / f'{name}.wasm'
        run(name, [str(COMPILER), '--plugin', str(PLUGIN),
            '--icwire-internal', '--trap-on-candid',
            '--enhanced-orthogonal-persistence',
            *(['--sanity-checks'] if SANITY == '1' else []),
            '--force-gc', '-A=M0270', '-Werror', '-g', *flags, '-o', str(wasm),
            str(HERE / 'actor.mo')])
        report['artifacts'][name] = {'file': wasm.name,
            'bytes': wasm.stat().st_size, 'sha256': digest(wasm)}
        save()
    assert (OUT / 'default.wasm').read_bytes() == (
        OUT / 'wasm32.wasm').read_bytes(), 'Default is not explicit wasm32'
    run('runtime', ['node', str(HERE / 'runtime.mjs')])
    runtime = json.loads((OUT / 'runtime-results.json').read_text())
    assert runtime['passed'] is True
    assert runtime['gcVerified'] == ['wasm32', 'wasm64']
    assert runtime['upgradesVerified'] == [
        'wasm32-to-wasm32', 'wasm32-to-wasm64', 'wasm64-to-wasm32']
    for path, pin in report['inputs'].items():
        assert digest(Path(path)) == pin, f'Input changed: {path}'
    report['runtimeSha256'] = digest(OUT / 'runtime-results.json')
    report['passed'] = True
    save()
    print(json.dumps(report, indent=2))
except BaseException as error:
    report['error'] = str(error)
    save()
    raise
