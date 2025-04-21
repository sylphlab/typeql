import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VSCodeTransport } from './index'; // Assuming VSCodeTransport is exported from index.ts
import type {
    ProcedureCallMessage,
    ProcedureResultMessage,
    SubscribeMessage,
    SubscriptionDataMessage,
    SubscriptionEndMessage,
    SubscriptionErrorMessage,
    AckMessage, // Added import
    RequestMissingMessage, // Added import
} from '@sylphlab/zen-query-shared';

// --- Mocks ---

// Mock the global acquireVsCodeApi function
const mockPostMessage = vi.fn();
const mockVsCodeApi = {
    postMessage: mockPostMessage,
    // Mock other API parts if needed
};
// No longer need realAcquireVsCodeApi or realWindow

// Mock event target (simulating window) and capture handler
type MessageHandler = (event: MessageEvent) => void;
let messageHandler: MessageHandler | null = null;
const mockAddEventListener = vi.fn((type, handler) => {
    if (type === 'message' && typeof handler === 'function') {
        messageHandler = handler as MessageHandler;
    }
});
const mockRemoveEventListener = vi.fn((type, handler) => {
     if (type === 'message' && messageHandler === handler) {
        messageHandler = null;
    }
});
const mockEventTarget = {
    addEventListener: mockAddEventListener,
    removeEventListener: mockRemoveEventListener,
};


// Helper to simulate receiving a message from the extension host
function simulateIncomingMessage(data: any) {
    if (messageHandler) {
        messageHandler({ data } as MessageEvent);
    } else {
        console.warn('No message handler attached to simulate incoming message');
    }
}

// --- Tests ---

import { ConnectionManager } from './connectionHandler'; // Import for mocking

// Mock the ConnectionManager
vi.mock('./connectionHandler');
const MockConnectionManager = vi.mocked(ConnectionManager);
const mockConnect = vi.fn();
const mockDisconnect = vi.fn();
const mockOnConnectionChange = vi.fn();
const mockOnDisconnect = vi.fn();
const mockIsConnected = vi.fn(() => true); // Default to connected

