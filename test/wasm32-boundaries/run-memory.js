'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
(async () => {
  // Check persistent memory32 addressing and growth boundaries.
  const options = {};
  for (let index = 2; index < process.argv.length; index++) {
    const flag = process.argv[index];
    if (flag === '--help') {
      console.log('Usage: node run-memory.js --wasm FIXTURE [--output RESULT.json]');
      return;
    }
    if ((flag !== '--wasm' && flag !== '--output') ||
        index + 1 >= process.argv.length ||
        process.argv[index + 1].startsWith('--')) {
      throw new Error('Expected --wasm FIXTURE or --output RESULT.json');
    }
    options[flag.slice(2)] = path.resolve(process.argv[++index]);
  }
  if (!options.wasm) throw new Error('--wasm is required');
  if (options.output === options.wasm) {
    throw new Error('--output must differ from --wasm');
  }
  const wasm = options.wasm;
  const bytes = fs.readFileSync(wasm);
  const {instance} = await WebAssembly.instantiate(bytes, {});
  const e = instance.exports;
  const checks = [];
  function check(name, value) {
    checks.push({name, pass: value});
    if (!value) throw new Error(name);
  }
  const marker = 0x123456789abcdef0n;
  e.store(0n, marker);
  function trapKeepsMarker(name, fn) {
    let trapped = false;
    try { fn(); } catch (err) { trapped = err instanceof WebAssembly.RuntimeError; }
    check(name + ':traps', trapped);
    check(name + ':low-memory-unchanged', e.load(0n) === marker);
  }
  trapKeepsMarker('high-store', () => e.store(0x100000000n, 0n));
  trapKeepsMarker('high-copy-destination', () => e.copy(0x100000000n, 0n, 8n));
  trapKeepsMarker('high-copy-source', () => e.copy(0n, 0x100000000n, 8n));
  trapKeepsMarker('high-copy-length', () => e.copy(0n, 8n, 0x100000000n));
  trapKeepsMarker('high-fill-destination', () => e.fill(0x100000000n, 0, 8n));
  trapKeepsMarker('high-fill-length', () => e.fill(0n, 0, 0x100000000n));
  trapKeepsMarker('high-init-destination', () => e.init(0x100000000n, 0, 3));
  check('large-u64-roundtrip', e.load(0n) === marker);
  e.store8(16n, 255n);
  check('packed8-zero-extension', e.load8u(16n) === 255n);
  check('packed8-sign-extension', e.load8s(16n) === -1n);
  e.init(24n, 0, 3);
  check('memory-init-abc', e.load8u(24n) === 97n && e.load8u(25n) === 98n && e.load8u(26n) === 99n);
  check('grow-to-maximum-returns-old-size', e.grow(65534n) === 1n);
  check('maximum-size', e.size() === 65535n);
  e.store(0x80000000n, marker);
  check('address-high-bit-zero-extension', e.load(0x80000000n) === marker);
  e.store(0xfffefff8n, marker);
  check('last-available-eight-bytes', e.load(0xfffefff8n) === marker);
  trapKeepsMarker('reserved-last-page', () => e.store(0xffff0000n, 0n));
  check('grow-past-maximum-returns-minus-one', e.grow(1n) === -1n);
  const report = {
    verified: checks.every(x => x.pass),
    engine: process.execPath,
    engineVersion: process.version,
    module: wasm,
    moduleSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    tests: checks.length,
    checks
  };
  const encoded = JSON.stringify(report, null, 2) + '\n';
  if (options.output) {
    fs.mkdirSync(path.dirname(options.output), {recursive: true});
    fs.writeFileSync(options.output, encoded);
    console.log(JSON.stringify({
      verified: report.verified, engine: report.engineVersion,
      tests: report.tests, output: options.output
    }));
  } else {
    process.stdout.write(encoded);
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
