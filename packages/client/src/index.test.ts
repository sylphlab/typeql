import { describe, it, expect } from 'vitest';
// Import something known to be exported from the index file
import { createClient } from './index';

describe('Client Index Exports', () => {
  it('should export createClient function', () => {
    // Simple assertion to ensure the import worked and the function exists
    expect(createClient).toBeDefined();
    expect(typeof createClient).toBe('function');
  });

  // Add more tests here if needed to check other specific exports
});