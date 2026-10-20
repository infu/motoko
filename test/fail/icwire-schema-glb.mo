//MOC-FLAG --plugin ../../../plugins/dist/icwire
// Contravariance asks the outer function join to meet the endpoint schemas.
func bad(flag : Bool,
  narrow : (shared icwire { a : Nat } -> async ()) -> Nat,
  wide : (shared icwire { a : Nat; b : Bool } -> async ()) -> Nat,
  endpoint : shared icwire { a : Nat; b : Bool } -> async ()
) : Nat {
  let merged = if (flag) narrow else wide;
  merged(endpoint)
};
