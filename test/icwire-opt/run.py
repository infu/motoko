#!/usr/bin/env python3
"""Record compiler, Node and Wasm audit process exits before parsing reports."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--skip-build', action='store_true')
args = parser.parse_args()
here = Path(__file__).resolve().parent
out = Path(os.environ.get('ICWIRE_OPT_BUILD', here / '_build')).resolve()
out.mkdir(parents=True, exist_ok=True)
report = {'passed': False, 'processes': []}
digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()


def save():
    (out / 'process-results.json').write_text(json.dumps(report, indent=2) + '\n')


def run(name, command):
    result = subprocess.run(command, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, check=False)
    stdout, stderr = out / f'{name}-process.stdout', out / f'{name}-process.stderr'
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
    if not args.skip_build:
        run('build', [sys.executable, str(here / 'build.py')])
    build_report = json.loads((out / 'build.json').read_text())
    assert build_report['passed'] is True, 'Compiler input freeze did not pass'
    # Preserve the real Node exit code before reading runtime-results.json.
    run('runtime', ['node', str(here / 'runtime.mjs')])
    runtime = json.loads((out / 'runtime-results.json').read_text())
    assert runtime['passed'] is True
    report['runtime'] = {'tests': len(runtime['tests']),
                         'calls': len(runtime['calls']),
                         'reportSha256': digest(out / 'runtime-results.json')}
    artifacts = json.loads((out / 'build.json').read_text())['artifacts']
    run('wasm-policy', [sys.executable, str(here / 'wasm_policy.py'),
        '--export', 'canister_*', '--assert-icwire-fixture',
        '-o', str(out / 'wasm-policy.json'),
        *[str(out / item['file']) for name, item in artifacts.items()
          if name not in {'class', 'inspect'}]])
    run('wasm-extra', [sys.executable, str(here / 'wasm_policy.py'),
        '--export', 'canister_*', '-o', str(out / 'wasm-extra.json'),
        *[str(out / artifacts[name]['file']) for name in ['class', 'inspect']]])
    report['passed'] = True
    save()
    print(json.dumps(report, indent=2))
except BaseException as error:
    report['error'] = str(error)
    save()
    raise
