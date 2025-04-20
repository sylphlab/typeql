---
"@sylphlab/transport-websocket": patch
---

refactor(transport-websocket): implement TypeQLTransport interface

Refactored the WebSocket transport to correctly implement the shared `TypeQLTransport` interface from `@sylphlab/typeql-shared`. This includes:
- Using a factory function `createWebSocketTransport`.
- Handling specific TypeQL message types.
- Managing message correlation for requests.
- Using AsyncIterableIterator for subscriptions.
- Adding `@sylphlab/typeql-shared` as a dependency.
- Refactoring tests to align with the new interface and removing obsolete tests.
