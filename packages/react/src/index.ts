// packages/react/src/index.ts

// packages/react/src/index.ts

import React, { createContext, useContext, useMemo } from 'react';
// Correct import paths using workspace alias
import { createClient, AnyRouter } from '@typeql/core'; // Import AnyRouter type as well

// --- Context ---

// Define a more specific type for the client instance based on createClient's return type
// Assuming createClient returns a specific type `TypeQLClientProxy<TRouter>`
type TypeQLClient<TRouter extends AnyRouter> = ReturnType<typeof createClient<TRouter>>;

// Create the context with a generic type for the router
const TypeQLContext = createContext<TypeQLClient<any> | null>(null);

// --- Provider ---

export interface TypeQLProviderProps<TRouter extends AnyRouter> {
  client: TypeQLClient<TRouter>;
  children: React.ReactNode;
}

/**
 * Provider component to make the TypeQL client available via context.
 */
// Removed export keyword
function TypeQLProvider<TRouter extends AnyRouter>({
  client,
  children,
}: TypeQLProviderProps<TRouter>): React.ReactElement {
  // Use useMemo to ensure the context value reference doesn't change unnecessarily
  const contextValue = useMemo(() => client, [client]);
  return React.createElement(TypeQLContext.Provider, { value: contextValue }, children);
}

// --- Hook ---

/**
 * Hook to access the TypeQL client instance from the context.
 * Throws an error if used outside of a TypeQLProvider.
 */
// Removed export keyword
function useTypeQLClient<TRouter extends AnyRouter>(): TypeQLClient<TRouter> {
  const client = useContext(TypeQLContext);
  if (!client) {
    throw new Error('`useTypeQLClient` must be used within a `TypeQLProvider`.');
  }
  // Cast needed as the context is created with `any` router type initially.
  return client as TypeQLClient<TRouter>;
}

// --- Query Hook (Basic Implementation) ---

// Helper type to extract query procedures
// This is complex and might need refinement based on actual client proxy type structure
type inferQueryInput<TProcedure> = TProcedure extends { query: (input: infer TInput) => any } ? TInput : never;
type inferQueryOutput<TProcedure> = TProcedure extends { query: (input: any) => Promise<infer TOutput> } ? TOutput : never;

/**
 * Basic hook to perform a TypeQL query.
 * NOTE: Path resolution and dependency management need significant refinement.
 */
export function useQuery<
    TRouter extends AnyRouter,
    TPath extends string, // Placeholder for path inference/validation
    TProcedure extends /* Lookup procedure type based on path */ any,
    TInput = inferQueryInput<TProcedure>,
    TOutput = inferQueryOutput<TProcedure>
>(
    // path: string[], // Replace string array with a more typesafe path lookup/proxy interaction
    procedure: TProcedure, // Pass the actual procedure accessor from the client proxy
    input: TInput,
    options?: { enabled?: boolean }
): { data: TOutput | undefined; isLoading: boolean; error: Error | null } {
    // Get client instance via hook
    const client = useTypeQLClient<TRouter>(); // Router type might be needed here or inferred
    const [data, setData] = React.useState<TOutput | undefined>(undefined);
    const [isLoading, setIsLoading] = React.useState(options?.enabled !== false); // Only start loading if enabled
    const [error, setError] = React.useState<Error | null>(null);

    // Serialize input for dependency array - basic JSON stringify, might need improvement
    const inputKey = useMemo(() => {
        try {
            return JSON.stringify(input);
        } catch {
            return String(input); // Fallback
        }
    }, [input]);

    React.useEffect(() => {
        if (options?.enabled === false) {
            // If disabled after being enabled, reset state
            if (isLoading || data || error) {
                setData(undefined);
                setIsLoading(false);
                setError(null);
            }
            return;
        }

        let isCancelled = false;
        setIsLoading(true);
        setError(null); // Reset error on new fetch

        const callQuery = async () => {
            try {
                // Directly use the passed procedure accessor if types align
                const queryFn = (procedure as any)?.query;
                if (typeof queryFn !== 'function') {
                    throw new Error("Invalid procedure object passed to useQuery.");
                }

                const result = await queryFn(input);
                if (!isCancelled) {
                    setData(result as TOutput); // Cast result
                    setIsLoading(false);
                }
            } catch (err: any) {
                 if (!isCancelled) {
                    setError(err instanceof Error ? err : new Error(String(err)));
                }
            }
        };

        callQuery();

        return () => {
            isCancelled = true;
        };
        // Use serialized input key in dependency array
    }, [procedure, inputKey, options?.enabled]); // Procedure reference should be stable if client is stable

    return { data, isLoading, error };
}


console.log("@typeql/react basic context, hook, and useQuery loaded.");

// Export the provider and hook
export { TypeQLProvider, useTypeQLClient };
// Context itself is usually not exported directly
