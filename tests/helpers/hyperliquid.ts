// Hyperliquid fixtures: the requests the Kairos wallet API sends a self-custodied wallet for HIP-4
// outcome markets, built as the backend builds them (wallet-facing typed data: declared fields only).

const ZERO = '0x0000000000000000000000000000000000000000';
const HL_DOMAIN = (chainId = 42161) => ({ name: 'HyperliquidSignTransaction', version: '1', chainId, verifyingContract: ZERO });
const EIP712_DOMAIN = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
];

export const AGENT = '0x1111111111111111111111111111111111111111';
export const BUILDER = '0x3333333333333333333333333333333333333333';

export function approveAgentTypedData(
  o: { agent?: string; name?: string; nonce?: number; chainId?: number; network?: string } = {},
) {
  return {
    domain: HL_DOMAIN(o.chainId),
    types: {
      'HyperliquidTransaction:ApproveAgent': [
        { name: 'hyperliquidChain', type: 'string' },
        { name: 'agentAddress', type: 'address' },
        { name: 'agentName', type: 'string' },
        { name: 'nonce', type: 'uint64' },
      ],
      EIP712Domain: EIP712_DOMAIN,
    },
    primaryType: 'HyperliquidTransaction:ApproveAgent',
    message: {
      hyperliquidChain: o.network ?? 'Mainnet',
      agentAddress: o.agent ?? AGENT,
      agentName: o.name ?? 'kairos',
      nonce: o.nonce ?? 1792280000000,
    },
  };
}

export function builderFeeTypedData(o: { rate?: string; builder?: string; nonce?: number } = {}) {
  return {
    domain: HL_DOMAIN(),
    types: {
      'HyperliquidTransaction:ApproveBuilderFee': [
        { name: 'hyperliquidChain', type: 'string' },
        { name: 'maxFeeRate', type: 'string' },
        { name: 'builder', type: 'address' },
        { name: 'nonce', type: 'uint64' },
      ],
      EIP712Domain: EIP712_DOMAIN,
    },
    primaryType: 'HyperliquidTransaction:ApproveBuilderFee',
    message: {
      hyperliquidChain: 'Mainnet',
      maxFeeRate: o.rate ?? '0.01%',
      builder: o.builder ?? BUILDER,
      nonce: o.nonce ?? 1792280000001,
    },
  };
}

export function perpsToSpotTypedData(o: { amount?: string; toPerp?: boolean; nonce?: number } = {}) {
  return {
    domain: HL_DOMAIN(),
    types: {
      'HyperliquidTransaction:UsdClassTransfer': [
        { name: 'hyperliquidChain', type: 'string' },
        { name: 'amount', type: 'string' },
        { name: 'toPerp', type: 'bool' },
        { name: 'nonce', type: 'uint64' },
      ],
      EIP712Domain: EIP712_DOMAIN,
    },
    primaryType: 'HyperliquidTransaction:UsdClassTransfer',
    message: {
      hyperliquidChain: 'Mainnet',
      amount: o.amount ?? '5.06',
      toPerp: o.toPerp ?? false,
      nonce: o.nonce ?? 1792280000002,
    },
  };
}

/** A user-signed action Kairos never needs: moving USDC out of the account. */
export function withdrawTypedData(destination: string) {
  return {
    domain: HL_DOMAIN(),
    types: {
      'HyperliquidTransaction:Withdraw': [
        { name: 'hyperliquidChain', type: 'string' },
        { name: 'destination', type: 'string' },
        { name: 'amount', type: 'string' },
        { name: 'time', type: 'uint64' },
      ],
      EIP712Domain: EIP712_DOMAIN,
    },
    primaryType: 'HyperliquidTransaction:Withdraw',
    message: { hyperliquidChain: 'Mainnet', destination, amount: '100', time: 1792280000003 },
  };
}

/** Kairos' order authorization: the wallet's signature over exactly the order Kairos then places with the agent. */
export function placeOrderTypedData(
  wallet: string,
  o: Partial<{
    market: string;
    outcome: string;
    side: string;
    price: string;
    size: string;
    timeInForce: string;
    postOnly: boolean;
    action: string;
    expiresAt: number;
  }> = {},
) {
  return {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
      ],
      PlaceOrder: [
        { name: 'wallet', type: 'address' },
        { name: 'market', type: 'string' },
        { name: 'outcome', type: 'string' },
        { name: 'side', type: 'string' },
        { name: 'price', type: 'string' },
        { name: 'size', type: 'string' },
        { name: 'timeInForce', type: 'string' },
        { name: 'postOnly', type: 'bool' },
        { name: 'action', type: 'string' },
        { name: 'expiresAt', type: 'uint256' },
      ],
    },
    primaryType: 'PlaceOrder',
    domain: { name: 'Kairos', version: '1', chainId: 42161 },
    message: {
      wallet,
      market: 'hyperliquid:13228',
      outcome: 'SF',
      side: 'buy',
      price: '0.5',
      size: '10',
      timeInForce: 'GTC',
      postOnly: false,
      action: 'a1',
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      ...o,
    },
  };
}

export function hlStep(wallet: string, td: unknown, description = 'Confirm this Hyperliquid order') {
  return {
    id: 'hl',
    type: 'order',
    status: 'needs_signature',
    venue: 'hyperliquid',
    chainId: '0xa4b1',
    description,
    request: { method: 'eth_signTypedData_v4', params: [wallet, JSON.stringify(td)] },
    result: null,
    error: null,
  };
}
