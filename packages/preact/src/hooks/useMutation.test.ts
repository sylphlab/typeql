// packages/preact/src/hooks/useMutation.test.ts
import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import { h, FunctionalComponent, ComponentChildren } from 'preact';
import { render, act } from '@testing-library/preact';

// Import hook under test and provider/context
import { useMutation } from './useMutation'; // Import hook
import { TypeQLProvider } from '../context'; // Import provider
import { createClient, OptimisticStore, PredictedChange } from '@sylphlab/typeql-client';
import { TypeQLClientError } from '@sylphlab/typeql-shared';

// Mocks (Copied and potentially simplified)
const mockTransport = { connect: vi.fn(), disconnect: vi.fn(), send: vi.fn(), on: vi.fn(), off: vi.fn() };
const mockClient = createClient({ transport: mockTransport as any });

const getOptimisticStateMock = vi.fn(() => ({}));
const subscribeMock = vi.fn(() => () => {}); // Keep subscribe mock for provider
const applyServerDeltaMock = vi.fn();
const getConfirmedStateMock = vi.fn(() => ({}));
const getConfirmedServerSeqMock = vi.fn(() => 0);
const getPendingMutationsMock = vi.fn(() => []);
const addPendingMutationMock = vi.fn();
const rejectPendingMutationMock = vi.fn();
const confirmPendingMutationMock = vi.fn();

const mockStore: OptimisticStore<any> = {
    getOptimisticState: getOptimisticStateMock,
    subscribe: subscribeMock,
    applyServerDelta: applyServerDeltaMock,
    getConfirmedState: getConfirmedStateMock,
    getConfirmedServerSeq: getConfirmedServerSeqMock,
    getPendingMutations: getPendingMutationsMock,
    addPendingMutation: addPendingMutationMock,
    rejectPendingMutation: rejectPendingMutationMock,
    confirmPendingMutation: confirmPendingMutationMock,
};

