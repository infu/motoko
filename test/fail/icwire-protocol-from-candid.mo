//MOC-FLAG --plugin ../../../plugins/dist/icwire
func bad(f : shared Nat -> async Nat) :
  (shared icwire Nat -> async Nat) = f;
