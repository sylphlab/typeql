// packages/core/src/server/requestHandler.ts

import { createServerSequenceManager, ServerSequenceManager } from '../core/seqManager'; // Import sequence manager
import type { AnyRouter, ProcedureRouterRecord } from './router';
import type { AnyProcedure, ProcedureContext, ProcedureDef, ProcedureOptions, SubscriptionOptions } from './procedure';
import { ZodError } from 'zod';
import type { SubscriptionManager } from './subscriptionManager'; // Import manager type
import type { TypeQLTransport, SubscriptionDataMessage, ProcedureResultMessage, SubscriptionErrorMessage } from '../core/types'; // Import transport and message types

// --- Error Formatting Helper ---

/** Standard error codes */
type ErrorCode = 'BAD_REQUEST' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'METHOD_NOT_SUPPORTED' | 'TIMEOUT' | 'CONFLICT' | 'PRECONDITION_FAILED' | 'PAYLOAD_TOO_LARGE' | 'UNSUPPORTED_MEDIA_TYPE' | 'UNPROCESSABLE_CONTENT' | 'TOO_MANY_REQUESTS' | 'CLIENT_CLOSED_REQUEST' | 'INTERNAL_SERVER_ERROR';

interface FormattedError {
    message: string;
    code: ErrorCode;
    // Optionally include original error in dev?
    // originalError?: unknown;
}

