import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  CatalogEvent,
  CatalogPage,
  CatalogQuery,
  CatalogSide,
  CatalogSort,
  CatalogStatus,
  CatalogVenue,
  MatchedMarket,
} from '../../core/predictions/discover';
import { catalogTradeTarget } from '../../core/predictions/discover';
import { VENUES } from '../../core/predictions/venues';
import { Icon } from '../components/Icon';
import { Button, Empty, ErrorNote, Field, Screen, Sheet, Toggle, TopBar } from '../components/ui';
import { useCatalogQuotes } from '../components/useCatalogQuotes';
import { api } from '../lib/api';
import { prefetchMarket, useTradingStatus } from '../lib/predictQueries';
import { fetchQuery, getQueryData, prefetch, setQueryData, useQuery } from '../lib/query';
import { back, navigate, useRoute } from '../lib/router';
import { useWallet } from '../lib/store';
import { cents, ListSkeleton, venueStatus } from './Predict';

const DISCOVER = '/predict/discover';
const EVENT = `${DISCOVER}/event`;
const MARKET = `${DISCOVER}/market`;
const TTL = 60_000;
const PAGE_SIZE = 20;
const STATES = {
  all: undefined,
  live: ['live'],
  upcoming: ['upcoming'],
  past: ['ended', 'closed', 'resolved'],
} satisfies Record<string, CatalogStatus[] | undefined>;
const CATEGORIES = ['Sports', 'Esports'];
const SORTS: Record<CatalogSort, string> = {
  start_time: 'Start time',
  close_time: 'Trading deadline',
  newest: 'Recently matched',
  markets: 'Most markets',
};
const STATUS_LABEL: Record<CatalogStatus, string> = {
  live: 'Live',
  upcoming: 'Upcoming',
  open: 'Open',
  resolving: 'Resolving',
  ended: 'Event ended',
  closed: 'Closed',
  resolved: 'Resolved',
};
const CATALOG_VENUES: CatalogVenue[] = [...VENUES, 'kalshi'];
const venueCount = (count: number) => `${count} ${count === 1 ? 'venue' : 'venues'}`;
const categoryLabel = (category?: string | null) => category && category[0].toUpperCase() + category.slice(1);
const marketCount = (count: number) => `${count} ${count === 1 ? 'market' : 'markets'}`;
const catalogKey = (url: string, resource: string, id: string) => `p/catalog/${url}/${resource}/${id}`;

interface Filters {
  category?: string;
  venues: CatalogVenue[];
  sort: CatalogSort;
  ready: boolean;
}

function readFilters(params: URLSearchParams): Filters {
  const venues = params.get('venues')?.split(',') ?? [];
  const sort = Object.keys(SORTS).find((s): s is CatalogSort => s === params.get('sort'));
  return {
    category: CATEGORIES.find((c) => c === params.get('category')),
    venues: CATALOG_VENUES.filter((v) => venues.includes(v)),
    sort: sort ?? 'start_time',
    ready: params.get('ready') === '1',
  };
}

const statuses = {
  all: 'All',
  live: 'Live',
  upcoming: 'Upcoming',
  past: 'Past',
} satisfies Record<keyof typeof STATES, string>;

function saveBrowse(q: string, state: keyof typeof STATES, f: Filters) {
  navigate(
    DISCOVER,
    {
      q: q || undefined,
      status: state !== 'all' ? state : undefined,
      category: f.category,
      venues: f.venues.length ? f.venues.join(',') : undefined,
      sort: f.sort !== 'start_time' ? f.sort : undefined,
      ready: f.ready ? '1' : undefined,
    },
    true,
  );
}

function timestamp(value: string | null, timeOnly = false): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  return new Intl.DateTimeFormat(undefined, { ...(timeOnly ? {} : { dateStyle: 'medium' }), timeStyle: 'short' }).format(date);
}

function dayLabel(value: string | null): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return 'Today';
  today.setDate(today.getDate() + 1);
  if (date.toDateString() === today.toDateString()) return 'Tomorrow';
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(date);
}

function EventArtwork({ url, large }: { url?: string | null; large?: boolean }) {
  const [broken, setBroken] = useState(false);
  const cls = large ? 'catalog-art large' : 'catalog-art';
  return url && /^https:\/\//i.test(url) && !broken ? (
    <img className={cls} src={url} alt="" loading="lazy" onError={() => setBroken(true)} />
  ) : (
    <span className={cls} aria-hidden="true">
      <Icon name="predict" size={large ? 24 : 18} />
    </span>
  );
}

