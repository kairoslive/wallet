import type { Fetch } from '../../../src/core/http';

export interface RecordedCall {
  url: string;
  init: RequestInit;
}

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response> | unknown;

export const json = (body: unknown, status = 200, statusText = 'OK') =>
  new Response(JSON.stringify(body), { status, statusText, headers: { 'content-type': 'application/json' } });

/**
 * A fetch stub that records every call. The handler may return a Response, or any other
 * value which is serialized as a 200 JSON response.
 */
export function mockFetch(handler: Handler): Fetch & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    const out = await handler(new URL(url), init);
    return out instanceof Response ? out : json(out);
  }) as Fetch & { calls: RecordedCall[] };
  fn.calls = calls;
  return fn;
}

export const headerOf = (init: RequestInit, name: string): string | null => new Headers(init.headers).get(name);
