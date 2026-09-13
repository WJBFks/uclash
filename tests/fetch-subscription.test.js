import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { fetchSubscription } from '../server/lib/fetch-subscription.js';

test('subscription download retries a transient connection failure', async (t) => {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    if (requests === 1) {
      req.socket.destroy();
      return;
    }
    res.end('name: recovered\n');
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());

  const result = await fetchSubscription(`http://127.0.0.1:${server.address().port}/subscription`, {
    timeout: 3000,
    retryDelay: 0,
  });

  assert.equal(requests, 2);
  assert.equal(result.text, 'name: recovered\n');
});

test('subscription download exposes a safe network error code after retries', async () => {
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
  };

  await assert.rejects(
    () => fetchSubscription('https://secret.example/sub?token=hidden', {
      timeout: 3000,
      attempts: 2,
      retryDelay: 0,
      fetchImpl,
    }),
    (error) => {
      assert.match(error.message, /ECONNRESET/);
      assert.doesNotMatch(error.message, /secret|hidden/);
      return true;
    },
  );
  assert.equal(requests, 2);
});
