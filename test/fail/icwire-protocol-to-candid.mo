//MOC-FLAG --plugin ../../../plugins/dist/icwire
func bad(f : shared icwire Nat -> async Nat) :
  (shared Nat -> async Nat) = f;
