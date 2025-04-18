import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/client.ts',
    'src/optimisticStore.ts'
  ],
  outDir: 'dist',
  format: ['esm', 'cjs'],
  dts: false, // Use tsc --build for declarations
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: 'terser',
  tsconfig: 'tsconfig.json',
  external: [], // Workspace deps should not be external
})