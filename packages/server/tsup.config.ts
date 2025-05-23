import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm', 'cjs'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  tsconfig: 'tsconfig.json',
  external: ['@sylphlab/zen-query-shared'] // Mark internal workspace deps as external
})