// Some Solana dependencies expect a global Buffer.
import { Buffer } from 'buffer';
if (typeof globalThis.Buffer === 'undefined') globalThis.Buffer = Buffer;
export { Buffer };
