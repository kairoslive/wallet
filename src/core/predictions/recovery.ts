import { encodeFunctionData, erc20Abi, getAddress, parseAbi, type Hex } from 'viem';
import { publicClient } from '../evm/client';
import type { EvmNetwork } from '../types';

/**
 * Recovery for tokens sent to a trading (deposit) wallet that trading can't use, e.g. plain USDC
 * instead of pUSD. Only pUSD counts as trading balance, and converting inside the wallet requires
 * the venue's relayer. The deposit wallet's owner can always exit through its pause timelock:
 * pause → wait the factory's timelock → withdrawERC20 to the owner → unpause.
 */

export const DEPOSIT_WALLET_ABI = parseAbi([
  'function owner() view returns (address)',
  'function paused() view returns (uint256)',
  'function factory() view returns (address)',
  'function pause()',
  'function unpause()',
  'function withdrawERC20(address token, address to, uint256 amount)',
]);

const FACTORY_ABI = parseAbi(['function timelockDelay() view returns (uint256)']);

/** Polygon tokens people commonly send by mistake. pUSD itself is never "stray". */
export const STRAY_TOKENS = [
  { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', symbol: 'USDC', decimals: 6 },
  { address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', symbol: 'USDC.e', decimals: 6 },
  { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', symbol: 'USDT', decimals: 6 },
] as const;

export interface StrayBalance {
  address: string;
  symbol: string;
  decimals: number;
  /** Base units. */
  amount: string;
}

export interface RecoveryState {
  tradingWallet: string;
  owner: string;
  stray: StrayBalance[];
  /** Unix seconds when the wallet was paused, or 0. */
  pausedAt: number;
  timelockSeconds: number;
  /** Unix seconds when withdrawals unlock (pausedAt + timelock), or 0 if not paused. */
  unlocksAt: number;
  /** What the owner should do next. */
  next: 'none' | 'pause' | 'wait' | 'withdraw' | 'unpause';
}

export async function getRecoveryState(network: EvmNetwork, tradingWallet: string): Promise<RecoveryState> {
  const client = publicClient(network);
  const wallet = getAddress(tradingWallet);
  const [owner, pausedAt, factory, block, balances] = await Promise.all([
    client.readContract({ address: wallet, abi: DEPOSIT_WALLET_ABI, functionName: 'owner' }),
    client.readContract({ address: wallet, abi: DEPOSIT_WALLET_ABI, functionName: 'paused' }),
    client.readContract({ address: wallet, abi: DEPOSIT_WALLET_ABI, functionName: 'factory' }),
    // The timelock is enforced against block time, not the local clock.
    client.getBlock({ blockTag: 'latest' }),
    Promise.all(
      STRAY_TOKENS.map((t) =>
        client.readContract({ address: t.address, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] }).catch(() => 0n),
      ),
    ),
  ]);
  const timelockSeconds = Number(
    await client.readContract({ address: factory, abi: FACTORY_ABI, functionName: 'timelockDelay' }),
  );
  const stray = STRAY_TOKENS.map((t, i) => ({ ...t, amount: balances[i].toString() })).filter((t) => t.amount !== '0');
  const paused = Number(pausedAt);
  const unlocksAt = paused ? paused + timelockSeconds : 0;
  // The contract requires block.timestamp > pausedAt + delay.
  const unlocked = paused !== 0 && Number(block.timestamp) > unlocksAt;
  let next: RecoveryState['next'] = 'none';
  if (stray.length) next = !paused ? 'pause' : unlocked ? 'withdraw' : 'wait';
  else if (paused) next = unlocked ? 'unpause' : 'wait';
  return { tradingWallet: wallet, owner, stray, pausedAt: paused, timelockSeconds, unlocksAt, next };
}

export const encodePause = (): Hex => encodeFunctionData({ abi: DEPOSIT_WALLET_ABI, functionName: 'pause' });
export const encodeUnpause = (): Hex => encodeFunctionData({ abi: DEPOSIT_WALLET_ABI, functionName: 'unpause' });
export const encodeWithdraw = (token: string, to: string, amount: bigint): Hex =>
  encodeFunctionData({
    abi: DEPOSIT_WALLET_ABI,
    functionName: 'withdrawERC20',
    args: [getAddress(token), getAddress(to), amount],
  });
