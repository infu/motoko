//MOC-FLAG --plugin ../../../plugins/dist/icwire
func bad(f : shared icwire ?Int -> async ()) :
  (shared icwire ?Nat -> async ()) = f;
