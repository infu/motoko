import Prim "mo:prim";

actor class Stabilization() {
  var value = 7;
  let values = Prim.Array_tabulate<{index : Nat; payload : Blob}>(
    1024, func(index) {{index; payload = "saved value"}}
  );

  public query func state() : async (Nat, Nat, Nat) {
    (value, values.size(), values[1023].index)
  };
  public func add(amount : Nat) : async Nat { value += amount; value };
};
