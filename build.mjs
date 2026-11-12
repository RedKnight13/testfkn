// Bundles src/app.js, inlines it into one self-contained index.html, and copies the service worker.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';

const out = await build({
  entryPoints: ['src/app.js'], bundle: true, format: 'iife', minify: true,
  target: ['es2020'], write: false, legalComments: 'none',
});
const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = readFileSync('src/template.html', 'utf8').replace('/*APP_JS*/', () => js);
mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', html);
copyFileSync('src/sw.js', 'dist/sw.js');
console.log('dist/index.html', (html.length / 1024).toFixed(0) + ' KB');
