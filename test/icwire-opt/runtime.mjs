import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';

const build = process.env.ICWIRE_OPT_BUILD ??
  fileURLToPath(new URL('_build/', import.meta.url));
const packageDirectory = process.env.PIC_PACKAGE_DIR ??
  '/srv/shared/code/ash/node_modules/@dfinity/pic';
const {PocketIc} = await import(pathToFileURL(join(packageDirectory,
  'dist/pocket-ic.js')));
const binary = process.env.POCKET_IC_BIN ?? join(homedir(), '.local/bin/pocket-ic');
const hash = value => createHash('sha256').update(value).digest('hex');
const concat = (...parts) => Buffer.concat(parts.map(value => Buffer.from(value)));
const byte = (...values) => Buffer.from(values);
const empty = byte();

// A literal host oracle independent of plugin generators and Candid packages.
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
const blob = value => concat(nat(value.length), value);
const text = value => blob(Buffer.from(value, 'utf8'));
const principal = value => blob(value.toUint8Array());
const vector = (values, encode) => concat(nat(values.length), ...values.map(encode));
const option = (value, encode) => value === null ? byte(0) : concat(byte(1), encode(value));
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
const nested = value => concat(word(value.a, 8),
  vector(value.b, v => option(v, text)));
const choice = value => value.tag === 0 ? byte(0) :
  concat(byte(value.tag), value.tag === 1 ? nested(value.value) :
    vector(value.value, nat));
// Labels a..f are already ordered by their unsigned field hash.
const payload = value => concat(nat(value.a), text(value.b),
  vector(value.c, v => word(v, 4)), option(value.d, nested), choice(value.e),
  blob(value.f[0]), int(value.f[1]), byte(Number(value.f[2])));
const samples = [
  {a: 0n, b: '', c: [], d: null, e: {tag: 0}, f: [byte(), 0n, false]},
  {a: (1n << 127n) + 7n, b: 'snow ☃ and 😀', c: [0, 128, 0xffffffff],
    d: {a: 0xffffffffffffffffn, b: [null, '', 'nested']},
    e: {tag: 1, value: {a: 128n, b: ['x', null, 'λ']}},
    f: [byte(0, 255, 128, 42), -(1n << 127n), true]},
  {a: 16384n, b: 'z'.repeat(257), c: [1, 2, 3, 4, 5],
    d: {a: 1n, b: ['last']}, e: {tag: 2, value: [0n, 128n, 1n << 80n]},
    f: [Buffer.alloc(65537, 0xa5), 1n << 255n, false]},
].map(payload);
const report = {passed: false, tests: [], calls: [],
  pocketIcBinary: binary, pocketIcSha256: hash(await readFile(binary)),
  artifacts: {}, oracleSamples: samples.map(value =>
    ({bytes: value.length, sha256: hash(value)}))};
const save = () => writeFile(join(build, 'runtime-results.json'),
  JSON.stringify(report, null, 2) + '\n');
async function check(name, body) {
  await body();
  report.tests.push(name);
  await save();
  console.log(`PASS ${name}`);
}

