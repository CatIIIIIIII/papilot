// pdf.js draws CJK text from fonts without a ToUnicode map, such as xeCJK's
// default Fandol fonts, through Adobe's predefined CMaps; without them those
// characters stay blank. Each bundle ships pdf.js's packed CMaps as assets and
// passes their URLs here. pdf.js then asks for one file at a time by name.
export function cMapData(urls: Record<string, string>, resolve = (url: string) => url) {
  const files = new Map(
    Object.entries(urls).map(([path, url]) => [path.slice(path.lastIndexOf("/") + 1), url]),
  );
  return class CMapData {
    async fetch({ kind, filename }: { kind: string; filename: string }) {
      // Standard fonts and wasm keep pdf.js's behaviour without their URLs.
      if (kind !== "cMapUrl") throw new Error(`Ensure that the \`${kind}\` API parameter is provided.`);
      const url = files.get(filename);
      if (!url) throw new Error(`Unknown CMap: ${filename}`);
      const response = await fetch(resolve(url));
      if (!response.ok) throw new Error(`Unable to load CMap data at: ${resolve(url)}`);
      return new Uint8Array(await response.arrayBuffer());
    }
  };
}
