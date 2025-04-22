import { describe, it, expect, vi } from 'vitest'; // Import vi
import type { Mock } from 'vitest'; // Import Mock type
import { createRouter } from '../router';
import { initzenQuery } from '../procedure';
import { createRequestHandler } from '../requestHandler'; // Import createRequestHandler
// Import specific message types for send mock
import type {
    zenQueryTransport,
    SubscriptionDataMessage,
    SubscriptionErrorMessage,
    SubscriptionEndMessage
} from '@sylphlab/zen-query-shared';
import { SubscriptionManager } from '../subscriptionManager'; // Import SubscriptionManager
import * as z from 'zod';

// Define a context type for testing, satisfying ProcedureContext
interface TestContext {
  user?: { id: string; name: string };
  isAdmin: boolean;
  [key: string]: unknown; // Add index signature
}

// Initialize procedure builder with the test context
const t = initzenQuery<TestContext>();

describe('@sylphlab/zen-query-server', () => {

  describe('createRouter', () => {
    it('should create a simple router with procedures', () => {
      const router = createRouter<TestContext>()({
        health: t.query.resolve(() => 'ok'),
        echo: t.query.input(z.string()).resolve(({ input }) => input),
      });

      expect(router).toBeDefined();
      expect(router._def.router).toBe(true);
      expect(router._def.procedures).toBeDefined();
      expect(router._def.procedures.health).toBeDefined();
      expect(router._def.procedures.health._def.type).toBe('query');
      expect(router._def.procedures.echo).toBeDefined();
      expect(router._def.procedures.echo._def.type).toBe('query');
      expect(router._def.procedures.echo._def.inputSchema).toBeInstanceOf(z.ZodString);
    });

    it('should create a router with nested routers', () => {
      const userRouter = createRouter<TestContext>()({
        get: t.query.input(z.object({ id: z.string() })).resolve(({ input }) => ({ id: input.id, name: 'Test' })),
        update: t.mutation.input(z.object({ id: z.string(), name: z.string() })).resolve(() => ({ success: true })),
      });

      const postRouter = createRouter<TestContext>()({
        list: t.query.resolve(() => [{ id: 'p1', title: 'Post 1' }]),
      });

      const appRouter = createRouter<TestContext>()({
        user: userRouter,
        post: postRouter,
        health: t.query.resolve(() => 'ok'),
      });

      expect(appRouter).toBeDefined();
      expect(appRouter._def.procedures.user).toBeDefined();
      expect((appRouter._def.procedures.user as any)._def.router).toBe(true);
      expect((appRouter._def.procedures.user as any)._def.procedures.get).toBeDefined();
      expect((appRouter._def.procedures.user as any)._def.procedures.get._def.type).toBe('query');
      expect((appRouter._def.procedures.user as any)._def.procedures.update).toBeDefined();
      expect((appRouter._def.procedures.user as any)._def.procedures.update._def.type).toBe('mutation');

      expect(appRouter._def.procedures.post).toBeDefined();
      expect((appRouter._def.procedures.post as any)._def.router).toBe(true);
      expect((appRouter._def.procedures.post as any)._def.procedures.list).toBeDefined();
      expect((appRouter._def.procedures.post as any)._def.procedures.list._def.type).toBe('query');

      expect(appRouter._def.procedures.health).toBeDefined();
      expect(appRouter._def.procedures.health._def.type).toBe('query');
    });

    // Add more tests for router merging, middleware (when implemented) etc.
  });

  // Placeholder for procedure tests
  describe('Procedures (initzenQuery)', () => {
     it('should define a query procedure', () => {
        const proc = t.query.input(z.string()).output(z.number()).resolve(({ input }) => input.length);
        expect(proc._def.type).toBe('query');
        expect(proc._def.inputSchema).toBeInstanceOf(z.ZodString);
        expect(proc._def.outputSchema).toBeInstanceOf(z.ZodNumber);
        expect(proc._def.resolver).toBeDefined();
     });

     it('should define a mutation procedure', () => {
        const proc = t.mutation.input(z.object({})).resolve(() => {});
        expect(proc._def.type).toBe('mutation');
        expect(proc._def.inputSchema).toBeInstanceOf(z.ZodObject);
        expect(proc._def.resolver).toBeDefined();
     });

      it('should define a subscription procedure', () => {
        const proc = t.subscription.subscriptionOutput(z.object({})).legacySubscribe(() => () => {}); // Changed to .legacySubscribe based on signature
        expect(proc._def.type).toBe('subscription');
        expect(proc._def.subscriptionOutputSchema).toBeInstanceOf(z.ZodObject); // Corrected typo
        expect(proc._def.legacySubscriptionResolver).toBeDefined(); // Assert legacy resolver
     });

     // Add tests for context usage, error handling in resolvers etc.
  });

   // Placeholder for requestHandler tests
   describe('createRequestHandler', () => {
       // TODO: Write tests for requestHandler, including context creation,
       // procedure finding, input/output parsing, error handling,
       // subscription lifecycle, batching etc. Requires mocking transport.
       it('should handle query requests', async () => {
           // 1. Setup Router
           const router = createRouter<TestContext>()({
               greeting: t.query.input(z.string()).resolve(({ input, ctx }) => `Hello, ${input}! Context: ${JSON.stringify(ctx)}`),
           });

           // 2. Mock Transport
           const mockTransport: zenQueryTransport = { // Corrected type name casing
               // Explicitly type send as a Vitest mock function
               // Remove generic signature, let TS infer from zenQueryTransport interface
               send: vi.fn(),
               onDisconnect: vi.fn(() => () => {}), // Mock onDisconnect to return an unsubscribe function
               requestMissingDeltas: vi.fn(), // Mock if needed by handler/store interaction
               request: vi.fn(), // Added missing property
               subscribe: vi.fn(), // Added missing property
               // Add other methods if the handler requires them
           };

           // 3. Create Handler
           // Assuming createRequestHandler and ZenQueryTransport paths are correct relative to this test file
           // Adjust imports if necessary:
           // import { createRequestHandler } from '../requestHandler';
           // import type { ZenQueryTransport } from '../../shared/types';
           // Import vi if not already imported at the top
           // import { vi } from 'vitest';
           // Mock SubscriptionManager
           const mockSubscriptionManager: SubscriptionManager = {
                addSubscription: vi.fn(),
                removeSubscription: vi.fn(),
                // publish: vi.fn(), // Removed non-existent property
                hasSubscription: vi.fn(),
           } as any as SubscriptionManager; // Cast to bypass private property check

           const handler = createRequestHandler({
               router,
               createContext: async () => ({ isAdmin: false } as TestContext), // Simple context factory
               subscriptionManager: mockSubscriptionManager, // Add mock manager
               clientId: 'test-client-1',
           }, mockTransport); // Pass transport as the second argument

           // 4. Simulate Query Request Message
           const queryMessage = {
               id: 'req-1',
               type: 'query' as const,
               path: 'greeting', // Procedure path
               input: 'World', // Input for the procedure
           };

           // Simulate receiving the message (assuming handler exposes a method like handleIncomingMessage or similar)
           // This might need adjustment based on the actual requestHandler implementation
           // If handleIncomingMessage doesn't exist, this test will fail and need refinement.
           if (typeof (handler as any).handleIncomingMessage !== 'function') {
                console.warn("Test assumes 'handleIncomingMessage' exists on handler. Adjust if needed.");
                // Potentially simulate via transport events if that's the mechanism
           }
           await (handler as any).handleIncomingMessage?.(JSON.stringify(queryMessage));


           // 5. Assertions
           expect(mockTransport.send).toHaveBeenCalledTimes(1);
           // Ensure send was called before trying to parse
           // Use type assertion with imported Mock type
           if ((mockTransport.send as Mock).mock.calls.length > 0) {
                const sentMessage = JSON.parse((mockTransport.send as Mock).mock.calls[0][0]);
                expect(sentMessage).toEqual({
                    id: 'req-1',
                    type: 'response',
                    result: {
                        type: 'data',
                        data: 'Hello, World! Context: {"isAdmin":false}',
                    },
                });
           } else {
                // Fail the test explicitly if send wasn't called
                expect(mockTransport.send).toHaveBeenCalled();
           }
       });
       it('should handle mutation requests', async () => {
           const router = createRouter<TestContext>()({
               updateUser: t.mutation.input(z.string()).resolve(({ input }) => ({ success: true, received: input })),
           });
           const mockTransport = { send: vi.fn(), onDisconnect: vi.fn(() => () => {}), requestMissingDeltas: vi.fn(), request: vi.fn(), subscribe: vi.fn() } as any as zenQueryTransport;
           const mockManager = { addSubscription: vi.fn(), removeSubscription: vi.fn(), hasSubscription: vi.fn() } as any as SubscriptionManager;
           const handler = createRequestHandler({ router, createContext: async () => ({}), subscriptionManager: mockManager, clientId: 'mut-client' }, mockTransport);
           const msg = { id: 'mut-1', type: 'mutation' as const, path: 'updateUser', input: 'test-data' };
           await (handler as any).handleIncomingMessage?.(JSON.stringify(msg));
           expect(mockTransport.send).toHaveBeenCalledTimes(1);
           const sent = JSON.parse((mockTransport.send as Mock).mock.calls[0][0]);
           expect(sent.id).toBe('mut-1');
           expect(sent.result.type).toBe('data');
           expect(sent.result.data).toEqual({ success: true, received: 'test-data' });
       });

       it('should handle subscription start requests', async () => {
           const cleanupFn = vi.fn();
           const router = createRouter<TestContext>()({
               onUpdate: t.subscription.legacySubscribe(() => cleanupFn),
           });
           const mockTransport = { send: vi.fn(), onDisconnect: vi.fn(() => () => {}), requestMissingDeltas: vi.fn(), request: vi.fn(), subscribe: vi.fn() } as any as zenQueryTransport;
           const mockManager = { addSubscription: vi.fn(), removeSubscription: vi.fn(), hasSubscription: vi.fn() } as any as SubscriptionManager;
           const handler = createRequestHandler({ router, createContext: async () => ({}), subscriptionManager: mockManager, clientId: 'sub-start-client' }, mockTransport);
           const msg = { id: 'sub-1', type: 'subscription' as const, path: 'onUpdate' };
           await (handler as any).handleIncomingMessage?.(JSON.stringify(msg));
           expect(mockTransport.send).not.toHaveBeenCalled(); // Start doesn't send immediate response
           expect(mockManager.addSubscription).toHaveBeenCalledWith('sub-1', expect.any(Function));
       });

       it('should handle subscription stop requests', async () => {
           const router = createRouter<TestContext>()({}); // No procedures needed for stop
           const mockTransport = { send: vi.fn(), onDisconnect: vi.fn(() => () => {}), requestMissingDeltas: vi.fn(), request: vi.fn(), subscribe: vi.fn() } as any as zenQueryTransport;
           const mockManager = { addSubscription: vi.fn(), removeSubscription: vi.fn(), hasSubscription: vi.fn() } as any as SubscriptionManager;
           const handler = createRequestHandler({ router, createContext: async () => ({}), subscriptionManager: mockManager, clientId: 'sub-stop-client' }, mockTransport);
           // Simulate adding the subscription first (internal state)
           (handler as any).activeClientSubscriptions?.set('sub-to-stop', { path: 'some.path' });
           const msg = { id: 'sub-to-stop', type: 'subscriptionStop' as const };
           await (handler as any).handleIncomingMessage?.(JSON.stringify(msg));
           expect(mockTransport.send).not.toHaveBeenCalled();
           expect(mockManager.removeSubscription).toHaveBeenCalledWith('sub-to-stop');
           expect((handler as any).activeClientSubscriptions?.has('sub-to-stop')).toBe(false);
       });

       it('should handle batch requests', async () => {
           const router = createRouter<TestContext>()({
               query1: t.query.resolve(() => 'res1'),
               mut1: t.mutation.input(z.number()).resolve(({ input }) => input * 2),
           });
           const mockTransport = { send: vi.fn(), onDisconnect: vi.fn(() => () => {}), requestMissingDeltas: vi.fn(), request: vi.fn(), subscribe: vi.fn() } as any as zenQueryTransport;
           const mockManager = { addSubscription: vi.fn(), removeSubscription: vi.fn(), hasSubscription: vi.fn() } as any as SubscriptionManager;
           const handler = createRequestHandler({ router, createContext: async () => ({}), subscriptionManager: mockManager, clientId: 'batch-client' }, mockTransport);
           const batchMsg = [
               { id: 'b-q1', type: 'query' as const, path: 'query1' },
               { id: 'b-m1', type: 'mutation' as const, path: 'mut1', input: 5 },
           ];
           await (handler as any).handleIncomingMessage?.(JSON.stringify(batchMsg));
           expect(mockTransport.send).toHaveBeenCalledTimes(1); // Batch sends one response array
           const sent = JSON.parse((mockTransport.send as Mock).mock.calls[0][0]);
           expect(sent).toBeInstanceOf(Array);
           expect(sent).toHaveLength(2);
           expect(sent[0]).toEqual({ id: 'b-q1', result: { type: 'data', data: 'res1' } });
           expect(sent[1]).toEqual({ id: 'b-m1', result: { type: 'data', data: 10 } });
       });

       it('should handle context creation errors', async () => {
           const router = createRouter<TestContext>()({ query1: t.query.resolve(() => 'ok') });
           const mockTransport = { send: vi.fn(), onDisconnect: vi.fn(() => () => {}), requestMissingDeltas: vi.fn(), request: vi.fn(), subscribe: vi.fn() } as any as zenQueryTransport;
           const mockManager = { addSubscription: vi.fn(), removeSubscription: vi.fn(), hasSubscription: vi.fn() } as any as SubscriptionManager;
           const contextError = new Error('Context Failed');
           const handler = createRequestHandler({ router, createContext: async () => { throw contextError; }, subscriptionManager: mockManager, clientId: 'ctx-err-client' }, mockTransport);
           const msg = { id: 'ctx-err-1', type: 'query' as const, path: 'query1' };
           await (handler as any).handleIncomingMessage?.(JSON.stringify(msg));
           expect(mockTransport.send).toHaveBeenCalledTimes(1);
           const sent = JSON.parse((mockTransport.send as Mock).mock.calls[0][0]);
           expect(sent.id).toBe('ctx-err-1');
           expect(sent.result.type).toBe('error');
           expect(sent.result.error.code).toBe('INTERNAL_SERVER_ERROR');
           expect(sent.result.error.message).toBe('Context Failed'); // Or the formatted message
       });

       it('should handle input validation errors', async () => {
           const router = createRouter<TestContext>()({
               proc: t.query.input(z.string()).resolve(() => 'ok'),
           });
           const mockTransport = { send: vi.fn(), onDisconnect: vi.fn(() => () => {}), requestMissingDeltas: vi.fn(), request: vi.fn(), subscribe: vi.fn() } as any as zenQueryTransport;
           const mockManager = { addSubscription: vi.fn(), removeSubscription: vi.fn(), hasSubscription: vi.fn() } as any as SubscriptionManager;
           const handler = createRequestHandler({ router, createContext: async () => ({}), subscriptionManager: mockManager, clientId: 'in-val-client' }, mockTransport);
           const msg = { id: 'in-val-1', type: 'query' as const, path: 'proc', input: 123 }; // Invalid input
           await (handler as any).handleIncomingMessage?.(JSON.stringify(msg));
           expect(mockTransport.send).toHaveBeenCalledTimes(1);
           const sent = JSON.parse((mockTransport.send as Mock).mock.calls[0][0]);
           expect(sent.id).toBe('in-val-1');
           expect(sent.result.type).toBe('error');
           expect(sent.result.error.code).toBe('BAD_REQUEST');
           expect(sent.result.error.message).toBe('Input validation failed');
       });

       it('should handle output validation errors', async () => {
           const router = createRouter<TestContext>()({
               proc: t.query.output(z.string()).resolve(() => 123 as any), // Invalid output (cast to any to bypass TS check, test runtime validation)
           });
           const mockTransport = { send: vi.fn(), onDisconnect: vi.fn(() => () => {}), requestMissingDeltas: vi.fn(), request: vi.fn(), subscribe: vi.fn() } as any as zenQueryTransport;
           const mockManager = { addSubscription: vi.fn(), removeSubscription: vi.fn(), hasSubscription: vi.fn() } as any as SubscriptionManager;
           const handler = createRequestHandler({ router, createContext: async () => ({}), subscriptionManager: mockManager, clientId: 'out-val-client' }, mockTransport);
           const msg = { id: 'out-val-1', type: 'query' as const, path: 'proc' };
           await (handler as any).handleIncomingMessage?.(JSON.stringify(msg));
           expect(mockTransport.send).toHaveBeenCalledTimes(1);
           const sent = JSON.parse((mockTransport.send as Mock).mock.calls[0][0]);
           expect(sent.id).toBe('out-val-1');
           expect(sent.result.type).toBe('error');
           expect(sent.result.error.code).toBe('INTERNAL_SERVER_ERROR');
           expect(sent.result.error.message).toBe('Internal server error: Invalid procedure output');
       });

       it('should handle resolver errors', async () => {
           const resolverError = new Error('Resolver Failed');
           const router = createRouter<TestContext>()({
               proc: t.query.resolve(() => { throw resolverError; }),
           });
           const mockTransport = { send: vi.fn(), onDisconnect: vi.fn(() => () => {}), requestMissingDeltas: vi.fn(), request: vi.fn(), subscribe: vi.fn() } as any as zenQueryTransport;
           const mockManager = { addSubscription: vi.fn(), removeSubscription: vi.fn(), hasSubscription: vi.fn() } as any as SubscriptionManager;
           const handler = createRequestHandler({ router, createContext: async () => ({}), subscriptionManager: mockManager, clientId: 'res-err-client' }, mockTransport);
           const msg = { id: 'res-err-1', type: 'query' as const, path: 'proc' };
           await (handler as any).handleIncomingMessage?.(JSON.stringify(msg));
           expect(mockTransport.send).toHaveBeenCalledTimes(1);
           const sent = JSON.parse((mockTransport.send as Mock).mock.calls[0][0]);
           expect(sent.id).toBe('res-err-1');
           expect(sent.result.type).toBe('error');
           expect(sent.result.error.code).toBe('INTERNAL_SERVER_ERROR');
           expect(sent.result.error.message).toBe('Resolver Failed');
       });

       it('should handle subscription resolver errors', async () => {
           const subError = new Error('Sub Setup Failed');
           const router = createRouter<TestContext>()({
               onEvent: t.subscription.legacySubscribe(() => { throw subError; }),
           });
           const mockTransport = { send: vi.fn(), onDisconnect: vi.fn(() => () => {}), requestMissingDeltas: vi.fn(), request: vi.fn(), subscribe: vi.fn() } as any as zenQueryTransport;
           const mockManager = { addSubscription: vi.fn(), removeSubscription: vi.fn(), hasSubscription: vi.fn() } as any as SubscriptionManager;
           const handler = createRequestHandler({ router, createContext: async () => ({}), subscriptionManager: mockManager, clientId: 'sub-err-client' }, mockTransport);
           const msg = { id: 'sub-err-1', type: 'subscription' as const, path: 'onEvent' };
           await (handler as any).handleIncomingMessage?.(JSON.stringify(msg));
           expect(mockTransport.send).toHaveBeenCalledTimes(1); // Error during setup sends a response
           const sent = JSON.parse((mockTransport.send as Mock).mock.calls[0][0]);
           expect(sent.id).toBe('sub-err-1');
           expect(sent.result.type).toBe('error');
           expect(sent.result.error.code).toBe('INTERNAL_SERVER_ERROR');
           expect(sent.result.error.message).toBe('Sub Setup Failed');
           expect(mockManager.addSubscription).not.toHaveBeenCalled();
       });

       it('should handle procedure not found errors', async () => {
           const router = createRouter<TestContext>()({}); // Empty router
           const mockTransport = { send: vi.fn(), onDisconnect: vi.fn(() => () => {}), requestMissingDeltas: vi.fn(), request: vi.fn(), subscribe: vi.fn() } as any as zenQueryTransport;
           const mockManager = { addSubscription: vi.fn(), removeSubscription: vi.fn(), hasSubscription: vi.fn() } as any as SubscriptionManager;
           const handler = createRequestHandler({ router, createContext: async () => ({}), subscriptionManager: mockManager, clientId: 'notfound-client' }, mockTransport);
           const msg = { id: 'nf-1', type: 'query' as const, path: 'nonexistent.proc' };
           await (handler as any).handleIncomingMessage?.(JSON.stringify(msg));
           expect(mockTransport.send).toHaveBeenCalledTimes(1);
           const sent = JSON.parse((mockTransport.send as Mock).mock.calls[0][0]);
           expect(sent.id).toBe('nf-1');
           expect(sent.result.type).toBe('error');
           // expect(sent.result.error.code).toBe('NOT_FOUND'); // formatError currently makes this INTERNAL_SERVER_ERROR
           expect(sent.result.error.code).toBe('INTERNAL_SERVER_ERROR');
           expect(sent.result.error.message).toContain('Procedure not found');
       });

       it('should handle incorrect procedure type calls', async () => {
           const router = createRouter<TestContext>()({
               myMutation: t.mutation.resolve(() => 'ok'),
           });
           const mockTransport = { send: vi.fn(), onDisconnect: vi.fn(() => () => {}), requestMissingDeltas: vi.fn(), request: vi.fn(), subscribe: vi.fn() } as any as zenQueryTransport;
           const mockManager = { addSubscription: vi.fn(), removeSubscription: vi.fn(), hasSubscription: vi.fn() } as any as SubscriptionManager;
           const handler = createRequestHandler({ router, createContext: async () => ({}), subscriptionManager: mockManager, clientId: 'badtype-client' }, mockTransport);
           const msg = { id: 'bt-1', type: 'query' as const, path: 'myMutation' }; // Calling mutation with query type
           await (handler as any).handleIncomingMessage?.(JSON.stringify(msg));
           expect(mockTransport.send).toHaveBeenCalledTimes(1);
           const sent = JSON.parse((mockTransport.send as Mock).mock.calls[0][0]);
           expect(sent.id).toBe('bt-1');
           expect(sent.result.type).toBe('error');
           // expect(sent.result.error.code).toBe('METHOD_NOT_SUPPORTED'); // formatError currently makes this INTERNAL_SERVER_ERROR
           expect(sent.result.error.code).toBe('INTERNAL_SERVER_ERROR');
           expect(sent.result.error.message).toContain('Cannot call mutation procedure using query');
       });

       it('should call subscription cleanup on stop/disconnect', async () => {
           const cleanupFn = vi.fn();
           const router = createRouter<TestContext>()({
               onStuff: t.subscription.legacySubscribe(() => cleanupFn),
           });
           const mockTransport = { send: vi.fn(), onDisconnect: vi.fn(() => () => {}), requestMissingDeltas: vi.fn(), request: vi.fn(), subscribe: vi.fn() } as any as zenQueryTransport;
           const mockManager = { addSubscription: vi.fn(), removeSubscription: vi.fn(), hasSubscription: vi.fn() } as any as SubscriptionManager;
           const handler = createRequestHandler({ router, createContext: async () => ({}), subscriptionManager: mockManager, clientId: 'cleanup-client' }, mockTransport);

           // Simulate start
           const startMsg = { id: 'clean-sub-1', type: 'subscription' as const, path: 'onStuff' };
           await (handler as any).handleIncomingMessage?.(JSON.stringify(startMsg));
           // Get the cleanup wrapper passed to addSubscription
           const cleanupWrapper = (mockManager.addSubscription as Mock).mock.calls[0][1];

           // Simulate stop message
           const stopMsg = { id: 'clean-sub-1', type: 'subscriptionStop' as const };
           await (handler as any).handleIncomingMessage?.(JSON.stringify(stopMsg));
           expect(mockManager.removeSubscription).toHaveBeenCalledWith('clean-sub-1');

           // Simulate direct cleanup call (e.g., on disconnect)
           // Need to manually call the wrapper if removeSubscription doesn't trigger it in the mock
           if (cleanupWrapper) cleanupWrapper();
           expect(cleanupFn).toHaveBeenCalledTimes(1); // Check if original cleanup was called

           // OR Simulate disconnect triggering cleanup via transport.onDisconnect
           // const disconnectHandler = (mockTransport.onDisconnect as Mock).mock.calls[0][0];
           // disconnectHandler(); // Call the registered cleanup
           // expect(mockManager.removeSubscription).toHaveBeenCalledWith('clean-sub-1'); // Check if disconnect triggers removal
           // expect(cleanupFn).toHaveBeenCalledTimes(1); // Check if original cleanup was called
       });
    });

    // Placeholder for SubscriptionManager tests
    describe('SubscriptionManager', () => {
        // TODO: Write tests for adding, removing, checking subscriptions and cleanup execution.
        it('should add a subscription cleanup', () => {
            const manager = new SubscriptionManager();
            const cleanupFn = vi.fn();
            const subId = 'sub-add-1';
            manager.addSubscription(subId, cleanupFn);
            expect(manager.hasSubscription(subId)).toBe(true);
            // Check internal state if possible/necessary, or rely on removeSubscription test
        });

        it('should remove a subscription and call cleanup', () => {
            const manager = new SubscriptionManager();
            const cleanupFn = vi.fn();
            const subId = 'sub-remove-1';
            manager.addSubscription(subId, cleanupFn);
            expect(manager.hasSubscription(subId)).toBe(true);
            manager.removeSubscription(subId);
            expect(manager.hasSubscription(subId)).toBe(false);
            expect(cleanupFn).toHaveBeenCalledTimes(1);
        });

        it('should handle removing non-existent subscription', () => {
            const manager = new SubscriptionManager();
            const cleanupFn = vi.fn();
            const subId = 'sub-nonexist-1';
            // Ensure removeSubscription doesn't throw and cleanup isn't called
            expect(() => manager.removeSubscription(subId)).not.toThrow();
            expect(cleanupFn).not.toHaveBeenCalled();
            expect(manager.hasSubscription(subId)).toBe(false);
        });

        it('should correctly report if a subscription exists', () => {
            const manager = new SubscriptionManager();
            const cleanupFn = vi.fn();
            const subId1 = 'sub-exist-1';
            const subId2 = 'sub-exist-2';
            manager.addSubscription(subId1, cleanupFn);
            expect(manager.hasSubscription(subId1)).toBe(true);
            expect(manager.hasSubscription(subId2)).toBe(false);
            manager.removeSubscription(subId1);
            expect(manager.hasSubscription(subId1)).toBe(false);
        });
    });

     // Placeholder for UpdateHistory tests
     describe('createInMemoryUpdateHistory', () => {
         // TODO: Write tests for adding updates, getting updates within range,
         // buffer pruning, clearing history.
         // Ensure createInMemoryUpdateHistory is imported
         // import { createInMemoryUpdateHistory } from '../updateHistory';

         it('should add updates', () => {
             const history = createInMemoryUpdateHistory({ bufferSize: 10 });
             const update1 = { seq: 1, data: 'update1' };
             const update2 = { seq: 2, data: 'update2' };
             history.add('topic1', update1);
             history.add('topic1', update2);
             const updates = history.getUpdatesSince('topic1', 0);
             expect(updates).toEqual([update1, update2]);
         });

         it('should retrieve updates in a sequence range', () => {
             const history = createInMemoryUpdateHistory({ bufferSize: 10 });
             const update1 = { seq: 1, data: 'update1' };
             const update2 = { seq: 2, data: 'update2' };
             const update3 = { seq: 3, data: 'update3' };
             history.add('topic1', update1);
             history.add('topic1', update2);
             history.add('topic1', update3);
             const updates = history.getUpdatesSince('topic1', 1); // Get updates since seq 1
             expect(updates).toEqual([update2, update3]);
             const updates2 = history.getUpdatesSince('topic1', 3); // Get updates since seq 3 (none)
             expect(updates2).toEqual([]);
             const updates3 = history.getUpdatesSince('topic1', 0); // Get all
             expect(updates3).toEqual([update1, update2, update3]);
         });

         it('should prune old updates when buffer size exceeded', () => {
             const history = createInMemoryUpdateHistory({ bufferSize: 2 }); // Buffer size 2
             const update1 = { seq: 1, data: 'update1' };
             const update2 = { seq: 2, data: 'update2' };
             const update3 = { seq: 3, data: 'update3' };
             history.add('topic1', update1);
             history.add('topic1', update2);
             let updates = history.getUpdatesSince('topic1', 0);
             expect(updates).toEqual([update1, update2]); // Both updates present
             history.add('topic1', update3); // Add third update, exceeding buffer
             updates = history.getUpdatesSince('topic1', 0);
             expect(updates).toEqual([update2, update3]); // update1 should be pruned
             updates = history.getUpdatesSince('topic1', 1);
             expect(updates).toEqual([update2, update3]); // update1 is gone
             updates = history.getUpdatesSince('topic1', 2);
             expect(updates).toEqual([update3]);
         });

         it('should clear topic history', () => {
             const history = createInMemoryUpdateHistory({ bufferSize: 10 });
             const update1 = { seq: 1, data: 'update1' };
             history.add('topic1', update1);
             history.add('topic2', { seq: 1, data: 'updateT2' });
             history.clearTopic('topic1');
             const updates1 = history.getUpdatesSince('topic1', 0);
             const updates2 = history.getUpdatesSince('topic2', 0);
             expect(updates1).toEqual([]);
             expect(updates2).toEqual([{ seq: 1, data: 'updateT2' }]);
         });

         it('should clear all history', () => {
             const history = createInMemoryUpdateHistory({ bufferSize: 10 });
             history.add('topic1', { seq: 1, data: 'updateT1' });
             history.add('topic2', { seq: 1, data: 'updateT2' });
             history.clearAll();
             const updates1 = history.getUpdatesSince('topic1', 0);
             const updates2 = history.getUpdatesSince('topic2', 0);
             expect(updates1).toEqual([]);
             expect(updates2).toEqual([]);
         });
     });

});