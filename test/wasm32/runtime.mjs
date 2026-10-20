import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {access, mkdir, mkdtemp, readFile, rm, writeFile}
  from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {gzipSync} from 'node:zlib';

const build = process.env.WASM32_BUILD;
assert.ok(build, 'WASM32_BUILD must name a fresh evidence directory');
await access(join(build, 'runtime-results.json')).then(() => {
  throw new Error(`Use a fresh runtime execution record: ${build}`);
}, error => { if (error.code !== 'ENOENT') throw error });
const buildReport = JSON.parse(
  await readFile(join(build, 'build.json'), 'utf8'));
assert.equal(buildReport.passed, true);
const packageDirectory = process.env.PIC_PACKAGE_DIR ??
  '/srv/shared/code/ash/node_modules/@dfinity/pic';
const {PocketIc} = await import(pathToFileURL(join(packageDirectory,
  'dist/pocket-ic.js')));
const {IDL} = await import(pathToFileURL(join(dirname(packageDirectory),
  'candid/lib/esm/index.js')));
const {Principal} = await import(pathToFileURL(join(dirname(packageDirectory),
  'principal/lib/esm/index.js')));
const binary = process.env.POCKET_IC_BIN ??
  join(homedir(), '.local/bin/pocket-ic');
const hash = value => createHash('sha256').update(value).digest('hex');
for (const artifact of Object.values(buildReport.artifacts)) {
  assert.equal(hash(await readFile(join(build, artifact.file))),
    artifact.sha256,
    `Artifact changed since compilation: ${artifact.file}`);
}
const concat = (...parts) =>
  Buffer.concat(parts.map(value => Buffer.from(value)));
const byte = (...values) => Buffer.from(values);
const empty = byte();

// Literal ICWire oracle: these bytes do not come from Motoko or the plugin.
function nat(input) {
  let value = BigInt(input);
  assert.ok(value >= 0n);
  const parts = [];
  do {
    const low = Number(value & 127n);
    value >>= 7n;
    parts.push(low | (value ? 128 : 0));
  } while (value);
  return byte(...parts);
}
function int(input) {
  let value = BigInt(input);
  const parts = [];
  for (;;) {
    const low = Number(value & 127n);
    value >>= 7n;
    const done = (value === 0n && !(low & 64)) ||
      (value === -1n && (low & 64));
    parts.push(low | (done ? 0 : 128));
    if (done) return byte(...parts);
  }
}
function word(input, width) {
  let value = BigInt(input);
  const output = Buffer.alloc(width);
  for (let i = 0; i < width; i++) {
    output[i] = Number(value & 255n);
    value >>= 8n;
  }
  assert.equal(value, 0n);
  return output;
}
const blob = value => concat(nat(value.length), value);
const text = value => blob(Buffer.from(value, 'utf8'));
const principal = value => blob(value.toUint8Array());
const vector = (values, encode) => concat(nat(values.length),
  ...values.map(encode));
const option = (value, encode) => value === null ? byte(0) :
  concat(byte(1), encode(value));
const nested = value => concat(word(value.a, 8),
  vector(value.b, item => option(item, text)));
const choice = value => value.tag === 0 ? byte(0) : concat(byte(value.tag),
  value.tag === 1 ? nested(value.value) : vector(value.value, nat));
const payload = value => concat(nat(value.a), text(value.b),
  vector(value.c, item => word(item, 4)), option(value.d, nested),
  choice(value.e), blob(value.f[0]), int(value.f[1]), byte(Number(value.f[2])));
const samples = [
  {a: 0n, b: '', c: [], d: null, e: {tag: 0}, f: [empty, 0n, false]},
  {a: (1n << 127n) + 7n, b: 'snow ☃ and 😀', c: [0, 128, 0xffffffff],
    d: {a: 0xffffffffffffffffn, b: [null, '', 'nested']},
    e: {tag: 1, value: {a: 128n, b: ['x', null, 'λ']}},
    f: [byte(0, 255, 128, 42), -(1n << 127n), true]},
  {a: 16384n, b: 'z'.repeat(257), c: [1, 2, 3, 4, 5],
    d: {a: 1n, b: ['last']}, e: {tag: 2, value: [0n, 128n, 1n << 80n]},
    f: [Buffer.alloc(65537, 0xa5), 1n << 255n, false]},
].map(payload);
const Value = IDL.Record({a: IDL.Nat, b: IDL.Int, c: IDL.Nat64,
  d: IDL.Text, e: IDL.Vec(IDL.Opt(IDL.Nat32)), f: IDL.Vec(IDL.Nat8),
  g: IDL.Variant({a: IDL.Null, b: IDL.Float64})});
const value = {a: (1n << 255n) + 19n, b: -(1n << 191n),
  c: 0xffffffffffffffffn, d: 'mixed width λ 😀',
  e: [[], [0], [0xffffffff]], f: byte(0, 255, 127, 128), g: {b: Math.PI}};
