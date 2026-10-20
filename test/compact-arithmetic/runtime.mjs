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
const build = resolve(process.env.COMPACT_TEST_BUILD);
const binary = process.env.POCKET_IC_BIN ??
  join(homedir(), '.local/bin/pocket-ic');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const oracle = JSON.parse(await readFile(join(build, 'oracle.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(build, 'build.json'), 'utf8'));
assert.equal(hash(await readFile(join(build, 'oracle.json'))),
  manifest.sources['oracle.json']);
const empty = new Uint8Array(IDL.encode([], []));
const passed = [], gc = {};

const idlFactory = ({IDL}) => IDL.Service({
  signed: IDL.Func([IDL.Vec(IDL.Tuple(IDL.Int, IDL.Int))],
    [IDL.Vec(IDL.Tuple(IDL.Int, IDL.Int))], []),
  natural: IDL.Func([IDL.Vec(IDL.Tuple(IDL.Nat, IDL.Nat))],
    [IDL.Vec(IDL.Tuple(IDL.Nat, IDL.Opt(IDL.Nat)))], []),
  subtract: IDL.Func([IDL.Nat, IDL.Nat], [IDL.Nat], []),
  retain: IDL.Func([IDL.Vec(IDL.Tuple(IDL.Int, IDL.Int))], [], []),
  retained: IDL.Func([], [IDL.Vec(IDL.Tuple(IDL.Int, IDL.Int,
    IDL.Int, IDL.Int))], ['query']),
  boxedSmall: IDL.Func([IDL.Nat, IDL.Nat32, IDL.Int],
    [IDL.Int, IDL.Int, IDL.Int], []),
  retainedSmall: IDL.Func([], [IDL.Int], ['query']),
  stats: IDL.Func([], [IDL.Nat, IDL.Nat, IDL.Nat], ['query']),
  churn: IDL.Func([IDL.Int, IDL.Nat], [IDL.Int], []),
  evaluationOrder: IDL.Func([], [IDL.Nat], []),
});

async function check(name, run) {
  await run();
  passed.push(name);
  console.log(`PASS ${name}`);
}

async function start() {
  const temporary = await mkdtemp(join(tmpdir(), 'compact-arithmetic-'));
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

async function suite(pic, label) {
  const artifact = manifest.artifacts[label];
  const wasm = await readFile(join(build, artifact.file));
  assert.equal(hash(wasm), artifact.sha256);
  const canisterId = await pic.createCanister();
  await pic.installCode({canisterId, wasm, arg: empty});
  const actor = pic.createActor(idlFactory, canisterId);
  await check(`${label}: ${oracle.signed.length} runtime signed pairs`, async () => {
    for (let offset = 0; offset < oracle.signed.length; offset += 128) {
      const rows = oracle.signed.slice(offset, offset + 128);
      assert.deepEqual(await actor.signed(rows.map(row =>
        [BigInt(row.a), BigInt(row.b)])), rows.map(row =>
        [BigInt(row.add), BigInt(row.sub)]), `signed batch ${offset}`);
    }
  });
  await check(`${label}: ${oracle.natural.length} runtime natural pairs`, async () => {
    for (let offset = 0; offset < oracle.natural.length; offset += 128) {
      const rows = oracle.natural.slice(offset, offset + 128);
      assert.deepEqual(await actor.natural(rows.map(row =>
        [BigInt(row.a), BigInt(row.b)])), rows.map(row =>
        [BigInt(row.add), row.sub === null ? [] : [BigInt(row.sub)]]),
      `natural batch ${offset}`);
    }
  });
  await check(`${label}: exact Nat underflow and following valid calls`, async () => {
    for (const [a, b] of oracle.underflow) {
      await assert.rejects(actor.subtract(BigInt(a), BigInt(b)),
        /Natural subtraction underflow/);
      assert.equal(await actor.subtract(9n, 4n), 5n);
    }
  });
  await check(`${label}: operands execute once from left to right`, async () => {
    assert.equal(await actor.evaluationOrder(), 12n);
  });
  await check(`${label}: boxed zero from runtime shift uses mixed fallback`, async () => {
    for (const row of oracle.signed.filter(row => row.a === '0')) {
      assert.deepEqual(await actor.boxedSmall(0n, 64, BigInt(row.b)),
        [0n, BigInt(row.add), BigInt(row.sub)]);
    }
  });
  const retained = oracle.retained.map(row =>
    [BigInt(row.a), BigInt(row.b), BigInt(row.add), BigInt(row.sub)]);
  await actor.retain(retained.map(row => row.slice(0, 2)));
  const verify = async () => {
    assert.deepEqual(await actor.retained(), retained);
    assert.equal(await actor.retainedSmall(), 0n);
  };
  await verify();
  gc[label] = {automatic: [], forced: []};
  await check(`${label}: retained boxed inputs/results survive default GC`, async () => {
    const before = await actor.stats();
    let observed = false;
    for (let turn = 0; turn < 32; turn++) {
      assert.equal(await actor.churn(BigInt(oracle.churn.salt),
        BigInt(oracle.churn.count)), BigInt(oracle.churn.last));
      const stats = await actor.stats();
      gc[label].automatic.push(stats);
      await verify();
      if (stats[1] > before[1]) {observed = true; break}
    }
    assert.ok(observed, 'default incremental GC must reclaim bytes');
  });
  await check(`${label}: retained boxed values survive forced GC increments`, async () => {
    let observed = false;
    for (let increment = 0; increment < 8; increment++) {
      await pic.updateCall({canisterId, method: '__motoko_gc_trigger', arg: empty});
      const stats = await actor.stats();
      gc[label].forced.push(stats);
      observed ||= stats[2] > 0n;
      await verify();
      assert.equal(await actor.subtract(9n, 4n), 5n);
    }
    assert.ok(observed, 'forced increments must consume collector instructions');
  });
}

const report = {status: 'running', passed, gc,
  oracle: {signedPairs: oracle.signed.length,
    naturalPairs: oracle.natural.length, underflowCases: oracle.underflow.length,
    retainedRows: oracle.retained.length,
    sha256: manifest.sources['oracle.json']},
  artifacts: manifest.artifacts, compilers: manifest.compilers,
  pocketIc: {binary, sha256: hash(await readFile(binary))}};
let session;
try {
  session = await start();
  for (const label of Object.keys(manifest.artifacts)) await suite(session.pic, label);
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
