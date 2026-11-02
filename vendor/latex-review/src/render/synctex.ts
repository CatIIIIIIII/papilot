import fs from "node:fs";

// SyncTeX's own parser (synctex_parser.c with zlib), compiled to WebAssembly
// by native/synctex/build.sh. `synctex view` parses the whole .synctex.gz
// again for every query; an index parses it once and answers each forward
// query from the parser's table of nodes by input file and line, with the
// values the CLI prints.
let compiled: WebAssembly.Module | undefined;
const wasm = () =>
  (compiled ??= new WebAssembly.Module(
    fs.readFileSync(new URL("./synctex.wasm", import.meta.url)),
  ));

interface Exports {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  st_alloc(size: number): number;
  st_free(pointer: number): void;
  st_open(output: number): number;
  st_close(): void;
  st_view(input: number, line: number): number;
  st_results(): number;
}

// Page (1-based), x, y, h, v, W, H: the fields of a `synctex view` result.
export type ViewResult = [number, number, number, number, number, number, number];

// The few WASI calls the parser makes, served from JavaScript: it reads the
// .synctex(.gz) file next to the PDF and prints warnings, nothing else.
// (Node's own WASI can collect garbage inside fd_read while a WebAssembly
// frame is on the stack, which crashes V8.)
const ERRNO = { SUCCESS: 0, ACCES: 2, BADF: 8, INVAL: 28, NOENT: 44, NOTSUP: 58 };
const ROOT = 3;
function system(memory: () => WebAssembly.Memory) {
  const files = new Map<number, { data: Uint8Array; position: number }>();
  let next = ROOT + 1;
  const view = () => new DataView(memory().buffer),
    bytes = () => new Uint8Array(memory().buffer);
  const vectors = (iovs: number, count: number) =>
    Array.from({ length: count }, (_, i) => [
      view().getUint32(iovs + 8 * i, true),
      view().getUint32(iovs + 8 * i + 4, true),
    ]);
  return {
    environ_sizes_get(count: number, size: number) {
      view().setUint32(count, 0, true);
      view().setUint32(size, 0, true);
      return ERRNO.SUCCESS;
    },
    environ_get: () => ERRNO.SUCCESS,
    // The only preopened directory is the file system root.
    fd_prestat_get(fd: number, out: number) {
      if (fd !== ROOT) return ERRNO.BADF;
      view().setUint8(out, 0);
      view().setUint32(out + 4, 1, true);
      return ERRNO.SUCCESS;
    },
    fd_prestat_dir_name(fd: number, path: number, length: number) {
      if (fd !== ROOT || length < 1) return ERRNO.BADF;
      bytes()[path] = 0x2f;
      return ERRNO.SUCCESS;
    },
    path_open(
      dir: number,
      _lookup: number,
      path: number,
      length: number,
      openFlags: number,
      _rights: bigint,
      _inherited: bigint,
      _fdFlags: number,
      out: number,
    ) {
      if (dir !== ROOT) return ERRNO.BADF;
      if (openFlags !== 0) return ERRNO.ACCES; // read only: no create or truncate
      const name = "/" + new TextDecoder().decode(bytes().subarray(path, path + length));
      let data: Uint8Array;
      try {
        if (!fs.statSync(name).isFile()) return ERRNO.NOENT;
        data = fs.readFileSync(name);
      } catch {
        return ERRNO.NOENT;
      }
      files.set(next, { data, position: 0 });
      view().setUint32(out, next++, true);
      return ERRNO.SUCCESS;
    },
    fd_fdstat_get(fd: number, out: number) {
      const type = fd <= 2 ? 2 : fd === ROOT ? 3 : files.has(fd) ? 4 : -1;
      if (type < 0) return ERRNO.BADF;
      view().setUint8(out, type);
      view().setUint16(out + 2, 0, true);
      view().setBigUint64(out + 8, 0xffffffffffffffffn, true);
      view().setBigUint64(out + 16, 0xffffffffffffffffn, true);
      return ERRNO.SUCCESS;
    },
    fd_read(fd: number, iovs: number, count: number, out: number) {
      const file = files.get(fd);
      if (!file) return fd === 0 ? (view().setUint32(out, 0, true), ERRNO.SUCCESS) : ERRNO.BADF;
      let read = 0;
      for (const [at, size] of vectors(iovs, count)) {
        const chunk = file.data.subarray(file.position, file.position + size);
        bytes().set(chunk, at);
        file.position += chunk.length;
        read += chunk.length;
        if (chunk.length < size) break;
      }
      view().setUint32(out, read, true);
      return ERRNO.SUCCESS;
    },
    fd_seek(fd: number, offset: bigint, whence: number, out: number) {
      const file = files.get(fd);
      if (!file) return ERRNO.BADF;
      const base = whence === 0 ? 0 : whence === 1 ? file.position : whence === 2 ? file.data.length : NaN,
        position = base + Number(offset);
      if (!(position >= 0)) return ERRNO.INVAL;
      file.position = position;
      view().setBigUint64(out, BigInt(position), true);
      return ERRNO.SUCCESS;
    },
    fd_tell(fd: number, out: number) {
      const file = files.get(fd);
      if (!file) return ERRNO.BADF;
      view().setBigUint64(out, BigInt(file.position), true);
      return ERRNO.SUCCESS;
    },
    // Warnings go nowhere; they carry nothing a result does not.
    fd_write(fd: number, iovs: number, count: number, out: number) {
      if (fd > 2) return ERRNO.BADF;
      view().setUint32(out, vectors(iovs, count).reduce((sum, [, size]) => sum + size, 0), true);
      return ERRNO.SUCCESS;
    },
    fd_close(fd: number) {
      return files.delete(fd) ? ERRNO.SUCCESS : ERRNO.BADF;
    },
    path_rename: () => ERRNO.NOTSUP,
    proc_exit(code: number) {
      throw new Error(`SyncTeX index exited with status ${code}`);
    },
  };
}

export class SynctexIndex {
  private exports: Exports | null;
  private open: boolean;
  constructor(pdf: string) {
    let memory: WebAssembly.Memory | undefined;
    const instance = new WebAssembly.Instance(wasm(), {
      wasi_snapshot_preview1: system(() => memory!),
    });
    this.exports = instance.exports as unknown as Exports;
    memory = this.exports.memory;
    this.exports._initialize?.();
    const name = this.string(pdf);
    // Without SyncTeX data the CLI answers every query with no results.
    this.open = this.exports.st_open(name) !== 0;
    this.exports.st_free(name);
  }
  private string(text: string) {
    const encoded = new TextEncoder().encode(text + "\0"),
      at = this.exports!.st_alloc(encoded.length);
    new Uint8Array(this.exports!.memory.buffer, at, encoded.length).set(encoded);
    return at;
  }
  // What `synctex view -i line:0:input -o pdf` reports, in its order.
  view(input: string, line: number): ViewResult[] {
    if (!this.exports || !this.open) return [];
    const name = this.string(input),
      count = this.exports.st_view(name, line);
    this.exports.st_free(name);
    const rows: ViewResult[] = [];
    if (count > 0) {
      const data = new Float64Array(
        this.exports.memory.buffer,
        this.exports.st_results(),
        count * 7,
      );
      for (let i = 0; i < count; i++)
        rows.push(Array.from(data.subarray(i * 7, i * 7 + 7)) as ViewResult);
    }
    return rows;
  }
  close() {
    if (!this.exports) return;
    this.exports.st_close();
    this.exports = null;
  }
}
