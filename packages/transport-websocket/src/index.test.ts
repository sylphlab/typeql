// packages/transport-websocket/src/__tests__/index.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWebSocketTransport } from './index'; // Updated path
import type { TypeQLTransport, ProcedureCallMessage, ProcedureResultMessage, SubscribeMessage, AckMessage, RequestMissingMessage, SubscriptionDataMessage, SubscriptionErrorMessage, SubscriptionEndMessage } from '@sylphlab/typeql-shared'; // Use shared package
import { WebSocketServer, WebSocket } from 'ws'; // Import WebSocketServer for mocking

// Mock Server Setup
let mockServer: WebSocketServer;
let serverSocket: WebSocket | null = null;
const serverPort = 8088; // Use a specific port for testing
const serverUrl = `ws://localhost:${serverPort}`;

const startMockServer = (): Promise<WebSocketServer> => { // Return the server instance
    return new Promise((resolve, reject) => {
        try {
            mockServer = new WebSocketServer({ port: serverPort });

            // Add error handler for server creation itself
            mockServer.on('error', (error) => {
                 console.error('[Mock Server] Server error:', error);
                 // Clean up if server failed to start properly
                 // Check address() instead of listening property
                 if (mockServer && mockServer.address()) {
                     mockServer.close();
                 }
                 reject(error); // Reject the promise on server error
            });

            mockServer.on('connection', (ws) => {
            // console.log('[Mock Server] Client connected');
            serverSocket = ws;
            // Handle messages from the client transport
            ws.on('message', (message) => {
                // console.log('[Mock Server] Received:', message.toString());
                // Basic echo or specific responses can be added here for tests
            });
            ws.on('close', () => {
                // console.log('[Mock Server] Client disconnected');
                serverSocket = null;
            });
            ws.on('error', (error) => {
                // console.error('[Mock Server] Error:', error);
                serverSocket = null;
            });
            });

            mockServer.on('listening', () => {
                // console.log(`[Mock Server] Listening on ${serverUrl}`);
                resolve(mockServer); // Resolve with the server instance
            });

        } catch (error) {
             console.error('[Mock Server] Exception during server creation:', error);
             reject(error);
        }
    });
};

// Simplified stopMockServer - relies on close callback and timeout
const stopMockServer = (serverInstance?: WebSocketServer): Promise<void> => {
    const serverToClose = serverInstance || mockServer;
    return new Promise((resolve) => {
        if (serverSocket) {
            serverSocket.terminate(); // Force close client
            serverSocket = null;
        }
        if (serverToClose && serverToClose.address()) {
            let resolved = false;
            // Resolve after a short delay OR when close callback fires
            const timeoutId = setTimeout(() => {
                if (!resolved) {
                    console.warn('[Mock Server] stopMockServer timeout reached.');
                    resolved = true;
                    resolve();
                }
            }, 200); // Shorter timeout

            serverToClose.close((err) => {
                clearTimeout(timeoutId); // Clear timeout if close completes
                if (!resolved) {
                    if (err) {
                        console.error('[Mock Server] Error closing server:', err);
                    }
                    resolved = true;
                    resolve();
                }
            });
        } else {
            resolve(); // Nothing to close
        }
    });
};

// Helper to send message from mock server
const sendFromServer = (message: any) => {
    if (serverSocket && serverSocket.readyState === WebSocket.OPEN) {
        try {
            const payload = JSON.stringify(message);
            // console.log('[Mock Server] Sending:', payload);
            serverSocket.send(payload);
            return true;
        } catch (e) {
            // console.error('[Mock Server] Failed to send:', e);
            return false;
        }
    } else {
        // console.warn('[Mock Server] Cannot send, socket not open or not available.');
        return false;
    }
};


