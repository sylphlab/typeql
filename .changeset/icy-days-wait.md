---
"@sylphlab/transport-websocket": patch
---

fix(transport-websocket): resolve TS errors after refactor

Fixed TypeScript errors that arose after refactoring the WebSocket transport to implement the `TypeQLTransport` interface. This included:
- Removing the incorrect `onAckReceived` method definition.
- Removing an unused import (`SubscriptionEndMessage`).
- Updating tests to correctly use the factory function and check for optional methods (`connect`, `disconnect`).
- Removing tests for obsolete methods (`getState`, `send`).
- Correcting assertions in tests to match updated implementation details.
