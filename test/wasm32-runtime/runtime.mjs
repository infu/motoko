import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';

const out = process.env.WASM32_RUNTIME_BUILD;
assert.ok(out, 'WASM32_RUNTIME_BUILD must name the build directory');
const packageDirectory = process.env.PIC_PACKAGE_DIR ??
  '/srv/shared/code/ash/node_modules/@dfinity/pic';
const {PocketIc} = await import(pathToFileURL(join(packageDirectory,
  'dist/pocket-ic.js')));
const binary = process.env.POCKET_IC_BIN ?? join(homedir(), '.local/bin/pocket-ic');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const empty = Buffer.alloc(0);
const report = {passed: false, gcVerified: [], upgradesVerified: [], calls: [],
  artifacts: {}, pocketIcBinary: binary,
  pocketIcSha256: digest(await readFile(binary))};
const save = () => writeFile(join(out, 'runtime-results.json'),
  JSON.stringify(report, null, 2) + '\n');

function readNats(input, count) {
  const bytes = Buffer.from(input);
  const output = [];
  let index = 0;
  for (let i = 0; i < count; i++) {
    let result = 0n, shift = 0n, next;
    do {
      assert.ok(index < bytes.length, 'Truncated Nat reply');
      next = bytes[index++];
      result |= BigInt(next & 127) << shift;
      shift += 7n;
      assert.ok(shift < 4096n, 'Unbounded Nat reply');
    } while (next & 128);
    output.push(result);
  }
  assert.equal(index, bytes.length, 'Trailing bytes in Nat reply');
  return output;
}

const directory = await mkdtemp(join(tmpdir(), 'tripwire-wasm32-runtime-'));
const portFile = join(directory, 'port');
const child = spawn(binary, ['--ip-addr', '127.0.0.1', '--port-file', portFile,
  '--log-levels', 'pocket_ic_server=error,tower_http=error,axum::rejection=error'],
{stdio: ['ignore', 'ignore', 'pipe']});
let log = '', spawnError, pic;
child.stderr.on('data', data => { log += data });
child.on('error', error => { spawnError = error });

async function call(canisterId, label, method, query = false) {
  const record = {label, method, kind: query ? 'query' : 'update'};
  try {
    const args = {canisterId, method, arg: empty};
    const output = Buffer.from(await (query ? pic.queryCall(args) :
      pic.updateCall(args)));
    Object.assign(record, {ok: true, bytes: output.length,
      outputHex: output.toString('hex'), sha256: digest(output)});
    return output;
  } catch (error) {
    Object.assign(record, {ok: false, error: String(error)});
    throw error;
  } finally {
    report.calls.push(record);
    await save();
  }
}

async function verifyState(id, label, before, after, continuations,
  target = label) {
  const value = readNats(await call(id, label, 'state', true), 4);
  assert.deepEqual(value.slice(0, 3), [BigInt(before), BigInt(after),
    BigInt(continuations)]);
  assert.ok(value[3] > 5n * 1024n * 1024n);
  if (target !== 'wasm64') assert.ok(value[3] <= 65535n * 65536n);
  return value;
}

try {
  const deadline = Date.now() + 90000;
  let port;
  while (!port) {
    if (spawnError || child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`PocketIC exited during startup: ${spawnError ?? log}`);
    }
    try { port = Number(await readFile(portFile, 'utf8')) } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (Date.now() > deadline) throw new Error('PocketIC startup timed out');
    if (!port) await delay(100);
  }
  pic = await PocketIc.create(`http://127.0.0.1:${port}`, {
    application: [{state: {type: 'new'}, enableDeterministicTimeSlicing: true,
      enableBenchmarkingInstructionLimits: false}],
    processingTimeoutMs: 120000,
  });
  const actors = {}, wasms = {};
  // Default is already proven byte-identical to explicit wasm32 by run.py.
  for (const name of ['wasm32', 'wasm64']) {
    wasms[name] = await readFile(join(out, `${name}.wasm`));
    const id = await pic.createCanister();
    await pic.installCode({canisterId: id, wasm: wasms[name], arg: empty});
    actors[name] = id;
    report.artifacts[name] = {sha256: digest(wasms[name]),
      bytes: wasms[name].length, canisterId: id.toText()};
    assert.deepEqual(await call(id, name, 'prepare'), empty);
    await verifyState(id, name, 0, 0, 0);
    assert.deepEqual(readNats(await call(id, name, 'resume'), 1), [1n]);
    assert.deepEqual(await call(id, name, 'churn'), empty);
    const reclaimed = readNats(await call(id, name, 'collectAndCheck'), 1)[0];
    assert.ok(reclaimed > 32n * 1024n * 1024n);
    report.gcVerified.push(name);
    report.artifacts[name].reclaimedBytes = reclaimed.toString();
    await verifyState(id, name, 0, 0, 1);
    if (name !== 'wasm64') {
      await assert.rejects(call(id, name, 'tooLarge'), /Cannot grow memory/i);
      await verifyState(id, name, 0, 0, 1);
    }
    await save();
  }
  const id = actors.wasm32;
  let ordinal = 0;
  for (const [name, target] of [
    ['wasm32-to-wasm32', 'wasm32'],
    ['wasm32-to-wasm64', 'wasm64'],
    ['wasm64-to-wasm32', 'wasm32'],
  ]) {
    await pic.upgradeCanister({canisterId: id, wasm: wasms[target], arg: empty,
      upgradeModeOptions: {skip_pre_upgrade: [],
        wasm_memory_persistence: [{keep: null}]}});
    ordinal++;
    await verifyState(id, name, ordinal, ordinal, ordinal, target);
    assert.deepEqual(readNats(await call(id, name, 'resume'), 1),
      [BigInt(ordinal + 1)]);
    report.upgradesVerified.push(name);
    await save();
  }
  report.passed = true;
  await save();
  console.log(JSON.stringify({passed: true, gcVerified: report.gcVerified,
    upgradesVerified: report.upgradesVerified, calls: report.calls.length}));
} catch (error) {
  report.error = String(error.stack ?? error);
  await save();
  throw error;
} finally {
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    try { await exited } finally { clearTimeout(timer) }
  }
  report.ownedServer = {pid: child.pid, exitCode: child.exitCode,
    signalCode: child.signalCode};
  await writeFile(join(out, 'pocket-ic.stderr'), log);
  await rm(directory, {recursive: true, force: true});
  await save();
}
