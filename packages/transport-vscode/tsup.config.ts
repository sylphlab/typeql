import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm', 'cjs'],
  dts: true, // Re-enable tsup DTS generation
  splitting: false,
  sourcemap: true,
  clean: true,
  tsconfig: 'tsconfig.json',
  external: ['vscode', '@sylphlab/typeql-shared'] // Mark internal workspace deps and vscode as external
})