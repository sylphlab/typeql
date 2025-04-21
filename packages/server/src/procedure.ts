// packages/core/src/server/procedure.ts

// Core procedure building logic for zenQuery
// Inspired by tRPC procedures

import * as z from 'zod';
import type { ProcedureContext, AnyProcedure, BaseProcedureDef } from '@sylphlab/zen-query-shared';
import { RelayQueryBuilder } from './relay'; // Import RelayQueryBuilder
import { diffStatesToJsonPatch } from './utils/diff'; // Added import
import { JsonPatchOperationSchema, JsonPatchSchema, type JsonPatchOperation } from './utils/json-patch'; // Added import

// --- Core Types ---
// ProcedureContext is now imported from shared

/** Options passed to resolver/subscription functions */
export interface ProcedureOptions<TContext = ProcedureContext, TInput = unknown> { // Default TContext
    ctx: TContext;
    input: TInput;
}

/** Options passed specifically to legacy subscription resolvers */
export interface SubscriptionOptions<TContext = ProcedureContext, TInput = unknown, TOutput = unknown> extends ProcedureOptions<TContext, TInput> { // Default TContext
    /** Function to push data/deltas to the client */
    publish: (data: TOutput) => void;
}

/** Function signature for query/mutation resolvers */
export type Resolver<TInput = any, TOutput = any, TContext = ProcedureContext> = (opts: ProcedureOptions<TContext, TInput>) => Promise<TOutput> | TOutput; // Default TContext
// ProcedureOptions is implicitly exported via Resolver

/**
 * Function signature for legacy subscription resolvers.
 * Sets up the subscription and returns an unsubscribe/cleanup function.
 * @deprecated Use `.stream()` or `.streamDiff()` with async generators instead.
 */
export type SubscriptionResolver<TInput = any, TOutput = any, TContext = ProcedureContext> = (opts: SubscriptionOptions<TContext, TInput, TOutput>) => Promise<() => void> | (() => void); // Default TContext

/**
 * Type for the async generator function used in `.stream()` and internally by `.streamDiff()`.
 * It yields the data that will be sent to the client (full state or patches).
 */
export type SubscriptionStreamer<TInput = any, TStreamOutput = any, TContext = ProcedureContext> = (
    opts: ProcedureOptions<TContext, TInput>
) => AsyncGenerator<TStreamOutput, void, unknown>;

/**
 * Type for the user-provided async generator function used in `.streamDiff()`.
 * It yields the full state object whenever it changes.
 */
export type UserStreamer<TInput = any, TFullState = any, TContext = ProcedureContext> = (
    opts: ProcedureOptions<TContext, TInput>
) => AsyncGenerator<TFullState, void, unknown>;


// --- Procedure Definition ---

/** Internal definition of a procedure, extending the base */
export interface ProcedureDef<
    TContext = ProcedureContext,
    TInput = unknown,
    TOutput = unknown, // Output for query/mutation AND initial subscription state
    TSubscriptionOutput = unknown // Output for subscription stream (raw data or patches)
> extends BaseProcedureDef { // Extend BaseProcedureDef
    inputSchema?: z.ZodType<TInput>; // Zod schema for input validation/parsing
    outputSchema?: z.ZodType<TOutput>; // Zod schema for output validation/parsing (used for initial sub state too)
    subscriptionOutputSchema?: z.ZodType<TSubscriptionOutput>; // Schema for subscription stream data/deltas
    resolver?: Resolver<TInput, TOutput, TContext>;
    /** @deprecated Use subscriptionStreamer instead */
    legacySubscriptionResolver?: SubscriptionResolver<TInput, TSubscriptionOutput, TContext>; // Renamed
    subscriptionStreamer?: SubscriptionStreamer<TInput, TSubscriptionOutput, TContext>; // New field for async generator
    // meta?: TMeta; // Placeholder for metadata
}

// AnyProcedure is now imported from shared

// --- Builder Logic ---

/**
 * Base class/interface for the procedure builder chain.
 * Uses generics to track Context, Input, Output types.
 */
