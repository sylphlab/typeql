import { useState } from 'react';
import { usezenQuery, useMutation, useSubscription } from '@sylphlab/zen-query-react'; // Use correct package name
import { zenQueryClientError } from '@sylphlab/zen-query-shared'; // Use shared package
import type { AppRouter } from '../server/index.js'; // Ensure extension is present
import './App.css';

// Define types based on server definition for clarity (can be shared)
type CounterInput = { amount?: number };
type CounterOutput = number;
type CounterError = { message: string; code?: string };
type MutationContext = { previousCount?: number };

// Define the type for the client prop explicitly
type zenQueryClient = NonNullable<ReturnType<typeof usezenQuery>['client']>;

// New component that receives the guaranteed client
function Counter({ client }: { client: zenQueryClient }) {
  const [currentCount, setCurrentCount] = useState<number | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // === Mutation: Increment ===
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const incrementMutation = useMutation(client.increment as any, { // Re-add 'as any' workaround
    onMutate: async (variables: CounterInput) => {
      setCurrentCount((prev) => (prev !== undefined ? prev + (variables?.amount ?? 1) : undefined));
      const context: MutationContext = { previousCount: currentCount };
      return context;
    },
    onError: (err: Error | zenQueryClientError, _variables: CounterInput, context?: MutationContext) => {
      console.error("Increment failed:", err);
      setCurrentCount(context?.previousCount);
      setError(`Increment failed: ${err.message}`);
    },
  });

  // === Mutation: Decrement ===
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const decrementMutation = useMutation(client.decrement as any, { // Re-add 'as any' workaround
     onMutate: async (variables: CounterInput) => {
      setCurrentCount((prev) => (prev !== undefined ? prev - (variables?.amount ?? 1) : undefined));
      const context: MutationContext = { previousCount: currentCount };
      return context;
    },
    onError: (err: Error | zenQueryClientError, _variables: CounterInput, context?: MutationContext) => {
      console.error("Decrement failed:", err);
      setCurrentCount(context?.previousCount);
      setError(`Decrement failed: ${err.message}`);
    },
  });

  // === Subscription: Listen for count updates ===
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
   useSubscription(client.onCountUpdate as any, undefined, { // Re-add 'as any' workaround
     enabled: true, // Always enabled here as client exists
     onData: (newCount: CounterOutput) => {
       console.log('Subscription received:', newCount);
       setCurrentCount(newCount);
       setIsLoading(false);
       setError(null);
     },
     onError: (err: CounterError) => {
       console.error('Subscription error:', err);
       setError(`Subscription failed: ${err.message}`);
       setIsLoading(false);
     },
   });

  // --- Render Logic ---

  const handleIncrement = () => {
    incrementMutation.mutate({ amount: 1 });
  };

  const handleDecrement = () => {
    decrementMutation.mutate({ amount: 1 });
  };

  return (
      <div className="card">
        {isLoading ? (
          <p>Loading count...</p>
        ) : error ? (
          <p style={{ color: 'red' }}>Error: {error}</p>
        ) : (
          <p>Count is: {currentCount ?? 'N/A'}</p>
        )}
        <button onClick={handleIncrement} disabled={incrementMutation.isLoading || isLoading}>
          Increment
        </button>
        <button onClick={handleDecrement} disabled={decrementMutation.isLoading || isLoading}>
          Decrement
        </button>
      </div>
  );
}


function App() {
  // Get the typed zenQuery client instance using the specific AppRouter type
  const typeql = usezenQuery<AppRouter>(); // Specify AppRouter generic

  return (
    <>
      <h1>zenQuery Counter Example</h1>
      {/* Conditionally render the Counter component only when the client is available */}
      {typeql.client ? (
        <Counter client={typeql.client} />
      ) : (
        <div>Loading client...</div>
      )}
      <p className="read-the-docs">
        Open your browser console and server console to see logs.
      </p>
    </>
  );
}

export default App;
