open Wasm.Source
open Wasm_exts.Ast
open Wasm_exts.Types
open Wasm_exts.CustomModule

let nr value = value @@ no_region
let i64 value = nr (Const (nr (Wasm_exts.Values.I64 value)))
let i32 value = nr (Const (nr (Wasm_exts.Values.I32 value)))
let func signature body = nr {ftype = nr signature; locals = []; body}
let import name signature = nr {
  module_name = Lib.Utf8.decode "ic0";
  item_name = Lib.Utf8.decode name;
  idesc = nr (FuncImport (nr signature));
}

let base = {
  module_ = {empty_module with
    types = [nr (FuncType ([], [])); nr (FuncType ([I64Type], []));
      nr (FuncType (List.init 8 (fun _ -> I64Type), []));
      nr (FuncType ([I64Type; I64Type; I64Type], []))];
    memories = [nr {mtype = MemoryType (
      {min = 1L; max = None}, I64IndexType)}];
    tables = [nr {ttype = HugeTableType (
      {min = 2L; max = Some 2L}, FuncRefType)}];
    imports = [import "call_new" 2l; import "stable64_read" 3l];
    funcs = [func 0l []; func 1l []];
    elems = [nr {index = nr 0l; offset = nr [i64 0L];
      init = [nr 2l; nr 3l]}];
  };
  name = empty_name_section;
  dylink0 = [];
  motoko = empty_motoko_sections;
  candid = empty_candid_sections;
  enhanced_orthogonal_persistence = Some (false, "64-bit, layout version 1");
  source_mapping_url = None;
  wasm_features = [];
  target_features = ["memory64"; "bulk-memory"];
}

let lower = Wasm_exts.Memory32.lower

let signature module_ index =
  (List.nth module_.types (Int32.to_int index)).it

let test_abi () =
  let result = lower base in
  assert (result.enhanced_orthogonal_persistence =
    base.enhanced_orthogonal_persistence);
  assert (not (List.mem "memory64" result.target_features));
  assert ((List.hd result.module_.memories).it.mtype =
    MemoryType ({min = 1L; max = Some 65535L}, I32IndexType));
  assert ((List.hd result.module_.tables).it.ttype =
    TableType ({min = 4l; max = Some 4l}, FuncRefType));
  let import_type position =
    match (List.nth result.module_.imports position).it.idesc.it with
    | FuncImport index -> signature result.module_ index.it
    | _ -> assert false
  in
  assert (import_type 0 = FuncType (List.init 8 (fun _ -> I32Type), []));
  assert (import_type 1 = FuncType ([I64Type; I64Type; I64Type], []));
  let callback = List.nth result.module_.elems 1 in
  assert (callback.it.offset.it = [i32 3l]);
  assert (List.length callback.it.init = 1);
  let _, binary = Wasm_exts.CustomModuleEncode.encode result in
  let decoded = Wasm_exts.CustomModuleDecode.decode "memory32-test" binary in
  assert (List.map (fun memory -> memory.it.mtype) decoded.module_.memories =
    List.map (fun memory -> memory.it.mtype) result.module_.memories)

let test_memory_operations () =
  let body = [
    i64 0L; nr (Load {ty = I64Type; align = 3; offset = 0L; sz = None});
    nr Drop;
    i64 0L; i64 5L;
    nr (Store {ty = I64Type; align = 3; offset = 0L; sz = None});
    i64 0L; i64 8L; i64 8L; nr MemoryCopy;
    i64 0L; i32 1l; i64 8L; nr MemoryFill;
    i64 0L; i32 0l; i32 0l; nr (MemoryInit (nr 0l));
    i64 0x1_0000_0000L; nr MemoryGrow; nr Drop;
    nr MemorySize; nr Drop;
  ] in
  let candidate = {base with module_ = {base.module_ with
    funcs = [func 0l body; func 1l []];
    datas = [nr {dinit = ""; dmode = nr Passive}];
  }} in
  let result = lower candidate in
  let function_ = List.hd result.module_.funcs in
  assert (List.length function_.it.locals = 7);
  assert (List.length function_.it.body > List.length body);
  let _, binary = Wasm_exts.CustomModuleEncode.encode result in
  ignore (Wasm_exts.CustomModuleDecode.decode "memory32-operations" binary)

let test_limits () =
  let candidate = {base with module_ = {base.module_ with
    memories = [nr {mtype = MemoryType (
      {min = 65536L; max = None}, I64IndexType)}];
  }} in
  match lower candidate with
  | _ -> assert false
  | exception Wasm_exts.Memory32.Error _ -> ()

let test_import_references () =
  let candidate = {base with module_ = {base.module_ with
    imports = [import "canister_cycle_balance128" 1l];
    elems = [nr {index = nr 0l; offset = nr [i64 0L];
      init = [nr 0l; nr 2l]}];
    exports = [nr {name = Lib.Utf8.decode "import_alias";
      edesc = nr (FuncExport (nr 0l))}];
  }} in
  let result = lower candidate in
  let table_function = List.hd (List.hd result.module_.elems).it.init in
  assert (table_function.it <> 0l);
  match (List.hd result.module_.exports).it.edesc.it with
  | FuncExport index -> assert (index.it = table_function.it)
  | _ -> assert false

