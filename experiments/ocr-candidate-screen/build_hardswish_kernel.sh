#!/usr/bin/env bash
set -euo pipefail
experiment="$(realpath "$(dirname "$0")")"
output="$(realpath -m "${1:?canonical kernel output directory}")"
tool_cache="${OCR_WASM_TOOLS:-$HOME/.local/share/legal-browser-ocr}"
set +u
source "$tool_cache/onnxruntime-1.22.0/cmake/external/emsdk/emsdk_env.sh" >/dev/null 2>&1
set -u
export EMCC_CORES=1 BINARYEN_CORES=1
mkdir -p "$output"
em++ "$experiment/hardswish_kernel.cpp" -O3 -msimd128 -std=c++17 -ffp-contract=off \
  -sALLOW_MEMORY_GROWTH=1 -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node \
  '-sEXPORTED_FUNCTIONS=["_ocr_hardswish","_malloc","_free"]' -o "$output/validation.mjs"
