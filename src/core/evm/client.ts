import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  erc20Abi,
  http,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionRequest,
  type TypedDataDefinition,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { EvmNetwork, Token } from '../types';

const clients = new Map<string, PublicClient>();

export function toViemChain(n: EvmNetwork): Chain {
  return defineChain({
    id: n.chainId,
    name: n.name,
    nativeCurrency: n.nativeCurrency,
    rpcUrls: { default: { http: [n.rpcUrl] } },
    blockExplorers: n.explorerUrl ? { default: { name: 'Explorer', url: n.explorerUrl } } : undefined,
  });
}

export function publicClient(n: EvmNetwork): PublicClient {
  const key = `${n.chainId}|${n.rpcUrl}`;
  let c = clients.get(key);
  if (!c) {
    c = createPublicClient({
      chain: toViemChain(n),
      transport: http(n.rpcUrl, { batch: { batchSize: 50, wait: 10 }, retryCount: 2, timeout: 20_000 }),
    }) as PublicClient;
    clients.set(key, c);
  }
  return c;
}

function walletClient(n: EvmNetwork, privateKey: Hex) {
  return createWalletClient({
    account: privateKeyToAccount(privateKey),
    chain: toViemChain(n),
    transport: http(n.rpcUrl, { retryCount: 1, timeout: 30_000 }),
  });
}

export async function getNativeBalance(n: EvmNetwork, address: string): Promise<bigint> {
  return publicClient(n).getBalance({ address: address as Hex });
}

export async function getTokenBalances(n: EvmNetwork, address: string, tokens: Token[]): Promise<Map<string, bigint>> {
  const client = publicClient(n);
  const out = new Map<string, bigint>();
  await Promise.all(
    tokens.map(async (t) => {
      try {
        const bal = await client.readContract({
          address: t.address as Hex,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [address as Hex],
        });
        out.set(t.address.toLowerCase(), bal);
      } catch {
        // Token might not exist on this RPC (e.g. misconfigured custom token); skip it.
      }
    }),
  );
  return out;
}

export async function getTokenMetadata(n: EvmNetwork, address: string): Promise<Omit<Token, 'networkId'>> {
  const client = publicClient(n);
  const a = address as Hex;
  const [symbol, name, decimals] = await Promise.all([
    client.readContract({ address: a, abi: erc20Abi, functionName: 'symbol' }),
    client.readContract({ address: a, abi: erc20Abi, functionName: 'name' }).catch(() => ''),
    client.readContract({ address: a, abi: erc20Abi, functionName: 'decimals' }),
  ]);
  return { address, symbol, name: name || symbol, decimals: Number(decimals) };
}

export interface EvmTransferParams {
  from: string;
  to: string;
  token: Pick<Token, 'address'>;
  amount: bigint;
}

export function buildTransferTx(p: EvmTransferParams): TransactionRequest {
  if (p.token.address === 'native') {
    return { from: p.from as Hex, to: p.to as Hex, value: p.amount };
  }
  return {
    from: p.from as Hex,
    to: p.token.address as Hex,
    value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [p.to as Hex, p.amount] }),
  };
}

export interface EvmFeeEstimate {
  gas: bigint;
  /** Effective max fee per gas used for the worst-case fee. */
  maxFeePerGas: bigint;
  maxPriorityFeePerGas?: bigint;
  gasPrice?: bigint;
  /** Worst-case network fee in wei. */
  fee: bigint;
}

export async function estimateTx(n: EvmNetwork, tx: TransactionRequest): Promise<EvmFeeEstimate> {
  const client = publicClient(n);
  const gas = tx.gas ?? (await client.estimateGas({ ...tx, account: tx.from as Hex } as never));
  // Add a 20% buffer for contract calls whose cost can shift between estimate and inclusion.
  const gasLimit = tx.data && tx.data !== '0x' ? (gas * 120n) / 100n : gas;
  try {
    const fees = await client.estimateFeesPerGas();
    return {
      gas: gasLimit,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      fee: gasLimit * fees.maxFeePerGas,
    };
  } catch {
    const gasPrice = await client.getGasPrice();
    return { gas: gasLimit, maxFeePerGas: gasPrice, gasPrice, fee: gasLimit * gasPrice };
  }
}

export async function sendTx(n: EvmNetwork, privateKey: Hex, tx: TransactionRequest, fee?: EvmFeeEstimate): Promise<Hex> {
  const wallet = walletClient(n, privateKey);
  const est = fee ?? (await estimateTx(n, { ...tx, from: wallet.account.address }));
  const base = {
    to: tx.to ?? undefined,
    data: tx.data,
    value: tx.value ?? 0n,
    gas: est.gas,
    nonce: tx.nonce,
  };
  const request = est.gasPrice
    ? { ...base, gasPrice: est.gasPrice }
    : { ...base, maxFeePerGas: est.maxFeePerGas, maxPriorityFeePerGas: est.maxPriorityFeePerGas };
  return wallet.sendTransaction(request as never);
}

export async function waitForTx(n: EvmNetwork, hash: Hex, timeoutMs = 120_000) {
  const receipt = await publicClient(n).waitForTransactionReceipt({ hash, timeout: timeoutMs, pollingInterval: 1_000 });
  return { status: receipt.status === 'success' ? ('confirmed' as const) : ('failed' as const), receipt };
}

export async function getTxStatus(n: EvmNetwork, hash: Hex): Promise<'pending' | 'confirmed' | 'failed'> {
  try {
    const r = await publicClient(n).getTransactionReceipt({ hash });
    return r.status === 'success' ? 'confirmed' : 'failed';
  } catch {
    return 'pending';
  }
}

export async function getAllowance(n: EvmNetwork, token: string, owner: string, spender: string): Promise<bigint> {
  return publicClient(n).readContract({
    address: token as Hex,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner as Hex, spender as Hex],
  });
}

export function buildApproveTx(from: string, token: string, spender: string, amount: bigint): TransactionRequest {
  return {
    from: from as Hex,
    to: token as Hex,
    value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender as Hex, amount] }),
  };
}

export async function signMessage(privateKey: Hex, message: string | { raw: Hex }): Promise<Hex> {
  return privateKeyToAccount(privateKey).signMessage({ message });
}

export async function signTypedData(privateKey: Hex, typed: TypedDataDefinition): Promise<Hex> {
  return privateKeyToAccount(privateKey).signTypedData(typed as never);
}

export async function signTransaction(n: EvmNetwork, privateKey: Hex, tx: TransactionRequest): Promise<Hex> {
  const wallet = walletClient(n, privateKey);
  const prepared = await wallet.prepareTransactionRequest({ ...tx, account: wallet.account, chain: wallet.chain } as never);
  return wallet.account.signTransaction(prepared as never);
}

export async function getChainId(rpcUrl: string): Promise<number> {
  const c = createPublicClient({ transport: http(rpcUrl, { timeout: 10_000 }) });
  return c.getChainId();
}

/** False if the node no longer knows the transaction (dropped or replaced). */
export async function txKnown(n: EvmNetwork, hash: Hex): Promise<boolean> {
  try {
    await publicClient(n).getTransaction({ hash });
    return true;
  } catch {
    return false;
  }
}
