import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequestManager, type RequestManager } from './requestManager';
import { TypeQLClientError } from './types';
import type { ProcedureResultMessage } from './types';

describe('createRequestManager', () => {
    let requestManager: RequestManager;
    let mockResolve: (result: ProcedureResultMessage) => void;
    let mockReject: (reason?: any) => void;

    beforeEach(() => {
        requestManager = createRequestManager();
        mockResolve = vi.fn();
        mockReject = vi.fn();
    });

    it('should add a new request', () => {
        requestManager.add('req-1', mockResolve, mockReject);
        expect(requestManager.hasRequest('req-1')).toBe(true);
    });

    it('should resolve a pending request and remove it', () => {
        const result: ProcedureResultMessage = { id: 'req-1', result: { type: 'data', data: 'success' } };
        requestManager.add('req-1', mockResolve, mockReject);
        requestManager.resolveRequest('req-1', result);
        expect(mockResolve).toHaveBeenCalledWith(result);
        expect(requestManager.hasRequest('req-1')).toBe(false);
    });

    it('should reject a pending request and remove it', () => {
        const error = new Error('Test rejection');
        requestManager.add('req-1', mockResolve, mockReject);
        requestManager.rejectRequest('req-1', error);
        expect(mockReject).toHaveBeenCalledWith(error);
        expect(requestManager.hasRequest('req-1')).toBe(false);
    });

    it('should reject all pending requests', () => {
        const error = new TypeQLClientError('Transport disconnected');
        const mockResolve2 = vi.fn();
        const mockReject2 = vi.fn();
        requestManager.add('req-1', mockResolve, mockReject);
        requestManager.add('req-2', mockResolve2, mockReject2);

        requestManager.rejectAll(error);

        expect(mockReject).toHaveBeenCalledWith(error);
        expect(mockReject2).toHaveBeenCalledWith(error);
        expect(requestManager.hasRequest('req-1')).toBe(false);
        expect(requestManager.hasRequest('req-2')).toBe(false);
    });

    it('should return true from hasRequest for pending request', () => {
        requestManager.add('req-1', mockResolve, mockReject);
        expect(requestManager.hasRequest('req-1')).toBe(true);
    });

    it('should return false from hasRequest for non-pending request', () => {
        expect(requestManager.hasRequest('req-nonexistent')).toBe(false);
    });

     it('should delete a request and return true if it existed', () => {
        requestManager.add('req-1', mockResolve, mockReject);
        const deleted = requestManager.deleteRequest('req-1');
        expect(deleted).toBe(true);
        expect(requestManager.hasRequest('req-1')).toBe(false);
    });

    it('should return false from deleteRequest if request did not exist', () => {
        const deleted = requestManager.deleteRequest('req-nonexistent');
        expect(deleted).toBe(false);
    });

    it('should warn when resolving a non-existent request', () => {
        const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const result: ProcedureResultMessage = { id: 'req-nonexistent', result: { type: 'data', data: 'success' } };
        requestManager.resolveRequest('req-nonexistent', result);
        expect(mockResolve).not.toHaveBeenCalled();
        expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Attempted to resolve non-existent request ID'));
        consoleWarnSpy.mockRestore();
    });

     it('should warn when rejecting a non-existent request', () => {
        const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const error = new Error('Test rejection');
        requestManager.rejectRequest('req-nonexistent', error);
        expect(mockReject).not.toHaveBeenCalled();
        expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Attempted to reject non-existent request ID'));
        consoleWarnSpy.mockRestore();
    });

     it('should warn when adding a request with an existing ID', () => {
        const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        requestManager.add('req-1', mockResolve, mockReject);
        const mockResolve2 = vi.fn();
        const mockReject2 = vi.fn();
        requestManager.add('req-1', mockResolve2, mockReject2); // Add again with same ID
        expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Request with ID req-1 already exists. Overwriting.'));
        // Verify the *new* callbacks are stored (or test rejection of old one if implemented)
        const result: ProcedureResultMessage = { id: 'req-1', result: { type: 'data', data: 'success' } };
        requestManager.resolveRequest('req-1', result);
        expect(mockResolve).not.toHaveBeenCalled(); // Old resolve should not be called
        expect(mockResolve2).toHaveBeenCalledWith(result); // New resolve should be called
        consoleWarnSpy.mockRestore();
    });
});