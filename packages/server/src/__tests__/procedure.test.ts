import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { initzenQuery } from '../procedure';
// Adjust import path for shared types
import type { ProcedureContext, AnyProcedure } from '../../../shared/src';
import { JsonPatchSchema, type JsonPatchOperation } from '../utils/json-patch'; // Import patch schema

// Helper to consume an async generator
async function consumeAsyncGenerator<T>(gen: AsyncGenerator<T, void, unknown>): Promise<T[]> {
    const results: T[] = [];
    for await (const value of gen) {
        results.push(value);
    }
    return results;
}

// Initialize the procedure builder
const t = initzenQuery<ProcedureContext>(); // Use a generic context for testing

describe('ProcedureBuilder', () => {
  it('should define input schema correctly', () => {
    const inputSchema = z.object({ name: z.string() });
    const procedure = t.query.input(inputSchema).resolve(() => 'test');
    expect((procedure as AnyProcedure)._def.inputSchema).toBe(inputSchema);
  });

  it('should define output schema correctly for query', () => {
    const outputSchema = z.object({ result: z.string() });
    const procedure = t.query.output(outputSchema).resolve(() => ({ result: 'test' }));
    expect((procedure as AnyProcedure)._def.outputSchema).toBe(outputSchema);
  });

  it('should define output schema correctly for mutation', () => {
    const outputSchema = z.object({ success: z.boolean() });
    const procedure = t.mutation.output(outputSchema).resolve(() => ({ success: true }));
    expect((procedure as AnyProcedure)._def.outputSchema).toBe(outputSchema);
  });

  // Updated test for .output() on subscription
  it('should allow .output() for subscription initial state', () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const outputSchema = z.object({ initial: z.string() });
    // Chain with .stream() to finalize
    const procedure = t.subscription
        .output(outputSchema) // Should NOT warn now, used for initial state
        .subscriptionOutput(z.object({ delta: z.number() }))
        .stream(async function*() {}); // Need a streamer

    expect(consoleWarnSpy).not.toHaveBeenCalled(); // No warning expected
    expect((procedure as AnyProcedure)._def.outputSchema).toBe(outputSchema); // Schema should be set for potential initial resolver
    consoleWarnSpy.mockRestore();
  });


  it('should define subscriptionOutput schema correctly', () => {
    const subOutputSchema = z.object({ update: z.number() });
    // Use .stream() to finalize
    const procedure = t.subscription.subscriptionOutput(subOutputSchema).stream(async function*() {});
    expect((procedure as AnyProcedure)._def.subscriptionOutputSchema).toBe(subOutputSchema);
  });

  it('should throw error when using .subscriptionOutput() for query', () => {
     const subOutputSchema = z.object({ update: z.number() });
     expect(() => t.query.subscriptionOutput(subOutputSchema)).toThrowError(
       "'.subscriptionOutput()' can only be used for subscriptions."
     );
  });

   it('should throw error when using .subscriptionOutput() for mutation', () => {
     const subOutputSchema = z.object({ update: z.number() });
     expect(() => t.mutation.subscriptionOutput(subOutputSchema)).toThrowError(
       "'.subscriptionOutput()' can only be used for subscriptions."
     );
  });

  // Updated error messages
  it('should throw error when using .resolve() for subscription', () => {
    expect(() => t.subscription.resolve(() => 'test')).toThrowError(
      "Use '.stream()' or '.streamDiff()' for subscription procedures. Use '.resolveInitial()' for initial subscription data."
    );
  });

  it('should throw error when using .stream() for query', () => {
    expect(() => t.query.stream(async function*() {})).toThrowError(
      "Use '.resolve()' for query/mutation procedures."
    );
  });

  it('should throw error when using .stream() for mutation', () => {
    expect(() => t.mutation.stream(async function*() {})).toThrowError(
      "Use '.resolve()' for query/mutation procedures."
    );
  });

  it('should throw error when using .streamDiff() for query', () => {
    const stateSchema = z.object({ count: z.number() });
    expect(() => t.query.streamDiff(stateSchema, async function*() {})).toThrowError(
      "Use '.resolve()' for query/mutation procedures."
    );
  });

  it('should throw error when using .streamDiff() for mutation', () => {
     const stateSchema = z.object({ count: z.number() });
    expect(() => t.mutation.streamDiff(stateSchema, async function*() {})).toThrowError(
      "Use '.resolve()' for query/mutation procedures."
    );
  });

  it('should throw error when using .resolveInitial() for query', () => {
    expect(() => t.query.resolveInitial(() => 'test')).toThrowError(
      "'.resolveInitial()' can only be used for subscription procedures."
    );
  });

  it('should throw error when using .resolveInitial() for mutation', () => {
    expect(() => t.mutation.resolveInitial(() => 'test')).toThrowError(
      "'.resolveInitial()' can only be used for subscription procedures."
    );
  });

  // Deprecated method tests
  it('should throw error when using .legacySubscribe() for query', () => {
    expect(() => t.query.legacySubscribe(() => () => {})).toThrowError(
      "Use '.resolve()' for query/mutation procedures."
    );
  });

  it('should throw error when using .legacySubscribe() for mutation', () => {
    expect(() => t.mutation.legacySubscribe(() => () => {})).toThrowError(
      "Use '.resolve()' for query/mutation procedures."
    );
  });

  it('should allow chaining .context()', () => {
    interface MyContext extends ProcedureContext { userId: string }
    const tWithContext = initzenQuery<MyContext>();
    const procedure = tWithContext.query
      .context<MyContext>() // Explicitly setting context (though already set by init)
      .input(z.object({ id: z.string() }))
      .resolve(({ ctx, input }) => {
        // Verify context type inside resolver (compile-time check essentially)
        const userId: string = ctx.userId;
        return `User: ${userId}, Input: ${input.id}`;
      });

    // Basic check that procedure was created
    expect(procedure).toBeDefined();
    expect((procedure as AnyProcedure)._def.type).toBe('query');
    // We can't easily test the TContext generic runtime, but the builder should compile
  });

  it('should allow defining input and output', () => {
     const inputSchema = z.object({ value: z.number() });
     const outputSchema = z.object({ doubled: z.number() });
     const procedure = t.mutation
       .input(inputSchema)
       .output(outputSchema)
       .resolve(({ input }) => ({ doubled: input.value * 2 }));

     expect((procedure as AnyProcedure)._def.inputSchema).toBe(inputSchema);
     expect((procedure as AnyProcedure)._def.outputSchema).toBe(outputSchema);
     expect((procedure as AnyProcedure)._def.type).toBe('mutation');
  });

   it('should allow defining input and subscriptionOutput with .stream()', () => {
     const inputSchema = z.object({ start: z.number() });
     const subOutputSchema = z.object({ count: z.number() });
     const procedure = t.subscription
       .input(inputSchema)
       .subscriptionOutput(subOutputSchema)
       .stream(async function*({ input }) {
         yield { count: input.start };
       });

     expect((procedure as AnyProcedure)._def.inputSchema).toBe(inputSchema);
     expect((procedure as AnyProcedure)._def.subscriptionOutputSchema).toBe(subOutputSchema);
     expect((procedure as AnyProcedure)._def.type).toBe('subscription');
     expect((procedure as AnyProcedure)._def.subscriptionStreamer).toBeDefined();
     expect((procedure as AnyProcedure)._def.legacySubscriptionResolver).toBeUndefined();
   });

});

