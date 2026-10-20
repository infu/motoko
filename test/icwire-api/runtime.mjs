import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';

const packageDirectory = process.env.PIC_PACKAGE_DIR ??
  '/srv/shared/code/ash/node_modules/@dfinity/pic';
const {PocketIc} = await import(pathToFileURL(join(packageDirectory,
  'dist/pocket-ic.js')));
const build = process.env.ICWIRE_TEST_BUILD ??
  fileURLToPath(new URL('_build/', import.meta.url));
const binary = process.env.POCKET_IC_BIN ?? join(homedir(), '.local/bin/pocket-ic');
const concat = (...parts) => Buffer.concat(parts.map(value => Buffer.from(value)));
const bytes = (...values) => Buffer.from(values);
const empty = bytes();

// Independent wire oracle: no plugin schema code or Candid codec is imported.
function nat(input) {
  let value = BigInt(input);
  assert.ok(value >= 0n);
  const result = [];
  do {
    const low = Number(value & 127n);
    value >>= 7n;
    result.push(low | (value ? 128 : 0));
  } while (value);
  return bytes(...result);
}
function int(input) {
  let value = BigInt(input);
  const result = [];
  for (;;) {
    const low = Number(value & 127n);
    value >>= 7n;
    const done = (value === 0n && !(low & 64)) ||
      (value === -1n && (low & 64));
    result.push(low | (done ? 0 : 128));
    if (done) return bytes(...result);
  }
}
const blob = value => concat(nat(value.length), value);
const text = value => blob(Buffer.from(value, 'utf8'));
const principal = value => blob(value.toUint8Array());
const candidNat = value => concat(bytes(68, 73, 68, 76, 0, 1, 125), nat(value));
const candidPrincipal = value => concat(bytes(68, 73, 68, 76, 0, 1, 104, 1),
  principal(value));

const results = [];
async function check(name, body) {
  await body();
  results.push(name);
  console.log(`PASS ${name}`);
}

async function start() {
  const directory = await mkdtemp(join(tmpdir(), 'icwire-api-test-'));
  const portFile = join(directory, 'port');
  const child = spawn(binary, ['--ip-addr', '127.0.0.1', '--port-file', portFile,
    '--log-levels', 'pocket_ic_server=error,tower_http=error,axum::rejection=error'],
  {stdio: ['ignore', 'ignore', 'pipe']});
  let log = '', failure;
  child.stderr.on('data', data => { log += data });
  child.on('error', error => { failure = error });
  async function stop() {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      try { await exited } finally { clearTimeout(timer) }
    }
    await rm(directory, {recursive: true, force: true});
  }
  try {
    const deadline = Date.now() + 90000;
    let port;
    while (!port) {
      if (failure || child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`PocketIC startup failed: ${failure ?? log}`);
      }
      try { port = Number(await readFile(portFile, 'utf8')) } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (Date.now() > deadline) throw new Error('PocketIC startup timed out');
      if (!port) await delay(100);
    }
    const pic = await PocketIc.create(`http://127.0.0.1:${port}`, {
      application: [{state: {type: 'new'},
        enableDeterministicTimeSlicing: true,
        enableBenchmarkingInstructionLimits: false}],
      processingTimeoutMs: 120000,
    });
    return {pic, stop};
  } catch (error) {
    await stop();
    throw error;
  }
}

