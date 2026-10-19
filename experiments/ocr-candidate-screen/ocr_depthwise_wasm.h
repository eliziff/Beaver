#pragma once
#include <cstddef>
#include <wasm_simd128.h>

// Nine-tap, stride-one depthwise convolution reads the original row directly.
// Accumulate before adding bias, including at padded left/right boundaries.
static void OcrDepthwiseNine(const float* input, const float* weights,
                              const float* bias, float* output,
                              size_t batches, size_t channels, size_t width) {
  for (size_t n = 0; n < batches; ++n) for (size_t c = 0; c < channels; ++c) {
    const float* row = input + (n * channels + c) * width;
    const float* filter = weights + c * 9;
    float* result = output + (n * channels + c) * width;
    const float offset = bias ? bias[c] : 0.0f;
    auto edge = [&](size_t t) {
      float sum = 0;
      for (size_t k = 0; k < 9; ++k) {
        const ptrdiff_t position = static_cast<ptrdiff_t>(t + k) - 4;
        const float pixel = position >= 0 && static_cast<size_t>(position) < width ? row[position] : 0.0f;
        sum += pixel * filter[k];
      }
      result[t] = sum + offset;
    };
    size_t t = 0;
    for (; t < width && t < 4; ++t) edge(t);
    v128_t kernel[9];
#pragma unroll
    for (size_t k = 0; k < 9; ++k) kernel[k] = wasm_f32x4_splat(filter[k]);
    for (; t + 12 <= width; t += 8) {
      v128_t low = wasm_f32x4_splat(0), high = low;
#pragma unroll
      for (size_t k = 0; k < 9; ++k) {
        low = wasm_f32x4_add(low, wasm_f32x4_mul(wasm_v128_load(row + t + k - 4), kernel[k]));
        high = wasm_f32x4_add(high, wasm_f32x4_mul(wasm_v128_load(row + t + k), kernel[k]));
      }
      const v128_t add = wasm_f32x4_splat(offset);
      wasm_v128_store(result + t, wasm_f32x4_add(low, add));
      wasm_v128_store(result + t + 4, wasm_f32x4_add(high, add));
    }
    for (; t < width; ++t) edge(t);
  }
}
