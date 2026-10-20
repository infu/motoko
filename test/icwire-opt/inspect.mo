// Inspection decoding is deliberately global, including for an overridden
// endpoint. This fixture proves compilation; raw PocketIC calls bypass inspect.
actor {
  type Value = { a : Nat; b : Text; c : [Nat32] };
  public shared icwire func hot(value : Value) : async Value { value };
  public shared icwire query func queryValue(value : Value) : async Value {
    value
  };
  public shared icwire composite query func compositeValue() : async Nat { 0 };
  system func inspect({ msg : {
    #hot : () -> Value; #queryValue : () -> Value
  } }) : Bool {
    switch msg {
      case (#hot decode) { decode().a != 13 };
      case (#queryValue decode) { decode().a != 13 };
    }
  }
}
