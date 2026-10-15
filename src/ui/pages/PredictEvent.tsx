import { navigate, useRoute } from '../lib/router';
import { cachedEvent } from '../lib/predictCache';
import { Empty, Screen, TopBar } from '../components/ui';
import { compactUsd, pct } from './Predict';

/** Outcomes of a grouped event (e.g. price ladders, multi-candidate races). */
export function PredictEvent() {
  const route = useRoute();
  const event = cachedEvent(route.query.get('id') ?? '');
  if (!event) {
    return (
      <Screen>
        <TopBar title="Event" />
        <div className="screen-body">
          <Empty title="This event isn't loaded">
            <button className="link-btn" onClick={() => navigate('/predict', undefined, true)}>
              Back to markets
            </button>
          </Empty>
        </div>
      </Screen>
    );
  }
  const outcomes = [...event.outcomes].sort((a, b) => (b.price ?? 0) - (a.price ?? 0));
  return (
    <Screen>
      <TopBar title="Event" />
      <div className="screen-body stack" style={{ gap: 10 }}>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          {event.image && <img className="market-thumb" src={event.image} alt="" style={{ width: 48, height: 48 }} />}
          <div>
            <div style={{ fontWeight: 750, fontSize: 16, lineHeight: 1.3 }}>{event.title}</div>
            <div className="small muted">
              {event.volume24h ? `${compactUsd(event.volume24h)} traded in 24h` : ''}
              {event.expiration ? ` · ends ${new Date(event.expiration).toLocaleDateString()}` : ''}
            </div>
          </div>
        </div>
        <div className="list" data-testid="outcome-list">
          {outcomes.map((o) => (
            <button key={o.marketId} className="list-item" onClick={() => navigate('/predict/market', { id: o.marketId })}>
              <div className="main">
                <div className="title" style={{ fontSize: 13 }}>
                  {o.label ?? o.title}
                </div>
                {o.label && <div className="sub ellipsis">{o.title}</div>}
              </div>
              <div className="end prob">{pct(o.price)}</div>
            </button>
          ))}
        </div>
      </div>
    </Screen>
  );
}
