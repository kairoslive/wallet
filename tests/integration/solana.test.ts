import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';
import { WalletService } from '../../src/core/wallet/service';
import { MemoryStore } from '../../src/core/storage';
import { getSplHoldings } from '../../src/core/solana/client';
import type { Account, SolanaNetwork, Token } from '../../src/core/types';
import { startSolanaShim, type SolanaShim } from '../helpers/solana-rpc-shim';

const MNEMONIC = 'test test test test test test test test test test test junk';
const PASSWORD = 'correct horse battery';
const NET_ID = 'sol-local';
const LAMPORTS = 1_000_000_000n;
const SIG_FEE = 5000n;

describe('Solana integration (LiteSVM RPC shim)', () => {
  let shim: SolanaShim;
  let service: WalletService;
  let network: SolanaNetwork;
  let a: Account;
  let b: Account;
  let mint: PublicKey;
  const unexpectedFetches: string[] = [];

  const sol: Token = { networkId: NET_ID, address: 'native', symbol: 'SOL', name: 'Solana', decimals: 9 };

  beforeAll(async () => {
    shim = await startSolanaShim();
    service = new WalletService({
      store: new MemoryStore(),
      session: new MemoryStore(),
      pbkdf2Iterations: 1000,
      // Any HTTP call other than the RPC (prices, token metadata) must not reach the internet.
      fetchFn: async (input) => {
        unexpectedFetches.push(String(input instanceof Request ? input.url : input));
        throw new Error('network disabled in tests');
      },
    });
    await service.createWallet({ password: PASSWORD, mnemonic: MNEMONIC });
    for (const n of (await service.getSettings()).networks) await service.upsertNetwork({ ...n, enabled: false });
    network = {
      type: 'solana',
      id: NET_ID,
      name: 'Local Solana',
      cluster: 'custom',
      rpcUrl: shim.rpcUrl,
      explorerUrl: '',
      nativeCurrency: { name: 'Solana', symbol: 'SOL', decimals: 9 },
      testnet: true,
      enabled: true,
    };
    await service.upsertNetwork(network);
    await service.updateSettings({ showTestnets: true });
    const state = await service.getState();
    a = state.accounts[0];
    b = await service.addAccount({ seedId: state.seeds[0].id });
  });

  afterAll(async () => {
    await shim?.stop();
  });

  it('shows an airdropped SOL balance in the portfolio', async () => {
    shim.airdrop(a.solanaAddress!, 5n * LAMPORTS);
    const p = await service.getPortfolio(a.id);
    expect(p.errors).toEqual({});
    const native = p.balances.find((x) => x.networkId === NET_ID && x.address === 'native');
    expect(native?.balance).toBe((5n * LAMPORTS).toString());
    expect(native?.symbol).toBe('SOL');
    // B has no SOL yet.
    const pb = await service.getPortfolio(b.id, [NET_ID]);
    expect(pb.balances.find((x) => x.address === 'native')?.balance).toBe('0');
  });

  it('previews native sends (fee, low-amount warning, insufficient funds)', async () => {
    const preview = await service.previewSend({ accountId: a.id, networkId: NET_ID, token: sol, to: b.solanaAddress!, amount: '0.0001' });
    expect(preview.fee).toBe(SIG_FEE.toString());
    expect(preview.feeSymbol).toBe('SOL');
    expect(preview.extra).toBeUndefined();
    expect(preview.warnings.some((w) => w.includes('rent minimum'))).toBe(true);

    await expect(
      service.previewSend({ accountId: a.id, networkId: NET_ID, token: sol, to: b.solanaAddress!, amount: '6' }),
    ).rejects.toThrow('Insufficient SOL balance');
    await expect(
      service.previewSend({ accountId: a.id, networkId: NET_ID, token: sol, to: b.solanaAddress!, amount: '5' }),
    ).rejects.toThrow('Insufficient SOL to cover the network fee');
  });

  it('sends SOL between two accounts of the same seed and confirms the signature', async () => {
    const beforeA = shim.getBalance(a.solanaAddress!);
    const beforeB = shim.getBalance(b.solanaAddress!);
    const ok = await service.previewSend({ accountId: a.id, networkId: NET_ID, token: sol, to: b.solanaAddress!, amount: '1.5' });
    expect(ok.warnings).toEqual([]);

    const rec = await service.send({ accountId: a.id, networkId: NET_ID, token: sol, to: b.solanaAddress!, amount: '1.5' });
    expect(rec.status).toBe('pending');
    expect(rec.chainType).toBe('solana');
    expect(rec.title).toBe('Sent 1.5 SOL');
    expect(shim.signatureStatus(rec.hash)).toEqual({ slot: expect.any(Number), err: null });

    expect(await service.waitForTx(NET_ID, rec.hash)).toBe('confirmed');
    const stored = (await service.getLocalTxs()).find((t) => t.hash === rec.hash);
    expect(stored?.status).toBe('confirmed');

    expect(shim.getBalance(a.solanaAddress!)).toBe(beforeA - 1_500_000_000n - SIG_FEE);
    expect(shim.getBalance(b.solanaAddress!)).toBe(beforeB + 1_500_000_000n);
    expect(await service.getBalance(b.id, NET_ID, sol)).toBe(beforeB + 1_500_000_000n);
  });

  it('maxSendable reserves the signature fee', async () => {
    const bal = shim.getBalance(b.solanaAddress!);
    const max = await service.maxSendable(b.id, NET_ID, sol);
    expect(max).toBe(formatLamports(bal - SIG_FEE));
  });

  it('sends an SPL token to an account without an ATA (rent extra, ATA created)', async () => {
    mint = await shim.createMint(6);
    await shim.mintTo(mint, a.solanaAddress!, 1_000_000_000n); // 1000 tokens
    const token: Token = { networkId: NET_ID, address: mint.toBase58(), symbol: 'TST', name: 'Test', decimals: 6 };

    // lookupToken reads decimals from the mint; metadata API is unavailable so it falls back.
    const looked = await service.lookupToken(NET_ID, mint.toBase58());
    expect(looked.decimals).toBe(6);
    expect(looked.address).toBe(mint.toBase58());
    await service.addCustomToken(looked);

    const holdingsA = await getSplHoldings(network, a.solanaAddress!);
    expect(holdingsA).toEqual([{ mint: mint.toBase58(), amount: 1_000_000_000n, decimals: 6, programId: TOKEN_PROGRAM_ID.toBase58() }]);

    const bAta = getAssociatedTokenAddressSync(mint, new PublicKey(b.solanaAddress!), true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    expect(shim.svm.getAccount(bAta.toBase58() as never).exists).toBe(false);

    const rent = shim.svm.minimumBalanceForRentExemption(165n);
    const preview = await service.previewSend({ accountId: a.id, networkId: NET_ID, token, to: b.solanaAddress!, amount: '12.5' });
    expect(preview.extra).toEqual({ amount: rent.toString(), label: 'Recipient token account rent' });
    expect(preview.fee).toBe(SIG_FEE.toString());

    const solBefore = shim.getBalance(a.solanaAddress!);
    const rec = await service.send({ accountId: a.id, networkId: NET_ID, token, to: b.solanaAddress!, amount: '12.5' });
    expect(await service.waitForTx(NET_ID, rec.hash)).toBe('confirmed');
    expect(rec.title).toBe('Sent 12.5 TST');

    expect(shim.svm.getAccount(bAta.toBase58() as never).exists).toBe(true);
    expect(shim.getBalance(a.solanaAddress!)).toBe(solBefore - rent - SIG_FEE);

    const holdingsB = await getSplHoldings(network, b.solanaAddress!);
    expect(holdingsB).toEqual([{ mint: mint.toBase58(), amount: 12_500_000n, decimals: 6, programId: TOKEN_PROGRAM_ID.toBase58() }]);
    expect(await service.getBalance(a.id, NET_ID, token)).toBe(1_000_000_000n - 12_500_000n);

    // Second send: ATA exists now, so no rent.
    const preview2 = await service.previewSend({ accountId: a.id, networkId: NET_ID, token, to: b.solanaAddress!, amount: '1' });
    expect(preview2.extra).toBeUndefined();

    // Portfolio lists the custom token with its balance.
    const p = await service.getPortfolio(b.id, [NET_ID]);
    const tb = p.balances.find((x) => x.address === mint.toBase58());
    expect(tb?.balance).toBe('12500000');
    expect(tb?.decimals).toBe(6);
  });

  it('rejects a token send larger than the balance', async () => {
    const token: Token = { networkId: NET_ID, address: mint.toBase58(), symbol: 'TST', name: 'Test', decimals: 6 };
    await expect(
      service.previewSend({ accountId: b.id, networkId: NET_ID, token, to: a.solanaAddress!, amount: '13' }),
    ).rejects.toThrow('Insufficient TST balance');
  });

  it('refreshPending confirms pending local records', async () => {
    const rec = await service.send({ accountId: b.id, networkId: NET_ID, token: sol, to: a.solanaAddress!, amount: '0.01' });
    expect((await service.getLocalTxs()).find((t) => t.hash === rec.hash)?.status).toBe('pending');
    await service.refreshPending();
    expect((await service.getLocalTxs()).find((t) => t.hash === rec.hash)?.status).toBe('confirmed');
  });

  it('solanaSigner.signMessage produces a valid ed25519 signature', async () => {
    const signer = await service.solanaSigner(a.id);
    expect(signer.address).toBe(a.solanaAddress);
    expect(signer.keypair.publicKey.toBase58()).toBe(a.solanaAddress);
    const msg = new TextEncoder().encode('Sign in to example.com');
    const sig = signer.signMessage(msg);
    expect(sig.length).toBe(64);
    expect(ed25519.verify(sig, msg, bs58.decode(a.solanaAddress!))).toBe(true);
    expect(ed25519.verify(sig, new TextEncoder().encode('tampered'), bs58.decode(a.solanaAddress!))).toBe(false);
  });

  it('an imported Solana private-key account can send', async () => {
    const kp = Keypair.generate();
    const imported = await service.importPrivateKey({ chainType: 'solana', privateKey: bs58.encode(kp.secretKey) });
    expect(imported.solanaAddress).toBe(kp.publicKey.toBase58());
    expect(imported.evmAddress).toBeUndefined();
    shim.airdrop(kp.publicKey, 2n * LAMPORTS);

    const before = shim.getBalance(a.solanaAddress!);
    const rec = await service.send({ accountId: imported.id, networkId: NET_ID, token: sol, to: a.solanaAddress!, amount: '0.5' });
    expect(await service.waitForTx(NET_ID, rec.hash)).toBe('confirmed');
    expect(shim.getBalance(a.solanaAddress!)).toBe(before + 500_000_000n);
    expect(shim.getBalance(kp.publicKey)).toBe(2n * LAMPORTS - 500_000_000n - SIG_FEE);

    // An imported Solana-only account has no EVM address; the EVM side is unavailable.
    await expect(service.evmSigner(imported.id)).rejects.toThrow('This account has no EVM key');
  });

  it('surfaces RPC send errors', async () => {
    const kp = Keypair.generate();
    const imported = await service.importPrivateKey({ chainType: 'solana', privateKey: bs58.encode(kp.secretKey) });
    // Unfunded fee payer: the shim's preflight rejects the transaction.
    await expect(
      service.send({ accountId: imported.id, networkId: NET_ID, token: sol, to: a.solanaAddress!, amount: '0.1' }),
    ).rejects.toThrow(/simulation failed/i);
    expect((await service.getLocalTxs()).some((t) => t.from === kp.publicKey.toBase58())).toBe(false);
  });

  it('did not attempt any non-RPC network access besides cosmetic metadata lookups', () => {
    // Only Jupiter token-metadata lookups (which are best-effort) may have been attempted.
    for (const url of unexpectedFetches) expect(url).toMatch(/jup\.ag/);
  });
});

function formatLamports(v: bigint): string {
  const s = v.toString().padStart(10, '0');
  const whole = s.slice(0, -9);
  const frac = s.slice(-9).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}
