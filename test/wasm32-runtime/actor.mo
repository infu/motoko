import Prim "mo:prim";

// The target changes memory indexing, never this persisted value layout.
actor {
  type Retained = {
    bytes : Blob;
    positive : Nat;
    negative : Int;
    nested : [?Text];
    mutable : [var Nat];
  };
  var retained : ?Retained = null;
  let region = Prim.regionNew();
  var beforeUpgrade = 0;
  var afterUpgrade = 0;
  var continuations = 0;
  var reclaimedBefore = 0;

  func verify() {
    switch retained {
      case null Prim.trap("retained value has not been initialized");
      case (?value) {
        assert value.bytes.size() == 65_537;
        assert value.bytes[0] == 17;
        assert value.bytes[65_536] == 17;
        assert value.positive == 170141183460469231731687303715884105735;
        assert value.negative == -340282366920938463463374607431768211459;
        assert value.nested == [null, ?"retained ☃", ?""];
        assert value.mutable[0] == 7;
        assert value.mutable[256] == 263;
      };
    };
    assert Prim.regionSize(region) == 2;
    assert Prim.regionLoadNat64(region, 0) == 0xFEDC_BA98_7654_3210;
    assert Prim.regionLoadNat64(region, 65_532) == 0x0123_4567_89AB_CDEF;
    assert Prim.regionLoadNat8(region, 65_600) == 0xA5;
    assert Prim.regionLoadBlob(region, 65_601, 8) == "region32";
  };

  public shared icwire func prepare() : async () {
    switch retained {
      case null {};
      case (?_) Prim.trap("retained value was already initialized");
    };
    retained := ?{
      bytes = Prim.arrayToBlob(Prim.Array_tabulate<Nat8>(65_537,
        func(i) { Prim.natToNat8((i * 131 + 17) % 256) }));
      positive = 170141183460469231731687303715884105735;
      negative = -340282366920938463463374607431768211459;
      nested = [null, ?"retained ☃", ?""];
      mutable = Prim.Array_tabulateVar<Nat>(257, func(i) { i + 7 });
    };
    assert Prim.regionGrow(region, 2) == 0;
    Prim.regionStoreNat64(region, 0, 0xFEDC_BA98_7654_3210);
    // This one 64-bit access deliberately straddles a 64 KiB page boundary.
    Prim.regionStoreNat64(region, 65_532, 0x0123_4567_89AB_CDEF);
    Prim.regionStoreNat8(region, 65_600, 0xA5);
    Prim.regionStoreBlob(region, 65_601, "region32");
    verify();
  };

  public shared icwire func churn() : async () {
    reclaimedBefore := Prim.rts_reclaimed();
    var i = 0;
    while (i < 9) {
      ignore Prim.Array_init<Nat>(1024 * 1024, i);
      i += 1;
    };
    verify();
  };

  public shared icwire func collectAndCheck() : async Nat {
    var i = 0;
    while (i < 6) {
      await async {};
      verify();
      i += 1;
    };
    let reclaimed = Prim.rts_reclaimed();
    assert reclaimed > reclaimedBefore + 32 * 1024 * 1024;
    reclaimed - reclaimedBefore
  };

  public shared icwire func resume() : async Nat {
    await async { await async {} };
    continuations += 1;
    verify();
    continuations
  };

  public shared icwire query func state() : async (Nat, Nat, Nat, Nat) {
    verify();
    (beforeUpgrade, afterUpgrade, continuations, Prim.rts_memory_size())
  };

  public shared icwire func tooLarge() : async () {
    // Eight billion bytes cannot fit memory32. Failure must trap before any
    // truncated address or successful allocation can overwrite retained data.
    ignore Prim.Array_init<Nat>(1_000_000_000, 7);
    Prim.trap("allocation unexpectedly succeeded");
  };

  system func preupgrade() { beforeUpgrade += 1; verify() };
  system func postupgrade() { afterUpgrade += 1; verify() };
}
