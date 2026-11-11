// Playwright for the check scripts. Their expect waits up to 15 s, as the
// pages' own timeouts do: a shared CI runner can take longer than Playwright's
// 5 s default to render a state the app does reach, while a state it never
// reaches still fails.
import { expect as playwrightExpect } from '../engine/node_modules/@playwright/test/index.mjs';
export { chromium, webkit, _electron } from '../engine/node_modules/@playwright/test/index.mjs';
export const expect = playwrightExpect.configure({ timeout: 15_000 });
