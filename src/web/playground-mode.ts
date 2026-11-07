// Build-time boundary: the regular app never imports the example data adapter.
export const isPlayground = import.meta.env?.MODE === 'playground';
export function requestPlaygroundDownload() { window.dispatchEvent(new Event('papilot:playground-download')); }
export function pdfAsset(url: string) {
  const task = url.match(/^\/api\/tasks\/(example-[a-z-]+)\/pdf/);
  if (isPlayground && task) return `${import.meta.env.BASE_URL}fixtures/${task[1]}/revised.pdf`;
  return isPlayground ? `${import.meta.env.BASE_URL}example.pdf${url.includes('?') ? url.slice(url.indexOf('?')) : ''}` : url;
}
export function wordAsset(url: string) { return isPlayground ? undefined : url; }
