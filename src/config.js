// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized.
// -----------------------------------------------------------------------------

import { POLL_INTERVALS, SILENT_MINUTES } from './constants.js';

// Defaults: they MUST match the `default` values of the manifest.
export const DEFAULTS = Object.freeze({
  poll_interval: '300',
  silent_minutes: '1440',
});

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export function normalizeConfig(raw = {}) {
  raw = raw ?? {};
  const pick = (key, list) => (list.includes(String(raw[key])) ? String(raw[key]) : DEFAULTS[key]);
  const username = typeof raw.username === 'string' ? raw.username.trim() : '';
  // A password pasted with its line end: the line end is not part of it.
  const password = typeof raw.password === 'string' ? raw.password.replace(/[\r\n]+$/, '') : '';
  return {
    username,
    password,
    // HTTP Basic: the user name cannot hold ':' and no field a control character.
    usernameInvalid:
      username !== '' &&
      (username.includes(':') || CONTROL.test(username) || username.length > 254),
    passwordInvalid: password !== '' && (CONTROL.test(password) || password.length > 512),
    pollSeconds: Number(pick('poll_interval', POLL_INTERVALS)),
    silentMinutes: Number(pick('silent_minutes', SILENT_MINUTES)),
  };
}
