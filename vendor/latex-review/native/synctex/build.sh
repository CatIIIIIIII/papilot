#!/bin/sh
# Builds src/render/synctex.wasm: SyncTeX's parser (with zlib for .synctex.gz)
# for WASI, plus synctex_index.c, which keeps one scanner open for queries.
# Needs wasi-sdk: WASI_SDK=/path/to/wasi-sdk sh native/synctex/build.sh
set -eu
SYNCTEX_COMMIT=a256d4835b7df2a0472cfa3d557af73a1b83f076
ZLIB_VERSION=1.3.1
here=$(cd "$(dirname "$0")" && pwd)
out="$here/../../src/render/synctex.wasm"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"
for file in synctex_parser.c synctex_parser.h synctex_parser_utils.c synctex_parser_utils.h \
  synctex_version.h synctex_parser_advanced.h synctex_parser_local.h; do
  curl -sSfL -o "$file" "https://raw.githubusercontent.com/jlaurens/synctex/$SYNCTEX_COMMIT/$file"
done
curl -sSfL -o zlib.tar.gz "https://github.com/madler/zlib/releases/download/v$ZLIB_VERSION/zlib-$ZLIB_VERSION.tar.gz"
shasum -a 256 -c <<SUMS
fa8bb24365d1f92c2fe7d75aac0abeda79222d6398737263e8092656c91febc0  synctex_parser.c
ac9fbbef013962d79f1f1fb40eec642103e152a471c5feed964515292ae6cb2c  synctex_parser.h
f5395f741c4de96790c76d2287d9e427ae74f354984a9bb2719d7ca51ecc1a37  synctex_parser_utils.c
305900cf5c5c55900107ea400bce5fb1080d4e1e15a45d3fd5b4e10cf80cc6be  synctex_parser_utils.h
02762a33566a97b189b9f5f824e53a5d9e13265008c84cceef74f4924cc62c45  synctex_version.h
edcad2c96f1c5e48fbd20923bf2dd3868914e566ccab82bfffc520f802345dd8  synctex_parser_advanced.h
a813d3d4aafd726220eaf5a6198f501aad55540359d549e5c1ff840b74248635  synctex_parser_local.h
9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23  zlib.tar.gz
SUMS
tar -xzf zlib.tar.gz
z="zlib-$ZLIB_VERSION"
# include/syslog.h: WASI has no syslog; SyncTeX needs only its level names.
"$WASI_SDK/bin/clang" --target=wasm32-wasi --sysroot="$WASI_SDK/share/wasi-sysroot" \
  -O2 -mexec-model=reactor -I"$here/include" -I"$z" -I. -DHAVE_UNISTD_H -w -o "$out" \
  "$here/synctex_index.c" synctex_parser.c synctex_parser_utils.c \
  "$z/adler32.c" "$z/crc32.c" "$z/deflate.c" "$z/gzclose.c" "$z/gzlib.c" "$z/gzread.c" \
  "$z/gzwrite.c" "$z/inffast.c" "$z/inflate.c" "$z/inftrees.c" "$z/trees.c" "$z/zutil.c"
echo "Wrote $out"
