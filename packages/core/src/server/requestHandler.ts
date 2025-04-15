// packages/core/src/server/requestHandler.ts

import { createServerSequenceManager, ServerSequenceManager } from '../core/seqManager'; // Import sequence manager
import type { AnyRouter, ProcedureRouterRecord } from './router';
import type { AnyProcedure, ProcedureContext, ProcedureDef, ProcedureOptions, SubscriptionOptions } from './procedure';
import { ZodError } from 'zod';
import type { SubscriptionManager } from './subscriptionManager'; // Import manager type
import type { TypeQLTransport, SubscriptionDataMessage } from '../core/types'; // Import transport and message types

// --- Request/Response Types (Simplified for now) ---

/** Represents an incoming procedure call */
export interface ProcedureCall {
    /** Path to the procedure (e.g., 'user.get' or 'item.list') */
    path: string;
    /** Input data for the procedure */
    input?: unknown;
    /** Type of procedure */
    type: 'query' | 'mutation' | 'subscription';
    /** Unique ID for correlation, originates from client request/subscription */
    id: number | string;
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
    subscriptionManager: SubscriptionManager; // Add SubscriptionManager
    // How to get the specific transport/client connection for this request? Needs context.
    createContext: (opts: { transport?: TypeQLTransport; /* other context sources */ }) => Promise<TContext> | TContext;
    // onError?: (error: any) => void;
}

/**
 * Creates a function that handles incoming procedure calls against a specific router.
 *
 * @param opts Options including the router and context creation function.
 * @returns An async function that handles a ProcedureCall. For subscriptions, the return might differ or trigger side effects.
 */
