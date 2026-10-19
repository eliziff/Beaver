#include "ocr_sgemm_tiles.h"
#include "ocr_depthwise_wasm.h"

extern "C" size_t sgemm_tiles_check(const float* a, const float* b, float* c,
                                    size_t k, size_t n, size_t lda, size_t ldc,
                                    float alpha, int zero, int rows) {
  if (rows == 6)
    return zero ? OcrSgemmSixRows<true>(a, b, c, k, n, lda, ldc, alpha)
                : OcrSgemmSixRows<false>(a, b, c, k, n, lda, ldc, alpha);
  return zero ? OcrSgemmFourRows<true>(a, b, c, k, n, lda, ldc, alpha)
              : OcrSgemmFourRows<false>(a, b, c, k, n, lda, ldc, alpha);
}

extern "C" void depthwise_check(const float* x, const float* weights,
                                 const float* bias, float* y,
                                 size_t n, size_t c, size_t width) {
  OcrDepthwiseNine(x, weights, bias, y, n, c, width);
}
