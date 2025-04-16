# Technical Context for ReqDelta

*   **Language**: TypeScript
*   **Package Manager**: bun (using Workspaces)
*   **Monorepo Tooling**: Changesets (Setup), Turborepo (Planned)
*   **Monorepo Structure**: Yes, using bun workspaces (`packages/*`).
*   **Core Package**: `@sylph/typeql-core` (in `packages/core`)
*   **React Package**: `@sylph/typeql-react` (in `packages/react`)
*   **Preact Package**: `@sylph/typeql-preact` (in `packages/transport-preact`)
*   **Transport Packages**:
    *   `@sylph/typeql-transport-websocket` (in `packages/transport-websocket`)
    *   `@sylph/typeql-transport-http` (in `packages/transport-http`)
    *   `@sylph/typeql-transport-vscode` (in `packages/transport-vscode`)
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
*   **CI/CD**: GitHub Actions (Setup - Basic CI & Release workflows).
*   **Constraints**: Core must be transport-layer agnostic. Strong typing required.
*   **Development Setup**: Node.js/bun setup. Run `bun install` in the root. Dev dependencies managed in root and package `package.json` files. `tsconfig.base.json` used. Use `bun changeset` for versioning.
*   **Guideline Checksums**:
    *   *(No guidelines referenced yet)*
