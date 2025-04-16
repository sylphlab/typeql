import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // Output directory relative to the project root (examples/vscode-extension/)
    outDir: 'dist/webview',
    // Don't empty the outDir, as the extension compile might also output there
    emptyOutDir: false,
    rollupOptions: {
      input: {
        // Entry point for the webview code
        main: 'src/webview/main.tsx',
      },
      output: {
        // Output file names (relative to outDir)
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name].[ext]',
      },
    },
  },
  // Define base to ensure assets are loaded correctly in the webview
  base: './',
});