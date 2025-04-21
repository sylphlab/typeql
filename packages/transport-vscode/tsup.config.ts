import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: [
    '@sylphlab/zen-query-shared',
    'vscode',
  ],
  target: 'es2020',
  platform: 'neutral',
});