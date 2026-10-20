#!/usr/bin/env python3
"""Build policy fixtures and retain every compiler exit before checking it."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
OUT = Path(os.environ.get('ICWIRE_OPT_BUILD', HERE / '_build')).resolve()
OUT.mkdir(parents=True, exist_ok=True)
if (OUT / 'build.json').exists():
    raise FileExistsError(f'Use a fresh evidence directory: {OUT}')
COMPILER = Path(os.environ['TRIPWIRE']).absolute()
PLUGIN = Path(os.environ['ICWIRE_PLUGIN']).resolve()
SDK = HERE.parent.parent
FAST = Path(os.environ.get('ICWIRE_FAST_PACKAGE',
    PLUGIN.parent.parent / 'packages/fast/src')).resolve()
ENV = os.environ.copy()
ENV.setdefault('MOC_RELEASE_RTS', str(SDK / 'rts/mo-rts.wasm'))
ENV.setdefault('MOC_DEBUG_RTS', str(SDK / 'rts/mo-rts-debug.wasm'))
digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()

inputs = [COMPILER, SDK / 'src/_build/default/exes/moc.exe',
          Path(ENV['MOC_RELEASE_RTS']), Path(ENV['MOC_DEBUG_RTS'])]
inputs += sorted(path for path in PLUGIN.rglob('*') if path.is_file())
inputs += sorted(path for path in FAST.rglob('*') if path.is_file())
inputs += sorted(path for path in HERE.iterdir() if path.is_file())
pins = {str(path): digest(path) for path in inputs}
report = {'inputs': pins, 'runs': [], 'artifacts': {},
          'scope': 'Endpoint > query/composite group > global; default speed.'}
# Retain exact input bytes, including fixtures, independently of later edits.
objects = OUT / 'inputs/objects'
objects.mkdir(parents=True, exist_ok=True)
for path, pin in pins.items():
    target = objects / pin
    if not target.exists():
        target.write_bytes(Path(path).read_bytes())
    assert digest(target) == pin
report['inputObjects'] = {path: f'inputs/objects/{pin}'
                          for path, pin in pins.items()}


def save():
    (OUT / 'build.json').write_text(json.dumps(report, indent=2) + '\n')


def run(name, arguments, success=True, diagnostic=None):
    started = time.time()
    result = subprocess.run(arguments, env=ENV, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, check=False)
    stdout, stderr = OUT / f'{name}.stdout', OUT / f'{name}.stderr'
    stdout.write_bytes(result.stdout)
    stderr.write_bytes(result.stderr)
    record = {'name': name, 'command': list(map(str, arguments)),
              'returncode': result.returncode,
              'stdout': stdout.name, 'stderr': stderr.name,
              'stdoutSha256': digest(stdout), 'stderrSha256': digest(stderr),
              'startedUnix': started, 'wallSeconds': time.time() - started,
              'expectedSuccess': success}
    report['runs'].append(record)
    save()  # Keep the actual status/logs even if validation below fails.
    if (result.returncode == 0) != success:
        raise AssertionError(f'{name}: unexpected exit {result.returncode}: '
                             f'{result.stderr.decode(errors="replace")}')
    if diagnostic and not re.search(diagnostic,
            result.stderr.decode(errors='replace'), re.I):
        raise AssertionError(f'{name}: expected diagnostic /{diagnostic}/')
    return result


def reverse_methods(text):
    """Move equal-schema endpoints and callbacks before their opposite level."""
    for first, second in [('hot', 'cold'), ('forwardHot', 'forwardCold')]:
        blocks = []
        for name in [first, second]:
            start = text.index(f'  public shared icwire func {name}(')
            body = text.index('{', start)
            depth, end = 1, body + 1
            while depth:
                depth += (text[end] == '{') - (text[end] == '}')
                end += 1
            if text[end] == ';':
                end += 1
            blocks.append((start, end, text[start:end]))
        (a, b, left), (c, d, right) = sorted(blocks)
        text = text[:a] + right + text[b:c] + left + text[d:]
    return text


def build(name, flags, source=HERE / 'runtime.mo'):
    target = OUT / f'{name}.wasm'
    args = [str(COMPILER), '--plugin', str(PLUGIN), '--package', 'fast',
            str(FAST), '--icwire-internal', '--trap-on-candid',
            '--enhanced-orthogonal-persistence', '-Werror', '-g', '--idl',
            *flags, '-o', str(target), str(source)]
    run(name, args)
    report['artifacts'][name] = {'file': target.name, 'bytes': target.stat().st_size,
        'sha256': digest(target), 'source': str(source),
        'sourceSha256': digest(source), 'flags': flags}
    save()


try:
    run('version', [str(COMPILER), '--version'])
    variants = {
        'default': [],
        'speed': ['--icwire-opt', 'speed'],
        'compact': ['--icwire-opt', 'compact'],
        'query': ['--icwire-opt', 'compact', '--icwire-opt-query', 'speed'],
        'query-override': ['--icwire-opt', 'speed', '--icwire-opt-query', 'compact',
            '--icwire-opt-endpoint', 'queryValue=speed',
            '--icwire-opt-endpoint', 'compositeValue=speed'],
        'mixed-hot': ['--icwire-opt', 'compact', '--icwire-opt-query', 'speed',
            '--icwire-opt-endpoint', 'hot=speed',
            '--icwire-opt-endpoint', 'forwardHot=speed',
            '--icwire-opt-endpoint', 'defaultApis=speed',
            '--icwire-opt-endpoint', 'asyncApis=speed',
            '--icwire-opt-endpoint', 'helper=speed',
            '--icwire-opt-endpoint', 'queryValue=compact'],
        'mixed-cold': ['--icwire-opt', 'speed', '--icwire-opt-query', 'compact',
            '--icwire-opt-endpoint', 'cold=compact',
            '--icwire-opt-endpoint', 'forwardCold=compact',
            '--icwire-opt-endpoint', 'defaultApis=compact',
            '--icwire-opt-endpoint', 'asyncApis=compact',
            '--icwire-opt-endpoint', 'helper=compact',
            '--icwire-opt-endpoint', 'queryValue=speed'],
    }
    for name, flags in variants.items():
        build(name, flags)
    reversed_source = OUT / 'runtime-reversed.mo'
    reversed_source.write_text(reverse_methods((HERE / 'runtime.mo').read_text()))
    build('mixed-hot-reversed', variants['mixed-hot'], reversed_source)
    build('mixed-cold-reversed', variants['mixed-cold'], reversed_source)
    build('inspect', ['--icwire-opt', 'compact', '--icwire-opt-query', 'speed',
          '--icwire-opt-endpoint', 'hot=speed'], HERE / 'inspect.mo')
    build('class', ['--icwire-opt', 'compact', '--icwire-opt-endpoint',
          'hot=speed'], HERE / 'class.mo')

    base = [str(COMPILER), '--plugin', str(PLUGIN), '--package', 'fast',
            str(FAST), '--icwire-internal', '-Werror']
    negatives = {
        'bad-global': ['--icwire-opt', 'turbo'],
        'bad-query': ['--icwire-opt-query', 'turbo'],
        'bad-endpoint-level': ['--icwire-opt-endpoint', 'hot=turbo'],
        'bad-endpoint-format': ['--icwire-opt-endpoint', 'hot'],
        'empty-endpoint': ['--icwire-opt-endpoint', '=speed'],
        'duplicate-endpoint': ['--icwire-opt-endpoint', 'hot=speed',
                               '--icwire-opt-endpoint', 'hot=compact'],
        'unknown-endpoint': ['--icwire-opt-endpoint', 'absent=compact'],
        'candid-endpoint': ['--icwire-opt-endpoint', 'candid=compact'],
    }
    for name, flags in negatives.items():
        run(name, [*base, *flags, '-o', str(OUT / f'{name}.wasm'),
                   str(HERE / 'runtime.mo')], False, r'icwire|endpoint')
    run('plain-endpoint', [*base, '--icwire-opt-endpoint', 'hot=compact',
        '-o', str(OUT / 'plain-endpoint.wasm'), str(HERE / 'plain.mo')],
        False, r'icwire|endpoint|actor')
    for path, pin in pins.items():
        if digest(Path(path)) != pin:
            raise AssertionError(f'Input changed during compilation: {path}')
    report['passed'] = True
    save()
    print(json.dumps({'passed': True, 'build': str(OUT / 'build.json'),
                      'artifacts': len(report['artifacts']),
                      'runs': len(report['runs'])}, indent=2))
except BaseException as error:
    report['passed'] = False
    report['error'] = str(error)
    save()
    raise
