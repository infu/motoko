//MOC-FLAG --plugin ../../../plugins/dist/icwire
func bad(f : shared icwire ((Nat, Text)) -> async ()) :
  (shared icwire (Nat, Text) -> async ()) = f;
