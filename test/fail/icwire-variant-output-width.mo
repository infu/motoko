//MOC-FLAG --plugin ../../../plugins/dist/icwire
func bad(f : shared icwire () -> async { #b : Nat }) :
  (shared icwire () -> async { #a; #b : Nat }) = f;
