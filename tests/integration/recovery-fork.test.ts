import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublicClient, erc20Abi, http, keccak256, pad, parseEther, toHex, toBytes } from 'viem';
import { WalletService } from '../../src/core/wallet/service';
import { MemoryStore } from '../../src/core/storage';
import { startAnvil, ANVIL_MNEMONIC, type AnvilInstance } from '../helpers/anvil';
import type { EvmNetwork } from '../../src/core/types';

/**
 * Recovery against the real Polymarket DepositWallet contract on a Polygon mainnet fork.
 * Opt-in (needs the internet): RECOVERY_FORK=1 pnpm test:integration
 */
const TRADING_WALLET = '0xe8206a62c75d1688166489b6006cedb4e86981cd';
const USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const EOA = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
// Ownable slot used by DepositWallet: keccak256("DepositWallet.owner") - 1.
const OWNER_SLOT = toHex(BigInt(keccak256(toBytes('DepositWallet.owner'))) - 1n, { size: 32 });

describe.skipIf(!process.env.RECOVERY_FORK)('trading wallet recovery (Polygon fork)', () => {
  let anvil: AnvilInstance;
  let service: WalletService;
  let accountId: string;

  beforeAll(async () => {
    anvil = await startAnvil({
      chainId: 137,
      args: ['--fork-url', process.env.POLYGON_RPC ?? 'https://polygon-bor-rpc.publicnode.com'],
      timeoutMs: 60_000,
    });
    // Make the test key the wallet's owner on the fork, and give it gas.
    await anvil.rpc('anvil_setStorageAt', [TRADING_WALLET, OWNER_SLOT, pad(EOA, { size: 32 })]);
    const fetchFn = (async (url: string) => {
      if (String(url).includes('/v3/wallets/')) {
        return new Response(
          JSON.stringify({ wallet: EOA, tradingWallet: TRADING_WALLET, ready: true, balance: '0', next: 'fund' }),
        );
      }
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch;
    service = new WalletService({ store: new MemoryStore(), session: new MemoryStore(), pbkdf2Iterations: 1000, fetchFn });
    await service.createWallet({ password: 'password123', mnemonic: ANVIL_MNEMONIC });
    const polygon = (await service.getSettings()).networks.find((n) => n.id === 'polygon') as EvmNetwork;
    await service.upsertNetwork({ ...polygon, rpcUrl: anvil.rpcUrl, history: { kind: 'none' } });
    accountId = (await service.getState()).accounts[0].id;
  }, 120_000);

  afterAll(async () => anvil?.stop());

  it('pauses, waits out the timelock, withdraws the USDC and resumes the wallet', async () => {
    const client = createPublicClient({ transport: http(anvil.rpcUrl) });
    const usdcIn = await client.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [TRADING_WALLET] });
    expect(usdcIn).toBeGreaterThan(0n);

    let state = await service.predictionRecoveryState(accountId);
    expect(state.next).toBe('pause');
    expect(state.stray).toEqual([expect.objectContaining({ symbol: 'USDC', amount: usdcIn.toString() })]);

    // No POL yet: the wallet reports exactly what's missing instead of failing mid-transaction.
    await anvil.rpc('anvil_setBalance', [EOA, '0x0']);
    const gas = await service.predictionRecoveryGas(accountId);
    expect(BigInt(gas.have)).toBe(0n);
    expect(BigInt(gas.needed)).toBeGreaterThan(0n);
    expect(BigInt(gas.needed)).toBeLessThan(parseEther('0.5'));
    await expect(service.predictionRecoveryStep(accountId)).rejects.toThrow(/needs about .* POL/);

    await anvil.rpc('anvil_setBalance', [EOA, toHex(parseEther('1'))]);
    state = await service.predictionRecoveryStep(accountId);
    expect(state.next).toBe('wait');
    await expect(service.predictionRecoveryStep(accountId)).rejects.toThrow('Withdrawals unlock');

    await anvil.rpc('evm_increaseTime', [state.timelockSeconds + 1]);
    await anvil.rpc('evm_mine', []);
    state = await service.predictionRecoveryState(accountId);
    expect(state.next).toBe('withdraw');

    state = await service.predictionRecoveryStep(accountId);
    expect(state.next).toBe('none');
    expect(state.pausedAt).toBe(0);
    expect(await client.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [TRADING_WALLET] })).toBe(
      0n,
    );
    expect(await client.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [EOA] })).toBe(usdcIn);
  }, 180_000);
});