async function start() {
  const directory = await mkdtemp(join(tmpdir(), 'icwire-opt-test-'));
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

const session = await start();
try {
  const modes = ['default', 'speed', 'compact', 'query', 'query-override',
    'mixed-hot', 'mixed-cold', 'mixed-hot-reversed', 'mixed-cold-reversed'];
  const actors = {};
  for (const mode of modes) {
    const wasm = await readFile(join(build, `${mode}.wasm`));
    const id = await session.pic.createCanister();
    await session.pic.installCode({canisterId: id, wasm, arg: empty});
    actors[mode] = id;
    report.artifacts[mode] = {sha256: hash(wasm), bytes: wasm.length,
      canisterId: id.toText()};
  }
  const classWasm = await readFile(join(build, 'class.wasm'));
  const classId = await session.pic.createCanister();
  await session.pic.installCode({canisterId: classId, wasm: classWasm, arg: nat(17)});
  actors.class = classId;
  report.artifacts.class = {sha256: hash(classWasm), bytes: classWasm.length,
    canisterId: classId.toText()};
  async function call(mode, method, arg, query = false) {
    const options = {canisterId: actors[mode], method, arg};
    const record = {mode, method, kind: query ? 'query' : 'update',
      inputBytes: arg.length, inputSha256: hash(arg)};
    try {
      const value = Buffer.from(await (query ? session.pic.queryCall(options) :
        session.pic.updateCall(options)));
      Object.assign(record, {ok: true, outputBytes: value.length,
        outputSha256: hash(value)});
      return value;
    } catch (error) {
      Object.assign(record, {ok: false, error: String(error)});
      throw error;
    } finally {
      report.calls.push(record);
      await save();
    }
  }
  for (const mode of modes) {
    await check(`${mode}: automatic update/query and all eight explicit APIs`,
      async () => {
        for (const value of samples) {
          for (const method of ['hot', 'cold']) {
            assert.deepEqual(await call(mode, method, value), value);
          }
          assert.deepEqual(await call(mode, 'queryValue', value, true), value);
          for (const method of ['defaultApis', 'compactApis', 'speedApis',
            'helper', 'asyncApis']) {
            assert.deepEqual(await call(mode, method, value), blob(value));
          }
          assert.deepEqual(await call(mode, 'insufficient', value), byte(1));
        }
      });
    await check(`${mode}: malformed errors, traps and recovery agree across levels`,
      async () => {
        const valid = samples[1];
        const malformed = [
          {wire: concat(valid.subarray(0, -1), byte(2)),
            expected: concat(text('bool'), word(valid.length - 1, 8))},
          {wire: concat(valid, byte(0)),
            expected: concat(text('trailing'), word(valid.length, 8))},
        ];
        for (const {wire, expected} of malformed) {
          for (const level of [0, 1, 2]) {
            assert.deepEqual(await call(mode, 'invalid',
              concat(nat(level), byte(0), blob(wire))), expected);
            await assert.rejects(call(mode, 'invalid',
              concat(nat(level), byte(1), blob(wire))), /ICWire/i);
          }
          await assert.rejects(call(mode, 'hot', wire), /ICWire/i);
          assert.deepEqual(await call(mode, 'hot', valid), valid);
        }
        await assert.rejects(call(mode, 'candid',
          concat(byte(68, 73, 68, 76, 0, 1, 125), nat(5))), /Candid.*forbidden/i);
      });
  }
  await check('actor-class exported endpoint selector and ICWire constructor',
    async () => {
      assert.deepEqual(await call('class', 'hot', nat(5)), nat(22));
    });
  for (const [from, to] of [
    ['speed', 'compact'], ['compact', 'speed'],
    ['mixed-hot', 'mixed-cold'], ['mixed-cold', 'mixed-hot'],
    ['mixed-hot-reversed', 'mixed-cold-reversed'],
    ['mixed-cold-reversed', 'mixed-hot-reversed'],
  ]) {
    await check(`${from} to ${to}: mixed-level callbacks, async and composite query`,
      async () => {
        for (const value of samples) {
          const input = concat(principal(actors[to]), value);
          // Both result schemas are equal. Execute both callback directions.
          for (const method of ['forwardHot', 'forwardCold']) {
            assert.deepEqual(await call(from, method, input), value);
          }
          assert.deepEqual(await call(from, 'compositeValue', input, true), value);
        }
      });
  }
  report.passed = true;
  await save();
  console.log(JSON.stringify({passed: true, tests: report.tests.length,
    calls: report.calls.length, report: join(build, 'runtime-results.json')}, null, 2));
} catch (error) {
  report.error = String(error.stack ?? error);
  await save();
  throw error;
} finally {
  await session.stop();
}
