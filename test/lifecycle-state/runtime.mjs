import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {homedir, tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';

const packageDirectory = process.env.PIC_PACKAGE_DIR ??
  '/srv/shared/code/ash/node_modules/@dfinity/pic';
const require = createRequire(join(packageDirectory, 'package.json'));
const {IDL} = require('@dfinity/candid');
const {PocketIc} = await import(pathToFileURL(join(packageDirectory,
  'dist/pocket-ic.js')));
const build = resolve(process.env.LIFECYCLE_TEST_BUILD ??
  fileURLToPath(new URL('_build/', import.meta.url)));
const binary = process.env.POCKET_IC_BIN ??
  join(homedir(), '.local/bin/pocket-ic');
const empty = new Uint8Array(IDL.encode([], []));
const natArg = value => new Uint8Array(IDL.encode([IDL.Nat], [value]));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(await readFile(join(build, 'build.json'), 'utf8'));
const results = [];
const observations = {};

function idlFactory({IDL}) {
  return IDL.Service({
    state: IDL.Func([], [IDL.Nat, IDL.Nat], ['query']),
    callbacks: IDL.Func([], [IDL.Nat], ['query']),
    queryWrite: IDL.Func([], [IDL.Nat], ['query']),
    queryTrap: IDL.Func([], [IDL.Nat], ['query']),
    compositeRoundtrip: IDL.Func([IDL.Principal, IDL.Bool], [IDL.Nat],
      ['composite_query']),
    add: IDL.Func([IDL.Nat], [IDL.Nat], []),
    roundtrip: IDL.Func([IDL.Principal, IDL.Bool], [IDL.Nat], []),
    callbackTrap: IDL.Func([IDL.Principal], [IDL.Nat], []),
  });
}

async function check(name, body) {
  await body();
  results.push(name);
  console.log(`PASS ${name}`);
}

async function start() {
  const directory = await mkdtemp(join(tmpdir(), 'lifecycle-state-'));
  const portFile = join(directory, 'port');
  const child = spawn(binary, ['--ip-addr', '127.0.0.1',
    '--port-file', portFile, '--log-levels',
    'pocket_ic_server=error,tower_http=error,axum::rejection=error'],
  {stdio: ['ignore', 'ignore', 'pipe']});
  let log = '', failure;
  child.stderr.on('data', data => {log += data});
  child.on('error', error => {failure = error});
  let pic;
  async function stop() {
    try {
      if (pic) await pic.tearDown();
    } finally {
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
        try {await exited} finally {clearTimeout(timer)}
      }
      await writeFile(join(build, 'server.log'), log);
      await rm(directory, {recursive: true, force: true});
    }
  }
  try {
    const deadline = Date.now() + 90000;
    let port;
    while (!port) {
      if (failure || child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`PocketIC startup failed: ${failure ?? log}`);
      }
      try {port = Number(await readFile(portFile, 'utf8'))} catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (Date.now() > deadline) throw new Error('PocketIC startup timed out');
      if (!port) await delay(100);
    }
    const url = `http://127.0.0.1:${port}`;
    pic = await PocketIc.create(url, {
      application: [{state: {type: 'new'},
        enableDeterministicTimeSlicing: true,
        enableBenchmarkingInstructionLimits: false}],
      processingTimeoutMs: 120000,
    });
    // This private server creates exactly one instance, numbered zero.
    async function trace(action, canister) {
      const read = action === 'get_memory_access_trace';
      const response = await fetch(`${url}/instances/0/${read ? 'read' :
        'update'}/${action}`, {method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({canister_id:
          Buffer.from(canister.toUint8Array()).toString('base64')})});
      assert.ok(response.ok, `${action}: ${response.status}`);
      return response.json();
    }
    return {pic, trace, stop};
  } catch (error) {
    await stop();
    throw error;
  }
}

async function wasm(name) {
  const bytes = await readFile(join(build, name));
  assert.equal(hash(bytes), manifest.artifacts[name].sha256, name);
  return bytes;
}

async function install(pic, compiler, seed = 41n) {
  const canisterId = await pic.createCanister();
  await pic.installCode({canisterId,
    wasm: await wasm(`${compiler}-actor.wasm`), arg: natArg(seed)});
  return {id: canisterId,
    actor: pic.createActor(idlFactory, canisterId)};
}

async function upgrade(pic, canisterId, compiler, skip) {
  await pic.upgradeCanister({canisterId,
    wasm: await wasm(`${compiler}-actor.wasm`), arg: natArg(41n),
    upgradeModeOptions: {skip_pre_upgrade: [skip],
      wasm_memory_persistence: [{keep: null}]}});
}

async function messages(pic, compiler) {
  const {actor} = await install(pic, compiler);
  const peer = await install(pic, compiler, 73n);
  let value = 41n;
  const label = name => `${compiler}: ${name}`;
  await check(label('successful query rolls back before next update'), async () => {
    assert.equal(await actor.queryWrite(), value + 1000n);
    assert.deepEqual(await actor.state(), [value, 0n]);
    assert.equal(await actor.add(1n), ++value);
  });
  await check(label('trapping query rolls back before next update'), async () => {
    await assert.rejects(actor.queryTrap(), /expected query trap/);
    assert.deepEqual(await actor.state(), [value, 0n]);
    assert.equal(await actor.add(1n), ++value);
  });
  for (const reject of [false, true]) {
    await check(label(`composite ${reject ? 'reject' : 'reply'} callback ` +
      'keeps isolated state'), async () => {
      assert.equal(await actor.compositeRoundtrip(peer.id, reject),
        value + 1001n);
      assert.deepEqual(await actor.state(), [value, 0n]);
      assert.equal(await actor.add(1n), ++value);
    });
    await check(label(`update ${reject ? 'reject' : 'reply'} callback ` +
      'returns to idle'), async () => {
      assert.equal(await actor.roundtrip(peer.id, reject), ++value);
      assert.equal(await actor.add(1n), ++value);
      assert.equal(await actor.callbacks(), 0n);
    });
  }
  await check(label('callback trap rolls back callback and cleans continuation'),
    async () => {
      await assert.rejects(actor.callbackTrap(peer.id), /expected callback trap/);
      // The first message committed +1 before await. The callback's +1000
      // traps and rolls back; its cleanup must release the continuation.
      value += 1n;
      assert.deepEqual(await actor.state(), [value, 0n]);
      assert.equal(await actor.callbacks(), 0n);
      assert.equal(await actor.add(1n), ++value);
    });
}