async function suite(pic, mode) {
  const seed = 128n;
  const wasm = await readFile(join(build, `${mode}.wasm`));
  const a = await pic.createCanister();
  const b = await pic.createCanister();
  // Anonymous principal is one byte 04, encoded without Candid's marker.
  const init = concat(nat(seed), bytes(1, 4));
  await pic.installCode({canisterId: a, wasm, arg: init});
  await pic.installCode({canisterId: b, wasm, arg: init});
  const update = async (method, arg = empty, target = a) =>
    Buffer.from(await pic.updateCall({canisterId: target, method, arg}));
  const query = async (method, arg = empty, target = a) =>
    Buffer.from(await pic.queryCall({canisterId: target, method, arg}));
  const equalUpdate = async (method, input, expected = input) =>
    assert.deepEqual(await update(method, input), expected, method);
  const label = name => `${mode}: ${name}`;

  await check(label('ICWire constructor, empty update and caller context'), async () => {
    assert.deepEqual(await query('constructorValue'), nat(seed));
    await equalUpdate('zero', empty);
    await equalUpdate('callerIsExpected', empty, bytes(1));
  });
  await check(label('integer boundaries and large integers'), async () => {
    for (const value of [0n, 63n, 64n, 127n, 128n, 16384n,
      (1n << 62n) - 1n, 1n << 62n, (1n << 64n) - 1n, 1n << 127n,
      (1n << 255n) + 12345n]) {
      await equalUpdate('echoNat', nat(value));
      await equalUpdate('echoInt', int(value));
      await equalUpdate('echoInt', int(-value));
    }
  });
  await check(label('option, variant, record, vector, text and blob'), async () => {
    await equalUpdate('echoBool', bytes(0));
    await equalUpdate('echoBool', bytes(1));
    await equalUpdate('echoOpt', bytes(0));
    await equalUpdate('echoOpt', concat(bytes(1), nat(12345)));
    await equalUpdate('echoVariant', bytes(0));
    await equalUpdate('echoVariant', concat(bytes(1), nat(12345)));
    // Labels a, b, c are already in unsigned label-hash order.
    await equalUpdate('echoRecord', concat(nat(129), text('snow ☃'), bytes(1)));
    await equalUpdate('echoArray', nat(0));
    await equalUpdate('echoArray', concat(nat(3), nat(1), nat(128), nat(1n << 80n)));
    await equalUpdate('echoText', text('snow ☃ and 😀'));
    await equalUpdate('echoBlob', blob(bytes(0, 255, 128, 1)));
  });
  await check(label('multiple values and one tuple value'), async () => {
    const pair = concat(nat(12345), text('tuple'));
    await equalUpdate('many', pair);
    await equalUpdate('tuple', pair);
  });
  await check(label('explicit and actor codecs share nested result schemas'), async () => {
    // #ok precedes #err by unsigned label hash. The nested #err is its
    // schema's only arm, so both variant ordinals are zero.
    await equalUpdate('echoNestedResult', concat(bytes(0, 0), nat(12345)));
    await equalUpdate('echoNestedResult', concat(bytes(1), text('handled')));
    await assert.rejects(update('echoNestedResult', bytes(0, 1)), /ICWire|icwire/i);
    await equalUpdate('echoNestedResult', concat(bytes(0, 0), nat(7)));
    await assert.rejects(update('emitFloat32Tail', bytes(0)), /ICWire|icwire/i);
    const finite = Buffer.alloc(4);
    finite.writeFloatLE(1.5);
    await equalUpdate('emitFloat32Tail', bytes(1),
      concat(blob(Buffer.alloc(128, 0x5a)), finite));
  });
  await check(label('direct codecs preserve bytes and exact diagnostic traps'), async () => {
    const finite = Buffer.alloc(8);
    finite.writeDoubleLE(1.5);
    const payload = Buffer.alloc(1022, 0x5a);
    const encoded = concat(blob(payload), finite);
    for (const mode of [0, 1, 2, 3]) {
      const encode = (valid, capacity = 2048) =>
        concat(nat(mode), nat(payload.length), bytes(Number(valid)), nat(capacity));
      await assert.rejects(update('codecEncode', encode(false)),
        /ICWire float at byte 1_024/);
      await equalUpdate('codecEncode', encode(true), blob(encoded));
      if (mode < 2) {
        await assert.rejects(update('codecEncode', encode(false, 3)),
          /ICWire limit at byte 0/);
        await assert.rejects(update('codecEncode', encode(true, 16 * 1024 * 1024 + 1)),
          /ICWire limit at byte 0/);
        await equalUpdate('codecEncode', encode(true), blob(encoded));
      }
    }
    const finite32 = Buffer.alloc(4);
    finite32.writeFloatLE(1.5);
    for (const direct of [0, 1]) {
      await assert.rejects(update('codecEncode32', bytes(direct, 0)),
        /ICWire float at byte 1_024/);
      await equalUpdate('codecEncode32', bytes(direct, 1),
        blob(concat(blob(payload), finite32)));
      await assert.rejects(update('codecDecode',
        concat(bytes(direct), blob(concat(blob(payload), bytes(2))))),
        /ICWire bool at byte 1_024/);
      await assert.rejects(update('codecDecode',
        concat(bytes(direct), blob(concat(blob(payload), bytes(1, 0))))),
        /ICWire trailing at byte 1_025/);
      await equalUpdate('codecDecode',
        concat(bytes(direct), blob(concat(blob(payload), bytes(1)))), nat(1022));
    }
  });
  await check(label('query, composite query and cross-canister async'), async () => {
    assert.deepEqual(await query('queryNat', nat(777)), nat(777));
    assert.deepEqual(await query('compositeQuery', concat(principal(b), nat(999))), nat(999));
    await equalUpdate('runPure', principal(b), nat(128n + seed + 4n));
    assert.deepEqual(await query('received', empty, b), nat(3));
  });
  await check(label('oneway returns empty bytes and commits'), async () => {
    await equalUpdate('notify', nat(7), empty);
    assert.deepEqual(await query('received'), nat(7));
  });
  await check(label('actor and shared callback references preserve protocol'), async () => {
    const callback = concat(principal(b), text('queryNat'));
    await equalUpdate('getCallback', principal(b), callback);
    await equalUpdate('echoCallback', callback);
    await equalUpdate('getActor', principal(b));
    await equalUpdate('echoActor', principal(b));
    await equalUpdate('callReturned', principal(b), nat(456));
  });
  await check(label('varying output sizes preserve exact bytes'), async () => {
    // Include length-prefix transitions and repeated large/small values.
    const sizes = [0, 1, 15, 16, 17, 127, 128, 255, 256, 257, 511, 512,
      513, 8193, 65537, 1048576, ...Array(20).fill(1), 65537, 0, 1048576,
      ...Array(20).fill(0)];
    for (const size of sizes) {
      const value = blob(Buffer.alloc(size, 0x5a));
      await equalUpdate('emitBlob', nat(size), value);
    }
    // Exercise records and vectors as well as Blob.
    for (const size of [1, 511, 65537, 1, 1, 1, 1025, 0]) {
      await equalUpdate('echoRecord', concat(nat(129), text('x'.repeat(size)), bytes(1)));
      await equalUpdate('echoArray', concat(nat(size), Buffer.alloc(size, 1)));
    }
  });
  await check(label('queries and peer requests/replies preserve exact bytes'), async () => {
    // Interleave large queries with small updates and then reverse the sizes.
    for (const size of [1, 65537, 1, 1048576, 1, 65537]) {
      const value = blob(Buffer.alloc(size, 0x5a));
      assert.deepEqual(await query('queryBlob', value), value);
      assert.deepEqual(await query('queryBlob', value), value);
      await equalUpdate('echoBlob', blob(bytes(0x5a)));
      await equalUpdate('relayBlob', concat(principal(b), nat(size)), value);
      assert.deepEqual(await query('queryBlob', blob(empty)), blob(empty));
    }
  });
  await check(label('semantic errors and oversize values allow subsequent valid calls'), async () => {
    // Array itself consumes one typed node, leaving 999999 null elements.
    await equalUpdate('emitNulls', nat(999999), nat(999999));
    for (let attempt = 0; attempt < 3; attempt++) {
      await assert.rejects(update('emitNulls', nat(1000000)), /ICWire|icwire/i);
      await equalUpdate('emitNulls', nat(3), nat(3));
      await assert.rejects(update('emitBlob', nat(16 * 1024 * 1024)), /ICWire|icwire/i);
      await equalUpdate('emitBlob', nat(16), blob(Buffer.alloc(16, 0x5a)));
      await equalUpdate('emitBlob', nat(65537), blob(Buffer.alloc(65537, 0x5a)));
      await assert.rejects(update('echoBlob', bytes(128)), /ICWire|icwire/i);
      await equalUpdate('emitBlob', nat(0), blob(empty));
    }
    // A four-byte length prefix plus this payload exactly reaches 16 MiB.
    // Encoding succeeds, then the IC response-size limit rejects the reply.
    // This distinguishes codec capacity from transport capacity.
    await assert.rejects(update('emitBlob', nat(16 * 1024 * 1024 - 4)), error => {
      assert.doesNotMatch(String(error), /ICWire.*(failed|limit|forbidden)/i);
      assert.match(String(error), /size|bytes|large|limit/i);
      return true;
    });
    await equalUpdate('emitBlob', nat(1), blob(bytes(0x5a)));
  });
  await check(label('invalid float after large Blob and oversize outgoing calls reject safely'), async () => {
    const finite = Buffer.alloc(8);
    finite.writeDoubleLE(1.5);
    for (const size of [65537, 131073, 1048576]) {
      await assert.rejects(update('emitFloatTail', concat(nat(size), bytes(0))), /ICWire|icwire/i);
      await equalUpdate('emitFloatTail', concat(nat(1), bytes(1)),
        concat(blob(bytes(0x5a)), finite));
      await equalUpdate('emitFloatTail', concat(nat(size), bytes(1)),
        concat(blob(Buffer.alloc(size, 0x5a)), finite));
    }
    assert.deepEqual(await query('acceptedBlobs', empty, b), nat(0));
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(update('sendBlob', concat(principal(b), nat(16 * 1024 * 1024))),
        /ICWire|icwire/i);
      assert.deepEqual(await query('acceptedBlobs', empty, b), nat(0));
    }
    await equalUpdate('sendBlob', concat(principal(b), nat(65537)), nat(65537));
    assert.deepEqual(await query('acceptedBlobs', empty, b), nat(1));
  });
  await check(label('malformed input rejected without mutating state'), async () => {
    for (const [method, arg] of [
      ['echoNat', empty], ['echoNat', bytes(128)],
      ['echoNat', bytes(128, 0)], ['echoNat', bytes(0, 0)],
      ['echoBool', bytes(2)], ['echoOpt', bytes(2)],
      ['echoVariant', bytes(2)], ['echoVariant', bytes(1)],
      ['echoText', bytes(2, 255, 255)], ['echoBlob', bytes(2, 0)],
      ['zero', bytes(0)], ['notify', concat(nat(500), bytes(0))],
      ['echoActor', concat(nat(30), Buffer.alloc(30))],
      ['echoCallback', concat(principal(b), bytes(1, 255))],
    ]) {
      await assert.rejects(update(method, arg), /ICWire|icwire|trap/i,
        `${method} should reject ${arg.toString('hex')}`);
    }
    assert.deepEqual(await query('received'), nat(7));
  });
  if (mode === 'mixed') {
    await check(label('Candid and ICWire callback cache coexist'), async () => {
      await equalUpdate('runMixed', principal(b), nat(32n + 2n * seed));
      await equalUpdate('legacyNat', candidNat(5), candidNat(seed + 5n));
      assert.deepEqual(await query('legacyQuery', candidNat(9)), candidNat(seed + 9n));
      await equalUpdate('legacyCallsWire', candidPrincipal(b), candidNat(999));
    });
  } else {
    await check(label('tripwire rejects intentional Candid ingress and outgoing call'), async () => {
      await assert.rejects(update('legacyNat', candidNat(5)), /Candid.*forbidden/i);
      await assert.rejects(query('legacyQuery', candidNat(5)), /Candid.*forbidden/i);
      await assert.rejects(update('runMixed', principal(b)), /Candid.*forbidden/i);
    });
  }
  await check(label('upgrade preserves the wire contract'), async () => {
    await equalUpdate('emitBlob', nat(1048576), blob(Buffer.alloc(1048576, 0x5a)));
    await pic.upgradeCanister({canisterId: a, wasm, arg: init,
      upgradeModeOptions: {skip_pre_upgrade: [], wasm_memory_persistence: [{keep: null}]}});
    assert.deepEqual(await query('constructorValue'), nat(seed));
    for (const size of [1, 65537, 1, 1048576, 0]) {
      await equalUpdate('emitBlob', nat(size), blob(Buffer.alloc(size, 0x5a)));
    }
    await equalUpdate('runPure', principal(b), nat(128n + seed + 4n));
  });
}

