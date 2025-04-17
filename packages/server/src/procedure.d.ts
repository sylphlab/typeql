import * as z from 'zod';
import type { ProcedureContext, AnyProcedure, BaseProcedureDef } from '@sylphlab/typeql-shared';
/** Options passed to resolver/subscription functions */
export interface ProcedureOptions<TContext = ProcedureContext, TInput = unknown> {
    ctx: TContext;
    input: TInput;
}
/** Options passed specifically to subscription resolvers */
export interface SubscriptionOptions<TContext = ProcedureContext, TInput = unknown, TOutput = unknown> extends ProcedureOptions<TContext, TInput> {
    /** Function to push data/deltas to the client */
    publish: (data: TOutput) => void;
}
/** Function signature for query/mutation resolvers */
export type Resolver<TInput = any, TOutput = any, TContext = ProcedureContext> = (opts: ProcedureOptions<TContext, TInput>) => Promise<TOutput> | TOutput;
/**
 * Function signature for subscription resolvers.
 * Sets up the subscription and returns an unsubscribe/cleanup function.
 */
export type SubscriptionResolver<TInput = any, TOutput = any, TContext = ProcedureContext> = (opts: SubscriptionOptions<TContext, TInput, TOutput>) => Promise<() => void> | (() => void);
/** Internal definition of a procedure */
export interface ProcedureDef<TContext = ProcedureContext, TInput = unknown, TOutput = unknown, TSubscriptionOutput = unknown> {
    type: 'query' | 'mutation' | 'subscription';
    inputSchema?: z.ZodType<TInput>;
    outputSchema?: z.ZodType<TOutput>;
    subscriptionOutputSchema?: z.ZodType<TSubscriptionOutput>;
    resolver?: Resolver<TInput, TOutput, TContext>;
    subscriptionResolver?: SubscriptionResolver<TInput, TSubscriptionOutput, TContext>;
}
/** Internal definition of a procedure, extending the base */
export interface ProcedureDef<TContext = ProcedureContext, TInput = unknown, TOutput = unknown, TSubscriptionOutput = unknown> extends BaseProcedureDef {
    inputSchema?: z.ZodType<TInput>;
    outputSchema?: z.ZodType<TOutput>;
    subscriptionOutputSchema?: z.ZodType<TSubscriptionOutput>;
    resolver?: Resolver<TInput, TOutput, TContext>;
    subscriptionResolver?: SubscriptionResolver<TInput, TSubscriptionOutput, TContext>;
}
/**
 * Base class/interface for the procedure builder chain.
 * Uses generics to track Context, Input, Output types.
 */
declare class ProcedureBuilder<TContext = ProcedureContext, // Default context
TInput = unknown, TOutput = unknown, // Output for query/mutation
TSubscriptionOutput = unknown> {
    protected _def: Partial<ProcedureDef<any, any, any, any>>;
    constructor(initialDef: Partial<ProcedureDef<any, any, any, any>>);
    /** Define the context type for subsequent steps */
    context<TNewContext extends ProcedureContext>(): ProcedureBuilder<TNewContext, TInput, TOutput, TSubscriptionOutput>;
    /** Define the input schema/validator */
    input<ZodSchema extends z.ZodType>(schema: ZodSchema): ProcedureBuilder<TContext, z.infer<ZodSchema>, TOutput, TSubscriptionOutput>;
    /** Define the output schema/validator (for query/mutation) */
    output<ZodSchema extends z.ZodType>(schema: ZodSchema): ProcedureBuilder<TContext, TInput, z.infer<ZodSchema>, TSubscriptionOutput>;
    /** Define the output schema/validator for the subscription stream */
    subscriptionOutput<ZodSchema extends z.ZodType>(schema: ZodSchema): ProcedureBuilder<TContext, TInput, TOutput, z.infer<ZodSchema>>;
    /** Define the resolver function for a query or mutation */
    resolve(resolver: Resolver<TInput, TOutput, TContext>): AnyProcedure;
    /** Define the resolver function for a subscription */
    subscribe(resolver: SubscriptionResolver<TInput, TSubscriptionOutput, TContext>): AnyProcedure;
}
/**
 * Initializes the procedure builder chain.
 * This acts like the initial `t.procedure` or `t.router` in tRPC.
 */
declare class ProcedureBuilderInitializer<TContext = ProcedureContext> {
    /** Starts building a Query procedure */
    get query(): ProcedureBuilder<TContext, unknown, unknown, unknown>;
    /** Starts building a Mutation procedure */
    get mutation(): ProcedureBuilder<TContext, unknown, unknown, unknown>;
    /** Starts building a Subscription procedure */
    get subscription(): ProcedureBuilder<TContext, unknown, unknown, unknown>;
}
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
export declare function initTypeQL<TContext = ProcedureContext>(): ProcedureBuilderInitializer<TContext>;
export {};
//# sourceMappingURL=procedure.d.ts.map