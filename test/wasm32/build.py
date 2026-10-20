#!/usr/bin/env python3
"""Compile identical API fixtures for both memory widths and retain evidence."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

HERE = Path(__file__).resolve().parent
SDK = HERE.parent.parent
OUT = Path(os.environ['WASM32_BUILD']).resolve()
COMPILER = Path(os.environ['TRIPWIRE']).absolute()
PLUGIN = Path(os.environ['ICWIRE_PLUGIN']).resolve()
FAST = Path(os.environ.get('ICWIRE_FAST_PACKAGE',
    PLUGIN.parent.parent / 'packages/fast/src')).resolve()
ENV = os.environ.copy()
ENV.setdefault('MOC_RELEASE_RTS', str(SDK / 'rts/mo-rts.wasm'))
ENV.setdefault('MOC_DEBUG_RTS', str(SDK / 'rts/mo-rts-debug.wasm'))
OUT.mkdir(parents=True, exist_ok=True)
if (OUT / 'build.json').exists():
    raise FileExistsError(f'Use a fresh evidence directory: {OUT}')
digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
report = {'passed': False, 'inputs': {}, 'runs': [], 'artifacts': {}}


def save():
    (OUT / 'build.json').write_text(json.dumps(report, indent=2) + '\n')


def run(name, command):
    started = time.time()
    result = subprocess.run(command, env=ENV, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, check=False)
    stdout, stderr = OUT / f'{name}.stdout', OUT / f'{name}.stderr'
    stdout.write_bytes(result.stdout)
    stderr.write_bytes(result.stderr)
    report['runs'].append({'name': name, 'command': command,
        'returncode': result.returncode, 'startedUnix': started,
        'wallSeconds': time.time() - started, 'stdout': stdout.name,
        'stderr': stderr.name, 'stdoutSha256': digest(stdout),
        'stderrSha256': digest(stderr)})
    save()
    if result.returncode:
        raise RuntimeError(f'{name} exited {result.returncode}; see {stderr}')


def leb(data, position):
    value, shift = 0, 0
    while True:
        byte = data[position]
        position += 1
        value |= (byte & 127) << shift
        if not byte & 128:
            return value, position
        shift += 7
        assert shift <= 70, 'Invalid unsigned LEB'


def memories(data):
    """Read defined memory limits; actual execution supplies Wasm validation."""
    assert data[:8] == b'\x00asm\x01\x00\x00\x00'
    position, found = 8, []
    while position < len(data):
        section = data[position]
        length, body = leb(data, position + 1)
        end = body + length
        assert end <= len(data)
        if section == 5:
            count, cursor = leb(data, body)
            for _ in range(count):
                flags, cursor = leb(data, cursor)
                minimum, cursor = leb(data, cursor)
                maximum = None
                if flags & 1:
                    maximum, cursor = leb(data, cursor)
                found.append({'memory64': bool(flags & 4), 'flags': flags,
                              'minimum': minimum, 'maximum': maximum})
            assert cursor == end
        position = end
    assert len(found) == 1, f'Expected one defined linear memory: {found}'
    return found


def embedded_modules(data):
    """Extract whole module literals from compiler-emitted data segments."""
    position, found = 8, []
    while position < len(data):
        section = data[position]
        length, body = leb(data, position + 1)
        end = body + length
        if section == 11:
            count, cursor = leb(data, body)
            for _ in range(count):
                flags, cursor = leb(data, cursor)
                assert flags in (0, 1, 2), 'Unknown data segment mode'
                if flags == 2:
                    _, cursor = leb(data, cursor)
                if flags != 1:
                    assert data[cursor] in (0x41, 0x42), \
                        'Expected constant compiler data offset'
                    _, cursor = leb(data, cursor + 1)
                    assert data[cursor] == 0x0b
                    cursor += 1
                size, cursor = leb(data, cursor)
                content = data[cursor:cursor + size]
                assert len(content) == size
                if content.startswith(b'\x00asm\x01\x00\x00\x00'):
                    found.append(content)
                cursor += size
            assert cursor == end
        position = end
    return found


try:
    paths = {COMPILER, Path(ENV['MOC_RELEASE_RTS']),
             Path(ENV['MOC_DEBUG_RTS'])}
    paths.update(path for path in PLUGIN.rglob('*') if path.is_file())
    paths.update(path for path in FAST.rglob('*') if path.is_file())
    paths.update(path for path in HERE.iterdir() if path.is_file())
    paths.update(SDK / 'test/icwire-opt' / name for name in
                 ['runtime.mo', 'inspect.mo'])
    objects = OUT / 'inputs/objects'
    objects.mkdir(parents=True)
    for path in sorted(paths):
        pin = digest(path)
        target = objects / pin
        if not target.exists():
            target.write_bytes(path.read_bytes())
        assert digest(target) == pin
        report['inputs'][str(path)] = {'sha256': pin,
                                     'object': f'inputs/objects/{pin}'}
    save()
    run('version', [str(COMPILER), '--version'])
    variants = [
        ('interop-default', HERE / 'interop.mo', [], False, 32),
        ('interop32', HERE / 'interop.mo', ['--wasm32'], False, 32),
        ('interop64', HERE / 'interop.mo', ['--wasm64'], False, 64),
        ('interop32-compact', HERE / 'interop.mo',
         ['--wasm32', '--icwire-opt', 'compact'], False, 32),
        ('runtime32', SDK / 'test/icwire-opt/runtime.mo',
         ['--wasm32', '--icwire-opt', 'speed'], True, 32),
        ('runtime64', SDK / 'test/icwire-opt/runtime.mo',
         ['--wasm64', '--icwire-opt', 'compact'], True, 64),
        ('inspect32', SDK / 'test/icwire-opt/inspect.mo',
         ['--wasm32'], False, 32),
        ('inspect64', SDK / 'test/icwire-opt/inspect.mo',
         ['--wasm64'], False, 64),
    ]
    for name, source, flags, trap, width in variants:
        target = OUT / f'{name}.wasm'
        command = [str(COMPILER), '--plugin', str(PLUGIN), '--package',
            'fast', str(FAST), '--icwire-internal',
            '--enhanced-orthogonal-persistence', '-Werror', '-g', '--idl',
            *(['--trap-on-candid'] if trap else []), *flags,
            '-o', str(target), str(source)]
        run(name, command)
        memory = memories(target.read_bytes())
        assert memory[0]['memory64'] == (width == 64), (name, memory)
        children = embedded_modules(target.read_bytes())
        assert len(children) == (1 if name.startswith('interop') else 0), \
            f'{name}: unexpected embedded actor-class modules'
        embedded = []
        for index, child in enumerate(children):
            child_memory = memories(child)
            assert child_memory[0]['memory64'] == (width == 64), \
                (name, 'embedded actor class', child_memory)
            child_target = OUT / f'{name}.embedded-{index}.wasm'
            child_target.write_bytes(child)
            embedded.append({'file': child_target.name,
                'bytes': len(child), 'sha256': digest(child_target),
                'memory': child_memory})
        report['artifacts'][name] = {'file': target.name,
            'bytes': target.stat().st_size, 'sha256': digest(target),
            'flags': flags, 'source': str(source), 'memory': memory,
            'embedded': embedded,
            'inspectionRuntimeClaim': False if name.startswith('inspect')
                                      else None}
        save()
    assert report['artifacts']['interop-default']['sha256'] == \
        report['artifacts']['interop32']['sha256'], \
        'Default output must equal explicit --wasm32 output'
    report['defaultEqualsExplicit32'] = True
    for path, item in report['inputs'].items():
        assert digest(Path(path)) == item['sha256'], f'Input changed: {path}'
    report['passed'] = True
    save()
    print(json.dumps({'passed': True, 'artifacts': len(variants),
                      'report': str(OUT / 'build.json')}, indent=2))
except BaseException as error:
    report['error'] = str(error)
    save()
    raise
