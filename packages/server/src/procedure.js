// packages/core/src/server/procedure.ts
// --- Builder Logic ---
/**
 * Base class/interface for the procedure builder chain.
 * Uses generics to track Context, Input, Output types.
 */
class ProcedureBuilder {
    // Store the definition being built
    // Use `Partial<ProcedureDef<any, any, any, any>>` internally for flexibility during build steps
    _def;
    // Constructor takes the internal definition state
    constructor(initialDef) {
        this._def = initialDef;
    }
    /** Define the context type for subsequent steps */
    context() {
        // This doesn't change the definition, only the generic type for the next builder instance
        return this;
    }
    /** Define the input schema/validator */
    input(schema) {
        console.log(`[TypeQL Procedure] Defining input schema for ${this._def.type}...`);
        // Create a new builder instance with updated generic type inferred from ZodSchema
        const nextDef = {
            ...this._def,
            inputSchema: schema, // Store the schema
        };
        return new ProcedureBuilder(nextDef);
    }
    /** Define the output schema/validator (for query/mutation) */
    output(schema) {
        if (this._def.type === 'subscription') {
            console.warn("[TypeQL Procedure] Use '.subscriptionOutput()' for subscription stream output.");
        }
        console.log(`[TypeQL Procedure] Defining output schema for ${this._def.type}...`);
        // Create a new builder instance with updated generic type inferred from ZodSchema
        const nextDef = {
            ...this._def, // Need cast here
            outputSchema: schema, // Store the schema
        };
        return new ProcedureBuilder(nextDef);
    }
    /** Define the output schema/validator for the subscription stream */
    subscriptionOutput(schema) {
        if (this._def.type !== 'subscription') {
            throw new Error("'.subscriptionOutput()' can only be used for subscriptions.");
        }
        console.log(`[TypeQL Procedure] Defining subscription output schema...`);
        // Create a new builder instance with updated generic type inferred from ZodSchema
        const nextDef = {
            ...this._def, // Need cast here
            subscriptionOutputSchema: schema, // Store the schema
        };
        return new ProcedureBuilder(nextDef);
    }
    /** Define the resolver function for a query or mutation */
    resolve(resolver // Use correct generics from the builder state
    ) {
        if (this._def.type === 'subscription') {
            throw new Error("Use '.subscribe()' for subscription procedures.");
        }
        console.log(`[TypeQL Procedure] Defining resolver for ${this._def.type}...`);
        const finalDef = {
            ...this._def, // Cast existing def
            type: this._def.type, // type is guaranteed by constructor
            resolver: resolver,
        };
        // Return the final procedure definition, cast to AnyProcedure for storage in router
        return { _def: finalDef };
    }
    /** Define the resolver function for a subscription */
    subscribe(resolver // Use correct generics
    ) {
        if (this._def.type !== 'subscription') {
            throw new Error("Use '.resolve()' for query/mutation procedures.");
        }
        console.log(`[TypeQL Procedure] Defining subscription resolver...`);
        const finalDef = {
            ...this._def, // Cast existing def
            type: 'subscription', // Explicitly set type
            subscriptionResolver: resolver,
        };
        // Return the final procedure definition, cast to AnyProcedure for storage in router
        return { _def: finalDef };
    }
}
/**
 * Initializes the procedure builder chain.
 * This acts like the initial `t.procedure` or `t.router` in tRPC.
 */
class ProcedureBuilderInitializer {
    /** Starts building a Query procedure */
    get query() {
        // Provide initial definition with type
        return new ProcedureBuilder({ type: 'query' });
    }
    /** Starts building a Mutation procedure */
    get mutation() {
        // Provide initial definition with type
        return new ProcedureBuilder({ type: 'mutation' });
    }
    /** Starts building a Subscription procedure */
    get subscription() {
        // Provide initial definition with type
        return new ProcedureBuilder({ type: 'subscription' });
    }
}
// --- Export ---
/**
 * Creates the initial object for defining procedures.
 * Pass the context type expected by your procedures.
 *
 * @example
 * const t = initTypeQL<AppContext>();
 * const appRouter = createRouter({
 *   getUser: t.query // Use the getter here
 *     .input(...)
 *     .resolve(...)
 * });
 */
export function initTypeQL() {
    return new ProcedureBuilderInitializer();
}
// Example usage (won't run here, just for illustration)
/*
interface MyContext extends ProcedureContext { userId?: string }
const t = initTypeQL<MyContext>();

// Example Zod schemas
const UserIdInput = z.object({ id: z.string().uuid() });
const UserOutput = z.object({ id: z.string().uuid(), name: z.string() });
const UpdateFilterInput = z.object({ filter: z.string().optional() });
const UpdateDeltaOutput = z.object({ type: z.literal('update'), data: z.string(), timestamp: z.number() });

const exampleProcedure = t.query // Use getter
    .input(UserIdInput) // Use Zod schema
    .output(UserOutput) // Use Zod schema
    .resolve(async ({ ctx, input }) => {
        // input is now typed as { id: string }
        console.log("Context:", ctx.userId);
        console.log("Input:", input.id); // Access validated input
        // Fetch user based on input.id
        return { id: input.id, name: "Example User" }; // Return type checked against UserOutput
    });

const exampleSubscription = t.subscription // Use getter
    .input(UpdateFilterInput) // Use Zod schema
    .subscriptionOutput(UpdateDeltaOutput) // Use Zod schema for the delta/update type
    .subscribe(({ ctx, input, publish }) => {
        // input is now typed as { filter?: string }
         console.log("Subscription started with filter:", input.filter);
         const interval = setInterval(() => {
             // Publish data matching UpdateDeltaOutput schema
             publish({ type: 'update', data: `Update at ${Date.now()}`, timestamp: Date.now() });
         }, 1000);
         // Return cleanup function
         return () => {
             console.log("Subscription ended");
             clearInterval(interval);
         };
     });
*/
console.log("packages/core/src/server/procedure.ts loaded");
// --- End Builder Logic ---
// Removed deprecated code block
//# sourceMappingURL=procedure.js.map