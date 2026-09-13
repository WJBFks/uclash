import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionResponseCache, createConnectionTracker } from '../server/lib/connections.js';

test('connection contract derives source/destination and explicit unavailable process state', () => {
  const track = createConnectionTracker();
  const result = track([{
    id: 'raw-1',
    upload: 0,
    download: 0,
    metadata: {
      sourceIP: '192.0.2.10', sourcePort: 51234,
      destinationIP: '198.51.100.20', destinationPort: 443,
    },
  }], 1000);

  assert.deepEqual(result.connections[0].metadata.source, '192.0.2.10:51234');
  assert.deepEqual(result.connections[0].metadata.destination, '198.51.100.20:443');
  assert.equal(result.connections[0].processAvailable, false);
  assert.equal(result.connections[0].processLabel, '进程信息不可用');
});

test('connection contract prefers process fields and retains the complete process path', () => {
  const track = createConnectionTracker();
  const result = track([
    {
      id: 'top-level', process: '/usr/local/bin/clash', upload: 0, download: 0,
      metadata: { processPath: '/ignored/path', process: 'ignored' },
    },
    {
      id: 'metadata-path', upload: 0, download: 0,
      metadata: { processPath: 'C:\\Program Files\\App\\client.exe', process: 'ignored' },
    },
    {
      id: 'metadata-process', upload: 0, download: 0,
      metadata: { process: '/opt/tool/worker' },
    },
  ], 1000);

  assert.deepEqual(result.connections.map(({ process, processLabel, processAvailable }) => ({ process, processLabel, processAvailable })), [
    { process: '/usr/local/bin/clash', processLabel: 'clash', processAvailable: true },
    { process: 'C:\\Program Files\\App\\client.exe', processLabel: 'client.exe', processAvailable: true },
    { process: '/opt/tool/worker', processLabel: 'worker', processAvailable: true },
  ]);
});

test('connection contract treats blank process candidates as unavailable', () => {
  const result = createConnectionTracker()([{
    id: 'blank', process: '  ', upload: 0, download: 0,
    metadata: { processPath: '', process: '   ' },
  }], 1000);

  assert.equal(result.connections[0].process, '');
  assert.equal(result.connections[0].processAvailable, false);
  assert.equal(result.connections[0].processLabel, '进程信息不可用');
});

test('normalized connection results are stable for repeated snapshot generations', () => {
  let calls = 0;
  const normalize = createConnectionResponseCache((rows, at) => {
    calls++;
    return { connections: rows.map((row) => ({ ...row, speed: calls, at })) };
  });
  const first = { data: { connections: [{ id: 'a' }] }, generation: 1, sampledAt: 1000, fresh: true, error: null };
  assert.equal(normalize(first).connections[0].speed, 1);
  assert.equal(normalize({ ...first, fresh: false }).connections[0].speed, 1);
  assert.equal(calls, 1);
  assert.equal(normalize({ ...first, generation: 2, sampledAt: 3000, fresh: true }).connections[0].speed, 2);
});