describe('@sylphlab/zen-query-transport-vscode', () => {
    let transport: VSCodeTransport;
    let connectionManagerInstance: InstanceType<typeof MockConnectionManager>;

    beforeEach(() => {
        // Reset mocks before each test
        MockConnectionManager.mockClear();
        mockConnect.mockClear();
        mockDisconnect.mockClear();
        mockOnConnectionChange.mockClear();
        mockOnDisconnect.mockClear();
        mockIsConnected.mockClear().mockReturnValue(true); // Reset to connected

        // Setup mock instance methods
        MockConnectionManager.mockImplementation(() => ({
            connect: mockConnect,
            disconnect: mockDisconnect,
            onConnectionChange: mockOnConnectionChange,
            onDisconnect: mockOnDisconnect,
            get isConnected() { return mockIsConnected(); },
            // Mock constructor args if needed, though they are callbacks
        } as unknown as InstanceType<typeof MockConnectionManager>));


        mockPostMessage.mockClear();
        mockAddEventListener.mockClear();
        mockRemoveEventListener.mockClear();
        messageHandler = null;

        // Create transport instance, injecting mocks
        transport = new VSCodeTransport(mockVsCodeApi, mockEventTarget);
        // Get the instance created inside the transport constructor
        connectionManagerInstance = MockConnectionManager.mock.instances[0];
    });

    afterEach(() => {
        // No need to restore globals as they are no longer stubbed here
        messageHandler = null;
    });

    it('should be created and attach message listener', () => {
        // Transport is created in beforeEach
        expect(transport).toBeInstanceOf(VSCodeTransport);
        // Check if the injected addEventListener was called
        expect(mockAddEventListener).toHaveBeenCalledOnce();
        expect(mockAddEventListener).toHaveBeenCalledWith('message', expect.any(Function));
        // Ensure handler was captured
        expect(messageHandler).toBeInstanceOf(Function);
    });

    describe('request', () => {
        it('should send a message and resolve on successful response', async () => {
            const requestMsg: ProcedureCallMessage = { type: 'query', path: 'test.get', id: 1 };
            const responseMsg: ProcedureResultMessage = {
                id: 1,
                result: { type: 'data', data: { success: true } },
            };

            const promise = transport.request(requestMsg);

            // Check if message was posted
            expect(mockPostMessage).toHaveBeenCalledOnce();
            expect(mockPostMessage).toHaveBeenCalledWith(requestMsg);

            // Simulate response from extension host
            simulateIncomingMessage(responseMsg);

            // Check if promise resolved correctly
            await expect(promise).resolves.toEqual(responseMsg);
        });

        it('should send a message and reject on error response', async () => {
            const requestMsg: ProcedureCallMessage = { type: 'mutation', path: 'test.update', id: 2 };
            const errorResponse: ProcedureResultMessage = {
                id: 2,
                result: { type: 'error', error: { message: 'Failed to update' } },
            };

            const promise = transport.request(requestMsg);

            expect(mockPostMessage).toHaveBeenCalledOnce();
            expect(mockPostMessage).toHaveBeenCalledWith(requestMsg);

            // Simulate error response
            simulateIncomingMessage(errorResponse);

            // Check if promise rejected correctly
            // Add type guard before accessing .error
            if (errorResponse.result.type === 'error') {
                await expect(promise).rejects.toEqual(errorResponse.result.error);
            } else {
                // Should not happen in this test case
                throw new Error('Test setup error: Expected error response');
            }
        });

        it('should generate an ID if none is provided', async () => {
            const requestMsg: Omit<ProcedureCallMessage, 'id'> = { type: 'query', path: 'test.get' };
             const responseMsg = {
                id: 1, // Transport should generate ID 1
                result: { type: 'data', data: { success: true } },
            };

            const promise = transport.request(requestMsg as ProcedureCallMessage); // Cast needed as ID is missing

            expect(mockPostMessage).toHaveBeenCalledOnce();
            const sentMessage = mockPostMessage.mock.calls[0][0] as ProcedureCallMessage;
            expect(sentMessage.id).toBe(1); // Check generated ID
            expect(sentMessage.type).toBe('query');
            expect(sentMessage.path).toBe('test.get');


            simulateIncomingMessage(responseMsg);
            await expect(promise).resolves.toEqual(responseMsg);
        });

        // TODO: Test request timeout?
    });

    describe('subscribe', () => {
        it('should send subscribe message and yield data', async () => {
            const subscribeMsg: SubscribeMessage = { type: 'subscription', path: 'test.stream', id: 10 };
            const dataMsg1: SubscriptionDataMessage = { id: 10, type: 'subscriptionData', data: { value: 1 }, serverSeq: 1 };
            const dataMsg2: SubscriptionDataMessage = { id: 10, type: 'subscriptionData', data: { value: 2 }, serverSeq: 2 };
            const endMsg: SubscriptionEndMessage = { id: 10, type: 'subscriptionEnd' };

            const { iterator } = transport.subscribe(subscribeMsg);

            expect(mockPostMessage).toHaveBeenCalledOnce();
            expect(mockPostMessage).toHaveBeenCalledWith(subscribeMsg);

            // Simulate data messages
            simulateIncomingMessage(dataMsg1);
            simulateIncomingMessage(dataMsg2);
            simulateIncomingMessage(endMsg); // End the subscription

            const results: any[] = [];
            for await (const msg of iterator) {
                results.push(msg);
            }

            expect(results).toEqual([dataMsg1, dataMsg2]);
        });

         it('should yield error message and terminate', async () => {
            const subscribeMsg: SubscribeMessage = { type: 'subscription', path: 'test.errorStream', id: 11 };
            const dataMsg: SubscriptionDataMessage = { id: 11, type: 'subscriptionData', data: { value: 1 }, serverSeq: 1 };
            const errorMsg: SubscriptionErrorMessage = { id: 11, type: 'subscriptionError', error: { message: 'Stream failed' } };

            const { iterator } = transport.subscribe(subscribeMsg);

            expect(mockPostMessage).toHaveBeenCalledOnce();
            expect(mockPostMessage).toHaveBeenCalledWith(subscribeMsg);

            // Simulate data then error
            simulateIncomingMessage(dataMsg);
            simulateIncomingMessage(errorMsg);

            const results: any[] = [];
            try {
                 for await (const msg of iterator) {
                    results.push(msg);
                }
            } catch (e) {
                 // Errors from the iterator itself (like disconnect) might be caught here
                 // but subscriptionError messages are yielded.
            }

            // The error message should be yielded, then the iterator completes
            expect(results).toEqual([dataMsg, errorMsg]);

             // Verify iterator is done after error
             const nextResult = await iterator.next();
             expect(nextResult.done).toBe(true);
        });

        it('should send unsubscribe message when unsubscribe is called', () => {
            const subscribeMsg: SubscribeMessage = { type: 'subscription', path: 'test.stream', id: 12 };
            const unsubscribeMsg = { id: 12, type: 'subscriptionStop' };

            const { unsubscribe } = transport.subscribe(subscribeMsg);

            expect(mockPostMessage).toHaveBeenCalledTimes(1); // Initial subscribe

            unsubscribe();

            expect(mockPostMessage).toHaveBeenCalledTimes(2); // Subscribe + Unsubscribe
            expect(mockPostMessage).toHaveBeenLastCalledWith(unsubscribeMsg);
        });

         it('should send unsubscribe message when iterator.return() is called', async () => {
            const subscribeMsg: SubscribeMessage = { type: 'subscription', path: 'test.stream', id: 13 };
            const unsubscribeMsg = { id: 13, type: 'subscriptionStop' };
            const dataMsg: SubscriptionDataMessage = { id: 13, type: 'subscriptionData', data: { value: 1 }, serverSeq: 1 };

            const { iterator } = transport.subscribe(subscribeMsg);
            expect(mockPostMessage).toHaveBeenCalledTimes(1);

            // Start iterating and ensure the first item is processed
            const nextPromise = iterator.next();
            simulateIncomingMessage(dataMsg); // Send data *after* next() is called
            const firstResult = await nextPromise; // Wait for the next() promise to resolve
            expect(firstResult).toEqual({ done: false, value: dataMsg });

            // NOW simulate consumer breaking the loop (calls iterator.return())
            await iterator.return?.(); // Await the return promise

            // Check that unsubscribe was sent
            expect(mockPostMessage).toHaveBeenCalledTimes(2); // Subscribe + Unsubscribe
            expect(mockPostMessage).toHaveBeenLastCalledWith(unsubscribeMsg);
         });

        // TODO: Test buffering
        // TODO: Test gap detection/requestMissingDeltas interaction? (Requires more complex setup)
    });

    describe('onAckReceived', () => {
        it('should call the handler when an ack message is received', () => {
            const ackHandler = vi.fn();
            transport.onAckReceived = ackHandler; // Set the handler

            const ackMsg: AckMessage = { id: 1, type: 'ack', clientSeq: 123, serverSeq: 456 };
            simulateIncomingMessage(ackMsg);

            expect(ackHandler).toHaveBeenCalledOnce();
            expect(ackHandler).toHaveBeenCalledWith(ackMsg);
        });

        it('should not throw if handler is not set', () => {
             const ackMsg: AckMessage = { id: 1, type: 'ack', clientSeq: 123, serverSeq: 456 };
             expect(() => simulateIncomingMessage(ackMsg)).not.toThrow();
        });
    });

    describe('requestMissingDeltas', () => {
        it('should call postMessage with the correct message', () => {
            const subId = 'sub-1';
            const fromSeq = 10;
            const toSeq = 15;
            const expectedMsg: RequestMissingMessage = {
                id: subId,
                type: 'request_missing',
                fromSeq,
                toSeq,
            };

            transport.requestMissingDeltas(subId, fromSeq, toSeq);

            expect(mockPostMessage).toHaveBeenCalledOnce();
            expect(mockPostMessage).toHaveBeenCalledWith(expectedMsg);
        });

         it('should handle postMessage errors gracefully', () => {
            mockPostMessage.mockImplementationOnce(() => { throw new Error('Post failed'); });
            // Expect console.error to be called, but test shouldn't fail
            const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            expect(() => transport.requestMissingDeltas('sub-1', 10, 15)).not.toThrow();
            expect(consoleErrorSpy).toHaveBeenCalled();
            consoleErrorSpy.mockRestore();
        });
    });

    describe('connection handling (delegated)', () => {
        it('should delegate connected getter to ConnectionManager', () => {
            mockIsConnected.mockReturnValueOnce(false);
            expect(transport.connected).toBe(false);
            expect(mockIsConnected).toHaveBeenCalled();
        });

        it('should delegate onConnectionChange to ConnectionManager', () => {
            const handler = vi.fn();
            transport.onConnectionChange(handler);
            expect(mockOnConnectionChange).toHaveBeenCalledWith(handler);
        });

        it('should delegate onDisconnect to ConnectionManager', () => {
            const handler = vi.fn();
            transport.onDisconnect(handler);
            expect(mockOnDisconnect).toHaveBeenCalledWith(handler);
        });

        it('should delegate connect to ConnectionManager', () => {
            transport.connect();
            expect(mockConnect).toHaveBeenCalledOnce();
        });

        it('should delegate disconnect to ConnectionManager', () => {
            transport.disconnect(1001, 'Test Reason');
            expect(mockDisconnect).toHaveBeenCalledOnce();
            expect(mockDisconnect).toHaveBeenCalledWith('Test Reason'); // Check reason is passed
        });

        it('should trigger internal cleanup via callback when ConnectionManager disconnects', async () => {
            const requestMsg: ProcedureCallMessage = { type: 'query', path: 'test.get', id: 99 };
            const promise = transport.request(requestMsg);

            const subscribeMsg: SubscribeMessage = { type: 'subscription', path: 'test.stream', id: 100 };
            const { iterator } = transport.subscribe(subscribeMsg);
            const nextPromise = iterator.next(); // Start waiting

            // Simulate disconnect by finding the callback passed to ConnectionManager constructor
            const constructorArgs = MockConnectionManager.mock.calls[0];
            const cleanupCallback = constructorArgs[1] as (reason?: string) => void;

            // Call the cleanup callback as ConnectionManager would
            cleanupCallback('Simulated disconnect');

            // Check that pending items were rejected
            await expect(promise).rejects.toThrow('Simulated disconnect');
            await expect(nextPromise).rejects.toThrow('Simulated disconnect');
        });
    });

     describe('postMessage error handling', () => {
        it('should reject request promise if postMessage fails', async () => {
            mockPostMessage.mockImplementationOnce(() => { throw new Error('Send Error'); });
            const requestMsg: ProcedureCallMessage = { type: 'query', path: 'test.get', id: 101 };
            await expect(transport.request(requestMsg)).rejects.toThrow('Send Error');
        });

        it('should throw if postMessage fails during subscribe', () => {
            mockPostMessage.mockImplementationOnce(() => { throw new Error('Send Error'); });
            const subscribeMsg: SubscribeMessage = { type: 'subscription', path: 'test.stream', id: 102 };
            expect(() => transport.subscribe(subscribeMsg)).toThrow('Send Error');
        });

         it('should handle postMessage error during unsubscribe gracefully', () => {
            const subscribeMsg: SubscribeMessage = { type: 'subscription', path: 'test.stream', id: 103 };
            const { unsubscribe } = transport.subscribe(subscribeMsg);
            mockPostMessage.mockClear(); // Clear subscribe call

            mockPostMessage.mockImplementationOnce(() => { throw new Error('Unsub Error'); });
            const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            expect(() => unsubscribe()).not.toThrow(); // Should not throw out
            expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to send unsubscribe for 103:', expect.any(Error));

            consoleErrorSpy.mockRestore();
        });
    });

     describe('iterator throw', () => {
         it('should call unsubscribe and reject when iterator.throw() is called', async () => {
            const subscribeMsg: SubscribeMessage = { type: 'subscription', path: 'test.stream', id: 104 };
            const unsubscribeMsg = { id: 104, type: 'subscriptionStop' };
            const testError = new Error('Test Throw');

            const { iterator } = transport.subscribe(subscribeMsg);
            mockPostMessage.mockClear(); // Clear subscribe call

            await expect(iterator.throw?.(testError)).rejects.toThrow(testError);

            // Check that unsubscribe was sent
            expect(mockPostMessage).toHaveBeenCalledTimes(1);
            expect(mockPostMessage).toHaveBeenCalledWith(unsubscribeMsg);
         });
     });

    // TODO: Test buffering
});
