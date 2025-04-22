import { describe, it, expect, vi } from 'vitest';
import { renderHook, render } from '@testing-library/react'; // Use React Testing Library
import React, { type ReactNode } from 'react'; // Import React
import { zenQueryProvider, usezenQuery } from './context'; // Corrected relative import path
import type { createClient, OptimisticStore } from '@sylphlab/zen-query-client';

// Use ReturnType to get the type of the client instance for mocking
type zenQueryClientInstance = ReturnType<typeof createClient>;

// Mock the zenQueryClient and OptimisticStore (same mocks should work)
const mockClient = {
  query: vi.fn(),
  mutate: vi.fn(),
  subscribe: vi.fn(),
} as unknown as zenQueryClientInstance;

const mockStore = {
  getState: vi.fn(() => ({})),
} as unknown as OptimisticStore<any>;

describe('zenQueryProvider and usezenQuery (React)', () => {
  it('should provide the client instance via usezenQuery', () => {
    // Wrapper using React JSX
    const wrapper = ({ children }: { children: ReactNode }) => ( // Use ReactNode
      <zenQueryProvider client={mockClient}>{children}</zenQueryProvider>
    );

    // Use renderHook from @testing-library/react
    const { result } = renderHook(() => usezenQuery(), { wrapper });

    expect(result.current.client).toBe(mockClient);
    expect(result.current.store).toBeUndefined();
  });

  it('should provide the client and store instances via usezenQuery', () => {
    // Wrapper using React JSX
    const wrapper = ({ children }: { children: ReactNode }) => ( // Use ReactNode
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
    const TestChild = () => <div>Test Child Content</div>; // Use React JSX
    // Use render from @testing-library/react
    const { getByText } = render(
      <zenQueryProvider client={mockClient}>
        <TestChild />
      </zenQueryProvider>
    );
    expect(getByText('Test Child Content')).toBeDefined();
  });
});