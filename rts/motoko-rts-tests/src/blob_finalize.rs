use core::mem::size_of;

use motoko_rts::{
    gc::incremental::{
        get_incremental_gc_state, get_partitioned_heap,
        partitioned_heap::{PartitionedHeapIterator, PARTITION_SIZE},
        set_incremental_gc_state,
        time::BoundedTime,
        IncrementalGC, Phase,
    },
    memory::{alloc_blob, finalize_blob, Memory},
    types::{
        Blob, Bytes, FreeSpace, Obj, Value, Words, TAG_BLOB_B, TAG_FREE_SPACE, TAG_ONE_WORD_FILLER,
    },
};

use crate::memory::TestMemory;

struct HeapMemory(TestMemory);

impl Memory for HeapMemory {
    unsafe fn alloc_words(&mut self, words: Words<usize>) -> Value {
        get_partitioned_heap().allocate(&mut self.0, words)
    }

    unsafe fn grow_memory(&mut self, address: usize) {
        self.0.grow_memory(address);
    }
}

impl HeapMemory {
    unsafe fn new(phase: Phase) -> Self {
        let mut memory = Self(TestMemory::new(Bytes(8 * PARTITION_SIZE).to_words()));
        let state = IncrementalGC::<Self>::initial_gc_state(memory.0.heap_base());
        set_incremental_gc_state(Some(state));
        get_partitioned_heap().start_collection(&mut memory.0, &mut BoundedTime::new(0));
        get_incremental_gc_state().set_phase(phase);
        memory
    }
}

impl Drop for HeapMemory {
    fn drop(&mut self) {
        unsafe { set_incremental_gc_state(None) }
    }
}

pub unsafe fn test() {
    println!("Testing unpublished blob finalization ...");
    for phase in [Phase::Pause, Phase::Mark, Phase::Evacuate, Phase::Update] {
        test_normal(phase);
    }
    let normal_capacity = PARTITION_SIZE - size_of::<Blob>();
    test_large(normal_capacity + 1, 0);
    test_large(normal_capacity + 1, 1);
    test_large(normal_capacity + 16, normal_capacity + 15);
    test_large(2 * PARTITION_SIZE - size_of::<Blob>() + 1, 1);
    test_large(normal_capacity + 1, normal_capacity + 1);
}

unsafe fn test_normal(phase: Phase) {
    let mut memory = HeapMemory::new(phase);
    for (capacity, length) in [
        (0, 0),
        (1, 0),
        (7, 1),
        (8, 7),
        (9, 8),
        (16, 8),
        (24, 8),
        (40, 1),
        (40, 0),
        (40, 40),
        (PARTITION_SIZE - size_of::<Blob>(), 0),
    ] {
        let original = alloc_blob(&mut memory, TAG_BLOB_B, Bytes(capacity));
        let blob = original.as_blob_mut();
        for index in 0..length {
            blob.set(index, index as u8);
        }
        // Another live allocation prevents a finalizer from rewinding the heap.
        let sentinel = alloc_blob(&mut memory, TAG_BLOB_B, Bytes(8));
        sentinel.as_blob_mut().set(0, 0xa5);
        let sentinel = finalize_blob(&mut memory, sentinel, Bytes(8));
        let partition_index = original.get_ptr() / PARTITION_SIZE;
        let marked_before = get_partitioned_heap()
            .get_partition(partition_index)
            .marked_size();
        let result = finalize_blob(&mut memory, original, Bytes(length));
        assert_eq!(result.get_ptr(), original.get_ptr());
        assert_eq!(result.as_blob().len(), Bytes(length));
        for index in 0..length {
            assert_eq!(result.as_blob().get(index), index as u8);
        }
        assert_eq!(sentinel.as_blob().len(), Bytes(8));
        assert_eq!(sentinel.as_blob().get(0), 0xa5);

        let payload_start = blob.payload_addr() as usize;
        let new_end = payload_start + Bytes(length).to_words().to_bytes().as_usize();
        let old_end = payload_start + Bytes(capacity).to_words().to_bytes().as_usize();
        let slop = old_end - new_end;
        if slop == size_of::<usize>() {
            assert_eq!(*(new_end as *const usize), TAG_ONE_WORD_FILLER);
        } else if slop != 0 {
            let filler = new_end as *const FreeSpace;
            assert_eq!((*filler).tag, TAG_FREE_SPACE);
            assert_eq!(
                (*filler).words.to_bytes().as_usize() + size_of::<FreeSpace>(),
                slop
            );
        }
        let marked_after = get_partitioned_heap()
            .get_partition(partition_index)
            .marked_size();
        let expected_marked = if phase == Phase::Mark || phase == Phase::Evacuate {
            size_of::<Blob>() + Bytes(length).to_words().to_bytes().as_usize()
        } else {
            0
        };
        assert_eq!(marked_after - marked_before, expected_marked);
        if expected_marked != 0 && slop != 0 {
            assert!(!get_partitioned_heap().is_object_marked(new_end as *mut Obj));
        }
        let subsequent = alloc_blob(&mut memory, TAG_BLOB_B, Bytes(1));
        subsequent.as_blob_mut().set(0, 0x5a);
        let subsequent = finalize_blob(&mut memory, subsequent, Bytes(1));
        assert_eq!(subsequent.as_blob().get(0), 0x5a);
        assert_eq!(sentinel.as_blob().get(0), 0xa5);
    }
}

