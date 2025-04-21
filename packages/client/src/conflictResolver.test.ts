import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    resolveConflict,
    ConflictResolverConfig,
    ConflictResolutionResult,
    ConflictResolutionStrategy, // Correct type name
    CustomConflictResolver,
    ConflictResolutionOutcome
} from './conflictResolver'; // Adjust path as needed
import type { ProcedureCallMessage, SubscriptionDataMessage } from '@sylphlab/zen-query-shared';
import { Operation as JsonPatchOperation } from 'fast-json-patch';
import { produceWithPatches, enablePatches, Patch as ImmerPatch } from 'immer';

// Enable Immer patches
enablePatches();

// Mock data types (Keep for context, though state itself isn't passed to resolver)
interface TestItem {
    id: string;
    value: string;
    version: number;
}
type TestState = TestItem[];

describe('Conflict Resolver', () => {

    const initialState: TestState = [{ id: '1', value: 'initial', version: 0 }];
    // Keep clientMutation for context if needed by custom resolver tests, but not passed directly to resolveConflict
    let clientMutation: ProcedureCallMessage;
    let serverDeltaMsg: SubscriptionDataMessage; // Keep for context if needed
    let serverDeltaData: JsonPatchOperation[];
    let clientImmerPatches: ImmerPatch[];
    let clientJsonPatches: JsonPatchOperation[]; // This is the 'clientDelta' passed to resolveConflict

    beforeEach(() => {
        vi.clearAllMocks();

        // Common Client Mutation (updates value)
        clientMutation = { id: 1, type: 'mutation', path: 'item.update', input: { id: '1', value: 'client val' }, clientSeq: 1 };

        // Generate Immer patches for the client mutation based on initialState
        const [, patches] = produceWithPatches(initialState, draft => {
            const item = draft.find(i => i.id === '1');
            if (item) {
                item.value = 'client val'; // Simulate the mutation's effect
            }
        });
        clientImmerPatches = patches; // Keep if needed for custom resolver context

        // Convert Immer patches to JSON patches - THIS IS THE CLIENT DELTA
        clientJsonPatches = clientImmerPatches.map(patch => ({
            op: patch.op,
            path: '/' + patch.path.join('/'),
            value: patch.value
        })).filter(op => (op.op as any) !== 'test'); // Filter out 'test' ops, casting op.op to any


        // Common Server Delta (conflicts by updating the same value)
        serverDeltaData = [{ op: 'replace', path: '/0/value', value: 'server val' }];
        serverDeltaMsg = { // Keep for context if needed
            id: 'sub1',
            type: 'subscriptionData',
            data: serverDeltaData,
            serverSeq: 1,
            prevServerSeq: 0
        };
    });

    describe('strategy: server-wins', () => {
        // Correct generic argument
        const config: ConflictResolverConfig<JsonPatchOperation[]> = { strategy: 'server-wins' };

        it('should return server delta and "server-applied" outcome', () => {
            // Correct arguments for resolveConflict
            const result = resolveConflict(clientJsonPatches, serverDeltaData, config);

            expect(result.outcome).toBe<ConflictResolutionOutcome>('server-applied');
            expect(result.resolvedDelta).toEqual(serverDeltaData);
        });

        it('should handle non-conflicting paths (server-wins)', () => {
             const nonConflictingServerData: JsonPatchOperation[] = [{ op: 'add', path: '/1', value: { id: '2', value: 'server new', version: 1 } }];
             // Correct arguments
             const result = resolveConflict(clientJsonPatches, nonConflictingServerData, config);

             expect(result.outcome).toBe<ConflictResolutionOutcome>('server-applied');
             expect(result.resolvedDelta).toEqual(nonConflictingServerData);
        });
    });

    describe('strategy: client-wins', () => {
        // Correct generic argument
        const config: ConflictResolverConfig<JsonPatchOperation[]> = { strategy: 'client-wins' };

        it('should return client delta (as JSON Patch) and "client-applied" outcome', () => {
            // Correct arguments
            const result = resolveConflict(clientJsonPatches, serverDeltaData, config);

            expect(result.outcome).toBe<ConflictResolutionOutcome>('client-applied');
            expect(result.resolvedDelta).toEqual(clientJsonPatches);
        });

         it('should handle non-conflicting paths (client-wins)', () => {
             const nonConflictingServerData: JsonPatchOperation[] = [{ op: 'add', path: '/1', value: { id: '2', value: 'server new', version: 1 } }];
             // Correct arguments
             const result = resolveConflict(clientJsonPatches, nonConflictingServerData, config);

             // Client-wins should still preserve the client change.
             // The internal logic should merge non-conflicting server changes.
             expect(result.outcome).toBe<ConflictResolutionOutcome>('client-applied');
             // Check that the resolved delta is exactly the client's delta for client-wins
             expect(result.resolvedDelta).toEqual(clientJsonPatches);
        });
    });

    describe('strategy: custom', () => {
        it('should call custom resolver and return its result', () => {
            const mergedDelta: JsonPatchOperation[] = [{ op: 'replace', path: '/0/value', value: 'merged' }];
            // Correct CustomConflictResolver signature
            const customResolver: CustomConflictResolver<JsonPatchOperation[]> = vi.fn().mockReturnValue(mergedDelta);
            // Correct generic argument
            const config: ConflictResolverConfig<JsonPatchOperation[]> = { strategy: 'custom', customResolver };

            // Correct arguments
            const result = resolveConflict(clientJsonPatches, serverDeltaData, config);

            expect(customResolver).toHaveBeenCalledTimes(1);
            // Correct arguments passed to custom resolver
            expect(customResolver).toHaveBeenCalledWith(
                clientJsonPatches, // Client changes as JSON Patch
                serverDeltaData    // Server changes as JSON Patch
                // No other arguments expected based on type
            );
            expect(result.outcome).toBe<ConflictResolutionOutcome>('merged');
            expect(result.resolvedDelta).toEqual(mergedDelta);
        });

        it('should return "error" outcome if custom resolver throws', () => {
            const resolverError = new Error('Custom resolver failed!');
            const customResolver = vi.fn().mockImplementation(() => { throw resolverError; });
            // Correct generic argument
            const config: ConflictResolverConfig<JsonPatchOperation[]> = { strategy: 'custom', customResolver };
            const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            // Correct arguments
            const result = resolveConflict(clientJsonPatches, serverDeltaData, config);

            expect(customResolver).toHaveBeenCalledTimes(1);
            expect(result.outcome).toBe<ConflictResolutionOutcome>('error'); // Fallback outcome
            expect(result.resolvedDelta).toEqual(serverDeltaData); // Fallback delta (server-wins)
            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringContaining('Custom conflict resolver failed'),
                resolverError
            );
            consoleErrorSpy.mockRestore();
        });

         it('should return "error" outcome if custom resolver is missing', () => {
            // Correct generic argument, missing customResolver
            const config: ConflictResolverConfig<JsonPatchOperation[]> = { strategy: 'custom' };
            const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            // Correct arguments
            const result = resolveConflict(clientJsonPatches, serverDeltaData, config);

            expect(result.outcome).toBe<ConflictResolutionOutcome>('error'); // Fallback outcome
            expect(result.resolvedDelta).toEqual(serverDeltaData); // Fallback delta (server-wins)
            expect(consoleErrorSpy).toHaveBeenCalledWith(
                 expect.stringContaining('Conflict strategy set to "custom" but no customResolver provided')
            );
            consoleErrorSpy.mockRestore();
        });
    });

    // Test edge cases
    it('should handle empty client patches (server-wins)', () => {
        // Correct generic argument
        const config: ConflictResolverConfig<JsonPatchOperation[]> = { strategy: 'server-wins' };
        // Correct arguments
        const result = resolveConflict([], serverDeltaData, config); // Empty client JSON patches
        expect(result.outcome).toBe<ConflictResolutionOutcome>('server-applied');
        expect(result.resolvedDelta).toEqual(serverDeltaData);
    });

    it('should handle empty client patches (client-wins)', () => {
        // Correct generic argument
        const config: ConflictResolverConfig<JsonPatchOperation[]> = { strategy: 'client-wins' };
        // Correct arguments
        const result = resolveConflict([], serverDeltaData, config); // Empty client JSON patches
        // If client had no effect, server delta should apply even in client-wins
        expect(result.outcome).toBe<ConflictResolutionOutcome>('server-applied'); // Falls back to server as client had no effect
        expect(result.resolvedDelta).toEqual(serverDeltaData);
    });

    it('should handle empty server delta (server-wins)', () => {
        // Correct generic argument
        const config: ConflictResolverConfig<JsonPatchOperation[]> = { strategy: 'server-wins' };
        // Correct arguments
        const result = resolveConflict(clientJsonPatches, [], config); // Empty server delta
        // If server delta is empty, client mutation effectively "wins" by default
        expect(result.outcome).toBe<ConflictResolutionOutcome>('client-applied'); // No server change to apply
        expect(result.resolvedDelta).toEqual(clientJsonPatches);
    });

     it('should handle empty server delta (client-wins)', () => {
        // Correct generic argument
        const config: ConflictResolverConfig<JsonPatchOperation[]> = { strategy: 'client-wins' };
        // Correct arguments
        const result = resolveConflict(clientJsonPatches, [], config); // Empty server delta
        expect(result.outcome).toBe<ConflictResolutionOutcome>('client-applied');
        expect(result.resolvedDelta).toEqual(clientJsonPatches);
    });

     it('should fallback to server-wins for unknown strategy', () => {
        // Correct generic argument, unknown strategy
        const config: ConflictResolverConfig<JsonPatchOperation[]> = { strategy: 'unknown-strategy' as any };
        const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        // Correct arguments
        const result = resolveConflict(clientJsonPatches, serverDeltaData, config);

        expect(result.outcome).toBe<ConflictResolutionOutcome>('error'); // Fallback outcome
        expect(result.resolvedDelta).toEqual(serverDeltaData); // Fallback delta (server-wins)
        expect(consoleWarnSpy).toHaveBeenCalledWith(
            expect.stringContaining('Unknown conflict strategy "unknown-strategy"')
        );
        consoleWarnSpy.mockRestore();
    });

});