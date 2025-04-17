import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { createClient } from '@sylph/typeql-client'; // Use client package
import { createVSCodeTransport } from '@typeql/transport-vscode'; // Use the correct transport
import { TypeQLProvider } from '@typeql/react';
import type { ExtensionRouter } from '../extension'; // Import router type from extension code

// --- TypeQL Client Setup for Webview ---

// 1. Acquire the VSCode API instance (available globally in webviews)
// Note: In real-world scenarios, you might need to handle cases where this isn't available immediately.
// @ts-ignore - acquireVsCodeApi is injected globally by VS Code
const vscodeApi = acquireVsCodeApi();

// 2. Create the VSCode transport using the acquired API
const transport = createVSCodeTransport({ vscodeApi });

// 3. Create the TypeQL client, typed with the ExtensionRouter
const client = createClient<ExtensionRouter>({
    transport,
});

// --- Render React App ---

const container = document.getElementById('root');
if (container) {
    const root = createRoot(container);
    root.render(
        <React.StrictMode>
            <TypeQLProvider client={client}>
                <App />
            </TypeQLProvider>
        </React.StrictMode>
    );
} else {
    console.error('Root element not found for React app.');
}