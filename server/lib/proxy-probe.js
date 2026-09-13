import http from 'node:http';
import tls from 'node:tls';

/** Probe an HTTPS origin through a local HTTP proxy without curl or a shell. */
export function probeHttpsThroughProxy({ proxyHost, proxyPort, hostname, timeoutMs = 8000 }) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.destroy();
      resolve({ ...result, elapsed: ((performance.now() - startedAt) / 1000).toFixed(3) });
    };
    const request = http.request({
      host: proxyHost,
      port: proxyPort,
      method: 'CONNECT',
      path: `${hostname}:443`,
      headers: { Host: `${hostname}:443` },
    });
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs);

    request.on('connect', (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        finish({ ok: false, error: `proxy CONNECT HTTP ${response.statusCode || 0}` });
        return;
      }
      const secure = tls.connect({ socket, servername: hostname });
      let responseText = '';
      secure.setEncoding('utf8');
      secure.on('secureConnect', () => {
        secure.write(`HEAD / HTTP/1.1\r\nHost: ${hostname}\r\nConnection: close\r\n\r\n`);
      });
      secure.on('data', (chunk) => {
        responseText += chunk;
        if (responseText.includes('\r\n')) {
          const match = responseText.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/);
          secure.destroy();
          finish(match
            ? { ok: true, status: Number(match[1]) }
            : { ok: false, error: 'invalid HTTP response' });
        }
      });
      secure.on('error', (error) => finish({ ok: false, error: error.message }));
      if (head.length) secure.unshift(head);
    });
    request.on('error', (error) => finish({ ok: false, error: error.message }));
    request.end();
  });
}
