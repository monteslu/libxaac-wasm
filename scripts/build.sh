#!/bin/bash
#
# Build the libxaac-wasm encoder into dist/. Mirrors the proven webaudio-node
# recipe: libxaac's GENERIC plain-C path compiled with Emscripten, x86 SSE
# intrinsics translated to WASM SIMD via -msimd128. Single binary, every arch.

set -e

# --- locate emsdk -----------------------------------------------------------
if command -v emcc > /dev/null 2>&1; then
  echo "emcc found in PATH"
elif [ -n "$EMSDK" ] && [ -f "$EMSDK/emsdk_env.sh" ]; then
  source "$EMSDK/emsdk_env.sh" > /dev/null 2>&1
elif [ -f "$HOME/emsdk/emsdk_env.sh" ]; then
  source "$HOME/emsdk/emsdk_env.sh" > /dev/null 2>&1
else
  echo "Error: emsdk not found. Install Emscripten and/or set EMSDK." >&2
  exit 1
fi

VENDOR_DIR="vendor/libxaac"
if [ ! -d "$VENDOR_DIR/encoder" ]; then
  echo "Error: vendor/libxaac/encoder missing. Run: npm run vendor" >&2
  exit 1
fi

OUT_DIR="dist"
BUILD_DIR="build"
mkdir -p "$OUT_DIR" "$BUILD_DIR"

# Include dirs: encoder + common + the generic (portable) implementation.
INCLUDES="-I$VENDOR_DIR/encoder -I$VENDOR_DIR/common -I$VENDOR_DIR/encoder/generic"

# SIMD recipe: take libxaac's x86 path, let Emscripten lower SSE -> WASM SIMD.
# -U__ARM_NEON__: libxaac's generic selector self-disables under NEON; force the
# portable path. Single-threaded on purpose (no -pthread): wasm threads need
# SharedArrayBuffer + COOP/COEP, which we avoid for cross-origin web-admin use.
CFLAGS="-O3 -msimd128 -msse -msse2 -D__i386__ -U__ARM_NEON__ -DX86 -D_X86_ -w \
  -Wno-error=incompatible-pointer-types -Wno-incompatible-pointer-types \
  -Wno-error=implicit-function-declaration -Wno-implicit-function-declaration"

# Encoder source list. Generated once into scripts/encoder_sources.txt by
# enumerating $VENDOR_DIR/encoder + the generic path (see README "Updating libxaac").
if [ ! -f scripts/encoder_sources.txt ]; then
  echo "Generating encoder source list..."
  find "$VENDOR_DIR/encoder" "$VENDOR_DIR/common" -name '*.c' \
    | grep -viE '/(x86|x86_64|armv7|armv8)/' \
    > scripts/encoder_sources.txt
fi
ENCODER_SOURCES="$(tr '\n' ' ' < scripts/encoder_sources.txt)"

echo "Compiling libxaac encoder (generic path) -> wasm ..."
emcc \
  $CFLAGS $INCLUDES \
  --bind \
  -std=c++17 \
  src/encoder.cpp \
  $ENCODER_SOURCES \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=createLibxaac \
  -s ENVIRONMENT=web,worker,node \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s SINGLE_FILE=1 \
  -s EXPORTED_RUNTIME_METHODS='["HEAPF32","HEAPU8"]' \
  -o "$OUT_DIR/libxaac.js"

echo "Built $OUT_DIR/libxaac.js ($(du -h "$OUT_DIR/libxaac.js" | cut -f1))"
echo "SINGLE_FILE=1 inlines the wasm, so src/index.js can import it directly."
