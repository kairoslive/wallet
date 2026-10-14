import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublicClient, http, parseEther, type Hex } from 'viem';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, Connection } from '@solana/web3.js';
import { base64 } from '@scure/base';
import { WalletService } from '../../src/core/wallet/service';
import { MemoryStore } from '../../src/core/storage';
import { DappController } from '../../src/core/dapp/controller';
import type { ApprovalType, Approver } from '../../src/core/dapp/types';
import type { EvmNetwork, SolanaNetwork } from '../../src/core/types';
import { startAnvil, ANVIL_MNEMONIC, type AnvilInstance } from '../helpers/anvil';
import { startSolanaShim, type SolanaShim } from '../helpers/solana-rpc-shim';

const ORIGIN = 'https://dapp.example';

/** Approves everything and records what was asked. */
class AutoApprover implements Approver {
  seen: { type: ApprovalType; payload: Record<string, unknown> }[] = [];
  async request(type: ApprovalType, _origin: string, payload: Record<string, unknown>) {
    this.seen.push({ type, payload });
    return { approved: true };
  }
}

describe('dApp provider end-to-end against local chains', () => {
  let anvil: AnvilInstance;
  let shim: SolanaShim;
  let service: WalletService;
  let approver: AutoApprover;
  let dapp: DappController;

  beforeAll(async () => {
    // Run anvil as chain 1 so the built-in "Ethereum" network can simply point at it.
    [anvil, shim] = await Promise.all([startAnvil({ chainId: 1 }), startSolanaShim()]);
    service = new WalletService({
      store: new MemoryStore(),
      session: new MemoryStore(),
      pbkdf2Iterations: 1000,
      fetchFn: async () => {
        throw new Error('network disabled in tests');
      },
    });
    await service.createWallet({ password: 'password123', mnemonic: ANVIL_MNEMONIC });
    const s = await service.getSettings();
    const eth = s.networks.find((n) => n.id === 'eth') as EvmNetwork;
    const devnet = s.networks.find((n) => n.id === 'solana-devnet') as SolanaNetwork;
    await service.upsertNetwork({ ...eth, rpcUrl: anvil.rpcUrl, history: { kind: 'none' } });
    await service.upsertNetwork({ ...devnet, rpcUrl: shim.rpcUrl });
    approver = new AutoApprover();
    // Read-only calls are proxied with the real fetch to the local node.
    dapp = new DappController(service, approver, (...a) => fetch(...a));
  });

  afterAll(async () => {
    await Promise.all([anvil?.stop(), shim?.stop()]);
  });

  it('eth_sendTransaction sends a real transaction after approval and records it', async () => {
    const evm = (method: string, params?: unknown) => dapp.handle(ORIGIN, { chain: 'evm', method, params });
    const [from] = (await evm('eth_requestAccounts')) as string[];
    const to = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
    const client = createPublicClient({ transport: http(anvil.rpcUrl) });
    const before = await client.getBalance({ address: to });

    const hash = (await evm('eth_sendTransaction', [{ from, to, value: '0xde0b6b3a7640000' }])) as Hex;
    const approval = approver.seen.find((s) => s.type === 'evmSendTransaction')!;
    expect(approval.payload).toMatchObject({ networkId: 'eth', value: parseEther('1').toString() });
    expect(BigInt(approval.payload.fee as string)).toBeGreaterThan(0n);

    const receipt = await client.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe('success');
    expect(await client.getBalance({ address: to })).toBe(before + parseEther('1'));
    const local = (await service.getLocalTxs()).find((t) => t.hash === hash);
    expect(local).toMatchObject({ kind: 'send', title: 'Sent 1 ETH', networkId: 'eth' });

    // Read-only methods are proxied to the same node.
    expect(await evm('eth_getTransactionReceipt', [hash])).toMatchObject({ transactionHash: hash });
  });

  it('warns in the approval when a transaction would revert', async () => {
    const evm = (method: string, params?: unknown) => dapp.handle(ORIGIN, { chain: 'evm', method, params });
    const [from] = (await evm('eth_accounts')) as string[];
    // A contract whose code is PUSH1 0 PUSH1 0 REVERT fails gas estimation for any call.
    const reverter = '0x000000000000000000000000000000000000dEaD';
    await anvil.rpc('anvil_setCode', [reverter, '0x60006000fd']);
    const sent = approver.seen.length;
    await expect(evm('eth_sendTransaction', [{ from, to: reverter, data: '0x12345678' }])).rejects.toBeDefined();
    expect(approver.seen.length).toBe(sent + 1);
    const approval = approver.seen.filter((s) => s.type === 'evmSendTransaction').at(-1)!;
    expect(approval.payload.estimateError).toBeTruthy();
  });

  it('solana signAndSendTransaction signs and submits to the selected cluster', async () => {
    const sol = (method: string, params?: unknown) => dapp.handle(ORIGIN, { chain: 'solana', method, params });
    const { accounts } = (await sol('connect', {})) as { accounts: string[] };
    const owner = new PublicKey(accounts[0]);
    shim.airdrop(owner, 2_000_000_000n);
    const recipient = Keypair.generate().publicKey;
    const conn = new Connection(shim.rpcUrl, 'confirmed');
    const { blockhash } = await conn.getLatestBlockhash();
    const tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: owner,
        recentBlockhash: blockhash,
        instructions: [SystemProgram.transfer({ fromPubkey: owner, toPubkey: recipient, lamports: 1_000_000 })],
      }).compileToV0Message(),
    );
    const res = (await sol('signAndSendTransaction', {
      address: owner.toBase58(),
      chain: 'solana:devnet',
      transactions: [base64.encode(tx.serialize())],
    })) as { signatures: string[] };
    expect(res.signatures).toHaveLength(1);
    expect(shim.signatureStatus(res.signatures[0])?.err ?? null).toBeNull();
    expect(shim.getBalance(recipient)).toBe(1_000_000n);
    expect((await service.getLocalTxs()).some((t) => t.hash === res.signatures[0] && t.kind === 'dapp')).toBe(true);
  });
});