function CatalogStatusPill({ status }: { status: CatalogStatus }) {
  return (
    <span className={`catalog-status ${status}`} title={status === 'live' ? 'Based on the scheduled start time' : undefined}>
      {STATUS_LABEL[status]}
    </span>
  );
}

/** How widely an event is listed, without naming the venues. */
function VenueBadges({ venues }: { venues: CatalogVenue[] }) {
  return <div className="small muted catalog-venues">Listed on {venueCount(venues.length)}</div>;
}

function CatalogEventRow({ event, url, onOpen }: { event: CatalogEvent; url: string; onOpen: () => void }) {
  const warm = () => prefetch(catalogKey(url, 'event', event.id), () => api.predictionCatalogEvent(event.id), TTL);
  return (
    <button className="catalog-event-row" onPointerDown={warm} onClick={onOpen} data-testid="catalog-event-row">
      <EventArtwork key={event.image} url={event.image} />
      <span className="catalog-event-info">
        <span className="catalog-event-title">{event.title}</span>
        <span className="catalog-event-meta">
          {event.start_time && <time dateTime={event.start_time}>{timestamp(event.start_time, true)}</time>}
          <span>{marketCount(event.market_count)}</span>
          <span>{event.venues.length} venues</span>
        </span>
      </span>
      {event.status === 'live' || event.status === 'resolving' ? (
        <CatalogStatusPill status={event.status} />
      ) : (
        <Icon name="chevronRight" size={15} />
      )}
    </button>
  );
}

export function PredictDiscover() {
  const { state: wallet, account } = useWallet();
  const route = useRoute();
  const url = wallet.settings.apis.kairosMarketDataUrl;
  const enabled = wallet.settings.apis.kairosEnabled;
  const q = route.query.get('q') ?? '';
  const [search, setSearch] = useState(q);
  const [filterOpen, setFilterOpen] = useState(false);
  const [showSearchLimit, setShowSearchLimit] = useState(false);
  const state = (Object.keys(STATES) as (keyof typeof STATES)[]).find((s) => s === route.query.get('status')) ?? 'all';
  const filters = readFilters(route.query);
  const shouldReadStatus = enabled && (filterOpen || filters.ready) && account?.evmAddress;
  const { data: trading, loading: readinessLoading } = useTradingStatus(shouldReadStatus ? account?.id : undefined);
  const readyVenues = VENUES.filter((v) => venueStatus(trading, v)?.ready);
  const filterCount =
    Number(!!filters.category) + filters.venues.length + Number(filters.ready) + Number(filters.sort !== 'start_time');
  const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(searchTimer.current), []);

  const updateSearch = (value: string) => {
    setSearch(value);
    clearTimeout(searchTimer.current);
    const trimmed = value.trim();
    const invalid = new TextEncoder().encode(trimmed).length > 200 || trimmed.split(/\s+/).length > 10;
    setShowSearchLimit(invalid);
    if (!invalid) searchTimer.current = setTimeout(() => saveBrowse(trimmed, state, filters), trimmed ? 220 : 0);
  };
  const changeFilters = (nextState: keyof typeof STATES, nextFilters: Filters) => {
    clearTimeout(searchTimer.current);
    saveBrowse(showSearchLimit ? q : search.trim(), nextState, nextFilters);
  };

  const query: CatalogQuery = {
    q,
    category: filters.category,
    venues: filters.venues,
    statuses: STATES[state],
    executableVenues: filters.ready ? readyVenues : undefined,
    sort: filters.sort,
    includeMarkets: false,
    limit: PAGE_SIZE,
  };
  const noReadyVenues = filters.ready && !readyVenues.length;
  const key = catalogKey(url, 'list', JSON.stringify(query));

  return (
    <Screen>
      <TopBar
        title="Discover"
        onBack={() => back('/predict')}
        right={
          <button className="link-btn catalog-all-link" onClick={() => back('/predict')}>
            All markets
          </button>
        }
      />
      {!enabled ? (
        <div className="screen-body">
          <Empty title="Prediction markets are off">
            <button className="link-btn" onClick={() => navigate('/settings/apis')}>
              Turn them on in Settings
            </button>
          </Empty>
        </div>
      ) : (
        <>
          <div className="catalog-controls">
            <div className="catalog-search-row">
              <div className="search-input">
                <Icon name="search" size={16} />
                <input
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={search}
                  onChange={(e) => updateSearch(e.target.value)}
                  aria-label="Search matched events"
                  placeholder="Search events"
                />
                {search && (
                  <button className="search-clear" aria-label="Clear search" onClick={() => updateSearch('')}>
                    <Icon name="close" size={14} />
                  </button>
                )}
              </div>
              <button
                className={`catalog-filter ${filterCount ? 'active' : ''}`}
                onClick={() => setFilterOpen(true)}
                aria-haspopup="dialog"
              >
                <Icon name="settings" size={15} />
                Filters{filterCount ? ` (${filterCount})` : ''}
              </button>
            </div>
            {showSearchLimit && (
              <div className="small neg" role="status">
                Search up to 10 words or 200 bytes.
              </div>
            )}
            <div className="chip-row" aria-label="Event status">
              {(Object.keys(statuses) as (keyof typeof STATES)[]).map((s) => (
                <button
                  key={s}
                  className={`chip ${state === s ? 'active' : ''}`}
                  aria-pressed={state === s}
                  onClick={() => changeFilters(s, filters)}
                >
                  {statuses[s]}
                </button>
              ))}
            </div>
          </div>
          {noReadyVenues ? (
            <div className="screen-body">
              {account?.evmAddress && readinessLoading ? (
                <ListSkeleton rows={4} />
              ) : (
                <Empty title="No venues ready to trade">
                  <button className="link-btn" onClick={() => changeFilters(state, { ...filters, ready: false })}>
                    Show all matching events
                  </button>
                </Empty>
              )}
            </div>
          ) : (
            <CatalogList key={key} cacheKey={key} url={url} query={query} />
          )}
        </>
      )}
      {filterOpen && (
        <CatalogFilters
          value={filters}
          hasReadyVenue={readyVenues.length > 0}
          onClose={() => setFilterOpen(false)}
          onApply={(next) => {
            changeFilters(state, next);
            setFilterOpen(false);
          }}
        />
      )}
    </Screen>
  );
}

