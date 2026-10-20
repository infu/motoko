#!/usr/bin/env bash
set -euo pipefail
: "${TRIPWIRE:?Set TRIPWIRE to the isolated experimental compiler}"
: "${ICWIRE_PLUGIN:?Set ICWIRE_PLUGIN to its rebuilt ICWire plugin directory}"
icwire_test_directory=$(cd -- "$(dirname -- "$0")" && pwd)
icwire_build_directory=${ICWIRE_TEST_BUILD:-"$icwire_test_directory/_build"}
mkdir -p "$icwire_build_directory"
"$TRIPWIRE" --plugin "$ICWIRE_PLUGIN" --check -Werror \
  "$icwire_test_directory/types.mo"
for icwire_compile_only in inspect class; do
  "$TRIPWIRE" --plugin "$ICWIRE_PLUGIN" --icwire-internal -Werror --idl \
    -o "$icwire_build_directory/$icwire_compile_only.wasm" \
    "$icwire_test_directory/$icwire_compile_only.mo"
done
for icwire_mode in mixed guarded; do
  icwire_guard=()
  if [[ "$icwire_mode" == guarded ]]; then
    icwire_guard=(--trap-on-candid)
  fi
  "$TRIPWIRE" --plugin "$ICWIRE_PLUGIN" --icwire-internal \
    --enhanced-orthogonal-persistence -Werror --idl "${icwire_guard[@]}" \
    -o "$icwire_build_directory/$icwire_mode.wasm" \
    "$icwire_test_directory/runtime.mo"
done
