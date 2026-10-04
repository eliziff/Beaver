//! WebAssembly (WASI) binding over `dispatch` for the browser runtime.
//!
//! One C-ABI entry point takes a dispatch request and returns its reply behind a
//! `[u32 length]` prefix, which says how much to free.

use crate::dispatch;
use std::alloc::{GlobalAlloc, Layout, System};
use std::arch::wasm32::memory_size;

/// The system allocator, growing linear memory a quarter at a time. Left alone it
/// grows by the 64 KiB it lacks, and the browser takes about a millisecond per
/// growth: thousands of them while one large PDF is read.
struct QuarterGrowth;

const PAGE: usize = 64 * 1024;

fn reserve_after(before: usize) {
    let after = memory_size(0);
    if after == before {
        return;
    }
    // Claimed and released at once, the reserve stays at the top of the heap
    // for the allocations that follow; linear memory never shrinks either way.
    if let Ok(layout) = Layout::from_size_align(after * PAGE / 4, 16) {
        // SAFETY: the layout is non-zero; the block is released unread.
        unsafe {
            let block = System.alloc(layout);
            if !block.is_null() {
                System.dealloc(block, layout);
            }
        }
    }
}

// SAFETY: every call is the system allocator's own; the reserve only frees
// what it allocated.
unsafe impl GlobalAlloc for QuarterGrowth {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let before = memory_size(0);
        let block = System.alloc(layout);
        reserve_after(before);
        block
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let before = memory_size(0);
        let block = System.alloc_zeroed(layout);
        reserve_after(before);
        block
    }
    unsafe fn realloc(&self, block: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        let before = memory_size(0);
        let moved = System.realloc(block, layout, size);
        reserve_after(before);
        moved
    }
    unsafe fn dealloc(&self, block: *mut u8, layout: Layout) {
        System.dealloc(block, layout)
    }
}

#[global_allocator]
static ALLOCATOR: QuarterGrowth = QuarterGrowth;

#[no_mangle]
pub extern "C" fn authorities_alloc(length: usize) -> *mut u8 {
    let mut buffer = vec![0u8; length].into_boxed_slice();
    let pointer = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    pointer
}

/// # Safety
/// `pointer` and `length` must come from `authorities_alloc` or a returned frame
/// (whose length is its four-byte prefix plus four).
#[no_mangle]
pub unsafe extern "C" fn authorities_free(pointer: *mut u8, length: usize) {
    drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(pointer, length)));
}

/// # Safety
/// `pointer` must address `length` initialized bytes from `authorities_alloc`.
#[no_mangle]
pub unsafe extern "C" fn authorities_call(pointer: *const u8, length: usize) -> *mut u8 {
    let reply = dispatch::call(std::slice::from_raw_parts(pointer, length), None);
    let mut out = Vec::with_capacity(4 + reply.len());
    out.extend_from_slice(&(reply.len() as u32).to_le_bytes());
    out.extend_from_slice(&reply);
    let mut out = out.into_boxed_slice();
    let pointer = out.as_mut_ptr();
    std::mem::forget(out);
    pointer
}
