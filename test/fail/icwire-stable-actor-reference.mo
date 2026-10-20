//MOC-FLAG --plugin ../../../plugins/dist/icwire
actor {
  let target : actor { f : shared icwire () -> async Nat } = actor "aaaaa-aa";
};
