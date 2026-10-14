import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  encodeDeployData,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  parseEther,
  verifyMessage,
  verifyTypedData,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { WalletService } from '../../src/core/wallet/service';
import { MemoryStore } from '../../src/core/storage';
import { publicClient } from '../../src/core/evm/client';
import type { Account, EvmNetwork, Token } from '../../src/core/types';
import { ANVIL_MNEMONIC, startAnvil, type AnvilInstance } from '../helpers/anvil';
import { compileContracts } from '../helpers/contracts';

const PASSWORD = 'correct horse battery';
const NET_ID = 'anvil';
const ANVIL_ACCOUNT_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const ANVIL_ACCOUNT_1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const LIFI_URL = 'http://lifi.test';
const ETH = 10n ** 18n;

describe('EVM integration (anvil)', () => {
  let anvil: AnvilInstance;
  let service: WalletService;
  let network: EvmNetwork;
  let acc0: Account;
  let acc1: Account;
  let token: Token;
  let routerAddress: Hex;
  const eth: Token = { networkId: NET_ID, address: 'native', symbol: 'ETH', name: 'Ether', decimals: 18 };
  const contracts = compileContracts();
  const fetchLog: string[] = [];
  /** Fake LI.FI responder; set per test. */
  let lifiQuote: ((url: URL) => unknown) | undefined;

  const client = () => publicClient(network);

  async function receipt(hash: string) {
    return client().waitForTransactionReceipt({ hash: hash as Hex, pollingInterval: 100 });
  }

  async function gasCost(hash: string): Promise<bigint> {
    const r = await receipt(hash);
    return r.gasUsed * r.effectiveGasPrice;
  }

  beforeAll(async () => {
    anvil = await startAnvil();
    service = new WalletService({
      store: new MemoryStore(),
      session: new MemoryStore(),
      pbkdf2Iterations: 1000,
      fetchFn: async (input) => {
        const url = new URL(String(input instanceof Request ? input.url : input));
        fetchLog.push(url.toString());
        if (url.origin === LIFI_URL && url.pathname === '/v1/quote' && lifiQuote) {
          return new Response(JSON.stringify(lifiQuote(url)), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        throw new Error(`unexpected fetch in test: ${url}`);
      },
    });
    await service.createWallet({ password: PASSWORD, mnemonic: ANVIL_MNEMONIC });
    // Disable all built-in networks so nothing hits public RPCs.
    for (const n of (await service.getSettings()).networks) await service.upsertNetwork({ ...n, enabled: false });
    network = {
      type: 'evm',
      id: NET_ID,
      name: 'Anvil',
      chainId: 31337,
      rpcUrl: anvil.rpcUrl,
      explorerUrl: '',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      history: { kind: 'none' },
      testnet: true,
      enabled: true,
      // Lets the (mocked) LI.FI swap flow run against this chain.
      lifiChainId: 31337,
    };
    await service.upsertNetwork(network);
    await service.updateSettings({ showTestnets: true, apis: { ...(await service.getSettings()).apis, lifiUrl: LIFI_URL } });
    acc0 = (await service.getState()).accounts[0];
  });

  afterAll(async () => {
    await anvil?.stop();
  });

  it('creates the wallet from the anvil mnemonic with matching first account', async () => {
    expect(acc0.evmAddress).toBe(ANVIL_ACCOUNT_0);
    expect(acc0.index).toBe(0);
    const net = await service.getNetwork(NET_ID);
    expect(net.custom).toBe(true);
    expect((await service.activeNetworks()).map((n) => n.id)).toEqual([NET_ID]);
  });

  it('getPortfolio shows 10000 ETH', async () => {
    const p = await service.getPortfolio(acc0.id);
    expect(p.errors).toEqual({});
    const evmBalances = p.balances.filter((b) => b.networkId === NET_ID);
    expect(evmBalances).toHaveLength(1);
    expect(evmBalances[0]).toMatchObject({ address: 'native', symbol: 'ETH', balance: (10_000n * ETH).toString() });
    // Testnet: no price lookups.
    expect(p.totalUsd).toBe(0);
    expect(await service.getCachedPortfolio(acc0.id)).toEqual(p);
  });

  it('previewSend reports the fee and rejects bad sends', async () => {
    const preview = await service.previewSend({
      accountId: acc0.id,
      networkId: NET_ID,
      token: eth,
      to: ANVIL_ACCOUNT_1,
      amount: '1',
    });
    const fees = await client().estimateFeesPerGas();
    expect(BigInt(preview.fee)).toBe(21_000n * fees.maxFeePerGas);
    expect(preview).toMatchObject({ feeSymbol: 'ETH', feeDecimals: 18, amountBase: ETH.toString(), warnings: [] });
    expect(preview.feeUsd).toBeUndefined();

    const self = await service.previewSend({
      accountId: acc0.id,
      networkId: NET_ID,
      token: eth,
      to: ANVIL_ACCOUNT_0,
      amount: '1',
    });
    expect(self.warnings).toContain('You are sending to your own address');

    await expect(
      service.previewSend({ accountId: acc0.id, networkId: NET_ID, token: eth, to: ANVIL_ACCOUNT_1, amount: '20000' }),
    ).rejects.toThrow('Insufficient ETH balance');
    await expect(
      service.previewSend({ accountId: acc0.id, networkId: NET_ID, token: eth, to: ANVIL_ACCOUNT_1, amount: '10000' }),
    ).rejects.toThrow('Insufficient ETH to cover the network fee');
    await expect(
      service.previewSend({ accountId: acc0.id, networkId: NET_ID, token: eth, to: '0x1234', amount: '1' }),
    ).rejects.toThrow('Invalid recipient address');
    await expect(
      service.previewSend({ accountId: acc0.id, networkId: NET_ID, token: eth, to: ANVIL_ACCOUNT_1, amount: '0' }),
    ).rejects.toThrow('Amount must be greater than zero');
  });

  it('sends native ETH to a second derived account', async () => {
    acc1 = await service.addAccount({ seedId: acc0.seedId! });
    expect(acc1.index).toBe(1);
    expect(acc1.evmAddress).toBe(ANVIL_ACCOUNT_1);

    const before0 = await service.getBalance(acc0.id, NET_ID, eth);
    const before1 = await service.getBalance(acc1.id, NET_ID, eth);
    const rec = await service.send({ accountId: acc0.id, networkId: NET_ID, token: eth, to: acc1.evmAddress!, amount: '1.25' });
    expect(rec).toMatchObject({
      networkId: NET_ID,
      chainType: 'evm',
      from: ANVIL_ACCOUNT_0,
      to: ANVIL_ACCOUNT_1,
      title: 'Sent 1.25 ETH',
      kind: 'send',
      direction: 'out',
      status: 'pending',
      source: 'local',
    });
    expect(await service.waitForTx(NET_ID, rec.hash)).toBe('confirmed');
    expect((await service.getLocalTxs()).find((t) => t.hash === rec.hash)?.status).toBe('confirmed');

    const cost = await gasCost(rec.hash);
    expect(await service.getBalance(acc1.id, NET_ID, eth)).toBe(before1 + parseEther('1.25'));
    expect(await service.getBalance(acc0.id, NET_ID, eth)).toBe(before0 - parseEther('1.25') - cost);

    // A second send confirmed via refreshPending instead of waitForTx.
    const rec2 = await service.send({ accountId: acc1.id, networkId: NET_ID, token: eth, to: acc0.evmAddress!, amount: '0.5' });
    await receipt(rec2.hash);
    await service.refreshPending();
    expect((await service.getLocalTxs()).find((t) => t.hash === rec2.hash)?.status).toBe('confirmed');
    expect((await service.getLocalTxs()).map((t) => t.hash)).toEqual([rec2.hash, rec.hash]);
  });

  it('deploys an ERC-20, looks up metadata, adds it as a custom token and sends it', async () => {
    const signer = await service.evmSigner(acc0.id);
    const deployHash = await signer.sendTransaction(network, {
      from: acc0.evmAddress as Hex,
      data: encodeDeployData({
        abi: contracts.TestToken.abi,
        bytecode: contracts.TestToken.bytecode,
        args: ['Test Token', 'TST', 18, 1_000_000n * ETH],
      }),
    });
    const r = await receipt(deployHash);
    expect(r.status).toBe('success');
    const tokenAddress = getAddress(r.contractAddress!);

    const looked = await service.lookupToken(NET_ID, tokenAddress.toLowerCase());
    expect(looked).toEqual({ networkId: NET_ID, address: tokenAddress, symbol: 'TST', name: 'Test Token', decimals: 18 });
    await service.addCustomToken(looked);
    await expect(service.addCustomToken({ ...looked, address: tokenAddress.toLowerCase() })).rejects.toThrow(
      'Token already added',
    );
    token = { ...looked, custom: true };
    expect((await service.getTokens(NET_ID)).map((t) => t.symbol)).toEqual(['ETH', 'TST']);

    // Custom tokens are shown even with zero balance; acc0 holds the whole supply.
    const p0 = await service.getPortfolio(acc0.id, [NET_ID]);
    expect(p0.balances.find((b) => b.symbol === 'TST')?.balance).toBe((1_000_000n * ETH).toString());
    const p1 = await service.getPortfolio(acc1.id, [NET_ID]);
    expect(p1.balances.find((b) => b.symbol === 'TST')?.balance).toBe('0');

    const preview = await service.previewSend({
      accountId: acc0.id,
      networkId: NET_ID,
      token,
      to: acc1.evmAddress!,
      amount: '250',
    });
    expect(BigInt(preview.fee)).toBeGreaterThan(0n);
    await expect(
      service.previewSend({ accountId: acc1.id, networkId: NET_ID, token, to: acc0.evmAddress!, amount: '1' }),
    ).rejects.toThrow('Insufficient TST balance');

    const eth0 = await service.getBalance(acc0.id, NET_ID, eth);
    const rec = await service.send({ accountId: acc0.id, networkId: NET_ID, token, to: acc1.evmAddress!, amount: '250' });
    expect(rec.title).toBe('Sent 250 TST');
    expect(await service.waitForTx(NET_ID, rec.hash)).toBe('confirmed');
    expect(await service.getBalance(acc1.id, NET_ID, token)).toBe(250n * ETH);
    expect(await service.getBalance(acc0.id, NET_ID, token)).toBe(999_750n * ETH);
    // Only gas was spent in ETH.
    expect(await service.getBalance(acc0.id, NET_ID, eth)).toBe(eth0 - (await gasCost(rec.hash)));

    // maxSendable for a token is the full balance.
    expect(await service.maxSendable(acc1.id, NET_ID, token)).toBe('250');
  });

  it('executes a (mocked) LI.FI swap quote, approving the router first', async () => {
    // Deploy the toy router and give it ETH to pay out.
    const signer = await service.evmSigner(acc1.id);
    const deployHash = await signer.sendTransaction(network, {
      from: acc1.evmAddress as Hex,
      data: encodeDeployData({ abi: contracts.TestRouter.abi, bytecode: contracts.TestRouter.bytecode }),
    });
    routerAddress = getAddress((await receipt(deployHash)).contractAddress!);
    await anvil.rpc('anvil_setBalance', [routerAddress, `0x${(10n * ETH).toString(16)}`]);

    const amountIn = 100n * ETH;
    const amountOut = amountIn / 1000n;
    const seenParams: Record<string, string>[] = [];
    lifiQuote = (url) => {
      seenParams.push(Object.fromEntries(url.searchParams));
      return {
        id: 'quote-1',
        tool: 'testdex',
        toolDetails: { name: 'Test DEX' },
        action: { fromChainId: 31337, toChainId: 31337 },
        estimate: {
          approvalAddress: routerAddress,
          toAmount: amountOut.toString(),
          toAmountMin: ((amountOut * 99n) / 100n).toString(),
          executionDuration: 5,
        },
        transactionRequest: {
          to: routerAddress,
          data: encodeFunctionData({
            abi: contracts.TestRouter.abi,
            functionName: 'swapToNative',
            args: [token.address, BigInt(url.searchParams.get('fromAmount')!)],
          }),
          value: '0x0',
          chainId: 31337,
        },
      };
    };

    const quote = await service.getQuote({
      accountId: acc0.id,
      fromNetworkId: NET_ID,
      toNetworkId: NET_ID,
      fromToken: token,
      toToken: eth,
      amount: '100',
    });
    expect(seenParams).toHaveLength(1);
    expect(seenParams[0]).toMatchObject({
      fromChain: '31337',
      toChain: '31337',
      fromToken: token.address,
      toToken: '0x0000000000000000000000000000000000000000',
      fromAmount: amountIn.toString(),
      fromAddress: ANVIL_ACCOUNT_0,
      toAddress: ANVIL_ACCOUNT_0,
      slippage: '0.005',
      integrator: 'duo-wallet',
    });
    expect(quote).toMatchObject({
      provider: 'lifi',
      tool: 'Test DEX',
      toolKey: 'testdex',
      toAmount: amountOut.toString(),
      approval: { token: token.address, spender: routerAddress, amount: amountIn.toString() },
    });

    const allowance = () =>
      client().readContract({
        address: token.address as Hex,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [acc0.evmAddress as Hex, routerAddress],
      });
    expect(await allowance()).toBe(0n);
    const routerEthBefore = await client().getBalance({ address: routerAddress });
    const tst0 = await service.getBalance(acc0.id, NET_ID, token);

    const txsBefore = (await service.getLocalTxs()).length;
    const rec = await service.executeQuote(acc0.id, quote);
    expect(rec).toMatchObject({
      kind: 'swap',
      direction: 'out',
      from: ANVIL_ACCOUNT_0,
      symbol: 'TST',
      amount: '100',
      status: 'pending',
    });
    expect(rec.title).toBe('Swapped 100 TST → 0.1 ETH');
    expect(rec.bridge).toBeUndefined();

    const txs = await service.getLocalTxs();
    expect(txs).toHaveLength(txsBefore + 2);
    const approve = txs.find((t) => t.kind === 'approve');
    expect(approve).toMatchObject({ status: 'confirmed', to: token.address, title: 'Approved TST' });
    // The approval tx really called approve(router, amount).
    const approveTx = await client().getTransaction({ hash: approve!.hash as Hex });
    expect(approveTx.input).toBe(encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [routerAddress, amountIn] }));
    expect(txs[0].hash).toBe(rec.hash);

    expect(await service.waitForTx(NET_ID, rec.hash)).toBe('confirmed');
    // Router pulled exactly the approved amount (allowance fully consumed) and paid out ETH.
    expect(await allowance()).toBe(0n);
    expect(await service.getBalance(acc0.id, NET_ID, token)).toBe(tst0 - amountIn);
    expect(
      await client().readContract({
        address: token.address as Hex,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [routerAddress],
      }),
    ).toBe(amountIn);
    expect(await client().getBalance({ address: routerAddress })).toBe(routerEthBefore - amountOut);

    // A quote for another account is refused.
    await expect(service.executeQuote(acc1.id, quote)).rejects.toThrow('Quote was created for a different account');
  });

  it('skips the approval when the allowance already covers the swap', async () => {
    const amountIn = 10n * ETH;
    // Pre-approve generously via the dApp signer path.
    const signer = await service.evmSigner(acc0.id);
    const h = await signer.sendTransaction(network, {
      from: acc0.evmAddress as Hex,
      to: token.address as Hex,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [routerAddress, 1_000n * ETH] }),
    });
    expect((await receipt(h)).status).toBe('success');

    const quote = await service.getQuote({
      accountId: acc0.id,
      fromNetworkId: NET_ID,
      toNetworkId: NET_ID,
      fromToken: token,
      toToken: eth,
      amount: '10',
    });
    const before = await service.getLocalTxs();
    const rec = await service.executeQuote(acc0.id, quote);
    const after = await service.getLocalTxs();
    expect(after).toHaveLength(before.length + 1);
    expect(after[0]).toMatchObject({ hash: rec.hash, kind: 'swap' });
    expect(await service.waitForTx(NET_ID, rec.hash)).toBe('confirmed');
    expect(
      await client().readContract({
        address: token.address as Hex,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [acc0.evmAddress as Hex, routerAddress],
      }),
    ).toBe(1_000n * ETH - amountIn);
  });

  it('evmSigner signMessage / signTypedData verify with viem', async () => {
    const signer = await service.evmSigner(acc0.id);
    expect(signer.address).toBe(ANVIL_ACCOUNT_0);

    const sig = await signer.signMessage('hello duo');
    expect(await verifyMessage({ address: ANVIL_ACCOUNT_0, message: 'hello duo', signature: sig })).toBe(true);
    expect(await verifyMessage({ address: ANVIL_ACCOUNT_1, message: 'hello duo', signature: sig })).toBe(false);

    const rawSig = await signer.signMessage({ raw: '0xdeadbeef' });
    expect(await verifyMessage({ address: ANVIL_ACCOUNT_0, message: { raw: '0xdeadbeef' }, signature: rawSig })).toBe(true);

    const typed = {
      domain: { name: 'Duo Test', version: '1', chainId: 31337, verifyingContract: token.address as Hex },
      types: {
        Person: [
          { name: 'name', type: 'string' },
          { name: 'wallet', type: 'address' },
        ],
        Mail: [
          { name: 'from', type: 'Person' },
          { name: 'to', type: 'Person' },
          { name: 'contents', type: 'string' },
        ],
      },
      primaryType: 'Mail',
      message: {
        from: { name: 'Alice', wallet: ANVIL_ACCOUNT_0 },
        to: { name: 'Bob', wallet: ANVIL_ACCOUNT_1 },
        contents: 'Hello, Bob!',
      },
    } as const;
    const typedSig = await signer.signTypedData(typed);
    expect(await verifyTypedData({ ...typed, address: ANVIL_ACCOUNT_0, signature: typedSig })).toBe(true);
    expect(
      await verifyTypedData({
        ...typed,
        message: { ...typed.message, contents: 'tampered' },
        address: ANVIL_ACCOUNT_0,
        signature: typedSig,
      }),
    ).toBe(false);

    // signTransaction produces a raw tx that the node accepts.
    const raw = await signer.signTransaction(network, { to: ANVIL_ACCOUNT_1, value: 1n });
    const hash = await client().sendRawTransaction({ serializedTransaction: raw });
    expect((await receipt(hash)).status).toBe('success');
  });

  it('an imported private-key account can send, and maxSendable leaves only fee headroom', async () => {
    const pk = generatePrivateKey();
    const address = privateKeyToAccount(pk).address;
    const imported = await service.importPrivateKey({ chainType: 'evm', privateKey: pk });
    expect(imported).toMatchObject({ kind: 'privateKey', evmAddress: address, name: 'Imported 1' });
    expect(imported.solanaAddress).toBeUndefined();

    const fund = await service.send({ accountId: acc0.id, networkId: NET_ID, token: eth, to: address, amount: '1' });
    expect(await service.waitForTx(NET_ID, fund.hash)).toBe('confirmed');
    expect(await service.getBalance(imported.id, NET_ID, eth)).toBe(ETH);

    const rec = await service.send({
      accountId: imported.id,
      networkId: NET_ID,
      token: eth,
      to: acc1.evmAddress!,
      amount: '0.1',
    });
    expect(rec.from).toBe(address);
    expect(await service.waitForTx(NET_ID, rec.hash)).toBe('confirmed');
    const afterFirst = await service.getBalance(imported.id, NET_ID, eth);
    expect(afterFirst).toBe(ETH - parseEther('0.1') - (await gasCost(rec.hash)));

    const max = await service.maxSendable(imported.id, NET_ID, eth);
    const maxWei = parseEther(max);
    const est = await client().estimateFeesPerGas();
    expect(maxWei).toBeLessThan(afterFirst);
    expect(afterFirst - maxWei).toBeGreaterThanOrEqual(21_000n * est.maxFeePerGas);
    // Max must be sendable as-is.
    await service.previewSend({ accountId: imported.id, networkId: NET_ID, token: eth, to: acc0.evmAddress!, amount: max });
    const sweep = await service.send({
      accountId: imported.id,
      networkId: NET_ID,
      token: eth,
      to: acc0.evmAddress!,
      amount: max,
    });
    expect(await service.waitForTx(NET_ID, sweep.hash)).toBe('confirmed');
    const left = await service.getBalance(imported.id, NET_ID, eth);
    expect(left).toBeLessThan(parseEther('0.001'));
    expect(left).toBe(afterFirst - maxWei - (await gasCost(sweep.hash)));

    // Imported EVM-only account has no Solana key.
    await expect(service.solanaSigner(imported.id)).rejects.toThrow('This account has no Solana key');
  });

  it('only contacted the mocked LI.FI endpoint over HTTP (no public network access)', () => {
    expect(fetchLog.length).toBeGreaterThan(0);
    for (const u of fetchLog) expect(u.startsWith(`${LIFI_URL}/v1/quote?`)).toBe(true);
  });
});
