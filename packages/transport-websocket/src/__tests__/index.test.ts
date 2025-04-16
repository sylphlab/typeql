// packages/transport-websocket/src/__tests__/index.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWebSocketTransport } from '../index';
import type { TypeQLTransport, ProcedureCallMessage, ProcedureResultMessage, SubscribeMessage, AckMessage, RequestMissingMessage, SubscriptionDataMessage, SubscriptionErrorMessage, SubscriptionEndMessage } from '@sylph/typeql-core';
import { WebSocketServer, WebSocket } from 'ws'; // Import WebSocketServer for mocking

// Mock Server Setup
let mockServer: WebSocketServer;
let serverSocket: WebSocket | null = null;
const serverPort = 8088; // Use a specific port for testing
const serverUrl = `ws://localhost:${serverPort}`;

const startMockServer = (): Promise<void> => {
    return new Promise((resolve) => {
        mockServer = new WebSocketServer({ port: serverPort });
        mockServer.on('connection', (ws) => {
            console.log('[Mock Server] Client connected');
            serverSocket = ws;
            // Handle messages from the client transport
            ws.on('message', (message) => {
                console.log('[Mock Server] Received:', message.toString());
                // Basic echo or specific responses can be added here for tests
            });
            ws.on('close', () => {
                console.log('[Mock Server] Client disconnected');
                serverSocket = null;
            });
            ws.on('error', (error) => {
                console.error('[Mock Server] Error:', error);
                serverSocket = null;
            });
        });
        mockServer.on('listening', () => {
            console.log(`[Mock Server] Listening on ${serverUrl}`);
            resolve();
        });
        mockServer.on('error', (error) => {
             console.error('[Mock Server] Failed to start:', error);
             // No reject here, let tests handle connection failure if needed
        });
    });
};

const stopMockServer = (): Promise<void> => {
    return new Promise((resolve, reject) => {
        if (serverSocket) {
            serverSocket.close();
            serverSocket = null;
        }
        if (mockServer) {
            mockServer.close((err) => {
                if (err) {
                    console.error('[Mock Server] Failed to stop:', err);
                    reject(err);
                } else {
                    console.log('[Mock Server] Stopped');
                    resolve();
                }
            });
        } else {
            resolve();
        }
    });
};

// Helper to send message from mock server
const sendFromServer = (message: any) => {
    if (serverSocket && serverSocket.readyState === WebSocket.OPEN) {
        try {
            const payload = JSON.stringify(message);
            console.log('[Mock Server] Sending:', payload);
            serverSocket.send(payload);
            return true;
        } catch (e) {
            console.error('[Mock Server] Failed to send:', e);
            return false;
        }
    } else {
        console.warn('[Mock Server] Cannot send, socket not open or not available.');
        return false;
    }
};