async function upgrades(pic, initial, next) {
  for (const skip of [false, true]) {
    await check(`${initial} -> ${next}: keep-memory upgrade, ` +
      `skip_pre_upgrade=${skip}`, async () => {
      const {id, actor} = await install(pic, initial);
      assert.equal(await actor.add(9n), 50n);
      assert.equal(await actor.queryWrite(), 1050n);
      await upgrade(pic, id, next, skip);
      const after = await actor.state();
      // Skipping Motoko's preupgrade also skips saving the stable actor.
      // Check this existing behavior against the baseline, not just liveness.
      const expected = skip ? 41n : 50n;
      assert.deepEqual(after, [expected, 0n]);
      assert.equal(await actor.add(1n), expected + 1n);
      assert.equal(await actor.callbacks(), 0n);
      observations[`${initial}->${next}:skip=${skip}`] = after;
    });
  }
}

async function stabilization(session) {
  const {pic, trace} = session;
  const canisterId = await pic.createCanister();
  const code = await wasm('candidate-stabilization.wasm');
  await pic.installCode({canisterId, wasm: code, arg: empty});
  const state = async () => IDL.decode([IDL.Nat, IDL.Nat, IDL.Nat],
    await pic.queryCall({canisterId, method: 'state', arg: empty}));
  const add = async () => IDL.decode([IDL.Nat], await pic.updateCall({
    canisterId, method: 'add', arg: natArg(1n)}))[0];
  await trace('start_memory_access_tracing', canisterId);
  await check('candidate: explicit stabilization blocks ordinary messages',
    async () => {
      assert.deepEqual(await state(), [7n, 1024n, 1023n]);
      assert.equal(await add(), 8n);
      await pic.updateCall({canisterId,
        method: '__motoko_stabilize_before_upgrade', arg: empty});
      await assert.rejects(state(), /Messages are blocked during stabilization/);
      await assert.rejects(add(), /Messages are blocked during stabilization/);
    });
  await check('candidate: explicit destabilization resumes gated state',
    async () => {
      await pic.upgradeCanister({canisterId, wasm: code, arg: empty,
        upgradeModeOptions: {skip_pre_upgrade: [],
          wasm_memory_persistence: [{keep: null}]}});
      await assert.rejects(state(), /Messages are blocked during stabilization/);
      await assert.rejects(add(), /Messages are blocked during stabilization/);
      await pic.updateCall({canisterId,
        method: '__motoko_destabilize_after_upgrade', arg: empty});
      assert.deepEqual(await state(), [8n, 1024n, 1023n]);
      assert.equal(await add(), 9n);
    });
  const raw = await trace('get_memory_access_trace', canisterId);
  await writeFile(join(build, 'stabilization-trace.json'),
    JSON.stringify(raw, null, 2) + '\n');
  await trace('stop_memory_access_tracing', canisterId);
  await trace('clear_memory_access_trace', canisterId);
  await check('candidate: trace proves multiple stabilization increments',
    async () => {
      const executions = raw.executions;
      assert.ok(Array.isArray(executions), 'expected native trace executions');
      const count = name => executions.filter(execution =>
        execution.function.includes(name)).length;
      const counts = {stabilization: count('@motoko_async_stabilization'),
        destabilization: count('@motoko_async_destabilization')};
      observations.stabilizationIncrements = counts;
      assert.ok(counts.stabilization > 1, JSON.stringify(counts));
      assert.ok(counts.destabilization > 1, JSON.stringify(counts));
    });
}

const report = {status: 'running', passed: results,
  observations, buildManifest: manifest,
  pocketIc: {binary, sha256: hash(await readFile(binary))}};
let session;
try {
  session = await start();
  await messages(session.pic, 'candidate');
  await upgrades(session.pic, 'candidate', 'candidate');
  if (manifest.compilers.baseline) {
    await messages(session.pic, 'baseline');
    await upgrades(session.pic, 'baseline', 'baseline');
    await upgrades(session.pic, 'baseline', 'candidate');
    await upgrades(session.pic, 'candidate', 'baseline');
    await check('baseline -> candidate -> baseline: stable state survives both',
      async () => {
        const {id, actor} = await install(session.pic, 'baseline');
        assert.equal(await actor.add(9n), 50n);
        await upgrade(session.pic, id, 'candidate', false);
        assert.deepEqual(await actor.state(), [50n, 0n]);
        assert.equal(await actor.add(1n), 51n);
        await upgrade(session.pic, id, 'baseline', false);
        assert.deepEqual(await actor.state(), [51n, 0n]);
        assert.equal(await actor.add(1n), 52n);
      });
  }
  await stabilization(session);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = String(error.stack ?? error);
  throw error;
} finally {
  await writeFile(join(build, 'runtime-results.json'),
    JSON.stringify(report, (_, value) => typeof value === 'bigint' ?
      value.toString() : value, 2) + '\n');
  if (session) await session.stop();
}
