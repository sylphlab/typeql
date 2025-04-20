import { describe, it, expect, vi } from 'vitest';
import { renderHook, render } from '@testing-library/react'; // Use React Testing Library
import React, { ReactNode } from 'react'; // Import React
import { TypeQLProvider, useTypeQL } from './context'; // Corrected relative import path
import type { createClient, OptimisticStore } from '@sylphlab/typeql-client';

// Use ReturnType to get the type of the client instance for mocking
type TypeQLClientInstance = ReturnType<typeof createClient>;

// Mock the TypeQLClient and OptimisticStore (same mocks should work)
const mockClient = {
  query: vi.fn(),
  mutate: vi.fn(),
  subscribe: vi.fn(),
} as unknown as TypeQLClientInstance;

const mockStore = {
  getState: vi.fn(() => ({})),
} as unknown as OptimisticStore<any>;

describe('TypeQLProvider and useTypeQL (React)', () => {
  it('should provide the client instance via useTypeQL', () => {
    // Wrapper using React JSX
    const wrapper = ({ children }: { children: ReactNode }) => ( // Use ReactNode
      <TypeQLProvider client={mockClient}>{children}</TypeQLProvider>
    );

    // Use renderHook from @testing-library/react
    const { result } = renderHook(() => useTypeQL(), { wrapper });

    expect(result.current.client).toBe(mockClient);
    expect(result.current.store).toBeUndefined();
  });

  it('should provide the client and store instances via useTypeQL', () => {
    // Wrapper using React JSX
    const wrapper = ({ children }: { children: ReactNode }) => ( // Use ReactNode
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
    const TestChild = () => <div>Test Child Content</div>; // Use React JSX
    // Use render from @testing-library/react
    const { getByText } = render(
      <TypeQLProvider client={mockClient}>
        <TestChild />
      </TypeQLProvider>
    );
    expect(getByText('Test Child Content')).toBeDefined();
  });
});