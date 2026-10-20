//MOC-FLAG --plugin ../../../plugins/dist/icwire
func bad(f : shared icwire () -> async { a : Nat; b : Bool }) :
  (shared icwire () -> async { a : Nat }) = f;
