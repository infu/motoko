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
