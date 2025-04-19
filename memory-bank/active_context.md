# Active Context

## Current Goal
*   Fix failing tests in `@sylphlab/typeql-transport-websocket` after refactoring unit tests to use `vi.mock` with `importOriginal`.
*   Specifically address:
   *   `connection.test.ts`: Failures related to testing original logic (e.g., `handleMessage`, `disconnectWebSocket`) within the mocked module context.
   *   `request.test.ts`: Failures where `sendMessage` mock isn't called or `entry?.timer` is undefined.
   *   `subscription.test.ts`: Failures in `iterator.return()` and `requestMissingDeltas` when disconnected.
   *   `__tests__/index.test.ts`: Timeout in `should call onAckReceived when ack message is received`.

## Next Action
*   Create a new task to continue debugging the failing tests in `@sylphlab/typeql-transport-websocket`.

## Waiting For
*   User confirmation to create the new task.