/**
 * Generates a simple pseudo-random ID.
 * NOTE: This is NOT cryptographically secure or guaranteed to be universally unique.
 * Replace with a more robust solution (like `uuid`) if necessary for production.
 * @param length The desired length of the ID. Defaults to 8.
 * @returns A pseudo-random string ID.
 */
export function generateId(length: number = 8): string {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const charactersLength = characters.length;
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
  }
  return result;
}
