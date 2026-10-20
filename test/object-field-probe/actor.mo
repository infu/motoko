import Cases "cases";
import Prim "mo:prim";

actor class FieldProbe() {
  type Cell = { var b : Nat; var d : Text; f : Nat };
  let exact : Cell = { var b = 0; var d = "exact"; f = 1 };
  let wide = {
    a = 10; var b = 0; c = 20; var d = "wide";
    e = 30; f = 2; g = 40
  };
  let narrow : Cell = wide;
  let alias : Cell = narrow;
  var rounds = 0;
  transient var scratch : [Nat] = [];

  public func cases(seed : Nat) : async Nat { Cases.run(seed) };

  func update(seed : Nat, text : Text) {
    Cases.write(exact, seed, text # ":exact");
    Cases.write(narrow, seed, text # ":wide");
    assert wide.b == alias.b;
    assert wide.d == alias.d;
    rounds += 1
  };

  public func mutate(seed : Nat, text : Text) : async () {
    update(seed, text)
  };

  public query func state() : async (Nat, Text, Nat, Text, Nat) {
    (exact.b, exact.d, alias.b, alias.d, rounds)
  };

  public func callback(seed : Nat, text : Text) : async () {
    let saved : Cell = narrow;
    update(seed, text);
    await async {};
    assert saved.b == wide.b;
    assert saved.d == alias.d;
    saved.d := saved.d # ":callback";
    assert alias.d == wide.d;
    assert exact.f == 1;
    assert saved.f == 2
  };

  public func churn(count : Nat, seed : Nat) : async Nat {
    // Keep the preceding allocation alive until the next execution so the
    // default collector must trace the persisted exact/wide objects too.
    scratch := Prim.Array_tabulate<Nat>(count, func(index) { seed + index });
    scratch[count - 1]
  };

  public query func stats() : async (Nat, Nat, Nat) {
    (Prim.rts_total_allocation(), Prim.rts_reclaimed(),
      Prim.rts_collector_instructions())
  };
};
