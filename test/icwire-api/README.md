# Experimental public ICWire regression tests

These tests run against the isolated Tripwire compiler and a plugin rebuilt
against it.
They do not install or modify the normal Motoko toolchain.

```sh
TRIPWIRE=/absolute/path/to/experimental/tripwire \
ICWIRE_PLUGIN=/absolute/path/to/experimental/plugins/dist/icwire \
bash test/icwire-api/build.sh
node test/icwire-api/runtime.mjs
```

`ICWIRE_TEST_BUILD` overrides the `_build` artifact directory. `PIC_PACKAGE_DIR`
overrides the PocketIC JS package location (the development default is
`/srv/shared/code/ash/node_modules/@dfinity/pic`), and `POCKET_IC_BIN` overrides
the private server binary (default `$HOME/.local/bin/pocket-ic`). Each invocation
starts and stops its own server; it does not touch existing viewers or servers.

The host uses manually constructed bytes, independent of the plugin generator
and benchmark's schema client. It imports no application Candid codec. Known
literal Candid scalar envelopes are used only in the mixed-protocol and guard
negative tests. IC management create/install operations use the platform's
standard control-plane codec; the installed actor's constructor arguments use
ICWire.

Coverage includes nonempty constructor arguments, scalar and composite wire
values, arbitrary-size integers, zero and multiple arguments/results, a single
tuple argument/result, alias-typed calls, caller context, update/query/composite
query, oneway, reject callbacks, recursive compiler-generated async selfcalls,
actor and shared callback references, and mixed Candid/ICWire calls sharing the
same result type. Malformed and trailing
input must be rejected before the endpoint body runs. Candid `.did` output must
exclude ICWire methods and retain ordinary Candid methods.

Additional compile-only fixtures cover mixed inspect-message decoders, the
exclusion of composite queries from inspection, and explicit ICWire actor-class
syntax. Raw PocketIC calls bypass HTTP ingress inspection, so these tests do not
claim to execute the inspection hook. Positive type checks cover aliases,
declaration reordering, whole-method actor width and unchanged Candid variance.

Serializer checks alternate small and large Blob, record and vector values
across length-prefix and allocation boundaries, queries and peer calls. They
verify exact bytes after repeated malformed-input, node-count and byte-limit
failures. A valid 16 MiB encoding exceeds the IC's
smaller response limit: that case must fail at the platform boundary, while an
encoding over 16 MiB must fail in ICWire. Successful transferred values reach
1 MiB; no test claims the platform can deliver a 16 MiB response.
Invalid nonfinite floats occur after a large Blob in the same result, and
oversized outgoing calls must fail before the receiving endpoint runs. A
same-code upgrade repeats the wire checks without introducing any application
migration.

The same actor is compiled with `--trap-on-candid`. Its pure suite must pass,
then an intentional Candid endpoint call must trap. This exercises the guard
itself and detects hidden serialization in constructor, async continuation,
callback and reply paths; checking whether payloads start with `DIDL` alone does
not establish this property.

Negative frontend fixtures are `test/fail/icwire-*.mo`. Run them using
`test-runner -b test/fail/icwire-*.mo` from the compiler development environment,
and regenerate their expectation files with `-a` after reviewing diagnostics.
