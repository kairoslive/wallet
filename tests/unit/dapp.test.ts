import { beforeEach, describe, expect, it } from 'vitest';
import { recoverMessageAddress, recoverTypedDataAddress, type Hex } from 'viem';
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base64 } from '@scure/base';
import bs58 from 'bs58';
import { WalletService } from '../../src/core/wallet/service';
import { MemoryStore } from '../../src/core/storage';
import { DappController } from '../../src/core/dapp/controller';
import { ProviderError, type ApprovalResult, type ApprovalType, type Approver } from '../../src/core/dapp/types';

const MNEMONIC = 'test test test test test test test test test test test junk';
const ANVIL_0 = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const ORIGIN = 'https://app.example';

class FakeApprover implements Approver {
  calls: { type: ApprovalType; origin: string; payload: Record<string, unknown> }[] = [];
  next: (type: ApprovalType, payload: Record<string, unknown>) => ApprovalResult = () => ({ approved: true });
  async request(type: ApprovalType, origin: string, payload: Record<string, unknown>) {
    this.calls.push({ type, origin, payload });
    return this.next(type, payload);
  }
}

async function setup() {
  const service = new WalletService({
    store: new MemoryStore(),
    session: new MemoryStore(),
    pbkdf2Iterations: 1000,
    fetchFn: async () => {
      throw new Error('no network');
    },
  });
  await service.createWallet({ password: 'password123', mnemonic: MNEMONIC });
  const approver = new FakeApprover();
  const rpcCalls: { url: string; body: unknown }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    rpcCalls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x10' }));
  }) as unknown as typeof fetch;
  const dapp = new DappController(service, approver, fetchFn);
  const evm = (method: string, params?: unknown) => dapp.handle(ORIGIN, { chain: 'evm', method, params });
  const solana = (method: string, params?: unknown) => dapp.handle(ORIGIN, { chain: 'solana', method, params });
  return { service, approver, dapp, evm, solana, rpcCalls };
}

async function rejects(p: Promise<unknown>, code: number) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ProviderError);
  expect((err as ProviderError).code).toBe(code);
}

