// This actor has no "hot" endpoint. Main-actor selectors must not leak into
// the imported actor class while it is compiled into the caller's module.
actor class Child(seed : Nat) {
  public shared icwire func cold(value : Nat) : async Nat { value + seed };
}
