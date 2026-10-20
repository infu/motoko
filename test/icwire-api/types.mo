import Prim "mo:prim";

// Aliases, reordered declarations and whole-method actor width are safe.
type Payload = { first : Nat; second : ?Text };
type Reordered = { second : ?Text; first : Nat };
type Endpoint = shared icwire Payload -> async Reordered;
func _alias(f : Endpoint) :
  (shared icwire Reordered -> async Payload) = f;
func _actorWidth(a : actor {
  wire : Endpoint;
  candid : shared Nat -> async Nat;
}) : actor { wire : Endpoint } = a;

// Ordinary Candid shared functions retain their existing variance behavior.
func _candidVariance(f : shared Int -> async { x : Nat; y : Bool }) :
  (shared Nat -> async { x : Int }) = f;

// These actor references are local transient values, never stable/Candid data.
func _reference() : actor { wire : Endpoint } {
  Prim.actorOfPrincipal<actor { wire : Endpoint }>(
    Prim.principalOfBlob(""))
};
