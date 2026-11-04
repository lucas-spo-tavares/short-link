import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';

await mkdir('infra/.build', { recursive: true });
await build({
  entryPoints: ['back/src/links.mjs', 'back/src/api-keys.mjs'],
  outdir: 'back/dist',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  legalComments: 'none',
  logLevel: 'info',
});
