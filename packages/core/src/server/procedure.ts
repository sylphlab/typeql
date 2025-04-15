// packages/core/src/server/procedure.ts

// Core procedure building logic for TypeQL
// Inspired by tRPC procedures

import * as z from 'zod';
import type { StandardDelta } from '../core/types'; // Assuming deltas are needed

// --- Core Types ---

/** Context object passed to resolvers/subscriptions */
export type ProcedureContext = Record<string, unknown>; // Base context, user can extend

/** Options passed to resolver/subscription functions */
export interface ProcedureOptions<TContext, TInput = unknown> {
    ctx: TContext;
    input: TInput;
}

/** Options passed specifically to subscription resolvers */
export interface SubscriptionOptions<TContext, TInput = unknown, TOutput = unknown> extends ProcedureOptions<TContext, TInput> {
    /** Function to push data/deltas to the client */
    publish: (data: TOutput) => void;
}

/** Function signature for query/mutation resolvers */
export type Resolver<TInput = any, TOutput = any, TContext = any> = (opts: ProcedureOptions<TContext, TInput>) => Promise<TOutput> | TOutput;

/**
 * Function signature for subscription resolvers.
 * Sets up the subscription and returns an unsubscribe/cleanup function.
 */
export type SubscriptionResolver<TInput = any, TOutput = any, TContext = any> = (opts: SubscriptionOptions<TContext, TInput, TOutput>) => Promise<() => void> | (() => void);


// --- Procedure Definition ---

/** Internal definition of a procedure */
export interface ProcedureDef<
    TContext = ProcedureContext,
    TInput = unknown,
    TOutput = unknown,
    TSubscriptionOutput = unknown // Separate output for subscription stream
> {
    type: 'query' | 'mutation' | 'subscription';
    inputSchema?: z.ZodType<TInput>; // Zod schema for input validation/parsing
    outputSchema?: z.ZodType<TOutput>; // Zod schema for output validation/parsing
    subscriptionOutputSchema?: z.ZodType<TSubscriptionOutput>; // Schema for subscription data/deltas
    resolver?: Resolver<TInput, TOutput, TContext>;
    subscriptionResolver?: SubscriptionResolver<TInput, TSubscriptionOutput, TContext>;
    // meta?: TMeta; // Placeholder for metadata
}

/** Marker type for any procedure */
export interface AnyProcedure {
    _def: ProcedureDef<any, any, any, any>;
    // // These markers might not be strictly necessary if client inference works via router structure
    // _input_in?: any;
    // _output_out?: any;
    // _subscription_out?: any;
    // _ctx_in?: any;
    // // _meta_in?: any;
}


// --- Builder Logic ---

/**
 * Base class/interface for the procedure builder chain.
 * Uses generics to track Context, Input, Output types.
 */
class ProcedureBuilder<
    TContext extends ProcedureContext,
    TInput,
    TOutput, // Output for query/mutation
    TSubscriptionOutput // Output for subscription stream (deltas)
