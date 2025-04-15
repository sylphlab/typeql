# Active Context for ReqDelta

*   **Current Focus**: Continuing Phase 2 implementation, specifically sequence number management.
*   **Recent Changes**:
    *   Created initial Memory Bank files & refactored to Monorepo structure.
    *   Implemented basic Phase 1 components (`types`, `utils`, `createStore`, `SubscriptionManager`, `RequestHandler`, index files) within `@reqdelta/core`.
    *   Created root `.gitignore`.
    *   Received new requirements for optimistic updates, sequence IDs, conflict resolution, and consistency checks.
    *   Updated `projectbrief.md` and `systemPatterns.md` in English with these new requirements and adjusted roadmap.
    *   Added Standard Delta types (`StandardDelta`, `AddDelta`, etc.) and Standard Operation types (`StandardOperation`, `AddOperation`, etc.) to `core/types.ts`.
    *   Added Standard Delta utility functions (`getIn`, `setIn`, `applyStandardDelta`, `standardOperationToDelta`, `standardMatchesPendingOperation`, `defaultCloneState`) to `core/utils.ts`.
    *   Exported new types/utils from `core/index.ts`.
    *   Refactored `createStore.ts` to integrate optimistic update logic (replacing `optimisticStore.ts`).
    *   Updated `progress.md` reflecting these additions.
    *   Committed standard delta/utils implementation and `createStore` refactor.
*   **Next Steps**:
    *   Commit updated Memory Bank (`progress.md`, `activeContext.md`).
    *   Implement sequence number management (`packages/core/src/core/seqManager.ts`).
*   **Active Decisions**:
    *   Project is an npm workspace monorepo.
    *   Transports are separate packages.
    *   Core library provides standard delta types and utilities for convenience, while allowing custom implementations.
    *   Core library `@reqdelta/core` will include optimistic update logic, sequence management, conflict resolution framework, and recovery mechanisms.
    *   All documentation (Memory Bank, comments) will be in English.
*   **Blockers**: None.
