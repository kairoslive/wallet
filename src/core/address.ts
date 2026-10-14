import { getAddress, isAddress } from 'viem';
import { PublicKey } from '@solana/web3.js';
import type { ChainType } from './types';

export function isValidEvmAddress(a: string): boolean {
  return isAddress(a.trim(), { strict: false });
}

export function isValidSolanaAddress(a: string): boolean {
  try {
    const s = a.trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
    return new PublicKey(s).toBytes().length === 32;
  } catch {
    return false;
  }
}

export function isValidAddress(chain: ChainType, a: string): boolean {
  return chain === 'evm' ? isValidEvmAddress(a) : isValidSolanaAddress(a);
}

export function normalizeAddress(chain: ChainType, a: string): string {
  return chain === 'evm' ? getAddress(a.trim()) : new PublicKey(a.trim()).toBase58();
}

export function sameAddress(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  return a.startsWith('0x') ? a.toLowerCase() === b.toLowerCase() : a === b;
}