// Export the class
export class ProcedureBuilder<
    TContext = ProcedureContext, // Default context
    TInput = unknown,
    TOutput = unknown, // Output for query/mutation/initial sub state
    TSubscriptionOutput = unknown, // Output for subscription stream (raw or patch)
    TFullState = unknown // Full state type used internally by streamDiff wrapper
> {
    // Store the definition being built
    // Use `Partial<ProcedureDef<any, any, any, any>>` internally for flexibility during build steps
    protected _def: Partial<ProcedureDef<any, any, any, any>>;

    // Constructor takes the internal definition state
    constructor(initialDef: Partial<ProcedureDef<any, any, any, any>>) {
        this._def = initialDef;
    }

    /** Define the context type for subsequent steps */
    context<TNewContext extends ProcedureContext>(): ProcedureBuilder<TNewContext, TInput, TOutput, TSubscriptionOutput, TFullState> {
        // This doesn't change the definition, only the generic type for the next builder instance
        return this as unknown as ProcedureBuilder<TNewContext, TInput, TOutput, TSubscriptionOutput, TFullState>;
    }

    /** Define the input schema/validator */
    input<ZodSchema extends z.ZodType>(
        schema: ZodSchema
    ): ProcedureBuilder<TContext, z.infer<ZodSchema>, TOutput, TSubscriptionOutput, TFullState> {
        console.log(`[zenQuery Procedure] Defining input schema for ${this._def.type}...`);
        // Create a new builder instance with updated generic type inferred from ZodSchema
        const nextDef: Partial<ProcedureDef<TContext, z.infer<ZodSchema>, TOutput, TSubscriptionOutput>> = {
            ...this._def,
            inputSchema: schema as z.ZodType<z.infer<ZodSchema>>, // Store the schema
        };
        return new ProcedureBuilder<TContext, z.infer<ZodSchema>, TOutput, TSubscriptionOutput, TFullState>(nextDef);
    }

    /**
     * Define the output schema/validator.
     * For subscriptions, this schema validates the *initial* state if `.resolveInitial()` is used.
     * Use `.subscriptionOutput()` for the stream's output schema.
     */
    output<ZodSchema extends z.ZodType>(
        schema: ZodSchema
    ): ProcedureBuilder<TContext, TInput, z.infer<ZodSchema>, TSubscriptionOutput, TFullState> {
        console.log(`[zenQuery Procedure] Defining output schema for ${this._def.type}...`);
        // Create a new builder instance with updated generic type inferred from ZodSchema
        const nextDef: Partial<ProcedureDef<TContext, TInput, z.infer<ZodSchema>, TSubscriptionOutput>> = {
            ...(this._def as Partial<ProcedureDef<TContext, TInput, z.infer<ZodSchema>, TSubscriptionOutput>>), // Need cast here
            outputSchema: schema as z.ZodType<z.infer<ZodSchema>>, // Store the schema
        };
        return new ProcedureBuilder<TContext, TInput, z.infer<ZodSchema>, TSubscriptionOutput, TFullState>(nextDef);
    }

    /** Define the output schema/validator for the subscription stream */
    subscriptionOutput<ZodSchema extends z.ZodType>(
        schema: ZodSchema
    ): ProcedureBuilder<TContext, TInput, TOutput, z.infer<ZodSchema>, TFullState> {
        if (this._def.type !== 'subscription') {
            throw new Error("'.subscriptionOutput()' can only be used for subscriptions.");
        }
        console.log(`[zenQuery Procedure] Defining subscription output schema...`);
        // Create a new builder instance with updated generic type inferred from ZodSchema
        const nextDef: Partial<ProcedureDef<TContext, TInput, TOutput, z.infer<ZodSchema>>> = {
            ...(this._def as Partial<ProcedureDef<TContext, TInput, TOutput, z.infer<ZodSchema>>>), // Need cast here
            subscriptionOutputSchema: schema as z.ZodType<z.infer<ZodSchema>>, // Store the schema
        };
        return new ProcedureBuilder<TContext, TInput, TOutput, z.infer<ZodSchema>, TFullState>(nextDef);
    }


    /** Define the resolver function for a query or mutation */
    resolve(
        resolver: Resolver<TInput, TOutput, TContext> // Use correct generics from the builder state
    ): AnyProcedure {
        if (this._def.type === 'subscription') {
            // Guide user towards new methods
            throw new Error("Use '.stream()' or '.streamDiff()' for subscription procedures. Use '.resolveInitial()' for initial subscription data.");
        }
        console.log(`[zenQuery Procedure] Defining resolver for ${this._def.type}...`);
        const finalDef: ProcedureDef<TContext, TInput, TOutput, TSubscriptionOutput> = {
            ...(this._def as ProcedureDef<TContext, TInput, TOutput, TSubscriptionOutput>), // Cast existing def
             type: this._def.type!, // type is guaranteed by constructor
             resolver: resolver,
        };
        // Return the final procedure definition, cast to AnyProcedure for storage in router
        return { _def: finalDef } as AnyProcedure;
    }

    /**
     * Define the resolver function for the initial state of a subscription (optional).
     * The output of this resolver is validated against the schema set by `.output()`.
     */
    resolveInitial(
        resolver: Resolver<TInput, TOutput, TContext>
    ): ProcedureBuilder<TContext, TInput, TOutput, TSubscriptionOutput, TFullState> {
         if (this._def.type !== 'subscription') {
            throw new Error("'.resolveInitial()' can only be used for subscription procedures.");
        }
        console.log(`[zenQuery Procedure] Defining initial resolver for subscription...`);
        const nextDef: Partial<ProcedureDef<TContext, TInput, TOutput, TSubscriptionOutput>> = {
            ...(this._def as Partial<ProcedureDef<TContext, TInput, TOutput, TSubscriptionOutput>>),
            resolver: resolver, // Store the initial resolver in the standard 'resolver' field
        };
        // Return a new builder instance to allow chaining `.stream()` or `.streamDiff()`
        return new ProcedureBuilder<TContext, TInput, TOutput, TSubscriptionOutput, TFullState>(nextDef);
    }


    /**
     * Define the async generator for a subscription that yields the raw data to be sent.
     * The yielded data is validated against the schema set by `.subscriptionOutput()`.
     */
    stream(
        streamer: SubscriptionStreamer<TInput, TSubscriptionOutput, TContext> // Use correct generics
    ): AnyProcedure {
        if (this._def.type !== 'subscription') {
            throw new Error("Use '.resolve()' for query/mutation procedures.");
        }
        if (this._def.legacySubscriptionResolver) {
             console.warn("[zenQuery Procedure] '.stream()' called after '.legacySubscribe()'. The legacy resolver will be ignored.");
        }
        console.log(`[zenQuery Procedure] Defining subscription stream (raw)...`);
         const finalDef: ProcedureDef<TContext, TInput, TOutput, TSubscriptionOutput> = {
             ...(this._def as ProcedureDef<TContext, TInput, TOutput, TSubscriptionOutput>), // Cast existing def
             type: 'subscription', // Explicitly set type
             subscriptionStreamer: streamer, // Store the async generator
             legacySubscriptionResolver: undefined, // Ensure legacy is not used
         };
        // Return the final procedure definition, cast to AnyProcedure for storage in router
        return { _def: finalDef } as AnyProcedure;
    }

    /**
     * Define the async generator for a subscription that yields the full state.
     * zenQuery will automatically calculate JSON patches (RFC 6902) between yielded states
     * and stream the patches to the client.
     * The output schema for the stream is automatically set to `JsonPatchSchema`.
     *
     * @param fullStateSchema - A Zod schema validating the full state object yielded by the userStreamer.
     * @param userStreamer - An async generator function that yields the complete state object whenever it changes.
     */
    streamDiff<ZodFullStateSchema extends z.ZodType>(
        fullStateSchema: ZodFullStateSchema, // Schema for the state yielded by userStreamer
        userStreamer: UserStreamer<TInput, z.infer<ZodFullStateSchema>, TContext>
    ): AnyProcedure {
        if (this._def.type !== 'subscription') {
            throw new Error("Use '.resolve()' for query/mutation procedures.");
        }
         if (this._def.legacySubscriptionResolver) {
             console.warn("[zenQuery Procedure] '.streamDiff()' called after '.legacySubscribe()'. The legacy resolver will be ignored.");
        }
        if (this._def.subscriptionOutputSchema && this._def.subscriptionOutputSchema !== JsonPatchSchema) {
            console.warn("[zenQuery Procedure] '.subscriptionOutput()' was called before '.streamDiff()'. The output schema will be overridden by JsonPatchSchema.");
        }
        console.log(`[zenQuery Procedure] Defining subscription stream (diff)...`);

        // Define the internal streamer that wraps the user's streamer
        const internalStreamer: SubscriptionStreamer<TInput, JsonPatchOperation[], TContext> = async function* (opts) {
            let previousState: z.infer<ZodFullStateSchema> | undefined = undefined;
            const fullStateIterator = userStreamer(opts);

            for await (const newState of fullStateIterator) {
                try {
                    // Validate the new state yielded by the user's streamer
                    const validatedNewState = fullStateSchema.parse(newState);

                    if (previousState !== undefined) {
                        const patch = diffStatesToJsonPatch(previousState, validatedNewState);
                        if (patch.length > 0) {
                            yield patch; // Yield the calculated JSON patch array
                        }
                    }
                    previousState = validatedNewState; // Update previous state
                } catch (error) {
                    console.error("[zenQuery Procedure] Error processing state in streamDiff:", error);
                    // Decide error handling: re-throw, yield an error object, or terminate?
                    // For now, re-throwing will terminate the generator on the server-side.
                    // Consider yielding a specific error format if client-side handling is desired.
                    if (error instanceof z.ZodError) {
                         throw new Error(`Subscription state validation failed: ${error.message}`);
                    }
                    throw error; // Re-throw other errors
                }
            }
        };

         const finalDef: ProcedureDef<TContext, TInput, TOutput, JsonPatchOperation[]> = {
             ...(this._def as ProcedureDef<TContext, TInput, TOutput, JsonPatchOperation[]>), // Cast existing def
             type: 'subscription', // Explicitly set type
             subscriptionOutputSchema: JsonPatchSchema, // Set output to JSON Patch array schema
             subscriptionStreamer: internalStreamer, // Store the internal async generator
             legacySubscriptionResolver: undefined, // Ensure legacy is not used
         };
        // Return the final procedure definition
        return { _def: finalDef } as AnyProcedure;
    }


    /**
     * Define the resolver function for a subscription using the legacy callback mechanism.
     * @deprecated Use `.stream()` or `.streamDiff()` with async generators instead.
     */
    legacySubscribe(
        resolver: SubscriptionResolver<TInput, TSubscriptionOutput, TContext> // Use correct generics
    ): AnyProcedure {
        if (this._def.type !== 'subscription') {
            throw new Error("Use '.resolve()' for query/mutation procedures.");
        }
        if (this._def.subscriptionStreamer) {
             console.warn("[zenQuery Procedure] '.legacySubscribe()' called after '.stream()' or '.streamDiff()'. The async generator will be ignored.");
        }
        console.warn("[zenQuery Procedure] '.legacySubscribe()' is deprecated. Use '.stream()' or '.streamDiff()' instead.");
        console.log(`[zenQuery Procedure] Defining legacy subscription resolver...`);
         const finalDef: ProcedureDef<TContext, TInput, TOutput, TSubscriptionOutput> = {
             ...(this._def as ProcedureDef<TContext, TInput, TOutput, TSubscriptionOutput>), // Cast existing def
             type: 'subscription', // Explicitly set type
             legacySubscriptionResolver: resolver, // Store the legacy resolver
             subscriptionStreamer: undefined, // Ensure streamer is not used
         };
        // Return the final procedure definition, cast to AnyProcedure for storage in router
        return { _def: finalDef } as AnyProcedure;
    }

    /**
     * Switch to the Relay-specific builder for defining connections.
     * Only applicable to queries.
     */
    relay(): RelayQueryBuilder<TContext, undefined, undefined> {
        if (this._def.type !== 'query') {
            throw new Error("'.relay()' can only be used for query procedures.");
        }
        console.log(`[zenQuery Procedure] Switching to Relay builder...`);
        // Pass the current builder instance ('this') to the RelayQueryBuilder constructor
        return new RelayQueryBuilder<TContext, undefined, undefined>(this);
    }
}


