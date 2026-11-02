# SyncTeX index

`src/render/synctex.wasm` answers the forward queries that `synctex view -i
line:0:input -o pdf` answers, without starting a process per query. The CLI
parses the whole `.synctex.gz` again every time, which for a 300-page thesis
costs about 0.12 s per source line. The module keeps one SyncTeX scanner open
per build, so each query is a lookup in the parser's index of nodes by input
file and line.

It is SyncTeX's own parser, so results are those of the CLI. `build.sh`
fetches the pinned SyncTeX sources and zlib, checks their hashes, and compiles
them with `synctex_index.c` using [wasi-sdk](https://github.com/WebAssembly/wasi-sdk):

    WASI_SDK=/path/to/wasi-sdk sh native/synctex/build.sh

The output is reproducible for a given wasi-sdk.
