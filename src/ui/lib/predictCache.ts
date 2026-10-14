import type { PredictionEvent } from '../../core/predictions/types';

/** Events from the last market list, so the event screen can render without a dedicated endpoint. */
const events = new Map<string, PredictionEvent>();

export function cacheEvents(list: PredictionEvent[]) {
  for (const e of list) events.set(e.id, e);
}

export function cachedEvent(id: string): PredictionEvent | undefined {
  return events.get(id);
}
