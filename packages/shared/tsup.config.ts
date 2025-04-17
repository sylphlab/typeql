import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm', 'cjs'],
  experimentalDts: {
    entry: 'src/index.ts',
    compilerOptions: {
      composite: true,
      incremental: true,
      tsBuildInfoFile: './.tsbuildinfo'
    }
  },
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: 'terser',
  tsconfig: 'tsconfig.json',
  // No external needed for shared
})