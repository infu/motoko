//MOC-FLAG --wasm32
import Prim "mo:prim";

let region = Prim.regionNew();
assert Prim.regionGrow(region, 2) == 0;
assert Prim.regionSize(region) == 2;
let wide : Nat64 = 18_446_744_073_709_551_615;
Prim.regionStoreNat64(region, 65_532, wide);
assert Prim.regionLoadNat64(region, 65_532) == wide;
assert Prim.regionLoadNat8(region, 65_531) == 0;
assert Prim.regionLoadNat8(region, 65_540) == 0;

let huge : Nat = 340_282_366_920_938_463_463_374_607_431_768_211_457;
let encoded = to_candid(huge, wide, "Wasm32 mémoire");
let decoded : ?(Nat, Nat64, Text) = from_candid(encoded);
assert decoded == ?(huge, wide, "Wasm32 mémoire");

//SKIP run-low
//SKIP run
//SKIP run-ir
