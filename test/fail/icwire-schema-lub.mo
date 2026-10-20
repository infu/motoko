//MOC-FLAG --plugin ../../../plugins/dist/icwire
func bad(flag : Bool,
  narrow : shared icwire () -> async { a : Nat },
  wide : shared icwire () -> async { a : Nat; b : Bool }
) : (shared icwire () -> async { a : Nat }) {
  let merged = if (flag) narrow else wide;
  merged
};
