// packages/react/src/hooks/useTypeQLClient.ts
import { AnyRouter } from '@sylphlab/typeql-shared';
import { createClient } from '@sylphlab/typeql-client';
import { useTypeQL } from '../context'; // Import from the new context file

/**
 * @deprecated Use `useTypeQL().client` instead. Accessing only the client might hide the need for the store.
 */
export function useTypeQLClient<TRouter extends AnyRouter = AnyRouter>(): ReturnType<typeof createClient<TRouter>> {
     console.warn("`useTypeQLClient` is deprecated. Use `useTypeQL().client` instead.");
     return useTypeQL<TRouter>().client;
}