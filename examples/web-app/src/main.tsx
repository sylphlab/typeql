import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.js'; // Add extension
import type { TypeQLTransport } from '@sylphlab/typeql-shared'; // Import transport type
import { createClient } from '@sylphlab/typeql-client'; // Use client package
import { createWebSocketTransport } from '@sylphlab/typeql-transport-websocket'; // Import WS transport
import { TypeQLProvider } from '@sylphlab/typeql-react'; // Import React provider
import type { AppRouter } from '../server/index.js'; // Import the AppRouter type from server with extension

// Create the WebSocket transport
const transport: TypeQLTransport = createWebSocketTransport({ // Explicitly type transport
  url: 'ws://localhost:8080', // URL of our server
});

// Create the TypeQL client, providing the AppRouter type
const client = createClient<AppRouter>({
  transport,
});


createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Wrap the App with the TypeQLProvider */}
    <TypeQLProvider client={client}>
      <App />
    </TypeQLProvider>
  </StrictMode>,
);
