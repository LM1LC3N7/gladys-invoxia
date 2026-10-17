// -----------------------------------------------------------------------------
// The configuration, normalized.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, normalizeConfig } from '../src/config.js';

test('defaults and choices outside the list', () => {
  const config = normalizeConfig();
  assert.equal(config.pollSeconds, Number(DEFAULTS.poll_interval));
  assert.equal(config.silentMinutes, Number(DEFAULTS.silent_minutes));
  assert.equal(config.username, '');
  assert.equal(normalizeConfig({ poll_interval: '10' }).pollSeconds, 300, 'never under 5 min');
  assert.equal(normalizeConfig({ poll_interval: 600 }).pollSeconds, 600);
  assert.equal(normalizeConfig({ silent_minutes: '2880' }).silentMinutes, 2880);
  assert.equal(normalizeConfig(null).pollSeconds, 300);
});

test('credentials: trimmed address, password kept but its line end, invalid ones said', () => {
  const config = normalizeConfig({ username: ' me@example.org ', password: ' pass word \n' });
  assert.equal(config.username, 'me@example.org');
  assert.equal(config.password, ' pass word ');
  assert.equal(config.usernameInvalid, false);
  assert.equal(config.passwordInvalid, false);
  assert.equal(normalizeConfig({ username: 'a:b' }).usernameInvalid, true);
  assert.equal(normalizeConfig({ username: 'a\nb' }).usernameInvalid, true);
  assert.equal(normalizeConfig({ password: 'a\tb' }).passwordInvalid, true);
  assert.equal(normalizeConfig({ password: 42 }).password, '');
});
