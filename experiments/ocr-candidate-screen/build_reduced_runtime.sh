#!/usr/bin/env bash
set -euo pipefail
# Reuse the desktop's existing ORT 1.22 Python environment and a durable tool cache.
tool_cache="${OCR_WASM_TOOLS:-$HOME/.local/share/legal-browser-ocr}"
ort_source="$tool_cache/onnxruntime-1.22.0"
python_exe="${OCR_BUILD_PYTHON:?Set OCR_BUILD_PYTHON to the existing ORT 1.22 Python executable}"
"$python_exe" -m pip install cmake==3.31.6 ninja==1.13.2
if [[ ! -d "$ort_source/.git" ]]; then
  mkdir -p "$tool_cache"
  git clone --quiet --branch v1.22.0 --depth 1 --recursive https://github.com/microsoft/onnxruntime.git "$ort_source"
fi
[[ "$(git -C "$ort_source" rev-parse HEAD)" == f217402897f40ebba457e2421bc0a4702771968e ]]
if [[ "${1:-setup}" == setup ]]; then exit 0; fi
eigen_revision=1d8b82b0740839c0de7f1242a3585e3390ff5f33
eigen_source="$tool_cache/eigen-$eigen_revision"
if [[ ! -d "$eigen_source/.git" ]]; then
  git init -q -b main "$eigen_source"
  git -C "$eigen_source" remote add origin https://gitlab.com/libeigen/eigen.git
fi
if [[ "$(git -C "$eigen_source" rev-parse --verify HEAD 2>/dev/null || true)" != "$eigen_revision" ]]; then
  git -C "$eigen_source" fetch --depth 1 origin "$eigen_revision"
  git -C "$eigen_source" checkout --detach FETCH_HEAD
fi
[[ "$(git -C "$eigen_source" rev-parse HEAD)" == "$eigen_revision" ]]
emsdk_root="$ort_source/cmake/external/emsdk"
"$emsdk_root/emsdk" install 4.0.4
"$emsdk_root/emsdk" activate 4.0.4
set +u
source "$emsdk_root/emsdk_env.sh" >/dev/null 2>&1
set -u
config_file="$(realpath "$1")"
output_dir="$(realpath -m "$2")"
export PATH="$(dirname "$python_exe"):$PATH"
cd "$ort_source"
mkdir -p "$output_dir"
set +e
"$python_exe" tools/ci_build/build.py --config Release --build_dir "$tool_cache/build" \
  --build_wasm --enable_wasm_simd --enable_wasm_threads --skip_tests \
  --disable_wasm_exception_catching --disable_rtti --disable_ml_ops \
  --include_ops_by_config "$config_file" --cmake_generator Ninja --parallel 1 \
  --allow_running_as_root --cmake_extra_defines "FETCHCONTENT_SOURCE_DIR_EIGEN3=$eigen_source" > "$output_dir/build.log" 2>&1
build_status=$?
set -e
if [[ $build_status != 0 ]]; then
  grep -n -A 12 -B 3 -E 'CMake Error|FAILED:|fatal error:|error:' "$output_dir/build.log" | head -n 100 || true
  exit "$build_status"
fi
cp "$tool_cache/build/Release/ort-wasm-simd-threaded.mjs" "$output_dir/"
cp "$tool_cache/build/Release/ort-wasm-simd-threaded.wasm" "$output_dir/"
git rev-parse HEAD > "$output_dir/ort-source-revision.txt"
