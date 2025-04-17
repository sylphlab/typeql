import { describe, it, expect } from 'vitest';
import { createRouter } from '../router';
import { initTypeQL } from '../procedure';
import * as z from 'zod';

// Define a context type for testing, satisfying ProcedureContext
interface TestContext {
  user?: { id: string; name: string };
  isAdmin: boolean;
  [key: string]: unknown; // Add index signature
}

// Initialize procedure builder with the test context
const t = initTypeQL<TestContext>();

describe('@sylph/typeql-server', () => {

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
  describe('Procedures (initTypeQL)', () => {
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
        const proc = t.subscription.subscriptionOutput(z.object({})).subscribe(() => () => {});
        expect(proc._def.type).toBe('subscription');
        expect(proc._def.subscriptionOutputSchema).toBeInstanceOf(z.ZodObject); // Corrected typo
        expect(proc._def.subscriptionResolver).toBeDefined();
     });

     // Add tests for context usage, error handling in resolvers etc.
  });

   // Placeholder for requestHandler tests
   describe('createRequestHandler', () => {
       // TODO: Write tests for requestHandler, including context creation,
       // procedure finding, input/output parsing, error handling,
       // subscription lifecycle, batching etc. Requires mocking transport.
       it.todo('should handle query requests');
       it.todo('should handle mutation requests');
       it.todo('should handle subscription start requests');
       it.todo('should handle subscription stop requests');
       it.todo('should handle batch requests');
       it.todo('should handle context creation errors');
       it.todo('should handle input validation errors');
       it.todo('should handle output validation errors');
       it.todo('should handle resolver errors');
       it.todo('should handle subscription resolver errors');
       it.todo('should handle procedure not found errors');
       it.todo('should handle incorrect procedure type calls');
       it.todo('should call subscription cleanup on stop/disconnect');
   });

    // Placeholder for SubscriptionManager tests
    describe('SubscriptionManager', () => {
        // TODO: Write tests for adding, removing, checking subscriptions and cleanup execution.
        it.todo('should add a subscription cleanup');
        it.todo('should remove a subscription and call cleanup');
        it.todo('should handle removing non-existent subscription');
        it.todo('should correctly report if a subscription exists');
    });

     // Placeholder for UpdateHistory tests
     describe('createInMemoryUpdateHistory', () => {
         // TODO: Write tests for adding updates, getting updates within range,
         // buffer pruning, clearing history.
         it.todo('should add updates');
         it.todo('should retrieve updates in a sequence range');
         it.todo('should prune old updates when buffer size exceeded');
         it.todo('should clear topic history');
         it.todo('should clear all history');
     });

});