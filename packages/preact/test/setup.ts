import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/preact';
import { h, Fragment } from 'preact'; // Import h and Fragment

// Make h and Fragment globally available for JSX transformation in tests
// Although esbuild config in vitest.config.ts should handle this,
// explicitly setting it here can sometimes resolve environment issues.
// Note: This might cause type conflicts if 'React' is implicitly expected elsewhere.
// Consider if this is truly necessary or if the esbuild config just needs fixing/Vite plugin.
// Let's try WITH global assignment now as other methods failed.
(globalThis as any).h = h; // Use globalThis for better compatibility
(globalThis as any).Fragment = Fragment;
// Also assign to React properties as a workaround for environments expecting React
(globalThis as any).React = { createElement: h, Fragment: Fragment };

// Optional: Run cleanup after each test case (e.g., clearing jsdom)
// This might be handled by Vitest's environment setup too.
afterEach(() => {
  cleanup();
});

// Add any other global test setup here
console.log('Vitest setup for @sylphlab/zen-query-preact running...');
