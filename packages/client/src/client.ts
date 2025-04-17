// All exports consolidated here to avoid conflicts

// packages/core/src/client/client.ts

import type { AnyRouter, AnyProcedure } from '@sylph/typeql-shared'; // Use package import
import * as z from 'zod';
import { // Changed to regular import for TypeQLClientError
    TypeQLTransport,
    ProcedureCallMessage,
    SubscribeMessage,
    UnsubscribeFn,
    // SubscriptionHandlers, // Removed
    // ProcedureResultMessage, // Removed as unused
    // SubscriptionResult, // Removed
    SubscriptionDataMessage, // Added
    SubscriptionErrorMessage, // Added
    TypeQLClientError, // Keep custom error here
} from '@sylph/typeql-shared'; // Use package import
import { generateId } from '@sylph/typeql-shared'; // Use package import
// Import PredictedChange as a type, OptimisticStore as a value/type
import type { PredictedChange } from './optimisticStore';
import { OptimisticStore } from './optimisticStore';
import { createClientSequenceManager, ClientSequenceManager } from '@sylph/typeql-shared'; // Use package import


// --- Client Creation ---


interface ClientOptions<TState = any> { // Remove export keyword
    /** The transport layer responsible for communication */
    transport: TypeQLTransport;
    /** Optional function to generate request IDs */
    generateRequestId?: () => string | number;
    /** Optional optimistic store instance */
    store?: OptimisticStore<TState>;
    // url?: string; // Potential alternative or supplement to transport
    // fetch?: typeof fetch; // Allow custom fetch implementation
}


/**
 * Creates a strongly-typed client proxy based on the server's AppRouter type.
 * If an `OptimisticStore` is provided, it automatically wires the transport's
 * `onAckReceived` callback to the store's `confirmPendingMutation` method.
 *
 * @param opts Client options, including the transport layer.
 * @returns A proxy object mirroring the server's router structure.
 */
function createClient<TRouter extends AnyRouter, TState = any>(
    opts: ClientOptions<TState> // Use generic options
): CreateClientProxy<TRouter> {
    console.log("[TypeQL Client] Creating client proxy...");

    const reqIdGenerator = opts.generateRequestId ?? generateId;
    const store = opts.store; // Store the optional store instance
    const transport = opts.transport; // Get the transport instance directly
    const clientSeqManager = createClientSequenceManager(); // Internal manager for clientSeq if no store

    // Automatically wire the store's confirmation method to the transport's ack handler
    if (store && transport) {
        if (transport.onAckReceived) {
            console.warn("[TypeQL Client] Transport already has an onAckReceived handler. Overwriting with store.confirmPendingMutation.");
        }
        // Ensure the store's method is bound correctly if it relies on 'this'
        transport.onAckReceived = store.confirmPendingMutation.bind(store);
        console.log("[TypeQL Client] Automatically wired store.confirmPendingMutation to transport.onAckReceived.");
    } else if (store && !transport) {
        // Should not happen with current types, but defensive check
        console.error("[TypeQL Client] OptimisticStore provided but no transport found in options.");
    }


    // Use a Proxy to dynamically handle calls to the router structure
    function createRecursiveProxy(path: string[], currentStore?: OptimisticStore<TState>): any { // Pass store down
        // This proxy represents a node in the router path.
        // It can either be further navigated (e.g., client.user...)
        // or terminated with a procedure call (.query, .mutate, .subscribe)
        return new Proxy({} as any, {
            get(_target, propKey: string): any {
                 if (typeof propKey !== 'string' || propKey === 'then') {
                     // Avoid issues with Promise-like checks
                     return undefined;
                 }
                 const newPath = [...path, propKey];
                 // If the property accessed is a procedure method, create and return the specific method
                 if (propKey === 'query' || propKey === 'mutate' || propKey === 'subscribe') {
                     // Pass the confirmed transport instance
                     const procedureMethods = createProcedureProxy(transport, path, reqIdGenerator, clientSeqManager, currentStore); // Pass store & seq manager
                     return procedureMethods[propKey]; // Return the specific method directly
                 }
                 // Otherwise, continue building the path recursively
                 return createRecursiveProxy(newPath, currentStore); // Pass store down
            },
        });
    }

    return createRecursiveProxy([], store); // Start with root path and the store
}

// --- Proxy Logic ---

// Revised Type helper: Ensure base case returns the correct object structure
type CreateClientProxy<TRouterOrProcedure extends AnyRouter | AnyProcedure, TState = any> =
    TRouterOrProcedure extends AnyRouter // Check if it's a router first
    ? { // If yes, recurse
        [K in keyof TRouterOrProcedure['_def']['procedures']]: CreateClientProxy<TRouterOrProcedure['_def']['procedures'][K], TState>;
    }
    : TRouterOrProcedure extends AnyProcedure // Base case: a procedure
    // Return the object { query: ... } or { mutate: ... } or { subscribe: ... } directly
    ? CreateProcedureClient<TRouterOrProcedure, TState>
    : never; // Should not happen

