//MOC-FLAG --plugin ../../../plugins/dist/icwire
func bad(f : shared icwire () -> async Null) :
  (shared icwire () -> async ?Nat) = f;
