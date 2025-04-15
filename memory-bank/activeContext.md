# Active Context for ReqDelta

*   **Current Focus**: Finalizing Memory Bank updates and code additions for Standard Delta types and utilities. Preparing to commit current state.
*   **Recent Changes**:
    *   Created initial Memory Bank files & refactored to Monorepo structure.
    *   Implemented basic Phase 1 components (`types`, `utils`, `createStore`, `SubscriptionManager`, `RequestHandler`, index files) within `@reqdelta/core`.
    *   Created root `.gitignore`.
    *   Received new requirements for optimistic updates, sequence IDs, conflict resolution, and consistency checks.
    *   Updated `projectbrief.md` and `systemPatterns.md` in English with these new requirements and adjusted roadmap.
    *   Added Standard Delta types (`StandardDelta`, `AddDelta`, etc.) and Standard Operation types (`StandardOperation`, `AddOperation`, etc.) to `core/types.ts`.
    *   Added Standard Delta utility functions (`getIn`, `setIn`, `applyStandardDelta`, `standardOperationToDelta`, `standardMatchesPendingOperation`) to `core/utils.ts`.
    *   Updated `progress.md` reflecting these additions.
*   **Next Steps**:
    *   Export new types and utils from `packages/core/src/core/index.ts`.
    *   Commit the current state (Monorepo setup, Phase 1 basic implementation, standard deltas, .gitignore, Memory Bank updates).
    *   Begin implementing Phase 2 (Optimistic Updates & Consistency), focusing on integrating optimistic logic into `createStore` (or creating `OptimisticStore`).
*   **Active Decisions**:
    *   Project is an npm workspace monorepo.
    *   Transports are separate packages.
    *   Core library provides standard delta types and utilities for convenience, while allowing custom implementations.
    *   Core library `@reqdelta/core` will include optimistic update logic, sequence management, conflict resolution framework, and recovery mechanisms.
    *   All documentation (Memory Bank, comments) will be in English.
*   **Blockers**: None.
