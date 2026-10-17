// -----------------------------------------------------------------------------
// The transport (src/invoxia/http.js) and the client against loopback http
// servers: deadline, size cap, no redirect, no URL in an error.
// -----------------------------------------------------------------------------

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { InvoxiaClient } from '../src/invoxia/client.js';
import { CODES, InvoxiaError, isRefused } from '../src/invoxia/errors.js';
import { httpRequest } from '../src/invoxia/http.js';

let server;
let base;
const seen = [];

before(async () => {
  server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    if (req.url === '/slow') return; // never answers
    if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(Buffer.alloc(4096, 0x20));
      return;
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'https://elsewhere.example.org/' });
      res.end();
      return;
    }
    if (req.url === '/devices/?type=tracker') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ id: 7, name: 'T', type: 'tracker_04', tracker_status: {} }]));
      return;
    }
    if (req.url === '/devices/7/tracker_data/') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.url === '/devices/8/tracker_data/') {
      res.writeHead(429, { 'retry-after': '120', 'content-type': 'application/json' });
      res.end('{"detail":"Request was throttled."}');
      return;
    }
    res.writeHead(403, { 'content-type': 'text/html' });
    res.end('<html>Forbidden</html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

const loopback = (url, options) => httpRequest(url, { ...options, allowHttp: true });

test('plain http is refused unless the loopback tests allow it', async () => {
  await assert.rejects(httpRequest(`${base}/x`, { timeout: 1000, maxBytes: 100 }), (err) => {
    assert.equal(err.code, CODES.BAD_ANSWER);
    assert.ok(!err.message.includes('127.0.0.1'));
    return true;
  });
});

test('a deadline, a size cap, no redirect followed; no URL in the errors', async () => {
  await assert.rejects(loopback(`${base}/slow`, { timeout: 200, maxBytes: 100 }), (err) => {
    assert.equal(err.code, CODES.TIMEOUT);
    assert.ok(!err.message.includes('slow'));
    return true;
  });
  await assert.rejects(loopback(`${base}/big`, { timeout: 2000, maxBytes: 1000 }), {
    code: CODES.TOO_LARGE,
  });
  const redirect = await loopback(`${base}/redirect`, { timeout: 2000, maxBytes: 1000 });
  assert.equal(redirect.status, 302, 'given back, not followed');
  await assert.rejects(
    loopback('http://127.0.0.1:1/x', { timeout: 2000, maxBytes: 100 }),
    (err) => err instanceof InvoxiaError && err.code === CODES.UNREACHABLE,
  );
});

test('the client: Basic header, 204 is no location, a proxy 403 is no refusal, Retry-After', async () => {
  const client = new InvoxiaClient({
    username: 'user@example.org',
    password: 'pässword',
    request: loopback,
    apiUrl: base,
  });
  const trackers = await client.trackers();
  assert.equal(trackers.length, 1);
  const header = seen.at(-1).headers.authorization;
  assert.equal(
    Buffer.from(header.replace(/^Basic /, ''), 'base64').toString('utf8'),
    'user@example.org:pässword',
  );
  assert.equal(await client.lastLocation('7'), null);
  await assert.rejects(client.lastLocation('8'), (err) => {
    assert.equal(err.status, 429);
    assert.equal(err.retryAfterMs, 120_000);
    assert.equal(isRefused(err), false);
    return true;
  });
  await assert.rejects(client.lastLocation('9'), (err) => {
    assert.equal(err.status, 403);
    assert.equal(err.envelope, false);
    assert.equal(isRefused(err), false);
    return true;
  });
  await assert.rejects(client.lastLocation('../x'), { code: CODES.BAD_ANSWER });
  client.close();
  await assert.rejects(client.trackers(), { code: CODES.CLOSED });
});

test('what a refusal is', () => {
  const http401 = new InvoxiaError(CODES.HTTP, 'HTTP 401', { status: 401, account: false });
  assert.equal(isRefused(http401), true);
  const api403 = (account) =>
    new InvoxiaError(CODES.HTTP, 'HTTP 403', { status: 403, envelope: true, account });
  assert.equal(isRefused(api403(true)), true, 'the account may not read its trackers');
  assert.equal(isRefused(api403(false)), false, 'one tracker only');
  assert.equal(isRefused(new InvoxiaError(CODES.HTTP, 'HTTP 404', { status: 404 })), false);
});
