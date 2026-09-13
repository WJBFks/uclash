import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { resolveMihomoBin } from '../server/config.js';

test('mihomo binary discovery prefers an explicit setting', () => {
  assert.equal(resolveMihomoBin({
    explicit: '/opt/mihomo-custom',
    home: '/home/tester',
    pathValue: '/usr/bin',
    executable: () => true,
  }), '/opt/mihomo-custom');
});

test('mihomo binary discovery supports user installs without shell aliases', () => {
  const localBin = path.join('/home/tester', '.local/bin/mihomo');
  assert.equal(resolveMihomoBin({
    explicit: '',
    home: '/home/tester',
    pathValue: '/custom/bin:/usr/bin',
    executable: candidate => candidate === localBin,
  }), localBin);
});

test('mihomo binary discovery falls back to PATH and system locations', () => {
  assert.equal(resolveMihomoBin({
    explicit: '',
    home: '/home/tester',
    pathValue: '/custom/bin:/usr/bin',
    executable: candidate => candidate === '/custom/bin/mihomo',
  }), '/custom/bin/mihomo');
  assert.equal(resolveMihomoBin({
    explicit: '',
    home: '/home/tester',
    pathValue: '',
    executable: candidate => candidate === '/usr/local/bin/mihomo',
  }), '/usr/local/bin/mihomo');
});
