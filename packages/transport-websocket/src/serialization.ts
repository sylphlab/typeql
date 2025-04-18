// packages/transport-websocket/src/serialization.ts

/**
 * Default serializer using JSON.stringify.
 * @param data - The data to serialize.
 * @returns The serialized JSON string.
 */
export const defaultSerializer = (data: any): string => JSON.stringify(data);

/**
 * Default deserializer using JSON.parse.
 * Handles various input types (string, Buffer, ArrayBuffer, Buffer[]).
 * Logs errors and returns null on failure.
 * @param data - The raw data received from the WebSocket.
 * @returns The deserialized JavaScript object, or null if deserialization fails.
 */
export const defaultDeserializer = (data: string | Buffer | ArrayBuffer | Buffer[]): any => {
    let dataString: string | undefined;
    try {
        if (typeof data === 'string') {
            dataString = data;
        } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) {
            // Handle Node.js Buffer
            dataString = data.toString('utf-8');
        } else if (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer) {
            // Handle Browser ArrayBuffer
            dataString = new TextDecoder().decode(data);
         } else if (Array.isArray(data) && typeof Buffer !== 'undefined') {
             // Handle ws Buffer[] case (assuming Buffer elements)
             // Filter out non-Buffer elements just in case
             const buffers = data.filter(item => Buffer.isBuffer(item)) as Buffer[];
             if (buffers.length === data.length) { // Ensure all elements were Buffers
                dataString = Buffer.concat(buffers).toString('utf-8');
             } else {
                 console.warn("[TypeQL WS Transport] Received mixed array data type, attempting String() conversion:", data);
                 dataString = String(data);
             }
         } else {
             // Fallback for any other type not explicitly handled
            console.warn("[TypeQL WS Transport] Received unexpected data type, attempting String() conversion:", typeof data);
            dataString = String(data); // Use String() for safer conversion of primitives or objects with toString
        }

        if (dataString === undefined) {
             // This should ideally not happen with the String() fallback, but safety first
             throw new Error("Could not convert received data to string");
        }

        return JSON.parse(dataString);
    } catch (error) {
        console.error("[TypeQL WS Transport] Deserialization error:", error, dataString ?? data); // Log original data on error if possible
         return null; // Explicitly return null on error
     }
 };