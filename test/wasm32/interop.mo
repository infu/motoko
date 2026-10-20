import Prim "mo:prim";
import { setTimer } "mo:⛔";
import Child "./child";

// Identical source is compiled for both linear-memory widths. Motoko values
// deliberately retain their full 64-bit and arbitrary-precision representation.
actor {
  type Value = {
    a : Nat; b : Int; c : Nat64; d : Text; e : [?Nat32]; f : Blob;
    g : { #a; #b : Float }
  };
  type Peer = actor {
    wire : shared icwire Value -> async Value;
    candid : shared Value -> async Value;
    wireQuery : shared icwire query Value -> async Value;
    candidQuery : shared query Value -> async Value;
    failWire : shared icwire () -> async ();
    failCandid : shared () -> async ();
  };
  var callbacks = 0;
  var cleanups = 0;
  var timers = 0;

  public shared icwire func wire(value : Value) : async Value { value };
  public shared func candid(value : Value) : async Value { value };
  public shared icwire query func wireQuery(value : Value) : async Value {
    value
  };
  public shared query func candidQuery(value : Value) : async Value { value };

  public shared icwire func relay(
    target : Principal, value : Value
  ) : async Value {
    let peer = Prim.actorOfPrincipal<Peer>(target);
    let first = await peer.candid(value);
    let second = await peer.wire(first);
    callbacks += 2;
    await async { await async { second } }
  };
  public shared func relayCandid(
    target : Principal, value : Value
  ) : async Value {
    let peer = Prim.actorOfPrincipal<Peer>(target);
    let first = await peer.wire(value);
    let second = await peer.candid(first);
    callbacks += 2;
    await async { await async { second } }
  };
  public shared icwire composite query func compositeWire(
    target : Principal, value : Value
  ) : async Value {
    let peer = Prim.actorOfPrincipal<Peer>(target);
    let first = await peer.candidQuery(value);
    await peer.wireQuery(first)
  };
  public shared composite query func compositeCandid(
    target : Principal, value : Value
  ) : async Value {
    let peer = Prim.actorOfPrincipal<Peer>(target);
    let first = await peer.wireQuery(value);
    await peer.candidQuery(first)
  };

  public shared icwire func failWire() : async () {
    throw Prim.error("expected wire rejection")
  };
  public shared func failCandid() : async () {
    throw Prim.error("expected Candid rejection")
  };
  public shared icwire func rejected(
    target : Principal, useWire : Bool
  ) : async (Nat, Nat) {
    let peer = Prim.actorOfPrincipal<Peer>(target);
    var caught = false;
    try {
      if (useWire) await peer.failWire() else await peer.failCandid()
    } catch error {
      assert Prim.errorMessage(error) ==
        (if (useWire) "expected wire rejection" else
          "expected Candid rejection");
      callbacks += 1;
      caught := true
    } finally {
      cleanups += 1
    };
    assert caught;
    (callbacks, cleanups)
  };
  public shared icwire query func stats() : async (Nat, Nat, Nat) {
    (callbacks, cleanups, timers)
  };
  public shared icwire func armTimer() : async () {
    ignore setTimer<system>(1_000_000, false, func () : async () {
      let next = await async { timers + 1 };
      timers := next
    })
  };
  public shared icwire func createChild(seed : Nat64) : async Principal {
    let child = await (with cycles = 2_000_000_000_000) Child.Child(seed);
    assert (await child.wire(3)) == seed + 3;
    assert (await child.candid(5)) == seed + 5;
    Prim.principalOfActor(child)
  };
}
