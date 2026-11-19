/** Random identifier for sessions. Uses crypto.randomUUID where available. */
export function newId(): string {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') return cryptoObj.randomUUID();
  const random = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
  return `${random()}-${random().slice(0, 4)}-${random().slice(0, 4)}-${random().slice(0, 4)}-${random()}${random().slice(0, 4)}`;
}
