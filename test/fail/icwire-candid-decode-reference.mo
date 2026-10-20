//MOC-FLAG --plugin ../../../plugins/dist/icwire
func bad(bytes : Blob) : ?{ nested : ?[shared icwire () -> async Nat] } {
  from_candid(bytes)
};
