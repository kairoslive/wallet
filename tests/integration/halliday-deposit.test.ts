import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPublicClient, encodeDeployData, erc20Abi, getAddress, http, recoverTypedDataAddress, type Hex } from 'viem';
import { WalletService } from '../../src/core/wallet/service';
import { MemoryStore } from '../../src/core/storage';
import type { EvmNetwork, Token } from '../../src/core/types';
import { startAnvil, ANVIL_MNEMONIC, type AnvilInstance } from '../helpers/anvil';
import { compileContracts } from '../helpers/contracts';

/**
 * Prediction-market deposits through Halliday, against a local chain posing as Polygon
 * (Halliday's API is mocked; token transfers are real).
 */
const TRADING_WALLET = '0x00000000000000000000000000000000000071ad';
const DEPOSIT_ADDRESS = '0x00000000000000000000000000000000000d0e70';
const OWNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

const ownershipProof = {
  domain: { name: 'Halliday', version: '1', chainId: 137 },
  types: {
    EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
    ],
    OwnerVerification: [
      { name: 'owner', type: 'address' },
      { name: 'nonce', type: 'string' },
    ],
  },
  primaryType: 'OwnerVerification',
  message: { owner: OWNER, nonce: 'abc' },
};

type Scenario = 'ok' | 'wrong-token' | 'too-much' | 'verify' | 'verify-permit';

