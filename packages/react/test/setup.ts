// packages/react/test/setup.ts
import { afterEach, expect } from 'vitest';
import { cleanup } from '@testing-library/react'; // Use react testing library
import * as matchers from '@testing-library/jest-dom/matchers';
import '@testing-library/jest-dom/vitest'; // Import the extension

// Extend Vitest's expect with jest-dom matchers
expect.extend(matchers);

// Automatically cleanup the DOM after each test
afterEach(() => {
  cleanup();
});

console.log('Vitest setup file loaded for @sylphlab/typeql-react.');