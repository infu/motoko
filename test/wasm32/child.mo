// The compiler embeds and installs this actor class. Both public protocols
// must work in the embedded module as well as in the parent actor.
actor class Child(seed : Nat64) {
  public shared icwire func wire(value : Nat64) : async Nat64 {
    seed + value
  };
  public shared func candid(value : Nat64) : async Nat64 { seed + value };
}