describe('Halliday deposits (anvil as Polygon)', () => {
  let anvil: AnvilInstance;
  let service: WalletService;
  let accountId: string;
  let usdc: Token;
  let scenario: Scenario = 'ok';
  let confirms: Record<string, unknown>[] = [];

  const deposit = (overrides: Partial<{ deposit_token: string; deposit_amount: string }> = {}) => ({
    payment_id: 'pay-1',
    status: 'PENDING',
    next_instruction: {
      type: 'TRANSFER_IN',
      deposit_info: [
        {
          deposit_token: `polygon:${usdc.address.toLowerCase()}`,
          deposit_amount: '10',
          deposit_address: DEPOSIT_ADDRESS,
          deposit_chain: 'polygon',
          ...overrides,
        },
      ],
    },
  });

  beforeAll(async () => {
    anvil = await startAnvil({ chainId: 137 });
    const fetchFn = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const json = (v: unknown) => new Response(JSON.stringify(v));
      if (u.includes('/v3/wallets/'))
        return json({ wallet: OWNER, tradingWallet: TRADING_WALLET, ready: true, balance: '0', next: 'fund' });
      if (u.endsWith('/payments/quotes')) {
        return json({
          quotes: [
            { payment_id: 'pay-1', output_amount: { asset: 'polygon:0xc011', amount: '9.99' }, fees: { total_fees: '0.01' } },
          ],
          state_token: 'state',
          accept_by: new Date(Date.now() + 300_000).toISOString(),
        });
      }
      if (u.endsWith('/payments/confirm')) {
        confirms.push(body);
        if (body.verification_token) return json(deposit());
        if (scenario === 'wrong-token')
          return json(deposit({ deposit_token: 'polygon:0x1111111111111111111111111111111111111111' }));
        if (scenario === 'too-much') return json(deposit({ deposit_amount: '11' }));
        if (scenario === 'verify' || scenario === 'verify-permit') {
          const payload =
            scenario === 'verify'
              ? ownershipProof
              : { ...ownershipProof, primaryType: 'Permit', message: { owner: OWNER, spender: DEPOSIT_ADDRESS, value: '1' } };
          return json({
            payment_id: 'pay-1',
            status: 'UNCONFIRMED',
            next_instruction: {
              type: 'USER_VERIFY',
              verification_token: 'vtok',
              verifications: [{ reason: 'EVM_OWNER', signature_type: 'EIP712', payload: JSON.stringify(payload) }],
            },
          });
        }
        return json(deposit());
      }
      if (u.includes('/payments?payment_id=')) return json({ payment_id: 'pay-1', status: 'COMPLETE' });
      throw new Error(`unexpected request ${u}`);
    }) as unknown as typeof fetch;

    service = new WalletService({ store: new MemoryStore(), session: new MemoryStore(), pbkdf2Iterations: 1000, fetchFn });
    await service.createWallet({ password: 'password123', mnemonic: ANVIL_MNEMONIC });
    const builtIn = (await service.getSettings()).networks.find((n) => n.id === 'polygon') as EvmNetwork;
    // Everything below must hit anvil only, never the real Polygon RPC.
    const polygon: EvmNetwork = { ...builtIn, rpcUrl: anvil.rpcUrl, history: { kind: 'none' } };
    await service.upsertNetwork(polygon);
    accountId = (await service.getState()).accounts[0].id;

    // A 6-decimal stand-in for USDC.
    const { TestToken } = compileContracts();
    const signer = await service.evmSigner(accountId);
    const hash = await signer.sendTransaction(polygon, {
      from: OWNER as Hex,
      data: encodeDeployData({ abi: TestToken.abi, bytecode: TestToken.bytecode, args: ['USD Coin', 'USDC', 6, 1_000_000_000n] }),
    });
    const client = createPublicClient({ transport: http(anvil.rpcUrl) });
    const receipt = await client.waitForTransactionReceipt({ hash });
    usdc = { networkId: 'polygon', address: getAddress(receipt.contractAddress!), symbol: 'USDC', name: 'USD Coin', decimals: 6 };
  }, 120_000);

  afterAll(async () => anvil?.stop());
  beforeEach(() => {
    confirms = [];
  });

  const depositBalance = () =>
    createPublicClient({ transport: http(anvil.rpcUrl) }).readContract({
      address: usdc.address as Hex,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [DEPOSIT_ADDRESS],
    });

  it('converts a held token: confirms to the trading wallet and sends exactly the instructed amount', async () => {
    scenario = 'ok';
    const quote = await service.depositQuote({ networkId: 'polygon', token: usdc, amount: '10' });
    expect(quote.outputAmount).toBe('9.99');
    const res = await service.depositWithCrypto(accountId, { networkId: 'polygon', token: usdc, amount: '10', quote });
    expect(res.paymentId).toBe('pay-1');
    expect(await service.waitForTx(res.networkId, res.hash)).toBe('confirmed');
    expect(await depositBalance()).toBe(10_000_000n);
    expect(confirms[0]).toMatchObject({ payment_id: 'pay-1', owner_address: OWNER, destination_address: TRADING_WALLET });
    expect(await service.depositStatus('pay-1')).toEqual({ status: 'COMPLETE', inProgress: false });
  });

  it.each([
    ['a different token', 'wrong-token', 'different token'],
    ['more than quoted', 'too-much', 'more than you entered'],
  ] as const)('sends nothing when the deposit instruction asks for %s', async (_name, s, message) => {
    scenario = s;
    const before = await depositBalance();
    await expect(service.depositWithCrypto(accountId, { networkId: 'polygon', token: usdc, amount: '10' })).rejects.toThrow(
      message,
    );
    expect(await depositBalance()).toBe(before);
  });

  it('completes the one-time owner verification for larger deposits', async () => {
    scenario = 'verify';
    const before = await depositBalance();
    const res = await service.depositWithCrypto(accountId, { networkId: 'polygon', token: usdc, amount: '10' });
    await service.waitForTx(res.networkId, res.hash);
    expect(await depositBalance()).toBe(before + 10_000_000n);
    const cont = confirms.find((c) => c.verification_token) as { signatures: { reason: string; signature: Hex }[] };
    expect(cont.signatures[0].reason).toBe('EVM_OWNER');
    const types = { ...ownershipProof.types } as Record<string, unknown>;
    delete types.EIP712Domain;
    const signer = await recoverTypedDataAddress({
      domain: ownershipProof.domain,
      types,
      primaryType: ownershipProof.primaryType,
      message: ownershipProof.message,
      signature: cont.signatures[0].signature,
    } as unknown as Parameters<typeof recoverTypedDataAddress>[0]);
    expect(signer).toBe(OWNER);
  });

  it('refuses a "verification" that is really a token permit', async () => {
    scenario = 'verify-permit';
    const before = await depositBalance();
    await expect(service.depositWithCrypto(accountId, { networkId: 'polygon', token: usdc, amount: '10' })).rejects.toThrow(
      'token permission',
    );
    expect(confirms.some((c) => c.verification_token)).toBe(false);
    expect(await depositBalance()).toBe(before);
  });
});