for (const mode of ['mixed', 'guarded']) {
  const did = await readFile(join(build, `${mode}.did`), 'utf8');
  await check(`${mode}: truthful Candid service metadata`, async () => {
    assert.doesNotMatch(did, /service\s*:\s*\(/,
      'ICWire constructor must not be advertised as Candid');
    for (const name of ['legacyNat', 'legacyQuery', 'legacyCallsWire']) {
      assert.match(did, new RegExp(`\\b${name}\\s*:`));
    }
    for (const name of ['zero', 'echoNat', 'runPure', 'runMixed', 'compositeQuery',
      'queryNat', 'received', 'notify', 'constructorValue']) {
      assert.doesNotMatch(did, new RegExp(`\\b${name}\\s*:`));
    }
  });
}
await check('pure ICWire actor has no Candid methods or constructor', async () => {
  const did = await readFile(join(build, 'class.did'), 'utf8');
  assert.doesNotMatch(did, /\bread\s*:/);
  assert.doesNotMatch(did, /service\s*:\s*\(/);
});
const session = await start();
try {
  await suite(session.pic, 'mixed');
  await suite(session.pic, 'guarded');
  const report = {passed: results.length, tests: results,
    compilerArtifacts: resolve(build), pocketIcBinary: binary};
  await writeFile(join(build, 'runtime-results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await session.stop();
}
