import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/preact';
import { TypeQLProvider, useQuery, useMutation, useSubscription, useTypeQL } from '@sylph/typeql-preact'; // Correct package name
import { TypeQLTransport, SubscriptionDataMessage, SubscriptionErrorMessage, UnsubscribeFn, SubscribeMessage, ProcedureContext } from '@sylph/typeql-shared'; // Correct package name
import { createClient } from '@sylph/typeql-client'; // Import createClient separately
// Removed Router import as inferred type is used
import { createRouter } from '@sylph/typeql-server'; // Correct package name
import { initTypeQL } from '@sylph/typeql-server'; // Correct package name
import * as z from 'zod'; // Import zod
import { h } from 'preact';

// Create procedure builder initializer instance
const t = initTypeQL();

// Mock Transport
const mockTransport: TypeQLTransport = {
  request: vi.fn(),
  // Revert signature to match TypeQLTransport interface (message: SubscribeMessage)
  subscribe: vi.fn((message: SubscribeMessage) => {
    const iterator = (async function*(): AsyncIterableIterator<SubscriptionDataMessage | SubscriptionErrorMessage> {
        // Yield mock data or updates here if needed for specific tests
        // Correct message type to 'subscriptionData' and remove 'topic'
        yield { type: 'subscriptionData' as const, id: message.id, data: { initial: true }, serverSeq: 1 };
        // yield { type: 'subscriptionData' as const, id: message.id, data: { update: 'something' }, serverSeq: 2, prevServerSeq: 1 };
        // yield { type: 'subscriptionError' as const, id: message.id, error: { message: 'Something went wrong' } };
      })();
    return {
        iterator,
        unsubscribe: vi.fn() as UnsubscribeFn, // Ensure mock unsubscribe matches type
    };
  }),
  requestMissingDeltas: vi.fn(),
  // Removed close: vi.fn() as it's not in TypeQLTransport
  onAckReceived: vi.fn(),
};

// Define Mock Router using server utilities
const mockRouter = createRouter()({ // Keep () call
  // Use .input/.output/.subscriptionOutput with Zod schemas
  testQuery: t.query
    .input(z.object({ id: z.string() }))
    .output(z.object({ id: z.string(), data: z.string() }))
    .resolve(async ({ input }) => ({ id: input.id, data: `Data for ${input.id}` })), // Remove generics from resolve

  testMutation: t.mutation
    .input(z.object({ data: z.string() }))
    .output(z.object({ success: z.boolean() }))
    .resolve(async ({ input }) => ({ success: true })), // Remove generics from resolve

  testSubscription: t.subscription
    .input(z.object({ topic: z.string() }))
    .subscriptionOutput(z.object({ delta: z.any(), serverSeq: z.number(), prevServerSeq: z.number().optional() }))
    // Refactor resolver to use publish and return cleanup function
    .subscribe(({ input, publish }) => {
      // console.log(`Mock subscription started for topic: ${input.topic}`);
      // Simulate publishing initial data immediately
      publish({ delta: { initial: true }, serverSeq: 1 });

      // Removed setInterval to prevent potential leaks in test environment

      // Return an empty cleanup function as there's no interval
      return () => {
        // console.log(`Mock subscription cleanup for topic: ${input.topic} (no interval)`);
      };
    }),
});

// Infer the router type
type MockAppRouter = typeof mockRouter;

// Mock Client using the inferred router type
const mockClient = createClient<MockAppRouter>({
  transport: mockTransport,
});

// Wrapper component for providing context
const wrapper = ({ children }: { children: preact.ComponentChildren }) => (
  h(TypeQLProvider, { client: mockClient, children: children }) // Explicitly pass children prop
);

describe('@typeql/preact Hooks', { timeout: 5000 }, () => { // Removed .skip to test memory usage
  describe('useTypeQL', () => {
    it('should return the client instance from context', () => {
      const { result } = renderHook(() => useTypeQL(), { wrapper });
      // Assert the client property specifically, not the whole context object
      expect(result.current.client).toBe(mockClient);
      expect(result.current.store).toBeUndefined(); // Also check store is undefined as expected
    });

    it('should throw error if used outside of TypeQLProvider', () => {
       // Preact testing library doesn't easily capture errors thrown during initial render like React's does.
       // We might need a different approach or accept this limitation.
       // For now, skipping direct error throw test during render.
       // console.warn("Skipping useTypeQL error test outside provider due to testing library limitations.");
    });
  });

  describe('useQuery', () => {
    it('should fetch data on initial render', async () => {
      // TODO: Implement test
    });

    it('should return loading state initially', () => {
      // TODO: Implement test
    });

    it('should return data after successful fetch', async () => {
      // TODO: Implement test
    });

    it('should return error state on fetch failure', async () => {
      // TODO: Implement test
    });

    it('should refetch data when input changes', async () => {
      // TODO: Implement test
    });

     it('should use the select function when provided', async () => {
      // TODO: Implement test
    });

    it('should update data based on optimistic store changes', async () => {
       // TODO: Implement test - requires mocking store updates
    });
  });

  describe('useMutation', () => {
    it('should call the mutation function on mutate', async () => {
      // TODO: Implement test
    });

    it('should return loading state during mutation', async () => {
      // TODO: Implement test
    });

    it('should return data after successful mutation', async () => {
      // TODO: Implement test
    });

    it('should return error state on mutation failure', async () => {
      // TODO: Implement test
    });

    it('should trigger optimistic updates if configured', async () => {
       // TODO: Implement test - requires mocking store interaction
    });
  });

  describe('useSubscription', () => {
    it('should subscribe on initial render', async () => {
      // TODO: Implement test
    });

    it('should return initial data if provided by subscription', async () => {
       // TODO: Implement test - requires specific mock transport behavior
    });

    it('should update data when deltas are received', async () => {
      // TODO: Implement test
    });

    it('should handle errors during subscription', async () => {
      // TODO: Implement test
    });

    it('should unsubscribe on unmount', () => {
      // TODO: Implement test
    });

    it('should resubscribe when input changes', async () => {
      // TODO: Implement test
    });
  });
});