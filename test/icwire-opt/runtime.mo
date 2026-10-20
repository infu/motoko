import Prim "mo:prim";
import ICWire "mo:fast/ICWire";

// Every endpoint deliberately shares this nested schema. Policy must be in
// helper and callback cache identities, rather than depending on first use.
actor {
  type Nested = { a : Nat64; b : [?Text] };
  type Choice = { #a; #b : Nested; #c : [Nat] };
  type Payload = {
    a : Nat; b : Text; c : [Nat32]; d : ?Nested; e : Choice;
    f : (Blob, Int, Bool)
  };
  type Peer = actor {
    hot : shared icwire Payload -> async Payload;
    cold : shared icwire Payload -> async Payload;
    queryValue : shared icwire query Payload -> async Payload;
  };

  // Separately compiled helpers intentionally retain the global policy.
  func topLevel(value : Payload) : Blob { ICWire.encodeOrTrap(value) };

  public shared icwire func hot(value : Payload) : async Payload { value };
  public shared icwire func cold(value : Payload) : async Payload { value };
  public shared icwire query func queryValue(value : Payload) : async Payload {
    value
  };
  public shared icwire composite query func compositeValue(
    target : Principal, value : Payload
  ) : async Payload {
    await Prim.actorOfPrincipal<Peer>(target).queryValue(value)
  };
  public shared icwire func forwardHot(
    target : Principal, value : Payload
  ) : async Payload {
    let peer = Prim.actorOfPrincipal<Peer>(target);
    let result = await peer.hot(value);
    // The recursive async continuation must inherit the endpoint policy too.
    await async { await async { result } }
  };
  public shared icwire func forwardCold(
    target : Principal, value : Payload
  ) : async Payload {
    let peer = Prim.actorOfPrincipal<Peer>(target);
    let result = await peer.cold(value);
    await async { await async { result } }
  };

  // All eight APIs are checked under inherited and explicitly forced levels.
  // Keep inherited operations inside the method, not a top-level helper.
  public shared icwire func defaultApis(value : Payload) : async Blob {
    let wire = ICWire.unwrap(ICWire.encode(value));
    assert ICWire.encodeOrTrap(value) == wire;
    assert ICWire.unwrap(ICWire.encodeBounded(value, wire.size())) == wire;
    assert ICWire.encodeBoundedOrTrap(value, wire.size()) == wire;
    assert ICWire.estimateSize(value) == wire.size();
    assert ICWire.unwrap(ICWire.decode<Payload>(wire)) == value;
    assert ICWire.decodeOptional<Payload>(wire) == ?value;
    assert ICWire.decodeOrTrap<Payload>(wire) == value;
    wire
  };
  public shared icwire func compactApis(value : Payload) : async Blob {
    let wire = ICWire.unwrap(ICWire.Compact.encode(value));
    assert ICWire.Compact.encodeOrTrap(value) == wire;
    assert ICWire.unwrap(ICWire.Compact.encodeBounded(value, wire.size())) == wire;
    assert ICWire.Compact.encodeBoundedOrTrap(value, wire.size()) == wire;
    assert ICWire.Compact.estimateSize(value) == wire.size();
    assert ICWire.unwrap(ICWire.Compact.decode<Payload>(wire)) == value;
    assert ICWire.Compact.decodeOptional<Payload>(wire) == ?value;
    assert ICWire.Compact.decodeOrTrap<Payload>(wire) == value;
    wire
  };
  public shared icwire func speedApis(value : Payload) : async Blob {
    let wire = ICWire.unwrap(ICWire.Speed.encode(value));
    assert ICWire.Speed.encodeOrTrap(value) == wire;
    assert ICWire.unwrap(ICWire.Speed.encodeBounded(value, wire.size())) == wire;
    assert ICWire.Speed.encodeBoundedOrTrap(value, wire.size()) == wire;
    assert ICWire.Speed.estimateSize(value) == wire.size();
    assert ICWire.unwrap(ICWire.Speed.decode<Payload>(wire)) == value;
    assert ICWire.Speed.decodeOptional<Payload>(wire) == ?value;
    assert ICWire.Speed.decodeOrTrap<Payload>(wire) == value;
    wire
  };
  public shared icwire func helper(value : Payload) : async Blob {
    topLevel(value)
  };
  public shared icwire func asyncApis(value : Payload) : async Blob {
    let saved = await async { await async { value } };
    ICWire.encodeOrTrap(saved)
  };
  public shared icwire func invalid(
    mode : Nat, direct : Bool, wire : Blob
  ) : async (Text, Nat64) {
    if (direct) {
      switch mode {
        case (0) { ignore ICWire.decodeOrTrap<Payload>(wire) };
        case (1) { ignore ICWire.Compact.decodeOrTrap<Payload>(wire) };
        case (_) { ignore ICWire.Speed.decodeOrTrap<Payload>(wire) };
      };
      return ("unexpected", 0)
    };
    let result = switch mode {
      case (0) {
        assert ICWire.decodeOptional<Payload>(wire) == null;
        ICWire.decode<Payload>(wire)
      };
      case (1) {
        assert ICWire.Compact.decodeOptional<Payload>(wire) == null;
        ICWire.Compact.decode<Payload>(wire)
      };
      case (_) {
        assert ICWire.Speed.decodeOptional<Payload>(wire) == null;
        ICWire.Speed.decode<Payload>(wire)
      };
    };
    switch result {
      case (#err error) (error.kind, error.offset);
      case (#ok _) Prim.trap("invalid input unexpectedly decoded");
    }
  };
  public shared icwire func insufficient(value : Payload) : async Bool {
    let bound = Prim.abs((ICWire.estimateSize(value) : Int) - 1);
    let a = ICWire.encodeBounded(value, bound);
    let b = ICWire.Compact.encodeBounded(value, bound);
    let c = ICWire.Speed.encodeBounded(value, bound);
    switch (a, b, c) {
      case (#err x, #err y, #err z) {
        assert x == y and y == z;
        true
      };
      case (_) false;
    }
  };
  public shared func candid(value : Nat) : async Nat { value };
}
