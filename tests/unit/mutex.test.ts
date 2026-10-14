import { describe, expect, it } from 'vitest';
import { Mutex } from '../../src/core/wallet/mutex';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('Mutex', () => {
  it('runs critical sections one at a time, in call order', async () => {
    const m = new Mutex();
    const log: string[] = [];
    let active = 0;
    let maxActive = 0;
    const task = (name: string, ms: number) =>
      m.run(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        log.push(`start ${name}`);
        await tick(ms);
        log.push(`end ${name}`);
        active--;
        return name;
      });
    const results = await Promise.all([task('a', 15), task('b', 1), task('c', 5)]);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(maxActive).toBe(1);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('prevents lost updates in read-modify-write sequences', async () => {
    const m = new Mutex();
    let store = 0;
    const increment = () =>
      m.run(async () => {
        const v = store;
        await tick(1);
        store = v + 1;
      });
    await Promise.all(Array.from({ length: 20 }, increment));
    expect(store).toBe(20);
  });

  it('isolates errors: a rejection propagates to its caller only and does not block the queue', async () => {
    const m = new Mutex();
    const order: string[] = [];
    const failing = m.run(async () => {
      order.push('fail');
      throw new Error('boom');
    });
    const next = m.run(async () => {
      order.push('next');
      return 42;
    });
    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe(42);
    expect(order).toEqual(['fail', 'next']);
  });

  it('isolates synchronous throws inside fn', async () => {
    const m = new Mutex();
    const bad = m.run(() => {
      throw new Error('sync boom');
    });
    await expect(bad).rejects.toThrow('sync boom');
    await expect(m.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('keeps working after many errors', async () => {
    const m = new Mutex();
    const runs = Array.from({ length: 5 }, (_, i) =>
      m.run(async () => {
        if (i % 2 === 0) throw new Error(`e${i}`);
        return i;
      }),
    );
    const settled = await Promise.allSettled(runs);
    expect(settled.map((s) => s.status)).toEqual(['rejected', 'fulfilled', 'rejected', 'fulfilled', 'rejected']);
    expect(await m.run(async () => 'still alive')).toBe('still alive');
  });

  it('separate mutexes do not block each other', async () => {
    const a = new Mutex();
    const b = new Mutex();
    let release!: () => void;
    const blocker = a.run(() => new Promise<void>((r) => (release = r)));
    await expect(b.run(async () => 'b done')).resolves.toBe('b done');
    release();
    await blocker;
  });
});
