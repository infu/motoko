import Prim "mo:prim";

actor class Lifecycle(seed : Nat) {
  var value = seed;
  transient var queryWrites = 0;
  type Peer = actor {
    echo : shared Nat -> async Nat;
    reject : shared () -> async Nat;
    read : shared query () -> async Nat;
    queryReject : shared query () -> async Nat;
  };

  public query func state() : async (Nat, Nat) {
    (value, queryWrites)
  };
  public query func callbacks() : async Nat {
    Prim.rts_callback_table_count()
  };
  public query func read() : async Nat { value };
  public query func queryWrite() : async Nat {
    value += 1000;
    queryWrites += 1;
    value
  };
  public query func queryTrap() : async Nat {
    value += 1000;
    queryWrites += 1;
    Prim.trap("expected query trap")
  };
  public query func queryReject() : async Nat {
    throw Prim.error("expected query rejection")
  };
  public composite query func compositeRoundtrip(
    target : Principal, reject : Bool
  ) : async Nat {
    let peer = Prim.actorOfPrincipal<Peer>(target);
    value += 1000;
    queryWrites += 1;
    try {
      if (reject) {
        ignore await peer.queryReject();
        Prim.trap("query rejection was expected")
      } else {
        ignore await peer.read()
      }
    } catch error {
      assert reject;
      assert Prim.errorMessage(error) == "expected query rejection"
    };
    value += 1;
    value
  };
  public func add(amount : Nat) : async Nat { value += amount; value };
  public func echo(amount : Nat) : async Nat { amount };
  public func reject() : async Nat {
    throw Prim.error("expected update rejection")
  };
  public func roundtrip(target : Principal, reject : Bool) : async Nat {
    let peer = Prim.actorOfPrincipal<Peer>(target);
    try {
      if (reject) {
        ignore await peer.reject();
        Prim.trap("update rejection was expected")
      } else {
        assert (await peer.echo(17)) == 17
      }
    } catch error {
      assert reject;
      assert Prim.errorMessage(error) == "expected update rejection"
    };
    value += 1;
    value
  };
  public func callbackTrap(target : Principal) : async Nat {
    let peer = Prim.actorOfPrincipal<Peer>(target);
    value += 1;
    ignore await peer.echo(17);
    value += 1000;
    Prim.trap("expected callback trap")
  };
};
