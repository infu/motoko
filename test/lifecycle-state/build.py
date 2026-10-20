#!/usr/bin/env python3
"""Build lifecycle fixtures with the candidate and optional baseline compiler."""
import hashlib
import json
import os
from pathlib import Path
import subprocess

source = Path(__file__).resolve().parent
output = Path(os.environ.get('LIFECYCLE_TEST_BUILD', source / '_build')).resolve()
output.mkdir(parents=True, exist_ok=True)
compilers = {'candidate': os.environ['TRIPWIRE']}
if os.environ.get('BASELINE_TRIPWIRE'):
    compilers['baseline'] = os.environ['BASELINE_TRIPWIRE']
manifest = {'sources': {}, 'compilers': {}, 'artifacts': {}}
for name in ('actor.mo', 'stabilization.mo', 'build.py', 'runtime.mjs'):
    manifest['sources'][name] = hashlib.sha256((source / name).read_bytes()).hexdigest()
for name, executable in compilers.items():
    environment = os.environ.copy()
    compiler = Path(executable).resolve()
    sdk = Path(executable).absolute().parent.parent
    environment['MOC_RELEASE_RTS'] = str(sdk / 'rts/mo-rts.wasm')
    environment['MOC_DEBUG_RTS'] = str(sdk / 'rts/mo-rts-debug.wasm')
    version = subprocess.check_output([executable, '--version'], env=environment, text=True).strip()
    native = sdk / 'src/_build/default/exes/moc.exe'
    manifest['compilers'][name] = {
        'command': executable, 'version': version,
        'wrapper_sha256': hashlib.sha256(compiler.read_bytes()).hexdigest(),
        'native_sha256': hashlib.sha256(native.read_bytes()).hexdigest(),
        'rts_sha256': hashlib.sha256((sdk / 'rts/mo-rts.wasm').read_bytes()).hexdigest(),
    }
    for fixture in ('actor', 'stabilization'):
        target = output / f'{name}-{fixture}.wasm'
        arguments = [executable, '--enhanced-orthogonal-persistence', '-Werror', '--idl']
        if fixture == 'stabilization':
            arguments += ['--stabilization-instruction-limit=10000',
                          '--stable-memory-access-limit=4096']
        arguments += ['-o', str(target), str(source / f'{fixture}.mo')]
        print('Building', name, fixture, flush=True)
        subprocess.run(arguments, env=environment, check=True)
        manifest['artifacts'][target.name] = {
            'sha256': hashlib.sha256(target.read_bytes()).hexdigest(),
            'command': arguments,
        }
(output / 'build.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(output / 'build.json')
