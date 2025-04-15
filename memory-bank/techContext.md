# Technical Context for ReqDelta

*   **Language**: TypeScript
*   **Package Manager**: bun (using Workspaces)
*   **Monorepo Tooling**: Turborepo (Planned), Changesets (Planned)
*   **Monorepo Structure**: Yes, using bun workspaces (`packages/*`).
*   **Core Package**: `@typeql/core` (in `packages/core`)
*   **React Package**: `@typeql/react` (in `packages/react`)
*   **Transport Packages**:
    *   `@typeql/transport-websocket` (in `packages/transport-websocket`) - *Basic structure setup*
    *   Others planned (`@typeql/transport-*`)
*   **Target Environment**: Node.js (Server), Browsers (Client, React, Preact), VSCode Extensions
*   **Key Libraries/Frameworks (Core)**:
    *   `zod`: For input/output validation and type inference.
    *   `immer`: For state management in `OptimisticStore`.
*   **Key Libraries/Frameworks (React)**:
    *   `react`: Peer dependency.
*   **Key Libraries/Frameworks (Transport-WS)**:
    *   `ws`: WebSocket implementation (primarily for Node.js server-side or testing).
*   **Build/Compilation**: tsup (Planned), `tsc` (Currently, via project references). Root build script likely `bun run build`.
*   **Testing**: Vitest (Planned).
*   **Linting/Formatting**: ESLint, Prettier (Planned, configured at root).
*   **CI/CD**: GitHub Actions (Planned).
*   **Constraints**: Core must be transport-layer agnostic. Strong typing required.
*   **Development Setup**: Node.js/bun setup. Run `bun install` in the root. Dev dependencies managed in root and package `package.json` files. `tsconfig.base.json` used.
*   **Guideline Checksums**:
    *   *(No guidelines referenced yet)*