/**
 * Initializes the procedure builder chain.
 * This acts like the initial `t.procedure` or `t.router` in tRPC.
 */
class ProcedureBuilderInitializer<TContext = ProcedureContext> { // Default context
    /** Starts building a Query procedure */
    get query() {
        // Provide initial definition with type
        // Add TFullState generic default
        return new ProcedureBuilder<TContext, unknown, unknown, unknown, unknown>({ type: 'query' });
    }

    /** Starts building a Mutation procedure */
    get mutation() {
        // Provide initial definition with type
        // Add TFullState generic default
        return new ProcedureBuilder<TContext, unknown, unknown, unknown, unknown>({ type: 'mutation' });
    }

    /** Starts building a Subscription procedure */
    get subscription() {
         // Provide initial definition with type
         // Add TFullState generic default
        return new ProcedureBuilder<TContext, unknown, unknown, unknown, unknown>({ type: 'subscription' });
    }
}

// --- Export ---

/**
 * Creates the initial object for defining procedures.
 * Pass the context type expected by your procedures.
 *
 * @example
 * const t = initzenQuery<AppContext>();
 * const appRouter = createRouter({
 *   getUser: t.query // Use the getter here
 *     .input(...)
 *     .resolve(...)
 * });
 */
export function initzenQuery<TContext = ProcedureContext>() { // Default context
    return new ProcedureBuilderInitializer<TContext>();
}


