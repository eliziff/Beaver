#pragma once
#include <cstddef>
#include <wasm_simd128.h>

template<bool Zero>
static inline void OcrStoreSgemmEight(float* output, v128_t low, v128_t high,
                                     size_t count, v128_t alpha) {
  low = wasm_f32x4_mul(low, alpha);
  high = wasm_f32x4_mul(high, alpha);
  if (count >= 4) {
    if (!Zero) low = wasm_f32x4_add(low, wasm_v128_load(output));
    wasm_v128_store(output, low);
    output += 4;
    count -= 4;
    low = high;
  }
  if (count == 4) {
    if (!Zero) low = wasm_f32x4_add(low, wasm_v128_load(output));
    wasm_v128_store(output, low);
    return;
  }
  if (count > 0) {
    alignas(16) float tail[4];
    wasm_v128_store(tail, low);
    for (size_t i = 0; i < count; ++i)
      output[i] = Zero ? tail[i] : tail[i] + output[i];
  }
}

// Preserve MLAS's packed-B format (16 columns per K) and arithmetic order.
// Four rows share each B load; two vectors per row keep eight accumulators.
template<bool Zero>
static size_t OcrSgemmFourRows(const float* A, const float* B, float* C,
                              size_t countK, size_t countN, size_t lda,
                              size_t ldc, float alpha) {
  const v128_t scale = wasm_f32x4_splat(alpha);
  for (size_t block = 0; block < countN; block += 16) {
    const size_t remaining = countN - block;
    const size_t available = remaining < 16 ? remaining : 16;
    for (size_t half = 0; half < available; half += 8) {
      const size_t left = available - half;
      const size_t count = left < 8 ? left : 8;
      v128_t a0 = wasm_f32x4_splat(0), a1 = a0;
      v128_t b0 = a0, b1 = a0, c0 = a0, c1 = a0, d0 = a0, d1 = a0;
      const float* packed = B + (block / 16) * countK * 16 + half;
      for (size_t k = 0; k < countK; ++k, packed += 16) {
        const v128_t x0 = wasm_v128_load(packed), x1 = wasm_v128_load(packed + 4);
        v128_t w = wasm_f32x4_splat(A[k]);
        a0 = wasm_f32x4_add(a0, wasm_f32x4_mul(x0, w));
        a1 = wasm_f32x4_add(a1, wasm_f32x4_mul(x1, w));
        w = wasm_f32x4_splat(A[lda + k]);
        b0 = wasm_f32x4_add(b0, wasm_f32x4_mul(x0, w));
        b1 = wasm_f32x4_add(b1, wasm_f32x4_mul(x1, w));
        w = wasm_f32x4_splat(A[lda * 2 + k]);
        c0 = wasm_f32x4_add(c0, wasm_f32x4_mul(x0, w));
        c1 = wasm_f32x4_add(c1, wasm_f32x4_mul(x1, w));
        w = wasm_f32x4_splat(A[lda * 3 + k]);
        d0 = wasm_f32x4_add(d0, wasm_f32x4_mul(x0, w));
        d1 = wasm_f32x4_add(d1, wasm_f32x4_mul(x1, w));
      }
      float* output = C + block + half;
      OcrStoreSgemmEight<Zero>(output, a0, a1, count, scale);
      OcrStoreSgemmEight<Zero>(output + ldc, b0, b1, count, scale);
      OcrStoreSgemmEight<Zero>(output + ldc * 2, c0, c1, count, scale);
      OcrStoreSgemmEight<Zero>(output + ldc * 3, d0, d1, count, scale);
    }
  }
  return 4;
}