unsafe fn test_large(capacity: usize, length: usize) {
    let mut memory = HeapMemory::new(Phase::Mark);
    let original = alloc_blob(&mut memory, TAG_BLOB_B, Bytes(capacity));
    let blob = original.as_blob_mut();
    for index in 0..core::cmp::min(length, 257) {
        blob.set(index, index as u8);
    }
    if length != 0 {
        blob.set(length - 1, 0xe7);
    }
    let result = finalize_blob(&mut memory, original, Bytes(length));
    assert_eq!(blob.len(), Bytes(capacity));
    assert_eq!(result.as_blob().len(), Bytes(length));
    assert_eq!(original.get_ptr() == result.get_ptr(), capacity == length);
    for index in 0..core::cmp::min(length.saturating_sub(1), 257) {
        assert_eq!(result.as_blob().get(index), index as u8);
    }
    if length != 0 {
        assert_eq!(result.as_blob().get(length - 1), 0xe7);
    }
    // Unpublished large scratch remains a valid, unmarked large object and can
    // be reclaimed without hiding the result or miscounting its partitions.
    get_partitioned_heap().collect_large_objects();
    assert_only_marked(result);
    if capacity != length {
        assert!(get_partitioned_heap()
            .get_partition(original.get_ptr() / PARTITION_SIZE)
            .is_free());
    }
    // Re-create marks in the next collection as a live root would.
    get_partitioned_heap().complete_collection();
    get_partitioned_heap().start_collection(&mut memory.0, &mut BoundedTime::new(0));
    assert!(get_partitioned_heap().mark_object(result.get_ptr() as *mut Obj));
    get_partitioned_heap().collect_large_objects();
    assert_only_marked(result);
    assert_eq!(result.as_blob().len(), Bytes(length));
    if length != 0 {
        assert_eq!(result.as_blob().get(length - 1), 0xe7);
    }
}

unsafe fn assert_only_marked(expected: Value) {
    let heap = get_partitioned_heap();
    let mut iterator = PartitionedHeapIterator::new(heap);
    let mut found = Vec::new();
    while iterator.has_partition() {
        while iterator.has_object() {
            found.push(iterator.current_object() as usize);
            iterator.next_object();
        }
        iterator.next_partition(heap);
    }
    assert_eq!(found, [expected.get_ptr()]);
}

// Run separately: this must trap even though 1 and 2 bytes occupy the same word.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn test_blob_finalize_reject_growth() {
    let mut memory = HeapMemory::new(Phase::Pause);
    let blob = alloc_blob(&mut memory, TAG_BLOB_B, Bytes(1));
    finalize_blob(&mut memory, blob, Bytes(2));
}
