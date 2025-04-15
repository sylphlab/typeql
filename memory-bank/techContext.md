# Technical Context for ReqDelta

*   **Language**: TypeScript
*   **Package Manager**: npm (using Workspaces)
*   **Monorepo Structure**: Yes, using npm workspaces (`packages/*`, `packages/react`). Switched to `bun` for package management due to npm issues.
*   **Core Package**: `@typeql/core` (in `packages/core`)
*   **React Package**: `@typeql/react` (in `packages/react`)
*   **Transport Packages**: Planned as `@typeql/transport-*` (e.g., `packages/transport-websocket`)
*   **Target Environment**: Node.js (Server), Browsers (Client, React), VSCode Extensions (potential transport)
*   **Key Libraries/Frameworks (Core)**:
    *   `zod`: For input/output validation and type inference.
*   **Key Libraries/Frameworks (React)**:
    *   `react`: Peer dependency.
*   **Build/Compilation**: `tsc` (TypeScript Compiler) per package using project references. Root build script might change from `npm` to `bun`.
*   **Testing**: TBD (Jest, Vitest recommended, potentially configured at root level).
*   **Linting/Formatting**: TBD (ESLint, Prettier recommended, likely configured at root level).
*   **CI/CD**: TBD (GitHub Actions recommended).
*   **Constraints**: Core must be transport-layer agnostic. Strong typing required.
*   **Development Setup**: Node.js/bun setup. Run `bun install` in the root. Dev dependencies managed in root and package `package.json` files. `tsconfig.base.json` used.
*   **Guideline Checksums**:
    *   *(No guidelines referenced yet)*
