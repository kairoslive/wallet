import { describe, expect, it } from 'vitest';
import { HttpError, getJson, joinUrl, type Fetch } from '../../src/core/http';
import { json, mockFetch } from './helpers/mockFetch';

describe('getJson', () => {
  it('returns parsed JSON and forwards init with an abort signal', async () => {
    const f = mockFetch(() => ({ ok: 1 }));
    const out = await getJson<{ ok: number }>('https://api.example.com/x', { method: 'POST', headers: { a: 'b' } }, f);
    expect(out).toEqual({ ok: 1 });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe('https://api.example.com/x');
    expect(f.calls[0].init.method).toBe('POST');
    expect(f.calls[0].init.headers).toEqual({ a: 'b' });
    expect(f.calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns undefined for an empty body', async () => {
    const f = mockFetch(() => new Response('', { status: 200 }));
    expect(await getJson('https://api.example.com/x', {}, f)).toBeUndefined();
  });

  it('returns raw text for a non-JSON success body', async () => {
    const f = mockFetch(() => new Response('plain', { status: 200 }));
    expect(await getJson('https://api.example.com/x', {}, f)).toBe('plain');
  });

  it('uses `message` from a JSON error body', async () => {
    const body = { message: 'Rate limit exceeded', code: 1005 };
    const f = mockFetch(() => json(body, 429, 'Too Many Requests'));
    const err = await getJson('https://api.example.com/x', {}, f).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(429);
    expect((err as HttpError).message).toBe('Rate limit exceeded');
    expect((err as HttpError).body).toEqual(body);
  });

  it('falls back to `error` when there is no `message`', async () => {
    const f = mockFetch(() => json({ error: 'Invalid mint' }, 400, 'Bad Request'));
    await expect(getJson('https://api.example.com/x', {}, f)).rejects.toThrow('Invalid mint');
  });

  it('falls back to status text for non-JSON or message-less error bodies', async () => {
    const html = '<html>Bad Gateway</html>';
    const f = mockFetch(() => new Response(html, { status: 502, statusText: 'Bad Gateway' }));
    const err = (await getJson('https://api.example.com/x', {}, f).catch((e: unknown) => e)) as HttpError;
    expect(err).toBeInstanceOf(HttpError);
    expect(err.message).toBe('api.example.com returned HTTP 502 Bad Gateway');
    expect(err.body).toBe(html);

    const f2 = mockFetch(() => json({ detail: 'nope' }, 404, 'Not Found'));
    await expect(getJson('https://api.example.com/x', {}, f2)).rejects.toThrow('api.example.com returned HTTP 404 Not Found');

    const f3 = mockFetch(() => new Response('', { status: 500, statusText: 'Internal Server Error' }));
    await expect(getJson('https://api.example.com/x', {}, f3)).rejects.toThrow('api.example.com returned HTTP 500 Internal Server Error');

    const f4 = mockFetch(() => new Response('<!DOCTYPE html><title>Just a moment...</title>', { status: 403 }));
    await expect(getJson('https://api.example.com/x', {}, f4)).rejects.toThrow('api.example.com blocked the request with a bot check');
  });

  it('times out with a readable message naming the host', async () => {
    let aborted = false;
    const hang: Fetch = (_input, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(init.signal!.reason);
        });
      });
    await expect(getJson('https://slow.example.com/path', {}, hang, 20)).rejects.toThrow(
      'Request timed out: slow.example.com',
    );
    expect(aborted).toBe(true);
  });

  it('propagates non-abort network errors unchanged', async () => {
    const boom: Fetch = () => Promise.reject(new TypeError('fetch failed'));
    await expect(getJson('https://api.example.com/x', {}, boom)).rejects.toThrow(TypeError);
    await expect(getJson('https://api.example.com/x', {}, boom)).rejects.toThrow('fetch failed');
  });

  it('does not abort a request that completes in time', async () => {
    let signal: AbortSignal | undefined;
    const f = mockFetch((_u, init) => {
      signal = init.signal ?? undefined;
      return { ok: true };
    });
    await getJson('https://api.example.com/x', {}, f, 50);
    await new Promise((r) => setTimeout(r, 80));
    expect(signal?.aborted).toBe(false);
  });
});

describe('joinUrl', () => {
  it('joins with exactly one slash', () => {
    expect(joinUrl('https://a.com', 'b')).toBe('https://a.com/b');
    expect(joinUrl('https://a.com/', '/b')).toBe('https://a.com/b');
    expect(joinUrl('https://a.com///', '//b/c?x=1')).toBe('https://a.com/b/c?x=1');
    expect(joinUrl('https://a.com/api/v1', 'tokens')).toBe('https://a.com/api/v1/tokens');
  });
});
