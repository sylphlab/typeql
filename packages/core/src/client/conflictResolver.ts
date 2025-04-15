/**
 * Represents a conflict resolution strategy.
 */
export type ConflictResolutionStrategy = 'client-wins' | 'server-wins' | 'custom';

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
 * TODO: Implement actual conflict resolution logic based on the chosen strategy.
 * This might involve comparing timestamps, applying specific rules, or using the custom resolver.
 * For now, this is a placeholder.
 * Decides which delta 'wins' in a conflict scenario.
 */
export function resolveConflict<Delta>(
    clientDelta: Delta,
    serverDelta: Delta, // Changed parameter name for clarity
    config: ConflictResolverConfig<Delta>
): Delta {
    console.warn(`[ReqDelta Client] Conflict detected between client delta and server delta. Strategy: ${config.strategy}`);

    switch (config.strategy) {
        case 'client-wins':
            return clientDelta;
        case 'server-wins':
            return serverDelta;
        case 'custom':
            if (config.customResolver) {
                try {
                    return config.customResolver(clientDelta, serverDelta);
                } catch (err) {
                    console.error('[ReqDelta Client] Custom conflict resolver failed:', err);
                    // Fallback strategy if custom resolver fails (e.g., server wins)
                    return serverDelta;
                }
            } else {
                console.error('[ReqDelta Client] Conflict strategy set to "custom" but no customResolver provided. Falling back to "server-wins".');
                return serverDelta;
            }
        default:
            console.warn(`[ReqDelta Client] Unknown conflict strategy "${config.strategy}". Falling back to "server-wins".`);
            return serverDelta;
    }
}
