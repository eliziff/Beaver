#pragma once
#include "ocr_sgemm_four_rows.h"

static inline v128_t OcrTileMultiplyAdd(v128_t x, v128_t weight, v128_t sum) {
#ifdef OCR_SGEMM_FMA
  return wasm_f32x4_relaxed_madd(x, weight, sum);
#else
  return wasm_f32x4_add(sum, wasm_f32x4_mul(x, weight));
#endif
}

// Twelve accumulators plus two B vectors fit the six-row/eight-column tile.
template<bool Zero>
static size_t OcrSgemmSixRows(const float* A, const float* B, float* C,
                             size_t countK, size_t countN, size_t lda,
                             size_t ldc, float alpha) {
  for (size_t block = 0; block < countN; block += 16) {
    const size_t available = countN - block < 16 ? countN - block : 16;
    for (size_t half = 0; half < available; half += 8) {
      const size_t count = available - half < 8 ? available - half : 8;
      v128_t low[6], high[6];
#pragma unroll
      for (size_t row = 0; row < 6; ++row)
        low[row] = high[row] = wasm_f32x4_splat(0);
      const float* packed = B + (block / 16) * countK * 16 + half;
      for (size_t k = 0; k < countK; ++k, packed += 16) {
        const v128_t x0 = wasm_v128_load(packed), x1 = wasm_v128_load(packed + 4);
#pragma unroll
        for (size_t row = 0; row < 6; ++row) {
          const v128_t weight = wasm_f32x4_splat(A[row * lda + k]);
          low[row] = OcrTileMultiplyAdd(x0, weight, low[row]);
          high[row] = OcrTileMultiplyAdd(x1, weight, high[row]);
        }
      }
      const v128_t scale = wasm_f32x4_splat(alpha);
#pragma unroll
      for (size_t row = 0; row < 6; ++row)
        OcrStoreSgemmEight<Zero>(C + row * ldc + block + half,
                                 low[row], high[row], count, scale);
    }
  }
  return 6;
}