const floating = Buffer.alloc(8);
floating.writeDoubleLE(value.g.b);
const wireValue = concat(nat(value.a), int(value.b), word(value.c, 8),
  text(value.d), vector(value.e, item =>
    option(item.length ? item[0] : null, item => word(item, 4))),
  blob(value.f), byte(1), floating);
const candid = (types, values) => Buffer.from(IDL.encode(types, values));
function expectCandid(output, types, values) {
  // Valid Candid type-table order is not a wire canonicalization requirement.
  assert.deepEqual(candid(types, IDL.decode(types, Uint8Array.from(output))),
    candid(types, values));
}
const candidValue = candid([Value], [value]);
const report = {passed: false, tests: [], calls: [], artifacts: {},
  buildReportSha256: hash(await readFile(join(build, 'build.json'))),
  node: {version: process.version, binary: process.execPath,
    sha256: hash(await readFile(process.execPath))},
  pocketIcBinary: binary, pocketIcSha256: hash(await readFile(binary)),
  oracleSamples: samples.map(bytes => ({bytes: bytes.length,
    sha256: hash(bytes)})), mixedValue: {wireSha256: hash(wireValue),
    candidSha256: hash(candidValue)}, inspectionRuntimeClaim: false};
const save = () => writeFile(join(build, 'runtime-results.json'),
  JSON.stringify(report, null, 2) + '\n');
await mkdir(join(build, 'calls/objects'), {recursive: true});
const archived = new Set();
async function archive(value) {
  const pin = hash(value);
  const relative = `calls/objects/${pin}`;
  if (!archived.has(pin)) {
    await writeFile(join(build, relative), value, {flag: 'wx'});
    archived.add(pin);
  }
  return relative;
}
async function check(name, body) {
  await body();
  report.tests.push(name);
  await save();
  console.log(`PASS ${name}`);
}

