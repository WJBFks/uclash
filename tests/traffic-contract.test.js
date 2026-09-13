import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateTrafficRates, createConnectionsSnapshot, createTrafficSampler } from '../server/mihomo.js';

test('traffic rate calculation reports cumulative deltas and clamps counter rollback', () => {
  assert.deepEqual(calculateTrafficRates(
    { up: 1000, down: 2000, t: 1000 },
    { up: 1300, down: 2600, t: 2000 },
  ), { up: 300, down: 600 });
  assert.deepEqual(calculateTrafficRates(
    { up: 1300, down: 2600, t: 2000 },
    { up: 900, down: 1000, t: 3000 },
  ), { up: 0, down: 0 });
});

test('traffic rate calculation returns zero rates for a first sample and invalid elapsed time', () => {
  assert.deepEqual(calculateTrafficRates(null, { up: 100, down: 200, t: 1000 }), { up: 0, down: 0 });

  for (const t of [1000, 999, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(calculateTrafficRates(
      { up: 100, down: 200, t: 1000 },
      { up: 200, down: 400, t },
    ), { up: 0, down: 0 });
  }
});

test('traffic rate calculation independently clamps counter resets and non-finite counters', () => {
  assert.deepEqual(calculateTrafficRates(
    { up: 100, down: 200, t: 1000 },
    { up: 50, down: 500, t: 2000 },
  ), { up: 0, down: 300 });
  assert.deepEqual(calculateTrafficRates(
    { up: 100, down: 200, t: 1000 },
    { up: Number.NaN, down: Number.POSITIVE_INFINITY, t: 2000 },
  ), { up: 0, down: 0 });
});

test('traffic sampler maps connection totals, bounds history, and cancels its injected timer', async () => {
  let now = 0;
  let tick;
  let cancelled;
  let sample = 0;
  const sampler = createTrafficSampler({
    readTotals: async () => ({ uploadTotal: 100 + sample * 300, downloadTotal: 200 + sample++ * 600 }),
    now: () => now,
    schedule: (callback, intervalMs) => {
      assert.equal(intervalMs, 2000);
      tick = callback;
      return 'traffic-timer';
    },
    cancel: (timer) => { cancelled = timer; },
  });

  const stop = sampler.start();
  await tick();
  assert.deepEqual(sampler.getSnapshot(), {
    history: [{ t: 0, up: 0, down: 0 }],
    live: { up: 100, down: 200 },
    intervalMs: 2000,
    maxPoints: 120,
  });

  for (let index = 1; index <= 120; index++) {
    now = index * 1000;
    await tick();
  }

  const snapshot = sampler.getSnapshot();
  assert.deepEqual(snapshot.live, { up: 36100, down: 72200 });
  assert.equal(snapshot.history.length, 120);
  assert.deepEqual(snapshot.history[0], { t: 1000, up: 300, down: 600 });
  assert.deepEqual(snapshot.history.at(-1), { t: 120000, up: 300, down: 600 });
  stop();
  assert.equal(cancelled, 'traffic-timer');
});

test('traffic sampler ignores invalid totals and recovers from the last valid baseline', async () => {
  let now = 0;
  const totals = [
    { uploadTotal: 100, downloadTotal: 200 },
    { uploadTotal: Number.NaN, downloadTotal: 300 },
    { uploadTotal: 400, downloadTotal: 800 },
  ];
  const sampler = createTrafficSampler({ readTotals: async () => totals.shift(), now: () => now });

  await sampler.sample();
  now = 1000;
  await sampler.sample();
  now = 3000;
  await sampler.sample();

  assert.deepEqual(sampler.getSnapshot(), {
    history: [{ t: 0, up: 0, down: 0 }, { t: 3000, up: 100, down: 200 }],
    live: { up: 400, down: 800 }, intervalMs: 2000, maxPoints: 120,
  });
});

test('connection snapshot exposes generation, cache hits, failed fallback, and recovery', async () => {
  let now = 0, calls = 0, resolveRequest;
  const snapshot = createConnectionsSnapshot({
    now: () => now,
    ttlMs: 1000,
    request: () => {
      calls++;
      return new Promise((resolve) => { resolveRequest = resolve; });
    },
  });
  const first = snapshot.read();
  const concurrent = snapshot.read();
  assert.equal(calls, 1);
  resolveRequest({ uploadTotal: 10, downloadTotal: 20, connections: [] });
  assert.deepEqual(await first, { data: { uploadTotal: 10, downloadTotal: 20, connections: [] }, generation: 1, sampledAt: 0, fresh: true, error: null });
  assert.deepEqual(await concurrent, { data: { uploadTotal: 10, downloadTotal: 20, connections: [] }, generation: 1, sampledAt: 0, fresh: true, error: null });
  assert.deepEqual(await snapshot.read(), { data: { uploadTotal: 10, downloadTotal: 20, connections: [] }, generation: 1, sampledAt: 0, fresh: false, error: null });
  assert.equal(calls, 1);
  now = 1001;
  const refresh = snapshot.read();
  assert.equal(calls, 2);
  resolveRequest(null);
  assert.deepEqual(await refresh, { data: { uploadTotal: 10, downloadTotal: 20, connections: [] }, generation: 1, sampledAt: 0, fresh: false, error: 'request failed' });
  now = 2002;
  const recovery = snapshot.read();
  resolveRequest({ uploadTotal: 30, downloadTotal: 40, connections: [] });
  assert.deepEqual(await recovery, { data: { uploadTotal: 30, downloadTotal: 40, connections: [] }, generation: 2, sampledAt: 2002, fresh: true, error: null });
});

test('traffic sampler consumes each successful snapshot generation once using sampledAt', async () => {
  const reads = [
    // Another consumer performed the refresh; traffic first sees its cache hit.
    { data: { uploadTotal: 100, downloadTotal: 200 }, generation: 1, sampledAt: 1000, fresh: false, error: null },
    { data: { uploadTotal: 100, downloadTotal: 200 }, generation: 1, sampledAt: 1000, fresh: false, error: null },
    // An unseen generation with an error must not become a baseline or sample.
    { data: { uploadTotal: 200, downloadTotal: 400 }, generation: 2, sampledAt: 3000, fresh: false, error: 'request failed' },
    { data: { uploadTotal: 400, downloadTotal: 800 }, generation: 3, sampledAt: 5000, fresh: true, error: null },
  ];
  const sampler = createTrafficSampler({ readTotals: async () => reads.shift(), now: () => 999999 });
  await sampler.sample(); await sampler.sample(); await sampler.sample(); await sampler.sample();
  assert.deepEqual(sampler.getSnapshot().history, [{ t: 1000, up: 0, down: 0 }, { t: 5000, up: 75, down: 150 }]);
});