let test_compiler_prefix () =
  let body = [i64 0L;
    nr (Load {ty = I64Type; align = 3; offset = 0L; sz = None}); nr Drop;
    i64 0L; i64 0L; i64 0L; nr MemoryCopy] in
  let candidate = {base with module_ = {base.module_ with
    funcs = [func 0l body; func 1l body];
    globals = [nr {gtype = GlobalType (I64Type, Mutable);
      value = nr [i64 1024L]}];
    exports = [nr {name = Lib.Utf8.decode "__stack_pointer";
      edesc = nr (GlobalExport (nr 0l))}];
  }} in
  let checked = lower candidate in
  assert (checked = lower ~unchecked_functions:0 candidate);
  let result = lower ~unchecked_functions:1 candidate in
  let first = List.hd result.module_.funcs in
  let second = List.nth result.module_.funcs 1 in
  begin match (List.nth first.it.body 1).it,
      (List.nth second.it.body 1).it with
  | Convert (Wasm_exts.Values.I32 I32Op.WrapI64), Call _ -> ()
  | _ -> assert false
  end;
  (* Bulk operations in the exempt prefix still use checked narrowing. *)
  assert (List.exists (fun instruction -> match instruction.it with
    | Call _ -> true | _ -> false) first.it.body);
  List.iter (fun count ->
    match lower ~unchecked_functions:count candidate with
    | _ -> assert false
    | exception Wasm_exts.Memory32.Error _ -> ()
  ) [-1; 3]

let emit_stack_module path =
  let get index = nr (LocalGet (nr index)) in
  let store = nr (Store {ty = I64Type; align = 0; offset = 0L; sz = None}) in
  let types = [nr (FuncType ([], []));
    nr (FuncType ([I64Type], [])); nr (FuncType ([], [I64Type]))] in
  let definitions = [
    "callback", 0l, [nr (GlobalGet (nr 0l)); i64 99L; store];
    "native_call", 1l, [get 0l; nr (GlobalSet (nr 0l));
      nr (Call (nr 0l))];
    "marker", 2l, [i64 128L;
      nr (Load {ty = I64Type; align = 0; offset = 0L; sz = None})];
    "seed", 0l, [i64 128L; i64 42L; store];
  ] in
  let funcs = List.map (fun (_, signature, body) -> func signature body)
    definitions in
  let exports = List.mapi (fun index (name, _, _) -> nr {
    name = Lib.Utf8.decode name;
    edesc = nr (FuncExport (nr (Int32.of_int index)));
  }) definitions @ [nr {name = Lib.Utf8.decode "__stack_pointer";
    edesc = nr (GlobalExport (nr 0l))}] in
  let candidate = {base with module_ = {base.module_ with
    types; funcs; exports; imports = []; elems = []; tables = [];
    globals = [nr {gtype = GlobalType (I64Type, Mutable);
      value = nr [i64 1024L]}];
  }} in
  let result = lower ~unchecked_functions:1 candidate in
  (* The native prefix successor must check its SP before publishing it. *)
  begin match (List.nth result.module_.funcs 1).it.body with
  | _ :: {it = Call _; _} :: {it = GlobalSet _; _} :: _ -> ()
  | _ -> assert false
  end;
  let _, binary = Wasm_exts.CustomModuleEncode.encode result in
  Out_channel.with_open_bin path (fun output ->
    Out_channel.output_string output binary)

