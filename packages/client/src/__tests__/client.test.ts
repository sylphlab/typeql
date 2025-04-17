import { describe, it, expect, vi, beforeEach, Mock } from 'vitest'; // Import Mock type
import { createClient, TypeQLClientError, ClientOptions } from '../client'; // Adjust path if needed
import { OptimisticStore } from '../optimisticStore';
import type {
    AnyRouter,
    TypeQLTransport,
    ProcedureCallMessage,
    ProcedureResultMessage,
    SubscribeMessage,
    SubscriptionDataMessage,
    SubscriptionErrorMessage,
    UnsubscribeFn
} from '@sylphlab/typeql-shared'; // Import TypeQLTransport and message types from shared
import { z } from 'zod';

// Mock Transport - Use 'any' to bypass TS type checking for mock methods
const mockTransport: any = { // Changed TypeQLTransport to any
  request: vi.fn(),
  subscribe: vi.fn(),
  onAckReceived: undefined, // Start as undefined
  // Add other optional methods if needed for specific tests
};

// Mock OptimisticStore
const mockStore = {
  addPendingMutation: vi.fn(),
  confirmPendingMutation: vi.fn(),
  rejectPendingMutation: vi.fn(),
  // Add other methods if needed
} as unknown as OptimisticStore<any>; // Cast to satisfy type

// Mock Router Type (Define a simple structure for testing)
type MockProcedure<TInput, TOutput> = {
  _def: {
    type: 'query' | 'mutation' | 'subscription';
    inputSchema: z.ZodType<TInput>;
    outputSchema: z.ZodType<TOutput>;
  };
};

type MockRouter = {
  _def: {
    router: true;
    procedures: {
      user: {
        _def: {
          router: true;
          procedures: {
            get: MockProcedure<{ id: string }, { id: string; name: string }>;
            update: MockProcedure<{ id: string; name: string }, { success: boolean }>;
          };
        };
      };
      post: {
        _def: {
          router: true;
          procedures: {
            onNew: MockProcedure<undefined, { id: string; content: string }>;
          };
        };
      };
      noInputQuery: MockProcedure<undefined, string>;
    };
  };
} & AnyRouter; // Extend AnyRouter

