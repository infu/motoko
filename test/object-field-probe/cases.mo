module {
  public type Read = { b : Nat; d : Text; f : Nat };
  public type Write = { var b : Nat; var d : Text; f : Nat };

  module FixtureModule {
    public let a = 1;
    public let b = 12;
    public let c = 2;
    public let d = "module";
    public let f = 34
  };

  class FixtureClass(seed : Nat) {
    public let a = 1;
    public var b = seed;
    public let c = 2;
    public var d = "class";
    public let f = 3;
    public func bump() { b += 1 }
  };

  public func read(value : Read) : (Nat, Text, Nat) {
    (value.b, value.d, value.f)
  };

  public func generic<T <: Read>(value : T) : (Nat, Text, Nat) {
    (value.b, value.d, value.f)
  };

  func readModule(value : module { b : Nat; d : Text; f : Nat }) {
    assert value.b == 12;
    assert value.d == "module";
    assert value.f == 34
  };

  public func write(value : Write, amount : Nat, text : Text) {
    value.b += amount;
    value.d := text
  };

  public func run(seed : Nat) : Nat {
    let expected = (seed, "value", seed + 1);
    let exact : Read = { b = seed; d = "value"; f = seed + 1 };
    let earlier = {
      a = 100; b = seed; d = "value"; f = seed + 1
    };
    let interleaved = {
      a = 100; b = seed; c = 200; d = "value";
      e = 300; f = seed + 1; g = 400
    };
    let trailing = {
      b = seed; d = "value"; f = seed + 1; z = 500
    };
    let rows : [Read] = [exact, earlier, interleaved, trailing];
    var index = 0;
    while (index < rows.size()) {
      assert read(rows[index]) == expected;
      assert generic<Read>(rows[index]) == expected;
      let { b; d; f } = rows[index];
      assert (b, d, f) == expected;
      index += 1
    };
    readModule(FixtureModule);
    let instance = FixtureClass(seed);
    let instanceAlias : Write = instance;
    write(instanceAlias, 2, "class-alias");
    instance.bump();
    assert instanceAlias.b == seed + 3;
    assert instance.d == "class-alias";

    let mutableExact : Write = {
      var b = seed; var d = "old"; f = 10
    };
    let mutableWide = object {
      public let a = 100;
      public var b = seed;
      public let c = 200;
      public var d = "old";
      public let e = 300;
      public let f = 20;
      public let g = 400;
      public func bump() { b += 2; d := d # "+closure" }
    };
    let narrow : Write = mutableWide;
    let alias : Write = narrow;
    write(mutableExact, 1, "exact");
    assert mutableExact.b == seed + 1;
    assert mutableExact.d == "exact";
    write(narrow, 3, "wide");
    assert mutableWide.b == seed + 3;
    assert alias.d == "wide";
    mutableWide.bump();
    assert alias.b == seed + 5;
    assert narrow.d == "wide+closure";
    alias.d := "alias";
    assert mutableWide.d == "alias";

    let other : Write = { var b = 0; var d = "other"; f = 99 };
    var current = narrow;
    var calls = 0;
    func receiver() : Write { calls += 1; current };
    func rhs() : Text { current := other; "rhs" };
    receiver().d := rhs();
    assert calls == 1;
    assert narrow.d == "rhs";
    assert other.d == "other";
    assert receiver().f == 99;
    assert calls == 2;
    receiver().b += seed;
    assert calls == 3;
    assert other.b == seed;

    // Private state and captured methods add further physical object fields.
    let hidden = object {
      var privateValue = seed;
      public let b = seed;
      public let d = "value";
      public let f = seed + 1;
      public func update() { privateValue += 1 };
      public func get() : Nat { privateValue }
    };
    hidden.update();
    assert hidden.get() == seed + 1;
    assert read(hidden) == expected;
    4
  };
}
