# Tripwire: experimental ICWire actor API

Tripwire is the compiler in this isolated Motoko experiment. It adds an explicit
wire protocol to shared Motoko function types.
An actor can expose and call both ordinary Candid methods and ICWire methods.
The IC routing name, caller authentication, cycles, update/query distinction and
asynchronous call semantics still use the normal Internet Computer system API.
Only the method argument and successful reply payloads change encoding.

Run it from this SDK worktree with `bin/tripwire`. For example, with an ICWire
plugin built against this compiler:

```sh
bin/tripwire --version
bin/tripwire --plugin ../plugins/dist/icwire \
  --icwire-internal example.mo -o example.wasm
```

The existing `make -C src moc` build target and `bin/moc` test-tool entry remain
available for the compiler repository's tooling. This experiment does not
replace an installed compiler or change another worktree's commands.

```motoko
type Request = { id : Nat; body : Blob };
type Receipt = { accepted : Bool };

type Peer = actor {
  submit : shared icwire Request -> async Receipt;
  status : shared icwire query Nat -> async ?Receipt;
  publicStatus : shared query Nat -> async ?Receipt;
};

persistent actor Example {
  public shared icwire ({ caller }) func submit(request : Request)
    : async Receipt {
    // Admission and authorization are application responsibilities.
    { accepted = request.body.size() > 0 }
  };

  public shared icwire query func status(id : Nat) : async ?Receipt {
    null
  };

  public shared query func publicStatus(id : Nat) : async ?Receipt {
    null
  };
};
```

The corresponding composite-query spelling is
`shared icwire composite query`. The protocol is part of the function type and
survives type aliases, actor interfaces and function references. An outgoing
typed call uses the protocol in its callee type; it does not infer the protocol
from a method name or inspect the returned bytes. Existing declarations without
`icwire` retain Candid.

## Bytes and schemas

The compiler specializes the same `icwire_encode` and `icwire_decode`
plugin operations used by `mo:fast/ICWire`. Load the ICWire plugin when compiling an
actor that uses this API; endpoint payload types are validated against the
loaded plugin. There is no separate protocol wrapper, `DIDL` magic, schema
descriptor, runtime registry, field ID or endpoint method ID in the payload.
The IC already supplies the destination method name.

An argument or result sequence is encoded as one sequence value: zero values
become unit, one value remains that value, and multiple values become a tuple.
An endpoint accepting a single tuple uses the tuple's exact declared schema.
Unit encodes as zero bytes. Successful replies use the declared result schema;
IC rejection messages remain IC system-level rejection messages.

ICWire's existing positional contract applies. Fixed words are little endian;
lengths and variant ordinals use minimal unsigned LEB128. Records concatenate
their values in compile-time label-hash order. Variants encode their ordinal in
the sorted case list followed by the selected value. Label identities determine
compile-time ordering but are never transmitted. The plugin documentation and
ABI define the full scalar, collection, recursive-value and resource limits.

Both ends must use exactly the same schema. ICWire function parameters and
results are invariant; ordinary Candid function variance, record projection,
optional-field extension, variant extension and `Nat`/`Int` coercion cannot
change an ICWire function's payload contract. An actor interface can still
omit entire methods. Changing an existing method's payload schema requires an
explicit application-level contract change after its in-flight and retained
messages are safely resolved.

Supported payloads are the immutable data supported by the ICWire plugin,
including actor references and shared function references. An actor reference
encodes its principal; a shared function reference encodes its actor principal
followed by the method name as `Text`. No signature or protocol descriptor is
transmitted. The exact static schema determines whether a referenced method
uses Candid or ICWire. Local functions, mutable data, `Any` and runtime handles
are not ICWire payloads. Both floating-point widths reject NaN and infinities.
The decoder checks malformed scalar encodings, resource limits, truncation
and trailing bytes in its normal typed pass. An unsuccessful decode traps
before the method body runs. An unsuccessful reply encode traps instead of
publishing a partial reply.

By default, automatic API encoding uses exact-size `ICWire.encode`, including
outgoing arguments, successful replies, constructor arguments and private async
messages. The plugin measures the encoding, allocates its exact output size and
writes the value. Automatic encoding has no adaptive capacity hints or capacity
retries. Invalid values and values beyond the existing 16 MiB codec limit still
trap. This limit does not override the IC's separate request and response size
limits. Explicit `ICWire.encodeBounded` remains available to application code.

## Codec optimization levels

Tripwire offers two code generation policies for ICWire. `speed`, the default,
retains the specialized visitors and exact-size output allocation described
above. `compact` shares more visitor code and uses the streaming encoder to
reduce generated Wasm. Compact encoding still returns exactly the encoded bytes;
it does not choose a caller bound or add spare capacity to the wire payload.
The policies have identical schemas, bytes, validation limits and error results.
They differ in generated code and instruction costs. Their size and speed
tradeoff depends on the concrete types and operations.

Select the global policy, then override queries or individual hot endpoints:

```sh
bin/tripwire --plugin ../plugins/dist/icwire --icwire-internal \
  --icwire-opt compact \
  --icwire-opt-query compact \
  --icwire-opt-endpoint reactor_receive=speed \
  --icwire-opt-endpoint submit=speed \
  example.mo -o example.wasm
```

