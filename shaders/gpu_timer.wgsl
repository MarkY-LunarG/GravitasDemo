// Add the GPU time of a render pass to a total (src/app/gpu_timer.cpp).

// The two 64-bit timestamps of the pass, in nanoseconds: x is the low 32 bits, y the high 32 bits.
@group(0) @binding(0) var<storage, read> timestamps: array<vec2u, 2>;
// 0 and 1: the total time in nanoseconds (low and high 32 bits). 2: the number of measured frames.
@group(0) @binding(1) var<storage, read_write> total: array<u32, TOTAL_WORDS>;

@compute @workgroup_size(1)
fn cs_add() {
  let start = timestamps[0];
  let end = timestamps[1];
  // Use only a difference from 1 ns to 2^32 ns (4.3 s). A timestamp can be 0 or out of order, for
  // example after a GPU clock change.
  let sameHigh = end.y == start.y && end.x > start.x;
  let nextHigh = end.y == start.y + 1u && end.x < start.x;
  if (!sameHigh && !nextHigh) {
    return;
  }
  // The u32 subtraction wraps, so it is also correct when the high words are different.
  let delta = end.x - start.x;
  let low = total[0] + delta;
  total[1] += select(0u, 1u, low < delta);
  total[0] = low;
  total[2] += 1u;
}
