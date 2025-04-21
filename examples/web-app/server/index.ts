import {
    ProcedureContext, // Import base context type
    ProcedureResultMessage, SubscriptionDataMessage, SubscriptionErrorMessage, SubscriptionEndMessage, AckMessage, ProcedureCallMessage, SubscribeMessage, UnsubscribeMessage,
    zenQueryTransport // Import zenQueryTransport type
} from '@sylphlab/zen-query-shared'; // Shared types
import {
    createRouter,
    initzenQuery, // Import procedure builder initializer
    createRequestHandler,
    SubscriptionManager // Import SubscriptionManager class
} from '@sylphlab/zen-query-server'; // Server functions
import { z } from 'zod';

// --- Debugging: Catch unhandled errors ---
process.on('unhandledRejection', (reason, promise) => {
  console.error('!!! Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1); // Exit with error
});

process.on('uncaughtException', (error) => {
  console.error('!!! Uncaught Exception:', error);
  process.exit(1); // Exit with error
});
// --- End Debugging ---

import { WebSocketServer, WebSocket } from 'ws';

let currentCount = 0;

// Simple observable implementation for the counter
const counterObservable = (() => {
    const listeners = new Set<(count: number) => void>();
    return {
        subscribe(listener: (count: number) => void) {
            listeners.add(listener);
            listener(currentCount); // Send initial value
            return () => listeners.delete(listener);
        },
        next(count: number) {
            listeners.forEach(listener => listener(count));
        }
    };
})();

// Initialize procedure builder (using a basic context for this example)
const t = initzenQuery<ProcedureContext>();

const counterRouter = createRouter<ProcedureContext>()({ // Pass context type to createRouter
    getCount: t.query.resolve(() => currentCount), // Use t.query.resolve
    increment: t.mutation // Use t.mutation.input().resolve()
        .input(z.object({ amount: z.number().optional().default(1) }))
        .resolve(({ input }: { input: { amount: number } }) => { // Add explicit type
            currentCount += input.amount;
            counterObservable.next(currentCount); // Notify subscribers
            return currentCount;
        }),
    decrement: t.mutation // Use t.mutation.input().resolve()
        .input(z.object({ amount: z.number().optional().default(1) }))
        .resolve(({ input }: { input: { amount: number } }) => { // Add explicit type
            currentCount -= input.amount;
            counterObservable.next(currentCount); // Notify subscribers
            return currentCount;
        }),
    onCountUpdate: t.subscription.subscribe(({ publish }: { publish: (data: number) => void }) => { // Add explicit type for publish
            // This function should set up the subscription and return a cleanup function.
            console.log('[Server] Client subscribed to onCountUpdate');

            // Define the listener that uses the provided publish function
            const listener = (count: number) => {
                publish(count); // Publish the new count to the client
            };

            // Subscribe to the underlying counter observable
            const unsubscribe = counterObservable.subscribe(listener);

            // Return the cleanup function
            return () => {
                console.log('[Server] Cleaning up onCountUpdate subscription');
                unsubscribe(); // Unsubscribe from the counter observable
            };
        }), // Close the subscribe function call
}); // Close the createRouter call's procedure object

// Define the main AppRouter type
export type AppRouter = typeof counterRouter;

// --- WebSocket Server Setup ---
const wss = new WebSocketServer({ port: 8080 });
console.log('WebSocket server started on port 8080');

// Create a single SubscriptionManager instance for the server
const subscriptionManager = new SubscriptionManager();

// Basic context creation function
const createContext = async (): Promise<ProcedureContext> => {
    // In a real app, you might fetch user data, etc.
    return {};
};

wss.on('connection', (ws: WebSocket) => { // Add type for ws
    console.log('Client connected');

    // Define a function to send messages back to this specific client
    const sendToClient = (message: ProcedureResultMessage | SubscriptionDataMessage | SubscriptionErrorMessage | SubscriptionEndMessage | AckMessage) => {
        if (ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(JSON.stringify(message));
            } catch (error) {
                 console.error('Failed to send message to client:', error);
            }
        }
    };

    // Create the transport-like object for the handler, satisfying zenQueryTransport
    const transportForHandler: zenQueryTransport = {
        send: sendToClient,
        onDisconnect: (cleanupFn: () => void): (() => void) => { // Correct implementation
            const closeListener = () => {
                 console.log('Client disconnected, running handler cleanup');
                 cleanupFn();
            };
            const errorListener = (err: Error) => {
                 console.error('WebSocket error, running handler cleanup:', err);
                 cleanupFn();
            };
            ws.once('close', closeListener);
            ws.once('error', errorListener);
            // Return the unregister function
            return () => {
                ws.off('close', closeListener);
                ws.off('error', errorListener);
            };
        }, // Close onDisconnect method
        // Add dummy implementations for methods not used by server handler but required by type
        request: async (message: ProcedureCallMessage) => { // Add type for message
            console.error("Server handler transport should not call 'request'", message);
            // Return an error result matching ProcedureResultMessage structure
            return { id: message.id, result: { type: 'error', error: { message: 'Internal Server Error: Invalid transport usage' } } };
        },
        subscribe: (message: SubscribeMessage) => { // Add type for message
            console.error("Server handler transport should not call 'subscribe'", message);
            // Return a dummy subscription object
            return {
                iterator: (async function*() {})(), // Empty async generator
                unsubscribe: () => {}
            };
        },
        // Add other optional methods if needed by the interface, otherwise leave as undefined/null if allowed
        // onAckReceived: undefined,
        // requestMissingDeltas: undefined,
        // connect: undefined,
        // disconnect: undefined,
        // connected: false, // Or a getter returning false
        // onConnectionChange: undefined,
    };

    // Create a zenQuery request handler function for this specific client connection
    const handler = createRequestHandler<ProcedureContext>( // Assign the returned function directly
        { // Options object
            router: counterRouter,
            subscriptionManager: subscriptionManager, // Pass the manager instance
            createContext: createContext, // Pass the context function
        },
        transportForHandler // Pass the transport object
    );

    // Handle incoming messages from this client
    ws.on('message', async (message: Buffer | ArrayBuffer | Buffer[]) => { // Add type for message
         try {
             const messageString = message.toString();
             const parsedMessage = JSON.parse(messageString) as ProcedureCallMessage | UnsubscribeMessage;

             // Process the message using the handleMessage method of the handler object
             await handler.handleMessage(parsedMessage); // Correct: call handleMessage method

         } catch (error: unknown) { // Type the error as unknown
             console.error('Failed to process message or invalid JSON:', error);
             // Try to parse ID safely for error response
             let messageId: string | number = 'unknown';
             try {
                 const msgData = JSON.parse(message.toString());
                 if (msgData && typeof msgData === 'object' && 'id' in msgData) {
                     messageId = msgData.id;
                 }
             } catch { /* Ignore parsing error for ID */ }
             sendToClient({ id: messageId, result: { type: 'error', error: { message: 'Invalid message format' } } });
         }
     });

    // Note: 'close' and 'error' listeners for cleanup are now implicitly handled
    // by the `onDisconnect` logic passed to createRequestHandler.
    // We still keep top-level listeners for general logging if desired.
    ws.on('error', (error: Error) => { // Add type for error
        console.error('WebSocket error occurred (top-level):', error);
    });

     ws.on('close', () => {
         console.log('WebSocket connection closed (top-level)');
     });
});

console.log('zenQuery WebSocket server setup complete.');