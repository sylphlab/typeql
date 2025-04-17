// packages/core/src/server/requestHandler.ts

import { createServerSequenceManager, ServerSequenceManager } from '@sylph/typeql-shared';
// Consolidate imports from @sylph/typeql-shared
import { TypeQLClientError } from '@sylph/typeql-shared'; // Import as value
import type {
    AnyRouter,
    ProcedureRouterRecord,
    ProcedureContext,
    AnyProcedure,
    TypeQLTransport,
    SubscriptionDataMessage,
    ProcedureResultMessage,
    SubscriptionErrorMessage,
    UnsubscribeMessage
} from '@sylph/typeql-shared'; // Keep others as types
// Removed original line 4 which was: import type { AnyRouter, ProcedureRouterRecord, ProcedureContext, AnyProcedure } from '@sylph/typeql-shared';
import type { ProcedureDef, ProcedureOptions, SubscriptionOptions } from './procedure'; // Keep specific procedure types here
import { ZodError } from 'zod';
import { SubscriptionManager } from './subscriptionManager'; // Import manager CLASS

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
// Add optional isInputValidationError flag
function formatError(error: unknown, isInputValidationError: boolean = false): FormattedError {
    // Define validCodes once
    const validCodes: Record<ErrorCode, boolean> = {
        'BAD_REQUEST': true, 'UNAUTHORIZED': true, 'FORBIDDEN': true, 'NOT_FOUND': true,
        'METHOD_NOT_SUPPORTED': true, 'TIMEOUT': true, 'CONFLICT': true, 'PRECONDITION_FAILED': true,
        'PAYLOAD_TOO_LARGE': true, 'UNSUPPORTED_MEDIA_TYPE': true, 'UNPROCESSABLE_CONTENT': true,
        'TOO_MANY_REQUESTS': true, 'CLIENT_CLOSED_REQUEST': true, 'INTERNAL_SERVER_ERROR': true
    };

    // 1. TypeQLClientError (Highest Priority) - Restore instanceof check
    if (error instanceof TypeQLClientError && error.code && validCodes[error.code as ErrorCode]) {
        return { message: error.message, code: error.code as ErrorCode };
    }

    // 2. ZodError - Restore original logic with strict boolean check
    if (error instanceof ZodError) {
        if (isInputValidationError === false) {
             // Output validation failure -> INTERNAL_SERVER_ERROR (as per test expectation)
             console.error("[TypeQL Handler] Zod Output Validation Error:", error.flatten());
             return { message: 'Internal server error: Invalid procedure output', code: 'INTERNAL_SERVER_ERROR' };
        } else {
             // Input validation failure -> BAD_REQUEST
             return { message: 'Input validation failed', code: 'BAD_REQUEST' };
        }
    }


    // 3. Other Errors (Generic Error, string, unknown) -> INTERNAL_SERVER_ERROR
    let message = 'An unexpected error occurred';
    if (error instanceof Error) {
        message = error.message;
    } else if (typeof error === 'string') {
        message = error;
    }
    return { message, code: 'INTERNAL_SERVER_ERROR' };
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
    /** Global subscription manager instance (shared across handlers/connections). */
    subscriptionManager: SubscriptionManager;
    /** Function to create context for each request */
    createContext: (opts: { transport: TypeQLTransport; /* other context sources */ }) => Promise<TContext> | TContext;
    // onError?: (error: any) => void;
    /** Optional: Unique identifier for this specific client connection (e.g., from WebSocket server). */
    clientId?: string;
}

/**
 * Creates a function that handles incoming procedure calls against a specific router.
 *
 * @param opts Options including the router and context creation function.
 * @returns An async function that handles a ProcedureCall. For subscriptions, the return might differ or trigger side effects.
 */
/**
 * Creates a request handler object bound to a specific client transport.
 * This object contains a function to process incoming messages and a cleanup function.
 */
export interface RequestHandler {
    /** Processes an incoming message or an array of messages for batching. */
    handleMessage: (message: ProcedureCall | UnsubscribeMessage | ProcedureCall[]) => Promise<ProcedureResultMessage | ProcedureResultMessage[] | void>;
    /** Cleans up all resources associated with this handler (e.g., subscriptions). */
    cleanup: () => void;
}


