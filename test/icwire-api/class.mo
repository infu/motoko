shared icwire actor class Api(seed : Nat) {
  public shared icwire query func read() : async Nat { seed };
};
