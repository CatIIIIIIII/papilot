import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, DATA } from './paths.ts';
import { activeInstallation, waitForActivation } from '../../bin/installation.mjs';

const desktop = process.env.PAPILOT_DESKTOP === '1';
if (!desktop) await waitForActivation(DATA);
const root = desktop ? ROOT : activeInstallation(ROOT, DATA);
// A source checkout's default data directory must not move with the release.
process.env.PAPILOT_DATA = DATA;
await import(pathToFileURL(path.join(root, 'src/server/start.ts')).href);