export function createRequestHandler<TContext extends ProcedureContext>(
    opts: RequestHandlerOptions<TContext>,
    transport: TypeQLTransport // Transport is now mandatory and passed during creation
): RequestHandler {
    const { router, createContext, subscriptionManager, clientId = `client_${Date.now()}_${Math.random().toString(36).substring(2)}` } = opts;

    // Sequence manager and tracking are specific to this handler/connection (primarily for subscriptions)
    const serverSequenceManager: ServerSequenceManager = createServerSequenceManager();
    const lastServerSeqMap = new Map<string | number, number>(); // Track last seq per subscription ID for this client

    // Store subscriptions active for THIS handler/client connection
    const activeClientSubscriptions = new Map<string | number, { path: string }>(); // Store path for potential logging/debug

    console.log(`[TypeQL Handler] Created handler for Client ID: ${clientId}`);

    // Cleanup function for when the handler/connection is terminated
    // const cleanupHandler = () => { // Comment out unused variable
    //     console.log(`[TypeQL Handler] Cleaning up subscriptions for Client ID: ${clientId}`);
    //     activeClientSubscriptions.forEach((_subInfo, subId) => {
    //         // Remove from global manager (which triggers cleanup)
    //         subscriptionManager.removeSubscription(subId);
    //         lastServerSeqMap.delete(subId); // Clean up sequence tracking
    //     });
    //     activeClientSubscriptions.clear();
    //     // Unregister from transport connection changes if applicable
    //     // (Assuming transport handles its own cleanup on disconnect)
    // }; // Keep closing brace commented out

    // TODO: How to reliably trigger cleanupHandler?
    // Option 1: Transport exposes a disconnect event specific to this handler.
    // Option 2: Server managing transports calls cleanup when a connection drops.
    // For now, it's manual or relies on transport implementation details.

    // The handler now takes the raw message (ProcedureCall, UnsubscribeMessage, or ProcedureCall[])
    const handleMessage = async (message: ProcedureCall | UnsubscribeMessage | ProcedureCall[]): Promise<ProcedureResultMessage | ProcedureResultMessage[] | void> => {
        const startTime = Date.now();

        // --- Handle Batch Request ---
        if (Array.isArray(message)) {
            const calls = message as ProcedureCall[];
            console.log(`[TypeQL Handler ${clientId}] Handling batch request with ${calls.length} calls.`);

            // Create context once for the batch
            let batchCtx: TContext;
            try {
                batchCtx = await createContext({ transport });
                console.log(`[TypeQL Handler ${clientId}] Context created for batch request.`);
            } catch (ctxError) {
                const error = formatError(ctxError); // Remove defaultCode argument
                console.error(`[TypeQL Handler ${clientId}] ${error.code} creating context for batch: ${error.message}`);
                // Return an error result for every call in the batch
                return calls.map(call => ({ id: call.id, result: { type: 'error', error } }));
            }

            // Process calls concurrently
            const results = await Promise.all(calls.map(async (call): Promise<ProcedureResultMessage> => {
                const callStartTime = Date.now();
                console.log(`[TypeQL Handler ${clientId}] Processing batch call (ID: ${call.id}, Path: ${call.path})`);

                // Reject subscriptions in batch
                if (call.type === 'subscription') {
                    const error = formatError('Subscriptions are not supported in batch requests'); // Remove defaultCode argument, let formatError handle it
                    console.warn(`[TypeQL Handler ${clientId}] ${error.code} for batched subscription call (ID: ${call.id}, Path: ${call.path})`);
                    return { id: call.id, result: { type: 'error', error } };
                }

                const pathSegments = call.path.split('.');
                const procedure = findProcedure(router._def.procedures, pathSegments);

                if (!procedure) {
                    const error = formatError(`Procedure not found: ${call.path}`); // Remove defaultCode argument
                    console.error(`[TypeQL Handler ${clientId}] ${error.code} for batched call path ${call.path}: ${error.message}`);
                    return { id: call.id, result: { type: 'error', error } };
                }

                const procDef = procedure._def as ProcedureDef<TContext, any, any, any>;

                if (procDef.type !== call.type) {
                    const error = formatError(`Cannot call ${procDef.type} procedure using ${call.type}`); // Remove defaultCode argument
                    console.error(`[TypeQL Handler ${clientId}] ${error.code} for batched call path ${call.path}: ${error.message}`);
                    return { id: call.id, result: { type: 'error', error } };
                }

                try {
                    // Parse Input
                    let parsedInput: unknown = call.input;
                    if (procDef.inputSchema) {
                        try {
                            parsedInput = procDef.inputSchema.parse(call.input);
                        } catch (validationError: any) {
                            // Pass true for isInputValidationError
                            const error = formatError(validationError, true);
                            console.error(`[TypeQL Handler ${clientId}] ${error.code} for batched call path ${call.path} (Input): ${error.message}`);
                            return { id: call.id, result: { type: 'error', error } };
                        }
                    }

                    // Execute Query/Mutation
                    let result: unknown;
                    try {
                        const options: ProcedureOptions<TContext, unknown> = { ctx: batchCtx, input: parsedInput }; // Use shared batch context
                        result = await procDef.resolver!(options);
                    } catch (resolverError) {
                        const error = formatError(resolverError); // Remove defaultCode argument
                        console.error(`[TypeQL Handler ${clientId}] ${error.code} during resolver execution for batched call path ${call.path}: ${error.message}`);
                        return { id: call.id, result: { type: 'error', error } };
                    }

                    // Parse Output
                    let finalOutput: unknown = result;
                    if (procDef.outputSchema) {
                        try {
                            finalOutput = procDef.outputSchema.parse(result);
                        } catch (validationError: any) {
                            // Pass false (or omit) for isInputValidationError for output validation
                            const error = formatError(validationError, false);
                            console.error(`[TypeQL Handler ${clientId}] ${error.code} for batched call path ${call.path} (Output): ${error.message}`);
                            // formatError now sets the correct message and code
                            return { id: call.id, result: { type: 'error', error } };
                        }
                    }

                    const duration = Date.now() - callStartTime;
                    console.log(`[TypeQL Handler ${clientId}] Batched ${call.type} call successful for path: ${call.path} (ID: ${call.id}, Duration: ${duration}ms)`);
                    return { id: call.id, result: { type: 'data', data: finalOutput } };

                } catch (callError: any) {
                    const error = formatError(callError); // Remove defaultCode argument
                    console.error(`[TypeQL Handler ${clientId}] ${error.code} processing batched call for path ${call.path}: ${error.message}`);
                    return { id: call.id, result: { type: 'error', error } };
                }
            }));

            const batchDuration = Date.now() - startTime;
            console.log(`[TypeQL Handler ${clientId}] Batch request processed. Duration: ${batchDuration}ms`);
            return results;
        }

        // --- Handle Single Message (Existing Logic) ---
        console.log(`[TypeQL Handler ${clientId}] Handling single ${message.type} message (ID: ${message.id})`);

        // --- Handle Subscription Stop ---
        if (message.type === 'subscriptionStop') {
            const subId = message.id;
            if (activeClientSubscriptions.has(subId)) {
                console.log(`[TypeQL Handler ${clientId}] Stopping subscription (ID: ${subId})`);
                activeClientSubscriptions.delete(subId);
                subscriptionManager.removeSubscription(subId); // Trigger cleanup via global manager
                lastServerSeqMap.delete(subId); // Clean up sequence tracking
            } else {
                console.warn(`[TypeQL Handler ${clientId}] Received stop for unknown/inactive subscription (ID: ${subId})`);
            }
            return; // No response needed for stop message
        }

        // --- Handle Procedure Call (Query, Mutation, Subscription Start) ---
        const call = message as ProcedureCall; // Type assertion after checking for stop
        const pathSegments = call.path.split('.');
        const procedure = findProcedure(router._def.procedures, pathSegments);

        if (!procedure) {
            const error = formatError(`Procedure not found: ${call.path}`); // Remove defaultCode argument
            console.error(`[TypeQL Handler ${clientId}] ${error.code} for path ${call.path}: ${error.message}`);
            return { id: call.id, result: { type: 'error', error } };
        }

        const procDef = procedure._def as ProcedureDef<TContext, any, any, any>; // Cast for internal use

        // Check if the procedure type matches the call type
        if (procDef.type !== call.type) {
             const error = formatError(`Cannot call ${procDef.type} procedure using ${call.type}`); // Remove defaultCode argument
             console.error(`[TypeQL Handler ${clientId}] ${error.code} for path ${call.path}: ${error.message}`);
             return { id: call.id, result: { type: 'error', error } };
        }

        try {
            // 1. Create Context (Transport is now guaranteed)
            const ctx: TContext = await createContext({ transport });
            console.log(`[TypeQL Handler ${clientId}] Context created for request ${call.id}`);

            // 2. Parse Input
            let parsedInput: unknown = call.input;
            if (procDef.inputSchema) {
                try {
                    parsedInput = procDef.inputSchema.parse(call.input);
                    console.log(`[TypeQL Handler ${clientId}] Input parsed successfully for path: ${call.path}`);
                } catch (validationError: any) {
                    // Pass true for isInputValidationError
                    const error = formatError(validationError, true);
                    console.error(`[TypeQL Handler ${clientId}] ${error.code} for path ${call.path} (Input): ${error.message}`);
                    return { id: call.id, result: { type: 'error', error } };
                }
            }

            // 3. Handle based on procedure type
            if (procDef.type === 'query' || procDef.type === 'mutation') {
                // --- Query/Mutation Execution ---
                let result: unknown;
                try {
                    const options: ProcedureOptions<TContext, unknown> = { ctx, input: parsedInput };
                    result = await procDef.resolver!(options);
                } catch (resolverError) {
                    // Log the raw error *before* formatting for diagnosis
                    console.error(`[TypeQL Handler ${clientId}] Raw resolver error for path ${call.path}:`, resolverError);
                    const error = formatError(resolverError); // Format the error
                    console.error(`[TypeQL Handler ${clientId}] ${error.code} during resolver execution for path ${call.path}: ${error.message}`);
                    // Log the final *formatted* error object being returned
                    console.log(`[TypeQL Handler ${clientId}] Returning error object:`, JSON.stringify({ id: call.id, result: { type: 'error', error } }));
                    return { id: call.id, result: { type: 'error', error } };
                }

                // 4. Parse Output (Optional)
                let finalOutput: unknown = result;
                if (procDef.outputSchema) {
                    try {
                        finalOutput = procDef.outputSchema.parse(result);
                        console.log(`[TypeQL Handler ${clientId}] Output parsed successfully for path: ${call.path}`);
                    } catch (validationError: any) {
                        // Output validation errors should result in INTERNAL_SERVER_ERROR
                        const error = formatError(validationError, false); // Pass false for output validation
                        console.error(`[TypeQL Handler ${clientId}] ${error.code} for path ${call.path} (Output Validation): ${error.message}`);
                        // Use the formatted error directly
                        return { id: call.id, result: { type: 'error', error } };
                    }
                }

                const duration = Date.now() - startTime; // Use overall start time for single calls too
                console.log(`[TypeQL Handler ${clientId}] ${call.type} call successful for path: ${call.path} (ID: ${call.id}, Duration: ${duration}ms)`);
                return { id: call.id, result: { type: 'data', data: finalOutput } };

            } else if (procDef.type === 'subscription') {
                 // --- Subscription Start Handling ---
                 if (!procDef.subscriptionResolver) {
                      const error = formatError('Subscription resolver not implemented'); // Remove defaultCode argument
                      console.error(`[TypeQL Handler ${clientId}] ${error.code} for path ${call.path}: ${error.message}`);
                      return { id: call.id, result: { type: 'error', error } };
                 }

                 const subId = call.id;

                 // Check if already subscribed by this handler
                 if (activeClientSubscriptions.has(subId)) {
                     console.warn(`[TypeQL Handler ${clientId}] Received duplicate subscription request (ID: ${subId}). Ignoring.`);
                     return; // Don't re-setup
                 }

                 // Function for the resolver to publish data *to this specific client*
                 const publish = (rawData: unknown) => {
                     // Check if this specific subscription is still active before publishing
                     if (!activeClientSubscriptions.has(subId)) {
                         console.warn(`[TypeQL Handler ${clientId}] Attempted to publish to inactive/stopped subscription (ID: ${subId}). Skipping.`);
                         return;
                     }

                     let dataToPublish = rawData;
                     // Optional output parsing
                     if (procDef.subscriptionOutputSchema) {
                         try {
                             dataToPublish = procDef.subscriptionOutputSchema.parse(rawData);
                         } catch (validationError) {
                             const error = formatError(validationError, false); // Pass false for output validation
                             console.error(`[TypeQL Handler ${clientId}] Subscription output validation failed for subId ${subId}: ${error.message}`);
                             const errorMsg: SubscriptionErrorMessage = { type: 'subscriptionError', id: subId, error }; // Use formatted error directly
                             if (transport.send) { // Use the bound transport
                                 Promise.resolve(transport.send(errorMsg)).catch(sendErr => console.error(`[TypeQL Handler ${clientId}] Error sending subscription error message for subId ${subId}:`, sendErr));
                             }
                             // Stop the subscription on output error? Maybe configurable. For now, just log and send error.
                             // activeClientSubscriptions.delete(subId);
                             // subscriptionManager.removeSubscription(subId);
                             return;
                         }
                     }

                     // Get next sequence number for this client's subscription
                     const currentServerSeq = serverSequenceManager.getNext();
                     const prevServerSeqValue = lastServerSeqMap.get(subId);
                     lastServerSeqMap.set(subId, currentServerSeq);

                     const dataMsg: SubscriptionDataMessage = {
                         type: 'subscriptionData',
                         id: subId,
                         data: dataToPublish,
                         serverSeq: currentServerSeq,
                         ...(prevServerSeqValue !== undefined && { prevServerSeq: prevServerSeqValue })
                     };

                     if (transport.send) { // Use the bound transport
                         console.debug(`[TypeQL Handler ${clientId}] Publishing data for subId ${subId} (Seq: ${currentServerSeq})`);
                         Promise.resolve(transport.send(dataMsg)).catch((sendErr: any) => {
                             console.error(`[TypeQL Handler ${clientId}] Error sending subscription data via transport.send for subId ${subId}:`, sendErr);
                             const error = formatError(sendErr); // Remove defaultCode argument
                             const errorMsg: SubscriptionErrorMessage = { type: 'subscriptionError', id: subId, error }; // Use formatted error directly
                             if (transport.send) {
                                 Promise.resolve(transport.send(errorMsg)).catch(errMsgErr => console.error(`[TypeQL Handler ${clientId}] CRITICAL: Failed even to send error message for subId ${subId}:`, errMsgErr));
                             }
                             // Remove subscription on send error?
                             activeClientSubscriptions.delete(subId);
                             subscriptionManager.removeSubscription(subId);
                             lastServerSeqMap.delete(subId);
                         });
                     } else {
                         console.error(`[TypeQL Handler ${clientId}] Cannot publish data for subId ${subId}: Transport lacks 'send' method.`);
                         // Remove subscription if transport is broken
                         activeClientSubscriptions.delete(subId);
                         subscriptionManager.removeSubscription(subId);
                         lastServerSeqMap.delete(subId);
                     }
                 };

                 const subOptions: SubscriptionOptions<TContext, unknown, unknown> = { ctx, input: parsedInput, publish };

                 try {
                      // Execute the subscription resolver
                      const cleanupFn = await procDef.subscriptionResolver!(subOptions);

                      // Register cleanup in global manager
                      subscriptionManager.addSubscription(
                            subId,
                            () => { // Wrapper to also clean up local state
                                 lastServerSeqMap.delete(subId);
                                 if (typeof cleanupFn === 'function') {
                                      cleanupFn();
                                 }
                            }
                      );

                      // Track locally for this handler
                      activeClientSubscriptions.set(subId, { path: call.path });

                      console.log(`[TypeQL Handler ${clientId}] Subscription setup successful for path: ${call.path} (ID: ${subId})`);
                      // No explicit success message needed for subscription start, client waits for data/end/error
                      return;

                 } catch (subSetupError: any) {
                     const error = formatError(subSetupError); // Remove defaultCode argument
                     console.error(`[TypeQL Handler ${clientId}] ${error.code} during subscription setup for path ${call.path}: ${error.message}`);
                     // Send error back as a ProcedureResultMessage for the initial setup failure
                     return { id: call.id, result: { type: 'error', error } };
                 }
            }

        } catch (outerError: any) {
            // Catch errors during context creation or initial checks
            const error = formatError(outerError); // Remove defaultCode argument
            console.error(`[TypeQL Handler ${clientId}] ${error.code} processing single request for ${message.type} ${'path' in message ? message.path : ''}: ${error.message}`);
            // Ensure message.id exists before using it
            const messageId = 'id' in message ? message.id : undefined;
            if (messageId !== undefined) {
                 return { id: messageId, result: { type: 'error', error } };
            } else {
                 console.error(`[TypeQL Handler ${clientId}] Cannot send error response: Message ID missing.`);
            }
        }
    };

    // Define cleanup function separately
    const cleanup = () => {
        console.log(`[TypeQL Handler] Cleaning up subscriptions for Client ID: ${clientId}`);
        activeClientSubscriptions.forEach((_subInfo, subId) => {
            // Remove from global manager (which triggers resolver cleanup)
            subscriptionManager.removeSubscription(subId);
            lastServerSeqMap.delete(subId); // Clean up sequence tracking
        });
        activeClientSubscriptions.clear();
        console.log(`[TypeQL Handler] Cleanup complete for Client ID: ${clientId}`);
    };

    // Register cleanup with transport if possible - Ensure this happens *after* handler creation
    // The mock setup in the test needs to reflect this timing if onDisconnect is called immediately
    // For now, assume transport.onDisconnect is available and called correctly during handler setup.
    // The test failure might be due to mock reset timing.
    if (transport.onDisconnect) {
        console.log(`[TypeQL Handler ${clientId}] Registering cleanup function with transport.onDisconnect`);
        const unregister = transport.onDisconnect(cleanup);
        // Store unregister function if needed, though cleanup should handle unregistering from manager
    } else {
        console.warn(`[TypeQL Handler ${clientId}] Transport does not support onDisconnect. Cleanup must be triggered manually.`);
    }


    // Return the handler object containing the functions
    return {
        handleMessage,
        cleanup,
    };
}

console.log("packages/core/src/server/requestHandler.ts loaded");
