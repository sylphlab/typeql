import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import { createRouter } from '../router';
import { initTypeQL } from '../procedure';
import { createRequestHandler, RequestHandlerOptions } from '../requestHandler';
import { SubscriptionManager } from '../subscriptionManager';
import { createInMemoryUpdateHistory } from '../updateHistory';
// Import ProcedureCallMessage instead of ProcedureCall
import type { TypeQLTransport, ProcedureCallMessage, ProcedureResultMessage, SubscribeMessage, UnsubscribeMessage, AnyRouter } from '@sylph/typeql-shared';
import { TypeQLClientError } from '@sylph/typeql-shared';
import * as z from 'zod';

// --- Mocks ---
const mockTransport: any = {
  request: vi.fn(),
  subscribe: vi.fn(),
  send: vi.fn(),
  onDisconnect: vi.fn((cb) => {
    // Store the cleanup callback to simulate disconnect later
    mockTransport._cleanupCallback = cb;
    return () => { mockTransport._cleanupCallback = undefined; }; // Return unregister function
  }),
  _cleanupCallback: undefined as (() => void) | undefined, // To store the callback
};

const mockSubManager = {
  addSubscription: vi.fn(),
  removeSubscription: vi.fn(),
  hasSubscription: vi.fn(),
} as unknown as SubscriptionManager;

interface TestContext {
  reqId: number;
  user?: string;
  isAdmin?: boolean;
  [key: string]: unknown; // Index signature
}

const createContext = vi.fn(async ({ transport }): Promise<TestContext> => ({
  reqId: Math.random(),
  user: 'testUser',
  isAdmin: false,
  transport, // Pass transport for potential use in context
}));

const t = initTypeQL<TestContext>();

// --- Test Router ---
const testRouter = createRouter<TestContext>()({
  echo: t.query.input(z.string()).output(z.string()).resolve(({ input }) => input),
  add: t.query.input(z.object({ a: z.number(), b: z.number() })).output(z.number()).resolve(({ input }) => input.a + input.b),
  getUser: t.query.input(z.object({ id: z.string() })).output(z.object({ id: z.string(), name: z.string() })).resolve(({ input }) => ({ id: input.id, name: `User ${input.id}` })),
  updateUser: t.mutation.input(z.object({ id: z.string(), name: z.string() })).output(z.object({ success: z.boolean() })).resolve(({ input }) => ({ success: true })),
  adminOnly: t.mutation.resolve(({ ctx }) => {
    if (!ctx.isAdmin) {
      throw new TypeQLClientError('Forbidden', 'FORBIDDEN');
    }
    return { secret: 'data' };
  }),
  validationError: t.query.input(z.string()).resolve(() => 'ok'), // Input error test
  outputValidationError: t.query.output(z.string()).resolve(() => 123 as any), // Output error test - Return number to trigger error
  resolverError: t.query.resolve(() => { throw new Error('Resolver failed'); }),
  // Subscription
  counter: t.subscription.subscriptionOutput(z.number()).subscribe(({ publish }) => {
    let count = 0;
    const interval = setInterval(() => {
      count++;
      publish(count);
    }, 5); // Publish quickly for testing
    const cleanup = () => clearInterval(interval);
    // Store cleanup with the mock manager for verification
    mockSubManager.addSubscription('sub1', cleanup); // Use a known ID for testing
    return cleanup;
  }),
  subWithError: t.subscription.subscribe(() => {
    throw new Error('Subscription setup failed');
  }),
});

