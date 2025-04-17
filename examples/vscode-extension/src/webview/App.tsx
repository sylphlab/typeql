import React, { useState, useEffect } from 'react';
import { useTypeQL, useQuery, useMutation } from '@sylph/typeql-react'; // Use correct package name
import { TypeQLClientError } from '@sylph/typeql-shared'; // Use shared package

// Assuming the ExtensionRouter type is somehow made available here
// This often requires a build step or careful tsconfig setup.
// For now, we might need to define a placeholder or use 'any'.
// Let's try importing relative to the compiled output structure (adjust if needed)
import type { ExtensionRouter } from '../extension';

function App() {
    const typeql = useTypeQL<ExtensionRouter>(); // Specify the router type
    const [section, setSection] = useState('editor'); // Example section
    const [valueToUpdate, setValueToUpdate] = useState('');
    const [updateError, setUpdateError] = useState<string | null>(null);
    const [updateSuccess, setUpdateSuccess] = useState(false);

    // Query to get configuration
    const { data: configData, isLoading: isLoadingConfig, error: configError, refetch } = useQuery(
        typeql.client.getConfiguration, // Pass the procedure
        { section }, // Input
        { enabled: !!typeql.client } // Only enable when client is ready
    );

    // Mutation to update configuration
    // Remove the explicit generic as it caused issues
    const updateMutation = useMutation(typeql.client.updateConfiguration, {
        onMutate: () => {
            setUpdateError(null);
            setUpdateSuccess(false);
        },
        onSuccess: (data) => {
            console.log('Update successful:', data);
            setUpdateSuccess(true);
            // Optionally refetch the config after update
            refetch();
        },
        onError: (err: Error | TypeQLClientError) => {
            console.error('Update failed:', err);
            setUpdateError(err.message);
            setUpdateSuccess(false);
        },
    });

    const handleUpdate = () => {
        let parsedValue: unknown; // Use unknown to match Zod schema
        try {
            // Attempt to parse input as JSON, otherwise use as string
            parsedValue = JSON.parse(valueToUpdate);
        } catch (e) {
            parsedValue = valueToUpdate; // Use as string if JSON parse fails
        }
        updateMutation.mutate({ section, value: parsedValue }); // Pass directly
    };

    return (
        <div>
            <h1>VSCode Configuration Example</h1>

            <div>
                <label>
                    Config Section:
                    <input type="text" value={section} onChange={(e) => setSection((e.target as HTMLInputElement).value)} />
                </label>
                <button onClick={() => refetch()} disabled={isLoadingConfig}>
                    {isLoadingConfig ? 'Loading...' : 'Get Configuration'}
                </button>
            </div>

            {configError && <p style={{ color: 'red' }}>Error loading config: {configError.message}</p>}
            {configData && (
                <pre><code>{JSON.stringify(configData, null, 2)}</code></pre>
            )}

            <hr />

            <h2>Update Configuration</h2>
            <div>
                <label>
                    Value (String or JSON):
                    <textarea
                        value={valueToUpdate}
                        onChange={(e) => setValueToUpdate((e.target as HTMLTextAreaElement).value)}
                        rows={3}
                    />
                </label>
                <button onClick={handleUpdate} disabled={updateMutation.isLoading}>
                    {updateMutation.isLoading ? 'Updating...' : `Update ${section}`}
                </button>
            </div>
            {updateError && <p style={{ color: 'red' }}>Update Error: {updateError}</p>}
            {updateSuccess && <p style={{ color: 'green' }}>Update Successful!</p>}

        </div>
    );
}

export default App;