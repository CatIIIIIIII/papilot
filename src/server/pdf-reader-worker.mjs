// Workers do not inherit the CLI's programmatically registered TypeScript
// loader. Bootstrap it here for npm, desktop, and `tsx` development alike.
import { register } from 'tsx/esm/api';
register();
await import('./pdf-reader-worker.ts');