describe('WebSocketTransport', { timeout: 5000 }, () => { // Add 5 second timeout
    let transport: TypeQLTransport;

    let currentMockServer: WebSocketServer | undefined; // Store server instance per test

    beforeEach(async () => {
        // Ensure any previous server is stopped
        await stopMockServer(currentMockServer);
        currentMockServer = undefined;
        serverSocket = null;

        try {
            currentMockServer = await startMockServer(); // Wait for server to be ready
        } catch (e) {
            console.error("Failed to start mock server in beforeEach:", e);
            // Optionally re-throw or handle, depending on desired test behavior on setup failure
            throw e; // Fail the test if server can't start
        }

        // Create transport instance before each test, passing the Node 'ws' implementation
        // Note: We will redefine transport in specific tests needing different options or setup.
        // Default transport creation removed from here.
        //     url: serverUrl,
        //     WebSocket: WebSocket, // Pass the 'ws' WebSocket class
            // Short reconnect delays for testing
            // baseReconnectDelayMs: 50,
            // maxReconnectAttempts: 3,
            // requestTimeoutMs: 100, // Short request timeout
        // }); // Closing brace was commented out, causing syntax error. Fixed.

        // Connection will be established within tests that need it.
        // Ensure a default transport is created if not overridden by a test
         if (!transport) {
             transport = createWebSocketTransport({
                 url: serverUrl,
                 WebSocket: WebSocket,
                 baseReconnectDelayMs: 50,
                 maxReconnectAttempts: 3,
                 requestTimeoutMs: 100,
             });
             // Connect it for tests that might rely on beforeEach connection
             try {
                 await transport!.connect!();
                 await new Promise(res => setTimeout(res, 50));
             } catch (e) {
                 console.warn("Default transport connection failed in beforeEach:", e);
             }
         }
    });

    afterEach(async () => {
        // console.log(`[Test Cleanup] Starting afterEach for: ${expect.getState().currentTestName}`);
        if (transport) {
             // console.log('[Test Cleanup] Disconnecting transport...');
             transport.disconnect?.();
        } else {
            // console.log('[Test Cleanup] No transport instance to disconnect.');
        }
        // console.log('[Test Cleanup] Stopping mock server...');
        await stopMockServer(currentMockServer); // Pass the specific server instance
        currentMockServer = undefined;
        serverSocket = null;
        // console.log('[Test Cleanup] Clearing mocks...');
        vi.clearAllMocks();
        // console.log(`[Test Cleanup] Finished afterEach for: ${expect.getState().currentTestName}`);
         // Add a slightly longer delay to ensure ports are released etc.
         await new Promise(res => setTimeout(res, 100));
    });

    it('should connect to the server', async () => {
        // Ensure transport is connected for this test
        if (!transport || !transport.connected) {
             transport = createWebSocketTransport({ url: serverUrl, WebSocket: WebSocket });
             await transport.connect!();
             await new Promise(res => setTimeout(res, 50));
        }
        expect(transport.connected).toBe(true);
        expect(serverSocket).not.toBeNull();
    });

    it('should disconnect from the server', async () => {
         // Ensure transport is connected for this test
         if (!transport || !transport.connected) {
             transport = createWebSocketTransport({ url: serverUrl, WebSocket: WebSocket });
             await transport.connect!();
             await new Promise(res => setTimeout(res, 50));
         }
        expect(transport!.connected).toBe(true);
        transport!.disconnect!(); // Add non-null assertion
        expect(transport!.connected).toBe(false);
        // Allow time for server to register disconnect
        await new Promise(res => setTimeout(res, 50));
        expect(serverSocket).toBeNull();
    });

    it('should notify connection status changes', { timeout: 10000 }, async () => { // Increased timeout further
         // Ensure transport is connected for this test
         if (!transport || !transport.connected) {
             transport = createWebSocketTransport({ url: serverUrl, WebSocket: WebSocket, baseReconnectDelayMs: 50, maxReconnectAttempts: 3 });
             await transport.connect!();
             await new Promise(res => setTimeout(res, 50));
         }
        const connectionHandler = vi.fn();
        const unsubscribe = transport!.onConnectionChange!(connectionHandler);

        expect(connectionHandler).not.toHaveBeenCalled();

        // Simulate server disconnect
        await stopMockServer(currentMockServer); // Ensure correct server is stopped
        currentMockServer = undefined; // Mark as stopped

        // Wait for the handler to be called with 'false'
        await vi.waitFor(() => {
            expect(connectionHandler).toHaveBeenCalledWith(false);
        }, { timeout: 3000 }); // Increased timeout

        // Simulate server reconnect
        currentMockServer = await startMockServer(); // Wait for new server to start
        // Need to wait for the client to potentially attempt connection again
        // and for the server to accept it.

        // Wait for the handler to be called with 'true'
        await vi.waitFor(() => {
            expect(connectionHandler).toHaveBeenCalledWith(true);
        }, { timeout: 6000 }); // Increased timeout significantly for reconnect

        // Check final call count
        expect(connectionHandler).toHaveBeenCalledTimes(2); // Once for false, once for true

        if (typeof unsubscribe === 'function') {
            unsubscribe();
        }

        // Simulate another disconnect after unsubscribing
        const callsBeforeLastDisconnect = connectionHandler.mock.calls.length;
        await stopMockServer(currentMockServer);
        currentMockServer = undefined;
        await new Promise(res => setTimeout(res, 300)); // Allow time for potential call

        // Handler should not be called again
        expect(connectionHandler).toHaveBeenCalledTimes(callsBeforeLastDisconnect);
    });


    // --- Request Tests ---
    it('should send a request and receive a result', async () => {
         // Ensure transport is connected for this test
         if (!transport || !transport.connected) {
             transport = createWebSocketTransport({ url: serverUrl, WebSocket: WebSocket });
             await transport.connect!();
             await new Promise(res => setTimeout(res, 50));
         }
        const request: ProcedureCallMessage = { id: 'req1', type: 'query', path: 'test.get' };
        const expectedResult: ProcedureResultMessage = {
            id: 'req1',
            result: { type: 'data', data: { value: 'test data' } }
        };

        // Set up server response
        serverSocket?.on('message', (msg) => {
            const received = JSON.parse(msg.toString());
            if (received.id === 'req1') {
                sendFromServer(expectedResult);
            }
        });

        const result = await transport.request(request);
        expect(result).toEqual(expectedResult);
    });

    it('should reject request on server error result', async () => {
         // Ensure transport is connected for this test
         if (!transport || !transport.connected) {
             transport = createWebSocketTransport({ url: serverUrl, WebSocket: WebSocket });
             await transport.connect!();
             await new Promise(res => setTimeout(res, 50));
         }
        const request: ProcedureCallMessage = { id: 'req2', type: 'mutation', path: 'test.fail' };
        const errorResult: ProcedureResultMessage = {
            id: 'req2',
            result: { type: 'error', error: { message: 'Mutation failed', code: 'INTERNAL_SERVER_ERROR' } }
        };

        serverSocket?.on('message', (msg) => {
            const received = JSON.parse(msg.toString());
            if (received.id === 'req2') {
                sendFromServer(errorResult);
            }
        });

        await expect(transport.request(request)).rejects.toThrow('Mutation failed');
    });

     // Test timeout using real timers
     it('should reject request on timeout', { timeout: 500 }, async () => { // Increased test timeout
         // Ensure transport is connected for this test
         if (!transport || !transport.connected) {
             transport = createWebSocketTransport({ url: serverUrl, WebSocket: WebSocket, requestTimeoutMs: 100 });
             await transport.connect!();
             await new Promise(res => setTimeout(res, 50));
        }
        // Removed the 'else' block that caused the error.
        // Transport will always be recreated with the correct timeout for this test.
       const request: ProcedureCallMessage = { id: 'req3', type: 'query', path: 'test.timeout' };

        // No response from server configured

        const requestPromise = transport.request(request);

        // Expect the promise to reject after the internal 100ms timeout
        await expect(requestPromise).rejects.toThrow('Request timed out after 100ms (ID: req3)');

        // No need for fake timers
    });

    it('should reject request if disconnected during request', async () => {
         // Ensure transport is connected for this test
         if (!transport || !transport.connected) {
             transport = createWebSocketTransport({ url: serverUrl, WebSocket: WebSocket });
             await transport.connect!();
             await new Promise(res => setTimeout(res, 50));
         }
        const request: ProcedureCallMessage = { id: 'req4', type: 'query', path: 'test.disconnect' };

        const requestPromise = transport!.request!(request); // Add non-null assertion

        // Disconnect immediately after sending (or trying to send)
        transport!.disconnect!(1001, 'Test disconnect'); // Add non-null assertion, arguments are now allowed

        await expect(requestPromise).rejects.toThrow('WebSocket not connected for request.'); // Match actual error
    });


    // --- Subscription Tests ---
    it('should subscribe and receive data messages via iterator', async () => {
         // Ensure transport is connected for this test
         if (!transport || !transport.connected) {
             transport = createWebSocketTransport({ url: serverUrl, WebSocket: WebSocket });
             await transport.connect!();
             await new Promise(res => setTimeout(res, 50));
         }
        const subMessage: SubscribeMessage = { id: 'sub1', type: 'subscription', path: 'test.updates' };
        const { iterator, unsubscribe } = transport.subscribe(subMessage);

        // Wait for subscribe message to be sent and potentially processed
        await new Promise(res => setTimeout(res, 20));

        // Simulate server sending data
        const data1: SubscriptionDataMessage = { id: 'sub1', type: 'subscriptionData', data: { count: 1 }, serverSeq: 1, prevServerSeq: 0 };
        const data2: SubscriptionDataMessage = { id: 'sub1', type: 'subscriptionData', data: { count: 2 }, serverSeq: 2, prevServerSeq: 1 };
        sendFromServer(data1);
        sendFromServer(data2);

        const received: any[] = [];
        // Use for await...of which handles the async iterator
        (async () => {
             for await (const msg of iterator) {
                 received.push(msg);
                 if (received.length === 2) break; // Stop after receiving expected messages
             }
        })();


        // Wait for messages to be processed
        await vi.waitFor(() => {
            expect(received.length).toBe(2);
        });

        expect(received[0]).toEqual(data1);
        expect(received[1]).toEqual(data2);

        unsubscribe();
    });

     it('should handle subscription end message', async () => {
         // Ensure transport is connected for this test
         if (!transport || !transport.connected) {
             transport = createWebSocketTransport({ url: serverUrl, WebSocket: WebSocket });
             await transport.connect!();
             await new Promise(res => setTimeout(res, 50));
         }
        const subMessage: SubscribeMessage = { id: 'sub2', type: 'subscription', path: 'test.finite' };
        const { iterator, unsubscribe } = transport.subscribe(subMessage);

        await new Promise(res => setTimeout(res, 20));

        const data1: SubscriptionDataMessage = { id: 'sub2', type: 'subscriptionData', data: { status: 'running' }, serverSeq: 1, prevServerSeq: 0 };
        const endMsg: SubscriptionEndMessage = { id: 'sub2', type: 'subscriptionEnd' };
        sendFromServer(data1);
        sendFromServer(endMsg);

        const received: any[] = [];
        let isDone = false;
        try {
            for await (const msg of iterator) {
                received.push(msg);
            }
            // This part should be reached when the iterator completes
            isDone = true;
        } catch (e) {
            // Should not throw in this case
        }


        await vi.waitFor(() => {
             expect(isDone).toBe(true);
        });

        expect(received.length).toBe(1);
        expect(received[0]).toEqual(data1);

        // No need to call unsubscribe explicitly as iterator finished
    });

    it('should handle subscription error message', async () => {
         // Ensure transport is connected for this test
         if (!transport || !transport.connected) {
             transport = createWebSocketTransport({ url: serverUrl, WebSocket: WebSocket });
             await transport.connect!();
             await new Promise(res => setTimeout(res, 50));
         }
        const subMessage: SubscribeMessage = { id: 'sub3', type: 'subscription', path: 'test.error' };
        const { iterator, unsubscribe } = transport.subscribe(subMessage);

        await new Promise(res => setTimeout(res, 20));

        const errorMsg: SubscriptionErrorMessage = { id: 'sub3', type: 'subscriptionError', error: { message: 'Subscription failed', code: 'FORBIDDEN' } };
        sendFromServer(errorMsg);

        const received: any[] = [];
        let caughtError: any = null;
        let isDone = false;

        try {
            for await (const msg of iterator) {
                // If the error is yielded instead of thrown:
                if (msg.type === 'subscriptionError') {
                     received.push(msg);
                     // Break or let the iterator naturally end if error is yielded
                     break;
                }
                received.push(msg);
            }
             // Check if iterator finished without yielding error (it shouldn't if error is yielded)
             isDone = received.length > 0 && received[received.length - 1]?.type !== 'subscriptionError';
        } catch (e) {
            // If the error is thrown by the iterator:
            caughtError = e;
            isDone = true; // Iterator terminated due to error
        }

         await vi.waitFor(() => {
             // Check if the error was caught
             expect(caughtError).not.toBeNull();
         });

        // Error should be thrown by the iterator
        expect(received.length).toBe(0); // No messages should be yielded
        expect(caughtError).toBeInstanceOf(Error);
        expect(caughtError.message).toContain(errorMsg.error.message); // Check if the error message is included

        // Option 1: Error is yielded (Keep commented out as reference)
        // expect(received.length).toBe(1);
        // expect(received[0]).toEqual(errorMsg);
        // expect(caughtError).toBeNull();

        // Option 2: Error is thrown (Current expectation)
        // expect(received.length).toBe(0);
        // expect(caughtError).toBeInstanceOf(Error);
        // expect(caughtError.message).toContain('Subscription failed');

        // No need to call unsubscribe explicitly as iterator finished/errored
    });


    it('should send unsubscribe message when iterator is explicitly returned', { timeout: 1000 }, async () => { // Unskipped, use explicit return
         // Ensure transport is connected for this test
         if (!transport || !transport.connected) {
             transport = createWebSocketTransport({ url: serverUrl, WebSocket: WebSocket });
             await transport.connect!();
             await new Promise(res => setTimeout(res, 50));
         }
        const subMessage: SubscribeMessage = { id: 'sub4', type: 'subscription', path: 'test.unsubscribe' };
        const { iterator } = transport.subscribe(subMessage);
        let unsubscribeSent = false;

        serverSocket?.on('message', (msg) => {
            const received = JSON.parse(msg.toString());
            if (received.type === 'subscriptionStop' && received.id === 'sub4') {
                unsubscribeSent = true;
            }
        });

        await new Promise(res => setTimeout(res, 50)); // Wait a bit longer for subscribe send

        // Explicitly call return() on the iterator instead of relying on break
        // Use optional chaining as TS might consider .return optional
        const result = await iterator.return?.();
        expect(result?.done).toBe(true); // Check return() signals done

        // Wait for the unsubscribe message to be sent and received by the mock server
        await vi.waitFor(() => {
            expect(unsubscribeSent).toBe(true);
        }, { timeout: 500 }); // Increased waitFor timeout
    });


    // --- Ack and Gap Recovery Tests ---
    // Simplified test using existing transport
    it('should call onAckReceived when ack message is received', async () => {
        const ackHandler = vi.fn();

        // Create transport specifically for this test with the handler
        // Ensure previous transport is disconnected if exists
        if (transport) {
            transport.disconnect?.();
            await new Promise(res => setTimeout(res, 50)); // Allow disconnect
        }
        transport = createWebSocketTransport({
            url: serverUrl,
            WebSocket: WebSocket,
            baseReconnectDelayMs: 50,
            maxReconnectAttempts: 3,
            requestTimeoutMs: 100,
            onAckReceived: ackHandler, // Pass handler during creation
        });

        // Connect transport for this test
        await transport!.connect!();
        await new Promise(res => setTimeout(res, 50)); // Allow connection
        expect(transport.connected).toBe(true);
        expect(serverSocket).not.toBeNull();
        expect(serverSocket?.readyState).toBe(WebSocket.OPEN);


        const ack: AckMessage = { id: 'ack1', type: 'ack', clientSeq: 123, serverSeq: 456 };

        // Handler is already assigned via options

        const sent = sendFromServer(ack);
        expect(sent).toBe(true); // Ensure server could send the message

        // Wait for the ackHandler to be called
        await vi.waitFor(() => {
            expect(ackHandler).toHaveBeenCalledTimes(1);
        }, { timeout: 3000 }); // Further increased timeout
        expect(ackHandler).toHaveBeenCalledWith(ack);

        // No need to cleanup handler manually
    }, 4000); // Keep increased timeout

    it('should send request_missing message via requestMissingDeltas', async () => {
        // Re-create and connect transport for this test if needed
        if (!transport || !transport.connected) {
            // Ensure previous transport is disconnected if exists
            if (transport) {
                transport.disconnect?.();
                await new Promise(res => setTimeout(res, 50)); // Allow disconnect
            }
             transport = createWebSocketTransport({
                 url: serverUrl,
                 WebSocket: WebSocket,
                 baseReconnectDelayMs: 50,
                 maxReconnectAttempts: 3,
                 requestTimeoutMs: 100,
             });
             await transport!.connect!();
             await new Promise(res => setTimeout(res, 50));
             expect(transport.connected).toBe(true);
        }

        let missingRequestReceived = false;
        let receivedMessage: any = null;

        serverSocket?.on('message', (msg) => {
            const received = JSON.parse(msg.toString());
            if (received.type === 'request_missing') {
                missingRequestReceived = true;
                receivedMessage = received;
            }
        });

        const subId = 'subGap';
        const fromSeq = 10;
        const toSeq = 15;
        transport!.requestMissingDeltas!(subId, fromSeq, toSeq); // Add non-null assertion

        await vi.waitFor(() => {
            expect(missingRequestReceived).toBe(true);
        });

        expect(receivedMessage).toEqual({
            type: 'request_missing',
            id: subId,
            fromSeq: fromSeq,
            toSeq: toSeq
        });
    });

    // --- Reconnect Tests ---
    it('should attempt to reconnect on unexpected disconnect', { timeout: 10000 }, async () => { // Unskipped, simplified assertions
         // Re-create and connect transport for this test if needed
         if (!transport || !transport.connected) {
            // Ensure previous transport is disconnected if exists
            if (transport) {
                transport.disconnect?.();
                await new Promise(res => setTimeout(res, 50)); // Allow disconnect
            }
             transport = createWebSocketTransport({
                 url: serverUrl,
                 WebSocket: WebSocket,
                 baseReconnectDelayMs: 50,
                 maxReconnectAttempts: 3,
                 requestTimeoutMs: 100,
             });
             await transport!.connect!();
             await new Promise(res => setTimeout(res, 50));
         }
        expect(transport.connected).toBe(true);

        // Simulate unexpected server close
        serverSocket?.terminate(); // Simulate abnormal closure

        // Wait for disconnect detection
        await vi.waitFor(() => expect(transport.connected).toBe(false), { timeout: 5000 }); // Further increased timeout

        // Restart server - MUST await stop before starting again
        await stopMockServer(currentMockServer); // Ensure previous is stopped
        currentMockServer = undefined;
        currentMockServer = await startMockServer(); // Wait for new server to start

        // Wait for reconnect success
        await vi.waitFor(() => expect(transport.connected).toBe(true), { timeout: 7000 }); // Increased timeout

        // Final state should be connected
        expect(transport.connected).toBe(true);
    });


     it('should resubscribe after successful reconnect', async () => {
         // Re-create and connect transport for this test if needed
         if (!transport || !transport.connected) {
            // Ensure previous transport is disconnected if exists
            if (transport) {
                transport.disconnect?.();
                await new Promise(res => setTimeout(res, 50)); // Allow disconnect
            }
             transport = createWebSocketTransport({
                 url: serverUrl,
                 WebSocket: WebSocket,
                 baseReconnectDelayMs: 50,
                 maxReconnectAttempts: 3,
                 requestTimeoutMs: 100,
             });
             await transport!.connect!();
             await new Promise(res => setTimeout(res, 50));
         }
        const subMessage: SubscribeMessage = { id: 'subResub', type: 'subscription', path: 'test.reconnect' };
        const { iterator, unsubscribe } = transport.subscribe(subMessage);
        let subscribeReceivedCount = 0;
        let resubscribeReceived = false;

        const messageHandler = (msg: Buffer) => { // Define handler separately
            const received = JSON.parse(msg.toString());
            if (received.type === 'subscription' && received.id === 'subResub') {
                subscribeReceivedCount++;
                if (subscribeReceivedCount > 1) {
                    resubscribeReceived = true;
                }
                // Don't send data initially
            }
        };
        serverSocket?.on('message', messageHandler); // Attach initially

        // Wait for initial subscribe
        await vi.waitFor(() => expect(subscribeReceivedCount).toBe(1));

        // Simulate disconnect and reconnect
        await stopMockServer(currentMockServer);
        currentMockServer = undefined;
        await vi.waitFor(() => expect(transport.connected).toBe(false), { timeout: 3000 }); // Increased timeout
        currentMockServer = await startMockServer(); // Restart server and wait

        // Wait for the new connection and get the new serverSocket instance
        await new Promise<void>((resolveServerConnection) => {
            mockServer.once('connection', (newWs) => {
                // console.log('[Test] New server connection established.');
                serverSocket = newWs; // Update serverSocket reference
                // Re-attach listener to the new socket
                serverSocket.on('message', messageHandler);
                resolveServerConnection();
            });
        });

        // Wait for the transport to report connected status
        await vi.waitFor(() => expect(transport.connected).toBe(true), { timeout: 8000 }); // Further increased timeout

        // Check if resubscribe message was sent
        await vi.waitFor(() => expect(resubscribeReceived).toBe(true), { timeout: 3000 }); // Further increased timeout
        expect(subscribeReceivedCount).toBeGreaterThanOrEqual(2); // Should have received subscribe at least twice

        unsubscribe();
    });


});