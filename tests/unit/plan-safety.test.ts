import { describe, expect, it } from 'vitest';
import { PLAN_SIGNATURES, checkPlanRequests, wholeSecond } from '../../src/core/predictions/plans';

describe('trade plan safety', () => {
  it('floors deadlines to the whole seconds the SDK accepts', () => {
    expect(wholeSecond(1_700_000_000_999).getTime()).toBe(1_700_000_000_000);
    expect(() => wholeSecond(Number.NaN)).toThrow('Invalid deadline');
  });

  it('accepts only plan, trade and funding signatures', () => {
    const plan = (requests: { purpose: string; kind: string }[]) => ({ requests });
    expect(() =>
      checkPlanRequests(
        plan([
          { purpose: 'plan', kind: 'signature' },
          { purpose: 'trade', kind: 'signature' },
          { purpose: 'funding', kind: 'signature' },
        ]),
      ),
    ).not.toThrow();
    expect(() => checkPlanRequests(plan([{ purpose: 'permit', kind: 'signature' }]))).toThrow('unexpected permit');
    expect(() => checkPlanRequests(plan([{ purpose: 'trade', kind: 'transaction' }]))).toThrow('Refused to sign');
  });

  it('never signs typed data outside the plan’s own kinds', () => {
    expect(PLAN_SIGNATURES.has('Permit')).toBe(false);
    expect(PLAN_SIGNATURES.has('TradePlan')).toBe(true);
  });
});