/** Formats various errors into a standard structure */
function formatError(error: unknown, defaultCode: ErrorCode = 'INTERNAL_SERVER_ERROR'): FormattedError {
    let message = 'An unexpected error occurred';
    let code = defaultCode;

    if (error instanceof ZodError) {
        message = 'Input validation failed'; // Keep message generic for client
        code = 'BAD_REQUEST';
        // console.error("Zod Validation Error:", error.flatten()); // Log details server-side
    } else if (error instanceof Error) {
        message = error.message;
        // Allow specific error types to suggest codes?
        // if (error instanceof MyCustomError) code = error.code;
    } else if (typeof error === 'string') {
        message = error;
    }

    // Ensure code is a valid ErrorCode
    const validCodes: Record<ErrorCode, boolean> = {
        'BAD_REQUEST': true, 'UNAUTHORIZED': true, 'FORBIDDEN': true, 'NOT_FOUND': true,
        'METHOD_NOT_SUPPORTED': true, 'TIMEOUT': true, 'CONFLICT': true, 'PRECONDITION_FAILED': true,
        'PAYLOAD_TOO_LARGE': true, 'UNSUPPORTED_MEDIA_TYPE': true, 'UNPROCESSABLE_CONTENT': true,
        'TOO_MANY_REQUESTS': true, 'CLIENT_CLOSED_REQUEST': true, 'INTERNAL_SERVER_ERROR': true
    };
    if (!validCodes[code]) {
        code = 'INTERNAL_SERVER_ERROR';
    }


    return { message, code };
}


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
    /** Function to create context for each request */
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
    // Return type now uses ProcedureResultMessage for consistency
): (call: ProcedureCall, transport?: TypeQLTransport /* Pass transport if available */) => Promise<ProcedureResultMessage | void> { // Return void for handled subscriptions
    const { router, createContext, subscriptionManager } = opts;

    // Create a sequence manager for this request handler instance
    // TODO: Consider if this should be shared or per-topic? Global for now.
    const serverSequenceManager: ServerSequenceManager = createServerSequenceManager();
    let lastServerSeqMap = new Map<string, number>(); // Track last seq per subscription ID

    // This handler needs access to the specific client's transport for subscriptions
    return async (call: ProcedureCall, transport?: TypeQLTransport): Promise<ProcedureResultMessage | void> => {
        const startTime = Date.now();
        console.log(`[TypeQL Handler] Handling ${call.type} call for path: ${call.path} (ID: ${call.id})`);

        const pathSegments = call.path.split('.');
        const procedure = findProcedure(router._def.procedures, pathSegments);

        if (!procedure) {
            const error = formatError(`Procedure not found: ${call.path}`, 'NOT_FOUND');
            console.error(`[TypeQL Handler] ${error.code} for path ${call.path}: ${error.message}`);
            return { id: call.id, result: { type: 'error', error } };
        }

        const procDef = procedure._def as ProcedureDef<TContext, any, any, any>; // Cast for internal use

        // Check if the procedure type matches the call type
        if (procDef.type !== call.type) {
             const error = formatError(`Cannot call ${procDef.type} procedure using ${call.type}`, 'BAD_REQUEST');
             console.error(`[TypeQL Handler] ${error.code} for path ${call.path}: ${error.message}`);
             return { id: call.id, result: { type: 'error', error } };
        }

        try {
            // 1. Create Context
            // Pass transport and potentially other request-specific info (headers, etc.) if available
            // Explicitly handle undefined transport for exactOptionalPropertyTypes
            const contextInput: { transport?: TypeQLTransport } = {};
            if (transport) {
                contextInput.transport = transport;
            }
            const ctx: TContext = await createContext(contextInput); // Await context creation
            console.log(`[TypeQL Handler] Context created for request ${call.id}`);

            // 2. Parse Input (Common for all types initially)
            let parsedInput: unknown = call.input; // Default to raw input
            if (procDef.inputSchema) {
                try {
                    parsedInput = procDef.inputSchema.parse(call.input);
                    console.log(`[TypeQL Handler] Input parsed successfully for path: ${call.path}`);
                } catch (validationError) {
                    const error = formatError(validationError, 'BAD_REQUEST'); // ZodError handled by formatError
                    console.error(`[TypeQL Handler] ${error.code} for path ${call.path} (Input): ${error.message}`);
                    return { id: call.id, result: { type: 'error', error } };
                }
            }

            // 3. Handle based on procedure type
            if (procDef.type === 'query' || procDef.type === 'mutation') {
                let result: unknown;
                try {
                    // Execute Resolver (Query/Mutation)
                    const options: ProcedureOptions<TContext, unknown> = { ctx, input: parsedInput };
                    result = await procDef.resolver!(options); // Use non-null assertion after check
                } catch (resolverError) {
                    const error = formatError(resolverError, 'INTERNAL_SERVER_ERROR');
                    console.error(`[TypeQL Handler] ${error.code} during resolver execution for path ${call.path}: ${error.message}`);
                    return { id: call.id, result: { type: 'error', error } };
                }

                // 4. Parse Output (Optional)
                let finalOutput: unknown = result;
                if (procDef.outputSchema) {
                    try {
                        finalOutput = procDef.outputSchema.parse(result);
                        console.log(`[TypeQL Handler] Output parsed successfully for path: ${call.path}`);
                    } catch (validationError) {
                        // This is an internal server error, as the resolver returned unexpected data
                        const error = formatError(validationError, 'INTERNAL_SERVER_ERROR');
                        console.error(`[TypeQL Handler] ${error.code} for path ${call.path} (Output): ${error.message}`);
                        // Should not expose detailed validation errors to client here
                        return { id: call.id, result: { type: 'error', error: { ...error, message: 'Internal server error: Invalid procedure output' } } };
                    }
                }

                const duration = Date.now() - startTime;
                console.log(`[TypeQL Handler] ${call.type} call successful for path: ${call.path} (ID: ${call.id}, Duration: ${duration}ms)`);
                return { id: call.id, result: { type: 'data', data: finalOutput } }; // Return ProcedureResultMessage

            } else if (procDef.type === 'subscription') {
                 // --- Subscription Handling ---
                 if (!transport) {
                     const error = formatError('Transport unavailable for subscription', 'INTERNAL_SERVER_ERROR');
                     console.error(`[TypeQL Handler] ${error.code} for path ${call.path}: ${error.message}`);
                     return { id: call.id, result: { type: 'error', error } }; // Return error via ProcedureResultMessage
                 }
                 if (!procDef.subscriptionResolver) {
                      const error = formatError('Subscription resolver not implemented', 'INTERNAL_SERVER_ERROR');
                      console.error(`[TypeQL Handler] ${error.code} for path ${call.path}: ${error.message}`);
                      return { id: call.id, result: { type: 'error', error } }; // Return error via ProcedureResultMessage
                 }

                 const subId = call.id; // ID is now present on ProcedureCall

                 // TODO: How to get a unique clientId associated with the transport? For now, use subId as placeholder.
                 const clientId = `client_${subId}`; // Placeholder client ID

                 // Function for the resolver to publish data
                 const publish = (rawData: unknown) => {
                     let dataToPublish = rawData;
                     // Optional output parsing
                     if (procDef.subscriptionOutputSchema) {
                         try {
                             dataToPublish = procDef.subscriptionOutputSchema.parse(rawData);
                         } catch (validationError) {
                             const error = formatError(validationError, 'INTERNAL_SERVER_ERROR');
                             console.error(`[TypeQL Handler] Subscription output validation failed for subId ${subId}: ${error.message}`);
                             // Send error message instead of data
                             const errorMsg: SubscriptionErrorMessage = {
                                 type: 'subscriptionError',
                                 id: subId,
                                 error: { ...error, message: 'Internal server error: Invalid subscription output' }
                             };
                             if (transport?.send) {
                                 Promise.resolve(transport.send(errorMsg)).catch(sendErr => {
                                     console.error(`[TypeQL Handler] Error sending subscription error message for subId ${subId}:`, sendErr);
                                 });
                             }
                             return; // Stop publishing this invalid data
                         }
                     }

                     // Get next sequence number
                     const currentServerSeq = serverSequenceManager.getNext();
                     const prevServerSeqValue = lastServerSeqMap.get(String(subId));
                     lastServerSeqMap.set(String(subId), currentServerSeq);

                     const dataMsg: SubscriptionDataMessage = {
                         type: 'subscriptionData',
                         id: subId,
                         data: dataToPublish, // Use potentially parsed data
                         serverSeq: currentServerSeq,
                         ...(prevServerSeqValue !== undefined && { prevServerSeq: prevServerSeqValue })
                     };

                     if (transport?.send) {
                         console.debug(`[TypeQL Handler] Publishing data for subId ${subId} (Seq: ${currentServerSeq})`);
                         Promise.resolve(transport.send(dataMsg)).catch((sendErr: any) => {
                             console.error(`[TypeQL Handler] Error sending subscription data via transport.send for subId ${subId}:`, sendErr);
                             // Attempt to send an error message to the client about the failure
                             const error = formatError(sendErr, 'INTERNAL_SERVER_ERROR');
                             const errorMsg: SubscriptionErrorMessage = {
                                 type: 'subscriptionError',
                                 id: subId,
                                 error: { ...error, message: `Failed to send update: ${error.message}` }
                             };
                             // Nested catch for sending the error message itself
                             // Check if transport.send exists before calling
                             if (transport?.send) {
                                 Promise.resolve(transport.send(errorMsg)).catch(errMsgErr => {
                                     console.error(`[TypeQL Handler] CRITICAL: Failed even to send error message for subId ${subId}:`, errMsgErr);
                                 });
                             }
                             // Consider cleanup or marking subscription as potentially broken?
                         });
                     } else {
                         console.error(`[TypeQL Handler] Cannot publish data for subId ${subId}: Transport lacks 'send' method.`);
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

                 } catch (subSetupError: any) {
                     const error = formatError(subSetupError, 'INTERNAL_SERVER_ERROR');
                     console.error(`[TypeQL Handler] ${error.code} during subscription setup for path ${call.path}: ${error.message}`);
                     // Send error back as a ProcedureResultMessage for the initial setup failure
                     return { id: call.id, result: { type: 'error', error } };
                 }
            }

        } catch (outerError: any) {
            // Catch errors during context creation or initial checks
            const error = formatError(outerError, 'INTERNAL_SERVER_ERROR');
            console.error(`[TypeQL Handler] ${error.code} processing request for ${call.path}: ${error.message}`);
            // Ensure return type matches Promise<ProcedureResultMessage | void>
            return { id: call.id, result: { type: 'error', error } };
        }
    };
}

console.log("packages/core/src/server/requestHandler.ts loaded");
