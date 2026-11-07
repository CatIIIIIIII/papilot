import { version } from '../../../package.json';
import metadata from 'virtual:playground-paper';
import { browserStorage } from '../storage.ts';
import { createPlaygroundData, PlaygroundDownloadRequired } from './data.ts';
type DemoWindow = Window & { __papilotDemoApi?: typeof playgroundApi };
// Review frames share the parent transport, including its in-memory fallback
// when storage is blocked or full. Remounting a frame must not reset decisions.
const parentApi = (() => {
  try { return window.parent !== window ? (window.parent as DemoWindow).__papilotDemoApi : undefined; }
  catch { return undefined; } // The standalone Demo may itself be embedded cross-origin.
})();
const local = parentApi || createPlaygroundData(browserStorage, version, metadata.key, metadata.pages);
export async function playgroundApi<T>(route: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  try { return await local<T>(route, body, signal); }
  catch (error) { if (error instanceof PlaygroundDownloadRequired) window.dispatchEvent(new Event('papilot:playground-download')); throw error; }
}
(window as DemoWindow).__papilotDemoApi = playgroundApi;
