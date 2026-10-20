//MOC-FLAG --plugin ../../../plugins/dist/icwire
actor {
  public shared func bad(
    value : { nested : ?[shared icwire () -> async Nat] }
  ) : async () {};
};
