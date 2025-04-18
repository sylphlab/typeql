import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from 'react';
import { useTypeQL, useMutation, useSubscription } from '@sylphlab/typeql-react'; // Use correct package name
import './App.css';
// New component that receives the guaranteed client
function Counter({ client }) {
    const [currentCount, setCurrentCount] = useState(undefined);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState(null);
    // === Mutation: Increment ===
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const incrementMutation = useMutation(client.increment, {
        onMutate: async (variables) => {
            setCurrentCount((prev) => (prev !== undefined ? prev + (variables?.amount ?? 1) : undefined));
            const context = { previousCount: currentCount };
            return context;
        },
        onError: (err, _variables, context) => {
            console.error("Increment failed:", err);
            setCurrentCount(context?.previousCount);
            setError(`Increment failed: ${err.message}`);
        },
    });
    // === Mutation: Decrement ===
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const decrementMutation = useMutation(client.decrement, {
        onMutate: async (variables) => {
            setCurrentCount((prev) => (prev !== undefined ? prev - (variables?.amount ?? 1) : undefined));
            const context = { previousCount: currentCount };
            return context;
        },
        onError: (err, _variables, context) => {
            console.error("Decrement failed:", err);
            setCurrentCount(context?.previousCount);
            setError(`Decrement failed: ${err.message}`);
        },
    });
    // === Subscription: Listen for count updates ===
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    useSubscription(client.onCountUpdate, undefined, {
        enabled: true, // Always enabled here as client exists
        onData: (newCount) => {
            console.log('Subscription received:', newCount);
            setCurrentCount(newCount);
            setIsLoading(false);
            setError(null);
        },
        onError: (err) => {
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
    return (_jsxs("div", { className: "card", children: [isLoading ? (_jsx("p", { children: "Loading count..." })) : error ? (_jsxs("p", { style: { color: 'red' }, children: ["Error: ", error] })) : (_jsxs("p", { children: ["Count is: ", currentCount ?? 'N/A'] })), _jsx("button", { onClick: handleIncrement, disabled: incrementMutation.isLoading || isLoading, children: "Increment" }), _jsx("button", { onClick: handleDecrement, disabled: decrementMutation.isLoading || isLoading, children: "Decrement" })] }));
}
function App() {
    // Get the typed TypeQL client instance using the specific AppRouter type
    const typeql = useTypeQL(); // Specify AppRouter generic
    return (_jsxs(_Fragment, { children: [_jsx("h1", { children: "TypeQL Counter Example" }), typeql.client ? (_jsx(Counter, { client: typeql.client })) : (_jsx("div", { children: "Loading client..." })), _jsx("p", { className: "read-the-docs", children: "Open your browser console and server console to see logs." })] }));
}
export default App;
