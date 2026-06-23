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

# Include dirs. libxaac's encoder is all-portable C (verified: no arch subdirs
# under encoder/, unlike the decoder). drc_src holds the loudness/DRC sources.
INCLUDES="-I$VENDOR_DIR/encoder -I$VENDOR_DIR/common -I$VENDOR_DIR/encoder/drc_src"

# SIMD recipe: Emscripten lowers x86 SSE intrinsics to WASM SIMD via -msimd128.
# Single-threaded on purpose (no -pthread): wasm threads need SharedArrayBuffer +
# COOP/COEP, which we avoid for cross-origin web-admin use.
CFLAGS="-O3 -msimd128 -msse -msse2 -w \
  -Wno-error=incompatible-pointer-types -Wno-incompatible-pointer-types \
  -Wno-error=implicit-function-declaration -Wno-implicit-function-declaration"

# Encoder source list: every .c under encoder/ + common/ (all portable C).
if [ ! -f scripts/encoder_sources.txt ]; then
  echo "Generating encoder source list..."
  find "$VENDOR_DIR/encoder" "$VENDOR_DIR/common" -name '*.c' > scripts/encoder_sources.txt
fi
ENCODER_SOURCES="$(tr '\n' ' ' < scripts/encoder_sources.txt)"

# Stage 1: compile libxaac's C sources to objects (as C, NOT c++17). One emcc
# invocation can't mix -std=c++17 with .c files, so the codec builds separately.
echo "Stage 1: compiling libxaac C sources ($(wc -l < scripts/encoder_sources.txt) files) ..."
OBJ_DIR="$BUILD_DIR/obj"
mkdir -p "$OBJ_DIR"
i=0
while IFS= read -r src; do
  [ -z "$src" ] && continue
  obj="$OBJ_DIR/$(echo "$src" | tr '/' '_').o"
  if [ ! -f "$obj" ] || [ "$src" -nt "$obj" ]; then
    emcc $CFLAGS $INCLUDES -c "$src" -o "$obj" || { echo "compile failed: $src" >&2; exit 1; }
  fi
  i=$((i + 1))
  printf '\r  %d compiled' "$i"
done < scripts/encoder_sources.txt
echo ""

# Stage 2: compile the C++ Embind glue and link with the codec objects.
echo "Stage 2: compiling glue + linking -> wasm ..."
emcc \
  -O3 -msimd128 -std=c++17 --bind $INCLUDES \
  src/encoder.cpp \
  "$OBJ_DIR"/*.o \
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
