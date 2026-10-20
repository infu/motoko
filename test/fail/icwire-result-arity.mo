//MOC-FLAG --plugin ../../../plugins/dist/icwire
func bad(f : shared icwire () -> async ((Nat, Text))) :
  (shared icwire () -> async (Nat, Text)) = f;