/** Input options for mutation calls, allowing optimistic updates. */
interface MutationCallOptions<TInput, TState> { // Remove export keyword
    input: TInput;
    optimistic?: {
        /** The predicted change to apply locally (Immer patches or recipe). */
        predictedChange: PredictedChange<TState>;
        // TODO: Add context for onSettled?
    };
}

// Type helper for the callable procedure client part
type CreateProcedureClient<TProcedure extends AnyProcedure, TState = any> = // Add TState generic
    TProcedure['_def']['type'] extends 'query'
    ? { query: (input: TProcedure['_def']['inputSchema'] extends z.ZodType ? z.infer<TProcedure['_def']['inputSchema']> : never) => Promise<TProcedure['_def']['outputSchema'] extends z.ZodType ? z.infer<TProcedure['_def']['outputSchema']> : never> }
    : TProcedure['_def']['type'] extends 'mutation'
    // Mutate accepts an options object now
    ? { mutate: (opts: MutationCallOptions<TProcedure['_def']['inputSchema'] extends z.ZodType ? z.infer<TProcedure['_def']['inputSchema']> : never, TState>) => Promise<TProcedure['_def']['outputSchema'] extends z.ZodType ? z.infer<TProcedure['_def']['outputSchema']> : never> }
    : TProcedure['_def']['type'] extends 'subscription'
    // Update return type to match the modified TypeQLTransport interface
    ? { subscribe: (input: TProcedure['_def']['inputSchema'] extends z.ZodType ? z.infer<TProcedure['_def']['inputSchema']> : never) => { iterator: AsyncIterableIterator<SubscriptionDataMessage | SubscriptionErrorMessage>; unsubscribe: UnsubscribeFn } }
    : never;

/**
 * Internal function that creates the actual methods (.query, .mutate, .subscribe) for a given path.
 * @param transport The transport layer instance
 * @param path Array of path segments
 * @param generateRequestId Function to generate correlation IDs
 * @param clientSeqManager Manager for client sequence numbers
 * @param store Optional OptimisticStore instance
 */
