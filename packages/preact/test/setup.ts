import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/preact';

// Optional: Run cleanup after each test case (e.g., clearing jsdom)
// This might be handled by Vitest's environment setup too.
afterEach(() => {
  cleanup();
});

// Add any other global test setup here
console.log('Vitest setup for @sylphlab/typeql-preact running...');
