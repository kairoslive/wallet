import { useEffect, useState } from 'react';
import type { Portfolio } from '../../core/wallet/service';
import { api } from '../lib/api';

/** Cached portfolio first (instant), then a fresh fetch. */
export function usePortfolio(accountId: string | undefined) {
  const [portfolio, setPortfolio] = useState<Portfolio>();
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!accountId) return;
    let stale = false;
    setLoading(true);
    api.getCachedPortfolio(accountId).then((p) => !stale && p && setPortfolio((cur) => cur ?? p));
    api
      .getPortfolio(accountId)
      .then((p) => !stale && setPortfolio(p))
      .catch(() => {})
      .finally(() => !stale && setLoading(false));
    return () => {
      stale = true;
    };
  }, [accountId]);
  return { portfolio, loading };
}