let emit_boundary_module path =
  let get index = nr (LocalGet (nr index)) in
  let load ?(offset = 0L) ?sz () =
    nr (Load {ty = I64Type; align = 0; offset; sz}) in
  let store ?sz () =
    nr (Store {ty = I64Type; align = 0; offset = 0L; sz}) in
  let types = [
    nr (FuncType ([I64Type], [I64Type]));
    nr (FuncType ([I64Type; I64Type], []));
    nr (FuncType ([I64Type; I64Type; I64Type], []));
    nr (FuncType ([I64Type; I32Type; I64Type], []));
    nr (FuncType ([], [I64Type]));
    nr (FuncType ([I64Type; I32Type; I32Type], []));
  ] in
  let definitions = [
    "load", 0l, [get 0l; load ()];
    "store", 1l, [get 0l; get 1l; store ()];
    "copy", 2l, [get 0l; get 1l; get 2l; nr MemoryCopy];
    "fill", 3l, [get 0l; get 1l; get 2l; nr MemoryFill];
    "init", 5l, [get 0l; get 1l; get 2l; nr (MemoryInit (nr 0l))];
    "grow", 0l, [get 0l; nr MemoryGrow];
    "size", 4l, [nr MemorySize];
    "load8u", 0l, [get 0l; load ~sz:(Pack8, ZX) ()];
    "load8s", 0l, [get 0l; load ~sz:(Pack8, SX) ()];
    "store8", 1l, [get 0l; get 1l; store ~sz:Pack8 ()];
    "load_offset_max", 0l, [get 0l; load ~offset:0xffff_ffffL ()];
    "load_offset_over", 0l, [get 0l; load ~offset:0x1_0000_0000L ()];
    "self_check", 4l, [
      i64 0L; i64 0x1234_5678_9abc_def0L; store ();
      i64 8L; i64 0L; i64 8L; nr MemoryCopy;
      i64 8L; load ();
      i64 0x1234_5678_9abc_def0L;
      nr (Compare (Wasm_exts.Values.I64 I64Op.Ne));
      nr (If (ValBlockType None, [nr Unreachable], []));
      i64 16L; i32 255l; i64 1L; nr MemoryFill;
      i64 16L; load ~sz:(Pack8, SX) (); i64 (-1L);
      nr (Compare (Wasm_exts.Values.I64 I64Op.Ne));
      nr (If (ValBlockType None, [nr Unreachable], []));
      i64 24L; i32 0l; i32 3l; nr (MemoryInit (nr 0l));
      i64 24L; load ~sz:(Pack8, ZX) (); i64 97L;
      nr (Compare (Wasm_exts.Values.I64 I64Op.Ne));
      nr (If (ValBlockType None, [nr Unreachable], []));
      i64 1L;
    ];
  ] in
  let funcs = List.map (fun (_, signature, body) -> func signature body)
    definitions in
  let exports = List.mapi (fun index (name, _, _) -> nr {
    name = Lib.Utf8.decode name;
    edesc = nr (FuncExport (nr (Int32.of_int index)));
  }) definitions in
  let candidate = {base with module_ = {base.module_ with
    types; funcs; exports; imports = []; elems = []; tables = [];
    datas = [nr {dinit = "abc"; dmode = nr Passive}];
  }} in
  let _, binary = Wasm_exts.CustomModuleEncode.encode (lower candidate) in
  Out_channel.with_open_bin path (fun output ->
    Out_channel.output_string output binary)

let emit_callback_module path =
  let get index = nr (LocalGet (nr index)) in
  let types = [
    nr (FuncType ([], []));
    nr (FuncType ([I64Type], []));
    nr (FuncType (List.init 8 (fun _ -> I64Type), []));
    nr (FuncType ([I64Type; I64Type], []));
    nr (FuncType ([], [I64Type]));
    nr (FuncType ([I64Type; I64Type; I64Type], []));
    nr (FuncType ([I32Type], []));
  ] in
  let submit callback =
    [i64 0L; i64 0L; i64 0L; i64 0L;
      i64 callback; i64 0x8000_0000L;
      i64 callback; i64 0xffff_ffffL; nr (Call (nr 0l));
      i64 callback; i64 0x8000_0000L; nr (Call (nr 1l))]
  in
  let definitions = [
    "callback", 1l, [get 0l; nr (GlobalSet (nr 0l))];
    "submit", 0l, submit 0L;
    "submit_invalid", 0l, submit 0xffff_ffffL;
    "observed", 4l, [nr (GlobalGet (nr 0l))];
    "indirect_invalid", 0l,
      [i32 0l; i64 2L; nr (CallIndirect (nr 0l, nr 6l))];
    "size_result", 4l, [nr (Call (nr 2l))];
    "time_result", 4l, [nr (Call (nr 4l))];
    "stable_read", 0l, [i64 0x1_0000_0000L; i64 0x2_0000_0000L;
      i64 0x3_0000_0000L; nr (Call (nr 3l))];
  ] in
  let imported_count = 5 in
  let funcs = List.map (fun (_, signature, body) -> func signature body)
    definitions in
  let exports = List.mapi (fun index (name, _, _) -> nr {
    name = Lib.Utf8.decode name;
    edesc = nr (FuncExport (nr (Int32.of_int (index + imported_count))));
  }) definitions @ [nr {name = Lib.Utf8.decode "table";
    edesc = nr (TableExport (nr 0l))}] in
  let candidate = {base with module_ = {base.module_ with
    types; funcs; exports;
    imports = [import "call_new" 2l; import "call_on_cleanup" 3l;
      import "canister_self_size" 4l; import "stable64_read" 5l;
      import "time" 4l];
    globals = [nr {gtype = GlobalType (I64Type, Mutable);
      value = nr [i64 0L]}];
    elems = [nr {index = nr 0l; offset = nr [i64 0L];
      init = [nr 5l; nr 6l]}];
  }} in
  let _, binary = Wasm_exts.CustomModuleEncode.encode (lower candidate) in
  Out_channel.with_open_bin path (fun output ->
    Out_channel.output_string output binary)

let () =
  test_abi ();
  test_memory_operations ();
  test_limits ();
  test_import_references ();
  test_compiler_prefix ();
  Option.iter emit_boundary_module (Sys.getenv_opt "MEMORY32_TEST_WASM");
  Option.iter emit_callback_module
    (Sys.getenv_opt "MEMORY32_TEST_CALLBACK_WASM");
  Option.iter emit_stack_module (Sys.getenv_opt "MEMORY32_TEST_STACK_WASM")
