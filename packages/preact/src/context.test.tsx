import { describe, it, expect, vi } from 'vitest';
import { render, renderHook, act } from '@testing-library/preact';
import { h } from 'preact';
import { zenQueryProvider, usezenQuery } from './context';
import type { createClient, OptimisticStore } from '@sylphlab/zen-query-client';
// Use ReturnType to get the type of the client instance for mocking
type zenQueryClientInstance = ReturnType<typeof createClient>;

// Mock the zenQueryClient and OptimisticStore
const mockClient = {
  // Add mock methods as needed for other hook tests, not strictly needed here
  query: vi.fn(),
  mutate: vi.fn(),
  subscribe: vi.fn(),
} as unknown as zenQueryClientInstance; // Cast for simplicity

const mockStore = {
  // Add mock methods if needed
  getState: vi.fn(() => ({})),
} as unknown as OptimisticStore<any>; // Cast for simplicity

describe('zenQueryProvider and usezenQuery', () => {
  it('should provide the client instance via usezenQuery', () => {
    // Use JSX for wrapper for potentially better type inference
    const wrapper = ({ children }: { children: any }) => (
      <zenQueryProvider client={mockClient}>{children}</zenQueryProvider>
    );

    // Use renderHook to test the hook
    const { result } = renderHook(() => usezenQuery(), { wrapper });

    expect(result.current.client).toBe(mockClient);
    expect(result.current.store).toBeUndefined();
  });

  it('should provide the client and store instances via usezenQuery', () => {
    // Use JSX for wrapper
    const wrapper = ({ children }: { children: any }) => (
      <zenQueryProvider client={mockClient} store={mockStore}>{children}</zenQueryProvider>
    );

    const { result } = renderHook(() => usezenQuery(), { wrapper });

    expect(result.current.client).toBe(mockClient);
    expect(result.current.store).toBe(mockStore);
  });

  it('should throw an error if usezenQuery is used outside a zenQueryProvider', () => {
    // Suppress console.error output during this expected error test
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Expect renderHook itself to throw when the hook throws during initial render
    expect(() => renderHook(() => usezenQuery())).toThrow(
      'usezenQuery must be used within a zenQueryProvider'
    );

    // Restore console.error
    consoleErrorSpy.mockRestore();
  });

  // Optional: Test rendering children
  it('should render children components', () => {
    const TestChild = () => h('div', {}, 'Test Child Content');
    // Use JSX for render
    const { getByText } = render(
      <zenQueryProvider client={mockClient}>
        <TestChild />
      </zenQueryProvider>
    );
    expect(getByText('Test Child Content')).toBeDefined();
  });
});
