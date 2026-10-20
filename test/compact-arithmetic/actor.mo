import Prim "mo:prim";

actor class Arithmetic() {
  var saved : [(Int, Int, Int, Int)] = [];
  var savedSmall : Int = 0;

  public func signed(rows : [(Int, Int)]) : async [(Int, Int)] {
    Prim.Array_tabulate<(Int, Int)>(rows.size(), func(index) {
      let (a, b) = rows[index];
      (a + b, a - b)
    })
  };
  public func natural(rows : [(Nat, Nat)]) : async [(Nat, ?Nat)] {
    Prim.Array_tabulate<(Nat, ?Nat)>(rows.size(), func(index) {
      let (a, b) = rows[index];
      (a + b, if (a >= b) ?(a - b) else null)
    })
  };
  public func subtract(a : Nat, b : Nat) : async Nat { a - b };
  public func retain(rows : [(Int, Int)]) : async () {
    saved := Prim.Array_tabulate<(Int, Int, Int, Int)>(rows.size(), func(index) {
      let (a, b) = rows[index];
      (a, b, a + b, a - b)
    })
  };
  public query func retained() : async [(Int, Int, Int, Int)] { saved };
  public func boxedSmall(
    zero : Nat, amount : Nat32, other : Int
  ) : async (Int, Int, Int) {
    let boxed = Prim.shiftLeft(zero, amount);
    savedSmall := boxed;
    (boxed, boxed + other, boxed - other)
  };
  public query func retainedSmall() : async Int { savedSmall };
  public query func stats() : async (Nat, Nat, Nat) {
    (Prim.rts_total_allocation(), Prim.rts_reclaimed(),
      Prim.rts_collector_instructions())
  };
  public func churn(salt : Int, count : Nat) : async Int {
    let values = Prim.Array_tabulate<Int>(count, func(index) { salt + index });
    values[count - 1]
  };
  public func evaluationOrder() : async Nat {
    var order = 0;
    func first() : Int {order := order * 10 + 1; -1};
    func second() : Int {order := order * 10 + 2; 2};
    assert first() + second() == 1;
    assert order == 12;
    order := 0;
    assert first() - second() == -3;
    order
  };
};
