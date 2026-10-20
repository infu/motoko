import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {homedir, tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';

const directory = process.env.PIC_PACKAGE_DIR ??
  '/srv/shared/code/ash/node_modules/@dfinity/pic';
const require = createRequire(join(directory, 'package.json'));
const {IDL} = require('@dfinity/candid');
const {PocketIc} = await import(pathToFileURL(join(directory, 'dist/pocket-ic.js')));
const build = resolve(process.env.FIELD_TEST_BUILD);
const binary = process.env.POCKET_IC_BIN ??
  join(homedir(), '.local/bin/pocket-ic');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(await readFile(join(build, 'build.json'), 'utf8'));
const empty = new Uint8Array(IDL.encode([], []));
const passed = [], gc = {};
const idlFactory = ({IDL}) => IDL.Service({
  cases: IDL.Func([IDL.Nat], [IDL.Nat], []),
  mutate: IDL.Func([IDL.Nat, IDL.Text], [], []),
  callback: IDL.Func([IDL.Nat, IDL.Text], [], []),
  state: IDL.Func([], [IDL.Nat, IDL.Text, IDL.Nat, IDL.Text, IDL.Nat], ['query']),
  stats: IDL.Func([], [IDL.Nat, IDL.Nat, IDL.Nat], ['query']),
  churn: IDL.Func([IDL.Nat, IDL.Nat], [IDL.Nat], []),
});

async function check(name, run) {
  await run();
  passed.push(name);
  console.log(`PASS ${name}`);
}

async function start() {
  const temporary = await mkdtemp(join(tmpdir(), 'object-field-probe-'));
  const portFile = join(temporary, 'port');
  const server = spawn(binary, ['--ip-addr', '127.0.0.1', '--port-file',
    portFile, '--log-levels',
    'pocket_ic_server=error,tower_http=error,axum::rejection=error'],
  {stdio: ['ignore', 'ignore', 'pipe']});
  let log = '', failure, pic;
  server.stderr.on('data', data => {log += data});
  server.on('error', error => {failure = error});
  async function stop() {
    try {if (pic) await pic.tearDown()} finally {
      if (server.exitCode === null && server.signalCode === null && server.pid) {
        const exited = once(server, 'exit');
        server.kill('SIGTERM');
        const timer = setTimeout(() => server.kill('SIGKILL'), 2000);
        try {await exited} finally {clearTimeout(timer)}
      }
      await writeFile(join(build, 'server.log'), log);
      await rm(temporary, {recursive: true, force: true});
    }
  }
  try {
    let port;
    const deadline = Date.now() + 90000;
    while (!port) {
      if (failure || server.exitCode !== null || server.signalCode !== null) {
        throw new Error(`PocketIC startup failed: ${failure ?? log}`);
      }
      try {port = Number(await readFile(portFile, 'utf8'))} catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (Date.now() > deadline) throw new Error('PocketIC startup timeout');
      if (!port) await delay(100);
    }
    pic = await PocketIc.create(`http://127.0.0.1:${port}`, {
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

async function code(label) {
  const artifact = manifest.artifacts[label];
  const bytes = await readFile(join(build, artifact.file));
  assert.equal(hash(bytes), artifact.sha256);
  return bytes;
}

async function install(pic, label) {
  const canisterId = await pic.createCanister();
  await pic.installCode({canisterId, wasm: await code(label), arg: empty});
  return {canisterId, actor: pic.createActor(idlFactory, canisterId)};
}

async function suite(pic, label) {
  const {actor, canisterId} = await install(pic, label);
  await check(`${label}: exact/wide probes, aliases and evaluation once`, async () => {
    for (const seed of [0n, 42n, 1n << 100n]) {
      assert.equal(await actor.cases(seed), 4n);
    }
  });
  await actor.mutate(13n, 'retained');
  let expected = [13n, 'retained:exact', 13n, 'retained:wide', 1n];
  const verify = async () => assert.deepEqual(await actor.state(), expected);
  await check(`${label}: retained narrowed mutable aliases`, verify);
  await check(`${label}: wider objects and MutBoxes survive callbacks`, async () => {
    await actor.callback(7n, 'callback');
    expected = [20n, 'callback:exact', 20n, 'callback:wide:callback', 2n];
    await verify();
  });
  gc[label] = {automatic: [], forced: []};
  await check(`${label}: retained exact/wide objects survive default GC`, async () => {
    const before = await actor.stats();
    let observed = false;
    for (let turn = 0; turn < 32; turn++) {
      assert.equal(await actor.churn(400000n, 1000n), 400999n);
      const stats = await actor.stats();
      gc[label].automatic.push(stats);
      await verify();
      if (stats[1] > before[1]) {observed = true; break}
    }
    assert.ok(observed, 'default incremental GC must reclaim bytes');
    await actor.mutate(3n, 'after-default-gc');
    expected = [23n, 'after-default-gc:exact', 23n, 'after-default-gc:wide', 3n];
    await verify();
  });
  await check(`${label}: reads and pointer stores after explicit GC increments`,
    async () => {
    let observed = false;
    for (let increment = 0; increment < 8; increment++) {
      await pic.updateCall({canisterId, method: '__motoko_gc_trigger', arg: empty});
      const stats = await actor.stats();
      gc[label].forced.push(stats);
      observed ||= stats[2] > 0n;
      await verify();
      await actor.mutate(1n, `after-gc-${increment}`);
      expected = [24n + BigInt(increment), `after-gc-${increment}:exact`,
        24n + BigInt(increment), `after-gc-${increment}:wide`,
        4n + BigInt(increment)];
      await verify();
    }
    assert.ok(observed, 'explicit increments must consume collector instructions');
  });
}

async function upgrade(pic, initial, next) {
  await check(`${initial} -> ${next}: same-schema keep-memory upgrade`, async () => {
    const {actor, canisterId} = await install(pic, initial);
    await actor.mutate(13n, 'before');
    await actor.callback(7n, 'before-callback');
    const before = await actor.state();
    await pic.upgradeCanister({canisterId, wasm: await code(next), arg: empty,
      upgradeModeOptions: {skip_pre_upgrade: [false],
        wasm_memory_persistence: [{keep: null}]}});
    assert.deepEqual(await actor.state(), before);
    await actor.mutate(5n, 'after');
    assert.deepEqual(await actor.state(),
      [25n, 'after:exact', 25n, 'after:wide', 3n]);
    assert.equal(await actor.cases(37n), 4n);
  });
}

const report = {status: 'running', passed, gc, artifacts: manifest.artifacts,
  compilers: manifest.compilers, sources: manifest.sources,
  pocketIc: {binary, sha256: hash(await readFile(binary))}};
let session;
try {
  for (const [name, digest] of Object.entries(manifest.sources)) {
    assert.equal(hash(await readFile(new URL(name, import.meta.url))), digest);
  }
  session = await start();
  for (const label of Object.keys(manifest.artifacts)) await suite(session.pic, label);
  await upgrade(session.pic, 'candidate', 'candidate');
  if (manifest.artifacts.baseline) {
    await upgrade(session.pic, 'baseline', 'candidate');
    await upgrade(session.pic, 'candidate', 'baseline');
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = String(error.stack ?? error);
  throw error;
} finally {
  await writeFile(join(build, 'runtime-results.json'), JSON.stringify(report,
    (_, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
  if (session) await session.stop();
}
