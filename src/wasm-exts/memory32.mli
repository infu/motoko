(* Lower a fully linked memory64 module to memory32. Motoko values and the
   internal runtime/plugin ABI remain 64-bit. Linear memories reserve their
   last 64KiB page, and narrowing never aliases a high address to low memory. *)
exception Error of string

val lower : CustomModule.extended_module -> CustomModule.extended_module
