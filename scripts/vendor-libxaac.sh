#!/bin/bash
#
# Fetch and pin Ittiam libxaac, keeping only what the encoder build needs.
# The vendored tree lands in vendor/ (gitignored) so the upstream source is not
# committed; CI and `npm run build` run this first.
#
# Pin to a tag for reproducibility. Bump LIBXAAC_REF deliberately, then rebuild +
# rerun the benchmark to confirm quality/speed have not regressed.

set -e

LIBXAAC_REPO="https://github.com/ittiam-systems/libxaac.git"
LIBXAAC_REF="${LIBXAAC_REF:-v0.1.13}" # latest upstream release; re-bench before bumping
VENDOR_DIR="vendor/libxaac"

if [ -d "$VENDOR_DIR/.git" ]; then
  echo "libxaac already vendored at $VENDOR_DIR (ref: $(git -C "$VENDOR_DIR" describe --tags --always))"
  echo "delete vendor/ to re-fetch"
  exit 0
fi

echo "Fetching libxaac @ $LIBXAAC_REF ..."
rm -rf "$VENDOR_DIR"
git clone --depth 1 --branch "$LIBXAAC_REF" "$LIBXAAC_REPO" "$VENDOR_DIR"

echo "Vendored libxaac:"
echo "  ref:   $(git -C "$VENDOR_DIR" describe --tags --always)"
echo "  enc:   $([ -d "$VENDOR_DIR/encoder" ] && echo present || echo MISSING)"
echo "  common:$([ -d "$VENDOR_DIR/common" ] && echo present || echo MISSING)"

if [ ! -d "$VENDOR_DIR/encoder" ]; then
  echo "ERROR: no encoder/ tree in this libxaac ref. Pick a ref that ships the encoder." >&2
  exit 1
fi

# Preserve the upstream LICENSE/NOTICE alongside our own for redistribution.
cp "$VENDOR_DIR/LICENSE" "vendor/LIBXAAC-LICENSE" 2>/dev/null || true
cp "$VENDOR_DIR/NOTICE" "vendor/LIBXAAC-NOTICE" 2>/dev/null || true

echo "Done. Next: npm run build"
