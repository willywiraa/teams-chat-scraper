/**
 * Fast, synchronous, deterministic string hashing (non-cryptographic).
 * Two independent 53-bit cyrb53 hashes give ~106 bits, ample for de-duplication keys.
 */
export function cyrb53(input: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function stableHash(input: string): string {
  return (
    cyrb53(input, 0).toString(16).padStart(14, '0') +
    cyrb53(input, 0x9e3779b9).toString(16).padStart(14, '0')
  );
}

/** Normalises text for hashing so insignificant whitespace differences do not matter. */
export function normalizeForHash(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** Joins hash inputs with a separator that cannot appear in normalised text. */
export function hashParts(parts: Array<string | number | boolean | null | undefined>): string {
  return stableHash(parts.map((part) => (part === null || part === undefined ? '' : String(part))).join('\u001f'));
}
