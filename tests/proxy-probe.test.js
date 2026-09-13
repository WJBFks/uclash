import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { probeHttpsThroughProxy } from '../server/lib/proxy-probe.js';

test('proxy probe reports a rejected CONNECT without invoking curl', async () => {
  const proxy = http.createServer();
  proxy.on('connect', (_req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const address = proxy.address();
    const result = await probeHttpsThroughProxy({
      proxyHost: '127.0.0.1', proxyPort: address.port, hostname: 'example.com', timeoutMs: 1000,
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /CONNECT HTTP 403/);
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
  }
});
