import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, SystemProgram, type ParsedTransactionWithMeta } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { summarizeSolanaTx } from '../../src/core/history/solana';
import { DEFAULT_NETWORKS } from '../../src/core/networks';
import type { SolanaNetwork, TxRecord } from '../../src/core/types';

const solana = DEFAULT_NETWORKS.find((n) => n.id === 'solana') as SolanaNetwork;
const pk = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey;

const OWNER = pk(1);
const BOB = pk(2);
const POOL = pk(3);
const OWNER_ATA = pk(4);
const BOB_ATA = pk(5);
const OWNER_JUP_ATA = pk(6);
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const SYMBOLS: Record<string, string> = { [USDC]: 'USDC', [JUP]: 'JUP' };
const symbolFor = (mint: string) => SYMBOLS[mint];

const SIG = '5'.repeat(88);
const BLOCK_TIME = 1_714_564_800;
const FEE = 5000;

interface TokenBal {
  accountIndex: number;
  mint: string;
  owner: string;
  amount: string;
  decimals: number;
}

function tokenBalance(b: TokenBal) {
  return {
    accountIndex: b.accountIndex,
    mint: b.mint,
    owner: b.owner,
    programId: TOKEN_PROGRAM_ID.toBase58(),
    uiTokenAmount: {
      amount: b.amount,
      decimals: b.decimals,
      uiAmount: Number(b.amount) / 10 ** b.decimals,
      uiAmountString: String(Number(b.amount) / 10 ** b.decimals),
    },
  };
}

/** Builds a minimal jsonParsed transaction. The first key is the fee payer. */
function parsedTx(opts: {
  keys: PublicKey[];
  pre: number[];
  post: number[];
  preToken?: TokenBal[];
  postToken?: TokenBal[];
  err?: unknown;
  fee?: number;
  noMeta?: boolean;
  blockTime?: number | null;
}): ParsedTransactionWithMeta {
  return {
    slot: 250_000_000,
    blockTime: opts.blockTime === undefined ? BLOCK_TIME : opts.blockTime,
    version: 0,
    transaction: {
      signatures: [SIG],
      message: {
        accountKeys: opts.keys.map((pubkey, i) => ({ pubkey, signer: i === 0, writable: true, source: 'transaction' })),
        instructions: [],
        recentBlockhash: '11111111111111111111111111111111',
      },
    },
    meta: opts.noMeta
      ? null
      : {
          err: opts.err ?? null,
          fee: opts.fee ?? FEE,
          preBalances: opts.pre,
          postBalances: opts.post,
          preTokenBalances: (opts.preToken ?? []).map(tokenBalance),
          postTokenBalances: (opts.postToken ?? []).map(tokenBalance),
          innerInstructions: [],
          logMessages: [],
        },
  } as unknown as ParsedTransactionWithMeta;
}

const summarize = (tx: ParsedTransactionWithMeta, owner = OWNER) =>
  summarizeSolanaTx(solana, owner.toBase58(), SIG, tx, symbolFor);

