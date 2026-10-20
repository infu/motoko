# Wasm32 public API integration tests

Run only after building the compiler and its matching ICWire plugin:

```sh
TRIPWIRE=/absolute/path/to/moc \
ICWIRE_PLUGIN=/absolute/path/to/plugins/dist/icwire \
WASM32_BUILD=/absolute/path/to/fresh/evidence-directory \
python3 test/wasm32/run.py
```

`ICWIRE_FAST_PACKAGE`, `MOC_RELEASE_RTS`, `MOC_DEBUG_RTS`, `PIC_PACKAGE_DIR`
and `POCKET_IC_BIN` accept the same overrides as `test/icwire-opt`. The harness
starts and stops only its own custom PocketIC 16 server; existing servers,
viewers and traces remain untouched. It records actual compiler and Node exits,
input objects, artifact hashes, memory limits, exact raw-call/reply objects and
server termination. Successful build hashes are checked before installation;
existing execution reports cannot be overwritten. No instruction-performance
claim is derived from these tests.

Eight artifacts test default output against explicit `--wasm32`, retain
`--wasm64`, and exercise both ICWire optimization levels. The existing
`test/icwire-opt/runtime.mo` supplies large integers, Unicode, nested records,
options, variants, a 64 KiB Blob, all eight ICWire APIs and malformed-input
recovery. Its source is reused rather than copied. Its Speed Wasm32 actor and
Compact Wasm64 actor exchange calls and composite queries in both directions.

The small mixed-protocol fixture additionally exercises Candid and ICWire
calls between opposite memory widths, private asynchronous continuations,
reply and reject callbacks, `finally` cleanup, timers, and imported actor-class
installation. Wide Motoko values remain wide on both targets. Management
create/install control-plane messages use the platform's normal protocol.
Embedded actor-class Wasm is extracted from data segments and its actual memory
width checked separately; successful mixed-width calls do not prove its width.
Parent installation uses gzip to fit the management ingress request limit;
reported module sizes and hashes still refer to complete uncompressed Wasm.
The inspection fixture is compiled at both widths, but raw PocketIC calls
bypass ingress inspection: this is not a runtime inspection test.

The separate `test/wasm32-runtime` suite owns GC, stable-memory and upgrade
coverage. These API tests do not change persistence layouts or establish that
cross-width upgrades are safe.
