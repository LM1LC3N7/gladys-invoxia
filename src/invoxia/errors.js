// -----------------------------------------------------------------------------
// InvoxiaError: every failure of a request to the Invoxia API, with a code the
// app maps to a status, a retry policy or a message. Messages never carry the
// credentials, a tracker id nor a URL (a tracker id is part of some paths).
// -----------------------------------------------------------------------------

export const CODES = Object.freeze({
  UNREACHABLE: 'unreachable', // no TCP connection
  TIMEOUT: 'timeout', // no answer in time
  TLS_UNTRUSTED: 'tls_untrusted', // certificate refused
  HTTP: 'http', // an HTTP status other than 2xx (see `status`)
  BAD_ANSWER: 'bad_answer', // not the JSON expected
  TOO_LARGE: 'too_large', // answer above the size cap
  CLOSED: 'closed', // the client was replaced (new configuration)
});

export class InvoxiaError extends Error {
  constructor(code, message, { status, retryAfterMs, envelope, account } = {}) {
    super(message);
    this.name = 'InvoxiaError';
    this.code = code;
    if (status !== undefined) this.status = status;
    if (retryAfterMs !== undefined && retryAfterMs !== null) this.retryAfterMs = retryAfterMs;
    /** The error body was the API's own `{ "detail": "<text>" }`, not a page of a proxy. */
    if (envelope !== undefined) this.envelope = envelope;
    /** The request was the account endpoint (the list of trackers). */
    if (account !== undefined) this.account = account;
  }
}

/**
 * The error answer of the Invoxia API (Django REST framework): a JSON object
 * with a `detail` text (`{ "detail": "Invalid username/password." }`).
 */
export function isApiEnvelope(body) {
  try {
    const value = JSON.parse(body.toString('utf8'));
    return (
      Boolean(value) &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof value.detail === 'string'
    );
  } catch {
    return false;
  }
}

/**
 * The credentials refused: HTTP 401 on any request (wrong e-mail address or
 * password), or HTTP 403 answered by the API itself (`{ "detail": ... }`) on
 * the account endpoint (the account may not read its trackers). A 403 page
 * that is not the API's (a firewall, a CDN) is not about the credentials: it
 * is retried like an unexpected answer, never faster than the interval. A
 * 403 of the API on the locations of one tracker only skips that position.
 * Trying a wrong password again and again may lock the account: the app
 * stops for a long, growing delay.
 */
export const isRefused = (err) =>
  err?.code === CODES.HTTP &&
  (err.status === 401 || (err.status === 403 && err.envelope === true && err.account === true));
