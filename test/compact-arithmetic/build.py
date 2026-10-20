#!/usr/bin/env python3
"""Build runtime fixtures against a frozen candidate and optional baseline."""
import hashlib
import json
import os
from pathlib import Path
import subprocess

source = Path(__file__).resolve().parent
output = Path(os.environ['COMPACT_TEST_BUILD']).resolve()
output.mkdir(parents=True, exist_ok=True)
compilers = {'candidate': os.environ['TRIPWIRE']}
if os.environ.get('BASELINE_TRIPWIRE'):
    compilers['baseline'] = os.environ['BASELINE_TRIPWIRE']
manifest = {'compilers': {}, 'artifacts': {}, 'sources': {}}
for path in source.iterdir():
    if path.is_file():
        manifest['sources'][path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
for name, command in compilers.items():
    sdk = Path(command).absolute().parent.parent
    native = sdk / 'src/_build/default/exes/moc.exe'
    environment = os.environ.copy()
    for mode, target in [('RELEASE', 'mo-rts.wasm'), ('DEBUG', 'mo-rts-debug.wasm')]:
        environment[f'MOC_{mode}_RTS'] = str(sdk / 'rts' / target)
    manifest['compilers'][name] = {
        'command': command,
        'version': subprocess.check_output([command, '--version'],
            env=environment, text=True).strip(),
        'native_sha256': hashlib.sha256(native.read_bytes()).hexdigest(),
        'release_rts_sha256': hashlib.sha256((sdk / 'rts/mo-rts.wasm').read_bytes()).hexdigest(),
        'debug_rts_sha256': hashlib.sha256((sdk / 'rts/mo-rts-debug.wasm').read_bytes()).hexdigest(),
    }
    for sanity in ([False, True] if name == 'candidate' else [False]):
        label = name + ('-sanity' if sanity else '')
        target = output / f'{label}.wasm'
        arguments = [command, '--enhanced-orthogonal-persistence', '-Werror',
                     '--idl', '-o', str(target)]
        if sanity:
            arguments += ['--sanity-checks']
        arguments += [str(source / 'actor.mo')]
        subprocess.run(arguments, env=environment, check=True)
        manifest['artifacts'][label] = {'file': target.name,
            'sha256': hashlib.sha256(target.read_bytes()).hexdigest(),
            'command': arguments}
for name in ('oracle.json', 'tagged-proof.json', 'oracle-success.mo',
             'oracle-underflow.mo'):
    manifest['sources'][name] = hashlib.sha256((output / name).read_bytes()).hexdigest()
(output / 'build.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(output / 'build.json')
