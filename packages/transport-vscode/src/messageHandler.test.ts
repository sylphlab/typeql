import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupMessageHandler } from './messageHandler';
import type { VSCodePostMessage, ProcedureResultMessage, AckMessage, SubscriptionDataMessage, SubscriptionErrorMessage, SubscriptionEndMessage, TypeQLTransport } from './types';

// Mock dependencies
const mockVscodeApi: VSCodePostMessage = {
    postMessage: vi.fn(),
    onDidReceiveMessage: vi.fn(),
};

const mockRequestManager = {
    resolveRequest: vi.fn(),
    hasRequest: vi.fn(),
    // Add other methods if needed by handler logic being tested
    add: vi.fn(),
    rejectRequest: vi.fn(),
    rejectAll: vi.fn(),
    deleteRequest: vi.fn(),
};

const mockSubscriptionManager = {
    pushData: vi.fn(),
    endSubscription: vi.fn(),
    hasSubscription: vi.fn(),
    // Add other methods if needed
    create: vi.fn(),
    endAll: vi.fn(),
    requestMissing: vi.fn(),
};

const mockTransport: Partial<TypeQLTransport> = {
    onAckReceived: vi.fn(),
};
const getMockTransportInstance = () => mockTransport as TypeQLTransport | undefined;


describe('setupMessageHandler', () => {
    let messageListenerCallback: ((message: any) => void) | null = null;
    const mockDisposable = { dispose: vi.fn() };

    beforeEach(() => {
        vi.resetAllMocks();
        // Capture the listener callback when onDidReceiveMessage is called
        mockVscodeApi.onDidReceiveMessage = vi.fn((listener) => {
            messageListenerCallback = listener;
            return mockDisposable;
        });
        // Setup the handler, which registers the listener
        setupMessageHandler({
            vscodeApi: mockVscodeApi,
            requestManager: mockRequestManager,
            subscriptionManager: mockSubscriptionManager,
            getTransportInstance: getMockTransportInstance,
        });
    });

    it('should register a message listener on setup', () => {
        expect(mockVscodeApi.onDidReceiveMessage).toHaveBeenCalledTimes(1);
        expect(messageListenerCallback).toBeInstanceOf(Function);
    });

    it('should return a dispose function that calls the disposable', () => {
        const { dispose } = setupMessageHandler({
            vscodeApi: mockVscodeApi,
            requestManager: mockRequestManager,
            subscriptionManager: mockSubscriptionManager,
            getTransportInstance: getMockTransportInstance,
        });
        dispose();
        expect(mockDisposable.dispose).toHaveBeenCalledTimes(1); // Check if the original disposable was called
    });

    it('should handle ProcedureResultMessage for known request', () => {
        const message: ProcedureResultMessage = { id: 'req-1', result: { type: 'data', data: 'test' } };
        mockRequestManager.hasRequest.mockReturnValue(true);
        messageListenerCallback?.(message);
        expect(mockRequestManager.resolveRequest).toHaveBeenCalledWith('req-1', message);
    });

     it('should warn on ProcedureResultMessage for unknown request', () => {
        const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const message: ProcedureResultMessage = { id: 'req-unknown', result: { type: 'data', data: 'test' } };
        mockRequestManager.hasRequest.mockReturnValue(false);
        messageListenerCallback?.(message);
        expect(mockRequestManager.resolveRequest).not.toHaveBeenCalled();
        expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('unknown request ID: req-unknown'));
        consoleWarnSpy.mockRestore();
    });

    it('should handle AckMessage and call onAckReceived', () => {
        // Assuming serverSeq is required, adding a default value
        const message: AckMessage = { type: 'ack', id: 'sub-1', clientSeq: 1, serverSeq: 0 };
        messageListenerCallback?.(message);
        expect(mockTransport.onAckReceived).toHaveBeenCalledWith(message);
    });

     it('should handle SubscriptionDataMessage for known subscription', () => {
        // Assuming the data payload is directly under 'data' property
        const message: SubscriptionDataMessage = { type: 'subscriptionData', id: 'sub-1', serverSeq: 1, data: { payload: 'update' } };
        mockSubscriptionManager.hasSubscription.mockReturnValue(true);
        messageListenerCallback?.(message);
        expect(mockSubscriptionManager.pushData).toHaveBeenCalledWith('sub-1', message);
    });

    it('should warn on SubscriptionDataMessage for unknown subscription', () => {
        const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        // Assuming the data payload is directly under 'data' property
        const message: SubscriptionDataMessage = { type: 'subscriptionData', id: 'sub-unknown', serverSeq: 1, data: { payload: 'update' } };
        mockSubscriptionManager.hasSubscription.mockReturnValue(false);
        messageListenerCallback?.(message);
        expect(mockSubscriptionManager.pushData).not.toHaveBeenCalled();
        expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('unknown subscription ID: sub-unknown'));
        consoleWarnSpy.mockRestore();
    });

     it('should handle SubscriptionErrorMessage for known subscription', () => {
        const message: SubscriptionErrorMessage = { type: 'subscriptionError', id: 'sub-1', error: { message: 'failed' } };
        mockSubscriptionManager.hasSubscription.mockReturnValue(true);
        messageListenerCallback?.(message);
        expect(mockSubscriptionManager.pushData).toHaveBeenCalledWith('sub-1', message); // pushData handles errors too
    });

    it('should handle SubscriptionEndMessage for known subscription', () => {
        const message: SubscriptionEndMessage = { type: 'subscriptionEnd', id: 'sub-1' };
        mockSubscriptionManager.hasSubscription.mockReturnValue(true);
        messageListenerCallback?.(message);
        expect(mockSubscriptionManager.endSubscription).toHaveBeenCalledWith('sub-1');
    });

    it('should warn on unknown message format', () => {
        const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const message = { some: 'unknown', format: true };
        messageListenerCallback?.(message);
        expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('unknown/unhandled message format'), message);
        consoleWarnSpy.mockRestore();
    });

     it('should warn on invalid message format (not object or no id)', () => {
        const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        messageListenerCallback?.('a string');
        messageListenerCallback?.(null);
        messageListenerCallback?.({ type: 'ack' }); // Missing id
        expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('invalid message format'), expect.anything());
        consoleWarnSpy.mockRestore();
    });

});