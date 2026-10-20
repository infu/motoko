# Memory32 runtime regression

This fixture checks the unchanged 64-bit Motoko value layout behind memory32
indexing. It compiles the default, explicit `--wasm32` and `--wasm64` targets with
sanity checks and forced incremental GC, and requires default and wasm32 bytes to
match. Only the two distinct target artifacts are installed and executed. The
runtime checks retained arbitrary integers, immutable and mutable
arrays, a 64 KiB Blob, asynchronous continuations and stable regions across
messages and confirmed reclamation of more than 32 MiB of garbage.

One canister then upgrades with heap preservation through memory32 to memory32,
memory32 to memory64 and memory64 to memory32, checking pre/post hooks, retained
heap values, region contents and subsequent async callbacks after each upgrade.
The fixture intentionally exercises the compiler's pre/post-upgrade hooks and
disables only their known deprecation warning M0270. There is no migration or
alternate persisted layout. These upgrades cover heaps
below the memory32 limit; an existing heap above 65,535 pages cannot be retained
by a memory32 module. Memory32 also rejects an 8 GB allocation and verifies the
retained state after the trapped update. Low-level invalid addresses, oversized
growth and lowering instruction semantics belong to the lowering unit tests.
These upgrades await all asynchronous work and keep the compiler's existing
pre-upgrade guard against outstanding callbacks enabled. Switching memory
targets does not convert unresolved callback identities.

Set `WASM32_RUNTIME_SANITY=0` to run these same cases against release code,
including compiler-generated load/store guard elision and the unconditional
shared stack-pointer bound checks. The default `1` keeps every narrowing check
and links the debug runtime. Both modes retain `--force-gc`; the process report
records the selected mode. This option does not add scenarios or count repeated
executions as distinct tests.

```sh
TRIPWIRE=/absolute/path/to/moc \
ICWIRE_PLUGIN=/absolute/path/to/plugins/dist/icwire \
WASM32_RUNTIME_BUILD=/absolute/path/to/fresh/evidence \
python3 test/wasm32-runtime/run.py
```

`MOC_RELEASE_RTS` and `MOC_DEBUG_RTS` default to the SDK runtime files. The test
requires Node and `@dfinity/pic`, found by default in
`/srv/shared/code/ash/node_modules/@dfinity/pic`; override `PIC_PACKAGE_DIR` when
needed. `POCKET_IC_BIN` defaults to `$HOME/.local/bin/pocket-ic`. The harness
starts and stops only its own server, preserves actual process exits and logs,
checks tool/source hashes before and after, and records raw ICWire reply bytes.
Management create/install/upgrade uses the platform management protocol.