describe('createClient', () => {
  let client: any; // Cast to any to bypass type errors for now
  const opts: ClientOptions = { transport: mockTransport };

  beforeEach(() => {
    vi.resetAllMocks(); // Reset mocks before each test
    mockTransport.onAckReceived = undefined; // Reset handler
    client = createClient<MockRouter>(opts);
  });

  it('should create a proxy object reflecting router structure', () => {
    expect(client).toBeDefined();
    expect(client.user).toBeDefined();
    expect(client.user.get).toBeDefined();
    expect(client.user.update).toBeDefined();
    expect(client.post).toBeDefined();
    expect(client.post.onNew).toBeDefined();
    expect(client.noInputQuery).toBeDefined();
  });

  describe('Query Calls', () => {
    it('should call transport.request for query', async () => {
      const input = { id: '123' };
      const expectedResult = { id: '123', name: 'Test User' };
      mockTransport.request.mockResolvedValueOnce({
        id: 1, // Mock ID
        result: { type: 'data', data: expectedResult },
      });

      const result = await client.user.get.query(input);

      expect(mockTransport.request).toHaveBeenCalledOnce();
      expect(mockTransport.request).toHaveBeenCalledWith(expect.objectContaining({
        type: 'query',
        path: 'user.get',
        input: input,
      }));
      expect(result).toEqual(expectedResult);
    });

     it('should handle query without input', async () => {
        const expectedResult = "hello world";
        mockTransport.request.mockResolvedValueOnce({
            id: 1,
            result: { type: 'data', data: expectedResult },
        });

        const result = await client.noInputQuery.query(undefined as never); // Pass undefined for no-input query

        expect(mockTransport.request).toHaveBeenCalledOnce();
        expect(mockTransport.request).toHaveBeenCalledWith(expect.objectContaining({
            type: 'query',
            path: 'noInputQuery',
            input: undefined, // Ensure input is undefined
        }));
        expect(result).toEqual(expectedResult);
    });

    it('should throw TypeQLClientError on transport.request query error', async () => {
      const input = { id: '123' };
      const error = new Error('Network failed');
      mockTransport.request.mockRejectedValueOnce(error);

      try {
        await client.user.get.query(input);
        // Should not reach here
        expect.fail('Expected query to throw');
      } catch (e: any) {
        expect(e).toBeInstanceOf(TypeQLClientError);
        expect(e.message).toContain('Network failed');
        expect(e.code).toBe('QUERY_FAILED'); // Expect specific code for query failure
      }
      // Verify mock was called
      expect(mockTransport.request).toHaveBeenCalledTimes(1); // Ensure mock was called once per try
    });

    it('should throw TypeQLClientError on server error result for query', async () => {
      const input = { id: '123' };
      const errorResult = { message: 'User not found', code: 'NOT_FOUND' };
      mockTransport.request.mockResolvedValueOnce({
        id: 1,
        result: { type: 'error', error: errorResult },
      });

       try {
        await client.user.get.query(input);
        expect.fail('Expected query to throw');
      } catch (e: any) {
        expect(e).toBeInstanceOf(TypeQLClientError);
        expect(e.message).toBe('User not found');
        expect(e.code).toBe('NOT_FOUND');
      }
       expect(mockTransport.request).toHaveBeenCalledTimes(1);
    });
  });

  describe('Mutation Calls', () => {
    it('should call transport.request for non-optimistic mutation', async () => {
      const input = { id: '123', name: 'New Name' };
      const expectedResult = { success: true };
      mockTransport.request.mockResolvedValueOnce({
        id: 1,
        result: { type: 'data', data: expectedResult },
      });

      const result = await client.user.update.mutate({ input });

      expect(mockTransport.request).toHaveBeenCalledOnce();
      // Check essential properties, ensuring clientSeq is NOT present
      expect(mockTransport.request).toHaveBeenCalledWith(expect.objectContaining({
        type: 'mutation',
        path: 'user.update',
        input: input,
      }));
      expect(mockTransport.request).not.toHaveBeenCalledWith(expect.objectContaining({
          clientSeq: expect.anything(),
      }));
      expect(result).toEqual(expectedResult);
    });

    it('should throw TypeQLClientError on transport.request mutation error', async () => {
      const input = { id: '123', name: 'New Name' };
      const error = new Error('Mutation transport failed');
      mockTransport.request.mockRejectedValueOnce(error);

       try {
        await client.user.update.mutate({ input });
        expect.fail('Expected mutation to throw');
      } catch (e: any) {
        expect(e).toBeInstanceOf(TypeQLClientError);
        expect(e.message).toContain('Mutation transport failed');
        expect(e.code).toBe('MUTATION_FAILED'); // Expect specific code for mutation failure
      }
       expect(mockTransport.request).toHaveBeenCalledTimes(1);
    });

    it('should throw TypeQLClientError on server error result for mutation', async () => {
      const input = { id: '123', name: 'New Name' };
      const errorResult = { message: 'Update failed', code: 'INTERNAL_SERVER_ERROR' };
      mockTransport.request.mockResolvedValueOnce({
        id: 1,
        result: { type: 'error', error: errorResult },
      });

       try {
        await client.user.update.mutate({ input });
        expect.fail('Expected mutation to throw');
      } catch (e: any) {
        expect(e).toBeInstanceOf(TypeQLClientError);
        expect(e.message).toBe('Update failed');
        expect(e.code).toBe('INTERNAL_SERVER_ERROR');
      }
       expect(mockTransport.request).toHaveBeenCalledTimes(1);
    });
  });

  describe('Subscription Calls', () => {
    it('should call transport.subscribe and return iterator/unsubscribe', () => {
      const input = undefined; // Assuming no input for this sub
      const mockIterator = (async function*() { yield { type: 'subscriptionData', id: 1, data: {}, serverSeq: 1 }; })();
      const mockUnsubscribe = vi.fn();
      mockTransport.subscribe.mockReturnValueOnce({
        iterator: mockIterator,
        unsubscribe: mockUnsubscribe,
      });

      const result = client.post.onNew.subscribe(input as never);

      expect(mockTransport.subscribe).toHaveBeenCalledOnce();
      expect(mockTransport.subscribe).toHaveBeenCalledWith(expect.objectContaining({
        type: 'subscription',
        path: 'post.onNew',
        input: input,
      }));
      expect(result.iterator).toBe(mockIterator);
      expect(result.unsubscribe).toBe(mockUnsubscribe);
    });

    it('should throw TypeQLClientError if transport.subscribe fails', () => {
       const error = new Error('Subscription failed');
       mockTransport.subscribe.mockImplementationOnce(() => { throw error; });

       try {
         client.post.onNew.subscribe(undefined as never);
         expect.fail('Expected subscribe to throw');
       } catch (e: any) {
         expect(e).toBeInstanceOf(TypeQLClientError);
         expect(e.message).toContain('Subscription failed');
         expect(e.code).toBe('SUBSCRIPTION_ERROR');
       }
       expect(mockTransport.subscribe).toHaveBeenCalledTimes(1);
    });
  });

  describe('Optimistic Updates', () => {
     let clientWithStore: any; // Cast to any to bypass type errors for now
     const optsWithStore: ClientOptions = { transport: mockTransport, store: mockStore };

     beforeEach(() => {
        clientWithStore = createClient<MockRouter>(optsWithStore);
     });

     it('should wire transport.onAckReceived to store.confirmPendingMutation', () => {
        // createClient in beforeEach should have wired it
        expect(mockTransport.onAckReceived).toBeDefined();
        // Simulate receiving an ack
        const ack = { type: 'ack', id: 1, clientSeq: 1, serverSeq: 100 } as const;
        mockTransport.onAckReceived?.(ack);
        expect(mockStore.confirmPendingMutation).toHaveBeenCalledWith(ack);
     });

     it('should call store.addPendingMutation for optimistic mutation', async () => {
        const input = { id: '456', name: 'Optimistic Name' };
        const predictedChange = () => {}; // Mock recipe or patches
        mockTransport.request.mockResolvedValueOnce({ id: 1, result: { type: 'data', data: { success: true } } });

        await clientWithStore.user.update.mutate({ input, optimistic: { predictedChange } });

        expect(mockStore.addPendingMutation).toHaveBeenCalledOnce();
        expect(mockStore.addPendingMutation).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'mutation',
                path: 'user.update',
                input: input,
                clientSeq: expect.any(Number), // Check that clientSeq is generated
            }),
            predictedChange
        );
        // Ensure request is still sent
        expect(mockTransport.request).toHaveBeenCalledOnce();
        expect(mockTransport.request).toHaveBeenCalledWith(expect.objectContaining({
            clientSeq: expect.any(Number),
        }));
     });

     it('should call store.rejectPendingMutation on server error for optimistic mutation', async () => {
        const input = { id: '789', name: 'Error Name' };
        const predictedChange = () => {};
        const errorResult = { message: 'Server rejected', code: 'VALIDATION_ERROR' };
        mockTransport.request.mockResolvedValueOnce({ id: 1, result: { type: 'error', error: errorResult } });

        await expect(clientWithStore.user.update.mutate({ input, optimistic: { predictedChange } }))
            .rejects.toThrow(TypeQLClientError); // Expect specific error type

        expect(mockStore.addPendingMutation).toHaveBeenCalledOnce(); // Still added initially
        // rejectPendingMutation should be called once (now happens in the server error block)
        expect(mockStore.rejectPendingMutation).toHaveBeenCalledOnce();
        expect(mockStore.rejectPendingMutation).toHaveBeenCalledWith(expect.any(Number)); // Called with the clientSeq
     });

     it('should call store.rejectPendingMutation on transport error for optimistic mutation', async () => {
        const input = { id: '101', name: 'Transport Error Name' };
        const predictedChange = () => {};
        const error = new Error('Connection lost');
        mockTransport.request.mockRejectedValueOnce(error);

        await expect(clientWithStore.user.update.mutate({ input, optimistic: { predictedChange } }))
            .rejects.toThrow('Connection lost');

        expect(mockStore.addPendingMutation).toHaveBeenCalledOnce();
        expect(mockStore.rejectPendingMutation).toHaveBeenCalledOnce();
        expect(mockStore.rejectPendingMutation).toHaveBeenCalledWith(expect.any(Number));
     });
  });

});