`--icwire-opt-query` covers public ICWire queries and composite queries.
An explicit endpoint override takes precedence over the query policy, which
takes precedence over the global policy. Flag order does not change precedence.
Each endpoint selector names an exact public ICWire method export in the main
compilation target. Unknown names, Candid methods and repeated selectors are
errors. Imported actor classes use the global and query policies; selectors for
the main actor do not apply to their methods.

An endpoint's policy covers its argument decoder, reply encoder and ICWire
operations compiled in its body, including nested asynchronous continuations,
outgoing arguments and reply callbacks. This is a lexical compilation choice.
A helper defined outside the endpoint uses the global policy; calling it from
a hot endpoint does not compile a second specialization of it. Constructors,
system hooks, the shared async dispatch endpoint and `inspect` argument readers
also use the global policy. In particular, a method override does not change the
separate reader supplied to `inspect`. Ordinary application field accesses and
Candid serialization are unaffected by these codec policies.

For individual internal codecs, explicitly select the policy at the call site:

```motoko
import ICWire "mo:fast/ICWire";

let saved = ICWire.Compact.encodeOrTrap(request);
let hot = ICWire.Speed.decodeOrTrap<Request>(saved);
```

Both namespaces expose `encode`, `encodeBounded`, `decode`, `decodeOptional`,
`encodeOrTrap`, `decodeOrTrap`, `encodeBoundedOrTrap` and `estimateSize`.
These aliases select code generation at compilation; no policy value, descriptor
or dispatch branch is included in a message or evaluated at runtime. Ordinary
`ICWire` operations follow the compilation scope's policy. Explicit namespace
selection takes precedence over that policy, including inside shared local
helpers. Codec aliases retain their selection when passed through ordinary
Motoko bindings.

Optimization policy is absent from actor and function types. A compact client
can call a speed endpoint and a speed client can call a compact endpoint with
the same exact schema. These flags do not change protocol selection or relax
ICWire's schema invariance.

## Candid and discovery

Generated `.did` and `candid:service` descriptions include only actual Candid
methods. A pure ICWire actor therefore has an empty Candid service surface;
a mixed actor advertises only its Candid methods. Omitting an ICWire method
from Candid metadata does not remove its Wasm update/query export.

Candid has no annotation for the ICWire protocol. Candid payloads therefore
cannot transmit ICWire function references or actor references whose visible
interface contains ICWire methods. Pass a `Principal` and use an agreed typed
actor interface locally when discovery is needed. Merely importing
`mo:fast/ICWire` does not change a declaration's protocol.

Stable ICWire actor and function references are also rejected in this
experiment: persistence descriptors do not yet preserve the wire protocol.
Persist a `Principal` and reconstruct its agreed typed interface instead.

## Internal messages and the Candid audit

`--icwire-internal` selects ICWire for constructor arguments, compiler-private
asynchronous requests and replies, and the GC-trigger method. Constructor
callers must supply ICWire bytes with the exact constructor argument schema.
This flag leaves ordinary Candid method declarations on Candid; each public
method's explicit function type still selects its protocol. The compiler's
`__motoko_runtime_information` diagnostic query remains Candid and is not
invoked by the ICWire-only benchmark. Calling it in an audited module traps.

With this flag, generated `.did` files describe only the service and do not
advertise Candid constructor parameters; the Wasm also omits `candid:args`.
An imported actor class uses ICWire for its installation argument Blob, while
the management-canister installation envelope remains Candid. That management
call is intentionally unavailable under `--trap-on-candid`; the benchmark
installs its modules through the PocketIC host.

`--trap-on-candid` enables the experiment's runtime audit. Entering a Candid
serializer or deserializer traps, so an exercised application path cannot
silently fall back to Candid. It does not rewrite method types or replace
codec operations. Use it with `--icwire-internal` and explicit ICWire endpoint
declarations for the ICWire-only benchmark. Exercise an ordinary Candid call
separately without the audit flag to verify mixed-protocol interoperability.

Source and IR interpreters preserve protocol types and shared-call scheduling.
Like their existing Candid path, automatic shared calls pass typed values
without simulating transport bytes. Explicit ICWire codec operations use the
plugin reference implementation, but automatic endpoint byte validation,
resource-limit rejection, and non-finite-float rejection must be tested on
compiled Wasm. The PocketIC fixtures exercise those transport boundaries.

## Experiment measurement boundaries

An ICWire-only application benchmark must cover more than business method
calls. Setup, ingress, queries, cross-canister batches, replies, initialization
and compiler-private asynchronous continuations must use the experiment's
chosen wire. Audit those paths separately; changing a public signature alone
does not establish that the workload avoids Candid. Management-canister
installation calls belong to the PocketIC host setup, outside the measured
application-message workload.

Compare equivalent source workloads, populations, compiler optimization flags,
the default incremental collector, canister limits and PocketIC version. Native
PocketIC execution instruction totals already include page-access instruction
charges; report those charges separately without adding them a second time.
Retain Wasm/source hashes, raw traces, call counts, completion counts, malformed
input tests and latency coverage alongside timing and throughput results.
