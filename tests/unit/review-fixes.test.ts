import { describe, expect, it } from 'vitest';
import { encodeFunctionData, erc20Abi, maxUint256 } from 'viem';
import { Keypair, SystemProgram, TransactionMessage } from '@solana/web3.js';
import { base64 } from '@scure/base';
import bs58 from 'bs58';
import { WalletService } from '../../src/core/wallet/service';
import { MemoryStore } from '../../src/core/storage';
import { DappController, decodeTokenCall, looksLikeSolanaTxMessage } from '../../src/core/dapp/controller';
import { ProviderError, type Approver } from '../../src/core/dapp/types';

const MNEMONIC = 'test test test test test test test test test test test junk';
const PW = 'password123';
const ORIGIN = 'https://site.example';

async function make() {
  const store = new MemoryStore();
  const session = new MemoryStore();
  const service = new WalletService({
    store,
    session,
    pbkdf2Iterations: 1000,
    fetchFn: async () => {
      throw new Error('offline');
    },
  });
  await service.createWallet({ password: PW, mnemonic: MNEMONIC });
  return { service, store, session };
}

const approveAll: Approver = { request: async () => ({ approved: true }) };

describe('session safety', () => {
  it('a lock during session restore keeps the wallet locked', async () => {
    const { store, session } = await make();
    const fresh = new WalletService({ store, session, pbkdf2Iterations: 1000 });
    const restoring = fresh.restoreSession();
    await fresh.lock();
    expect(await restoring).toBe(false);
    expect(fresh.isUnlocked()).toBe(false);
  });

  it('changing the password while locked does not unlock', async () => {
    const { service } = await make();
    await service.lock();
    await service.changePassword(PW, 'another password');
    expect(service.isUnlocked()).toBe(false);
    await service.unlock('another password');
    expect(service.isUnlocked()).toBe(true);
  });
});

describe('dApp hardening', () => {
  it('keeps EVM and Solana connections separate', async () => {
    const { service } = await make();
    const dapp = new DappController(service, approveAll);
    await dapp.handle(ORIGIN, { chain: 'evm', method: 'eth_requestAccounts' });
    expect(await dapp.solanaAccounts(ORIGIN)).toEqual([]);
    await expect(
      dapp.handle(ORIGIN, { chain: 'solana', method: 'connect', params: { onlyIfTrusted: true } }),
    ).rejects.toBeInstanceOf(ProviderError);
    await dapp.handle(ORIGIN, { chain: 'solana', method: 'connect', params: {} });
    expect(await dapp.solanaAccounts(ORIGIN)).toHaveLength(1);
    expect(await dapp.evmAccounts(ORIGIN)).toHaveLength(1);
  });

  it('a chain switch after revoking does not reconnect the site', async () => {
    const { service } = await make();
    const dapp = new DappController(service, approveAll);
    await dapp.handle(ORIGIN, { chain: 'evm', method: 'eth_requestAccounts' });
    await service.revokePermission(ORIGIN);
    await dapp.handle(ORIGIN, { chain: 'evm', method: 'wallet_switchEthereumChain', params: [{ chainId: '0x2105' }] });
    expect(await service.getPermission(ORIGIN)).toBeUndefined();
  });

  it('refuses to sign a Solana transaction message passed to signMessage', async () => {
    const { service } = await make();
    const dapp = new DappController(service, approveAll);
    const { accounts } = (await dapp.handle(ORIGIN, { chain: 'solana', method: 'connect', params: {} })) as {
      accounts: string[];
    };
    const payer = Keypair.generate().publicKey;
    const msg = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: bs58.encode(new Uint8Array(32).fill(1)),
      instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1 })],
    });
    for (const bytes of [msg.compileToLegacyMessage().serialize(), msg.compileToV0Message().serialize()]) {
      expect(looksLikeSolanaTxMessage(bytes)).toBe(true);
      await expect(
        dapp.handle(ORIGIN, {
          chain: 'solana',
          method: 'signMessage',
          params: { address: accounts[0], message: base64.encode(bytes) },
        }),
      ).rejects.toMatchObject({ code: -32602 });
    }
    expect(looksLikeSolanaTxMessage(new TextEncoder().encode('Sign in to site.example'))).toBe(false);
  });

  it('rejects added chains whose native currency is not 18 decimals', async () => {
    const { service } = await make();
    const dapp = new DappController(service, approveAll);
    await expect(
      dapp.handle(ORIGIN, {
        chain: 'evm',
        method: 'wallet_addEthereumChain',
        params: [
          { chainId: '0x1234', rpcUrls: ['https://rpc.example'], nativeCurrency: { name: 'X', symbol: 'ETH', decimals: 30 } },
        ],
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it('decodes token approvals and flags unlimited ones', () => {
    const spender = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
    const unlimited = decodeTokenCall(
      encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, maxUint256] }),
    );
    expect(unlimited).toMatchObject({ fn: 'approve', target: spender, unlimited: true });
    const exact = decodeTokenCall(encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, 5n] }));
    expect(exact).toMatchObject({ amount: '5', unlimited: false });
    expect(decodeTokenCall(encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [spender, 7n] }))).toMatchObject({
      fn: 'transfer',
      amount: '7',
    });
    expect(decodeTokenCall('0x12345678')).toBeUndefined();
  });
});
