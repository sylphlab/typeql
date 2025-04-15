// packages/core/src/client/client.ts

import type { AnyRouter } from '../server/router';
import type { AnyProcedure } from '../server/procedure';
import * as z from 'zod';
import { // Changed to regular import for TypeQLClientError
    TypeQLTransport,
    ProcedureCallMessage,
    SubscribeMessage,
    UnsubscribeFn,
    // SubscriptionHandlers, // Removed
    ProcedureResultMessage,
    // SubscriptionResult, // Removed
    SubscriptionDataMessage, // Added
    SubscriptionErrorMessage, // Added
    TypeQLClientError, // Keep custom error here
} from '../core/types';
import { generateId } from '../core/utils';
// Import PredictedChange as a type, OptimisticStore as a value/type
import type { PredictedChange } from './optimisticStore';
import { OptimisticStore } from './optimisticStore';
import { createClientSequenceManager, ClientSequenceManager } from '../core/seqManager';


// --- Client Creation ---


export interface ClientOptions<TState = any> { // Revert interface
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
export function createClient<TRouter extends AnyRouter, TState = any>( // Add TState generic
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

// Type helper to recursively build the client proxy type
type CreateClientProxy<TRouter extends AnyRouter | AnyProcedure> = TRouter extends AnyRouter
    ? {
        [K in keyof TRouter['_def']['procedures']]: CreateClientProxy<TRouter['_def']['procedures'][K]>;
    }
    : TRouter extends AnyProcedure // Base case: a procedure
    ? CreateProcedureClient<TRouter>
    : never;

/** Input options for mutation calls, allowing optimistic updates. */
export interface MutationCallOptions<TInput, TState> {
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
                if (resultMessage.result.type === 'data') {
                    return resultMessage.result.data; // Return the actual data
                } else {
                    // Throw an error that might be caught by the caller
                    throw new Error(resultMessage.result.error.message);
                }
            } catch (error: any) {
                 console.error(`[TypeQL Client] Query '${pathString}' failed:`, error);
                 // Ensure error is re-thrown or handled appropriately
                 if (error instanceof Error) throw error;
                 throw new Error(`Query failed: ${error}`);
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
                if (resultMessage.result.type === 'data') {
                    // If optimistic, the store handles confirmation via Ack/Delta,
                    // but we still resolve the promise for the caller.
                    return resultMessage.result.data;
                } else {
                    // Handle server error response
                    const errorInfo = resultMessage.result.error;
                    console.error(`[TypeQL Client] Mutation '${pathString}' received server error:`, errorInfo);
                    // TODO: If optimistic, notify store about rejection?
                    throw new TypeQLClientError(errorInfo.message, errorInfo.code);
                }
            } catch (transportError: any) {
                 // Handle transport-level errors (network, timeout, etc.)
                 console.error(`[TypeQL Client] Mutation transport request '${pathString}' failed:`, transportError);
                 // TODO: If optimistic, potentially rollback or mark mutation as failed in store?
                 if (transportError instanceof TypeQLClientError || transportError instanceof Error) throw transportError;
                 throw new TypeQLClientError(`Mutation failed: ${transportError}`);
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
                 throw new TypeQLClientError(`Subscription initiation failed: ${error.message || error}`);
                 /* // Previous dummy return removed
                 return {
                    iterator: (async function*() {
                        yield { type: 'error', error: { message: `Subscription failed to initialize: ${error.message || error}` } };
                    })(),
                    unsubscribe: () => { console.error("Subscription failed to initialize."); }
                 };
                 */
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
