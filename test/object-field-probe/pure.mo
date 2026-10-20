import Cases "cases";
import Prim "mo:prim";

assert Cases.run(42) == 4;
assert Cases.run(0) == 4;
assert Cases.run(1_000_000_000_000_000_000_000) == 4;
Prim.debugPrint("object-field-probe: passed");
