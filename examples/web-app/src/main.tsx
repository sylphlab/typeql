import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.js'; // Add extension
import type { zenQueryTransport } from '@sylphlab/zen-query-shared'; // Import transport type
import { createClient } from '@sylphlab/zen-query-client'; // Use client package
import { createWebSocketTransport } from '@sylphlab/zen-query-transport-websocket'; // Import WS transport
import { zenQueryProvider } from '@sylphlab/zen-query-react'; // Import React provider
import type { AppRouter } from '../server/index.js'; // Import the AppRouter type from server with extension

// Create the WebSocket transport
const transport: zenQueryTransport = createWebSocketTransport({ // Explicitly type transport
  url: 'ws://localhost:8080', // URL of our server
});

// Create the zenQuery client, providing the AppRouter type
const client = createClient<AppRouter>({
  transport,
});


createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Wrap the App with the zenQueryProvider */}
    <zenQueryProvider client={client}>
      <App />
    </zenQueryProvider>
  </StrictMode>,
);
