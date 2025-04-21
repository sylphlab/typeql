# zenQuery Server (`@sylphlab/typeql-server`)

This package provides the core building blocks for creating zenQuery servers. Define your API procedures (queries, mutations, subscriptions) using simple TypeScript functions and get end-to-end typesafety automatically.

## Installation

```bash
pnpm add @sylphlab/typeql-server zod
# You also need a transport handler, e.g.:
# pnpm add @sylphlab/typeql-transport-websocket
```

## Basic Usage

1.  **Define Procedures and Router:** Use `createRouter`, `query`, `mutation`, and `subscription` to define your API endpoints.

    ```typescript
    // src/router.ts (Example)
    import { createRouter, query, mutation, subscription } from '@sylphlab/typeql-server';
    import { z } from 'zod';
    import { observable } from '@trpc/server/observable'; // Or your preferred observable/event system
    import { Operation as JsonPatchOperation } from 'rfc6902';

    // Example Context (passed during request handling)
    interface Context {
      userId?: string;
      // Add other context properties like database connections, etc.
    }

    // Example Data Store & Events
    interface Todo { id: string; text: string; completed: boolean; }
    let todos: Record<string, Todo> = {};
    const todoEvents = new EventTarget();

    // --- Define Procedures ---

    const getTodosProcedure = query({
      resolve: async ({ ctx }: { ctx: Context }) => {
        console.log('Context in getTodos:', ctx);
        return Object.values(todos);
      },
    });

    const addTodoProcedure = mutation({
      input: z.object({ text: z.string().min(1) }), // Input validation with Zod
      resolve: async ({ input, ctx }: { input: { text: string }, ctx: Context }) => {
        if (!ctx.userId) throw new Error("Not authenticated"); // Example context usage

        const id = Math.random().toString(36).substring(7);
        const newTodo: Todo = { id, text: input.text, completed: false };
        todos[id] = newTodo;

        // Dispatch event for subscription
        const detail: JsonPatchOperation[] = [{ op: 'add', path: `/${id}`, value: newTodo }];
        todoEvents.dispatchEvent(new CustomEvent('update', { detail }));

        return newTodo;
      },
    });

    const onTodoUpdateProcedure = subscription({
      resolve: ({ ctx }: { ctx: Context }) => {
        return observable<JsonPatchOperation[]>((emit) => {
          console.log('Subscription started for context:', ctx);
          const handler = (event: Event) => {
            emit.next((event as CustomEvent).detail);
          };
          todoEvents.addEventListener('update', handler);
          return () => { // Cleanup function
            todoEvents.removeEventListener('update', handler);
            console.log('Subscription stopped for context:', ctx);
          };
        });
      }
    });

    // --- Create Router ---

    export const appRouter = createRouter({
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

2.  **Integrate with a Transport:** Use a transport-specific handler (e.g., from `@sylphlab/typeql-transport-websocket`) to expose your router.

    ```typescript
    // src/server.ts (Example using WebSocket transport)
    import { createWebSocketHandler } from '@sylphlab/typeql-transport-websocket/server'; // Example
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
      handler(ws, req); // Attach zenQuery handler to the WebSocket connection
      ws.on('close', () => console.log('Client disconnected'));
    });

    console.log('WebSocket server started on ws://localhost:3000');
    ```

## Features

*   **`createRouter`:** Combines procedures into a typed router.
*   **`query`:** Defines data fetching procedures.
*   **`mutation`:** Defines data modification procedures.
*   **`subscription`:** Defines realtime procedures using observables (e.g., from `@trpc/server/observable` or RxJS) to stream JSON Patch deltas.
*   **Input Validation:** Use Zod schemas in the `input` property for automatic parsing and validation.
*   **Context:** Pass request-specific context (like authentication data, database connections) to your procedures via `createContext` in the transport handler.
*   **Typesafety:** Automatically infers types for client-side usage.

See the main project [README](../../README.md) for a more complete example and overview.