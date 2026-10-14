/**
 * A tiny Solana JSON-RPC server backed by LiteSVM (an in-process Solana VM).
 *
 * It implements just the RPC methods @solana/web3.js `Connection` calls in our code paths,
 * with the response shapes web3.js validates, so the real wallet code can run against it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { FailedTransactionMetadata, LiteSVM } from 'litesvm';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MINT_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import bs58 from 'bs58';

type Address = Parameters<LiteSVM['getAccount']>[0];
type Lamports = Parameters<LiteSVM['airdrop']>[1];
type KitTransaction = Parameters<LiteSVM['sendTransaction']>[0];

const addr = (a: string | PublicKey): Address => (typeof a === 'string' ? a : a.toBase58()) as Address;

interface RpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method: string;
  params?: unknown[];
}

class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
  }
}

interface AccountJson {
  data: [string, 'base64'];
  executable: boolean;
  lamports: number;
  owner: string;
  rentEpoch: number;
  space: number;
}

export interface SolanaShim {
  svm: LiteSVM;
  rpcUrl: string;
  port: number;
  /** Fee payer funded at startup, used by the setup helpers. */
  payer: Keypair;
  /** Airdrops lamports; returns the airdrop signature. */
  airdrop(to: string | PublicKey, lamports: bigint): string;
  getBalance(address: string | PublicKey): bigint;
  /** Creates a new SPL mint (classic Token program by default); the shim payer is mint authority. */
  createMint(decimals: number, programId?: PublicKey): Promise<PublicKey>;
  /** Mints tokens to the owner's associated token account, creating it if needed. Returns the ATA. */
  mintTo(mint: PublicKey, owner: string | PublicKey, amount: bigint, programId?: PublicKey): Promise<PublicKey>;
  /** Signs (with the given signers) and executes a legacy transaction directly in LiteSVM. */
  execute(ixs: TransactionInstruction[], signers: Keypair[]): string;
  /** Status of a signature as tracked by the shim (undefined = never seen). */
  signatureStatus(sig: string): { slot: number; err: unknown } | undefined;
  /** All JSON-RPC methods received, for assertions. */
  calls: string[];
  stop(): Promise<void>;
}

