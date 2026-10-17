// -----------------------------------------------------------------------------
// The Invoxia API, as the Invoxia app and gps-tracker 0.9.2 (MIT, ported to
// JavaScript: src/gps_tracker/client/asynchronous.py and url_provider.py)
// use it: HTTP Basic authentication with the e-mail address and password of
// the account, on https://labs.invoxia.io. Read only, two GETs:
//   GET /devices/?type=tracker          the trackers, with their status
//   GET /devices/<id>/tracker_data/     the last locations of one tracker
// The credentials travel in the Authorization header only: never in a URL,
// a log or an error message. A tracker id is part of a path: no URL is ever
// logged either.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { API_URL, MAX_BYTES, TIMEOUTS } from '../constants.js';
import { CODES, InvoxiaError, isApiEnvelope } from './errors.js';
import { httpRequest } from './http.js';
import { parseLocations, parseTrackers } from './parse.js';

/** Seconds of a Retry-After header (delta form only), in ms, or null. */
const retryAfterMs = (value) => {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || !/^\s*\d+\s*$/.test(raw)) return null;
  return Number(raw) * 1000;
};

/** gladys-invoxia/<version>, from package.json (copied into the image). */
export const USER_AGENT = (() => {
  try {
    const { version } = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    return typeof version === 'string' ? `gladys-invoxia/${version}` : 'gladys-invoxia';
  } catch {
    return 'gladys-invoxia';
  }
})();

export class InvoxiaClient {
  /**
   * @param {object} options
   * @param {string} options.username the e-mail address of the Invoxia account
   * @param {string} options.password its password
   * @param {Function} [options.request] the HTTP transport (tests inject a fake Invoxia)
   * @param {string} [options.apiUrl]
   */
  constructor({ username, password, request = httpRequest, apiUrl = API_URL }) {
    // The header is built once; the credentials are not kept otherwise.
    this.authorization = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
    this.request = request;
    this.apiUrl = apiUrl;
    this.closed = false;
  }

  close() {
    this.closed = true;
  }

  async get(path, { account }) {
    if (this.closed) throw new InvoxiaError(CODES.CLOSED, 'Client closed');
    const response = await this.request(`${this.apiUrl}${path}`, {
      headers: { authorization: this.authorization, 'user-agent': USER_AGENT },
      timeout: TIMEOUTS.API,
      maxBytes: MAX_BYTES,
    });
    // 204: nothing for this request (gps-tracker's NoContentQuery).
    if (response.status === 204) return null;
    if (response.status < 200 || response.status > 299) {
      throw new InvoxiaError(CODES.HTTP, `HTTP ${response.status}`, {
        status: response.status,
        retryAfterMs: retryAfterMs(response.headers?.['retry-after']),
        envelope: isApiEnvelope(response.body ?? Buffer.alloc(0)),
        account,
      });
    }
    try {
      return JSON.parse(response.body.toString('utf8'));
    } catch {
      throw new InvoxiaError(CODES.BAD_ANSWER, 'Not JSON');
    }
  }

  /** The trackers of the account. Rejects an InvoxiaError. */
  async trackers() {
    const value = await this.get('/devices/?type=tracker', { account: true });
    const trackers = parseTrackers(value ?? []);
    if (!trackers) throw new InvoxiaError(CODES.BAD_ANSWER, 'Not the list of trackers');
    return trackers;
  }

  /** The newest location of one tracker, or null. Rejects an InvoxiaError. */
  async lastLocation(id) {
    if (!/^\d+$/.test(id)) throw new InvoxiaError(CODES.BAD_ANSWER, 'Not a tracker id');
    const value = await this.get(`/devices/${id}/tracker_data/`, { account: false });
    if (value === null) return null;
    const location = parseLocations(value);
    if (location === undefined) throw new InvoxiaError(CODES.BAD_ANSWER, 'Not a list of locations');
    return location;
  }
}
