import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { licenseInfoPlugin } from './scripts/licenses.ts';
export default defineConfig(async ({ mode }) => ({
  resolve: mode === 'playground' ? { dedupe: ['react', 'react-dom'] } : undefined,
  base: mode === 'playground' ? '/demo/' : '/',
  plugins: [react(), licenseInfoPlugin(), ...(mode === 'playground' ? [(await import('./scripts/playground-assets.ts')).playgroundAssets()] : [])],
  build: { outDir: mode === 'playground' ? '_site/demo' : 'dist', ...(mode === 'playground' ? { rolldownOptions: { input: ['index.html', 'src/web/playground/review.html'] } } : {}) },
}));
