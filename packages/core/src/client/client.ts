// packages/core/src/client/client.ts

import type { AnyRouter } from '../server/router';
import type { AnyProcedure } from '../server/procedure';
import * as z from 'zod'; // Moved import
import type {
    TypeQLTransport,
    ProcedureCallMessage,
    SubscribeMessage,
    UnsubscribeFn,
    SubscriptionHandlers,
    ProcedureResultMessage // Import this too
} from '../core/types'; // Import transport and message types
import { generateId } from '../core/utils'; // Import ID generator
// Removed duplicate Zod import

// --- Client Creation ---

export interface ClientOptions {
    /** The transport layer responsible for communication */
    transport: TypeQLTransport; // Use the correct transport type
    /** Optional function to generate request IDs */
    generateRequestId?: () => string | number;
    // url?: string; // Potential alternative or supplement to transport
    // fetch?: typeof fetch; // Allow custom fetch implementation
}

/**
 * Creates a strongly-typed client proxy based on the server's AppRouter type.
 *
 * @param opts Client options, including the transport layer.
 * @returns A proxy object mirroring the server's router structure.
 */
export function createClient<TRouter extends AnyRouter>(
    opts: ClientOptions
): CreateClientProxy<TRouter> {
    console.log("[TypeQL Client] Creating client proxy...");

    const reqIdGenerator = opts.generateRequestId ?? generateId;

    // Use a Proxy to dynamically handle calls to the router structure
    function createRecursiveProxy(path: string[]): any {
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
                 console.log(`[TypeQL Client] Accessing path: ${newPath.join('.')}`);
                 // If the property accessed is a procedure method, execute it
                 if (propKey === 'query' || propKey === 'mutate' || propKey === 'subscribe') {
                     // We've reached the end of the path for this call type
                     const procedureMethods = createProcedureProxy(opts.transport, path, reqIdGenerator);
                     if (propKey === 'query') return procedureMethods.query;
                     if (propKey === 'mutate') return procedureMethods.mutate;
                     if (propKey === 'subscribe') return procedureMethods.subscribe;
                 }
                 // Otherwise, assume it's a path segment and continue recursively
                 const nextPath = [...path, propKey];
                 console.log(`[TypeQL Client] Accessing path segment: ${propKey} (Current path: ${nextPath.join('.')})`);
                 return createRecursiveProxy(nextPath);
                 // Removed extra closing brace/parenthesis from previous attempt
            }
        });
    }

    return createRecursiveProxy([]);
}

// --- Proxy Logic ---

// Type helper to recursively build the client proxy type
type CreateClientProxy<TRouter extends AnyRouter | AnyProcedure> = TRouter extends AnyRouter
    ? {
        [K in keyof TRouter['_def']['procedures']]: CreateClientProxy<TRouter['_def']['procedures'][K]>;
    }
    : TRouter extends AnyProcedure // Base case: procedure
    ? CreateProcedureClient<TRouter> // Return the actual function/object for procedure calls
    : never; // Should not happen

// Type helper for the callable procedure client part
type CreateProcedureClient<TProcedure extends AnyProcedure> = TProcedure['_def']['type'] extends 'query'
    ? { query: (input: TProcedure['_def']['inputSchema'] extends z.ZodType ? z.infer<TProcedure['_def']['inputSchema']> : never) => Promise<TProcedure['_def']['outputSchema'] extends z.ZodType ? z.infer<TProcedure['_def']['outputSchema']> : never> }
    : TProcedure['_def']['type'] extends 'mutation'
    ? { mutate: (input: TProcedure['_def']['inputSchema'] extends z.ZodType ? z.infer<TProcedure['_def']['inputSchema']> : never) => Promise<TProcedure['_def']['outputSchema'] extends z.ZodType ? z.infer<TProcedure['_def']['outputSchema']> : never> /* Add optimistic update options? */ }
    : TProcedure['_def']['type'] extends 'subscription'
     ? { subscribe: (input: TProcedure['_def']['inputSchema'] extends z.ZodType ? z.infer<TProcedure['_def']['inputSchema']> : never, handlers: SubscriptionHandlers) => UnsubscribeFn } // Correct subscribe signature
    : never;


/**
 * Internal function that creates the actual methods (.query, .mutate, .subscribe) for a given path.
 * @param transport The transport layer instance
 * @param path Array of path segments built up by the recursive proxy
 * @param generateRequestId Function to generate correlation IDs
 */
function createProcedureProxy(
    transport: TypeQLTransport,
    path: string[],
    generateRequestId: () => string | number
): {
    query: (input: unknown) => Promise<unknown>;
    mutate: (input: unknown) => Promise<unknown>;
    subscribe: (input: unknown, handlers: SubscriptionHandlers) => UnsubscribeFn; // Changed return type
} {
    const pathString = path.join('.');
    // console.log(`[TypeQL Client] Creating procedure proxy for path: ${pathString}`); // Logged in recursive proxy now

    return {
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
        mutate: async (input: unknown) => {
            console.log(`[TypeQL Client] Calling mutation '${pathString}' with input:`, input);
            const requestId = generateRequestId();
            const message: ProcedureCallMessage = { type: 'mutation', id: requestId, path: pathString, input };
            try {
                const resultMessage = await transport.request(message);
                if (resultMessage.result.type === 'data') {
                    return resultMessage.result.data;
                } else {
                    throw new Error(resultMessage.result.error.message);
                }
            } catch (error: any) {
                 console.error(`[TypeQL Client] Mutation '${pathString}' failed:`, error);
                 if (error instanceof Error) throw error;
                 throw new Error(`Mutation failed: ${error}`);
            }
        },
        // --- Subscription ---
        subscribe: (input: unknown, handlers: SubscriptionHandlers): UnsubscribeFn => {
            console.log(`[TypeQL Client] Calling subscription '${pathString}' with input:`, input);
            const requestId = generateRequestId();
            const message: SubscribeMessage = { type: 'subscription', id: requestId, path: pathString, input };

            try {
                // transport.subscribe handles the lifecycle and returns an unsubscribe function
                const unsubscribe = transport.subscribe(message, handlers);
                return unsubscribe;
            } catch (error: any) {
                 console.error(`[TypeQL Client] Subscription '${pathString}' failed to initiate:`, error);
                 // How to signal this failure? Throwing might be unexpected here.
                 // Maybe return a dummy unsubscribe function that logs an error?
                 return () => { console.error("Subscription failed to initialize."); };
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
