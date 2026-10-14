import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  unpackAccount,
  unpackMint,
} from '@solana/spl-token';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base64 } from '@scure/base';
import type { SolanaNetwork, Token } from '../types';

const connections = new Map<string, Connection>();

export function connection(n: SolanaNetwork): Connection {
  let c = connections.get(n.rpcUrl);
  if (!c) {
    c = new Connection(n.rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: false });
    connections.set(n.rpcUrl, c);
  }
  return c;
}

export async function getNativeBalance(n: SolanaNetwork, address: string): Promise<bigint> {
  return BigInt(await connection(n).getBalance(new PublicKey(address)));
}

export interface SplHolding {
  mint: string;
  amount: bigint;
  decimals: number;
  programId: string;
}

/** Lists all SPL / Token-2022 balances held by the owner, aggregated per mint. */
export async function getSplHoldings(n: SolanaNetwork, owner: string): Promise<SplHolding[]> {
  const conn = connection(n);
  const ownerPk = new PublicKey(owner);
  const programs = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
  const byMint = new Map<string, { amount: bigint; programId: PublicKey }>();
  await Promise.all(
    programs.map(async (programId) => {
      const res = await conn.getTokenAccountsByOwner(ownerPk, { programId });
      for (const { pubkey, account } of res.value) {
        const acc = unpackAccount(pubkey, account, programId);
        const key = acc.mint.toBase58();
        const prev = byMint.get(key);
        byMint.set(key, { amount: (prev?.amount ?? 0n) + acc.amount, programId });
      }
    }),
  );
  if (!byMint.size) return [];
  const mints = [...byMint.keys()];
  const infos = await conn.getMultipleAccountsInfo(mints.map((m) => new PublicKey(m)));
  return mints.map((mint, i) => {
    const entry = byMint.get(mint)!;
    const info = infos[i];
    const decimals = info ? unpackMint(new PublicKey(mint), info, info.owner).decimals : 0;
    return { mint, amount: entry.amount, decimals, programId: entry.programId.toBase58() };
  });
}

export async function getMintInfo(n: SolanaNetwork, mint: string): Promise<{ decimals: number; programId: PublicKey }> {
  const pk = new PublicKey(mint);
  const info = await connection(n).getAccountInfo(pk);
  if (!info) throw new Error('Mint account not found');
  if (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error('Address is not an SPL token mint');
  }
  return { decimals: unpackMint(pk, info, info.owner).decimals, programId: info.owner };
}

export const NATIVE_TRANSFER_CU = 1_000;
export const SPL_TRANSFER_CU = 20_000;
export const SPL_TRANSFER_WITH_ATA_CU = 80_000;

/** Priority fee in lamports for a given compute-unit price (micro-lamports) and limit. */
export function priorityFeeLamports(microLamports: number, units: number): bigint {
  return (BigInt(Math.ceil(microLamports)) * BigInt(units) + 999_999n) / 1_000_000n;
}

export interface SolanaTransferParams {
  from: string;
  to: string;
  token: Pick<Token, 'address'>;
  amount: bigint;
  /** Optional priority fee in micro-lamports per compute unit. */
  priorityMicroLamports?: number;
}

export interface BuiltSolanaTransfer {
  tx: VersionedTransaction;
  /** Extra lamports spent creating the recipient token account (rent), if any. */
  rentLamports: bigint;
}

