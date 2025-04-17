import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createRouter, Router } from '../router';
import { initTypeQL } from '../procedure';
import type { ProcedureContext, AnyProcedure, AnyRouter } from '@sylph/typeql-shared';

// Initialize the procedure builder
const t = initTypeQL<ProcedureContext>(); // Use a generic context for testing

describe('createRouter', () => {
  it('should create an empty router instance', () => {
    const router = createRouter()({});
    expect(typeof router).toBe('object'); // Check if it's an object
    expect(router._def).toBeDefined(); // Check if the internal definition exists
    expect(router._def.procedures).toEqual({});
  });

  it('should create a router instance with procedures', () => {
    const router = createRouter()({
      query1: t.query // Use getter
        .input(z.object({ id: z.string() })) // Chain methods
        .resolve(({ input }) => `Query 1: ${input.id}`), // End with resolve
      mutation1: t.mutation // Use getter
        .resolve(() => 'Mutation 1'), // End with resolve (no input needed)
    });
    expect(typeof router).toBe('object'); // Check if it's an object
    expect(router._def).toBeDefined(); // Check if the internal definition exists
    expect(Object.keys(router._def.procedures)).toEqual(['query1', 'mutation1']);
    expect(router._def.procedures.query1).toBeDefined();
    expect(router._def.procedures.mutation1).toBeDefined();
    expect((router._def.procedures.query1 as AnyProcedure)._def.type).toBe('query');
    expect((router._def.procedures.mutation1 as AnyProcedure)._def.type).toBe('mutation');
  });


  it('should handle nested routers correctly', () => {
    const subRouter = createRouter()({
      subQuery: t.query // Use getter
        .resolve(() => 'Sub Query'), // End with resolve
    });

    const mainRouter = createRouter()({
      mainQuery: t.query // Use getter
        .resolve(() => 'Main Query'), // End with resolve
      nested: subRouter, // Nest the previously created router
    });

    expect(typeof mainRouter).toBe('object'); // Check if it's an object
    expect(mainRouter._def).toBeDefined(); // Check if the internal definition exists
    expect(mainRouter._def.procedures.mainQuery).toBeDefined();
    expect(mainRouter._def.procedures.nested).toBeDefined();
    expect((mainRouter._def.procedures.nested as AnyRouter)._def.router).toBe(true); // Check if nested is a router
    expect((mainRouter._def.procedures.nested as AnyRouter)._def.procedures.subQuery).toBeDefined();
    expect(((mainRouter._def.procedures.nested as AnyRouter)._def.procedures.subQuery as AnyProcedure)._def.type).toBe('query');

  });

   it('should handle different procedure types', () => {
    const router = createRouter()({
      q: t.query.resolve(() => 'q'), // Use getter and resolve
      m: t.mutation.resolve(() => 'm'), // Use getter and resolve
      s: t.subscription.subscribe(() => { // Use getter and subscribe
        // Simplified resolver for test
        return () => {}; // Return cleanup function
      }),
    });

    expect((router._def.procedures.q as AnyProcedure)._def.type).toBe('query');
    expect((router._def.procedures.m as AnyProcedure)._def.type).toBe('mutation');
    expect((router._def.procedures.s as AnyProcedure)._def.type).toBe('subscription');
  });

  it('should pass context correctly (conceptual test)', () => {
    // This test remains conceptual as context passing happens during request handling.
    const mockResolver = vi.fn();
    // Define context type when initializing the builder
    const tWithContext = initTypeQL<{ user?: { id: string } }>();

    const router = createRouter<{ user?: { id: string } }>()({ // Pass context type to createRouter as well
      testQuery: tWithContext.query // Use the builder with context
        .resolve(mockResolver), // End with resolve
    });

    // We check that the procedure definition exists.
    expect(router._def.procedures.testQuery).toBeDefined();

    // Simulate calling the resolver (outside the scope of this test)
    // const context = { user: { id: '123' } };
    // const input = undefined;
    // const procedure = router._def.procedures.testQuery as AnyProcedure;
    // await procedure._def.resolver?.({ ctx: context, input });
    // expect(mockResolver).toHaveBeenCalledWith({ ctx: context, input });
  });

});