function CatalogList({ cacheKey, url, query }: { cacheKey: string; url: string; query: CatalogQuery }) {
  // A refresh reloads the first page but keeps pages already loaded below it, so coming back to a
  // long list doesn't drop the user back to page one.
  const { data, error, loading, reload } = useQuery(
    cacheKey,
    () =>
      api.predictionCatalog(query).then((first) => {
        const prev = getQueryData<CatalogPage>(cacheKey);
        if (!prev || prev.events.length <= first.events.length) return first;
        const seen = new Set(first.events.map((e) => e.id));
        return { ...prev, events: [...first.events, ...prev.events.filter((e) => !seen.has(e.id))] };
      }),
    { ttl: TTL },
  );
  const body = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const [pageError, setPageError] = useState<string>();
  useLayoutEffect(() => {
    const saved = window.history.state?.catalogScroll;
    if (body.current && saved?.key === cacheKey) body.current.scrollTop = saved.top;
  }, [cacheKey]);
  const openEvent = (id: string) => {
    const catalogScroll = { key: cacheKey, top: body.current?.scrollTop ?? 0 };
    window.history.replaceState({ ...window.history.state, catalogScroll }, '');
    navigate(EVENT, { id });
  };
  const loadMore = async () => {
    const cursor = data?.next_cursor;
    if (!data?.has_more || !cursor) return;
    setMore(true);
    setPageError(undefined);
    try {
      const next = await fetchQuery(
        catalogKey(url, 'cursor', `${cacheKey}/${cursor}`),
        () => api.predictionCatalog({ ...query, cursor }),
        TTL,
      );
      setQueryData<CatalogPage>(cacheKey, (prev) => {
        if (!prev || prev.next_cursor !== cursor) return prev;
        const seen = new Set(prev.events.map((e) => e.id));
        return { ...next, events: [...prev.events, ...next.events.filter((e) => !seen.has(e.id))] };
      });
    } catch (e) {
      setPageError((e as Error).message);
    } finally {
      setMore(false);
    }
  };
  const events = data?.events ?? [];
  return (
    <div ref={body} className="screen-body stack catalog-list" data-testid="catalog-list">
      {loading && <ListSkeleton rows={6} />}
      {error && <CatalogError error={error} retry={reload} />}
      {data && !events.length && (
        <Empty title="No matching events">
          <div>Try another search or filter, or browse individual venues.</div>
          <button className="link-btn" onClick={() => back('/predict')}>
            Browse all markets
          </button>
        </Empty>
      )}
      {events.map((event, index) => {
        const day = query.sort === 'start_time' ? (dayLabel(event.start_time) ?? 'Start time unavailable') : undefined;
        const prev = events[index - 1];
        return (
          <div key={event.id}>
            {day && (!prev || day !== (dayLabel(prev.start_time) ?? 'Start time unavailable')) && (
              <h2 className="catalog-date">{day}</h2>
            )}
            <CatalogEventRow event={event} url={url} onOpen={() => openEvent(event.id)} />
          </div>
        );
      })}
      <ErrorNote error={pageError} />
      {data?.has_more && data.next_cursor && (
        <Button small variant="secondary" onClick={loadMore} loading={more}>
          {pageError ? 'Retry next page' : 'Load more'}
        </Button>
      )}
    </div>
  );
}