describe('DappController: EVM', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('reports the default chain and no accounts before connecting', async () => {
    expect(await ctx.evm('eth_chainId')).toBe('0x1');
    expect(await ctx.evm('net_version')).toBe('1');
    expect(await ctx.evm('eth_accounts')).toEqual([]);
    expect(ctx.approver.calls).toHaveLength(0);
  });

  it('connects via eth_requestAccounts with a single approval', async () => {
    expect(await ctx.evm('eth_requestAccounts')).toEqual([ANVIL_0]);
    expect(ctx.approver.calls.map((c) => c.type)).toEqual(['connect']);
    expect(ctx.approver.calls[0].payload.chain).toBe('evm');
    // Already connected: no new prompt.
    expect(await ctx.evm('eth_requestAccounts')).toEqual([ANVIL_0]);
    expect(await ctx.evm('eth_accounts')).toEqual([ANVIL_0]);
    expect(ctx.approver.calls).toHaveLength(1);
    expect(await ctx.evm('wallet_getPermissions')).toEqual([{ parentCapability: 'eth_accounts' }]);
  });

  it('returns 4001 when the user rejects the connection', async () => {
    ctx.approver.next = () => ({ approved: false });
    await rejects(ctx.evm('eth_requestAccounts'), 4001);
    expect(await ctx.service.getPermission(ORIGIN)).toBeUndefined();
  });

  it('only exposes the accounts chosen in the approval, selected account first', async () => {
    const st = await ctx.service.getState();
    const a2 = await ctx.service.addAccount({ seedId: st.seeds[0].id });
    await ctx.service.selectAccount(st.accounts[0].id);
    ctx.approver.next = () => ({ approved: true, data: { accountIds: [st.accounts[0].id, a2.id] } });
    const accounts = (await ctx.evm('eth_requestAccounts')) as string[];
    expect(accounts).toEqual([ANVIL_0, a2.evmAddress!.toLowerCase()]);
    await ctx.service.selectAccount(a2.id);
    expect(((await ctx.evm('eth_accounts')) as string[])[0]).toBe(a2.evmAddress!.toLowerCase());
  });

  it('hides accounts while the wallet is locked', async () => {
    await ctx.evm('eth_requestAccounts');
    await ctx.service.lock();
    expect(await ctx.evm('eth_accounts')).toEqual([]);
  });

  it('revokes permissions', async () => {
    await ctx.evm('eth_requestAccounts');
    await ctx.evm('wallet_revokePermissions', [{ eth_accounts: {} }]);
    expect(await ctx.evm('eth_accounts')).toEqual([]);
  });

  it('switches to a known chain and rejects unknown chains with 4902', async () => {
    await ctx.evm('eth_requestAccounts');
    expect(await ctx.evm('wallet_switchEthereumChain', [{ chainId: '0x2105' }])).toBeNull();
    expect(await ctx.evm('eth_chainId')).toBe('0x2105');
    await rejects(ctx.evm('wallet_switchEthereumChain', [{ chainId: '0x99999' }]), 4902);
  });

  it('remembers a chain switch made before connecting', async () => {
    await ctx.evm('wallet_switchEthereumChain', [{ chainId: '0xa' }]);
    expect(await ctx.evm('eth_chainId')).toBe('0xa');
    await ctx.evm('eth_requestAccounts');
    expect((await ctx.service.getPermission(ORIGIN))?.evmNetworkId).toBe('optimism');
  });

  it('signs personal_sign messages after approval (hex and plain, either param order)', async () => {
    await ctx.evm('eth_requestAccounts');
    const hexMsg = '0x48656c6c6f'; // "Hello"
    const sig = (await ctx.evm('personal_sign', [hexMsg, ANVIL_0])) as Hex;
    expect(ctx.approver.calls.at(-1)).toMatchObject({ type: 'evmSignMessage', payload: { message: 'Hello' } });
    expect((await recoverMessageAddress({ message: { raw: hexMsg }, signature: sig })).toLowerCase()).toBe(ANVIL_0);
    const sig2 = (await ctx.evm('personal_sign', [ANVIL_0, 'plain text'])) as Hex;
    expect((await recoverMessageAddress({ message: 'plain text', signature: sig2 })).toLowerCase()).toBe(ANVIL_0);
  });

  it('refuses to sign for accounts that are not connected', async () => {
    await rejects(ctx.evm('personal_sign', ['0x00', ANVIL_0]), 4100);
    await ctx.evm('eth_requestAccounts');
    await rejects(ctx.evm('personal_sign', ['0x00', '0x70997970C51812dc3A010C7d01b50e0d17dc79C8']), 4100);
  });

  it('rejected signatures return 4001', async () => {
    await ctx.evm('eth_requestAccounts');
    ctx.approver.next = () => ({ approved: false });
    await rejects(ctx.evm('personal_sign', ['0x00', ANVIL_0]), 4001);
  });

  it('signs EIP-712 typed data and validates its chain id', async () => {
    await ctx.evm('eth_requestAccounts');
    const typed = {
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'chainId', type: 'uint256' },
        ],
        Mail: [{ name: 'contents', type: 'string' }],
      },
      primaryType: 'Mail',
      domain: { name: 'Test', chainId: 1 },
      message: { contents: 'hi' },
    };
    const sig = (await ctx.evm('eth_signTypedData_v4', [ANVIL_0, JSON.stringify(typed)])) as Hex;
    const recovered = await recoverTypedDataAddress({
      domain: typed.domain,
      types: { Mail: typed.types.Mail },
      primaryType: 'Mail',
      message: typed.message,
      signature: sig,
    });
    expect(recovered.toLowerCase()).toBe(ANVIL_0);
    await rejects(ctx.evm('eth_signTypedData_v4', [ANVIL_0, { ...typed, domain: { name: 'Test', chainId: 10 } }]), -32602);
    await rejects(ctx.evm('eth_signTypedData_v4', [ANVIL_0, 'not json']), -32602);
  });

  it('proxies read-only calls to the network RPC', async () => {
    expect(await ctx.evm('eth_blockNumber', [])).toBe('0x10');
    expect(ctx.rpcCalls[0].url).toBe('https://ethereum-rpc.publicnode.com');
    expect(ctx.rpcCalls[0].body).toMatchObject({ method: 'eth_blockNumber' });
  });

  it('rejects unsupported and unsafe methods with 4200', async () => {
    await rejects(ctx.evm('eth_sign', [ANVIL_0, '0x00']), 4200);
    await rejects(ctx.evm('foo_bar'), 4200);
  });

  it('wallet_addEthereumChain for an already-known chain just switches', async () => {
    await ctx.evm('wallet_addEthereumChain', [{ chainId: '0x89', rpcUrls: ['https://example.invalid'] }]);
    expect(await ctx.evm('eth_chainId')).toBe('0x89');
    expect(ctx.approver.calls.filter((c) => c.type === 'evmAddNetwork')).toHaveLength(0);
  });
});

