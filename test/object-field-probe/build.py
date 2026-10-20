#!/usr/bin/env python3
"""Build field-lookup fixtures with frozen compiler and RTS inputs."""
import hashlib
import json
import os
from pathlib import Path
import subprocess

source = Path(__file__).resolve().parent
output = Path(os.environ['FIELD_TEST_BUILD']).resolve()
output.mkdir(parents=True, exist_ok=True)
digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
compilers = {'candidate': os.environ['TRIPWIRE']}
if os.environ.get('BASELINE_TRIPWIRE'):
    compilers['baseline'] = os.environ['BASELINE_TRIPWIRE']
manifest = {'compilers': {}, 'artifacts': {}, 'sources': {}}
for path in source.iterdir():
    if path.is_file():
        manifest['sources'][path.name] = digest(path)
for name, command in compilers.items():
    sdk = Path(command).absolute().parent.parent
    environment = os.environ.copy()
    for mode, target in [('RELEASE', 'mo-rts.wasm'), ('DEBUG', 'mo-rts-debug.wasm')]:
        environment[f'MOC_{mode}_RTS'] = str(sdk / 'rts' / target)
    files = [Path(command), sdk / 'src/_build/default/exes/moc.exe',
             sdk / 'rts/mo-rts.wasm', sdk / 'rts/mo-rts-debug.wasm']
    manifest['compilers'][name] = {
        'command': command,
        'version': subprocess.check_output([command, '--version'],
            env=environment, text=True).strip(),
        'inputs': {str(path): digest(path) for path in files},
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
            'sha256': digest(target), 'command': arguments}
    for path in files:
        assert digest(path) == manifest['compilers'][name]['inputs'][str(path)]
(output / 'build.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(output / 'build.json')
