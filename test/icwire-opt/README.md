# ICWire optimization policy regression tests

Build and run these tests against the isolated Tripwire compiler and matching
plugin. The harness records each compiler exit and its stdout/stderr before
checking success, and records the actual Node process exit before inspecting its
JSON report.

```sh
TRIPWIRE=/absolute/path/to/sdk/src/_build/default/exes/moc.exe \
ICWIRE_PLUGIN=/absolute/path/to/plugins/dist/icwire \
ICWIRE_OPT_BUILD=/absolute/path/to/fresh/evidence-directory \
python3 test/icwire-opt/run.py
```

`ICWIRE_FAST_PACKAGE` overrides the sibling `packages/fast/src` package.
`MOC_RELEASE_RTS` and `MOC_DEBUG_RTS` default to this SDK's private runtime.
`PIC_PACKAGE_DIR` defaults to `/srv/shared/code/ash/node_modules/@dfinity/pic`.
`POCKET_IC_BIN` defaults to `$HOME/.local/bin/pocket-ic` (the custom version 16
server). Each runtime invocation starts and stops only its own server and writes
the server's PID, termination status and stderr to its report. Existing servers,
viewers and tracing records are untouched.

The fixture is compiled with default, speed, compact, query-group, query override
and opposite mixed endpoint policies. A retained generated source reverses the
equal-schema endpoint/callback declaration order. Main actor-class and imported
actor-class compilation also exercise exported-name selection and the rule that
main selectors do not apply to imported actors. Inspection compiles separately;
its readers deliberately retain the global policy. Raw PocketIC calls do not
execute ingress inspection, so no runtime inspection claim is made.

Runtime checks compare bytes to an independent literal host oracle for nested
records, options, variants, arrays, fixed and arbitrary-size integers, Unicode,
and a 64 KiB Blob. All eight default APIs and both forced namespaces are checked,
including exact size, bounded encoding and optional/trapping decoding. Tests
cover opposite-level cross-canister calls, same-schema callbacks, recursive async
continuations, composite queries, malformed bool/trailing errors and subsequent
recovery. Every runtime module uses `--trap-on-candid`; an intentional Candid
endpoint call must trap. Management create/install operations use the platform's
normal control-plane protocol.

Top-level helpers are compiled independently and keep the global level. The
`helper` endpoint deliberately selects the opposite level in mixed variants so
the static Wasm report can distinguish the helper body from automatic endpoint
decoding/reply encoding. `wasm_policy.py` records actual function names, code
hashes, direct calls and indirect-call limitations; wire equivalence alone does
not establish which optimization level was generated.
Its fixture assertions verify entry decoder levels, top-level helper policy,
callback decoder bodies and distinct same-schema callback identities under both
levels, including reversed declaration order. This static evidence does not
prove which indirect reply/async closure is invoked; runtime tests cover their
behavior and wire equivalence.

Negative CLI cases retain nonzero exits for invalid levels, malformed/empty and
duplicate selectors, unknown endpoints, a Candid target and a selector on a
non-actor program. These tests preserve the existing wire contract and do not
change GC policy, schemas or persisted layouts.