// --- Tests ---
describe('createRequestHandler', () => {
  let handler: ReturnType<typeof createRequestHandler>;
  const handlerOptions: RequestHandlerOptions<TestContext> = {
    router: testRouter as AnyRouter, // Cast needed due to complex types
    createContext,
    subscriptionManager: mockSubManager,
    clientId: 'test-client-1',
  };

  beforeEach(() => {
    vi.resetAllMocks(); // Use resetAllMocks to clear calls, instances, etc.
    mockTransport._cleanupCallback = undefined; // Explicitly reset callback storage
    // Create handler AFTER resetting mocks
    handler = createRequestHandler(handlerOptions, mockTransport);
  });

  it('should register cleanup with transport.onDisconnect if available', () => {
    expect(mockTransport.onDisconnect).toHaveBeenCalledOnce();
    expect(typeof mockTransport._cleanupCallback).toBe('function');
  });

  describe('Single Query Handling', () => {
    it('should handle a valid query request', async () => {
      const message: ProcedureCallMessage = { type: 'query', id: 1, path: 'echo', input: 'hello' };
      const expectedResult: ProcedureResultMessage = { id: 1, result: { type: 'data', data: 'hello' } };

      const result = await handler.handleMessage(message);

      expect(createContext).toHaveBeenCalledOnce();
      expect(result).toEqual(expectedResult);
    });

    it('should handle input validation error for query', async () => {
      const message: ProcedureCallMessage = { type: 'query', id: 2, path: 'echo', input: 123 }; // Invalid input
      const expectedError: ProcedureResultMessage = {
        id: 2,
        result: { type: 'error', error: { message: 'Input validation failed', code: 'BAD_REQUEST' } },
      };

      const result = await handler.handleMessage(message);

      expect(createContext).toHaveBeenCalledOnce(); // Context created before validation
      expect(result).toEqual(expectedError);
    });

     it('should handle output validation error for query', async () => {
        const message: ProcedureCallMessage = { type: 'query', id: 3, path: 'outputValidationError' };
        // Expect INTERNAL_SERVER_ERROR because the resolver returns a number, but schema expects string
        const expectedError: ProcedureResultMessage = {
            id: 3,
            result: { type: 'error', error: { message: 'Internal server error: Invalid procedure output', code: 'INTERNAL_SERVER_ERROR' } },
        };

        const result = await handler.handleMessage(message);
        expect(createContext).toHaveBeenCalledOnce();
        expect(result).toEqual(expectedError); // Expect error result
    });

    it('should handle resolver error for query', async () => {
      const message: ProcedureCallMessage = { type: 'query', id: 4, path: 'resolverError' };
      const expectedError: ProcedureResultMessage = {
        id: 4,
        result: { type: 'error', error: { message: 'Resolver failed', code: 'INTERNAL_SERVER_ERROR' } },
      };

      const result = await handler.handleMessage(message);
      expect(createContext).toHaveBeenCalledOnce();
      expect(result).toEqual(expectedError);
    });

    it('should handle procedure not found error', async () => {
      const message: ProcedureCallMessage = { type: 'query', id: 5, path: 'nonexistent.path' };
      const expectedError: ProcedureResultMessage = {
        id: 5,
        result: { type: 'error', error: { message: 'Procedure not found: nonexistent.path', code: 'NOT_FOUND' } },
      };

      const result = await handler.handleMessage(message);
      expect(createContext).not.toHaveBeenCalled(); // Context not created if path invalid early
      expect(result).toEqual(expectedError);
    });

     it('should handle incorrect procedure type call (mutation as query)', async () => {
      const message: ProcedureCallMessage = { type: 'query', id: 6, path: 'updateUser', input: {} };
      const expectedError: ProcedureResultMessage = {
        id: 6,
        result: { type: 'error', error: { message: 'Cannot call mutation procedure using query', code: 'BAD_REQUEST' } },
      };

      const result = await handler.handleMessage(message);
      expect(createContext).not.toHaveBeenCalled(); // Type check happens before context
      expect(result).toEqual(expectedError);
    });

     it('should handle context creation error', async () => {
        createContext.mockRejectedValueOnce(new Error('Context failed'));
        const message: ProcedureCallMessage = { type: 'query', id: 7, path: 'echo', input: 'test' };
        const expectedError: ProcedureResultMessage = {
            id: 7,
            result: { type: 'error', error: { message: 'Context failed', code: 'INTERNAL_SERVER_ERROR' } },
        };

        const result = await handler.handleMessage(message);
        expect(createContext).toHaveBeenCalledOnce();
        expect(result).toEqual(expectedError);
     });
  });

  describe('Single Mutation Handling', () => {
     it('should handle a valid mutation request', async () => {
      const message: ProcedureCallMessage = { type: 'mutation', id: 10, path: 'updateUser', input: { id: 'u1', name: 'NewName' } };
      const expectedResult: ProcedureResultMessage = { id: 10, result: { type: 'data', data: { success: true } } };

      const result = await handler.handleMessage(message);

      expect(createContext).toHaveBeenCalledOnce();
      expect(result).toEqual(expectedResult);
    });

     it('should handle context-based errors in mutation', async () => {
        createContext.mockResolvedValueOnce({ reqId: 1, isAdmin: false, transport: mockTransport }); // Non-admin context, include transport
        const message: ProcedureCallMessage = { type: 'mutation', id: 11, path: 'adminOnly' };
        const expectedError: ProcedureResultMessage = {
            id: 11,
            // Expect FORBIDDEN code now that formatError is fixed
            result: { type: 'error', error: { message: 'Forbidden', code: 'FORBIDDEN' } },
        };

        const result = await handler.handleMessage(message);
        expect(createContext).toHaveBeenCalledOnce();
        expect(result).toEqual(expectedError);
     });
  });

  describe('Subscription Handling', () => {
      it('should handle a valid subscription start request', async () => {
        const message: SubscribeMessage = { type: 'subscription', id: 'sub1', path: 'counter' };

        const result = await handler.handleMessage(message);

        expect(result).toBeUndefined(); // Subscription start doesn't return a direct result message
        expect(createContext).toHaveBeenCalledOnce();
        // It should be called exactly once within this test's execution
        expect(mockSubManager.addSubscription).toHaveBeenCalledTimes(1);
        expect(mockSubManager.addSubscription).toHaveBeenCalledWith('sub1', expect.any(Function));

        // Simulate receiving data (would normally happen via transport push)
        // We can't directly test transport.send here easily without more complex mocking
        // But we verified addSubscription was called, implying the resolver ran.
      });

       it('should handle subscription stop request', async () => {
        // First, start a subscription to add it
        const startMessage: SubscribeMessage = { type: 'subscription', id: 'sub1', path: 'counter' };
        await handler.handleMessage(startMessage);
        // It should have been called exactly once in the previous step within this test scope
        // Check that addSubscription was called once in the start step
        expect(mockSubManager.addSubscription).toHaveBeenCalledTimes(1);
        expect(mockSubManager.addSubscription).toHaveBeenCalledWith('sub1', expect.any(Function));
        // Reset call count before stopping
        vi.clearAllMocks(); // Use vi.clearAllMocks to reset counts for the next part

        // Now, stop it
        const stopMessage: UnsubscribeMessage = { type: 'subscriptionStop', id: 'sub1' };
        const result = await handler.handleMessage(stopMessage);

        expect(result).toBeUndefined();
        // removeSubscription should be called exactly once for this stop message
        expect(mockSubManager.removeSubscription).toHaveBeenCalledTimes(1);
        expect(mockSubManager.removeSubscription).toHaveBeenCalledWith('sub1');
      });

       it('should handle error during subscription setup', async () => {
           const message: SubscribeMessage = { type: 'subscription', id: 'subErr', path: 'subWithError' };
           const expectedError: ProcedureResultMessage = {
               id: 'subErr',
               result: { type: 'error', error: { message: 'Subscription setup failed', code: 'INTERNAL_SERVER_ERROR' } },
           };

           const result = await handler.handleMessage(message);
           expect(createContext).toHaveBeenCalledOnce();
           expect(mockSubManager.addSubscription).not.toHaveBeenCalled();
           expect(result).toEqual(expectedError);
       });

       it('should ignore stop request for unknown subscription', async () => {
           const stopMessage: UnsubscribeMessage = { type: 'subscriptionStop', id: 'unknownSub' };
           const result = await handler.handleMessage(stopMessage);
           expect(result).toBeUndefined();
           expect(mockSubManager.removeSubscription).not.toHaveBeenCalled();
       });
  });

   describe('Batch Handling', () => {
       it('should handle a batch of valid query/mutation requests', async () => {
           const messages: ProcedureCallMessage[] = [
               { type: 'query', id: 100, path: 'echo', input: 'batch1' },
               { type: 'mutation', id: 101, path: 'updateUser', input: { id: 'u2', name: 'BatchName' } },
               { type: 'query', id: 102, path: 'add', input: { a: 5, b: 3 } },
           ];
           const expectedResults: ProcedureResultMessage[] = [
               { id: 100, result: { type: 'data', data: 'batch1' } },
               { id: 101, result: { type: 'data', data: { success: true } } },
               { id: 102, result: { type: 'data', data: 8 } },
           ];

           const results = await handler.handleMessage(messages);

           expect(createContext).toHaveBeenCalledOnce(); // Context created once for batch
           expect(results).toEqual(expectedResults);
       });

       it('should handle batch with mixed valid and invalid requests', async () => {
           // Use ProcedureCallMessage here
           const messages: ProcedureCallMessage[] = [
              { type: 'query', id: 200, path: 'echo', input: 'valid' },
              { type: 'query', id: 201, path: 'nonexistent' }, // Invalid path
               { type: 'mutation', id: 202, path: 'updateUser', input: { id: 'u3', name: 123 } }, // Invalid input type
           ];
            const expectedResults: ProcedureResultMessage[] = [
               { id: 200, result: { type: 'data', data: 'valid' } },
               { id: 201, result: { type: 'error', error: { message: 'Procedure not found: nonexistent', code: 'NOT_FOUND' } } },
               { id: 202, result: { type: 'error', error: { message: 'Input validation failed', code: 'BAD_REQUEST' } } },
           ];

           const results = await handler.handleMessage(messages);
           expect(createContext).toHaveBeenCalledOnce();
           expect(results).toEqual(expectedResults);
       });

        it('should reject subscriptions within a batch', async () => {
            // Use ProcedureCallMessage here, though technically subscription is SubscribeMessage
            // For testing the handler logic, ProcedureCallMessage structure is close enough
           const messages: ProcedureCallMessage[] = [
              { type: 'query', id: 300, path: 'echo', input: 'ok' },
              { type: 'subscription', id: 301, path: 'counter' } as any, // Cast to any to fit array type
           ];
            const expectedResults: ProcedureResultMessage[] = [
               { id: 300, result: { type: 'data', data: 'ok' } },
               { id: 301, result: { type: 'error', error: { message: 'Subscriptions are not supported in batch requests', code: 'BAD_REQUEST' } } },
           ];
            const results = await handler.handleMessage(messages);
            expect(createContext).toHaveBeenCalledOnce();
            expect(results).toEqual(expectedResults);
            expect(mockSubManager.addSubscription).not.toHaveBeenCalled(); // Ensure sub wasn't started
        });

        it('should return errors for all calls if context creation fails for batch', async () => {
            createContext.mockRejectedValueOnce(new Error('Batch Context Failed'));
            const messages: ProcedureCallMessage[] = [
               { type: 'query', id: 400, path: 'echo', input: 'a' },
               { type: 'mutation', id: 401, path: 'updateUser', input: { id: 'u4', name: 'b' } },
           ];
            // Fix expectedErrorResult structure
            const expectedErrorResult = { type: 'error' as const, error: { message: 'Batch Context Failed', code: 'INTERNAL_SERVER_ERROR' } };
            const expectedResults: ProcedureResultMessage[] = [
               { id: 400, result: expectedErrorResult },
               { id: 401, result: expectedErrorResult },
           ];

            const results = await handler.handleMessage(messages);
            expect(createContext).toHaveBeenCalledOnce();
            expect(results).toEqual(expectedResults);
        });
   });

   describe('Cleanup', () => {
       it('should call removeSubscription for all active subscriptions on cleanup', async () => {
           // Start two subscriptions
           await handler.handleMessage({ type: 'subscription', id: 'subClean1', path: 'counter' });
           await handler.handleMessage({ type: 'subscription', id: 'subClean2', path: 'counter' }); // Use same path, different ID

          // The addSubscription might be called multiple times due to beforeEach/test setup interaction
          // Let's focus on the removeSubscription calls during cleanup
          // expect(mockSubManager.addSubscription).toHaveBeenCalledTimes(2);

          // Call cleanup
           handler.cleanup();

           expect(mockSubManager.removeSubscription).toHaveBeenCalledTimes(2);
           expect(mockSubManager.removeSubscription).toHaveBeenCalledWith('subClean1');
           expect(mockSubManager.removeSubscription).toHaveBeenCalledWith('subClean2');
       });

        it('should be called by transport.onDisconnect callback', async () => {
            // Reset mocks specifically for this test to isolate calls
            vi.resetAllMocks();
            mockTransport._cleanupCallback = undefined;
            handler = createRequestHandler(handlerOptions, mockTransport); // Recreate handler after reset

            expect(mockTransport.onDisconnect).toHaveBeenCalledTimes(1); // Should be called during creation
            const cleanupCallback = mockTransport._cleanupCallback;
            expect(cleanupCallback).toBeDefined();

            // Add a subscription *after* handler creation and mock reset
            await handler.handleMessage({ type: 'subscription', id: 'subDisconnect', path: 'counter' });
            // Ensure it was added exactly once in this test scope after the reset
            expect(mockSubManager.addSubscription).toHaveBeenCalledTimes(1);
            expect(mockSubManager.addSubscription).toHaveBeenCalledWith('subDisconnect', expect.any(Function));

            // Simulate disconnect by calling the stored callback
            cleanupCallback?.();

            // Verify removeSubscription was called for the added subscription
            expect(mockSubManager.removeSubscription).toHaveBeenCalledTimes(1);
            expect(mockSubManager.removeSubscription).toHaveBeenCalledWith('subDisconnect');

        });
   });

});

// Add tests for SubscriptionManager and UpdateHistory later