describe('summarizeSolanaTx', () => {
  it('SOL send: amount excludes the fee paid by the owner', () => {
    const tx = parsedTx({
      keys: [OWNER, BOB, SystemProgram.programId],
      pre: [10_000_000_000, 1_000_000_000, 1],
      post: [10_000_000_000 - 1_500_000_000 - FEE, 2_500_000_000, 1],
    });
    expect(summarize(tx)).toEqual<TxRecord>({
      hash: SIG,
      networkId: 'solana',
      chainType: 'solana',
      from: OWNER.toBase58(),
      to: BOB.toBase58(),
      title: 'Sent 1.5 SOL',
      direction: 'out',
      kind: 'send',
      amount: '1.5',
      symbol: 'SOL',
      timestamp: BLOCK_TIME * 1000,
      status: 'confirmed',
      fee: String(FEE),
      source: 'indexer',
    });
  });

  it('SOL send with a priority fee still reports the exact transfer amount', () => {
    const fee = 5000 + 123_456;
    const tx = parsedTx({
      keys: [OWNER, BOB, SystemProgram.programId],
      pre: [2_000_000_000, 0, 1],
      post: [2_000_000_000 - 1 - fee, 1, 1],
      fee,
    });
    const r = summarize(tx);
    expect(r).toMatchObject({ title: 'Sent 0.000000001 SOL', amount: '0.000000001', fee: String(fee), to: BOB.toBase58() });
  });

  it('SOL receive: counterparty is the sender, no fee attributed to owner', () => {
    const tx = parsedTx({
      keys: [BOB, OWNER, SystemProgram.programId],
      pre: [5_000_000_000, 0, 1],
      post: [5_000_000_000 - 250_000_000 - FEE, 250_000_000, 1],
    });
    const r = summarize(tx);
    expect(r).toMatchObject({
      title: 'Received 0.25 SOL',
      direction: 'in',
      kind: 'receive',
      amount: '0.25',
      symbol: 'SOL',
      from: BOB.toBase58(),
      to: OWNER.toBase58(),
      status: 'confirmed',
    });
    expect(r.fee).toBeUndefined();
  });

  it('SPL receive (sender pays ATA rent): reports the token, not SOL', () => {
    const RENT = 2_039_280;
    const tx = parsedTx({
      // Sender is fee payer and creates the owner's ATA; the owner's wallet SOL balance is unchanged.
      keys: [BOB, BOB_ATA, OWNER_ATA, OWNER, new PublicKey(USDC), TOKEN_PROGRAM_ID],
      pre: [1_000_000_000, RENT, 0, 500_000_000, 1, 1],
      post: [1_000_000_000 - RENT - FEE, RENT, RENT, 500_000_000, 1, 1],
      preToken: [{ accountIndex: 1, mint: USDC, owner: BOB.toBase58(), amount: '100000000', decimals: 6 }],
      postToken: [
        { accountIndex: 1, mint: USDC, owner: BOB.toBase58(), amount: '90000000', decimals: 6 },
        { accountIndex: 2, mint: USDC, owner: OWNER.toBase58(), amount: '10000000', decimals: 6 },
      ],
    });
    const r = summarize(tx);
    expect(r).toMatchObject({
      title: 'Received 10 USDC',
      direction: 'in',
      kind: 'receive',
      amount: '10',
      symbol: 'USDC',
      from: BOB.toBase58(),
      to: OWNER.toBase58(),
    });
    expect(r.fee).toBeUndefined();
  });

  it('SPL receive into an existing account, unknown mint symbol falls back to a short mint', () => {
    const MINT = pk(9).toBase58();
    const tx = parsedTx({
      keys: [BOB, BOB_ATA, OWNER_ATA],
      pre: [1_000_000_000, 1, 1],
      post: [1_000_000_000 - FEE, 1, 1],
      preToken: [
        { accountIndex: 1, mint: MINT, owner: BOB.toBase58(), amount: '5', decimals: 0 },
        { accountIndex: 2, mint: MINT, owner: OWNER.toBase58(), amount: '1', decimals: 0 },
      ],
      postToken: [
        { accountIndex: 1, mint: MINT, owner: BOB.toBase58(), amount: '2', decimals: 0 },
        { accountIndex: 2, mint: MINT, owner: OWNER.toBase58(), amount: '4', decimals: 0 },
      ],
    });
    // The owner's wallet isn't in the account keys at all; token balances still identify it.
    const r = summarize(tx);
    expect(r).toMatchObject({ title: `Received 3 ${MINT.slice(0, 4)}…`, kind: 'receive', amount: '3' });
  });

  it('SPL send', () => {
    const tx = parsedTx({
      keys: [OWNER, OWNER_ATA, BOB_ATA],
      pre: [1_000_000_000, 1, 1],
      post: [1_000_000_000 - FEE, 1, 1],
      preToken: [
        { accountIndex: 1, mint: USDC, owner: OWNER.toBase58(), amount: '7500000', decimals: 6 },
        { accountIndex: 2, mint: USDC, owner: BOB.toBase58(), amount: '0', decimals: 6 },
      ],
      postToken: [
        { accountIndex: 1, mint: USDC, owner: OWNER.toBase58(), amount: '2500000', decimals: 6 },
        { accountIndex: 2, mint: USDC, owner: BOB.toBase58(), amount: '5000000', decimals: 6 },
      ],
    });
    expect(summarize(tx)).toMatchObject({
      title: 'Sent 5 USDC',
      kind: 'send',
      direction: 'out',
      amount: '5',
      symbol: 'USDC',
      fee: String(FEE),
    });
  });

  it('swap: SOL out, token in', () => {
    const tx = parsedTx({
      keys: [OWNER, OWNER_ATA, POOL, new PublicKey(USDC)],
      pre: [5_000_000_000, 2_039_280, 900_000_000_000, 1],
      post: [5_000_000_000 - 1_000_000_000 - FEE, 2_039_280, 901_000_000_000, 1],
      preToken: [{ accountIndex: 1, mint: USDC, owner: OWNER.toBase58(), amount: '0', decimals: 6 }],
      postToken: [{ accountIndex: 1, mint: USDC, owner: OWNER.toBase58(), amount: '150250000', decimals: 6 }],
    });
    expect(summarize(tx)).toMatchObject({
      title: 'Swapped 1 SOL → 150.25 USDC',
      kind: 'swap',
      direction: 'out',
      amount: '1',
      symbol: 'SOL',
      from: OWNER.toBase58(),
      to: POOL.toBase58(),
      fee: String(FEE),
    });
  });

  it('swap: token → token ignores small SOL rent movements', () => {
    const RENT = 2_039_280;
    const tx = parsedTx({
      keys: [OWNER, OWNER_ATA, OWNER_JUP_ATA, POOL],
      pre: [1_000_000_000, RENT, 0, 1],
      post: [1_000_000_000 - RENT - FEE, RENT, RENT, 1],
      preToken: [{ accountIndex: 1, mint: USDC, owner: OWNER.toBase58(), amount: '10000000', decimals: 6 }],
      postToken: [
        { accountIndex: 1, mint: USDC, owner: OWNER.toBase58(), amount: '0', decimals: 6 },
        { accountIndex: 2, mint: JUP, owner: OWNER.toBase58(), amount: '20000000', decimals: 6 },
      ],
    });
    expect(summarize(tx)).toMatchObject({ title: 'Swapped 10 USDC → 20 JUP', kind: 'swap', amount: '10', symbol: 'USDC' });
  });

  it('failed tx: only the fee moved, status failed', () => {
    const tx = parsedTx({
      keys: [OWNER, BOB, SystemProgram.programId],
      pre: [1_000_000_000, 0, 1],
      post: [1_000_000_000 - FEE, 0, 1],
      err: { InstructionError: [0, { Custom: 1 }] },
    });
    const r = summarize(tx);
    expect(r).toMatchObject({
      title: 'Transaction',
      kind: 'contract',
      direction: 'contract',
      status: 'failed',
      fee: String(FEE),
      from: OWNER.toBase58(),
    });
    expect(r.amount).toBeUndefined();
    expect(r.symbol).toBeUndefined();
  });

  it('missing meta and blockTime degrade gracefully', () => {
    const tx = parsedTx({ keys: [OWNER, BOB], pre: [], post: [], noMeta: true, blockTime: null });
    const r = summarize(tx);
    expect(r).toMatchObject({ title: 'Transaction', kind: 'contract', status: 'confirmed', timestamp: 0, amount: undefined });
    expect(r.fee).toBe('0');
  });

  it('uses the network symbol (devnet)', () => {
    const devnet = DEFAULT_NETWORKS.find((n) => n.id === 'solana-devnet') as SolanaNetwork;
    const tx = parsedTx({ keys: [BOB, OWNER], pre: [2_000_000_000, 0], post: [1_000_000_000 - FEE, 1_000_000_000] });
    const r = summarizeSolanaTx(devnet, OWNER.toBase58(), SIG, tx);
    expect(r).toMatchObject({ networkId: 'solana-devnet', title: 'Received 1 SOL' });
  });
});
