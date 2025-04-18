// packages/preact/test/setup.ts
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/preact'; // Assuming @testing-library/preact is used or will be added

// Automatically cleanup the DOM after each test
afterEach(() => {
  cleanup();
});

console.log('Vitest setup file loaded for @typeql/preact.');