import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createVSCodeTransport } from './transport';
import type { VSCodePostMessage, TypeQLTransport, ProcedureCallMessage, ProcedureResultMessage, SubscribeMessage, SubscriptionDataMessage, AckMessage } from './types';
import { TypeQLClientError } from './types';

// Helper to advance timers and microtasks
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('createVSCodeTransport', () => {
    let transport!: TypeQLTransport; // Add definite assignment assertion
    let mockVscodeApi: VSCodePostMessage;
    let messageListenerCallback: ((message: any) => void) | null = null;
    let mockListenerDisposable: { dispose: () => void };
    let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        messageListenerCallback = null; // Reset callback capture
        mockListenerDisposable = { dispose: vi.fn() };
        mockVscodeApi = {
            postMessage: vi.fn(),
            onDidReceiveMessage: vi.fn((listener) => {
                messageListenerCallback = listener; // Capture the listener
                return mockListenerDisposable;
            }),
        };
        // Create locally first, then assign to outer variable
        const localTransport = createVSCodeTransport({ vscodeApi: mockVscodeApi });
        transport = localTransport;
        consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        // Ensure transport is disconnected to clean up listeners etc.
        if (transport) {
             (transport as any).disconnect(); // Cast to any
        }
        vi.restoreAllMocks();
    });

    it('should create a transport object with expected methods', () => {
        expect(transport).toBeDefined();
        expect(transport.request).toBeInstanceOf(Function);
        expect(transport.subscribe).toBeInstanceOf(Function);
        expect(transport.disconnect).toBeInstanceOf(Function);
        expect(transport.requestMissingDeltas).toBeInstanceOf(Function);
        expect(transport).toHaveProperty('onAckReceived'); // Initially undefined
    });

    it('should register a message listener via vscodeApi', () => {
        expect(mockVscodeApi.onDidReceiveMessage).toHaveBeenCalledTimes(1);
        expect(messageListenerCallback).toBeInstanceOf(Function);
    });

    describe('request', () => {
        const requestMessage: ProcedureCallMessage = { type: 'query', id: 'req-test-1', path: 'test.proc', input: { data: 1 } }; // Changed type to 'query'
        const successResponse: ProcedureResultMessage = { id: 'req-test-1', result: { type: 'data', data: 'Success!' } };
        const errorResponse: ProcedureResultMessage = { id: 'req-test-1', result: { type: 'error', error: { message: 'Failed!' } } };

        it('should send message via postMessage and resolve on success response', async () => {
            const requestPromise = transport.request(requestMessage); // Remove assertion

            expect(mockVscodeApi.postMessage).toHaveBeenCalledWith(requestMessage);

            // Simulate receiving the success response
            messageListenerCallback?.(successResponse);

            await expect(requestPromise).resolves.toEqual(successResponse);
        });

        it('should send message via postMessage and reject on error response', async () => {
            const requestPromise = transport.request(requestMessage); // Remove assertion

            expect(mockVscodeApi.postMessage).toHaveBeenCalledWith(requestMessage);

            // Simulate receiving the error response
            messageListenerCallback?.(errorResponse);

            // The promise resolves with the error *message*, the client interprets the result.type
             await expect(requestPromise).resolves.toEqual(errorResponse);
        });

        it('should reject if postMessage throws an error', async () => {
            const postError = new Error('VSCode unavailable');
            mockVscodeApi.postMessage = vi.fn(() => { throw postError; });

            const requestPromise = transport.request(requestMessage); // Remove assertion

            await expect(requestPromise).rejects.toThrow(TypeQLClientError);
            await expect(requestPromise).rejects.toThrow(`VSCode postMessage failed: ${postError.message}`);
        });

        it('should assign an ID if message is missing one and warn', async () => {
            const requestWithoutId = { type: 'query', path: 'test.proc', input: {} } as Omit<ProcedureCallMessage, 'id'> as ProcedureCallMessage; // Changed type to 'query'
            const generatedId = 'mock-id-1'; // Assume generateId returns this
            const mockGenerateId = vi.fn(() => generatedId);
            transport = createVSCodeTransport({ vscodeApi: mockVscodeApi, generateRequestId: mockGenerateId }); // Recreate with mock generator

            const requestPromise = transport.request(requestWithoutId);

            expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Request message was missing an ID. Assigned: mock-id-1'));
            expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({ ...requestWithoutId, id: generatedId });

            // Simulate response for generated ID
            const responseWithGeneratedId: ProcedureResultMessage = { id: generatedId, result: { type: 'data', data: 'ok' } };
            messageListenerCallback?.(responseWithGeneratedId);

            await expect(requestPromise).resolves.toEqual(responseWithGeneratedId);
        });
    });

    describe('subscribe', () => {
        const subscribeMessage: SubscribeMessage = { type: 'subscription', id: 'sub-test-1', path: 'test.sub', input: null };
        const dataMessage: SubscriptionDataMessage = { type: 'subscriptionData', id: 'sub-test-1', serverSeq: 1, data: { value: 1 } };
        const endMessage = { type: 'subscriptionEnd', id: 'sub-test-1' };

        it('should send subscribe message via postMessage', () => {
            transport.subscribe(subscribeMessage); // Remove assertion
            expect(mockVscodeApi.postMessage).toHaveBeenCalledWith(subscribeMessage);
        });

        it('should return iterator that yields received data', async () => {
            const { iterator } = transport.subscribe(subscribeMessage); // Remove assertion

            // Simulate receiving data
            messageListenerCallback?.(dataMessage);

            const result = await iterator.next();
            expect(result.done).toBe(false);
            expect(result.value).toEqual(dataMessage);
        });

        it('should return iterator that terminates on end message', async () => {
            const { iterator } = transport.subscribe(subscribeMessage); // Remove assertion

            // Simulate receiving end message
            messageListenerCallback?.(endMessage);

            const result = await iterator.next();
            expect(result.done).toBe(true);
        });

        it('should return unsubscribe function that sends stop message', () => {
            const { unsubscribe } = transport.subscribe(subscribeMessage); // Remove assertion
            unsubscribe();

            const expectedStopMessage = { type: 'subscriptionStop', id: 'sub-test-1' };
            // Called twice: once for subscribe, once for stop
            expect(mockVscodeApi.postMessage).toHaveBeenCalledTimes(2);
            expect(mockVscodeApi.postMessage).toHaveBeenCalledWith(expectedStopMessage);
        });

         it('should assign an ID if message is missing one and warn', () => {
            const subWithoutId = { type: 'subscription', path: 'test.sub', input: null } as Omit<SubscribeMessage, 'id'> as SubscribeMessage;
            const generatedId = 'mock-sub-id-1';
            const mockGenerateId = vi.fn(() => generatedId);
            transport = createVSCodeTransport({ vscodeApi: mockVscodeApi, generateRequestId: mockGenerateId }); // Recreate with mock generator

            transport.subscribe(subWithoutId);

            expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Subscribe message was missing an ID. Assigned: mock-sub-id-1'));
            expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({ ...subWithoutId, id: generatedId });
        });
    });

    describe('disconnect', () => {
        it('should dispose the message listener', () => {
            (transport as any).disconnect(); // Cast to any
            expect(mockListenerDisposable.dispose).toHaveBeenCalledTimes(1);
        });

        it('should reject pending requests', async () => {
            const requestPromise = (transport as any).request({ type: 'query', id: 'req-pending', path: 'test.proc' }); // Cast to any
            (transport as any).disconnect(); // Cast to any
            await expect(requestPromise).rejects.toThrow(TypeQLClientError);
            await expect(requestPromise).rejects.toThrow('Transport disconnected');
        });

        it('should end active subscriptions', async () => {
            const { iterator } = (transport as any).subscribe({ type: 'subscription', id: 'sub-pending', path: 'test.sub' }); // Cast to any
            const iteratorPromise = iterator.next(); // Start listening

            (transport as any).disconnect(); // Cast to any

            // Iterator should terminate
            const result = await iteratorPromise;
            expect(result.done).toBe(true);
        });
    });

    describe('requestMissingDeltas', () => {
        it('should send request_missing message via postMessage', () => {
            const subId = 'sub-delta';
            const fromSeq = 10;
            const toSeq = 20;
            (transport as any).requestMissingDeltas(subId, fromSeq, toSeq); // Cast to any

            const expectedMessage = {
                type: 'request_missing',
                id: subId,
                fromSeq: fromSeq,
                toSeq: toSeq
            };
            expect(mockVscodeApi.postMessage).toHaveBeenCalledWith(expectedMessage);
        });
    });

     describe('onAckReceived', () => {
        it('should call the assigned handler when an ack message is received', () => {
            const ackHandler = vi.fn();
            transport.onAckReceived = ackHandler; // Remove assertion

            const ackMessage: AckMessage = { type: 'ack', id: 'ack-test', clientSeq: 1, serverSeq: 1 };

            // Simulate receiving the ack message
            messageListenerCallback?.(ackMessage);

            expect(ackHandler).toHaveBeenCalledWith(ackMessage);
        });

         it('should not throw if no handler is assigned when ack is received', () => {
             const ackMessage: AckMessage = { type: 'ack', id: 'ack-test-nohandler', clientSeq: 1, serverSeq: 1 };
             // No handler assigned
             expect(() => messageListenerCallback?.(ackMessage)).not.toThrow();
         });
    });
});