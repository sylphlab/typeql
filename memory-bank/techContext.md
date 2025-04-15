# Technical Context for ReqDelta

*   **Language**: TypeScript
*   **Package Manager**: npm (using Workspaces)
*   **Monorepo Structure**: Yes, using npm workspaces (`packages/*`).
*   **Core Package**: `@reqdelta/core` (in `packages/core`)
*   **Transport Packages**: Planned as `@reqdelta/transport-*` (e.g., `packages/transport-websocket`)
*   **Target Environment**: Node.js, Browsers, VSCode Extensions (depending on the package/transport)
*   **Key Libraries/Frameworks (Core)**:
    *   `zod`: For input/output validation and type inference.
*   **Build/Compilation**: `tsc` (TypeScript Compiler) per package. Root `npm run build -ws` script.
*   **Testing**: TBD (Jest, Vitest recommended, potentially configured at root level).
*   **Linting/Formatting**: TBD (ESLint, Prettier recommended, likely configured at root level).
*   **CI/CD**: TBD (GitHub Actions recommended).
*   **Constraints**: Core must be transport-layer agnostic. Strong typing required.
*   **Development Setup**: Node.js/npm setup. Run `npm install` in the root. Dev dependencies (like TypeScript) managed in the root `package.json`.
*   **Guideline Checksums**:
    *   *(No guidelines referenced yet)*
