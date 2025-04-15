// packages/core/src/client/client.ts

import type { AnyRouter } from '../server/router';
import type { AnyProcedure } from '../server/procedure'; // Import missing type

// --- Client Creation ---

export interface ClientOptions {
    /** The transport layer responsible for communication */
    transport: /* Replace with actual Transport type */ any;
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

    // Use a Proxy to dynamically handle calls to the router structure
    return new Proxy({} as any, {
        get(_target, propKey: string): any {
             console.log(`[TypeQL Client] Accessing path segment: ${propKey}`);
             // Recursively build the path and return a new proxy or a function
             // This needs to handle nested routers and final procedure calls
            // Placeholder implementation:
            return createProcedureProxy(opts.transport, [propKey]);
        },
    });
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
     ? { subscribe: (input: TProcedure['_def']['inputSchema'] extends z.ZodType ? z.infer<TProcedure['_def']['inputSchema']> : never) => /* Return type for subscription (e.g., Observable or AsyncIterable) */ Promise<any> }
    : never;


/**
 * Internal function to create the proxy for a specific procedure path.
 * This function is returned when the proxy chain reaches a procedure endpoint.
 * @param transport The transport layer instance
 * @param path Array of path segments
 */
function createProcedureProxy(transport: any, path: string[]): any {
    const pathString = path.join('.');
    console.log(`[TypeQL Client] Creating procedure proxy for path: ${pathString}`);

    // Return an object with methods based on procedure type
    // These methods will actually use the transport to make calls
    return {
        query: async (input: unknown) => {
            console.log(`[TypeQL Client] Calling query '${pathString}' with input:`, input);
             // TODO: Call transport.send({ type: 'query', path: pathString, input })
            // Placeholder:
             return Promise.resolve({ data: `mock query result for ${pathString}` });
        },
        mutate: async (input: unknown) => {
            console.log(`[TypeQL Client] Calling mutation '${pathString}' with input:`, input);
             // TODO: Call transport.send({ type: 'mutation', path: pathString, input })
             // Placeholder:
            return Promise.resolve({ data: `mock mutation result for ${pathString}` });
        },
        subscribe: async (input: unknown) => {
            console.log(`[TypeQL Client] Calling subscription '${pathString}' with input:`, input);
             // TODO: Call transport.subscribe({ type: 'subscription', path: pathString, input })
             // Placeholder:
             console.warn("Subscription client logic not fully implemented.");
            return Promise.resolve({ /* mock subscription handle */ });
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

// Need to import Zod for type inference in CreateProcedureClient
import * as z from 'zod';

console.log("packages/core/src/client/client.ts loaded");
