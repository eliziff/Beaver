#!/usr/bin/env bash
set -euo pipefail
# Reuse the existing source/compiler/build cache; keep previous runtime bytes.
tool_cache="${OCR_WASM_TOOLS:-$HOME/.local/share/legal-browser-ocr}"
ort_source="$tool_cache/onnxruntime-1.22.0"
python_exe="${OCR_BUILD_PYTHON:?Set OCR_BUILD_PYTHON to the existing build Python}"
config_file="$(realpath "${1:?operator config}")"
output_dir="$(realpath -m "${2:?canonical runtime output directory}")"
mode="${3:-profile}"
[[ "$mode" == profile || "$mode" == xnnpack || "$mode" == sgemm || "$mode" == tiles || "$mode" == fma || "$mode" == depthwise || "$mode" == fmadw || "$mode" == sgemm4dw || "$mode" == minimal || "$mode" == hswish || "$mode" == convhswish ]]
[[ "$(git -C "$ort_source" rev-parse HEAD)" == f217402897f40ebba457e2421bc0a4702771968e ]]
experiment="$(realpath "$(dirname "$0")")"
patch_files=()
applied_patches=()
copied_headers=()
cleanup() {
  local failed=0
  for ((index=${#applied_patches[@]}-1; index>=0; --index)); do
    if ! git -C "$ort_source" apply --reverse "${applied_patches[$index]}"; then failed=1; fi
  done
  for header in "${copied_headers[@]}"; do rm -f -- "$header"; done
  return "$failed"
}
trap cleanup EXIT
copy_header() {
  local destination="$ort_source/onnxruntime/core/mlas/lib/$2/$1"
  [[ ! -e "$destination" ]]
  cp "$experiment/$1" "$destination"
  copied_headers+=("$destination")
}
if [[ "$mode" != profile ]]; then
  if [[ "$mode" == sgemm || "$mode" == sgemm4dw || "$mode" == minimal || "$mode" == hswish || "$mode" == convhswish ]]; then
    patch_files+=("$experiment/sgemm-wasm.patch")
    [[ -z "$(git -C "$ort_source" status --porcelain -- onnxruntime/core/mlas/lib/wasm_simd/SgemmKernelWasmSimd.cpp)" ]]
    copy_header ocr_sgemm_four_rows.h wasm_simd
    if [[ "$mode" == hswish || "$mode" == convhswish ]]; then
      [[ -z "$(git -C "$ort_source" status --porcelain -- onnxruntime/core/providers/cpu/activation/activations.h onnxruntime/core/providers/cpu/activation/activations.cc onnxruntime/core/providers/cpu/cpu_execution_provider.cc)" ]]
      patch_files+=("$experiment/hardswish-wasm.patch")
      destination="$ort_source/onnxruntime/core/providers/cpu/activation/ocr_hardswish_wasm.h"
      [[ ! -e "$destination" ]]
      cp "$experiment/ocr_hardswish_wasm.h" "$destination"
      copied_headers+=("$destination")
      if [[ "$mode" == convhswish ]]; then
        [[ -z "$(git -C "$ort_source" status --porcelain -- onnxruntime/core/mlas/inc/mlas.h onnxruntime/core/mlas/lib/activate.cpp onnxruntime/contrib_ops/cpu/fused_activation.cc)" ]]
        patch_files+=("$experiment/conv-hardswish-wasm.patch")
      fi
    fi
    if [[ "$mode" == sgemm4dw ]]; then
      [[ -z "$(git -C "$ort_source" status --porcelain -- onnxruntime/core/mlas/lib/convolve.cpp)" ]]
      patch_files+=("$experiment/depthwise-wasm.patch")
      copy_header ocr_depthwise_wasm.h .
    fi
  elif [[ "$mode" == xnnpack ]]; then
    patch_files+=("$experiment/xnnpack-wasm.patch")
    [[ -z "$(git -C "$ort_source" status --porcelain -- onnxruntime/wasm/api.cc)" ]]
  else
    [[ -z "$(git -C "$ort_source" status --porcelain -- onnxruntime/core/mlas/lib/wasm_simd/SgemmKernelWasmSimd.cpp cmake/onnxruntime_mlas.cmake onnxruntime/core/mlas/lib/convolve.cpp)" ]]
    patch_files+=("$experiment/sgemm-tiles-wasm.patch")
    copy_header ocr_sgemm_four_rows.h wasm_simd
    copy_header ocr_sgemm_tiles.h wasm_simd
    if [[ "$mode" == depthwise || "$mode" == fmadw ]]; then
      patch_files+=("$experiment/depthwise-wasm.patch")
      copy_header ocr_depthwise_wasm.h .
    fi
  fi
  for patch_file in "${patch_files[@]}"; do
    git -C "$ort_source" apply --check "$patch_file"
    git -C "$ort_source" apply "$patch_file"
    applied_patches+=("$patch_file")
  done
fi
set +u
source "$ort_source/cmake/external/emsdk/emsdk_env.sh" >/dev/null 2>&1
set -u
export PATH="$(dirname "$python_exe"):$PATH"
export EMCC_CORES=1 BINARYEN_CORES=1
mkdir -p "$output_dir"
extra=()
if [[ "$mode" == xnnpack ]]; then extra+=(--use_xnnpack); fi
profiling=ON
if [[ "$mode" == minimal ]]; then extra+=(--minimal_build --enable_reduced_operator_type_support); profiling=OFF; fi
fma=OFF
link_flags=
if [[ "$mode" == fma || "$mode" == fmadw ]]; then fma=ON; link_flags=-mrelaxed-simd; fi
eigen_source="$tool_cache/eigen-1d8b82b0740839c0de7f1242a3585e3390ff5f33"
[[ -d "$eigen_source/.git" ]]
cd "$ort_source"
set +e
"$python_exe" "$ort_source/tools/ci_build/build.py" --config Release --build_dir "$tool_cache/build" \
  --build_wasm --enable_wasm_simd --enable_wasm_threads --skip_tests \
  --disable_wasm_exception_catching --disable_rtti --disable_ml_ops \
  --include_ops_by_config "$config_file" --cmake_generator Ninja --parallel 1 \
  --allow_running_as_root "${extra[@]}" --cmake_extra_defines \
  "FETCHCONTENT_SOURCE_DIR_EIGEN3=$eigen_source" "onnxruntime_ENABLE_WEBASSEMBLY_PROFILING=$profiling" \
  "onnxruntime_OCR_SGEMM_FMA=$fma" "CMAKE_EXE_LINKER_FLAGS=$link_flags" \
  > "$output_dir/build.log" 2>&1
status=$?
set -e
if [[ "$status" != 0 ]]; then
  tail -n 65 "$output_dir/build.log"
  exit "$status"
fi
for name in ort-wasm-simd-threaded.mjs ort-wasm-simd-threaded.wasm; do
  cp "$tool_cache/build/Release/$name" "$output_dir/$name"
done
"$python_exe" - "$output_dir" "$config_file" "$experiment" "$mode" <<'PY'
import hashlib, json, pathlib, sys
output, config, experiment = map(pathlib.Path, sys.argv[1:4])
digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
result = {'ort_version': '1.22.0', 'ort_revision': 'f217402897f40ebba457e2421bc0a4702771968e',
          'mode': sys.argv[4], 'profiling_function_names': sys.argv[4] != 'minimal', 'build_jobs': 1,
          'config_sha256': digest(config), 'wasm_sha256': digest(output / 'ort-wasm-simd-threaded.wasm'),
          'loader_sha256': digest(output / 'ort-wasm-simd-threaded.mjs')}
mode = sys.argv[4]
patches = [] if mode == 'profile' else ['xnnpack-wasm.patch'] if mode == 'xnnpack' else ['sgemm-wasm.patch'] if mode in ['sgemm', 'sgemm4dw', 'minimal', 'hswish', 'convhswish'] else ['sgemm-tiles-wasm.patch']
headers = [] if mode in ['profile', 'xnnpack'] else ['ocr_sgemm_four_rows.h']
if mode in ['hswish', 'convhswish']:
    patches.append('hardswish-wasm.patch')
    headers.append('ocr_hardswish_wasm.h')
if mode == 'convhswish': patches.append('conv-hardswish-wasm.patch')
result['fused_hardswish'] = mode in ['hswish', 'convhswish']
result['convolution_hardswish_epilogue'] = mode == 'convhswish'
if mode in ['tiles', 'fma', 'depthwise', 'fmadw']: headers.append('ocr_sgemm_tiles.h')
if mode in ['depthwise', 'fmadw', 'sgemm4dw']:
    patches.append('depthwise-wasm.patch')
    headers.append('ocr_depthwise_wasm.h')
result['source_patches_sha256'] = {name: digest(experiment / name) for name in patches}
result['kernel_headers_sha256'] = {name: digest(experiment / name) for name in headers}
result['six_row_tile'] = mode in ['tiles', 'fma', 'depthwise', 'fmadw']
result['explicit_fma'] = mode in ['fma', 'fmadw']
result['direct_depthwise_9'] = mode in ['depthwise', 'fmadw', 'sgemm4dw']
(output / 'build-inputs.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result), flush=True)
PY