describe('useMutation', () => {
    const mockMutationProcedure = { mutate: vi.fn() };
    const mockInput = { name: 'New Item' };
    const mockOutput = { id: 2, name: 'New Item' };
    const mockError = new Error('Mutation Failed');
    const mockOptimisticChange = vi.fn((currentState: any) => ({
        ...currentState,
        items: [...(currentState.items || []), { id: 'temp-2', name: 'New Item (Optimistic)' }]
    }));

    beforeEach(() => {
      vi.resetAllMocks();
      getOptimisticStateMock.mockReturnValue({});
      // No need to reset capturedStoreListener here
      applyServerDeltaMock.mockClear();
    });

    interface MutationRunnerProps {
        procedure: typeof mockMutationProcedure;
        options?: any;
        onStateChange: (state: any) => void;
        mutateRef?: { current: null | ((input: any) => Promise<any>) };
    }
    const MutationRunner: FunctionalComponent<MutationRunnerProps> = ({ procedure, options, onStateChange, mutateRef }) => {
        const mutationResult = useMutation(procedure, options);
        onStateChange(mutationResult);
        if (mutateRef) { mutateRef.current = mutationResult.mutate; }
        return h('div', { 'data-testid': 'mutation-status' }, mutationResult.status);
    };

    const renderMutationHook = (props: Omit<MutationRunnerProps, 'onStateChange' | 'mutateRef'> & { onStateChange?: (state: any) => void }) => {
        const stateChanges: any[] = [];
        const onStateChange = props.onStateChange ?? ((state: any) => stateChanges.push(state));
        const mutateRef = { current: null as (((input: any) => Promise<any>) | null) };
        const renderResult = render(
             h(TypeQLProvider, { client: { ...mockClient, testMutation: mockMutationProcedure } as any, store: mockStore, children: h(MutationRunner, { ...props, onStateChange, mutateRef }) })
        );
        return { ...renderResult, stateChanges, getMutateFn: () => mutateRef.current };
    };

    it('should be in idle state initially', () => {
      const { stateChanges } = renderMutationHook({ procedure: mockMutationProcedure });
      expect(stateChanges.length).toBeGreaterThanOrEqual(1);
      const initialState = stateChanges[0];
      expect(initialState.isLoading).toBe(false);
      expect(initialState.isSuccess).toBe(false);
      expect(initialState.isError).toBe(false);
      expect(initialState.status).toBe('idle');
      expect(initialState.data).toBeUndefined();
      expect(initialState.error).toBeNull();
    });

    it('should enter loading state and call procedure on mutate', async () => {
      mockMutationProcedure.mutate.mockResolvedValueOnce(mockOutput);
      const { stateChanges, getMutateFn } = renderMutationHook({ procedure: mockMutationProcedure });
      const mutateFn = getMutateFn();
      expect(mutateFn).toBeInstanceOf(Function);
      let mutationPromise: Promise<any> | undefined;
      await act(async () => { mutationPromise = mutateFn!(mockInput); });
      expect(stateChanges.length).toBeGreaterThanOrEqual(2);
      const loadingState = stateChanges[stateChanges.length - 1];
      expect(loadingState.isLoading).toBe(true);
      expect(loadingState.status).toBe('loading');
      await act(async () => { await mutationPromise; });
      await vi.waitFor(() => { expect(stateChanges[stateChanges.length - 1].status).toBe('success'); });
      const finalState = stateChanges[stateChanges.length - 1];
      expect(mockMutationProcedure.mutate).toHaveBeenCalledWith({ input: mockInput });
      expect(finalState.isLoading).toBe(false);
      expect(finalState.status).toBe('success');
      expect(finalState.data).toEqual(mockOutput);
    });

     it('should handle mutation errors', async () => {
      mockMutationProcedure.mutate.mockRejectedValueOnce(mockError);
      const { stateChanges, getMutateFn } = renderMutationHook({ procedure: mockMutationProcedure });
      const mutateFn = getMutateFn();
      expect(mutateFn).toBeInstanceOf(Function);
      let mutationPromise: Promise<any> | undefined;
      await act(async () => { mutationPromise = mutateFn!(mockInput).catch(() => {}); });
      expect(stateChanges.length).toBeGreaterThanOrEqual(2);
      expect(stateChanges[stateChanges.length - 1].status).toBe('loading');
      await act(async () => { await mutationPromise; });
      await vi.waitFor(() => { expect(stateChanges[stateChanges.length - 1].status).toBe('error'); });
      const finalState = stateChanges[stateChanges.length - 1];
      expect(mockMutationProcedure.mutate).toHaveBeenCalledWith({ input: mockInput });
      expect(finalState.isLoading).toBe(false);
      expect(finalState.status).toBe('error');
      expect(finalState.data).toBeUndefined();
      expect(finalState.error).toEqual(mockError);
    });

    it('should call onSuccess callback on successful mutation', async () => {
      const onSuccessMock = vi.fn();
      mockMutationProcedure.mutate.mockResolvedValueOnce(mockOutput);
      const { getMutateFn } = renderMutationHook({ procedure: mockMutationProcedure, options: { onSuccess: onSuccessMock } });
      const mutateFn = getMutateFn();
      await act(async () => { await mutateFn!(mockInput); });
      expect(onSuccessMock).toHaveBeenCalledWith(mockOutput, mockInput);
    });

    it('should call onError callback on failed mutation', async () => {
      const onErrorMock = vi.fn();
      mockMutationProcedure.mutate.mockRejectedValueOnce(mockError);
      const { getMutateFn } = renderMutationHook({ procedure: mockMutationProcedure, options: { onError: onErrorMock } });
      const mutateFn = getMutateFn();
      await act(async () => { await mutateFn!(mockInput).catch(() => {}); });
      expect(onErrorMock).toHaveBeenCalledWith(mockError, mockInput);
    });

     it('should call onMutate callback before mutation', async () => {
      const onMutateMock = vi.fn();
      mockMutationProcedure.mutate.mockResolvedValueOnce(mockOutput);
      const { getMutateFn } = renderMutationHook({ procedure: mockMutationProcedure, options: { onMutate: onMutateMock } });
      const mutateFn = getMutateFn();
      await act(async () => { await mutateFn!(mockInput); });
      expect(onMutateMock).toHaveBeenCalledWith(mockInput);
      expect(mockMutationProcedure.mutate).toHaveBeenCalledWith({ input: mockInput });
    });

    it('should reset state when reset is called', async () => {
      mockMutationProcedure.mutate.mockResolvedValueOnce(mockOutput);
      const { stateChanges, getMutateFn } = renderMutationHook({ procedure: mockMutationProcedure });
      const mutateFn = getMutateFn();
      await act(async () => { await mutateFn!(mockInput); });
      await vi.waitFor(() => { expect(stateChanges[stateChanges.length - 1].status).toBe('success'); });
      expect(stateChanges[stateChanges.length - 1].data).toEqual(mockOutput);
      const resetFn = stateChanges[stateChanges.length - 1].reset;
      expect(resetFn).toBeInstanceOf(Function);
      act(() => { resetFn(); });
      const finalState = stateChanges[stateChanges.length - 1];
      expect(finalState.isLoading).toBe(false);
      expect(finalState.isSuccess).toBe(false);
      expect(finalState.isError).toBe(false);
      expect(finalState.status).toBe('idle');
      expect(finalState.data).toBeUndefined();
      expect(finalState.error).toBeNull();
    });

    it('should pass optimistic options to procedure.mutate if provided', async () => {
        mockMutationProcedure.mutate.mockResolvedValueOnce(mockOutput);
        const { getMutateFn } = renderMutationHook({
            procedure: mockMutationProcedure,
            options: { optimistic: { predictedChange: mockOptimisticChange } }
        });
        const mutateFn = getMutateFn();
        await act(async () => { await mutateFn!(mockInput); });
        expect(mockMutationProcedure.mutate).toHaveBeenCalledWith({
            input: mockInput,
            optimistic: { predictedChange: mockOptimisticChange }
        });
    });
}); // End of useMutation describe