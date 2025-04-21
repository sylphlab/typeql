import type {
  TypeQLTransport,
  ProcedureCallMessage,
  ProcedureResultMessage,
  SubscribeMessage,
  // AckMessage, // Import if needed for onAckReceived
  // SubscriptionDataMessage, // Import if needed
  // SubscriptionErrorMessage, // Import if needed
} from '@sylphlab/typeql-shared';

export interface HttpTransportOptions {
  /** The URL of the TypeQL HTTP endpoint. */
  url: string;
  /** Optional fetch options to pass to the fetch call (e.g., headers, credentials). */
  fetchOptions?: RequestInit;
  /**
   * Enable request batching.
   * - `false` (default): Requests are sent individually.
   * - `true`: Requests are batched using a default delay (e.g., 0ms for microtask batching).
   * - `{ delayMs: number }`: Requests are batched with the specified delay in milliseconds.
   */
  batching?: boolean | { delayMs: number };
}

// --- Batching Types ---

/** Represents a request waiting in the batch queue. */
export interface QueuedRequest {
  /** The original request payload. */
  payload: ProcedureCallMessage;
  /** Resolver for the promise associated with this request. */
  resolve: (value: ProcedureResultMessage | PromiseLike<ProcedureResultMessage>) => void;
  /** Rejecter for the promise associated with this request. */
  reject: (reason?: any) => void;
}

/** The payload sent to the server for a batch request. */
export type BatchRequestPayload = ProcedureCallMessage[];

/** The expected response structure from the server for a batch request. */
export type BatchResponsePayload = ProcedureResultMessage[];


// --- Custom error class for HTTP transport errors ---
export class HttpError extends Error {
  public status: number;
  public statusText: string;
  public body?: any; // Can store parsed JSON or raw text

  constructor(message: string, status: number, statusText: string, body?: any) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.statusText = statusText;
    this.body = body;
    // Ensure the prototype chain is correct
    Object.setPrototypeOf(this, HttpError.prototype);
  }
}


/**
 * Creates a TypeQL transport that communicates over HTTP.
 * Supports single requests. Batching to be implemented.
 * Does not support subscriptions.
 */