async function start() {
  const directory = await mkdtemp(join(tmpdir(), 'tripwire-wasm32-interop-'));
  const portFile = join(directory, 'port');
  const child = spawn(binary, ['--ip-addr', '127.0.0.1',
    '--port-file', portFile, '--log-levels',
    'pocket_ic_server=error,tower_http=error,axum::rejection=error'],
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
    report.ownedServer = {pid: child.pid, exitCode: child.exitCode,
      signalCode: child.signalCode, stderr: 'pocket-ic.stderr'};
    await writeFile(join(build, 'pocket-ic.stderr'), log);
    await rm(directory, {recursive: true, force: true});
    await save();
  }
  try {
    const deadline = Date.now() + 90000;
    let port;
    while (!port) {
      if (failure || child.exitCode !== null || child.signalCode !== null)
        throw new Error(`PocketIC startup failed: ${failure ?? log}`);
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

const session = await start();
try {
  const actors = {};
  for (const name of ['runtime32', 'runtime64', 'interop32', 'interop64',
    'interop32-compact']) {
    const wasm = await readFile(join(build, `${name}.wasm`));
    const installation = gzipSync(wasm);
    const id = await session.pic.createCanister({cycles: 100_000_000_000_000n});
    await session.pic.installCode({canisterId: id, wasm: installation,
      arg: empty});
    actors[name] = id;
    report.artifacts[name] = {sha256: hash(wasm), bytes: wasm.length,
      installationGzipBytes: installation.length,
      installationGzipSha256: hash(installation),
      canisterId: id.toText()};
    await save();
  }
  async function call(name, method, arg = empty, query = false) {
    const options = {canisterId: actors[name], method, arg};
    const record = {actor: name, method, kind: query ? 'query' : 'update',
      inputBytes: arg.length, inputSha256: hash(arg),
      inputObject: await archive(arg)};
    try {
      const output = Buffer.from(await (query ? session.pic.queryCall(options) :
        session.pic.updateCall(options)));
      Object.assign(record, {ok: true, outputBytes: output.length,
        outputSha256: hash(output), outputObject: await archive(output)});
      return output;
    } catch (error) {
      Object.assign(record, {ok: false, error: String(error)});
      throw error;
    } finally {
      report.calls.push(record);
      await save();
    }
  }
  for (const name of ['runtime32', 'runtime64']) {
    await check(`${name}: automatic codecs and all eight explicit APIs`,
      async () => {
        for (const sample of samples) {
          for (const method of ['hot', 'cold'])
            assert.deepEqual(await call(name, method, sample), sample);
          assert.deepEqual(await call(name, 'queryValue', sample, true),
            sample);
          for (const method of ['defaultApis', 'compactApis', 'speedApis',
            'helper', 'asyncApis'])
            assert.deepEqual(await call(name, method, sample), blob(sample));
          assert.deepEqual(await call(name, 'insufficient', sample), byte(1));
        }
      });
    await check(`${name}: malformed input, traps and decoder recovery`,
      async () => {
        const valid = samples[1];
        for (const {wire, expected} of [
          {wire: concat(valid.subarray(0, -1), byte(2)),
            expected: concat(text('bool'), word(valid.length - 1, 8))},
          {wire: concat(valid, byte(0)),
            expected: concat(text('trailing'), word(valid.length, 8))},
        ]) {
          for (const level of [0, 1, 2]) {
            assert.deepEqual(await call(name, 'invalid',
              concat(nat(level), byte(0), blob(wire))), expected);
            await assert.rejects(call(name, 'invalid',
              concat(nat(level), byte(1), blob(wire))), /ICWire/i);
          }
          await assert.rejects(call(name, 'hot', wire), /ICWire/i);
          assert.deepEqual(await call(name, 'hot', valid), valid);
        }
        await assert.rejects(call(name, 'candid', candid([IDL.Nat], [5n])),
          /Candid.*forbidden/i);
      });
  }
  for (const [from, to] of [['runtime32', 'runtime64'],
    ['runtime64', 'runtime32']]) {
    await check(`${from} to ${to}: ICWire callbacks and composite queries`,
      async () => {
        for (const sample of samples) {
          const input = concat(principal(actors[to]), sample);
          for (const method of ['forwardHot', 'forwardCold'])
            assert.deepEqual(await call(from, method, input), sample);
          assert.deepEqual(await call(from, 'compositeValue', input, true),
            sample);
        }
      });
  }
  for (const name of ['interop32', 'interop64', 'interop32-compact']) {
    await check(`${name}: Candid and ICWire preserve wide values`, async () => {
      assert.deepEqual(await call(name, 'wire', wireValue), wireValue);
      expectCandid(await call(name, 'candid', candidValue), [Value], [value]);
      assert.deepEqual(await call(name, 'wireQuery', wireValue, true),
        wireValue);
      expectCandid(await call(name, 'candidQuery', candidValue, true),
        [Value], [value]);
    });
  }
  for (const [from, to] of [['interop32', 'interop64'],
    ['interop64', 'interop32'], ['interop32-compact', 'interop64'],
    ['interop64', 'interop32-compact']]) {
    await check(`${from} to ${to}: both protocols, callbacks and rejection`,
      async () => {
        const input = concat(principal(actors[to]), wireValue);
        const candidInput = candid([IDL.Principal, Value], [actors[to], value]);
        assert.deepEqual(await call(from, 'relay', input), wireValue);
        expectCandid(await call(from, 'relayCandid', candidInput),
          [Value], [value]);
        assert.deepEqual(await call(from, 'compositeWire', input, true),
          wireValue);
        expectCandid(await call(from, 'compositeCandid', candidInput, true),
          [Value], [value]);
        const before = await call(from, 'stats', empty, true);
        assert.equal(before.length, 3);
        for (const useWire of [false, true]) {
          await call(from, 'rejected',
            concat(principal(actors[to]), byte(Number(useWire))));
        }
        const after = await call(from, 'stats', empty, true);
        assert.equal(after.length, 3);
        // All counters remain below 128; reject and finally each run once.
        assert.equal(after[0], before[0] + 2);
        assert.equal(after[1], before[1] + 2);
        assert.deepEqual(await call(from, 'wire', wireValue), wireValue);
      });
  }
  for (const name of ['interop32', 'interop64', 'interop32-compact']) {
    await check(`${name}: timer and private async continuation`, async () => {
      const before = await call(name, 'stats', empty, true);
      assert.deepEqual(await call(name, 'armTimer'), empty);
      await session.pic.advanceTime(1000);
      await session.pic.tick(5);
      const after = await call(name, 'stats', empty, true);
      assert.equal(after[2], before[2] + 1);
    });
    await check(`${name}: embedded imported actor class installs and replies`,
      async () => {
        const seed = (1n << 40n) + 17n;
        const encoded = await call(name, 'createChild', word(seed, 8));
        assert.equal(encoded[0], encoded.length - 1);
        const child = Principal.fromUint8Array(encoded.subarray(1));
        const label = `${name}-child`;
        actors[label] = child;
        report.artifacts[label] = {canisterId: child.toText(),
          embeddedIn: name};
        assert.deepEqual(await call(label, 'wire', word(9, 8)),
          word(seed + 9n, 8));
        expectCandid(await call(label, 'candid', candid([IDL.Nat64], [11n])),
          [IDL.Nat64], [seed + 11n]);
      });
  }
  report.passed = true;
  await save();
  console.log(JSON.stringify({passed: true, tests: report.tests.length,
    calls: report.calls.length}, null, 2));
} catch (error) {
  report.error = String(error.stack ?? error);
  await save();
  throw error;
} finally {
  await session.stop();
}
