import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ENGINE } from './paths.ts';

type Git = typeof import('../../engine/src/core/git.ts');
type Legacy = typeof import('../../engine/src/core/legacy-state.ts');
type Client = typeof import('../../engine/src/client.ts');
const load = <T>(file: string) => import(pathToFileURL(path.join(ENGINE, file)).href) as Promise<T>;
let loaded: Promise<[Git, Legacy, Client]> | undefined;
const engine = () => loaded ??= Promise.all([load<Git>('src/core/git.ts'), load<Legacy>('src/core/legacy-state.ts'), load<Client>('src/client.ts')]);

/** A paper's state folder in its Git directory, shared with the review engine. */
export async function stateDir(gitDir: string) { return (await engine())[0].stateDir(gitDir); }
/** Moves each paper's state from the names that Papilot 0.9.4 and earlier
 *  used, before anything reads it: on startup, and when a paper is added.
 *  On Windows a review server of the earlier version that is still running
 *  stops first, since its open files keep the folder from moving. Elsewhere
 *  it keeps working through the link the move leaves, until Papilot
 *  replaces it as it replaces any server of another version. */
export async function moveLegacyStates(roots: string[]) {
  const [{ gitDirOf, stateOf }, { legacyServerHome }, { stopServerIn }] = await engine();
  for (const root of roots) {
    try {
      const home = process.platform === 'win32' ? legacyServerHome(gitDirOf(root)) : null;
      if (home) await stopServerIn(home, root).catch(error => console.error(`Could not stop the earlier review server of ${root}:`, (error as Error).message));
      stateOf(root);
    } catch (error) { console.error(`Could not move the review state of ${root}:`, (error as Error).message); }
  }
}