export function createHttpTransport(
  options: HttpTransportOptions,
): TypeQLTransport {
  const { url, fetchOptions = {}, batching = false } = options;

  // --- Batching State ---
  let requestQueue: QueuedRequest[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null; // Use ReturnType for better type safety

  // Determine batching configuration
  const batchingEnabled = batching !== false;
  const batchDelayMs = typeof batching === 'object' ? batching.delayMs : 0; // Default to 0ms if batching is true

  // --- Batch Send Logic ---
  const sendBatch = async () => {
    // 1. Check if queue is empty
    if (requestQueue.length === 0) {
      return;
    }

    // 2. Copy and clear the queue *before* the async operation
    const batchToSend = [...requestQueue];
    requestQueue = []; // Clear original queue

    // 3. Format the payload
    const batchPayload: BatchRequestPayload = batchToSend.map(req => req.payload);

    // 4. Define batch URL (simple append for now, ensure no double slash)
    const batchUrl = `${url.replace(/\/$/, '')}/batch`;

    try {
      // 5. Make the batch request
      const response = await fetch(batchUrl, {
        method: 'POST',
        ...fetchOptions, // Spread user options first
        headers: { // Override/add specific headers
          ...fetchOptions.headers,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(batchPayload),
      });

      // 6. Handle non-OK response for the entire batch
      if (!response.ok) {
        let errorBody: any;
        try {
          errorBody = await response.json();
        } catch (e) {
          try {
            errorBody = await response.text();
          } catch (e2) {
            errorBody = `Status ${response.status} but failed to read error body.`;
          }
        }
        // Throw HttpError for batch failure
        throw new HttpError(
          `HTTP Batch Error ${response.status} (${response.statusText})`,
          response.status,
          response.statusText,
          errorBody,
        );
      }

      // 7. Parse successful response (handling individual results is Subtask 5)
      const batchResult: BatchResponsePayload = await response.json();

      // --- Subtask 5: Handle individual results/errors ---
      if (!Array.isArray(batchResult)) {
        throw new Error('Batch response is not an array');
      }

      if (batchResult.length !== batchToSend.length) {
        throw new Error(
          `Batch response length (${batchResult.length}) does not match request length (${batchToSend.length})`,
        );
      }

      // Process each result
      batchToSend.forEach((req, index) => {
        const result = batchResult[index];
        if (!result) {
          // Should not happen if lengths match, but handle defensively
          req.reject(new Error(`Missing response for request at index ${index}`));
          return;
        }

        // Check the discriminated union type
        if (result.result.type === 'error') {
          // Reject with the nested error object
          // Consider wrapping this in a custom client-side error if needed
          req.reject(result.result.error);
        } else {
          // Resolve with the full ProcedureResultMessage (which contains result.type === 'data')
          req.resolve(result);
        }
      });

    } catch (error: unknown) {
      // 8. Handle fetch/parsing errors, thrown HttpError, or response processing errors
      console.error('TypeQL HTTP Transport batch request failed:', error);

      // Reject all promises in the processed batch with the batch error
      const rejectionError = error instanceof Error ? error : new Error('Batch request failed');
      batchToSend.forEach(req => req.reject(rejectionError));
    }
  };
  // --- Request Logic ---
  const request = ( // Remove async here, return a Promise manually
    payload: ProcedureCallMessage,
  ): Promise<ProcedureResultMessage> => {

    if (!batchingEnabled) {
      // --- Send Immediately if Batching Disabled ---
      return (async () => {
        try {
          const response = await fetch(url, {
            method: 'POST', // TypeQL typically uses POST for queries/mutations
            ...fetchOptions, // Spread user options first
            headers: { // Override/add specific headers
              ...fetchOptions.headers,
              'Content-Type': 'application/json',
              Accept: 'application/json', // Expect JSON response
            },
            body: JSON.stringify(payload),
          });

          if (!response.ok) {
            let errorBody: any;
            try {
              errorBody = await response.json();
            } catch (e) {
              try {
                errorBody = await response.text();
              } catch (e2) {
                errorBody = `Status ${response.status} but failed to read error body.`;
              }
            }
            throw new HttpError(
              `HTTP Error ${response.status} (${response.statusText})`,
              response.status,
              response.statusText,
              errorBody,
            );
          }

          const result = await response.json();
          return result;

        } catch (error: unknown) {
          console.error('TypeQL HTTP Transport request failed (non-batched):', error);
          if (error instanceof HttpError) {
            throw error;
          }
          if (error instanceof Error) {
            throw new Error(`TypeQL HTTP Request Failed: ${error.message}`);
          }
          throw new Error(`TypeQL HTTP Request Failed: Unknown error occurred.`);
        }
      })();
    }

    // --- Queue Request if Batching Enabled ---
    return new Promise<ProcedureResultMessage>((resolve, reject) => {
      // Add request to the queue
      requestQueue.push({ payload, resolve, reject });

      // Clear existing timer if it exists
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }

      // Set a new timer to send the batch
      debounceTimer = setTimeout(() => {
        debounceTimer = null; // Clear the timer ID after execution
        sendBatch(); // Call the batch sending function
      }, batchDelayMs);
    });


    /* PREVIOUS SINGLE REQUEST LOGIC (MOVED INSIDE !batchingEnabled block)
    try {
      const response = await fetch(url, {
        method: 'POST', // TypeQL typically uses POST for queries/mutations
        ...fetchOptions, // Spread user options first
        headers: { // Override/add specific headers
          ...fetchOptions.headers,
          'Content-Type': 'application/json',
          Accept: 'application/json', // Expect JSON response
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        let errorBody: any;
        try {
          // Try parsing as JSON first, as TypeQL errors might be structured
          errorBody = await response.json();
        } catch (e) {
          try {
            // Fallback to text if JSON parsing fails
            errorBody = await response.text();
          } catch (e2) {
            // Ignore error reading body if all else fails
            errorBody = `Status ${response.status} but failed to read error body.`;
          }
        }
        // Use the custom HttpError class
        throw new HttpError(
          `HTTP Error ${response.status} (${response.statusText})`,
          response.status,
          response.statusText,
          errorBody,
        );
      }

      // Server response type (single or array) should match the request payload type.
      const result = await response.json();
      return result;

    } catch (error: unknown) {
      // Log the error for debugging purposes
      console.error('TypeQL HTTP Transport request failed:', error);

      // Re-throw HttpError instances directly
      if (error instanceof HttpError) {
        throw error;
      }

      // Wrap other errors (e.g., network errors)
      if (error instanceof Error) {
        throw new Error(`TypeQL HTTP Request Failed: ${error.message}`); // Or potentially wrap in a different custom error
      }
      // Fallback for non-Error objects thrown
      throw new Error(`TypeQL HTTP Request Failed: Unknown error occurred.`);
    }
    */
  };

  // --- Subscribe Logic (Not Supported) ---
  const subscribe = (
    _payload: SubscribeMessage,
  ): never => { // Using 'never' as return type since it always throws
    // Subscriptions require a persistent connection (like WebSockets), not standard HTTP.
    throw new Error('Subscriptions are not supported over standard HTTP transport.');
    /*
    // If using Observables and wanted to return an erroring observable:
    return new Observable(observer => {
      observer.error(new Error('Subscriptions are not supported over standard HTTP transport.'));
    });
    */
  };

  // --- Return Transport Object ---
  return {
    request: request,
    subscribe: subscribe,
  };
}

// Potentially export other utilities or types if needed later
