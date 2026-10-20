# Wasm32 execution boundaries

These runners execute synthetic modules emitted by
`src/wasm-exts/test_memory32.ml` after `Memory32.lower`. They complement its AST
assertions and the application benchmarks. They need Python 3, Node.js with
WebAssembly/BigInt support, and a Wasmtime CLI supporting `-W memory64=n`.
The original execution used Node.js 24.11.1 and Wasmtime 45.0.2.

From the repository root, in the compiler development environment:

```sh
fixture_dir=$(mktemp -d)
(
  cd src
  MEMORY32_TEST_WASM="$fixture_dir/boundaries.wasm" \
  MEMORY32_TEST_CALLBACK_WASM="$fixture_dir/callbacks.wasm" \
  MEMORY32_TEST_STACK_WASM="$fixture_dir/stack-callbacks.wasm" \
    dune exec wasm-exts/test_memory32.exe
)
python3 test/wasm32-boundaries/run-wasmtime.py \
  --wasm "$fixture_dir/boundaries.wasm" \
  --output "$fixture_dir/wasmtime.json"
node test/wasm32-boundaries/run-memory.js \
  --wasm "$fixture_dir/boundaries.wasm" \
  --output "$fixture_dir/memory.json"
node test/wasm32-boundaries/run-callbacks.js \
  --wasm "$fixture_dir/callbacks.wasm" \
  --output "$fixture_dir/callbacks.json"
node test/wasm32-boundaries/run-stack-callbacks.js \
  --wasm "$fixture_dir/stack-callbacks.wasm" \
  --output "$fixture_dir/stack-callbacks.json"
```

Use `--wasmtime /path/to/wasmtime` when it is outside `PATH`. Each runner exits
nonzero on failure. `--output` is optional; without it the full JSON report is
written to standard output. Wasmtime compilation caching is disabled.

The Wasmtime runner checks 66 cases with memory64 explicitly disabled: valid
loads/stores and bulk operations, packed loads, growth results, high addresses,
lengths that would truncate to 32 bits, and effective-address offset overflow.
The 25 persistent-memory checks verify that rejected operations leave low
memory unchanged, packed signed/unsigned loads agree, addresses above 2 GiB
work, the last available bytes work, and the reserved last page traps. They
grow to 65,535 pages (almost 4 GiB of virtual memory), touching only a few pages.

The 17 callback checks use stub IC0 imports to verify the Wasm32 reply, reject
and cleanup ABI, unsigned environment extension, invalid callback indexes,
unchanged 64-bit timestamps and stable64 arguments, and rejection of internal
indirect calls into the appended callback half of the table. These stubs do
not replace PocketIC system-API integration tests.

The seven stack-callback cases exercise a native function that publishes its
stack pointer and immediately invokes a compiler-generated callback without
accessing its own frame. The callback deliberately uses an unchecked store.
Five invalid pointer values, including underflow and a value that would wrap
onto the low-memory marker, must trap before publishing the pointer or changing
that marker. Two valid values exercise the bound and prove the callback can
execute. This checks the shared stack-pointer guard needed when release builds
omit redundant checks for compiler-generated heap loads/stores; native memory
accesses remain checked. Repeated execution of the portable runner is the same
seven cases, not additional scenarios.
