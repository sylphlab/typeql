/**
 * Represents a conflict resolution strategy.
 */
export type ConflictResolutionStrategy = 'client-wins' | 'server-wins' | 'custom';

/**
 * Indicates the outcome of the conflict resolution process.
 */
export type ConflictResolutionOutcome =
    | 'server-applied' // Server delta was used as is.
    | 'client-applied' // Client delta was used as is.
    | 'merged'         // Custom resolver produced a merged delta.
    | 'error';         // Resolution failed, fell back to server-wins.

/**
 * Interface for a custom conflict resolver function.
 * Takes the client's delta and the conflicting server delta and returns the resolved delta.
 */
export type CustomConflictResolver<Delta = any> = (
    clientDelta: Delta,
    serverUpdate: Delta // Assuming the server update also carries a delta
) => Delta;

/**
 * Interface defining the conflict resolution configuration.
 */
export interface ConflictResolverConfig<Delta = any> {
    strategy: ConflictResolutionStrategy;
    customResolver?: CustomConflictResolver<Delta>;
}

/**
 * Result object returned by the conflict resolver.
 */
export interface ConflictResolutionResult<Delta = any> {
    resolvedDelta: Delta;
    outcome: ConflictResolutionOutcome;
}


/** Helper to check if a delta (assumed JSON Patch array) is empty */
function isDeltaEmpty(delta: any): boolean {
    // Basic check, might need refinement based on actual Delta types used
    return Array.isArray(delta) && delta.length === 0;
}

/**
 * Decides which delta 'wins' in a conflict scenario based on the configured strategy
 * and returns the resolved delta along with the outcome.
 */
export function resolveConflict<Delta>(
    clientDelta: Delta,
    serverDelta: Delta, // Changed parameter name for clarity
    config: ConflictResolverConfig<Delta>
): ConflictResolutionResult<Delta> { // Changed return type
    console.warn(`[zenQuery Client] Conflict detected between client delta and server delta. Strategy: ${config.strategy}`);

    // Handle empty deltas first - assumes JSON Patch array format for Delta
    if (isDeltaEmpty(clientDelta)) {
        // If client delta is empty, server delta always applies
        return { resolvedDelta: serverDelta, outcome: 'server-applied' };
    }
    if (isDeltaEmpty(serverDelta)) {
        // If server delta is empty, client delta always applies
        return { resolvedDelta: clientDelta, outcome: 'client-applied' };
    }

    // Proceed with strategy if neither delta is empty
    switch (config.strategy) {
        case 'client-wins':
            // Client's delta is chosen, outcome indicates client preference applied
            return { resolvedDelta: clientDelta, outcome: 'client-applied' };
        case 'server-wins':
            // Server's delta is chosen, outcome indicates server preference applied
            return { resolvedDelta: serverDelta, outcome: 'server-applied' };
        case 'custom':
            if (config.customResolver) {
                try {
                    // Custom logic determines the final delta
                    const mergedDelta = config.customResolver(clientDelta, serverDelta);
                    // Outcome indicates a merge or custom resolution occurred
                    return { resolvedDelta: mergedDelta, outcome: 'merged' };
                } catch (err) {
                    console.error('[zenQuery Client] Custom conflict resolver failed:', err);
                    // Fallback to server-wins if custom logic fails, outcome indicates error
                    return { resolvedDelta: serverDelta, outcome: 'error' };
                }
            } else {
                console.error('[zenQuery Client] Conflict strategy set to "custom" but no customResolver provided. Falling back to "server-wins".');
                 // Fallback to server-wins if custom resolver is missing, outcome indicates error
                return { resolvedDelta: serverDelta, outcome: 'error' };
            }
        default:
            console.warn(`[zenQuery Client] Unknown conflict strategy "${config.strategy}". Falling back to "server-wins".`);
             // Fallback for unknown strategy, outcome indicates error
            return { resolvedDelta: serverDelta, outcome: 'error' };
    }
}
