import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.cjs'],
  outfile: 'dist/main.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  logLevel: 'info',
});

await build({
  entryPoints: ['src/renderer.jsx'],
  outfile: 'dist/renderer.mjs',
  bundle: true,
  platform: 'browser',
  format: 'esm',
  jsx: 'automatic',
  logLevel: 'info',
});
