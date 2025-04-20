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
}
// Custom error class for HTTP transport errors
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
  const { url, fetchOptions = {} } = options;

  // The TypeQLTransport interface expects a single message request
  const request = async (
    payload: ProcedureCallMessage,
  ): Promise<ProcedureResultMessage> => {
    // --- Basic implementation for single request first ---
    // Batching is handled by sending the payload array directly.
    // Server is expected to handle single object vs array.

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
  };

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

  // Request function now correctly handles both single and array payloads.
  return {
    request: request,
    subscribe,
  };
}

// Potentially export other utilities or types if needed later