function createProcedureProxy<TState = any>( // Add TState generic
    transport: TypeQLTransport,
    path: string[],
    generateRequestId: () => string | number,
    clientSeqManager: ClientSequenceManager, // Accept seq manager
    store?: OptimisticStore<TState> // Accept store
): any { // Simplify return type annotation for now to avoid complex assignment error
    const pathString = path.join('.');

    return { // Return implementation directly
        // --- Query ---
        query: async (input: unknown) => {
            console.log(`[TypeQL Client] Calling query '${pathString}' with input:`, input);
            const requestId = generateRequestId();
            const message: ProcedureCallMessage = { type: 'query', id: requestId, path: pathString, input };
            try {
                const resultMessage = await transport.request(message);
                // Check if resultMessage and resultMessage.result are defined before accessing type
                if (resultMessage?.result?.type === 'data') {
                    return resultMessage.result.data; // Return the actual data
                } else if (resultMessage?.result?.type === 'error') {
                     // Throw a specific error for server errors
                     const errorInfo = resultMessage.result.error;
                     console.error(`[TypeQL Client] Query '${pathString}' received server error:`, errorInfo);
                     throw new TypeQLClientError(errorInfo.message, errorInfo.code);
                } else {
                     // Handle unexpected transport response structure
                     console.error(`[TypeQL Client] Query '${pathString}' received unexpected response format:`, resultMessage);
                     throw new TypeQLClientError('Invalid response format received from transport.');
                }
            } catch (error: any) {
                 // This catch block handles transport errors OR errors thrown from the 'else' blocks above
                 console.error(`[TypeQL Client] Query request '${pathString}' failed:`, error);
                 // Re-throw wrapped error
                 if (error instanceof TypeQLClientError) throw error;
                 if (error instanceof Error) throw new TypeQLClientError(error.message, 'QUERY_FAILED'); // Use specific code
                 throw new TypeQLClientError(`Query failed: ${String(error)}`, 'QUERY_FAILED');
            }
        },
        // --- Mutation ---
        mutate: async (opts: MutationCallOptions<unknown, TState>) => {
            const { input, optimistic } = opts;
            console.log(`[TypeQL Client] Calling mutation '${pathString}' with input:`, input, optimistic ? "(Optimistic)" : "");
            const requestId = generateRequestId();
            let clientSeq: number | undefined = undefined;
            let message: ProcedureCallMessage;

            if (store && optimistic) {
                // Optimistic path: Add to store first
                // Let store handle clientSeq generation internally or retrieve next one
                clientSeq = clientSeqManager.getNext(); // Use internal manager for now
                message = { type: 'mutation', id: requestId, path: pathString, input, clientSeq };
                try {
                    store.addPendingMutation(message, optimistic.predictedChange);
                    console.log(`[TypeQL Client] Optimistic mutation added (clientSeq: ${clientSeq}) for '${pathString}'.`);
                } catch (storeError: any) {
                    console.error(`[TypeQL Client] Failed to add optimistic mutation (clientSeq: ${clientSeq}) for '${pathString}':`, storeError);
                    // If store fails, should we still send? Probably not.
                    throw storeError instanceof Error ? storeError : new TypeQLClientError(`Optimistic store failed: ${storeError}`);
                }
            } else {
                // Non-optimistic path
                message = { type: 'mutation', id: requestId, path: pathString, input };
            }

            // Send request via transport (always send, even if optimistic)
            try {
                const resultMessage = await transport.request(message); // Send message (with or without clientSeq)
                // Check if resultMessage and resultMessage.result are defined
                if (resultMessage?.result?.type === 'data') {
                    // If optimistic, the store handles confirmation via Ack/Delta,
                    // but we still resolve the promise for the caller.
                    return resultMessage.result.data;
                } else if (resultMessage?.result?.type === 'error') {
                    // Handle server error response
                    const errorInfo = resultMessage.result.error;
                    console.error(`[TypeQL Client] Mutation '${pathString}' received server error:`, errorInfo);
                    // Throw server error (catch block will handle optimistic rejection)
                    throw new TypeQLClientError(errorInfo.message, errorInfo.code);
                } else {
                     // Handle unexpected transport response structure
                     console.error(`[TypeQL Client] Mutation '${pathString}' received unexpected response format:`, resultMessage);
                     // Throw format error (catch block will handle optimistic rejection)
                     throw new TypeQLClientError('Invalid response format received from transport.');
                }
            } catch (error: any) {
                 // Handle transport-level errors OR errors thrown from the 'else' blocks above
                 console.error(`[TypeQL Client] Mutation request '${pathString}' failed:`, error);
                 // If optimistic, reject the pending mutation in the store
                 if (store && clientSeq !== undefined) {
                     try {
                         store.rejectPendingMutation(clientSeq);
                         console.log(`[TypeQL Client] Rejected pending mutation (clientSeq: ${clientSeq}) due to error for '${pathString}'.`);
                     } catch (rejectError: any) {
                         // Log secondary error during rejection, but prioritize throwing the original error
                         console.error(`[TypeQL Client] Error rejecting pending mutation (clientSeq: ${clientSeq}) after error:`, rejectError);
                     }
                 }
                 // Re-throw wrapped error
                 if (error instanceof TypeQLClientError) throw error;
                 if (error instanceof Error) throw new TypeQLClientError(error.message, 'MUTATION_FAILED');
                 throw new TypeQLClientError(`Mutation failed: ${String(error)}`, 'MUTATION_FAILED');
            }
        },
        // --- Subscription ---
        subscribe: (input: unknown) => { // Removed handlers parameter
            console.log(`[TypeQL Client] Calling subscription '${pathString}' with input:`, input);
            const requestId = generateRequestId();
            const message: SubscribeMessage = { type: 'subscription', id: requestId, path: pathString, input };

            try {
                // transport.subscribe now returns { iterator, unsubscribe }
                const subscriptionResult = transport.subscribe(message);
                return subscriptionResult; // Return the whole object
            } catch (error: any) {
                 console.error(`[TypeQL Client] Subscription '${pathString}' failed to initiate:`, error);
                 // Rethrow the error for the caller to handle
                 // Wrap and re-throw the error, ensuring it's always a TypeQLClientError
                 if (error instanceof TypeQLClientError) throw error;
                 if (error instanceof Error) throw new TypeQLClientError(error.message, 'SUBSCRIPTION_ERROR');
                 throw new TypeQLClientError(`Subscription initiation failed: ${String(error)}`, 'SUBSCRIPTION_ERROR');
            }
        },
    };
}


// Example (requires actual router/procedure types from server)
/*
import type { AppRouter } from '../server/router'; // Assuming AppRouter is exported type

const mockTransport = {
    send: (payload: any) => { console.log("TRANSPORT SEND:", payload); return Promise.resolve({ data: 'mock data' }); },
    subscribe: (payload: any) => { console.log("TRANSPORT SUBSCRIBE:", payload); return Promise.resolve({ unsubscribe: () => {} }); }
};

const client = createClient<AppRouter>({ transport: mockTransport });

async function run() {
    // Example usage (assuming AppRouter structure like in router.ts example)
    try {
        // const health = await client.health.query(); // Assuming health is parameter-less query
        // console.log("Health:", health);

        // const item = await client.item.get.query({ id: '123' });
        // console.log("Item:", item);

        // const mutationResult = await client.item.someMutation.mutate({ data: 'payload' }); // If exists
        // console.log("Mutation:", mutationResult);

        // const subHandle = await client.item.onUpdate.subscribe({ filter: 'abc' }); // If exists
        // console.log("Subscription handle:", subHandle);

    } catch (error) {
        console.error("Client Error:", error);
    }
}
run();
*/

// Zod import moved to the top

console.log("packages/core/src/client/client.ts loaded");


// Export all public types and functions
// Consolidated exports at end of file
export { TypeQLClientError, createClient };
export type { ClientOptions, MutationCallOptions };
