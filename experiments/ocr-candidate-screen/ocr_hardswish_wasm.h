#pragma once

#include <algorithm>
#include <cstddef>
#if defined(__wasm_simd128__)
#include <wasm_simd128.h>
#endif

// Match ONNX's float HardSigmoid(alpha=1/6, beta=.5), then Multiply,
// keeping the intermediate float rounding and allowing exact in-place use.
inline void OcrHardSwishF32(const float* input, float* output, size_t count) {
  constexpr float alpha = 1.0f / 6.0f;
  size_t i = 0;
#if defined(__wasm_simd128__)
  const auto a = wasm_f32x4_splat(alpha), b = wasm_f32x4_splat(.5f);
  const auto zero = wasm_f32x4_splat(0.f), one = wasm_f32x4_splat(1.f);
  for (; count - i >= 4; i += 4) {
    const auto x = wasm_v128_load(input + i);
    auto gate = wasm_f32x4_add(wasm_f32x4_mul(a, x), b);
    gate = wasm_f32x4_max(wasm_f32x4_min(gate, one), zero);
    wasm_v128_store(output + i, wasm_f32x4_mul(x, gate));
  }
#endif
  for (; i < count; ++i) {
    const float gate = std::max(std::min(alpha * input[i] + .5f, 1.f), 0.f);
    output[i] = input[i] * gate;
  }
}
