import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { initTypeQL } from '../procedure';
import type { ProcedureContext, AnyProcedure } from '@sylphlab/typeql-shared';

// Initialize the procedure builder
const t = initTypeQL<ProcedureContext>(); // Use a generic context for testing

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

  it('should warn when using .output() for subscription', () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const outputSchema = z.object({ initial: z.string() });
    // We need to chain .subscribe() to get the final procedure, even though .output() is the focus
    const procedure = t.subscription
        .output(outputSchema) // This should warn
        .subscriptionOutput(z.object({ delta: z.number() })) // Need this too
        .subscribe(() => () => {}); // Need a resolver

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "[TypeQL Procedure] Use '.subscriptionOutput()' for subscription stream output."
    );
    // Check if outputSchema was still set (though it's not used for the stream)
    expect((procedure as AnyProcedure)._def.outputSchema).toBe(outputSchema);
    consoleWarnSpy.mockRestore();
  });


  it('should define subscriptionOutput schema correctly', () => {
    const subOutputSchema = z.object({ update: z.number() });
    const procedure = t.subscription.subscriptionOutput(subOutputSchema).subscribe(() => () => {});
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

  it('should throw error when using .resolve() for subscription', () => {
    expect(() => t.subscription.resolve(() => 'test')).toThrowError(
      "Use '.subscribe()' for subscription procedures."
    );
  });

  it('should throw error when using .subscribe() for query', () => {
    expect(() => t.query.subscribe(() => () => {})).toThrowError(
      "Use '.resolve()' for query/mutation procedures."
    );
  });

  it('should throw error when using .subscribe() for mutation', () => {
    expect(() => t.mutation.subscribe(() => () => {})).toThrowError(
      "Use '.resolve()' for query/mutation procedures."
    );
  });

  it('should allow chaining .context()', () => {
    interface MyContext extends ProcedureContext { userId: string }
    const tWithContext = initTypeQL<MyContext>();
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

   it('should allow defining input and subscriptionOutput', () => {
     const inputSchema = z.object({ start: z.number() });
     const subOutputSchema = z.object({ count: z.number() });
     const procedure = t.subscription
       .input(inputSchema)
       .subscriptionOutput(subOutputSchema)
       .subscribe(({ input, publish }) => {
         let count = input.start;
         const interval = setInterval(() => {
           publish({ count: count++ });
         }, 10);
         return () => clearInterval(interval);
       });

     expect((procedure as AnyProcedure)._def.inputSchema).toBe(inputSchema);
     expect((procedure as AnyProcedure)._def.subscriptionOutputSchema).toBe(subOutputSchema);
     expect((procedure as AnyProcedure)._def.type).toBe('subscription');
   });

});

describe('initTypeQL', () => {
  it('should return an initializer object with query, mutation, subscription getters', () => {
    const initializer = initTypeQL();
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
     const initializer = initTypeQL<CustomContext>();
     // The context type is primarily for compile-time checks within resolvers
     // We can check that the builder methods exist
     expect(initializer.query).toBeDefined();
     // Further checks would involve creating procedures and verifying resolver signatures,
     // which is covered in the ProcedureBuilder tests.
  });
});