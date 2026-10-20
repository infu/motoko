open Wasm.Source
open Ast
open Types
open CustomModule

exception Error of string

let error message = raise (Error message)
let nr value = value @@ no_region
let i64 value = nr (Const (nr (Values.I64 value)))
let i32 value = nr (Const (nr (Values.I32 value)))
let get index = nr (LocalGet (nr index))
let set index = nr (LocalSet (nr index))
let call index = nr (Call (nr index))
let wrap = nr (Convert (Values.I32 I32Op.WrapI64))
let extend_u = nr (Convert (Values.I64 I64Op.ExtendUI32))
let extend_s = nr (Convert (Values.I64 I64Op.ExtendSI32))
let max_pages = 65535L
let max_u32 = 0xffff_ffffL

(* Positions whose IC system API types track the main memory index type.
   Stable64 offsets and sizes, cycles, timestamps and counters remain i64. *)
let ic0_narrowed name =
  let all count result = Some (List.init count Fun.id, result) in
  match name with
  | "call_new" -> all 8 false
  | "env_var_value_copy" -> all 5 false
  | "env_var_name_copy" -> all 4 false
  | "canister_self_copy" | "root_key_copy" | "subnet_self_copy"
  | "msg_arg_data_copy" | "msg_caller_copy" | "data_certificate_copy"
  | "msg_method_name_copy" | "msg_reject_msg_copy"
  | "msg_caller_info_signer_copy" | "msg_caller_info_data_copy" ->
    all 3 false
  | "call_data_append" | "call_on_cleanup" | "is_controller"
  | "debug_print" | "certified_data_set" | "msg_reject"
  | "msg_reply_data_append" | "trap" | "env_var_name_exists" ->
    all 2 false
  | "canister_cycle_balance128" | "canister_liquid_cycle_balance128"
  | "msg_cycles_available128"
  | "msg_cycles_refunded128" | "cost_create_canister" -> all 1 false
  | "msg_cycles_accept128" | "cycles_burn128" | "mint_cycles128" | "cost_call"
  | "cost_http_request" -> Some ([2], false)
  | "cost_sign_with_ecdsa" | "cost_sign_with_schnorr"
  | "cost_vetkd_derive_key" -> Some ([0; 1; 3], false)
  | "canister_self_size" | "root_key_size" | "subnet_self_size"
  | "msg_arg_data_size" | "msg_caller_size" | "data_certificate_size"
  | "msg_method_name_size" | "msg_reject_msg_size" | "env_var_count"
  | "msg_caller_info_signer_size" | "msg_caller_info_data_size" ->
    all 0 true
  | "env_var_name_size" -> all 1 true
  | "env_var_value_size" -> all 2 true
  | "cost_http_request_v2" -> all 3 false
  | _ -> None

