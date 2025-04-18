// packages/core/src/server/requestHandler.ts
import { createServerSequenceManager } from '@sylphlab/typeql-shared';
import { ZodError } from 'zod';
/** Formats various errors into a standard structure */
function formatError(error, defaultCode = 'INTERNAL_SERVER_ERROR') {
    let message = 'An unexpected error occurred';
    let code = defaultCode;
    if (error instanceof ZodError) {
        message = 'Input validation failed'; // Keep message generic for client
        code = 'BAD_REQUEST';
        // console.error("Zod Validation Error:", error.flatten()); // Log details server-side
    }
    else if (error instanceof Error) {
        message = error.message;
        // Allow specific error types to suggest codes?
        // if (error instanceof MyCustomError) code = error.code;
    }
    else if (typeof error === 'string') {
        message = error;
    }
    // Ensure code is a valid ErrorCode
    const validCodes = {
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
// --- Helper Functions ---
/**
 * Recursively finds a procedure definition within a router based on a path.
 * @param router Router definition object
 * @param path Array of path segments (e.g., ['user', 'get'])
 * @returns The procedure definition or undefined if not found
 */
function findProcedure(routerProcedures, path) {
    const currentPathSegment = path[0];
    if (!currentPathSegment || !routerProcedures[currentPathSegment]) {
        return undefined; // Path segment not found
    }
    const potentialTarget = routerProcedures[currentPathSegment];
    if (path.length === 1) {
        // Last segment, should be a procedure
        if (potentialTarget && !potentialTarget._def?.router) {
            return potentialTarget;
        }
        return undefined; // Found a router, not a procedure at the end
    }
    else {
        // More segments remaining, should be a router
        if (potentialTarget && potentialTarget._def?.router) {
            return findProcedure(potentialTarget._def.procedures, path.slice(1));
        }
        return undefined; // Found a procedure mid-path or segment not found
    }
}
export function createRequestHandler(opts, transport // Transport is now mandatory and passed during creation
) {
    const { router, createContext, subscriptionManager, clientId = `client_${Date.now()}_${Math.random().toString(36).substring(2)}` } = opts;
    // Sequence manager and tracking are specific to this handler/connection (primarily for subscriptions)
    const serverSequenceManager = createServerSequenceManager();
    const lastServerSeqMap = new Map(); // Track last seq per subscription ID for this client
    // Store subscriptions active for THIS handler/client connection
    const activeClientSubscriptions = new Map(); // Store path for potential logging/debug
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
    const handleMessage = async (message) => {
        const startTime = Date.now();
        // --- Handle Batch Request ---
        if (Array.isArray(message)) {
            const calls = message;
            console.log(`[TypeQL Handler ${clientId}] Handling batch request with ${calls.length} calls.`);
            // Create context once for the batch
            let batchCtx;
            try {
                batchCtx = await createContext({ transport });
                console.log(`[TypeQL Handler ${clientId}] Context created for batch request.`);
            }
            catch (ctxError) {
                const error = formatError(ctxError, 'INTERNAL_SERVER_ERROR');
                console.error(`[TypeQL Handler ${clientId}] ${error.code} creating context for batch: ${error.message}`);
                // Return an error result for every call in the batch
                return calls.map(call => ({ id: call.id, result: { type: 'error', error } }));
            }
            // Process calls concurrently
            const results = await Promise.all(calls.map(async (call) => {
                const callStartTime = Date.now();
                console.log(`[TypeQL Handler ${clientId}] Processing batch call (ID: ${call.id}, Path: ${call.path})`);
                // Reject subscriptions in batch
                if (call.type === 'subscription') {
                    const error = formatError('Subscriptions are not supported in batch requests', 'BAD_REQUEST');
                    console.warn(`[TypeQL Handler ${clientId}] ${error.code} for batched subscription call (ID: ${call.id}, Path: ${call.path})`);
                    return { id: call.id, result: { type: 'error', error } };
                }
                const pathSegments = call.path.split('.');
                const procedure = findProcedure(router._def.procedures, pathSegments);
                if (!procedure) {
                    const error = formatError(`Procedure not found: ${call.path}`, 'NOT_FOUND');
                    console.error(`[TypeQL Handler ${clientId}] ${error.code} for batched call path ${call.path}: ${error.message}`);
                    return { id: call.id, result: { type: 'error', error } };
                }
                const procDef = procedure._def;
                if (procDef.type !== call.type) {
                    const error = formatError(`Cannot call ${procDef.type} procedure using ${call.type}`, 'BAD_REQUEST');
                    console.error(`[TypeQL Handler ${clientId}] ${error.code} for batched call path ${call.path}: ${error.message}`);
                    return { id: call.id, result: { type: 'error', error } };
                }
                try {
                    // Parse Input
                    let parsedInput = call.input;
                    if (procDef.inputSchema) {
                        try {
                            parsedInput = procDef.inputSchema.parse(call.input);
                        }
                        catch (validationError) {
                            const error = formatError(validationError, 'BAD_REQUEST');
                            console.error(`[TypeQL Handler ${clientId}] ${error.code} for batched call path ${call.path} (Input): ${error.message}`);
                            return { id: call.id, result: { type: 'error', error } };
                        }
                    }
                    // Execute Query/Mutation
                    let result;
                    try {
                        const options = { ctx: batchCtx, input: parsedInput }; // Use shared batch context
                        result = await procDef.resolver(options);
                    }
                    catch (resolverError) {
                        const error = formatError(resolverError, 'INTERNAL_SERVER_ERROR');
                        console.error(`[TypeQL Handler ${clientId}] ${error.code} during resolver execution for batched call path ${call.path}: ${error.message}`);
                        return { id: call.id, result: { type: 'error', error } };
                    }
                    // Parse Output
                    let finalOutput = result;
                    if (procDef.outputSchema) {
                        try {
                            finalOutput = procDef.outputSchema.parse(result);
                        }
                        catch (validationError) {
                            const error = formatError(validationError, 'INTERNAL_SERVER_ERROR');
                            console.error(`[TypeQL Handler ${clientId}] ${error.code} for batched call path ${call.path} (Output): ${error.message}`);
                            return { id: call.id, result: { type: 'error', error: { ...error, message: 'Internal server error: Invalid procedure output' } } };
                        }
                    }
                    const duration = Date.now() - callStartTime;
                    console.log(`[TypeQL Handler ${clientId}] Batched ${call.type} call successful for path: ${call.path} (ID: ${call.id}, Duration: ${duration}ms)`);
                    return { id: call.id, result: { type: 'data', data: finalOutput } };
                }
                catch (callError) {
                    const error = formatError(callError, 'INTERNAL_SERVER_ERROR');
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
            }
            else {
                console.warn(`[TypeQL Handler ${clientId}] Received stop for unknown/inactive subscription (ID: ${subId})`);
            }
            return; // No response needed for stop message
        }
        // --- Handle Procedure Call (Query, Mutation, Subscription Start) ---
        const call = message; // Type assertion after checking for stop
        const pathSegments = call.path.split('.');
        const procedure = findProcedure(router._def.procedures, pathSegments);
        if (!procedure) {
            const error = formatError(`Procedure not found: ${call.path}`, 'NOT_FOUND');
            console.error(`[TypeQL Handler ${clientId}] ${error.code} for path ${call.path}: ${error.message}`);
            return { id: call.id, result: { type: 'error', error } };
        }
        const procDef = procedure._def; // Cast for internal use
        // Check if the procedure type matches the call type
        if (procDef.type !== call.type) {
            const error = formatError(`Cannot call ${procDef.type} procedure using ${call.type}`, 'BAD_REQUEST');
            console.error(`[TypeQL Handler ${clientId}] ${error.code} for path ${call.path}: ${error.message}`);
            return { id: call.id, result: { type: 'error', error } };
        }
        try {
            // 1. Create Context (Transport is now guaranteed)
            const ctx = await createContext({ transport });
            console.log(`[TypeQL Handler ${clientId}] Context created for request ${call.id}`);
            // 2. Parse Input
            let parsedInput = call.input;
            if (procDef.inputSchema) {
                try {
                    parsedInput = procDef.inputSchema.parse(call.input);
                    console.log(`[TypeQL Handler ${clientId}] Input parsed successfully for path: ${call.path}`);
                }
                catch (validationError) {
                    const error = formatError(validationError, 'BAD_REQUEST');
                    console.error(`[TypeQL Handler ${clientId}] ${error.code} for path ${call.path} (Input): ${error.message}`);
                    return { id: call.id, result: { type: 'error', error } };
                }
            }
            // 3. Handle based on procedure type
            if (procDef.type === 'query' || procDef.type === 'mutation') {
                // --- Query/Mutation Execution ---
                let result;
                try {
                    const options = { ctx, input: parsedInput };
                    result = await procDef.resolver(options);
                }
                catch (resolverError) {
                    const error = formatError(resolverError, 'INTERNAL_SERVER_ERROR');
                    console.error(`[TypeQL Handler ${clientId}] ${error.code} during resolver execution for path ${call.path}: ${error.message}`);
                    return { id: call.id, result: { type: 'error', error } };
                }
                // 4. Parse Output (Optional)
                let finalOutput = result;
                if (procDef.outputSchema) {
                    try {
                        finalOutput = procDef.outputSchema.parse(result);
                        console.log(`[TypeQL Handler ${clientId}] Output parsed successfully for path: ${call.path}`);
                    }
                    catch (validationError) {
                        const error = formatError(validationError, 'INTERNAL_SERVER_ERROR');
                        console.error(`[TypeQL Handler ${clientId}] ${error.code} for path ${call.path} (Output): ${error.message}`);
                        return { id: call.id, result: { type: 'error', error: { ...error, message: 'Internal server error: Invalid procedure output' } } };
                    }
                }
                const duration = Date.now() - startTime; // Use overall start time for single calls too
                console.log(`[TypeQL Handler ${clientId}] ${call.type} call successful for path: ${call.path} (ID: ${call.id}, Duration: ${duration}ms)`);
                return { id: call.id, result: { type: 'data', data: finalOutput } };
            }
            else if (procDef.type === 'subscription') {
                // --- Subscription Start Handling ---
                if (!procDef.subscriptionResolver) {
                    const error = formatError('Subscription resolver not implemented', 'INTERNAL_SERVER_ERROR');
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
                const publish = (rawData) => {
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
                        }
                        catch (validationError) {
                            const error = formatError(validationError, 'INTERNAL_SERVER_ERROR');
                            console.error(`[TypeQL Handler ${clientId}] Subscription output validation failed for subId ${subId}: ${error.message}`);
                            const errorMsg = { type: 'subscriptionError', id: subId, error: { ...error, message: 'Internal server error: Invalid subscription output' } };
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
                    const dataMsg = {
                        type: 'subscriptionData',
                        id: subId,
                        data: dataToPublish,
                        serverSeq: currentServerSeq,
                        ...(prevServerSeqValue !== undefined && { prevServerSeq: prevServerSeqValue })
                    };
                    if (transport.send) { // Use the bound transport
                        console.debug(`[TypeQL Handler ${clientId}] Publishing data for subId ${subId} (Seq: ${currentServerSeq})`);
                        Promise.resolve(transport.send(dataMsg)).catch((sendErr) => {
                            console.error(`[TypeQL Handler ${clientId}] Error sending subscription data via transport.send for subId ${subId}:`, sendErr);
                            const error = formatError(sendErr, 'INTERNAL_SERVER_ERROR');
                            const errorMsg = { type: 'subscriptionError', id: subId, error: { ...error, message: `Failed to send update: ${error.message}` } };
                            if (transport.send) {
                                Promise.resolve(transport.send(errorMsg)).catch(errMsgErr => console.error(`[TypeQL Handler ${clientId}] CRITICAL: Failed even to send error message for subId ${subId}:`, errMsgErr));
                            }
                            // Remove subscription on send error?
                            activeClientSubscriptions.delete(subId);
                            subscriptionManager.removeSubscription(subId);
                            lastServerSeqMap.delete(subId);
                        });
                    }
                    else {
                        console.error(`[TypeQL Handler ${clientId}] Cannot publish data for subId ${subId}: Transport lacks 'send' method.`);
                        // Remove subscription if transport is broken
                        activeClientSubscriptions.delete(subId);
                        subscriptionManager.removeSubscription(subId);
                        lastServerSeqMap.delete(subId);
                    }
                };
                const subOptions = { ctx, input: parsedInput, publish };
                try {
                    // Execute the subscription resolver
                    const cleanupFn = await procDef.subscriptionResolver(subOptions);
                    // Register cleanup in global manager
                    subscriptionManager.addSubscription(subId, () => {
                        lastServerSeqMap.delete(subId);
                        if (typeof cleanupFn === 'function') {
                            cleanupFn();
                        }
                    });
                    // Track locally for this handler
                    activeClientSubscriptions.set(subId, { path: call.path });
                    console.log(`[TypeQL Handler ${clientId}] Subscription setup successful for path: ${call.path} (ID: ${subId})`);
                    // No explicit success message needed for subscription start, client waits for data/end/error
                    return;
                }
                catch (subSetupError) {
                    const error = formatError(subSetupError, 'INTERNAL_SERVER_ERROR');
                    console.error(`[TypeQL Handler ${clientId}] ${error.code} during subscription setup for path ${call.path}: ${error.message}`);
                    // Send error back as a ProcedureResultMessage for the initial setup failure
                    return { id: call.id, result: { type: 'error', error } };
                }
            }
        }
        catch (outerError) {
            // Catch errors during context creation or initial checks
            const error = formatError(outerError, 'INTERNAL_SERVER_ERROR');
            console.error(`[TypeQL Handler ${clientId}] ${error.code} processing single request for ${message.type} ${'path' in message ? message.path : ''}: ${error.message}`);
            // Ensure message.id exists before using it
            const messageId = 'id' in message ? message.id : undefined;
            if (messageId !== undefined) {
                return { id: messageId, result: { type: 'error', error } };
            }
            else {
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
    // Register cleanup with transport if possible
    if (transport.onDisconnect) {
        console.log(`[TypeQL Handler ${clientId}] Registering cleanup function with transport.onDisconnect`);
        transport.onDisconnect(cleanup);
    }
    else {
        console.warn(`[TypeQL Handler ${clientId}] Transport does not support onDisconnect. Cleanup must be triggered manually.`);
    }
    // Return the handler object containing the functions
    return {
        handleMessage,
        cleanup,
    };
}
console.log("packages/core/src/server/requestHandler.ts loaded");
//# sourceMappingURL=requestHandler.js.map