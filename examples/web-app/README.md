# zenQuery Web App Example

This example demonstrates using zenQuery in a React application built with Vite, communicating with a backend server via WebSockets.

## Features Demonstrated

*   **zenQuery Server:** Basic router setup with queries, mutations, and subscriptions (`server/index.ts`).
*   **zenQuery Client:** Connecting to the server using `@sylphlab/typeql-transport-websocket`.
*   **React Integration:** Using `@sylphlab/typeql-react` hooks (`useQuery`, `useMutation`, `useSubscription`) to interact with the zenQuery API.
*   **Realtime Updates:** Subscribing to backend changes and applying delta updates to the UI.
*   **Optimistic Updates:** Basic example of optimistic UI updates for mutations.

## Setup

1.  **Install Root Dependencies:** Ensure you have run `pnpm install` in the root directory of the monorepo.
2.  **Install Example Dependencies:** Navigate to this directory (`examples/web-app`) and run:
    ```bash
    pnpm install
    ```
    *(This might not be strictly necessary if root `pnpm install` handled workspace dependencies correctly, but it ensures all dependencies are present.)*

## Running the Example

You need to run the backend server and the frontend development server simultaneously in separate terminals.

1.  **Run the Backend Server:**
    In your terminal, from the `examples/web-app` directory, run:
    ```bash
    pnpm exec tsx server/index.ts
    ```
    *(This uses `tsx` to execute the TypeScript server file directly. If you don't have `tsx` installed globally or in the workspace, you might need to install it: `pnpm add -D tsx`)*
    The server will start, typically listening on `ws://localhost:3000`.

2.  **Run the Frontend Dev Server:**
    In a **separate** terminal, from the `examples/web-app` directory, run:
    ```bash
    pnpm run dev
    ```
    This will start the Vite development server, usually accessible at `http://localhost:5173` (check terminal output for the exact URL).

3.  **Open the App:** Open the URL provided by Vite in your web browser. You should see the example application, allowing you to fetch, add, and see realtime updates for a simple list (e.g., Todos).

## Building for Production

```bash
pnpm run build
```
This command first compiles the server code (`tsconfig.node.json`) and then builds the frontend application using Vite. The output will be in the `dist/` directory. You can preview the production build using `pnpm run preview`. Note that the production deployment requires running the compiled server code (e.g., `node dist/server/index.js`) separately.
