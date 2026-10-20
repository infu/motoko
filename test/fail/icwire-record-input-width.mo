//MOC-FLAG --plugin ../../../plugins/dist/icwire
func bad(f : shared icwire { a : Nat } -> async ()) :
  (shared icwire { a : Nat; b : Bool } -> async ()) = f;
