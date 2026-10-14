import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NETWORKS,
  LIFI_SOLANA_CHAIN_ID,
  explorerAddressUrl,
  explorerTxUrl,
  validateNetwork,
} from '../../src/core/networks';
import type { EvmNetwork, Network, SolanaNetwork } from '../../src/core/types';

const byId = <T extends Network>(id: string) => DEFAULT_NETWORKS.find((n) => n.id === id) as T;
const eth = byId<EvmNetwork>('eth');
const solana = byId<SolanaNetwork>('solana');
const devnet = byId<SolanaNetwork>('solana-devnet');

const custom = (over: Partial<EvmNetwork> = {}): EvmNetwork => ({
  type: 'evm',
  id: 'my-chain',
  name: 'My Chain',
  chainId: 999_999,
  rpcUrl: 'https://rpc.example.com',
  explorerUrl: 'https://explorer.example.com',
  nativeCurrency: { name: 'Coin', symbol: 'CN', decimals: 18 },
  history: { kind: 'none' },
  testnet: false,
  enabled: true,
  custom: true,
  ...over,
});

describe('DEFAULT_NETWORKS', () => {
  it('has unique ids and EVM chain ids', () => {
    const ids = DEFAULT_NETWORKS.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    const chainIds = DEFAULT_NETWORKS.flatMap((n) => (n.type === 'evm' ? [n.chainId] : []));
    expect(new Set(chainIds).size).toBe(chainIds.length);
  });

  it('every default network passes validation', () => {
    for (const n of DEFAULT_NETWORKS) expect(validateNetwork(n, DEFAULT_NETWORKS), n.id).toEqual([]);
  });

  it('only mainnets are routable via LI.FI', () => {
    for (const n of DEFAULT_NETWORKS) {
      if (n.testnet) expect(n.lifiChainId, n.id).toBeUndefined();
      else if (n.type === 'evm') expect(n.lifiChainId, n.id).toBe(n.chainId);
      else expect(n.lifiChainId).toBe(LIFI_SOLANA_CHAIN_ID);
    }
  });
});

describe('validateNetwork', () => {
  it('accepts a valid custom network', () => {
    expect(validateNetwork(custom(), DEFAULT_NETWORKS)).toEqual([]);
    expect(validateNetwork(custom({ explorerUrl: '' }), DEFAULT_NETWORKS)).toEqual([]);
    expect(validateNetwork(custom({ rpcUrl: 'http://127.0.0.1:8545' }), DEFAULT_NETWORKS)).toEqual([]);
  });

  it.each(['', 'My-Chain', 'my chain', 'my_chain', 'chain!'])('rejects id %j', (id) => {
    expect(validateNetwork(custom({ id }), [])).toEqual(['Id must be lowercase letters, digits or dashes']);
  });

  it('requires a name and currency symbol', () => {
    expect(validateNetwork(custom({ name: '  ' }), [])).toEqual(['Name is required']);
    expect(validateNetwork(custom({ nativeCurrency: { name: 'x', symbol: ' ', decimals: 18 } }), [])).toEqual([
      'Currency symbol is required',
    ]);
  });

  it.each(['ftp://rpc.example.com', 'rpc.example.com', 'localhost:8545', 'wss://rpc.example.com', ''])(
    'rejects RPC URL %j',
    (rpcUrl) => {
      expect(validateNetwork(custom({ rpcUrl }), [])).toEqual(['RPC URL must start with http:// or https://']);
    },
  );

  it('rejects a non-http explorer URL', () => {
    expect(validateNetwork(custom({ explorerUrl: 'explorer.example.com' }), [])).toEqual([
      'Explorer URL must start with http(s)://',
    ]);
    expect(validateNetwork(custom({ explorerUrl: 'javascript:alert(1)' }), [])).toEqual([
      'Explorer URL must start with http(s)://',
    ]);
  });

  it.each([-1, 37, 1.5, NaN])('rejects decimals %s', (decimals) => {
    expect(validateNetwork(custom({ nativeCurrency: { name: 'x', symbol: 'X', decimals } }), [])).toEqual([
      'Decimals must be an integer between 0 and 36',
    ]);
  });

  it.each([0, 36])('accepts boundary decimals %s', (decimals) => {
    expect(validateNetwork(custom({ nativeCurrency: { name: 'x', symbol: 'X', decimals } }), [])).toEqual([]);
  });

  it.each([0, -1, 1.5, NaN])('rejects chain id %s', (chainId) => {
    expect(validateNetwork(custom({ chainId }), [])).toContain('Chain ID must be a positive integer');
  });

  it('rejects a chain id already used by another network', () => {
    expect(validateNetwork(custom({ chainId: 1 }), DEFAULT_NETWORKS)).toEqual(['Chain ID 1 is already used by Ethereum']);
    expect(validateNetwork(custom({ chainId: 8453 }), DEFAULT_NETWORKS)).toEqual(['Chain ID 8453 is already used by Base']);
  });

  it('allows editing a network that keeps its own chain id', () => {
    expect(validateNetwork({ ...eth, name: 'Ethereum (my RPC)', rpcUrl: 'https://my.rpc' }, DEFAULT_NETWORKS)).toEqual([]);
  });

  it('does not check chain id for Solana networks', () => {
    const s: SolanaNetwork = { ...devnet, id: 'my-sol', cluster: 'custom', rpcUrl: 'http://localhost:8899' };
    expect(validateNetwork(s, DEFAULT_NETWORKS)).toEqual([]);
  });

  it('reports multiple problems at once', () => {
    const errors = validateNetwork(custom({ id: 'X', name: '', rpcUrl: 'nope', chainId: 1 }), DEFAULT_NETWORKS);
    expect(errors).toHaveLength(4);
  });
});

