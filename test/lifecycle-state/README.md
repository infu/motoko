# Lifecycle state regressions

These pure-Prim canisters exercise the runtime state transitions affected by
moving the compiler's lifecycle enum from linear memory to a Wasm global.
They use ordinary Candid methods and require no Mops packages or compute plugins.

```sh
TRIPWIRE=/absolute/path/to/candidate/sdk/bin/tripwire \
BASELINE_TRIPWIRE=/absolute/path/to/accepted/sdk/bin/tripwire \
LIFECYCLE_TEST_BUILD=/absolute/path/to/fresh/evidence \
python3 test/lifecycle-state/build.py

LIFECYCLE_TEST_BUILD=/absolute/path/to/fresh/evidence \
POCKET_IC_BIN="$HOME/.local/bin/pocket-ic" \
node test/lifecycle-state/runtime.mjs
```

`BASELINE_TRIPWIRE` is optional. When provided, the suite runs the message tests
with both compilers and checks upgrades in both directions as well as same-code
upgrades. All fixture compilation uses `-Werror` without warning suppressions.
The fixture has no application preupgrade/postupgrade hooks: the upgrade checks
cover the compiler's system-method transitions and state restoration with both
`skip_pre_upgrade` settings. Skipping preupgrade also skips Motoko's stable actor
save; its resulting reset is asserted against both compiler versions.

The suite checks successful and trapping query rollback, isolated composite-query
reply/reject callbacks, update reply/reject callbacks, and callback-trap cleanup.
It verifies zero outstanding continuations and a successful update after each
callback path. EOP upgrades preserve Wasm heap memory.

A separate 1024-record fixture sets low graph-copy instruction and memory limits
to force explicit stabilization and destabilization over multiple messages.
Ordinary methods must be gated during both phases, then resume with intact data.
The custom PocketIC 16 memory trace proves multiple async increments and is saved
before the private test server is shut down. Server traces are then cleared.

`build.json` pins compiler, RTS, fixture and artifact hashes. Runtime rechecks the
artifact hashes and records the PocketIC binary hash, results, upgrade states and
increment counts in `runtime-results.json`. `PIC_PACKAGE_DIR` can select another
installation of the `@dfinity/pic` JS client.
