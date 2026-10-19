#include <cmath>
#include <cstdint>
#include <wasm_simd128.h>

// A 4-class by 8-timestep tile stays in registers. Reduce each completed tile
// directly into IDs, without writing or transposing the full score matrix.
extern "C" void fused_ctc_head(const float* features, const float* weights,
                               const float* bias, int32_t* ids,
                               int batches, int channels, int steps, int classes) {
  for (int n = 0; n < batches; ++n) {
    int t = 0;
    for (; t + 8 <= steps; t += 8) {
      v128_t maximum0 = wasm_f32x4_splat(-INFINITY);
      v128_t maximum1 = maximum0;
      v128_t index0 = wasm_i32x4_splat(0), index1 = index0;
      auto accept = [&](v128_t score0, v128_t score1, int klass) {
        v128_t better0 = wasm_f32x4_gt(score0, maximum0);
        v128_t better1 = wasm_f32x4_gt(score1, maximum1);
        maximum0 = wasm_v128_bitselect(score0, maximum0, better0);
        maximum1 = wasm_v128_bitselect(score1, maximum1, better1);
        v128_t candidate = wasm_i32x4_splat(klass);
        index0 = wasm_v128_bitselect(candidate, index0, better0);
        index1 = wasm_v128_bitselect(candidate, index1, better1);
      };
      int k = 0;
      for (; k + 4 <= classes; k += 4) {
        v128_t a0 = wasm_f32x4_splat(0), a1 = a0;
        v128_t b0 = a0, b1 = a0, c0 = a0, c1 = a0, d0 = a0, d1 = a0;
        for (int c = 0; c < channels; ++c) {
          const float* row = features + (n * channels + c) * steps + t;
          v128_t x0 = wasm_v128_load(row), x1 = wasm_v128_load(row + 4);
          v128_t w = wasm_f32x4_splat(weights[k * channels + c]);
          a0 = wasm_f32x4_add(a0, wasm_f32x4_mul(x0, w));
          a1 = wasm_f32x4_add(a1, wasm_f32x4_mul(x1, w));
          w = wasm_f32x4_splat(weights[(k + 1) * channels + c]);
          b0 = wasm_f32x4_add(b0, wasm_f32x4_mul(x0, w));
          b1 = wasm_f32x4_add(b1, wasm_f32x4_mul(x1, w));
          w = wasm_f32x4_splat(weights[(k + 2) * channels + c]);
          c0 = wasm_f32x4_add(c0, wasm_f32x4_mul(x0, w));
          c1 = wasm_f32x4_add(c1, wasm_f32x4_mul(x1, w));
          w = wasm_f32x4_splat(weights[(k + 3) * channels + c]);
          d0 = wasm_f32x4_add(d0, wasm_f32x4_mul(x0, w));
          d1 = wasm_f32x4_add(d1, wasm_f32x4_mul(x1, w));
        }
        v128_t offset = wasm_f32x4_splat(bias[k]);
        accept(wasm_f32x4_add(a0, offset), wasm_f32x4_add(a1, offset), k);
        offset = wasm_f32x4_splat(bias[k + 1]);
        accept(wasm_f32x4_add(b0, offset), wasm_f32x4_add(b1, offset), k + 1);
        offset = wasm_f32x4_splat(bias[k + 2]);
        accept(wasm_f32x4_add(c0, offset), wasm_f32x4_add(c1, offset), k + 2);
        offset = wasm_f32x4_splat(bias[k + 3]);
        accept(wasm_f32x4_add(d0, offset), wasm_f32x4_add(d1, offset), k + 3);
      }
      for (; k < classes; ++k) {
        v128_t sum0 = wasm_f32x4_splat(0), sum1 = sum0;
        for (int c = 0; c < channels; ++c) {
          const float* row = features + (n * channels + c) * steps + t;
          v128_t w = wasm_f32x4_splat(weights[k * channels + c]);
          sum0 = wasm_f32x4_add(sum0, wasm_f32x4_mul(wasm_v128_load(row), w));
          sum1 = wasm_f32x4_add(sum1, wasm_f32x4_mul(wasm_v128_load(row + 4), w));
        }
        v128_t offset = wasm_f32x4_splat(bias[k]);
        accept(wasm_f32x4_add(sum0, offset), wasm_f32x4_add(sum1, offset), k);
      }
      wasm_v128_store(ids + n * steps + t, index0);
      wasm_v128_store(ids + n * steps + t + 4, index1);
    }
    for (; t < steps; ++t) {
      float maximum = -INFINITY;
      int best = 0;
      for (int k = 0; k < classes; ++k) {
        float score = 0;
        for (int c = 0; c < channels; ++c)
          score += features[(n * channels + c) * steps + t] * weights[k * channels + c];
        score += bias[k];
        if (score > maximum) { maximum = score; best = k; }
      }
      ids[n * steps + t] = best;
    }
  }
}
