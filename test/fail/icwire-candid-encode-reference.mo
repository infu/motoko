//MOC-FLAG --plugin ../../../plugins/dist/icwire
func bad(f : shared icwire () -> async Nat) : Blob {
  to_candid({ nested = ?[f] })
};
