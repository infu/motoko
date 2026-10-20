//MOC-FLAG --plugin ../../../plugins/dist/icwire
func bad(flag : Bool,
  wire : shared icwire Nat -> async Nat,
  candid : shared Nat -> async Nat
) : (shared icwire Nat -> async Nat) {
  let merged = if (flag) wire else candid;
  merged
};
