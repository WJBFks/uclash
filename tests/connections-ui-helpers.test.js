import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCloseOutcome, deriveDetailConnection, formatSpeed, processDisplay, reconcileSelection } from '../src/components/connections/helpers.ts';

test('close outcomes distinguish all, partial, and no successful connection closures', () => {
  assert.deepEqual(classifyCloseOutcome(['a', 'b'], { results: [{ id: 'a', ok: true }, { id: 'b', ok: true }] }), {
    kind: 'all', succeededIds: ['a', 'b'], failedIds: [], message: '已关闭 2 个连接',
  });
  assert.deepEqual(classifyCloseOutcome(['a', 'b'], { results: [{ id: 'a', ok: true }, { id: 'b', ok: false }] }), {
    kind: 'partial', succeededIds: ['a'], failedIds: ['b'], message: '已关闭 1/2 个连接；未关闭 1 个',
  });
  assert.deepEqual(classifyCloseOutcome(['a', 'b'], { results: [{ id: 'a', ok: false }, { id: 'b', ok: false }] }), {
    kind: 'none', succeededIds: [], failedIds: ['a', 'b'], message: '未能关闭 2 个连接',
  });
});

test('selection reconciliation drops IDs absent from the active snapshot', () => {
  assert.deepEqual([...reconcileSelection(new Set(['kept', 'closed']), [{ id: 'kept' }, { id: 'other' }])], ['kept']);
});

test('speed formatting leaves unavailable speed as a dash without a rate suffix', () => {
  assert.equal(formatSpeed(undefined, () => '—'), '—');
  assert.equal(formatSpeed(1024, (value) => `${value} B`), '1024 B/s');
});

test('process display prefers label, then basename, then explicit unavailable text', () => {
  assert.equal(processDisplay({ processLabel: '浏览器', process: '/opt/app/browser' }), '浏览器');
  assert.equal(processDisplay({ process: 'C:\\Program Files\\App\\client.exe' }), 'client.exe');
  assert.equal(processDisplay({ processLabel: '  ', process: ' ' }), '进程信息不可用');
});

test('detail derivation follows an active connection into closed history and closes when missing', () => {
  const active = { id: 'same', upload: 1, download: 2 };
  const closed = { id: 'same', upload: 3, download: 4, closedAt: 1000 };
  assert.equal(deriveDetailConnection('same', [active], []), active);
  assert.equal(deriveDetailConnection('same', [], [closed]), closed);
  assert.equal(deriveDetailConnection('same', [], []), null);
});