describe('DappController: Solana', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  let address: string;
  beforeEach(async () => {
    ctx = await setup();
    address = (await ctx.service.getState()).accounts[0].solanaAddress!;
  });

  it('connect respects onlyIfTrusted and prompts otherwise', async () => {
    await rejects(ctx.solana('connect', { onlyIfTrusted: true }), 4001);
    expect(ctx.approver.calls).toHaveLength(0);
    expect(await ctx.solana('connect', {})).toEqual({ accounts: [address] });
    expect(ctx.approver.calls[0].payload.chain).toBe('solana');
    expect(await ctx.solana('connect', { onlyIfTrusted: true })).toEqual({ accounts: [address] });
  });

  it('signs messages with the ed25519 key', async () => {
    await ctx.solana('connect', {});
    const msg = new TextEncoder().encode('Sign in to example');
    const res = (await ctx.solana('signMessage', { address, message: base64.encode(msg) })) as { signature: string };
    expect(ctx.approver.calls.at(-1)).toMatchObject({ type: 'solanaSignMessage', payload: { message: 'Sign in to example' } });
    expect(ed25519.verify(base64.decode(res.signature), msg, bs58.decode(address))).toBe(true);
  });

  it('signs legacy and versioned transactions without sending them', async () => {
    await ctx.solana('connect', {});
    const from = new PublicKey(address);
    const ix = SystemProgram.transfer({ fromPubkey: from, toPubkey: Keypair.generate().publicKey, lamports: 1000 });
    const blockhash = bs58.encode(new Uint8Array(32).fill(9));
    const legacy = new Transaction({ feePayer: from, recentBlockhash: blockhash }).add(ix);
    const v0 = new VersionedTransaction(
      new TransactionMessage({ payerKey: from, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message(),
    );
    const res = (await ctx.solana('signTransaction', {
      address,
      chain: 'solana:devnet',
      transactions: [
        base64.encode(legacy.serialize({ requireAllSignatures: false, verifySignatures: false })),
        base64.encode(v0.serialize()),
      ],
    })) as { signedTransactions: string[] };
    const approval = ctx.approver.calls.at(-1)!;
    expect(approval.type).toBe('solanaSignTransaction');
    expect(approval.payload).toMatchObject({ send: false, networkId: 'solana-devnet' });
    const [signedLegacy, signedV0] = res.signedTransactions.map((t) => base64.decode(t));
    expect(Transaction.from(signedLegacy).verifySignatures()).toBe(true);
    const vt = VersionedTransaction.deserialize(signedV0);
    expect(ed25519.verify(vt.signatures[0], vt.message.serialize(), from.toBytes())).toBe(true);
  });

  it('requires a connected account to sign', async () => {
    await rejects(ctx.solana('signMessage', { address, message: base64.encode(new Uint8Array([1])) }), 4100);
  });

  it('disconnect revokes access', async () => {
    await ctx.solana('connect', {});
    await ctx.solana('disconnect');
    expect(await ctx.solana('accounts')).toEqual({ accounts: [] });
  });
});