describe('WebSocketTransport', () => {
    let transport: TypeQLTransport;

    beforeEach(async () => {
        await startMockServer();
        // Create transport instance before each test, passing the Node 'ws' implementation
        transport = createWebSocketTransport({
            url: serverUrl,
            WebSocket: WebSocket, // Pass the 'ws' WebSocket class
            // Short reconnect delays for testing
            baseReconnectDelayMs: 50,
            maxReconnectAttempts: 3,
            requestTimeoutMs: 100, // Short request timeout
        });
        // Wait for initial connection attempt
        await transport!.connect!(); // Add non-null assertion
        // Short delay to ensure server connection handler runs
        await new Promise(res => setTimeout(res, 10));
    });

    afterEach(async () => {
        transport!.disconnect!(); // Add non-null assertion
        await stopMockServer(); // Stop the mock server
        vi.clearAllMocks();
        vi.useRealTimers(); // Ensure real timers are restored
    });

    it('should connect to the server', async () => {
        expect(transport.connected).toBe(true);
        expect(serverSocket).not.toBeNull();
    });

    it('should disconnect from the server', async () => {
        expect(transport!.connected).toBe(true);
        transport!.disconnect!(); // Add non-null assertion
        expect(transport!.connected).toBe(false);
        // Allow time for server to register disconnect
        await new Promise(res => setTimeout(res, 50));
        expect(serverSocket).toBeNull();
    });

    it('should notify connection status changes', async () => {
        const connectionHandler = vi.fn();
        const unsubscribe = transport!.onConnectionChange!(connectionHandler); // Add non-null assertions

        expect(connectionHandler).not.toHaveBeenCalled(); // Should not call immediately

        // Simulate server disconnect
        await stopMockServer();
        // Wait for close event and reconnect logic to trigger status change
        await new Promise(res => setTimeout(res, 150)); // Wait past reconnect delay

        expect(connectionHandler).toHaveBeenCalledWith(false);

        // Simulate server reconnect
        await startMockServer();
        // Wait for reconnect attempt
        await new Promise(res => setTimeout(res, 150)); // Wait past reconnect delay

        expect(connectionHandler).toHaveBeenCalledWith(true);

        if (typeof unsubscribe === 'function') { // Check if unsubscribe is a function
            unsubscribe();
        }
        await stopMockServer();
         await new Promise(res => setTimeout(res, 150));
        // Should not be called after unsubscribe
        expect(connectionHandler).toHaveBeenCalledTimes(2);
    });

    // --- Request Tests ---
    it('should send a request and receive a result', async () => {
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

     it('should reject request on timeout', async () => {
        vi.useFakeTimers();
        const request: ProcedureCallMessage = { id: 'req3', type: 'query', path: 'test.timeout' };

        // No response from server configured

        const requestPromise = transport.request(request);

        // Advance timer past the timeout
        vi.advanceTimersByTime(150); // Default timeout is 100ms

        await expect(requestPromise).rejects.toThrow('Request timed out after 100ms (ID: req3)');
        vi.useRealTimers();
    });

    it('should reject request if disconnected during request', async () => {
        const request: ProcedureCallMessage = { id: 'req4', type: 'query', path: 'test.disconnect' };

        const requestPromise = transport!.request!(request); // Add non-null assertion

        // Disconnect immediately after sending (or trying to send)
        transport!.disconnect!(1001, 'Test disconnect'); // Add non-null assertion, arguments are now allowed

        await expect(requestPromise).rejects.toThrow('Transport disconnected by user');
    });


    // --- Subscription Tests ---
    it('should subscribe and receive data messages via iterator', async () => {
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
             // Check if either the error was caught OR yielded
             expect(caughtError !== null || (received.length > 0 && received[0]?.type === 'subscriptionError')).toBe(true);
         });

        // Depending on implementation (yield error vs throw error):
        // Option 1: Error is yielded
        expect(received.length).toBe(1);
        expect(received[0]).toEqual(errorMsg);
        expect(caughtError).toBeNull();

        // Option 2: Error is thrown (adjust expectations if this is the case)
        // expect(received.length).toBe(0);
        // expect(caughtError).toBeInstanceOf(Error);
        // expect(caughtError.message).toContain('Subscription failed');

        // No need to call unsubscribe explicitly as iterator finished/errored
    });


    it('should send unsubscribe message when iterator is explicitly returned', async () => {
        const subMessage: SubscribeMessage = { id: 'sub4', type: 'subscription', path: 'test.unsubscribe' };
        const { iterator } = transport.subscribe(subMessage);
        let unsubscribeSent = false;

        serverSocket?.on('message', (msg) => {
            const received = JSON.parse(msg.toString());
            if (received.type === 'subscriptionStop' && received.id === 'sub4') {
                unsubscribeSent = true;
            }
        });

        await new Promise(res => setTimeout(res, 20)); // Wait for subscribe send

        // Start iterating but break early
        const received: any[] = [];
        for await (const msg of iterator) {
            received.push(msg);
            // Simulate breaking the loop early, triggering iterator.return()
            break;
        }

        // iterator.return() should be called implicitly by the 'break' in for-await-of
        // We need to wait for the potential unsubscribe message to be sent
        await vi.waitFor(() => {
            expect(unsubscribeSent).toBe(true);
        });
    });


    // --- Ack and Gap Recovery Tests ---
    it('should call onAckReceived when ack message is received', async () => {
        const ackHandler = vi.fn();
        // Recreate transport with the handler
        transport!.disconnect!(); // Add non-null assertion
        transport = createWebSocketTransport({ url: serverUrl, WebSocket: WebSocket, onAckReceived: ackHandler });
        await transport!.connect!(); // Add non-null assertion
        await new Promise(res => setTimeout(res, 10)); // Ensure connection

        const ack: AckMessage = { id: 'ack1', type: 'ack', clientSeq: 123, serverSeq: 456 };
        sendFromServer(ack);

        await vi.waitFor(() => {
            expect(ackHandler).toHaveBeenCalledTimes(1);
        });
        expect(ackHandler).toHaveBeenCalledWith(ack);
    });

    it('should send request_missing message via requestMissingDeltas', async () => {
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
    it('should attempt to reconnect on unexpected disconnect', async () => {
        expect(transport.connected).toBe(true);

        // Simulate unexpected server close
        serverSocket?.close(1006); // Abnormal closure
        await vi.waitFor(() => expect(transport.connected).toBe(false)); // Wait for disconnect detection

        // Transport should attempt reconnect based on options (base 50ms, 3 attempts)
        // Wait longer than the first reconnect delay
        await new Promise(res => setTimeout(res, 100));

        // Server is still down, so it should still be disconnected
        expect(transport.connected).toBe(false);

        // Restart server
        await startMockServer();

        // Wait for subsequent reconnect attempts
        await vi.waitFor(() => expect(transport.connected).toBe(true), { timeout: 500 }); // Wait up to 500ms

        expect(transport.connected).toBe(true);
    });

     it('should resubscribe after successful reconnect', async () => {
        const subMessage: SubscribeMessage = { id: 'subResub', type: 'subscription', path: 'test.reconnect' };
        const { iterator, unsubscribe } = transport.subscribe(subMessage);
        let subscribeReceivedCount = 0;
        let resubscribeReceived = false;

        serverSocket?.on('message', (msg) => {
            const received = JSON.parse(msg.toString());
            if (received.type === 'subscription' && received.id === 'subResub') {
                subscribeReceivedCount++;
                if (subscribeReceivedCount > 1) {
                    resubscribeReceived = true;
                }
                // Don't send data initially
            }
        });

        // Wait for initial subscribe
        await vi.waitFor(() => expect(subscribeReceivedCount).toBe(1));

        // Simulate disconnect and reconnect
        await stopMockServer();
        await vi.waitFor(() => expect(transport.connected).toBe(false));
        await startMockServer(); // Restart server
        await vi.waitFor(() => expect(transport.connected).toBe(true), { timeout: 500 }); // Wait for reconnect

        // Check if resubscribe message was sent
        await vi.waitFor(() => expect(resubscribeReceived).toBe(true));
        expect(subscribeReceivedCount).toBeGreaterThanOrEqual(2); // Should have received subscribe at least twice

        unsubscribe();
    });


});