describe('explorer URLs', () => {
  it('EVM', () => {
    expect(explorerTxUrl(eth, '0xabc')).toBe('https://etherscan.io/tx/0xabc');
    expect(explorerAddressUrl(eth, '0xdef')).toBe('https://etherscan.io/address/0xdef');
  });

  it('EVM strips a trailing slash', () => {
    const n = custom({ explorerUrl: 'https://explorer.example.com/' });
    expect(explorerTxUrl(n, '0xabc')).toBe('https://explorer.example.com/tx/0xabc');
    expect(explorerAddressUrl(n, '0xdef')).toBe('https://explorer.example.com/address/0xdef');
  });

  it('Solana mainnet has no cluster query', () => {
    expect(explorerTxUrl(solana, 'sig1')).toBe('https://explorer.solana.com/tx/sig1');
    expect(explorerAddressUrl(solana, 'Addr1')).toBe('https://explorer.solana.com/address/Addr1');
  });

  it('Solana devnet/testnet add the cluster query', () => {
    expect(explorerTxUrl(devnet, 'sig1')).toBe('https://explorer.solana.com/tx/sig1?cluster=devnet');
    expect(explorerAddressUrl(devnet, 'Addr1')).toBe('https://explorer.solana.com/address/Addr1?cluster=devnet');
    const testnet: SolanaNetwork = { ...devnet, cluster: 'testnet' };
    expect(explorerTxUrl(testnet, 'sig1')).toBe('https://explorer.solana.com/tx/sig1?cluster=testnet');
  });

  it('Solana custom cluster encodes the RPC URL', () => {
    const local: SolanaNetwork = { ...devnet, id: 'local', cluster: 'custom', rpcUrl: 'http://127.0.0.1:8899' };
    expect(explorerTxUrl(local, 'sig1')).toBe(
      'https://explorer.solana.com/tx/sig1?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899',
    );
    expect(explorerAddressUrl(local, 'A')).toBe(
      'https://explorer.solana.com/address/A?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899',
    );
  });

  it('Solana strips a trailing slash too', () => {
    const n: SolanaNetwork = { ...solana, explorerUrl: 'https://explorer.solana.com/' };
    expect(explorerTxUrl(n, 'sig1')).toBe('https://explorer.solana.com/tx/sig1');
    expect(explorerAddressUrl({ ...devnet, explorerUrl: 'https://solscan.io/' }, 'A')).toBe(
      'https://solscan.io/address/A?cluster=devnet',
    );
  });
});
