'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

(async () => {
  const options = {};
  for (let index = 2; index < process.argv.length; index++) {
    const flag = process.argv[index];
    if (flag === '--help') {
      console.log('Usage: node run-stack-callbacks.js --wasm FIXTURE [--output RESULT.json]');
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

  const bytes = fs.readFileSync(options.wasm);
  const {instance} = await WebAssembly.instantiate(bytes, {});
  const e = instance.exports;
  const checks = [];
  e.seed();
  assert.equal(e.marker(), 42n);
  assert.equal(e.__stack_pointer.value, 1024n);
  for (const bad of [1025n, 0x100000080n, -65537n, -1n, -(1n << 63n)]) {
    let thrown;
    try { e.native_call(bad) } catch (error) { thrown = error }
    assert.ok(thrown instanceof WebAssembly.RuntimeError,
      `bad SP ${bad} did not trap`);
    assert.equal(e.marker(), 42n, 'unchecked callback wrote marker');
    assert.equal(e.__stack_pointer.value, 1024n,
      'invalid stack pointer was published');
    checks.push({input: bad.toString(), pass: true, trapped: true,
      marker: e.marker().toString(),
      stackPointer: e.__stack_pointer.value.toString(), error: String(thrown)});
  }
  e.native_call(1024n);
  assert.equal(e.__stack_pointer.value, 1024n);
  assert.equal(e.marker(), 42n);
  checks.push({input: '1024', pass: true, trapped: false,
    marker: '42', stackPointer: '1024'});
  e.native_call(128n);
  assert.equal(e.__stack_pointer.value, 128n);
  assert.equal(e.marker(), 99n);
  checks.push({input: '128', pass: true, trapped: false,
    marker: '99', stackPointer: '128'});

  const report = {verified: checks.every(check => check.pass),
    engine: process.execPath, engineVersion: process.version,
    module: options.wasm,
    moduleSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    tests: checks.length, checks};
  const encoded = JSON.stringify(report, null, 2) + '\n';
  if (options.output) {
    fs.mkdirSync(path.dirname(options.output), {recursive: true});
    fs.writeFileSync(options.output, encoded);
    console.log(JSON.stringify({verified: report.verified,
      engine: report.engineVersion, tests: report.tests, output: options.output}));
  } else {
    process.stdout.write(encoded);
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1 });