> {
    // Store the definition being built
    // Use `Partial<ProcedureDef<any, any, any, any>>` internally for flexibility during build steps
    protected _def: Partial<ProcedureDef<any, any, any, any>>;

    // Constructor takes the internal definition state
    constructor(initialDef: Partial<ProcedureDef<any, any, any, any>>) {
        this._def = initialDef;
    }

    /** Define the input schema/validator */
    input<ZodSchema extends z.ZodType>(
        schema: ZodSchema
    ): ProcedureBuilder<TContext, z.infer<ZodSchema>, TOutput, TSubscriptionOutput> {
        console.log(`[TypeQL Procedure] Defining input schema for ${this._def.type}...`);
        // Create a new builder instance with updated generic type inferred from ZodSchema
        const nextDef: Partial<ProcedureDef<TContext, z.infer<ZodSchema>, TOutput, TSubscriptionOutput>> = {
            ...this._def,
            inputSchema: schema as z.ZodType<z.infer<ZodSchema>>, // Store the schema
        };
        return new ProcedureBuilder<TContext, z.infer<ZodSchema>, TOutput, TSubscriptionOutput>(nextDef);
    }

    /** Define the output schema/validator (for query/mutation) */
    output<ZodSchema extends z.ZodType>(
        schema: ZodSchema
    ): ProcedureBuilder<TContext, TInput, z.infer<ZodSchema>, TSubscriptionOutput> {
        if (this._def.type === 'subscription') {
            console.warn("[TypeQL Procedure] Use '.subscriptionOutput()' for subscription stream output.");
        }
        console.log(`[TypeQL Procedure] Defining output schema for ${this._def.type}...`);
        // Create a new builder instance with updated generic type inferred from ZodSchema
        const nextDef: Partial<ProcedureDef<TContext, TInput, z.infer<ZodSchema>, TSubscriptionOutput>> = {
            ...(this._def as Partial<ProcedureDef<TContext, TInput, z.infer<ZodSchema>, TSubscriptionOutput>>), // Need cast here
            outputSchema: schema as z.ZodType<z.infer<ZodSchema>>, // Store the schema
        };
        return new ProcedureBuilder<TContext, TInput, z.infer<ZodSchema>, TSubscriptionOutput>(nextDef);
    }

    /** Define the output schema/validator for the subscription stream */
    subscriptionOutput<ZodSchema extends z.ZodType>(
        schema: ZodSchema
    ): ProcedureBuilder<TContext, TInput, TOutput, z.infer<ZodSchema>> {
        if (this._def.type !== 'subscription') {
            throw new Error("'.subscriptionOutput()' can only be used for subscriptions.");
        }
        console.log(`[TypeQL Procedure] Defining subscription output schema...`);
        // Create a new builder instance with updated generic type inferred from ZodSchema
        const nextDef: Partial<ProcedureDef<TContext, TInput, TOutput, z.infer<ZodSchema>>> = {
            ...(this._def as Partial<ProcedureDef<TContext, TInput, TOutput, z.infer<ZodSchema>>>), // Need cast here
            subscriptionOutputSchema: schema as z.ZodType<z.infer<ZodSchema>>, // Store the schema
        };
        return new ProcedureBuilder<TContext, TInput, TOutput, z.infer<ZodSchema>>(nextDef);
    }


    /** Define the resolver function for a query or mutation */
    resolve(
        resolver: Resolver<TInput, TOutput, TContext> // Use correct generics from the builder state
    ): AnyProcedure {
        if (this._def.type === 'subscription') {
            throw new Error("Use '.subscribe()' for subscription procedures.");
        }
        console.log(`[TypeQL Procedure] Defining resolver for ${this._def.type}...`);
        const finalDef: ProcedureDef<TContext, TInput, TOutput, TSubscriptionOutput> = {
            ...(this._def as ProcedureDef<TContext, TInput, TOutput, TSubscriptionOutput>), // Cast existing def
             type: this._def.type!, // type is guaranteed by constructor
             resolver: resolver,
        };
        // Return the final procedure definition, cast to AnyProcedure for storage in router
        return { _def: finalDef } as AnyProcedure;
    }

    /** Define the resolver function for a subscription */
    subscribe(
        resolver: SubscriptionResolver<TInput, TSubscriptionOutput, TContext> // Use correct generics
    ): AnyProcedure {
        if (this._def.type !== 'subscription') {
            throw new Error("Use '.resolve()' for query/mutation procedures.");
        }
        console.log(`[TypeQL Procedure] Defining subscription resolver...`);
         const finalDef: ProcedureDef<TContext, TInput, TOutput, TSubscriptionOutput> = {
             ...(this._def as ProcedureDef<TContext, TInput, TOutput, TSubscriptionOutput>), // Cast existing def
             type: 'subscription', // Explicitly set type
             subscriptionResolver: resolver,
         };
        // Return the final procedure definition, cast to AnyProcedure for storage in router
        return { _def: finalDef } as AnyProcedure;
    }
}


/**
 * Initializes the procedure builder chain.
 * This acts like the initial `t.procedure` or `t.router` in tRPC.
 */
class ProcedureBuilderInitializer<TContext extends ProcedureContext> {
    /** Starts building a Query procedure */
    get query() {
        // Provide initial definition with type
        return new ProcedureBuilder<TContext, unknown, unknown, unknown>({ type: 'query' });
    }

    /** Starts building a Mutation procedure */
    get mutation() {
        // Provide initial definition with type
        return new ProcedureBuilder<TContext, unknown, unknown, unknown>({ type: 'mutation' });
    }

    /** Starts building a Subscription procedure */
    get subscription() {
         // Provide initial definition with type
        return new ProcedureBuilder<TContext, unknown, unknown, unknown>({ type: 'subscription' });
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
export function initTypeQL<TContext extends ProcedureContext>() {
    return new ProcedureBuilderInitializer<TContext>();
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
