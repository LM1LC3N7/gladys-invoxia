// -----------------------------------------------------------------------------
// The only network access of the integration: one GET on node:https (plain
// http only with `allowHttp`, which the loopback tests alone set). A deadline
// for the whole exchange, a size cap on the body, no redirect followed (the
// Basic credentials never go to another host). Resolves
// { status, headers, body } for any status; rejects an InvoxiaError for the
// transport failures. No error message carries the URL nor a header.
// The certificate must be valid for the host name (system authorities).
// -----------------------------------------------------------------------------

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { CODES, InvoxiaError } from './errors.js';

const TLS_ERRORS = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_SIGNATURE_FAILURE',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'CERT_REVOKED',
  'INVALID_CA',
  'HOSTNAME_MISMATCH',
]);

export function transportError(err) {
  const code = String(err?.code ?? '');
  if (TLS_ERRORS.has(code)) {
    return new InvoxiaError(CODES.TLS_UNTRUSTED, `Certificate refused (${code})`);
  }
  // Something answered, but not in HTTP / TLS.
  if (code.startsWith('HPE_') || code === 'EPROTO' || code.startsWith('ERR_SSL_')) {
    return new InvoxiaError(CODES.BAD_ANSWER, `Not the expected protocol (${code})`);
  }
  // Only the code: a Node message may quote the address.
  return new InvoxiaError(CODES.UNREACHABLE, code || 'Connection failed');
}

/**
 * @param {string} url absolute https URL
 * @param {object} options
 * @param {Record<string, string>} [options.headers]
 * @param {number} options.timeout ms for the whole exchange
 * @param {number} options.maxBytes body size cap
 * @param {boolean} [options.allowHttp] plain http (loopback tests only; the app never sets it)
 */
export function httpRequest(url, { headers = {}, timeout, maxBytes, allowHttp = false } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new InvoxiaError(CODES.BAD_ANSWER, 'Refused: not a URL'));
      return;
    }
    if (target.protocol !== 'https:' && !(allowHttp && target.protocol === 'http:')) {
      reject(new InvoxiaError(CODES.BAD_ANSWER, `Refused: ${target.protocol} is not https`));
      return;
    }
    const host = target.hostname.replace(/^\[(.*)\]$/, '$1');
    const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
    let settled = false;
    let req = null;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        req?.destroy();
        reject(error);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(
      () =>
        finish(new InvoxiaError(CODES.TIMEOUT, `No answer within ${Math.round(timeout / 1000)} s`)),
      timeout,
    );

    const options = {
      method: 'GET',
      host,
      port,
      path: `${target.pathname}${target.search}`,
      headers: { accept: 'application/json', host: target.host, ...headers },
    };
    let lib = http;
    if (target.protocol === 'https:') {
      lib = https;
      options.servername = net.isIP(host) ? undefined : host;
      options.rejectUnauthorized = true;
      options.agent = false;
    }
    try {
      req = lib.request(options, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            finish(new InvoxiaError(CODES.TOO_LARGE, `Answer above ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          finish(null, {
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', (err) => finish(transportError(err)));
      });
      req.on('error', (err) => finish(transportError(err)));
      req.end();
    } catch (err) {
      // lib.request throws synchronously on a header it refuses: a failure,
      // never a crash (and never the header in the message).
      finish(transportError(err));
    }
  });
}
