'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
(async () => {
  // Check memory32 callback bridges and unchanged stable64 ABI.
  const options = {};
  for (let index = 2; index < process.argv.length; index++) {
    const flag = process.argv[index];
    if (flag === '--help') {
      console.log('Usage: node run-callbacks.js --wasm FIXTURE [--output RESULT.json]');
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
  const checks = [], calls = [], cleanups = [], stable = [];
  const time = 0x123456789abcdef0n;
  function check(name, value) {
    checks.push({name, pass: value});
    if (!value) throw new Error(name);
  }
  const {instance} = await WebAssembly.instantiate(bytes, {ic0: {
    call_new: (...args) => { calls.push(args); },
    call_on_cleanup: (...args) => { cleanups.push(args); },
    canister_self_size: () => -1,
    stable64_read: (...args) => { stable.push(args); },
    time: () => time,
  }});
  const e = instance.exports;
  e.submit();
  check('call-new-eight-i32-arguments', calls[0].length === 8 && calls[0].every(x => typeof x === 'number'));
  check('reply-and-reject-use-bridge-slot', calls[0][4] === 2 && calls[0][6] === 2);
  check('reply-env-preserves-high-bit', calls[0][5] >>> 0 === 0x80000000);
  check('reject-env-preserves-all-bits', calls[0][7] >>> 0 === 0xffffffff);
  check('cleanup-two-i32-arguments', cleanups[0].length === 2 && cleanups[0].every(x => typeof x === 'number'));
  check('cleanup-bridge-and-env', cleanups[0][0] === 2 && cleanups[0][1] >>> 0 === 0x80000000);
  e.table.get(calls[0][4])(0x80000000);
  check('callback-env-zero-extends-high-bit', e.observed() === 0x80000000n);
  e.table.get(calls[0][6])(-1);
  check('callback-env-zero-extends-all-bits', e.observed() === 0xffffffffn);
  check('generic-i32-result-zero-extends', e.size_result() === 0xffffffffn);
  check('timestamp-keeps-i64', e.time_result() === time);
  e.stable_read();
  check('stable64-keeps-three-i64-arguments', stable[0].length === 3 && stable[0].every(x => typeof x === 'bigint'));
  check('stable64-keeps-values-above-four-gib', stable[0][0] === 0x100000000n && stable[0][1] === 0x200000000n && stable[0][2] === 0x300000000n);
  e.submit_invalid();
  check('invalid-reply-and-reject-stay-invalid', calls[1][4] === -1 && calls[1][6] === -1);
  check('invalid-cleanup-stays-invalid', cleanups[1][0] === -1);
  let trapped = false;
  try { e.indirect_invalid(); } catch (err) { trapped = err instanceof WebAssembly.RuntimeError; }
  check('internal-indirect-cannot-enter-appended-bridge-half', trapped);
  check('invalid-indirect-did-not-call-callback', e.observed() === 0xffffffffn);
  check('table-appended-half-exists', e.table.length === 4);
  const report = {verified: checks.every(x => x.pass), engine: process.execPath, engineVersion: process.version, module: wasm,
    moduleSha256: crypto.createHash('sha256').update(bytes).digest('hex'), tests: checks.length, checks, calls, cleanups,
    stable64Calls: stable.map(args => args.map(String)), timestamp: String(time)};
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