export async function buildTransferTx(n: SolanaNetwork, p: SolanaTransferParams): Promise<BuiltSolanaTransfer> {
  const conn = connection(n);
  const from = new PublicKey(p.from);
  const to = new PublicKey(p.to);
  const ixs: TransactionInstruction[] = [];
  let rentLamports = 0n;
  let computeUnits = NATIVE_TRANSFER_CU;
  if (p.token.address === 'native') {
    ixs.push(SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: p.amount }));
  } else {
    const mint = new PublicKey(p.token.address);
    const { decimals, programId } = await getMintInfo(n, p.token.address);
    const fromAta = getAssociatedTokenAddressSync(mint, from, true, programId, ASSOCIATED_TOKEN_PROGRAM_ID);
    const toAta = getAssociatedTokenAddressSync(mint, to, true, programId, ASSOCIATED_TOKEN_PROGRAM_ID);
    const toInfo = await conn.getAccountInfo(toAta);
    if (!toInfo) {
      rentLamports = BigInt(await conn.getMinimumBalanceForRentExemption(programId.equals(TOKEN_PROGRAM_ID) ? 165 : 170));
      ixs.push(
        createAssociatedTokenAccountIdempotentInstruction(from, toAta, to, mint, programId, ASSOCIATED_TOKEN_PROGRAM_ID),
      );
    }
    ixs.push(createTransferCheckedInstruction(fromAta, mint, toAta, from, p.amount, decimals, [], programId));
    computeUnits = toInfo ? SPL_TRANSFER_CU : SPL_TRANSFER_WITH_ATA_CU;
  }
  // An explicit limit keeps priority fees proportional to the work actually done (default is 200k CU per instruction).
  const budget = [ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits })];
  if (p.priorityMicroLamports && p.priorityMicroLamports > 0) {
    budget.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: p.priorityMicroLamports }));
  }
  ixs.unshift(...budget);
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({ payerKey: from, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  return { tx: new VersionedTransaction(msg), rentLamports };
}

export async function estimateFee(n: SolanaNetwork, tx: VersionedTransaction): Promise<bigint> {
  const res = await connection(n).getFeeForMessage(tx.message, 'confirmed');
  return BigInt(res.value ?? 5000 * tx.message.header.numRequiredSignatures);
}

export async function getPriorityFee(n: SolanaNetwork): Promise<number> {
  try {
    const fees = await connection(n).getRecentPrioritizationFees();
    const vals = fees.map((f) => f.prioritizationFee).filter((f) => f > 0).sort((a, b) => a - b);
    if (!vals.length) return 0;
    // Median of recent non-zero fees, capped so a spike cannot drain funds.
    return Math.min(vals[Math.floor(vals.length / 2)], 1_000_000);
  } catch {
    return 0;
  }
}

export function keypairFromSecret(secret: Uint8Array): Keypair {
  return Keypair.fromSecretKey(secret);
}

/** Signs whatever transaction format the caller passed and returns it. */
export function signTx<T extends Transaction | VersionedTransaction>(tx: T, signer: Keypair): T {
  if (tx instanceof VersionedTransaction) tx.sign([signer]);
  else tx.partialSign(signer);
  return tx;
}

export function deserializeTx(bytes: Uint8Array): Transaction | VersionedTransaction {
  try {
    return VersionedTransaction.deserialize(bytes);
  } catch {
    return Transaction.from(bytes);
  }
}

export function serializeTx(tx: Transaction | VersionedTransaction): Uint8Array {
  return tx instanceof VersionedTransaction
    ? tx.serialize()
    : tx.serialize({ requireAllSignatures: false, verifySignatures: false });
}

export async function sendRawTx(n: SolanaNetwork, raw: Uint8Array): Promise<string> {
  return connection(n).sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 });
}

export async function signAndSend(n: SolanaNetwork, tx: Transaction | VersionedTransaction, signer: Keypair): Promise<string> {
  if (tx instanceof Transaction && !tx.recentBlockhash) {
    tx.recentBlockhash = (await connection(n).getLatestBlockhash('confirmed')).blockhash;
    tx.feePayer ??= signer.publicKey;
  }
  signTx(tx, signer);
  return sendRawTx(n, serializeTx(tx));
}

export async function getSignatureStatus(n: SolanaNetwork, sig: string): Promise<'pending' | 'confirmed' | 'failed'> {
  const res = await connection(n).getSignatureStatuses([sig], { searchTransactionHistory: true });
  const st = res.value[0];
  if (!st) return 'pending';
  if (st.err) return 'failed';
  return st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized' ? 'confirmed' : 'pending';
}

/** Polls signature status (avoids websocket subscriptions, which many public RPCs restrict). */
export async function waitForSignature(n: SolanaNetwork, sig: string, timeoutMs = 90_000, intervalMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = await getSignatureStatus(n, sig).catch(() => 'pending' as const);
    if (st !== 'pending') return st;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return 'pending' as const;
}

export function signMessage(secret: Uint8Array, message: Uint8Array): Uint8Array {
  return ed25519.sign(message, secret.slice(0, 32));
}

export function txFromBase64(b64: string) {
  return deserializeTx(base64.decode(b64));
}

export function describeFeePayer(tx: Transaction | VersionedTransaction): string | undefined {
  return tx instanceof VersionedTransaction ? tx.message.staticAccountKeys[0]?.toBase58() : tx.feePayer?.toBase58();
}
