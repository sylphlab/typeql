import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { createClient } from '@sylphlab/zen-query-client'; // Use client package
import { createVSCodeTransport } from '@sylphlab/zen-query-transport-vscode'; // Use the correct transport
// Removed incorrect import: import { zenQueryProvider } from '@sylphlab/zen-query-react';
import type { ExtensionRouter } from '../extension'; // Import router type from extension code

// --- zenQuery Client Setup for Webview ---

// 1. Acquire the VSCode API instance (available globally in webviews)
// Note: In real-world scenarios, you might need to handle cases where this isn't available immediately.
// @ts-ignore - acquireVsCodeApi is injected globally by VS Code
const vscodeApi = acquireVsCodeApi();

// 2. Create the VSCode transport using the acquired API
const transport = createVSCodeTransport({ vscodeApi });

// 3. Create the zenQuery client, typed with the ExtensionRouter
const client = createClient<ExtensionRouter>({
    transport,
});

// --- Render React App ---

const container = document.getElementById('root');
if (container) {
    const root = createRoot(container);
    root.render(
        <React.StrictMode>
            {/* <zenQueryProvider client={client}> */}
                <App />
            {/* </zenQueryProvider> */}
        </React.StrictMode>
    );
} else {
    console.error('Root element not found for React app.');
}