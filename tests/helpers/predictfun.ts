// Predict.fun fixtures: the approvals and order the Kairos wallet API asks a self-custodied wallet for.

export const USDT = '0x55d398326f99059fF775485246999027B3197955';
const WCOL = '0x66239b70133773A72A0D589E5564E88a50Cd39e7';
const YB_WCOL = '0xCfb9beF5F7B748aC72311F057f3a888BC73334D9';
export const EXCHANGES = {
  plain: '0x8BC070BEdAB741406F4B1Eb65A72bee27894B689',
  negRisk: '0x365fb81bd4A24D6303cd2F19c349dE6894D8d58A',
  yield: '0x6bEb5a40C032AFc305961162d8204CDA16DECFa5',
  yieldNegRisk: '0x8A289d458f5a134bA40015085A8F50Ffb681B41d',
};
const CTF = {
  plain: '0x22DA1810B194ca018378464a58f6Ac2B10C9d244',
  yield: '0x9400F8Ad57e9e0F352345935d6D3175975eb1d9F',
  yieldNegRisk: '0xF64b0b318AAf83BD9071110af24D24445719A07F',
};
const ADAPTER = {
  negRisk: '0xc3Cf7c252f65E0d8D88537dF96569AE94a7F1A6E',
  yieldNegRisk: '0x41dCe1A4B8FB5e6327701750aF6231B7CD0B2A40',
};

const word = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
export const approveCall = (token: string, spender: string) => ({
  to: token,
  data: `0x095ea7b3${word(spender)}${'f'.repeat(64)}`,
  value: '0x0',
});
export const operatorCall = (ctf: string, operator: string) => ({
  to: ctf,
  data: `0xa22cb465${word(operator)}${word('1')}`,
  value: '0x0',
});

/** The 12 approvals a fresh wallet is asked for (6 ERC-20, 6 ERC-1155), as Kairos builds them. */
export const APPROVALS = [
  approveCall(USDT, EXCHANGES.plain),
  operatorCall(CTF.plain, EXCHANGES.plain),
  approveCall(USDT, EXCHANGES.yield),
  operatorCall(CTF.yield, EXCHANGES.yield),
  approveCall(USDT, EXCHANGES.negRisk),
  approveCall(WCOL, EXCHANGES.negRisk),
  operatorCall(CTF.plain, EXCHANGES.negRisk),
  operatorCall(CTF.plain, ADAPTER.negRisk),
  approveCall(USDT, EXCHANGES.yieldNegRisk),
  approveCall(YB_WCOL, EXCHANGES.yieldNegRisk),
  operatorCall(CTF.yieldNegRisk, EXCHANGES.yieldNegRisk),
  operatorCall(CTF.yieldNegRisk, ADAPTER.yieldNegRisk),
];

export function sendCallsStep(wallet: string, calls = APPROVALS, extra: Record<string, unknown> = {}) {
  return {
    id: 'pf',
    type: 'order',
    status: 'needs_signature',
    venue: 'predictfun',
    chainId: '0x38',
    description: 'Approve Predict.fun on BNB Chain',
    request: {
      method: 'wallet_sendCalls',
      params: [{ version: '2.0.0', chainId: '0x38', from: wallet, atomicRequired: false, calls }],
    },
    fallbackRequests: calls.map((c) => ({ method: 'eth_sendTransaction', params: [{ from: wallet, ...c }] })),
    result: null,
    error: null,
    ...extra,
  };
}

export const LOGIN_MESSAGE = 'Please sign this message to log in. Timestamp: 1792185256';

export function venueLoginStep(wallet: string, message = LOGIN_MESSAGE) {
  return {
    id: 'pf',
    type: 'order',
    status: 'needs_signature',
    venue: 'predictfun',
    chainId: null,
    description: 'Sign in to Predict.fun',
    request: { method: 'personal_sign', params: [`0x${Buffer.from(message).toString('hex')}`, wallet] },
    result: null,
    error: null,
  };
}

/** A Predict.fun `Order` as the wallet API sends it (amounts in 18-decimal units). */
export function orderTypedData(
  wallet: string,
  o: { tokenId: string; side?: 0 | 1; makerAmount: string; takerAmount?: string; exchange?: string },
) {
  return {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      Order: [
        { name: 'salt', type: 'uint256' },
        { name: 'maker', type: 'address' },
        { name: 'signer', type: 'address' },
        { name: 'taker', type: 'address' },
        { name: 'tokenId', type: 'uint256' },
        { name: 'makerAmount', type: 'uint256' },
        { name: 'takerAmount', type: 'uint256' },
        { name: 'expiration', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'feeRateBps', type: 'uint256' },
        { name: 'side', type: 'uint8' },
        { name: 'signatureType', type: 'uint8' },
      ],
    },
    primaryType: 'Order',
    domain: { name: 'predict.fun CTF Exchange', version: '1', chainId: 56, verifyingContract: o.exchange ?? EXCHANGES.plain },
    message: {
      salt: '12345',
      maker: wallet.toLowerCase(),
      signer: wallet.toLowerCase(),
      taker: '0x0000000000000000000000000000000000000000',
      tokenId: o.tokenId,
      makerAmount: o.makerAmount,
      takerAmount: o.takerAmount ?? '10000000000000000000',
      expiration: '1792270000',
      nonce: '0',
      feeRateBps: '200',
      side: o.side ?? 0,
      signatureType: 0,
    },
  };
}

export function orderStep(wallet: string, td: unknown) {
  return {
    id: 'pf',
    type: 'order',
    status: 'needs_signature',
    venue: 'predictfun',
    chainId: '0x38',
    description: 'Confirm this order',
    request: { method: 'eth_signTypedData_v4', params: [wallet, JSON.stringify(td)] },
    result: null,
    error: null,
  };
}
