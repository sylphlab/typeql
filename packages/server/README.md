# zenQuery Server (`@sylphlab/zen-query-server`)

This package provides the core building blocks for creating zenQuery servers. Define your API procedures (queries, mutations, subscriptions) using simple TypeScript functions and get end-to-end typesafety automatically.

## Installation

```bash
pnpm add @sylphlab/zenquery-server zod fast-json-patch
 # You also need a transport handler, e.g.:
 # pnpm add @sylphlab/zenquery-transport-websocket
 ```

## Basic Usage

1.  **Initialize zenQuery & Define Procedures/Router:** Use `initZenQuery`, `createRouter`, and the builder methods (`t.query`, `t.mutation`, `t.subscription`) to define your API.

    ```typescript
    // src/router.ts (Example)
    import { initZenQuery, createRouter } from '@sylphlab/zenquery-server'; // Corrected import
    import { diffStatesToJsonPatch } from '@sylphlab/zenquery-server/utils'; // Diff helper
    import { z } from 'zod';
    import { Operation as JsonPatchOperation, applyPatch } from 'fast-json-patch'; // Use fast-json-patch

    // Example Context (passed during request handling)
    interface Context {
      userId?: string;
      // Add other context properties like database connections, etc.
    }

    // Example Data Store & Events
    interface Todo { id: string; text: string; completed: boolean; }
    let todos: Record<string, Todo> = {};
    const todoEvents = new EventTarget();

    // --- Initialize zenQuery with Context ---
    const t = initZenQuery<Context>();

    // --- Define Procedures using Builder ---

    const getTodosProcedure = t.query({ // Use t.query
      resolve: async ({ ctx }) => { // Context type inferred
        console.log('Context in getTodos:', ctx);
        return Object.values(todos);
      },
    });

    const addTodoProcedure = t.mutation({ // Use t.mutation
      input: z.object({ text: z.string().min(1) }), // Input validation with Zod
      resolve: async ({ input, ctx }) => { // Input and Context types inferred
        if (!ctx.userId) throw new Error("Not authenticated"); // Example context usage

        const id = Math.random().toString(36).substring(7);
        const newTodo: Todo = { id, text: input.text, completed: false };
        todos[id] = newTodo;

        // Dispatch event for subscription (or use a more robust mechanism)
        const patch: JsonPatchOperation[] = [{ op: 'add', path: `/${id}`, value: newTodo }];
        todoEvents.dispatchEvent(new CustomEvent('update', { detail: patch }));

        return newTodo;
      },
    });

    // Example using .streamDiff for automatic patching
    const onTodoUpdateProcedure = t.subscription({ // Use t.subscription
      // Define the type of the full state yielded by the generator
      // Note: .streamDiff might implicitly set the final output to JsonPatch[]
      // but we might still need to define the yielded state type for the generator function
      // Let's assume we define the yielded state schema separately for clarity
      // const TodoMapSchema = z.record(z.object({ id: z.string(), text: z.string(), completed: z.boolean() }));

      // Use .streamDiff with an async generator yielding full state
      streamDiff: async function* ({ ctx }) {
        console.log('Subscription started for context:', ctx);
        let currentState = { ...todos }; // Get initial state
        yield currentState; // Yield initial state (diff helper handles this)

        // Create an async iterator from the event target
        const eventIterator = createEventIterator<JsonPatchOperation[]>(todoEvents, 'update');

        try {
          for await (const patch of eventIterator) {
            // Apply patch to get new state (server needs to track state for diffing)
            try {
              // Use fast-json-patch applyPatch
              currentState = applyPatch(currentState, patch).newDocument;
              yield currentState; // Yield the new full state
            } catch (e) {
              console.error("Failed to apply patch for diff stream:", e);
              // Decide how to handle patch errors (e.g., yield error, close stream)
            }
          }
        } finally {
          console.log('Subscription stopped for context:', ctx);
          // Cleanup logic for the iterator if needed
          // eventIterator.return?.();
        }
      }
    });

    // Helper to convert EventTarget to AsyncIterator (conceptual)
    async function* createEventIterator<T>(target: EventTarget, eventName: string): AsyncGenerator<T, void, undefined> {
      let listener: ((event: Event) => void) | null = null;
      const queue: T[] = [];
      let resolvePromise: (() => void) | null = null;

      listener = (event: Event) => {
        queue.push((event as CustomEvent).detail as T);
        resolvePromise?.();
        resolvePromise = null;
      };
      target.addEventListener(eventName, listener);

      try {
        while (true) {
          if (queue.length > 0) {
            yield queue.shift()!;
          } else {
            await new Promise<void>((r) => resolvePromise = r);
          }
        }
      } finally {
        if (listener) target.removeEventListener(eventName, listener);
      }
    }

    // --- Create Router ---

    export const appRouter = createRouter<Context>()({ // Pass Context type
      // Group procedures under namespaces (e.g., 'todos')
      todos: {
        list: getTodosProcedure,
        add: addTodoProcedure,
        onUpdate: onTodoUpdateProcedure,
      },
      // You can add other procedure groups here
      // health: query({ resolve: () => 'ok' })
    });

    // Export the type for the client
    export type AppRouter = typeof appRouter;
    ```

2.  **Integrate with a Transport:** Use a transport-specific handler (e.g., from `@sylphlab/zenquery-transport-websocket`) to expose your router.

    ```typescript
    // src/server.ts (Example using WebSocket transport)
    import { createWebSocketHandler } from '@sylphlab/zenquery-transport-websocket/server'; // Example
    import { appRouter } from './router';
    import ws from 'ws'; // Example WebSocket server library

    const wss = new ws.Server({ port: 3000 });

    const handler = createWebSocketHandler({
      router: appRouter,
      // Optional: Define how to create context for each connection/request
      createContext: async ({ req }) => {
        // Example: Extract user ID from headers or session
        const userId = req.headers['x-user-id'] as string | undefined;
        return { userId };
      },
    });

    wss.on('connection', (ws, req) => {
      console.log('Client connected');
      handler({ ws, req }); // Attach zenQuery handler to the WebSocket connection
      ws.on('close', () => console.log('Client disconnected'));
    });

    console.log('WebSocket server started on ws://localhost:3000');
    ```

## Features

*   **`initZenQuery`:** Initializes the builder instance with a context type.
*   **`createRouter`:** Combines procedures into a typed router.
*   **`t.query`:** Defines data fetching procedures using the `QueryBuilder`.
*   **`t.mutation`:** Defines data modification procedures using the `MutationBuilder`.
*   **`t.subscription`:** Defines realtime procedures using the `SubscriptionBuilder`.
    *   **`.stream()`:** Uses an Async Generator (`yield`) to push raw data.
    *   **`.streamDiff()`:** Uses an Async Generator (`yield`) to push full state, automatically diffing and sending JSON Patches.
    *   **`.resolveInitial()`:** Optional method to send an initial state snapshot.
*   **Input Validation:** Use Zod schemas with the `.input()` method for automatic parsing and validation.
*   **Context:** Pass request-specific context (like authentication data, database connections) to your procedures via `createContext` in the transport handler.
*   **Typesafety:** Automatically infers types for client-side usage.

See the main project [README](../../README.md) for a more complete example and overview.