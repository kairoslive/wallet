import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { SearchResult } from '../../core/predictions/search';
import { api } from '../lib/api';
import { back, navigate } from '../lib/router';
import { fetchQuery, getQueryData } from '../lib/query';
import { prefetchMarket } from '../lib/predictQueries';
import { ErrorNote, Screen } from '../components/ui';
import { Icon } from '../components/Icon';
import { compactUsd, ListSkeleton, pct } from './Predict';

const RECENT_KEY = 'predict.recentSearches';
const SUGGESTIONS = ['Bitcoin', 'Fed rates', 'NFL', 'Election', 'Ethereum', 'Premier League'];
/** Long enough to skip mid-word requests, short enough to feel instant. */
const DEBOUNCE_MS = 140;

function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 6) : [];
  } catch {
    return [];
  }
}

function remember(q: string) {
  try {
    const next = [q, ...readRecent().filter((r) => r.toLowerCase() !== q.toLowerCase())].slice(0, 6);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable: recent searches just aren't kept.
  }
}

const searchKey = (q: string) => `p/search/${q.trim().toLowerCase()}`;

/**
 * Market search across every venue at once. Results arrive as you type (stale answers are
 * dropped), the same question listed on several venues shows once, and arrow keys + Enter open one.
 */
export function PredictSearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>();
  const [error, setError] = useState<string>();
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState(readRecent);
  const seq = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const q = query.trim();

  useEffect(() => {
    input.current?.focus();
  }, []);

  useEffect(() => {
    const id = ++seq.current;
    setError(undefined);
    setActive(0);
    if (q.length < 2) {
      setResults(undefined);
      return;
    }
    // A query typed before shows its results at once.
    const cached = getQueryData<SearchResult[]>(searchKey(q));
    if (cached) setResults(cached);
    const t = setTimeout(
      () =>
        fetchQuery(searchKey(q), () => api.predictionSearch(q, 30), 60_000)
          .then((r) => id === seq.current && setResults(r))
          .catch((e: Error) => id === seq.current && setError(e.message)),
      cached ? 0 : DEBOUNCE_MS,
    );
    return () => clearTimeout(t);
  }, [q]);

  const open = (r: SearchResult) => {
    remember(q || r.title);
    navigate('/predict/market', { id: r.marketId });
  };

  const onKey = (e: KeyboardEvent) => {
    if (!results?.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(results.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      open(results[active]);
    }
  };

  useEffect(() => {
    document.getElementById(`search-result-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <Screen>
      <div className="search-bar">
        <div className="search-input">
          <Icon name="search" size={16} />
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search markets"
            aria-label="Search markets"
            role="combobox"
            aria-expanded={!!results?.length}
            aria-controls="search-results"
            aria-activedescendant={results?.length ? `search-result-${active}` : undefined}
            autoComplete="off"
            spellCheck={false}
            data-testid="search-input"
          />
          {query && (
            <button
              className="search-clear"
              aria-label="Clear"
              onClick={() => {
                setQuery('');
                input.current?.focus();
              }}
            >
              <Icon name="close" size={14} />
            </button>
          )}
        </div>
        <button className="link-btn" onClick={() => back('/predict')}>
          Cancel
        </button>
      </div>
      <div className="screen-body" style={{ paddingTop: 8 }}>
        {q.length < 2 ? (
          <div className="stack" style={{ gap: 16 }}>
            {recent.length > 0 && (
              <div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div className="section-label">Recent</div>
                  <button
                    className="link-btn small"
                    onClick={() => {
                      try {
                        localStorage.removeItem(RECENT_KEY);
                      } catch {
                        // Nothing to clear.
                      }
                      setRecent([]);
                    }}
                  >
                    Clear
                  </button>
                </div>
                <div className="list">
                  {recent.map((r) => (
                    <button key={r} className="list-item recent-row" onClick={() => setQuery(r)}>
                      <Icon name="clock" size={16} />
                      <span className="main ellipsis">{r}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div>
              <div className="section-label">Try</div>
              <div className="chip-row wrap">
                {SUGGESTIONS.map((s) => (
                  <button key={s} className="chip" onClick={() => setQuery(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <>
            <ErrorNote error={error} />
            {!results && !error && <ListSkeleton rows={5} />}
            {results && !results.length && (
              <div className="empty-search">
                <div style={{ fontWeight: 700 }}>No markets for “{q}”</div>
                <div className="small muted">Try fewer words, or a team, ticker or person.</div>
              </div>
            )}
            <div className="list" id="search-results" role="listbox" data-testid="search-results">
              {results?.map((r, i) => (
                <button
                  key={r.linkId ?? r.marketId}
                  id={`search-result-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className={`list-item market-row ${i === active ? 'active' : ''}`}
                  onPointerDown={() => prefetchMarket(r.marketId)}
                  onPointerEnter={() => setActive(i)}
                  onClick={() => open(r)}
                >
                  {r.image ? <img className="market-thumb" src={r.image} alt="" /> : <span className="market-thumb" />}
                  <div className="main">
                    <div className="title market-row-title">{r.title}</div>
                    <div className="sub ellipsis">
                      {[r.label ?? r.eventTitle, r.volume24h ? `${compactUsd(r.volume24h)} vol` : undefined, endsIn(r.endsAt)]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  </div>
                  <div className="end">
                    <div className="prob num">{pct(r.price)}</div>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </Screen>
  );
}

function endsIn(iso?: string): string | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  if (ms < 3_600_000) return `ends in ${Math.max(1, Math.round(ms / 60_000))}m`;
  if (ms < 86_400_000) return `ends in ${Math.round(ms / 3_600_000)}h`;
  if (ms < 30 * 86_400_000) return `ends in ${Math.round(ms / 86_400_000)}d`;
  return undefined;
}
