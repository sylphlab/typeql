import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm', 'cjs'],
  dts: true, // Generate declaration files
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: 'terser',
  tsconfig: 'tsconfig.json',
  external: ['ws'], // Mark only external deps like ws
})