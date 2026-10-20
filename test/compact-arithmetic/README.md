# Compact arithmetic regression oracle

`oracle.py` uses Python arbitrary-precision integers to generate exact Int and
Nat addition/subtraction answers. Inputs include signed 62-bit compact limits,
the previous 32-bit fast-path limits, 128/256-bit boxed values, mixed operands,
cancellation into compact range, deterministic random values and Nat underflow.
It separately verifies the tagged overflow predicates exhaustively for toy word
sizes 4–12 and on 100,000 64-bit edge/random operand pairs.

```sh
python3 test/compact-arithmetic/oracle.py --output /path/to/fresh/evidence
TRIPWIRE=/path/to/candidate/sdk/bin/tripwire \
BASELINE_TRIPWIRE=/path/to/accepted/sdk/bin/tripwire \
COMPACT_TEST_BUILD=/path/to/fresh/evidence \
python3 test/compact-arithmetic/build.py
COMPACT_TEST_BUILD=/path/to/fresh/evidence \
node test/compact-arithmetic/runtime.mjs
TRIPWIRE=/path/to/candidate/sdk/bin/tripwire \
COMPACT_TEST_BUILD=/path/to/fresh/evidence \
python3 test/compact-arithmetic/engines.py
```

The runtime fixture receives its operands through Candid, preventing constant
folding. Python computes every expected arithmetic value; Motoko/core arithmetic
is not used as its own oracle. The same generated matrix runs under source, IR,
lowered IR and WASI engines. Logs and tool/source hashes accompany the results.
The IR interpreters report arithmetic overflow while returning exit status zero;
the harness checks their exact diagnostic and records the matching accepted
baseline behavior. Source and WASI underflow executions return nonzero statuses.

PocketIC runs the candidate with release and sanity-check RTS builds, optionally
also the accepted baseline. It checks exact Nat-underflow traps, subsequent valid
calls and operand evaluation order. Boxed inputs/results remain stored while
allocation churn provably triggers default incremental GC and across eight
explicit collector increments. Survivors are read and compared after every turn.
The suite keeps default GC policy; fixtures compile with `-Werror` and no warning
suppression. The private PocketIC server is stopped even when an assertion fails.

`POCKET_IC_BIN` selects the custom PocketIC 16 server and `PIC_PACKAGE_DIR` selects
the JS client. All generated data, Wasms and reports go to `COMPACT_TEST_BUILD`.
