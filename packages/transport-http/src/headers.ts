import type { HttpTransportOptions } from './types';

/**
 * Creates a function that retrieves the headers for an HTTP request,
 * combining base headers with dynamic headers provided in the options.
 *
 * @param options - The transport options containing potential header configurations.
 * @returns An async function that returns the final HeadersInit object.
 */
export function createHeaderGetter(options: Pick<HttpTransportOptions, 'headers'>): () => Promise<HeadersInit> {
    const getHeaders = async (): Promise<HeadersInit> => {
        const baseHeaders: HeadersInit = {
            'Content-Type': 'application/json',
            // Consider adding a specific header for batched requests?
            // 'X-TypeQL-Batch': '1'
        };

        if (!options.headers) {
            return baseHeaders;
        }

        const dynamicHeaders = typeof options.headers === 'function'
            ? await options.headers()
            : options.headers;

        // Combine base and dynamic headers, ensuring dynamic ones override base ones if keys clash
        const combined = new Headers(baseHeaders);
        new Headers(dynamicHeaders).forEach((value, key) => {
            combined.set(key, value);
        });

        return combined;
    };

    return getHeaders;
}