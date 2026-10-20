# Tripwire Wasm targets

Tripwire targets Wasm32 linear memory by default. Select `--wasm32` explicitly
or use `--wasm64` for the original memory64 target. The target applies to the
main module and to imported actor classes embedded during compilation.

```sh
bin/tripwire --plugin ../plugins/dist/icwire app.mo -o app.wasm
bin/tripwire --wasm64 --plugin ../plugins/dist/icwire app.mo -o app64.wasm
```

Wasm32 changes linear-memory addressing and the Internet Computer system-call
ABI. It retains the enhanced runtime's 64-bit managed values, object layout,
incremental collector and compute-plugin ABI. This is not a 32-bit heap-layout
port: objects do not become half their previous size. `Nat64`, `Int64`, larger
integers, Candid and ICWire retain their existing semantics and wire bytes.
Codec `speed` and `compact` policies are independent of the memory target.

The compiler first links the runtime and compute plugins, then lowers the
complete module. Plugins continue to build against the matching compiler's
Wasm64 runtime ABI; the final module uses Wasm32 memory. The same plugin package
can therefore compile either target. Do not substitute native Wasm32 Rust
plugin runtimes: their pointer-sized argument and object layouts differ.

Wasm32 main memory has a maximum of 65,535 pages, or 4 GiB minus 64 KiB. The last
page remains unavailable to preserve the runtime's overflow reserve. Failed
growth reports failure; out-of-range addresses trap rather than wrapping into
low memory. Internet Computer stable memory still uses its separate 64-bit
system API and is not reduced to the main-memory limit.

Normal builds (without `--sanity-checks`) omit redundant high-address checks
for ordinary loads/stores
in compiler-generated functions. These addresses come from bounded heap
objects or compiler-managed stack frames; array, blob and decoder bounds
checks remain in place. Linking appends native runtime functions after this
generated prefix. Rust/C runtime loads/stores retain narrowing checks because
their stack frames have different underflow behavior. `--sanity-checks` also
checks every generated load/store. Bulk memory operations, system-call
arguments, callback indices/environments and memory growth remain checked in
both modes. This optimization relies on the compiler and trusted plugin/FFI
contracts; it does not preserve arbitrary invalid raw-pointer Wasm behavior.
Normal builds additionally check every write to the shared stack pointer,
including native function frames, against its initial stack bound. This traps
native stack underflow before a callback can use compiler-managed temporary
storage, even if the native function has not accessed its own frame yet.

Enhanced orthogonal persistence retains the same 64-bit layout. Any deployed
heap must fit the selected target's memory limit; use Wasm64 when a retained
heap requires more memory. Changing the target is not a workflow or stored
payload migration. Applications must continue to preserve their concrete
memory and message contracts.

Drain physical calls before switching memory targets. The compiler's existing
preupgrade guard rejects upgrades with outstanding callbacks; do not bypass
that guard or skip preupgrade. Callback table entries are target-specific.

Benchmark comparisons must keep sources, codec policy, runtime, collector,
replica version and workload constant. Count native instructions including
page charges once, and report allocation, latency and simulated throughput
separately. A smaller address space does not establish a speed improvement.
