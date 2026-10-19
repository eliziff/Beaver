#include "ocr_sgemm_four_rows.h"

extern "C" size_t sgemm_check(const float* a, const float* packed_b, float* c,
                              size_t k, size_t n, size_t lda, size_t ldc,
                              float alpha, int zero) {
  return zero ? OcrSgemmFourRows<true>(a, packed_b, c, k, n, lda, ldc, alpha)
              : OcrSgemmFourRows<false>(a, packed_b, c, k, n, lda, ldc, alpha);
}
