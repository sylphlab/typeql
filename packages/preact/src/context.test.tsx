import { describe, it, expect, vi } from 'vitest';
import { render, renderHook, act } from '@testing-library/preact';
import { h } from 'preact';
import { TypeQLProvider, useTypeQL } from './context';
import type { createClient, OptimisticStore } from '@sylphlab/typeql-client';
// Use ReturnType to get the type of the client instance for mocking
type TypeQLClientInstance = ReturnType<typeof createClient>;

// Mock the TypeQLClient and OptimisticStore
const mockClient = {
  // Add mock methods as needed for other hook tests, not strictly needed here
  query: vi.fn(),
  mutate: vi.fn(),
  subscribe: vi.fn(),
} as unknown as TypeQLClientInstance; // Cast for simplicity

const mockStore = {
  // Add mock methods if needed
  getState: vi.fn(() => ({})),
} as unknown as OptimisticStore<any>; // Cast for simplicity

describe('TypeQLProvider and useTypeQL', () => {
  it('should provide the client instance via useTypeQL', () => {
    // Use JSX for wrapper for potentially better type inference
    const wrapper = ({ children }: { children: any }) => (
      <TypeQLProvider client={mockClient}>{children}</TypeQLProvider>
    );

    // Use renderHook to test the hook
    const { result } = renderHook(() => useTypeQL(), { wrapper });

    expect(result.current.client).toBe(mockClient);
    expect(result.current.store).toBeUndefined();
  });

  it('should provide the client and store instances via useTypeQL', () => {
    // Use JSX for wrapper
    const wrapper = ({ children }: { children: any }) => (
      <TypeQLProvider client={mockClient} store={mockStore}>{children}</TypeQLProvider>
    );

    const { result } = renderHook(() => useTypeQL(), { wrapper });

    expect(result.current.client).toBe(mockClient);
    expect(result.current.store).toBe(mockStore);
  });

  it('should throw an error if useTypeQL is used outside a TypeQLProvider', () => {
    // Suppress console.error output during this expected error test
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Expect renderHook itself to throw when the hook throws during initial render
    expect(() => renderHook(() => useTypeQL())).toThrow(
      'useTypeQL must be used within a TypeQLProvider'
    );

    // Restore console.error
    consoleErrorSpy.mockRestore();
  });

  // Optional: Test rendering children
  it('should render children components', () => {
    const TestChild = () => h('div', {}, 'Test Child Content');
    // Use JSX for render
    const { getByText } = render(
      <TypeQLProvider client={mockClient}>
        <TestChild />
      </TypeQLProvider>
    );
    expect(getByText('Test Child Content')).toBeDefined();
  });
});
