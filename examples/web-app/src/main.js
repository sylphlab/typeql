import { jsx as _jsx } from "react/jsx-runtime";
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { createClient } from '@sylph/typeql-client'; // Use client package
import { createWebSocketTransport } from '@sylph/typeql-transport-websocket'; // Import WS transport
import { TypeQLProvider } from '@sylph/typeql-react'; // Import React provider
// Create the WebSocket transport
const transport = createWebSocketTransport({
    url: 'ws://localhost:8080', // URL of our server
});
// Create the TypeQL client, providing the AppRouter type
const client = createClient({
    transport,
});
createRoot(document.getElementById('root')).render(_jsx(StrictMode, { children: _jsx(TypeQLProvider, { client: client, children: _jsx(App, {}) }) }));
