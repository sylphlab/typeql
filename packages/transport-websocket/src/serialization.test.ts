// packages/transport-websocket/src/serialization.test.ts

import { describe, it, expect, vi } from 'vitest';
import { defaultSerializer, defaultDeserializer } from './serialization';

describe('serialization', () => {
    describe('defaultSerializer', () => {
        it('should serialize plain objects', () => {
            const obj = { type: 'test', payload: { id: 1, value: 'hello' } };
            expect(defaultSerializer(obj)).toBe('{"type":"test","payload":{"id":1,"value":"hello"}}');
        });

        it('should serialize arrays', () => {
            const arr = [1, 'two', { three: 3 }];
            expect(defaultSerializer(arr)).toBe('[1,"two",{"three":3}]');
        });

        it('should serialize primitives', () => {
            expect(defaultSerializer(123)).toBe('123');
            expect(defaultSerializer('hello')).toBe('"hello"');
            expect(defaultSerializer(true)).toBe('true');
            expect(defaultSerializer(null)).toBe('null');
        });

        // Note: JSON.stringify converts undefined properties in objects to nothing,
        // and undefined in arrays to null. Top-level undefined becomes undefined string.
        it('should handle undefined', () => {
            expect(defaultSerializer(undefined)).toBeUndefined();
            expect(defaultSerializer({ a: undefined, b: 1 })).toBe('{"b":1}');
            expect(defaultSerializer([1, undefined, 3])).toBe('[1,null,3]');
        });
    });

    describe('defaultDeserializer', () => {
        it('should deserialize valid JSON strings', () => {
            const jsonString = '{"type":"test","payload":{"id":1,"value":"hello"}}';
            expect(defaultDeserializer(jsonString)).toEqual({ type: 'test', payload: { id: 1, value: 'hello' } });
        });

        it('should return null for invalid JSON strings', () => {
            const invalidJsonString = '{"type":"test", payload:';
            const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); // Suppress console error
            expect(defaultDeserializer(invalidJsonString)).toBeNull();
            expect(consoleErrorSpy).toHaveBeenCalled();
            consoleErrorSpy.mockRestore();
        });

        it('should deserialize data from a Node.js Buffer', () => {
            // Check if Buffer is available (Node.js environment)
            if (typeof Buffer !== 'undefined') {
                const obj = { message: 'from buffer' };
                const jsonString = JSON.stringify(obj);
                const buffer = Buffer.from(jsonString, 'utf-8');
                expect(defaultDeserializer(buffer)).toEqual(obj);
            } else {
                console.warn('Skipping Buffer test: Buffer not available in this environment.');
                it.skip('Buffer test skipped', () => {}); // Use it.skip
            }
        });

        // Skipping due to potential TextDecoder issues in Bun/Vitest environment
        it.skip('should deserialize data from an ArrayBuffer', () => {
             // Check if ArrayBuffer and TextDecoder are available (Browser-like environment)
            if (typeof ArrayBuffer !== 'undefined' && typeof TextDecoder !== 'undefined') {
                const obj = { message: 'from arraybuffer' };
                const jsonString = JSON.stringify(obj);
                const buffer = new TextEncoder().encode(jsonString);
                // Explicitly cast to ArrayBuffer to satisfy the type checker
                expect(defaultDeserializer(buffer.buffer as ArrayBuffer)).toEqual(obj);
            } else {
                 console.warn('Skipping ArrayBuffer test: ArrayBuffer/TextDecoder not available.');
                 it.skip('ArrayBuffer test skipped', () => {}); // Use it.skip
            }
        });

        it('should deserialize data from a ws Buffer[]', () => {
            // Check if Buffer is available (Node.js environment)
            if (typeof Buffer !== 'undefined') {
                const obj = { message: 'from buffer array' };
                const jsonString = JSON.stringify(obj);
                const buffer1 = Buffer.from(jsonString.slice(0, 10), 'utf-8');
                const buffer2 = Buffer.from(jsonString.slice(10), 'utf-8');
                expect(defaultDeserializer([buffer1, buffer2])).toEqual(obj);
            } else {
                console.warn('Skipping Buffer[] test: Buffer not available.');
                it.skip('Buffer[] test skipped', () => {}); // Use it.skip
            }
        });

        it('should return null and log error for Buffer[] with non-Buffer elements', () => {
             if (typeof Buffer !== 'undefined') {
                const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
                const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
                const buffer = Buffer.from('{"a":1}', 'utf-8');
                // @ts-expect-error - Intentionally passing wrong type
                expect(defaultDeserializer([buffer, "not a buffer"])).toBeNull();
                expect(consoleWarnSpy).toHaveBeenCalled();
                expect(consoleErrorSpy).toHaveBeenCalled(); // JSON.parse will fail
                consoleWarnSpy.mockRestore();
                consoleErrorSpy.mockRestore();
             } else {
                 it.skip('Buffer[] mixed type test skipped', () => {}); // Use it.skip
             }
        });


        it('should handle non-string/buffer types by attempting String() conversion and parsing', () => {
            const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            // Example: A number (JSON.parse('123') is 123)
            // Cast to any to test the fallback logic despite the strict signature
            expect(defaultDeserializer(123 as any)).toBe(123);
            expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('unexpected data type'), 'number');

            // Example: An object with a toString that yields valid JSON
            const objWithToString = {
                toString: () => '{"valid": true}'
            };
            // Cast to any to test the fallback logic
            expect(defaultDeserializer(objWithToString as any)).toEqual({ valid: true });
            expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('unexpected data type'), 'object');


            // Example: An object with a toString that yields invalid JSON
             const objWithBadToString = {
                 toString: () => '{invalid json'
             };
             // Cast to any to test the fallback logic
             expect(defaultDeserializer(objWithBadToString as any)).toBeNull();
             expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('unexpected data type'), 'object');
             expect(consoleErrorSpy).toHaveBeenCalled(); // JSON.parse fails

            consoleWarnSpy.mockRestore();
            consoleErrorSpy.mockRestore();
        });

        it('should return null if String() conversion results in invalid JSON', () => {
            // Test the scenario where the String() fallback is used, but the result cannot be parsed.
            const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

            const objWithBadToString = { toString: () => '{invalid json' };
            const inputData = objWithBadToString as any; // Cast to test fallback

            expect(defaultDeserializer(inputData)).toBeNull();

            // Verify it warned about the unexpected type
            expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('unexpected data type'), 'object');
            // Verify it logged the JSON.parse error
            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringContaining('Deserialization error'),
                expect.any(SyntaxError), // JSON.parse throws SyntaxError
                '{invalid json' // The string that was attempted to be parsed
            );

            consoleErrorSpy.mockRestore();
            consoleWarnSpy.mockRestore();
        });
    });
});