#include "ocr_hardswish_wasm.h"

extern "C" void ocr_hardswish(const float* input, float* output, size_t count) {
  OcrHardSwishF32(input, output, count);
}
