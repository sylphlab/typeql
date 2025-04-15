// packages/core/src/server/requestHandler.ts

import type { AnyRouter, ProcedureRouterRecord } from './router';
import type { AnyProcedure, ProcedureContext, ProcedureDef, ProcedureOptions } from './procedure';
import { ZodError } from 'zod';

// --- Request/Response Types (Simplified for now) ---

/** Represents an incoming procedure call */
export interface ProcedureCall {
    /** Path to the procedure (e.g., 'user.get' or 'item.list') */
    path: string;
    /** Input data for the procedure */
    input?: unknown;
    /** Type of procedure */
    type: 'query' | 'mutation' | 'subscription';
}

/** Represents the result of a query or mutation call */
export interface ProcedureResult {
    /** The data returned by the procedure */
    data?: unknown;
    /** Error information, if any */
    error?: {
        message: string;
        code?: string; // e.g., 'BAD_REQUEST', 'UNAUTHORIZED', 'INTERNAL_SERVER_ERROR'
        // stack?: string; // Optional stack trace in dev
    };
}

// --- Helper Functions ---

/**
 * Recursively finds a procedure definition within a router based on a path.
 * @param router Router definition object
 * @param path Array of path segments (e.g., ['user', 'get'])
 * @returns The procedure definition or undefined if not found
 */
function findProcedure(
    routerProcedures: ProcedureRouterRecord,
    path: string[]
): AnyProcedure | undefined {
    const currentPathSegment = path[0];
    if (!currentPathSegment || !routerProcedures[currentPathSegment]) {
        return undefined; // Path segment not found
    }

    const potentialTarget = routerProcedures[currentPathSegment];

    if (path.length === 1) {
        // Last segment, should be a procedure
        if (potentialTarget && !(potentialTarget as AnyRouter)._def?.router) {
            return potentialTarget as AnyProcedure;
        }
        return undefined; // Found a router, not a procedure at the end
    } else {
        // More segments remaining, should be a router
        if (potentialTarget && (potentialTarget as AnyRouter)._def?.router) {
            return findProcedure((potentialTarget as AnyRouter)._def.procedures, path.slice(1));
        }
        return undefined; // Found a procedure mid-path or segment not found
    }
}

// --- Request Handler ---

export interface RequestHandlerOptions<TContext extends ProcedureContext> {
    router: AnyRouter;
    createContext: () => Promise<TContext> | TContext; // Function to create context per request
    // onError?: (error: any) => void; // Optional global error handler
}

/**
 * Creates a function that handles incoming procedure calls against a specific router.
 *
 * @param opts Options including the router and context creation function.
 * @returns An async function that takes a ProcedureCall and returns a ProcedureResult.
 */
export function createRequestHandler<TContext extends ProcedureContext>(
    opts: RequestHandlerOptions<TContext>
): (call: ProcedureCall) => Promise<ProcedureResult> {
    const { router, createContext } = opts;

    return async (call: ProcedureCall): Promise<ProcedureResult> => {
        console.log(`[TypeQL Handler] Handling ${call.type} call to path: ${call.path}`);

        const pathSegments = call.path.split('.');
        const procedure = findProcedure(router._def.procedures, pathSegments);

        if (!procedure) {
            console.error(`[TypeQL Handler] Procedure not found for path: ${call.path}`);
            return { error: { message: `Procedure not found: ${call.path}`, code: 'NOT_FOUND' } };
        }

        const procDef = procedure._def as ProcedureDef<TContext, any, any, any>; // Cast for internal use

        // Check if the procedure type matches the call type
        if (procDef.type !== call.type) {
             console.error(`[TypeQL Handler] Mismatched procedure type for path: ${call.path}. Expected ${procDef.type}, got ${call.type}`);
             return { error: { message: `Cannot call ${procDef.type} procedure using ${call.type}`, code: 'BAD_REQUEST' } };
        }

        // Handle subscriptions separately (basic placeholder for now)
        if (call.type === 'subscription') {
            // TODO: Implement actual subscription setup and management
            console.warn(`[TypeQL Handler] Subscription handling for '${call.path}' not fully implemented.`);
             // This handler likely needs modification to support streaming/async iterators for subscriptions
             // For now, return an error or specific response indicating subscription setup required.
            return { error: { message: 'Subscription setup not yet supported via this handler', code: 'NOT_IMPLEMENTED' } };
        }

        try {
            // 1. Create Context
            const ctx = await createContext();

            // 2. Parse Input
            let parsedInput: unknown = call.input; // Default to raw input
            if (procDef.inputSchema) {
                try {
                    parsedInput = procDef.inputSchema.parse(call.input);
                    console.log(`[TypeQL Handler] Input parsed successfully for path: ${call.path}`);
                } catch (error) {
                    if (error instanceof ZodError) {
                        console.error(`[TypeQL Handler] Input validation failed for path ${call.path}:`, error.errors);
                        return { error: { message: 'Input validation failed', code: 'BAD_REQUEST', /* errors: error.flatten() */ } };
                    }
                    throw error; // Re-throw unexpected errors
                }
            }

            // 3. Execute Resolver (Query/Mutation)
            const options: ProcedureOptions<TContext, unknown> = { ctx, input: parsedInput };
            const result = await procDef.resolver!(options); // We know resolver exists for query/mutation

            // 4. Parse Output (Optional, primarily for ensuring correct shape)
            let finalOutput: unknown = result;
            if (procDef.outputSchema) {
                try {
                    finalOutput = procDef.outputSchema.parse(result);
                     console.log(`[TypeQL Handler] Output parsed successfully for path: ${call.path}`);
                } catch (error) {
                     if (error instanceof ZodError) {
                        // This is an internal server error, as the resolver returned unexpected data
                        console.error(`[TypeQL Handler] Output validation failed for path ${call.path}:`, error.errors);
                        // Should not expose detailed validation errors to client here
                        return { error: { message: 'Internal server error: Invalid procedure output', code: 'INTERNAL_SERVER_ERROR' } };
                     }
                     throw error;
                }
            }

            console.log(`[TypeQL Handler] Call successful for path: ${call.path}`);
            return { data: finalOutput };

        } catch (error: any) {
            console.error(`[TypeQL Handler] Error executing procedure ${call.path}:`, error);
            // TODO: Map errors to specific codes (e.g., auth errors)
            return { error: { message: error.message || 'An unexpected error occurred', code: 'INTERNAL_SERVER_ERROR' } };
        }
    };
}

console.log("packages/core/src/server/requestHandler.ts loaded");
