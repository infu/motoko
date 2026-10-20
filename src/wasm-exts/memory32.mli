(* Lower a fully linked memory64 module to memory32. Motoko values and the
   internal runtime/plugin ABI remain 64-bit. Linear memories reserve their
   last 64KiB page. The default checks every narrowed address.

   [unchecked_functions] may identify a prefix of compiler-generated functions
   whose ordinary loads/stores already require valid low heap addresses. It
   must not include native runtime functions or arbitrary Wasm. Bulk memory,
   system APIs, callbacks and growth remain checked throughout the module.
   With an exempt prefix, writes to the exported compiler stack pointer are
   checked in every function against its initial bound, including native
   frames that can call generated code before accessing their own memory. *)
exception Error of string

val lower : ?unchecked_functions:int -> CustomModule.extended_module ->
  CustomModule.extended_module
