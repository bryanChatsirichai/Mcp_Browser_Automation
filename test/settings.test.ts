import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectionChanged, DEFAULT_SETTINGS } from '../extension/dist/settings.js';

test('connectionChanged: changing only where tabs open does not reconnect', () => {
  assert.equal(connectionChanged(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, tabWindow: 'current' }), false);
});

test('connectionChanged: any connection field change reconnects', () => {
  assert.equal(connectionChanged(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, url: 'http://127.0.0.1:9000' }), true);
  assert.equal(connectionChanged(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, token: 'x' }), true);
  assert.equal(connectionChanged(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, enabled: true }), true);
  assert.equal(connectionChanged(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, connectNonce: 1 }), true);
});

test('connectionChanged: the first save, with nothing before it, reconnects', () => {
  assert.equal(connectionChanged(undefined, DEFAULT_SETTINGS), true);
});

test('connectionChanged: settings saved before tabWindow existed compare equal on connection fields', () => {
  const { tabWindow: _omit, ...old } = DEFAULT_SETTINGS;
  assert.equal(connectionChanged(old, DEFAULT_SETTINGS), false);
});
