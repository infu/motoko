//MOC-FLAG --plugin ../../../plugins/dist/icwire
func bad(f : shared icwire { #a; #b : Nat } -> async ()) :
  (shared icwire { #b : Nat } -> async ()) = f;