let lower (extended : extended_module) =
  let original = extended.module_ in
  if List.exists (fun import -> match import.it.idesc.it with
    | MemoryImport _ | TableImport _ -> true
    | _ -> false) original.imports then
    error "memory32 lowering requires a fully linked module";
  let function_imports = List.filter (fun import ->
    match import.it.idesc.it with FuncImport _ -> true | _ -> false
  ) original.imports in
  let imported_count = List.length function_imports in
  let types = ref original.types in
  let added_functions = ref [] in
  let added_names = ref [] in
  let function_type index =
    List.nth !types (Int32.to_int index) |> fun value -> value.it
  in
  let type_index signature =
    match List.find_index (fun value -> value.it = signature) !types with
    | Some index -> Int32.of_int index
    | None ->
      let index = Int32.of_int (List.length !types) in
      types := !types @ [nr signature];
      index
  in
  let add_function name parameters results body =
    let index = Int32.of_int (imported_count + List.length original.funcs
      + List.length !added_functions) in
    let ftype = nr (type_index (FuncType (parameters, results))) in
    added_functions := !added_functions @ [nr {ftype; locals = []; body}];
    added_names := !added_names @ [index, "memory32." ^ name];
    index
  in
  let checked_narrow = add_function "checked_address" [I64Type] [I32Type] [
    get 0l; i64 max_u32; nr (Compare (Values.I64 I64Op.GtU));
    nr (If (ValBlockType None, [nr Unreachable], []));
    get 0l; wrap;
  ] in
  let narrow = call checked_narrow in
  let table_sizes = List.map (fun table -> match table.it.ttype with
    | HugeTableType (limits, _) -> limits.min
    | TableType _ -> error "memory32 lowering expected a memory64 table"
  ) original.tables in
  let callback_table_size = match table_sizes with
    | [] -> 0L
    | [size] when size <= Int64.div max_u32 2L -> size
    | [_] -> error "memory32 callback table exceeds the index limit"
    | _ -> error "memory32 lowering supports one function table"
  in
  let callback_index = add_function "callback_index" [I64Type] [I32Type] [
    get 0l; i64 callback_table_size;
    nr (Compare (Values.I64 I64Op.GeU));
    nr (If (ValBlockType (Some I32Type), [i32 Int32.minus_one], [
      get 0l; i64 callback_table_size;
      nr (Binary (Values.I64 I64Op.Add)); wrap;
    ]));
  ] in
  let indirect_index = add_function "indirect_index" [I64Type] [I32Type] [
    get 0l; i64 callback_table_size;
    nr (Compare (Values.I64 I64Op.GeU));
    nr (If (ValBlockType None, [nr Unreachable], []));
    get 0l; wrap;
  ] in
  let import_bridges = Hashtbl.create 32 in
  let imports =
    let function_index = ref (-1) in
    List.map (fun import -> match import.it.idesc.it with
      | FuncImport signature_index ->
        incr function_index;
        let index = Int32.of_int !function_index in
        let name = Lib.Utf8.encode import.it.item_name in
        let policy =
          if Lib.Utf8.encode import.it.module_name = "ic0" then
            ic0_narrowed name
          else None
        in
        begin match policy with
        | None -> import
        | Some (positions, narrow_result) ->
          let FuncType (parameters, results) =
            function_type signature_index.it in
          let narrowed_parameters = List.mapi (fun position ty ->
            if List.mem position positions then begin
              if ty <> I64Type then
                error ("unexpected memory64 IC API parameter: " ^ name);
              I32Type
            end else ty
          ) parameters in
          let narrowed_results = if narrow_result then begin
            if results <> [I64Type] then
              error ("unexpected memory64 IC API result: " ^ name);
            [I32Type]
          end else results in
          let arguments = List.concat (List.mapi (fun position _ ->
            let conversion =
              if not (List.mem position positions) then []
              else if (name = "call_new" &&
                  (position = 4 || position = 6)) ||
                  (name = "call_on_cleanup" && position = 0) then
                [call callback_index]
              else [narrow]
            in
            get (Int32.of_int position) :: conversion
          ) parameters) in
          let body = arguments @ [call index]
            @ (if narrow_result then [extend_u] else []) in
          let bridge = add_function ("ic0." ^ name) parameters results body in
          Hashtbl.add import_bridges index bridge;
          let new_type = type_index
            (FuncType (narrowed_parameters, narrowed_results)) in
          {import with it = {import.it with
            idesc = nr (FuncImport (nr new_type))}}
        end
      | _ -> import
    ) original.imports
  in
  let remap_call index =
    Option.value (Hashtbl.find_opt import_bridges index) ~default:index
  in
  let grow memory_instruction = add_function
    (match memory_instruction with MemoryGrow -> "grow" | _ -> "stable_grow")
    [I64Type] [I64Type] [
      get 0l; i64 max_pages; nr (Compare (Values.I64 I64Op.GtU));
      nr (If (ValBlockType (Some I64Type), [i64 Int64.minus_one], [
        get 0l; wrap; nr memory_instruction; extend_s;
      ]));
    ]
  in
  let grow_main = lazy (grow MemoryGrow) in
  let grow_stable = lazy (grow StableGrow) in
  let transform_function function_ =
    let FuncType (parameters, _) = function_type function_.it.ftype.it in
    let locals = ref function_.it.locals in
    let scratch_slots = Hashtbl.create 8 in
    let scratch name ty =
      match Hashtbl.find_opt scratch_slots name with
      | Some index -> index
      | None ->
        let index = Int32.of_int (List.length parameters
          + List.length !locals) in
        locals := !locals @ [ty];
        Hashtbl.add scratch_slots name index;
        index
    in
    let lower_copy instruction =
      let length = scratch "copy_length" I64Type in
      let source = scratch "copy_source" I64Type in
      [set length; set source; narrow; get source; narrow;
        get length; narrow; nr instruction]
    in
    let rec instructions values = List.concat_map instruction values
    and instruction value =
      let unchanged () = [value] in
      match value.it with
      | Block (ty, body) ->
        [{value with it = Block (ty, instructions body)}]
      | Loop (ty, body) ->
        [{value with it = Loop (ty, instructions body)}]
      | If (ty, yes, no) ->
        [{value with it = If (ty, instructions yes, instructions no)}]
      | Load operation ->
        if operation.offset < 0L || operation.offset > max_u32 then
          [nr Unreachable]
        else [narrow; value]
      | Store operation ->
        if operation.offset < 0L || operation.offset > max_u32 then
          [nr Unreachable]
        else
          let temporary = scratch
            ("store_" ^ string_of_value_type operation.ty) operation.ty in
          [set temporary; narrow; get temporary; value]
      | MemorySize | StableSize -> [value; extend_u]
      | MemoryGrow -> [call (Lazy.force grow_main)]
      | StableGrow -> [call (Lazy.force grow_stable)]
      | MemoryCopy | StableRead | StableWrite -> lower_copy value.it
      | MemoryFill ->
        let length = scratch "fill_length" I64Type in
        let byte = scratch "fill_byte" I32Type in
        [set length; set byte; narrow; get byte; get length; narrow; value]
      | MemoryInit _ ->
        let length = scratch "init_length" I32Type in
        let source = scratch "init_source" I32Type in
        [set length; set source; narrow; get source; get length; value]
      | Call index -> [{value with it = Call (nr (remap_call index.it))}]
      | CallIndirect _ -> [call indirect_index; value]
      | _ -> unchanged ()
    in
    let body = instructions function_.it.body in
    {function_ with it = {function_.it with locals = !locals; body}}
  in
  let funcs = List.map transform_function original.funcs in
  let function_signature index =
    let position = Int32.to_int index in
    if position < imported_count then
      let import = List.nth function_imports position in
      match import.it.idesc.it with
      | FuncImport type_index -> function_type type_index.it
      | _ -> error "invalid function import in memory32 lowering"
    else
      let function_ = List.nth original.funcs (position - imported_count) in
      function_type function_.it.ftype.it
  in
  let callback_bridges = Hashtbl.create 32 in
  let callback_elements = ref [] in
  let elems = List.map (fun (element : table_segment) ->
    let offset = match element.it.offset.it with
      | [{it = Const {it = Values.I64 offset; _}; _}] -> offset
      | _ -> error "memory32 lowering requires resolved table offsets"
    in
    if offset < 0L || offset > callback_table_size ||
        Int64.of_int (List.length element.it.init) >
          Int64.sub callback_table_size offset then
      error "memory32 table segment exceeds its table";
    List.iteri (fun position function_index ->
      if function_signature function_index.it = FuncType ([I64Type], []) then
        let bridge = match Hashtbl.find_opt callback_bridges function_index.it
          with
          | Some bridge -> bridge
          | None ->
            let bridge = add_function "callback" [I32Type] [] [
              get 0l; extend_u; call (remap_call function_index.it)
            ] in
            Hashtbl.add callback_bridges function_index.it bridge;
            bridge
        in
        let callback_offset = Int64.add callback_table_size
          (Int64.add offset (Int64.of_int position)) in
        callback_elements := !callback_elements @ [nr {
          index = element.it.index;
          offset = nr [i32 (Int64.to_int32 callback_offset)];
          init = [nr bridge];
        }]
    ) element.it.init;
    {element with it = {element.it with
      offset = nr [i32 (Int64.to_int32 offset)];
      init = List.map (fun index -> nr (remap_call index.it)) element.it.init}}
  ) original.elems in
  let memories = List.map (fun memory ->
    let MemoryType (limits, index_type) = memory.it.mtype in
    if index_type <> I64IndexType then
      error "memory32 lowering expected memory64 input";
    if limits.min < 0L || limits.min > max_pages then
      error "initial memory exceeds the memory32 heap limit";
    let maximum = match limits.max with
      | None -> max_pages
      | Some maximum -> Int64.min maximum max_pages
    in
    {memory with it = {mtype = MemoryType (
      {limits with max = Some maximum}, I32IndexType)}}
  ) original.memories in
  let tables = List.map (fun table -> match table.it.ttype with
    | HugeTableType (_, element_type) ->
      let size = Int64.mul 2L callback_table_size |> Int64.to_int32 in
      {table with it = {ttype = TableType (
        {min = size; max = Some size}, element_type)}}
    | TableType _ -> error "memory32 lowering expected memory64 input"
  ) original.tables in
  let datas = List.map (fun data -> match data.it.dmode.it with
    | Passive -> data
    | Active _ | Declarative ->
      error "memory32 lowering requires passive linked data segments"
  ) original.datas in
  let exports = List.map (fun export -> match export.it.edesc.it with
    | FuncExport index -> {export with it = {export.it with
        edesc = nr (FuncExport (nr (remap_call index.it)))}}
    | _ -> export
  ) original.exports in
  {extended with
    module_ = {original with imports; types = !types; memories; tables; datas;
      exports;
      funcs = funcs @ !added_functions; elems = elems @ !callback_elements};
    name = {extended.name with function_names =
      extended.name.function_names @ !added_names};
    target_features = List.filter ((<>) "memory64") extended.target_features;
    wasm_features = List.filter ((<>) "memory64") extended.wasm_features;
  }