// Example usage (won't run here, just for illustration)
/*
interface MyContext extends ProcedureContext { userId?: string }
const t = initzenQuery<MyContext>();

// Example Zod schemas
const UserIdInput = z.object({ id: z.string().uuid() });
const UserOutput = z.object({ id: z.string().uuid(), name: z.string() });
const UpdateFilterInput = z.object({ filter: z.string().optional() });
// Example full state for streamDiff
const CounterStateSchema = z.object({ count: z.number(), lastUpdated: z.number().optional() });
// Output for raw stream
const UpdateDataOutput = z.object({ type: z.literal('update'), data: z.string(), timestamp: z.number() });


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

// Example using .stream() - yields raw data
const exampleRawStream = t.subscription
    .input(UpdateFilterInput)
    .subscriptionOutput(UpdateDataOutput) // Schema for the yielded data
    .stream(async function* ({ ctx, input }) {
        console.log("Raw stream started with filter:", input.filter);
        let i = 0;
        while (i < 5) { // Example: yield 5 updates then stop
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 sec
            // Yield data matching UpdateDataOutput schema
            yield { type: 'update', data: `Update #${i} at ${Date.now()}`, timestamp: Date.now() };
            i++;
        }
        console.log("Raw stream finished");
        // Generator implicitly finishes here
    });

// Example using .streamDiff() - yields full state, streams patches
const exampleDiffStream = t.subscription
    .input(z.object({ startValue: z.number().optional() }))
    // No .subscriptionOutput() needed, it's set to JsonPatchSchema automatically
    // .output(CounterStateSchema) // Optional: Define schema for initial state if using .resolveInitial()
    // .resolveInitial(({ input }) => { // Optional: Provide initial state
    //     return { count: input.startValue ?? 0, lastUpdated: Date.now() };
    // })
    .streamDiff(CounterStateSchema, async function* ({ input }) {
        let currentState = { count: input.startValue ?? 0 };
        console.log("Diff stream starting state:", currentState);
        yield currentState; // Yield initial state

        for (let i = 0; i < 5; i++) {
            await new Promise(resolve => setTimeout(resolve, 1200)); // Wait 1.2 sec
            currentState = {
                ...currentState,
                count: currentState.count + 1,
                lastUpdated: Date.now()
            };
            console.log("Diff stream yielding new state:", currentState);
            yield currentState; // Yield the full new state
        }
        console.log("Diff stream finished");
    });

*/

console.log("packages/core/src/server/procedure.ts loaded");
// --- End Builder Logic ---


// Removed deprecated code block