export function createRequestHandler<TContext extends ProcedureContext>(
    opts: RequestHandlerOptions<TContext>
): (call: ProcedureCall, transport?: TypeQLTransport /* Pass transport if available */) => Promise<ProcedureResult | void> { // Return void for handled subscriptions
    const { router, createContext, subscriptionManager } = opts;

    // Create a sequence manager for this request handler instance
    // TODO: Consider if this should be shared or per-topic? Global for now.
    const serverSequenceManager: ServerSequenceManager = createServerSequenceManager();
    let lastServerSeqMap = new Map<string, number>(); // Track last seq per subscription ID

    // This handler needs access to the specific client's transport for subscriptions
    return async (call: ProcedureCall, transport?: TypeQLTransport): Promise<ProcedureResult | void> => {
        console.log(`[TypeQL Handler] Handling ${call.type} call for path: ${call.path} (ID: ${call.id})`);

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

        try {
            // 1. Create Context (conditionally passing transport)
            const contextInput = transport ? { transport } : {};
            const ctx = await createContext(contextInput);

            // 2. Parse Input (Common for all types initially)
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

            // 3. Handle based on procedure type
            if (procDef.type === 'query' || procDef.type === 'mutation') {
                // Execute Resolver (Query/Mutation)
                const options: ProcedureOptions<TContext, unknown> = { ctx, input: parsedInput };
                const result = await procDef.resolver!(options);

                 // 4. Parse Output (Optional)
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

                 console.log(`[TypeQL Handler] ${call.type} call successful for path: ${call.path}`);
                 return { data: finalOutput }; // Return ProcedureResult for query/mutation

            } else if (procDef.type === 'subscription') {
                 // --- Subscription Handling ---
                 if (!transport) {
                     // Transport is required to manage subscriptions
                     console.error(`[TypeQL Handler] Transport required for subscription path: ${call.path}`);
                     return { error: { message: 'Transport unavailable for subscription', code: 'INTERNAL_SERVER_ERROR' } };
                 }
                 if (!procDef.subscriptionResolver) {
                      console.error(`[TypeQL Handler] Missing subscriptionResolver for path: ${call.path}`);
                      return { error: { message: 'Subscription resolver not implemented', code: 'INTERNAL_SERVER_ERROR' } };
                 }

                 const subId = call.id; // ID is now present on ProcedureCall

                 // TODO: How to get a unique clientId associated with the transport? For now, use subId as placeholder.
                 const clientId = `client_${subId}`; // Placeholder client ID

                 // Function for the resolver to publish data
                 const publish = (data: unknown) => {
                     // TODO: Optional output parsing using procDef.subscriptionOutputSchema?

                      // Get next sequence number
                      const currentServerSeq = serverSequenceManager.getNext();
                      const prevServerSeqValue = lastServerSeqMap.get(String(subId)); // Get previous seq for this specific sub
                      lastServerSeqMap.set(String(subId), currentServerSeq); // Update last seq for this sub

                      // Construct message, conditionally adding prevServerSeq
                      const dataMsg: SubscriptionDataMessage = {
                          type: 'subscriptionData',
                          id: subId, // Correlate with the original subscription request ID
                          data: data,
                          serverSeq: currentServerSeq, // Add sequence number
                          ...(prevServerSeqValue !== undefined && { prevServerSeq: prevServerSeqValue }) // Only add if defined
                      };
                       // Use the transport's 'send' method (if available) defined in the updated interface
                       if (transport?.send) {
                           console.log(`[TypeQL Handler] Publishing data for subId ${subId} via transport.send:`, data);
                           // Use Promise.resolve() to handle potential void return from transport.send
                           Promise.resolve(transport.send(dataMsg)).catch((sendErr: any) => {
                                console.error(`[TypeQL Handler] Error sending subscription data via transport.send for subId ${subId}:`, sendErr);
                                // Optional: Rollback sequence number? Might complicate things.
                           });
                      } else {
                          console.error(`[TypeQL Handler] Cannot publish data for subId ${subId}: Transport lacks 'send' method.`);
                          // Rollback sequence number if send fails immediately?
                          // serverSequenceManager.reset(currentServerSeq - 1); // Complicated logic, avoid for now
                      }
                 };

                 const subOptions: SubscriptionOptions<TContext, unknown, unknown> = { ctx, input: parsedInput, publish };

                 try {
                      // Execute the subscription resolver to set it up (use non-null assertion as check happened above)
                      const cleanupFn = await procDef.subscriptionResolver!(subOptions);

                      // Register the active subscription (pass transport for sending data back, assert non-null)
                      // Assuming addSubscription handles storing the cleanup function needed on unsubscribe
                      // Pass the transport instance (assert non-null as it was checked earlier)
                      subscriptionManager.addSubscription(
                            { type: 'subscription', id: subId, path: call.path, input: call.input }, // Reconstruct SubscribeMessage-like info
                            clientId,
                            transport!, // Pass the transport instance
                            // Pass the combined cleanup function directly as the 4th argument
                            () => {
                                 lastServerSeqMap.delete(String(subId)); // Clean up seq tracking on unsubscribe
                                 if (typeof cleanupFn === 'function') {
                                      cleanupFn(); // Call original cleanup
                                }
                           }
                      );

                      // Subscription setup successful, handler doesn't return data directly
                      console.log(`[TypeQL Handler] Subscription setup successful for path: ${call.path} (ID: ${subId})`);
                      return; // Return void or undefined for successful subscription setup

                 } catch (subError: any) {
                      console.error(`[TypeQL Handler] Error setting up subscription ${call.path}:`, subError);
                      return { error: { message: subError.message || 'Subscription setup failed', code: 'INTERNAL_SERVER_ERROR' } };
                 }
            }

        } catch (error: any) {
            // Catch errors during context creation or input parsing
            console.error(`[TypeQL Handler] Error processing request for ${call.path}:`, error);
            // Ensure return type matches Promise<ProcedureResult | void>
            return { error: { message: error.message || 'An unexpected error occurred', code: 'INTERNAL_SERVER_ERROR' } };
        }
    };
}

console.log("packages/core/src/server/requestHandler.ts loaded");
