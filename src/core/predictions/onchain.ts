import { encodeFunctionData, parseAbi, type Hex } from 'viem';
import { CTF_ADDRESS, POSITION_MANAGER_ADDRESS, PUSD_ADDRESS, UnsafeSigningRequestError } from './verify';

export type OnchainRequest = { market: string; amountRaw: string; idempotencyKey?: string; executeBefore?: string } & (
  { operation: 'split' | 'merge'; outcome?: never } | { operation: 'redeem'; outcome: 0 | 1 }
);

export const POLYMARKET_ROUTER = '0x12121212006e4cd160d18e3f00711da5c3372600';
const ADAPTERS = ['0xada100db00ca00073811820692005400218fce1f', '0xada2005600dec949baf300f4c6120000bdb6eaab'] as const;
const EMPTY_PARENT = ('0x' + '00'.repeat(32)) as Hex;
const ROUTER_ABI = parseAbi([
  'function split(bytes31 conditionId, uint256 amount)',
  'function merge(bytes31 conditionId, uint256 amount)',
  'function redeem(bytes31 conditionId, uint256 outcome, uint256 amount)',
]);
const ADAPTER_ABI = parseAbi([
  'function splitPosition(address collateral, bytes32 parent, bytes32 conditionId, uint256[] partition, uint256 amount)',
  'function mergePositions(address collateral, bytes32 parent, bytes32 conditionId, uint256[] partition, uint256 amount)',
]);
const APPROVAL_ABI = parseAbi([
  'function approve(address spender, uint256 amount)',
  'function setApprovalForAll(address operator, bool approved)',
]);

type BatchCall = { target: string; value: unknown; data: string };

export function onchainCondition(market: string): Hex {
  const condition = market.toLowerCase().replace(/^polymarket:/, '');
  if (!/^0x[0-9a-f]{64}$/.test(condition)) throw new Error('This operation requires a market condition ID.');
  return condition as Hex;
}

/** Match the actual operation and approval calldata against the user's selected market. */
export function verifyOnchainBatch(calls: unknown, input: OnchainRequest): void {
  const fail = () =>
    new UnsafeSigningRequestError('the position operation differs from the requested market, outcome, or amount');
  if (!Array.isArray(calls) || calls.length !== 2) throw fail();
  const [approval, operation] = calls as BatchCall[];
  if (!approval || !operation || String(approval.value) !== '0' || String(operation.value) !== '0') throw fail();
  const condition = onchainCondition(input.market);
  const amount = BigInt(input.amountRaw);
  const target = operation.target?.toLowerCase() as Hex;
  const modern = target === POLYMARKET_ROUTER;
  let expected: Hex;
  if (modern && condition.endsWith('00')) {
    const id = condition.slice(0, -2) as Hex;
    expected =
      input.operation === 'redeem'
        ? encodeFunctionData({ abi: ROUTER_ABI, functionName: 'redeem', args: [id, BigInt(input.outcome), amount] })
        : encodeFunctionData({ abi: ROUTER_ABI, functionName: input.operation, args: [id, amount] });
  } else if (input.operation !== 'redeem' && ADAPTERS.some((address) => address === target)) {
    expected = encodeFunctionData({
      abi: ADAPTER_ABI,
      functionName: input.operation === 'split' ? 'splitPosition' : 'mergePositions',
      args: [PUSD_ADDRESS, EMPTY_PARENT, condition, [1n, 2n], amount],
    });
  } else {
    throw fail();
  }
  const operatorAsset = input.operation === 'split' ? PUSD_ADDRESS : modern ? POSITION_MANAGER_ADDRESS : CTF_ADDRESS;
  const approvalData =
    input.operation === 'split'
      ? encodeFunctionData({ abi: APPROVAL_ABI, functionName: 'approve', args: [target, amount] })
      : encodeFunctionData({ abi: APPROVAL_ABI, functionName: 'setApprovalForAll', args: [target, true] });
  if (
    operation.data?.toLowerCase() !== expected ||
    approval.target?.toLowerCase() !== operatorAsset.toLowerCase() ||
    approval.data?.toLowerCase() !== approvalData
  )
    throw fail();
}
