import Child "./imported";

// Actor classes require internal identifier renaming. The selector names the
// externally exported method "hot", never its compiler-generated identifier.
actor class Policy(seed : Nat) {
  public shared icwire func hot(value : Nat) : async Nat { value + seed };
  public shared icwire func create(value : Nat) : async Nat {
    let child = await Child.Child(seed);
    await child.cold(value)
  };
}
