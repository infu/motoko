actor {
  public shared icwire func wire(n : Nat) : async Nat { n };
  public shared func candid(n : Nat) : async Nat { n };
  public shared icwire composite query func compositeQuery() : async Nat { 0 };

  // Composite queries are excluded; each decoder keeps the endpoint protocol.
  system func inspect({ msg : {
    #wire : () -> Nat;
    #candid : () -> Nat;
  } }) : Bool {
    switch msg {
      case (#wire decode) { decode() != 13 };
      case (#candid decode) { decode() != 14 };
    }
  }
}
