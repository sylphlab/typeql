import * as vscode from 'vscode';
import {
    ProcedureContext,
    zenQueryTransport, // Import zenQueryTransport
    ProcedureResultMessage, SubscriptionDataMessage, SubscriptionErrorMessage, SubscriptionEndMessage, AckMessage, UnsubscribeMessage // Import message types (Removed ProcedureCall)
} from '@sylphlab/zen-query-shared'; // Use shared package
import {
    createRouter,
    initzenQuery,
    createRequestHandler,
    SubscriptionManager,
} from '@sylphlab/zen-query-server'; // Use server package
import { createVSCodeTransport } from '@sylphlab/zen-query-transport-vscode'; // Correct import name
import { z } from 'zod'; // Import zod if needed for API definition

// Define a simple context for the extension procedures
interface ExtensionContext extends ProcedureContext {
    // Add any extension-specific context here, e.g., workspace state
}

// Initialize zenQuery procedure builder
const t = initzenQuery<ExtensionContext>();

// Define a simple router for the extension
const extensionRouter = createRouter<ExtensionContext>()({
    getConfiguration: t.query
        .input(z.object({ section: z.string() }))
        .resolve(async ({ input }: { input: { section: string } }) => { // Add input type
            // Access VSCode configuration API
            const config = vscode.workspace.getConfiguration(input.section);
            // Be careful about what configuration is exposed
            // Here, we just return a specific value or the whole section inspect result
            // Returning entire configuration objects might expose sensitive info.
            // Example: return config.get('exampleSetting');
            return config.inspect(input.section); // Example: return inspection details
        }),
    updateConfiguration: t.mutation
        .input(z.object({ section: z.string(), value: z.unknown() })) // Use z.unknown() for generic value
        .resolve(async ({ input }: { input: { section: string; value?: unknown } }) => { // Ensure value is optional
            try {
                const config = vscode.workspace.getConfiguration();
                // Update configuration globally (or workspace/folder specific)
                await config.update(input.section, input.value, vscode.ConfigurationTarget.Global);
                return { success: true };
            } catch (error: any) {
                console.error("Failed to update configuration:", error);
                // Throwing an error here will be caught by the handler and sent to client
                throw new Error(`Failed to update configuration: ${error.message}`);
            }
        }),
    // Add a simple subscription example (e.g., notify on config change)
    onConfigChange: t.subscription.subscribe(({ publish }: { publish: (data: any) => void }) => { // Add publish type
        console.log('[Extension] Client subscribed to onConfigChange');
        const disposable = vscode.workspace.onDidChangeConfiguration(e => {
            // Example: Check if a specific section changed and publish
            // This is a basic example; real implementation might need more filtering
            console.log('[Extension] Configuration changed, publishing event');
            publish({ event: 'configChanged', timestamp: Date.now() }); // Publish simple event object
        });

        // Return the disposable to clean up the listener
        return () => {
            console.log('[Extension] Cleaning up onConfigChange subscription');
            disposable.dispose();
        };
    })
});

// Export the router type for the client (Webview)
export type ExtensionRouter = typeof extensionRouter;

// Global subscription manager for the extension
const globalSubscriptionManager = new SubscriptionManager();

// Function to create context for each request/connection
const createContext = async (opts: { transport: zenQueryTransport }): Promise<ExtensionContext> => {
    // Access transport if needed, e.g., for client identification
    return {
        // Add context properties here
    };
};

// Keep track of panels to avoid creating duplicates or manage lifecycle
let currentPanel: vscode.WebviewPanel | undefined = undefined;

export function activate(context: vscode.ExtensionContext) {

    console.log('Extension "typeql-vscode-example" is now active!');

    // Register the command to show the webview panel
    let showPanelCommand = vscode.commands.registerCommand('typeql-vscode-example.showPanel', () => {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If we already have a panel, show it.
        if (currentPanel) {
            currentPanel.reveal(column);
            return;
        }

        // Otherwise, create a new panel.
        currentPanel = vscode.window.createWebviewPanel(
            'typeqlExample', // Identifies the type of the webview. Used internally
            'zenQuery Example', // Title of the panel displayed to the user
            column || vscode.ViewColumn.One, // Editor column to show the new webview panel in.
            { // Webview options
                enableScripts: true, // Allow scripts to run in the webview
                // Retain context when hidden
                retainContextWhenHidden: true,
                // Restrict the webview to only loading content from our extension's directories.
                // localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] // Example if loading local resources
            }
        );

        // --- zenQuery Setup for this Panel ---

        // 1. Create the VSCode Transport linked to this specific panel's webview
        // Pass the webview's postMessage and onDidReceiveMessage functions
        const transport = createVSCodeTransport({
             vscodeApi: currentPanel.webview // The webview object conforms to VSCodePostMessage interface
        });

        // 2. Create the Request Handler using the router, manager, context, and transport
        const handler = createRequestHandler<ExtensionContext>(
            {
                router: extensionRouter,
                subscriptionManager: globalSubscriptionManager,
                createContext: (opts: { transport: zenQueryTransport }) => createContext(opts), // Add opts type
                clientId: `webview_${Date.now()}` // Example client ID
            },
            transport // Pass the transport for this panel
        );

        // 3. Register cleanup when the panel is disposed
        currentPanel.onDidDispose(
            () => {
                console.log("Webview panel disposed, cleaning up handler.");
                handler.cleanup(); // Use the cleanup function returned by createRequestHandler
                currentPanel = undefined;
            },
            null,
            context.subscriptions
        );

        // 4. Set the webview's initial HTML content
        currentPanel.webview.html = getWebviewContent(currentPanel, context.extensionUri); // Pass panel and extensionUri

        // --- End zenQuery Setup ---

    });

    context.subscriptions.push(showPanelCommand);
}

// This method is called when your extension is deactivated
export function deactivate() {
    console.log('Extension "typeql-vscode-example" is deactivated.');
    // Perform any cleanup needed for the global subscription manager if necessary
    // globalSubscriptionManager.cleanupAll(); // Example if such a method exists
}

// Function to generate the HTML for the webview, including loading the compiled React app
function getWebviewContent(panel: vscode.WebviewPanel, extensionUri: vscode.Uri): string {
    // Get the local path to the bundled script file (assuming a build step creates this)
    // Adjust the path based on your actual build output structure
    const scriptPathOnDisk = vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'); // Example path

    // Generate a special URI to use in the webview
    const scriptUri = panel.webview.asWebviewUri(scriptPathOnDisk);

    // Use a nonce for Content Security Policy
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <!--
        Use a content security policy to only allow loading specific resources in the webview
    -->
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>zenQuery Example</title>
</head>
<body>
    <div id="root"></div> <!-- Root element for React app -->
    <script nonce="${nonce}" src="${scriptUri}"></script> <!-- Load the bundled webview script -->
</body>
</html>`;
}

// Helper function to generate a nonce
function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}