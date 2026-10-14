export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

export type Fetch = typeof fetch;

export async function getJson<T>(url: string, init: RequestInit = {}, fetchFn: Fetch = fetch, timeoutMs = 20_000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // Non-JSON body; keep raw text for the error message.
    }
    if (!res.ok) {
      const obj = (body && typeof body === 'object' ? body : {}) as { message?: unknown; error?: unknown };
      const textMsg = typeof body === 'string' && body.length < 200 && !body.trimStart().startsWith('<') ? body : '';
      const msg = String(obj.message ?? obj.error ?? '') || textMsg || `${res.status} ${res.statusText}`;
      throw new HttpError(res.status, msg, body);
    }
    return body as T;
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error(`Request timed out: ${new URL(url).host}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
