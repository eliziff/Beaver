#!/usr/bin/env bash
set -euo pipefail
tool_cache="${OCR_WASM_TOOLS:-$HOME/.local/share/legal-browser-ocr}"
source_file="$(realpath "$(dirname "$0")/fused_ctc_head.cpp")"
output="$(realpath -m "${1:?canonical head runtime directory}")"
set +u
source "$tool_cache/onnxruntime-1.22.0/cmake/external/emsdk/emsdk_env.sh" >/dev/null 2>&1
set -u
export EMCC_CORES=1 BINARYEN_CORES=1
mkdir -p "$output"
em++ "$source_file" -O3 -msimd128 -ffp-contract=off -fno-exceptions -fno-rtti \
  -s MODULARIZE=1 -s EXPORT_ES6=1 -s ENVIRONMENT=web,worker,node \
  -s "EXPORTED_FUNCTIONS=['_malloc','_free','_fused_ctc_head']" \
  -s "EXPORTED_RUNTIME_METHODS=['HEAPF32','HEAP32']" \
  -s FILESYSTEM=0 -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=2097152 \
  -s STACK_SIZE=65536 -s MALLOC=emmalloc -o "$output/fused-head.mjs"
em++ "$(dirname "$source_file")/sgemm_kernel_check.cpp" -O3 -msimd128 -ffp-contract=off -fno-exceptions -fno-rtti \
  -s MODULARIZE=1 -s EXPORT_ES6=1 -s ENVIRONMENT=web,worker,node \
  -s "EXPORTED_FUNCTIONS=['_malloc','_free','_sgemm_check']" \
  -s "EXPORTED_RUNTIME_METHODS=['HEAPF32']" \
  -s FILESYSTEM=0 -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=2097152 \
  -s STACK_SIZE=65536 -s MALLOC=emmalloc -o "$output/sgemm-check.mjs"
