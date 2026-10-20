//MOC-FLAG --plugin ../../../plugins/dist/icwire
func bad(f : shared icwire () -> async Nat) :
  (shared icwire () -> async Int) = f;
