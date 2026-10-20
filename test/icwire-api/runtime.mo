import Prim "mo:prim";

// A nonempty constructor makes an accidental Candid init path observable.
actor class Api(seed : Nat, expectedCaller : Principal) = this {
  transient var notifications = 0;
  transient var blobRequests = 0;
  type Pair = (Nat, Text);
  type Choice = { #a; #b : Nat };
  type Record = { a : Nat; b : Text; c : Bool };
  type NatCall = shared icwire Nat -> async Nat;
  type NatQuery = shared icwire query Nat -> async Nat;
  type View = actor { queryNat : NatQuery };
  type Peer = actor {
    zero : shared icwire () -> async ();
    echoNat : NatCall;
    many : shared icwire (Nat, Text) -> async (Nat, Text);
    tuple : shared icwire Pair -> async Pair;
    echoVariant : shared icwire Choice -> async Choice;
    echoRecord : shared icwire Record -> async Record;
    notify : shared icwire Nat -> ();
    queryNat : shared icwire query Nat -> async Nat;
    legacyNat : shared Nat -> async Nat;
    legacyQuery : shared query Nat -> async Nat;
    reject : shared icwire () -> async Nat;
    getCallback : shared icwire Principal -> async NatQuery;
    echoCallback : shared icwire NatQuery -> async NatQuery;
    getActor : shared icwire Principal -> async View;
    echoActor : shared icwire View -> async View;
    echoBlob : shared icwire Blob -> async Blob;
    acceptBlob : shared icwire Blob -> async Nat;
  };

  public shared icwire func zero() : async () {};
  public shared icwire func echoNat(n : Nat) : async Nat { n };
  public shared icwire func echoInt(n : Int) : async Int { n };
  public shared icwire func echoBool(v : Bool) : async Bool { v };
  public shared icwire func echoOpt(v : ?Nat) : async ?Nat { v };
  public shared icwire func echoVariant(v : Choice) : async Choice { v };
  public shared icwire func echoRecord(v : Record) : async Record { v };
  public shared icwire func echoArray(v : [Nat]) : async [Nat] { v };
  public shared icwire func echoText(v : Text) : async Text { v };
  public shared icwire func echoBlob(v : Blob) : async Blob { v };
  public shared icwire query func queryBlob(v : Blob) : async Blob { v };

  func filledBlob(size : Nat) : Blob {
    var remaining = size;
    var chunk = "Z";
    var value = "";
    while (remaining > 0) {
      if (remaining % 2 == 1) value #= chunk;
      remaining /= 2;
      if (remaining > 0) chunk #= chunk
    };
    Prim.encodeUtf8(value)
  };

  public shared icwire func emitBlob(size : Nat) : async Blob {
    filledBlob(size)
  };
  public shared icwire func relayBlob(target : Principal, size : Nat) : async Blob {
    let peer = Prim.actorOfPrincipal<Peer>(target);
    await peer.echoBlob(filledBlob(size))
  };
  public shared icwire func emitNulls(size : Nat) : async [Null] {
    Prim.Array_tabulate<Null>(size, func(_) { null })
  };
  public shared icwire func emitFloatTail(size : Nat, valid : Bool) : async (Blob, Float) {
    (filledBlob(size), if (valid) 1.5 else 0.0 / 0.0)
  };
  public shared icwire func acceptBlob(value : Blob) : async Nat {
    blobRequests += 1;
    value.size()
  };
  public shared icwire query func acceptedBlobs() : async Nat { blobRequests };
  public shared icwire func sendBlob(target : Principal, size : Nat) : async Nat {
    let peer = Prim.actorOfPrincipal<Peer>(target);
    await peer.acceptBlob(filledBlob(size))
  };
  public shared icwire func many(a : Nat, b : Text) : async (Nat, Text) {
    (a, b)
  };
  public shared icwire func tuple(value : Pair) : async Pair { value };
  public shared icwire func notify(n : Nat) : () {
    notifications += n
  };
  public shared icwire query func received() : async Nat { notifications };
  public shared icwire query func constructorValue() : async Nat { seed };
  public shared icwire query func queryNat(n : Nat) : async Nat { n };
  public shared icwire ({ caller }) func callerIsExpected() : async Bool {
    caller == expectedCaller
  };
  public shared icwire composite query func compositeQuery(
    target : Principal, n : Nat
  ) : async Nat {
    let peer = Prim.actorOfPrincipal<Peer>(target);
    await peer.queryNat(n)
  };
  public shared icwire func reject() : async Nat {
    throw Prim.error("expected ICWire rejection")
  };
  public shared icwire func getCallback(target : Principal) : async NatQuery {
    Prim.actorOfPrincipal<View>(target).queryNat
  };
  public shared icwire func echoCallback(callback : NatQuery) : async NatQuery {
    callback
  };
  public shared icwire func getActor(target : Principal) : async View {
    Prim.actorOfPrincipal<View>(target)
  };
  public shared icwire func echoActor(target : View) : async View { target };
  public shared icwire func callReturned(target : Principal) : async Nat {
    let peer = Prim.actorOfPrincipal<Peer>(target);
    let callback : NatQuery = await peer.getCallback(target);
    let returned = await peer.echoCallback(callback);
    assert (await returned(123)) == 123;
    let view : View = await peer.getActor(target);
    let returnedView = await peer.echoActor(view);
    await returnedView.queryNat(456)
  };

  func recurse(n : Nat) : async Nat {
    if (n == 0) return seed;
    await async { 1 + (await recurse(n - 1)) }
  };

  public shared icwire func runPure(target : Principal) : async Nat {
    let peer = Prim.actorOfPrincipal<Peer>(target);
    await peer.zero();
    // Calling through a type alias must retain the wire protocol.
    let call : NatCall = peer.echoNat;
    assert (await call(127)) == 127;
    assert (await peer.many(128, "snow ☃")) == (128, "snow ☃");
    assert (await peer.tuple((256, "tuple"))) == (256, "tuple");
    assert (await peer.echoVariant(#b(1000))) == #b(1000);
    assert (await peer.echoRecord({ a = 129; b = "x"; c = true })) ==
      { a = 129; b = "x"; c = true };
    peer.notify(3);
    assert (await peer.queryNat(3)) == 3;
    try {
      ignore await peer.reject();
      assert false
    } catch error {
      assert Prim.errorMessage(error) == "expected ICWire rejection"
    };
    let n = await async { await async { 128 } };
    n + (await recurse(4))
  };

  // Equal result types deliberately collide if callback caches omit the wire.
  public shared icwire func runMixed(target : Principal) : async Nat {
    let peer = Prim.actorOfPrincipal<Peer>(target);
    let a = await peer.legacyNat(5);
    let b = await peer.echoNat(7);
    let c = await peer.legacyQuery(9);
    let d = await peer.queryNat(11);
    a + b + c + d
  };
  public shared func legacyNat(n : Nat) : async Nat { n + seed };
  public shared query func legacyQuery(n : Nat) : async Nat { n + seed };
  public shared func legacyCallsWire(target : Principal) : async Nat {
    let peer = Prim.actorOfPrincipal<Peer>(target);
    await peer.echoNat(999)
  };
}
