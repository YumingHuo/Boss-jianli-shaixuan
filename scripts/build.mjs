import { build } from 'vite';
import { mkdir, copyFile, cp } from 'node:fs/promises';
await build({ build: { outDir: 'dist', emptyOutDir: true, rollupOptions: { input: { index: 'index.html', report: 'report.html', offscreen: 'offscreen.html' } } } });
for (const entry of ['background', 'content']) {
  await build({ publicDir: false, build: { outDir: 'dist', emptyOutDir: false, lib: { entry: `src/${entry}/index.ts`, name: 'HiringCopilot', formats: [entry === 'content' ? 'iife' : 'es'], fileName: () => `${entry}.js` } } });
}
await mkdir('dist', { recursive: true });
await copyFile('manifest.json', 'dist/manifest.json');
await mkdir('dist/ocr', { recursive: true });
await copyFile('node_modules/tesseract.js/dist/worker.min.js', 'dist/ocr/worker.min.js');
await cp('node_modules/tesseract.js-core', 'dist/ocr/core', { recursive: true, filter: path => !path.endsWith('.md') });
await cp('vendor/ocr/lang', 'dist/ocr/lang', { recursive: true });