describe('Subscription Methods (.stream(), .streamDiff(), .resolveInitial())', () => {

    it('.resolveInitial() should set the initial resolver', () => {
        const initialResolver = vi.fn(() => ({ initial: 'data' }));
        const procedureBuilder = t.subscription.resolveInitial(initialResolver);
        // Check internal state before finalizing with .stream() or .streamDiff()
        expect((procedureBuilder as any)._def.resolver).toBe(initialResolver);
        expect((procedureBuilder as any)._def.type).toBe('subscription');

        // Finalize and check again
        const finalProcedure = procedureBuilder.stream(async function*() {});
        expect((finalProcedure as AnyProcedure)._def.resolver).toBe(initialResolver);
    });

    it('.resolveInitial() should allow chaining .stream()', () => {
        const initialResolver = vi.fn(() => ({ initial: 'data' }));
        const streamer = async function*() { yield { update: 1 }; };
        const procedure = t.subscription
            .output(z.object({ initial: z.string() }))
            .resolveInitial(initialResolver)
            .subscriptionOutput(z.object({ update: z.number() }))
            .stream(streamer);

        expect((procedure as AnyProcedure)._def.resolver).toBe(initialResolver);
        expect((procedure as AnyProcedure)._def.subscriptionStreamer).toBe(streamer);
        expect((procedure as AnyProcedure)._def.type).toBe('subscription');
    });

     it('.resolveInitial() should allow chaining .streamDiff()', () => {
        const initialResolver = vi.fn(() => ({ count: 0 }));
        const stateSchema = z.object({ count: z.number() });
        const userStreamer = async function*() { yield { count: 1 }; };
        const procedure = t.subscription
            .output(stateSchema) // Schema for initial state
            .resolveInitial(initialResolver)
            // No .subscriptionOutput() needed for streamDiff
            .streamDiff(stateSchema, userStreamer);

        expect((procedure as AnyProcedure)._def.resolver).toBe(initialResolver);
        expect((procedure as AnyProcedure)._def.subscriptionStreamer).toBeDefined(); // Internal streamer is set
        expect((procedure as AnyProcedure)._def.subscriptionOutputSchema).toBe(JsonPatchSchema);
        expect((procedure as AnyProcedure)._def.type).toBe('subscription');
    });

    it('.stream() should set the streamer and type', () => {
        const streamer = async function*() { yield { update: 1 }; };
        const procedure = t.subscription
            .subscriptionOutput(z.object({ update: z.number() }))
            .stream(streamer);

        expect((procedure as AnyProcedure)._def.subscriptionStreamer).toBe(streamer);
        expect((procedure as AnyProcedure)._def.legacySubscriptionResolver).toBeUndefined();
        expect((procedure as AnyProcedure)._def.type).toBe('subscription');
    });

    it('.stream() streamer should yield correct values', async () => {
        const streamer = async function*() {
            yield { update: 1 };
            await new Promise(r => setTimeout(r, 10));
            yield { update: 2 };
        };
        const procedure = t.subscription
            .subscriptionOutput(z.object({ update: z.number() }))
            .stream(streamer);

        const internalStreamer = (procedure as AnyProcedure)._def.subscriptionStreamer;
        expect(internalStreamer).toBeDefined();

        const results = await consumeAsyncGenerator(internalStreamer!({ ctx: {}, input: undefined }));
        expect(results).toEqual([{ update: 1 }, { update: 2 }]);
    });

    it('.streamDiff() should set internal streamer, type, and patch schema', () => {
        const stateSchema = z.object({ count: z.number() });
        const userStreamer = async function*() { yield { count: 1 }; };
        const procedure = t.subscription.streamDiff(stateSchema, userStreamer);

        expect((procedure as AnyProcedure)._def.subscriptionStreamer).toBeDefined();
        expect((procedure as AnyProcedure)._def.legacySubscriptionResolver).toBeUndefined();
        expect((procedure as AnyProcedure)._def.type).toBe('subscription');
        expect((procedure as AnyProcedure)._def.subscriptionOutputSchema).toBe(JsonPatchSchema); // Check if schema is set correctly
    });

    it('.streamDiff() internal streamer should yield correct patches', async () => {
        const stateSchema = z.object({ count: z.number(), name: z.string().optional() });
        const userStreamer = async function*() {
            yield { count: 0 }; // Initial state
            await new Promise(r => setTimeout(r, 5));
            yield { count: 1 }; // Change 1
            await new Promise(r => setTimeout(r, 5));
            yield { count: 1, name: 'test' }; // Change 2
            await new Promise(r => setTimeout(r, 5));
            yield { count: 1, name: 'test' }; // No change
            await new Promise(r => setTimeout(r, 5));
            yield { count: 2, name: 'tested' }; // Change 3
        };
        const procedure = t.subscription.streamDiff(stateSchema, userStreamer);
        const internalStreamer = (procedure as AnyProcedure)._def.subscriptionStreamer;
        expect(internalStreamer).toBeDefined();

        const results = await consumeAsyncGenerator(internalStreamer!({ ctx: {}, input: undefined }));

        expect(results.length).toBe(3); // Initial state doesn't yield patch, no-change doesn't yield patch
        // Patch 1: count 0 -> 1
        expect(results[0]).toEqual([{ op: 'replace', path: '/count', value: 1 }]);
        // Patch 2: add name
        expect(results[1]).toEqual([{ op: 'add', path: '/name', value: 'test' }]);
        // Patch 3: count 1 -> 2, name 'test' -> 'tested' (order might vary)
        expect(results[2]).toEqual(expect.arrayContaining([
            { op: 'replace', path: '/count', value: 2 },
            { op: 'replace', path: '/name', value: 'tested' }
        ]));
        // Add type cast here
        expect((results[2] as JsonPatchOperation[]).length).toBe(2);
    });

     it('.streamDiff() should warn if .subscriptionOutput() was used before', () => {
        const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const stateSchema = z.object({ count: z.number() });
        const userStreamer = async function*() { yield { count: 1 }; };

        t.subscription
            .subscriptionOutput(z.string()) // Set a different schema first
            .streamDiff(stateSchema, userStreamer); // This should warn

        expect(consoleWarnSpy).toHaveBeenCalledWith(
            "[zenQuery Procedure] '.subscriptionOutput()' was called before '.streamDiff()'. The output schema will be overridden by JsonPatchSchema."
        );
        consoleWarnSpy.mockRestore();
    });

    it('.streamDiff() internal streamer should handle state validation errors', async () => {
        const stateSchema = z.object({ count: z.number() }); // Expects number
        const userStreamer = async function*() {
            yield { count: 0 }; // Valid initial state
            await new Promise(r => setTimeout(r, 5));
            // Use 'as any' to bypass compile-time check for this specific test case
            yield { count: 'invalid' } as any; // Invalid state
            await new Promise(r => setTimeout(r, 5));
            yield { count: 2 }; // This won't be reached
        };
        const procedure = t.subscription.streamDiff(stateSchema, userStreamer);
        const internalStreamer = (procedure as AnyProcedure)._def.subscriptionStreamer;
        expect(internalStreamer).toBeDefined();

        const generator = internalStreamer!({ ctx: {}, input: undefined });

        // Consume first (valid) state's patch (none expected)
        const firstResult = await generator.next();
        expect(firstResult.done).toBe(false); // Should yield patch from initial -> invalid
        expect(firstResult.value).toEqual([{ op: 'replace', path: '/count', value: 'invalid' }]); // Diff yields the invalid value before validation error

        // Expect the next iteration to throw due to validation
        await expect(generator.next()).rejects.toThrow(/Subscription state validation failed/);
    });

     it('.streamDiff() internal streamer should handle errors from user streamer', async () => {
        const stateSchema = z.object({ count: z.number() });
        const userStreamer = async function*() {
            yield { count: 0 }; // Valid initial state
            await new Promise(r => setTimeout(r, 5));
            throw new Error("User streamer error!");
            // yield { count: 1 }; // This won't be reached
        };
        const procedure = t.subscription.streamDiff(stateSchema, userStreamer);
        const internalStreamer = (procedure as AnyProcedure)._def.subscriptionStreamer;
        expect(internalStreamer).toBeDefined();

        const generator = internalStreamer!({ ctx: {}, input: undefined });

        // Consume first (valid) state's patch (none expected)
        // The first yield happens before the error
        // await expect(generator.next()).resolves.toEqual({ done: false, value: undefined }); // No patch for initial

        // Expect the next iteration to throw the user's error
        await expect(generator.next()).rejects.toThrow("User streamer error!");
    });

});

describe('initzenQuery', () => {
  it('should return an initializer object with query, mutation, subscription getters', () => {
    const initializer = initzenQuery();
    expect(initializer).toHaveProperty('query');
    expect(initializer).toHaveProperty('mutation');
    expect(initializer).toHaveProperty('subscription');
    // Check if getters return ProcedureBuilder instances (conceptual)
    expect(typeof initializer.query).toBe('object'); // Builders are objects
    expect(typeof initializer.mutation).toBe('object');
    expect(typeof initializer.subscription).toBe('object');
  });

  it('should allow specifying context type', () => {
     interface CustomContext extends ProcedureContext { tenantId: string }
     const initializer = initzenQuery<CustomContext>();
     // The context type is primarily for compile-time checks within resolvers
     // We can check that the builder methods exist
     expect(initializer.query).toBeDefined();
     // Further checks would involve creating procedures and verifying resolver signatures,
     // which is covered in the ProcedureBuilder tests.
  });
});