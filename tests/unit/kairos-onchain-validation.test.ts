import { describe, expect, it } from 'vitest';
import { encodeFunctionData, parseAbi } from 'viem';
import { POLYMARKET_ROUTER, verifyOnchainBatch } from '../../src/core/predictions/onchain';
import { POSITION_MANAGER_ADDRESS } from '../../src/core/predictions/verify';

const id = ('0x03' + '12'.repeat(30)) as `0x${string}`;
const market = `polymarket:${id}00`;
const router = parseAbi(['function redeem(bytes31 condition, uint256 outcome, uint256 amount)']);
const shares = parseAbi(['function setApprovalForAll(address operator, bool approved)']);
const request = { operation: 'redeem', market, outcome: 0, amountRaw: '1000000' } as const;

function batch(condition = id, outcome = 0n, amount = 1_000_000n) {
  return [
    {
      target: POSITION_MANAGER_ADDRESS,
      value: '0',
      data: encodeFunctionData({ abi: shares, functionName: 'setApprovalForAll', args: [POLYMARKET_ROUTER, true] }),
    },
    {
      target: POLYMARKET_ROUTER,
      value: '0',
      data: encodeFunctionData({ abi: router, functionName: 'redeem', args: [condition, outcome, amount] }),
    },
  ];
}

describe('on-chain position batch validation', () => {
  it('accepts the approved Router redemption with the exact selected condition, side and amount', () => {
    expect(() => verifyOnchainBatch(batch(), request)).not.toThrow();
  });

  it('refuses a different condition, outcome, amount, nonzero value or trailing calldata', () => {
    const other = ('0x03' + '44'.repeat(30)) as typeof id;
    const value = batch();
    value[1].value = '1';
    const trailing = batch();
    trailing[1].data = `${trailing[1].data}00`;
    for (const calls of [batch(other), batch(id, 1n), batch(id, 0n, 1_000_001n), value, trailing]) {
      expect(() => verifyOnchainBatch(calls, request)).toThrow(/position operation differs/);
    }
  });
});
