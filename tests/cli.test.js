import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCliArgs, renderServiceUnit } from '../server/cli.js';

test('uclash defaults to foreground mode on port 15924', () => {
  assert.deepEqual(parseCliArgs([]), { command: 'run', port: 15924 });
});

test('uclash accepts foreground and background port options', () => {
  assert.deepEqual(parseCliArgs(['--port', '18080']), { command: 'run', port: 18080 });
  assert.deepEqual(parseCliArgs(['start', '--port=18081']), { command: 'start', port: 18081 });
});

test('uclash parses stop and restart without a port', () => {
  assert.deepEqual(parseCliArgs(['stop']), { command: 'stop', port: null });
  assert.deepEqual(parseCliArgs(['restart']), { command: 'restart', port: null });
});

test('uclash rejects invalid arguments and ports', () => {
  assert.throws(() => parseCliArgs(['--port', '0']), /端口/);
  assert.throws(() => parseCliArgs(['stop', '--port', '15924']), /不接受/);
  assert.throws(() => parseCliArgs(['launch']), /未知命令/);
});

test('systemd unit starts the committed dist server with an absolute Node path', () => {
  const unit = renderServiceUnit({ rootDir: '/tmp/U Clash', nodeBin: '/opt/node bin/node', port: 15924 });
  assert.match(unit, /WorkingDirectory=\/tmp\/U\\x20Clash/);
  assert.match(unit, /Environment=PORT=15924/);
  assert.match(unit, /ExecStart="\/opt\/node bin\/node" "\/tmp\/U Clash\/server\/index\.js"/);
  assert.match(unit, /Restart=on-failure/);
});
