# Checked object field probes

`cases.mo` exercises exact lower-bound hits and wider physical records with
earlier, interleaved and trailing fields. It checks type-bounded reads, mutable
scalar and pointer fields, shared MutBox aliases, closure writes, and receiver
evaluation and assignment order. The actor retains both exact and wider narrowed
aliases across messages, incremental collection, callbacks and upgrades.

Use frozen compiler/RTS files and fresh output paths:

```sh
export FIELD_TEST_BUILD=/tmp/object-field-probe
export TRIPWIRE=/path/to/candidate/sdk/bin/tripwire
export BASELINE_TRIPWIRE=/path/to/baseline/sdk/bin/tripwire
python3 test/object-field-probe/build.py
python3 test/object-field-probe/engines.py
node test/object-field-probe/runtime.mjs
```

`engines.py` needs `wasmtime` and `wasm-validate` in the build environment.
`runtime.mjs` starts and stops its own PocketIC server, defaults to the custom
16.1 server, and writes collection observations and exact input hashes. It
requires real default incremental collection to reclaim bytes. The additional
explicit collection increments do not change the configured collector. Upgrade
checks use the same unchanged persisted schema in each compiler combination.
