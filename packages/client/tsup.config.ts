import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/client.ts',
    'src/optimisticStore.ts'
  ],
  outDir: 'dist',
  format: ['esm', 'cjs'],
  dts: true, // Re-enable tsup DTS generation
  splitting: false,
  sourcemap: true,
  clean: true,
  tsconfig: 'tsconfig.json',
  external: ['@sylphlab/zen-query-shared'], // Mark internal workspace deps as external
})