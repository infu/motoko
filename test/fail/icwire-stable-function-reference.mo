//MOC-FLAG --plugin ../../../plugins/dist/icwire
actor {
  let target : shared icwire () -> async Nat =
    (actor "aaaaa-aa" : actor { f : shared icwire () -> async Nat }).f;
};
