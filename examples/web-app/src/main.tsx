import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { createClient } from '@typeql/core/client'; // Import client creator
import { createWebSocketTransport } from '@typeql/transport-websocket'; // Import WS transport
import { TypeQLProvider } from '@typeql/react'; // Import React provider
import type { AppRouter } from '../server'; // Import the AppRouter type from server

// Create the WebSocket transport
const transport = createWebSocketTransport({
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