function CatalogError({ error, retry }: { error: string; retry: () => Promise<unknown> }) {
  return (
    <div className="stack catalog-error">
      <ErrorNote error={error} />
      <Button small variant="secondary" onClick={() => void retry()}>
        Try again
      </Button>
    </div>
  );
}

function CatalogFilters({
  value,
  hasReadyVenue,
  onClose,
  onApply,
}: {
  value: Filters;
  hasReadyVenue: boolean;
  onClose: () => void;
  onApply: (value: Filters) => void;
}) {
  const [draft, setDraft] = useState(value);
  return (
    <Sheet title="Filters" onClose={onClose}>
      <div className="stack catalog-filters-sheet">
        <Field label="Category" htmlFor="catalog-category">
          <select
            id="catalog-category"
            value={draft.category ?? ''}
            onChange={(e) => setDraft({ ...draft, category: e.target.value || undefined })}
          >
            <option value="">All categories</option>
            {CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
        <Field label="Sort by" htmlFor="catalog-sort">
          <select
            id="catalog-sort"
            value={draft.sort}
            onChange={(e) => setDraft({ ...draft, sort: e.target.value as CatalogSort })}
          >
            {Object.entries(SORTS).map(([sort, name]) => (
              <option key={sort} value={sort}>
                {name}
              </option>
            ))}
          </select>
        </Field>
        {(hasReadyVenue || draft.ready) && (
          <div className="row catalog-ready-filter">
            <span>Ready to trade with this wallet</span>
            <Toggle
              label="Ready to trade with this wallet"
              on={draft.ready}
              onChange={(ready) => setDraft({ ...draft, ready })}
            />
          </div>
        )}
        <div className="row catalog-filter-actions">
          <Button variant="secondary" onClick={() => setDraft(readFilters(new URLSearchParams()))}>
            Reset
          </Button>
          <Button onClick={() => onApply(draft)}>Show events</Button>
        </div>
      </div>
    </Sheet>
  );
}

function CatalogHeader({
  title,
  image,
  category,
  status,
  start,
}: {
  title: string;
  image?: string | null;
  category?: string | null;
  status: CatalogStatus;
  start: string | null;
}) {
  return (
    <header className="catalog-detail-header">
      <EventArtwork key={image} url={image} large />
      <div className="catalog-detail-heading">
        <div className="catalog-detail-meta">
          <CatalogStatusPill status={status} />
          {categoryLabel(category)}
        </div>
        <h2>{title}</h2>
        {start && (
          <time className="muted small" dateTime={start}>
            {timestamp(start)}
          </time>
        )}
      </div>
    </header>
  );
}

export function PredictDiscoverEvent() {
  const id = useRoute().query.get('id') ?? undefined;
  const { state: wallet } = useWallet();
  const { kairosEnabled: enabled, kairosMarketDataUrl: url } = wallet.settings.apis;
  const { data, error, reload } = useQuery(
    enabled && id ? catalogKey(url, 'event', id) : undefined,
    () => api.predictionCatalogEvent(id!),
    { ttl: TTL },
  );
  const event = data?.event;
  return (
    <Screen>
      <TopBar title="Event" onBack={() => back(DISCOVER)} />
      <div className="screen-body stack catalog-detail">
        {!enabled && <Empty title="Prediction markets are off" />}
        {enabled && !id && <Empty title="Event not found" />}
        {enabled && id && !event && !error && <ListSkeleton rows={4} />}
        {error && <CatalogError error={error} retry={reload} />}
        {event && (
          <>
            <CatalogHeader
              title={event.title}
              image={event.image}
              category={event.category}
              status={event.status}
              start={event.start_time}
            />
            <VenueBadges venues={event.venues} />
            <h3 className="section-label">{marketCount(event.market_count)}</h3>
            <div className="list">
              {event.markets?.map((market) => (
                <CatalogMarketRow key={market.id} market={market} event={event} url={url} />
              ))}
            </div>
            {!event.markets?.length && <Empty title="No matched markets found" />}
          </>
        )}
      </div>
    </Screen>
  );
}

function CatalogMarketRow({ market, event, url }: { market: MatchedMarket; event: CatalogEvent; url: string }) {
  return (
    <button
      className="catalog-market-row list-item market-row"
      onPointerDown={() => prefetch(catalogKey(url, 'market', market.id), () => api.predictionMatchedMarket(market.id), TTL)}
      onClick={() => navigate(MARKET, { id: market.id, event: event.id })}
    >
      <span className="main">
        <span className="title">{market.title}</span>
        <span className="sub">
          {market.outcomes.yes} · {market.outcomes.no}
        </span>
      </span>
      <Icon name="chevronRight" size={15} />
    </button>
  );
}

export function PredictDiscoverMarket() {
  const route = useRoute();
  const id = route.query.get('id') ?? undefined;
  const { state: wallet, account } = useWallet();
  const { kairosEnabled: enabled, kairosMarketDataUrl, kairosStreamUrl } = wallet.settings.apis;
  const { data, error, reload } = useQuery(
    enabled && id ? catalogKey(kairosMarketDataUrl, 'market', id) : undefined,
    () => api.predictionMatchedMarket(id!),
    { ttl: 20_000 },
  );
  const market = data?.market;
  const quote = useCatalogQuotes(kairosStreamUrl, market?.books?.yes, market?.books?.no);
  const eventId = data?.event.id ?? route.query.get('event');
  const goBack = () => back(eventId ? `${EVENT}?${new URLSearchParams({ id: eventId })}` : DISCOVER);
  return (
    <Screen>
      <TopBar title="Market" onBack={goBack} />
      <div className="screen-body stack catalog-detail">
        {!enabled && <Empty title="Prediction markets are off" />}
        {enabled && !id && <Empty title="Matched market not found" />}
        {enabled && id && !market && !error && <ListSkeleton rows={4} />}
        {error && <CatalogError error={error} retry={reload} />}
        {market && (
          <>
            {data?.event.title && data.event.title !== market.title && <div className="small muted">{data.event.title}</div>}
            <CatalogHeader
              title={market.title}
              image={market.image}
              category={market.category}
              status={market.status}
              start={market.start_time}
            />
            {market.close_time && (
              <div className="small muted">
                <Icon name="clock" size={12} /> Trading ends by{' '}
                <time dateTime={market.close_time}>{timestamp(market.close_time)}</time>
              </div>
            )}
            <div className="panel stack catalog-trade-panel">
              <h3>Trade this market</h3>
              <div className="outcome-buttons">
                {(['yes', 'no'] as const).map((side) => (
                  <CatalogTradeButton key={side} market={market} side={side} ask={quote[side]} enabled={!!account?.evmAddress} />
                ))}
              </div>
              <div className="small muted">
                {(!account?.evmAddress && 'Switch to a wallet account with an EVM address to trade.') ||
                  (!catalogTradeTarget(market, 'yes') &&
                    !catalogTradeTarget(market, 'no') &&
                    'Trading is unavailable for this market.') ||
                  (quote.yes !== undefined || quote.no !== undefined
                    ? 'Indicative asks across venues. Your price depends on size and available venues.'
                    : 'Review live prices and available venues before placing an order.')}
              </div>
            </div>
            <div className="small muted" data-testid="catalog-listings">
              {venueCount(market.venues.length)} · {market.venues.filter((v) => v.open && v.executable).length} trading
            </div>
          </>
        )}
      </div>
    </Screen>
  );
}

function CatalogTradeButton({
  market,
  side,
  ask,
  enabled,
}: {
  market: MatchedMarket;
  side: CatalogSide;
  ask?: number;
  enabled: boolean;
}) {
  const target = catalogTradeTarget(market, side);
  return (
    <button
      className={`outcome-btn ${market.outcomes[side].toLowerCase() === side ? side : 'catalog-named-outcome'}`}
      disabled={!target || !enabled}
      onPointerDown={() => target && prefetchMarket(target.id)}
      onClick={() => target && navigate('/predict/market', target)}
    >
      <span>{market.outcomes[side]}</span>
      {ask !== undefined && <span className="outcome-price num">{cents(ask)}</span>}
    </button>
  );
}
