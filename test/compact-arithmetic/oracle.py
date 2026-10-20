#!/usr/bin/env python3
"""Independent arbitrary-precision oracle and exhaustive tagged-word proof."""
import argparse
import hashlib
import itertools
import json
from pathlib import Path
import random


def tagged_proof():
    count = 0
    for bits in range(4, 13):
        mask = (1 << bits) - 1
        sign = 1 << (bits - 1)
        limit = 1 << (bits - 3)
        for left in range(-limit, limit):
            for right in range(-limit, limit):
                a, b = (4 * left + 2) & mask, (4 * right + 2) & mask
                for subtract in (False, True):
                    result = (a - b + 2 if subtract else a + b - 2) & mask
                    overflow = bool(((a ^ b) & (a ^ result) if subtract
                                     else (a ^ result) & (b ^ result)) & sign)
                    expected = left - right if subtract else left + right
                    assert overflow == (not -limit <= expected < limit)
                    if not overflow:
                        signed = result - (1 << bits) if result & sign else result
                        assert signed >> 2 == expected
                    count += 1
    rng = random.Random(5817)
    limit, mask, sign = 1 << 61, (1 << 64) - 1, 1 << 63
    edges = [-limit, -limit + 1, -limit + 2, -(1 << 30), -1, 0, 1,
             2, (1 << 30) - 1, 1 << 30, limit - 3, limit - 2, limit - 1]
    for _ in range(100_000):
        left = rng.choice(edges) if rng.randrange(2) else rng.randrange(-limit, limit)
        right = rng.choice(edges) if rng.randrange(2) else rng.randrange(-limit, limit)
        a, b = (4 * left + 2) & mask, (4 * right + 2) & mask
        for subtract in (False, True):
            result = (a - b + 2 if subtract else a + b - 2) & mask
            overflow = bool(((a ^ b) & (a ^ result) if subtract
                             else (a ^ result) & (b ^ result)) & sign)
            expected = left - right if subtract else left + right
            assert overflow == (not -limit <= expected < limit)
            count += 1
    return {'checked_predicates': count, 'seed': 5817,
            'toy_word_bits': [4, 12], 'random_64bit_pairs': 100_000,
            'compact_payload_bits': 62, 'tag': 2, 'shift': 2}


def cases():
    rng = random.Random(19731023)
    limit = 1 << 61
    compact = [-limit, -limit + 1, -limit + 2, -(1 << 60),
               -(1 << 30) - 1, -(1 << 30), -(1 << 30) + 1, -2, -1,
               0, 1, 2, (1 << 30) - 1, 1 << 30, (1 << 30) + 1,
               1 << 60, limit - 3, limit - 2, limit - 1]
    large = sorted({sign * ((1 << power) + delta)
                    for power in [61, 62, 63, 64, 127, 128, 129, 255, 256]
                    for delta in [-1, 0, 1] for sign in [-1, 1]})
    signed = set(itertools.product(compact, repeat=2))
    for value in large:
        for small in [-limit, -1, 0, 1, limit - 1]:
            signed.add((value, small))
            signed.add((small, value))
        for other in [-value - 1, -value, -value + 1, value - 1, value, value + 1]:
            signed.add((value, other))
    for _ in range(512):
        bits = rng.choice([30, 31, 61, 62, 63, 64, 128, 256])
        signed.add((rng.randrange(-(1 << bits), 1 << bits),
                    rng.randrange(-(1 << bits), 1 << bits)))
    natural_edges = sorted({0, 1, 2} | {
        (1 << power) + delta for power in [29, 30, 31, 60, 61, 62, 63, 64, 128, 256]
        for delta in [-1, 0, 1]})
    natural = set(itertools.product(natural_edges, repeat=2))
    for _ in range(256):
        natural.add((rng.getrandbits(rng.choice([31, 61, 62, 128, 256])),
                     rng.getrandbits(rng.choice([31, 61, 62, 128, 256]))))
    underflow = {(0, 1), (limit - 2, limit - 1), (1 << 60, (1 << 60) + 1)}
    for power in [30, 31, 60, 61, 62, 63, 64, 128, 256]:
        underflow.add(((1 << power) - 1, 1 << power))
        underflow.add((1 << power, (1 << power) + 1))
    signed_rows = [{'a': str(a), 'b': str(b), 'add': str(a + b), 'sub': str(a - b)}
                   for a, b in sorted(signed)]
    natural_rows = [{'a': str(a), 'b': str(b), 'add': str(a + b),
                    'sub': str(a - b) if a >= b else None}
                   for a, b in sorted(natural)]
    retained = [row for row in signed_rows if max(abs(int(row['a'])),
                abs(int(row['b']))) >= 1 << 127][::7][:64]
    return {'seed': 19731023, 'signed': signed_rows, 'natural': natural_rows,
            'underflow': [[str(a), str(b)] for a, b in sorted(underflow)],
            'retained': retained, 'churn': {'count': 40000,
            'salt': str(1 << 256), 'last': str((1 << 256) + 39999)}}


def fixture(data):
    lines = ['import Prim "mo:prim";',
             'let signed : [(Int, Int, Int, Int)] = [']
    lines += [f"  ({r['a']}, {r['b']}, {r['add']}, {r['sub']}),"
              for r in data['signed']]
    lines += ['];', 'var index = 0;', 'while (index < signed.size()) {',
              '  let (a, b, sum, difference) = signed[index];',
              '  assert a + b == sum;', '  assert a - b == difference;',
              '  index += 1;', '};', 'let natural : [(Nat, Nat, Nat, ?Nat)] = [']
    lines += [f"  ({r['a']}, {r['b']}, {r['add']}, " +
              (f"?{r['sub']}" if r['sub'] is not None else 'null') + '),'
              for r in data['natural']]
    lines += ['];', 'index := 0;', 'while (index < natural.size()) {',
              '  let (a, b, sum, difference) = natural[index];',
              '  assert a + b == sum;',
              '  switch difference {case (?expected) assert (a - b : Nat) == expected;',
              '    case null assert a < b};', '  index += 1;', '};',
              'Prim.debugPrint("compact arithmetic oracle passed");']
    return '\n'.join(lines) + '\n'


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    proof, data = tagged_proof(), cases()
    data['generator_sha256'] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    (args.output / 'tagged-proof.json').write_text(json.dumps(proof, indent=2) + '\n')
    (args.output / 'oracle.json').write_text(json.dumps(data, indent=2) + '\n')
    (args.output / 'oracle-success.mo').write_text(fixture(data))
    (args.output / 'oracle-underflow.mo').write_text(
        'import Prim "mo:prim";\n'
        'func subtract(a : Nat, b : Nat) : Nat {a - b};\n'
        'let values : [Nat] = [0, 1];\n'
        'var index = 0;\n'
        'while (index < values.size()) {\n'
        '  ignore subtract(values[index], values[1]);\n'
        '  index += 1;\n'
        '};\nPrim.trap("expected subtraction underflow");\n')
    print(json.dumps({'signed_pairs': len(data['signed']),
                      'natural_pairs': len(data['natural']),
                      'underflows': len(data['underflow']), **proof}, indent=2))
