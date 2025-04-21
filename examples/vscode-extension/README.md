# zenQuery VSCode Extension Example

This example demonstrates using zenQuery to facilitate communication between a VSCode extension's main process (extension host) and a webview panel, using the `@sylphlab/zenquery-transport-vscode` package.

## Features Demonstrated

*   **VSCode Extension Backend:** A simple zenQuery server running within the extension host (`src/extension.ts`).
*   **Webview Panel Frontend:** A React application running inside a VSCode webview (`src/webview/main.tsx`).
*   **zenQuery Communication:** Using zenQuery queries, mutations, and potentially subscriptions to interact between the extension host and the webview via the dedicated VSCode transport.
*   **`@sylphlab/zenquery-transport-vscode`:** Usage of the transport adapter designed for VSCode extension messaging.

## Setup

1.  **Install Root Dependencies:** Ensure you have run `pnpm install` in the root directory of the monorepo.
2.  **Install Example Dependencies:** Navigate to this directory (`examples/vscode-extension`) and run:
    ```bash
    pnpm install
    ```
    *(This might not be strictly necessary if root `pnpm install` handled workspace dependencies correctly, but it ensures all dependencies are present.)*

## Building the Example

Before running the extension, you need to compile both the extension code and the webview code:

```bash
# From the examples/vscode-extension directory
pnpm run compile
```

This command runs `tsc` to compile the extension's TypeScript code (output to `dist/`) and then runs `vite build` to build the webview React application (output to `dist/webview/`).

## Running & Debugging

1.  **Open the Monorepo:** Ensure the root `zen-query` monorepo folder is open in VSCode.
2.  **Build:** Run `pnpm run compile` in the `examples/vscode-extension` directory if you haven't already.
3.  **Launch Extension:**
    *   Go to the "Run and Debug" view in VSCode (Ctrl+Shift+D or Cmd+Shift+D).
    *   Select "Run Extension" from the dropdown menu.
    *   Press F5 or click the green play button.
4.  **New VSCode Window:** This will open a new VSCode window ([Extension Development Host]) with the example extension running.
5.  **Show Panel:** Open the command palette (Ctrl+Shift+P or Cmd+Shift+P) in the *new* window and run the command: `Show zenQuery Example Panel`.
6.  **Interact:** The webview panel should open, demonstrating the communication powered by zenQuery. You can set breakpoints in both the extension code (`src/extension.ts`, `src/server.ts`) and the webview code (`src/webview/*`) for debugging.

*(Note: If you make changes to the code, you'll need to re-run `pnpm run compile` and then restart the debugging session (Ctrl+Shift+F5 or Cmd+Shift+F5).)*