export async function startSolanaShim(): Promise<SolanaShim> {
  const svm = new LiteSVM();
  const statuses = new Map<string, { slot: number; err: unknown }>();
  const calls: string[] = [];
  let slot = 1;

  const context = () => ({ slot, apiVersion: '2.0.0' });

  function accountJson(address: string): AccountJson | null {
    const acc = svm.getAccount(addr(address));
    if (!acc.exists) return null;
    return {
      data: [Buffer.from(acc.data).toString('base64'), 'base64'],
      executable: acc.executable,
      lamports: Number(acc.lamports),
      owner: acc.programAddress,
      rentEpoch: 0,
      space: acc.data.length,
    };
  }

  /** Converts wire-format bytes (legacy or v0) to the @solana/kit shape LiteSVM accepts. */
  function toKitTx(raw: Uint8Array): { tx: KitTransaction; signature: string } {
    const vtx = VersionedTransaction.deserialize(raw);
    const signers = vtx.message.staticAccountKeys.slice(0, vtx.message.header.numRequiredSignatures);
    const signatures: Record<string, Uint8Array | null> = {};
    signers.forEach((pk, i) => {
      const sig = vtx.signatures[i];
      signatures[pk.toBase58()] = sig && sig.some((b) => b !== 0) ? sig : null;
    });
    const tx = { messageBytes: vtx.message.serialize(), signatures } as unknown as KitTransaction;
    return { tx, signature: bs58.encode(vtx.signatures[0]) };
  }

  function errToJson(err: unknown): unknown {
    // Keep it JSON-safe; web3.js only checks truthiness for status `err`.
    try {
      return JSON.parse(JSON.stringify(err, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))) ?? String(err);
    } catch {
      return String(err);
    }
  }

  /** Executes a raw transaction. Throws RpcError (like a preflight failure) without changing state on error. */
  function executeRaw(raw: Uint8Array, skipPreflight = false): string {
    const { tx, signature } = toKitTx(raw);
    if (statuses.has(signature)) throw new RpcError(-32002, 'Transaction simulation failed: This transaction has already been processed');
    if (!skipPreflight) {
      const sim = svm.simulateTransaction(tx);
      if (sim instanceof FailedTransactionMetadata) {
        const meta = sim.meta();
        throw new RpcError(-32002, `Transaction simulation failed: ${sim.toString()}`, {
          err: errToJson(sim.err()),
          logs: meta.logs(),
          accounts: null,
          unitsConsumed: Number(meta.computeUnitsConsumed()),
        });
      }
    }
    const res = svm.sendTransaction(tx);
    slot += 1;
    if (res instanceof FailedTransactionMetadata) {
      statuses.set(signature, { slot, err: errToJson(res.err()) });
      if (!skipPreflight) {
        throw new RpcError(-32002, `Transaction failed: ${res.toString()}`, { logs: res.meta().logs() });
      }
    } else {
      statuses.set(signature, { slot, err: null });
    }
    // New blockhash after every tx so otherwise-identical transfers don't collide as duplicates.
    svm.expireBlockhash();
    return signature;
  }

  function cfg(params: unknown[], i: number): Record<string, unknown> {
    const c = params[i];
    return c && typeof c === 'object' ? (c as Record<string, unknown>) : {};
  }

  const handlers: Record<string, (params: unknown[]) => unknown> = {
    getHealth: () => 'ok',
    getVersion: () => ({ 'solana-core': '2.0.0', 'feature-set': 0 }),
    getSlot: () => slot,
    getBlockHeight: () => slot,
    getGenesisHash: () => '11111111111111111111111111111111',
    getBalance: ([address]) => ({ context: context(), value: Number(svm.getBalance(addr(address as string)) ?? 0n) }),
    getLatestBlockhash: () => ({
      context: context(),
      value: { blockhash: svm.latestBlockhash(), lastValidBlockHeight: slot + 150 },
    }),
    getRecentBlockhash: () => ({
      context: context(),
      value: { blockhash: svm.latestBlockhash(), feeCalculator: { lamportsPerSignature: 5000 } },
    }),
    isBlockhashValid: ([hash]) => ({ context: context(), value: hash === svm.latestBlockhash() }),
    sendTransaction: (params) => {
      const [encoded] = params as [string];
      const c = cfg(params, 1);
      const raw = c.encoding === 'base64' ? Buffer.from(encoded, 'base64') : bs58.decode(encoded);
      return executeRaw(raw, c.skipPreflight === true);
    },
    simulateTransaction: (params) => {
      const [encoded] = params as [string];
      const c = cfg(params, 1);
      const raw = c.encoding === 'base64' ? Buffer.from(encoded, 'base64') : bs58.decode(encoded);
      const { tx } = toKitTx(raw);
      const sim = svm.simulateTransaction(tx);
      const meta = sim.meta();
      return {
        context: context(),
        value: {
          err: sim instanceof FailedTransactionMetadata ? errToJson(sim.err()) : null,
          logs: meta.logs(),
          accounts: null,
          unitsConsumed: Number(meta.computeUnitsConsumed()),
          returnData: null,
        },
      };
    },
    getSignatureStatuses: ([sigs]) => ({
      context: context(),
      value: (sigs as string[]).map((s) => {
        const st = statuses.get(s);
        if (!st) return null;
        return { slot: st.slot, confirmations: null, err: st.err, status: st.err ? { Err: st.err } : { Ok: null }, confirmationStatus: 'finalized' };
      }),
    }),
    getAccountInfo: ([address]) => ({ context: context(), value: accountJson(address as string) }),
    getMultipleAccounts: ([addresses]) => ({
      context: context(),
      value: (addresses as string[]).map((a) => accountJson(a)),
    }),
    getTokenAccountsByOwner: (params) => {
      const [owner, filter] = params as [string, { programId?: string; mint?: string }];
      const programIds = filter.programId
        ? [filter.programId]
        : [TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()];
      const ownerBytes = new PublicKey(owner).toBuffer();
      const value: { pubkey: string; account: AccountJson }[] = [];
      for (const pid of programIds) {
        for (const acc of svm.getProgramAccounts(addr(pid))) {
          const data = Buffer.from(acc.data);
          // SPL token account layout: mint (0..32), owner (32..64). Mints are 82 bytes and are skipped.
          if (data.length < 165) continue;
          if (!data.subarray(32, 64).equals(ownerBytes)) continue;
          if (filter.mint && new PublicKey(data.subarray(0, 32)).toBase58() !== filter.mint) continue;
          value.push({ pubkey: acc.address, account: accountJson(acc.address)! });
        }
      }
      return { context: context(), value };
    },
    getMinimumBalanceForRentExemption: ([len]) => Number(svm.minimumBalanceForRentExemption(BigInt(len as number))),
    getFeeForMessage: ([msgB64]) => {
      const msg = VersionedMessage.deserialize(Buffer.from(msgB64 as string, 'base64'));
      return { context: context(), value: 5000 * msg.header.numRequiredSignatures };
    },
    getRecentPrioritizationFees: () => [],
    requestAirdrop: ([address, lamports]) => airdrop(address as string, BigInt(lamports as number)),
  };

  async function handleOne(req: RpcRequest) {
    const id = req.id ?? null;
    calls.push(req.method);
    const fn = handlers[req.method];
    if (!fn) return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${req.method}` } };
    try {
      return { jsonrpc: '2.0', id, result: await fn(req.params ?? []) };
    } catch (e) {
      if (e instanceof RpcError) return { jsonrpc: '2.0', id, error: { code: e.code, message: e.message, data: e.data } };
      return { jsonrpc: '2.0', id, error: { code: -32603, message: (e as Error).message } };
    }
  }

  async function onRequest(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      return;
    }
    const out = Array.isArray(body)
      ? await Promise.all(body.map((r) => handleOne(r as RpcRequest)))
      : await handleOne(body as RpcRequest);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
  }

  function airdrop(to: string | PublicKey, lamports: bigint): string {
    const r = svm.airdrop(addr(to), lamports as Lamports);
    if (!r || r instanceof FailedTransactionMetadata) throw new Error(`airdrop failed: ${r?.toString()}`);
    slot += 1;
    const sig = bs58.encode(r.signature());
    statuses.set(sig, { slot, err: null });
    svm.expireBlockhash();
    return sig;
  }

  const payer = Keypair.generate();
  airdrop(payer.publicKey, 1_000n * 1_000_000_000n);

  function execute(ixs: TransactionInstruction[], signers: Keypair[]): string {
    const tx = new Transaction({ feePayer: signers[0].publicKey, recentBlockhash: svm.latestBlockhash() }).add(...ixs);
    tx.sign(...signers);
    return executeRaw(tx.serialize());
  }

  const server: Server = createServer((req, res) => {
    onRequest(req, res).catch((e) => {
      res.writeHead(500).end(String(e));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    svm,
    port,
    rpcUrl: `http://127.0.0.1:${port}`,
    payer,
    calls,
    airdrop,
    getBalance: (a) => BigInt(svm.getBalance(addr(a)) ?? 0n),
    execute,
    signatureStatus: (sig) => statuses.get(sig),
    async createMint(decimals, programId = TOKEN_PROGRAM_ID) {
      const mint = Keypair.generate();
      const lamports = Number(svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE)));
      execute(
        [
          SystemProgram.createAccount({
            fromPubkey: payer.publicKey,
            newAccountPubkey: mint.publicKey,
            space: MINT_SIZE,
            lamports,
            programId,
          }),
          createInitializeMint2Instruction(mint.publicKey, decimals, payer.publicKey, null, programId),
        ],
        [payer, mint],
      );
      return mint.publicKey;
    },
    async mintTo(mint, owner, amount, programId = TOKEN_PROGRAM_ID) {
      const ownerPk = typeof owner === 'string' ? new PublicKey(owner) : owner;
      const ata = getAssociatedTokenAddressSync(mint, ownerPk, true, programId, ASSOCIATED_TOKEN_PROGRAM_ID);
      execute(
        [
          createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, ownerPk, mint, programId, ASSOCIATED_TOKEN_PROGRAM_ID),
          createMintToInstruction(mint, ata, payer.publicKey, amount, [], programId),
        ],
        [payer],
      );
      return ata;
    },
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
