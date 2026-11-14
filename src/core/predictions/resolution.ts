import type { MarketDetail, Resolution } from './types';

/** The stage a market's resolution is at, in the order markets move through them. */
export type ResolutionStage = 'open' | 'awaiting' | 'proposed' | 'disputed' | 'resolved';

/** Plain words for where a resolution stands, with the outcome named. */
export function describeResolution(
  market: Pick<MarketDetail, 'tokens' | 'endDate' | 'status'>,
  r: Resolution,
  now = Date.now(),
): { stage: ResolutionStage; title: string; detail?: string; winner?: string } {
  const name = (fraction?: number) =>
    fraction === undefined
      ? undefined
      : fraction >= 0.99
        ? market.tokens[0]?.outcome
        : fraction <= 0.01
          ? market.tokens[1]?.outcome
          : '50-50 split';
  if (r.payouts?.length) {
    const top = r.payouts.indexOf(Math.max(...r.payouts));
    const split = r.payouts.filter((p) => p > 0).length > 1;
    const winner = split ? 'Split' : market.tokens[top]?.outcome;
    return {
      stage: 'resolved',
      title: split ? 'Resolved as a split' : `Resolved: ${winner}`,
      detail: r.resolvedAt
        ? new Date(r.resolvedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
        : undefined,
      winner,
    };
  }
  if (r.status === 'disputed' || (r.disputes > 0 && r.status !== 'proposed')) {
    return { stage: 'disputed', title: 'Result disputed', detail: 'The proposed result was challenged and is being reviewed.' };
  }
  if (r.status === 'proposed' || r.proposedPrice !== undefined) {
    const ends = r.challengeEndsAt ? Date.parse(r.challengeEndsAt) : undefined;
    const left = ends ? ends - now : undefined;
    return {
      stage: 'proposed',
      title: `Result proposed: ${name(r.proposedPrice) ?? 'pending'}`,
      detail:
        left !== undefined
          ? left > 0
            ? `Final in ${left > 3_600_000 ? `${Math.round(left / 3_600_000)}h` : `${Math.max(1, Math.round(left / 60_000))}m`} unless disputed`
            : 'Challenge window over, settling'
          : 'Final unless disputed',
    };
  }
  const ended = market.endDate ? Date.parse(market.endDate) <= now : market.status !== 'open';
  return ended
    ? { stage: 'awaiting', title: 'Waiting for the result', detail: 'The result is proposed once the outcome is known.' }
    : {
        stage: 'open',
        title: 'Trading open',
        detail: market.endDate
          ? `Ends ${new Date(market.endDate).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`
          : undefined,
      };
}
