// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and the fake Invoxia API,
// through the exact wiring of the container (src/handlers.js).
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { InvoxiaApp } from '../src/app.js';
import { ACTIONS, INTERVALS, LIMITS, SCENE_TRIGGERS } from '../src/constants.js';
import { buildDevice, trackerKey } from '../src/devices.js';
import { registerHandlers } from '../src/handlers.js';
import { PASSWORD, USERNAME, createFakeInvoxia, location, tracker } from './helpers/fakeInvoxia.js';
import { createFakeTimers } from './helpers/fakeTimers.js';

const T0 = Date.parse('2026-10-18T08:00:00Z');
const MIN = 60_000;
const HOUR = 3600_000;
const POLL = 300_000;
const SELECTOR = 'invoxia';
const ids = createFakeGladys({ selector: SELECTOR });
const BASE_CONFIG = { username: USERNAME, password: PASSWORD };
const WRONG = 'not-the-password';
const VELO = 878858;
const REX = 444000;
const device = (id, name, options = {}) =>
  buildDevice(ids, { key: trackerKey(id), name, ...options });
const featureId = (id, feature) => `ext:${SELECTOR}:device:${trackerKey(id)}:${feature}`;
const deviceId = (id) => `ext:${SELECTOR}:device:${trackerKey(id)}`;

let running;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

async function setup({
  config = {},
  created = [device(VELO, 'Vélo', { hasMoving: true }), device(REX, 'Rex')],
  invoxia,
  dataDir,
  now = T0,
} = {}) {
  const clock = { now, jump: 0 };
  invoxia ??= createFakeInvoxia();
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: { ...BASE_CONFIG, ...config },
    devices: created,
  });
  const timers = createFakeTimers();
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map((a) => a?.stack ?? String(a)).join(' ')}`),
    ]),
  );
  dataDir ??= mkdtempSync(join(tmpdir(), 'invoxia-app-'));
  const app = new InvoxiaApp({
    gladys,
    logger,
    request: invoxia.request,
    dataDir,
    now: () => clock.now,
    // The monotonic clock follows the test clock unless a test makes the
    // wall clock jump (clock.jump).
    monotonic: () => clock.now - clock.jump,
    timers,
  });
  running = app;
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  return { gladys, invoxia, timers, clock, logs, app, dataDir };
}

const poll = (timers, ms = POLL) => timers.run((delay) => delay === ms);
const last = (gladys, id, feature) => gladys.fake.lastState(featureId(id, feature));
const storeText = (dataDir) =>
  readdirSync(dataDir)
    .map((file) => readFileSync(join(dataDir, file), 'utf8'))
    .join('\n');
/** Emit `connected` again (Gladys came back) and wait for the restart. */
async function reconnect(gladys, app) {
  gladys.emit('connected');
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  await app.queue;
}
const statusOf = (invoxia, id) => invoxia.trackers.find((t) => t.id === id).tracker_status;

test('start: status, Discovery, every value, badges; read every 5 min', async () => {
  const { gladys, invoxia, timers } = await setup();
  assert.deepEqual(gladys.fake.connectionStatus, {
    connected: true,
    message: {
      en: 'Invoxia answers: 2 trackers, 0 silent for more than 24 h.',
      fr: 'Invoxia répond : 2 traceurs, 0 muet depuis plus de 24 h.',
    },
  });
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((d) => [d.external_id, d.name, d.model]),
    [
      [deviceId(REX), 'Rex', 'Invoxia GPS tracker'],
      [deviceId(VELO), 'Vélo', 'Invoxia GPS tracker'],
    ],
  );
  const [rex, velo] = gladys.fake.discoveredDevices;
  assert.ok(!rex.features.some((f) => f.external_id.endsWith(':moving')), 'stationary -1');
  assert.ok(velo.features.some((f) => f.external_id.endsWith(':moving')));
  for (const f of velo.features) {
    if (/:(latitude|longitude|accuracy)$/.test(f.external_id)) assert.equal(f.keep_history, false);
  }
  assert.equal(last(gladys, VELO, 'latitude'), 48.8566, 'the newest location');
  assert.equal(last(gladys, VELO, 'longitude'), 2.3522);
  assert.equal(last(gladys, VELO, 'accuracy'), 25);
  assert.equal(last(gladys, VELO, 'battery'), 80);
  assert.equal(last(gladys, VELO, 'moving'), 1, 'stationary 0');
  assert.equal(last(gladys, VELO, 'last_seen'), '2026-10-18 07:58 UTC', 'the last event');
  assert.equal(last(gladys, VELO, 'silent'), 0);
  assert.equal(last(gladys, REX, 'latitude'), 45.764);
  assert.equal(last(gladys, REX, 'accuracy'), 75);
  assert.equal(last(gladys, REX, 'battery'), 15);
  assert.equal(last(gladys, REX, 'last_seen'), '2026-10-18 05:30 UTC');
  assert.equal(last(gladys, REX, 'moving'), undefined, 'unknown: nothing published');
  assert.equal(gladys.fake.transports.length, 2);
  assert.ok(gladys.fake.transports.every((t) => t.transport === 'cloud'));
  assert.deepEqual(timers.delays(), [POLL]);
  assert.equal(invoxia.requests[0].url, 'https://labs.invoxia.io/devices/?type=tracker');
  assert.equal(
    invoxia.requests[0].headers.authorization,
    `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64')}`,
  );
  assert.match(invoxia.requests[0].headers['user-agent'], /^gladys-invoxia\/0\.1\.0$/);
  assert.equal(invoxia.locationRequests().length, 2);
  assert.equal(gladys.fake.sceneEvents.length, 0, 'nothing at the first reading');
  await poll(timers);
  assert.equal(invoxia.listRequests().length, 2);
  assert.equal(invoxia.locationRequests().length, 2, 'nothing moved: no location read');
  assert.deepEqual(timers.delays(), [POLL]);
});

test('a location is read again only when the status of its tracker moves on', async () => {
  const { gladys, invoxia, timers } = await setup();
  statusOf(invoxia, VELO).last_event = '2026-10-18T08:03:00Z';
  invoxia.locations[VELO] = [location({ datetime: '2026-10-18T08:02:00Z', lat: '48.9' })];
  await poll(timers);
  assert.deepEqual(
    invoxia.locationRequests().map((r) => r.path),
    [
      `/devices/${REX}/tracker_data/`,
      `/devices/${VELO}/tracker_data/`,
      `/devices/${VELO}/tracker_data/`,
    ],
  );
  assert.equal(last(gladys, VELO, 'latitude'), 48.9);
  assert.equal(last(gladys, VELO, 'last_seen'), '2026-10-18 08:03 UTC');
});

test('a newer position in the status wins; its accuracy is not invented', async () => {
  const invoxia = createFakeInvoxia();
  Object.assign(statusOf(invoxia, VELO), {
    last_location: '2026-10-18T07:59:00Z',
    last_loc_latitude: 43.2965,
    last_loc_longitude: 5.3698,
  });
  const { gladys } = await setup({ invoxia });
  assert.equal(last(gladys, VELO, 'latitude'), 43.2965);
  assert.equal(last(gladys, VELO, 'longitude'), 5.3698);
  assert.equal(last(gladys, VELO, 'accuracy'), undefined);
  assert.equal(last(gladys, VELO, 'last_seen'), '2026-10-18 07:59 UTC');
});

test('privacy: no credentials, position, name nor tracker id in the logs or /data', async () => {
  const { gladys, invoxia, timers, logs, dataDir } = await setup({ config: { password: WRONG } });
  await gladys.fake.configUpdated({ ...BASE_CONFIG });
  invoxia.failures.push({ status: 503 });
  await poll(timers);
  const written = storeText(dataDir);
  const basic = Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');
  for (const secret of [
    USERNAME,
    'someone',
    PASSWORD,
    WRONG,
    basic,
    '48.85',
    '2.35',
    '45.76',
    'Vélo',
    'Rex',
    String(VELO),
    String(REX),
  ]) {
    assert.ok(!logs.some((l) => l.includes(secret)), `log: ${secret}`);
    assert.ok(!written.includes(secret), `/data: ${secret}`);
  }
  // External ids carry digests, never the Invoxia id nor the serial.
  const published = JSON.stringify(gladys.fake.discoveredDevices);
  assert.ok(!published.includes(String(VELO)) && !published.includes('abcdef0123456789'));
});

test('the silent trigger: once per silence and threshold, never at the first reading', async () => {
  const { gladys, invoxia, timers, clock } = await setup();
  const events = () => gladys.fake.sceneEvents.map((e) => [e.data.device_name, e.data.minutes]);
  // Vélo: last event at 07:58. At 08:58 it is silent for 60 min.
  clock.now = T0 + 58 * MIN;
  await poll(timers);
  assert.deepEqual(events(), [['Vélo', '60']]);
  const [first] = gladys.fake.sceneEvents;
  assert.equal(first.key, SCENE_TRIGGERS.DEVICE_SILENT);
  assert.deepEqual(first.data, {
    device: deviceId(VELO),
    minutes: '60',
    device_name: 'Vélo',
    silent_for: 60,
    last_seen: '2026-10-18 07:58 UTC',
  });
  clock.now = T0 + 63 * MIN;
  await poll(timers);
  assert.equal(gladys.fake.sceneEvents.length, 1, 'not twice');
  // Rex was already silent for 150 min at start: 60, 120 never fire; 240 does.
  clock.now = T0 + 120 * MIN;
  await poll(timers);
  assert.deepEqual(events(), [
    ['Vélo', '60'],
    ['Rex', '240'],
    ['Vélo', '120'],
  ]);
  // News from Vélo ends its silence: the next one fires again.
  statusOf(invoxia, VELO).last_event = '2026-10-18T10:01:00Z';
  clock.now = T0 + 122 * MIN;
  await poll(timers);
  assert.equal(gladys.fake.sceneEvents.length, 3);
  assert.equal(last(gladys, VELO, 'silent'), 0);
  clock.now = T0 + 182 * MIN;
  await poll(timers);
  assert.deepEqual(events().at(-1), ['Vélo', '60']);
});

test('a restart of the app (Gladys came back) keeps the silences: no event again', async () => {
  const { gladys, timers, clock, app } = await setup();
  clock.now = T0 + 58 * MIN;
  await poll(timers);
  assert.equal(gladys.fake.sceneEvents.length, 1);
  await reconnect(gladys, app);
  clock.now = T0 + 63 * MIN;
  await poll(timers);
  assert.equal(gladys.fake.sceneEvents.length, 1);
});

test('refused credentials stop for 1 h, 6 h, 24 h, persisted: never a loop', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'invoxia-app-'));
  const { gladys, invoxia, timers, app } = await setup({ config: { password: WRONG }, dataDir });
  assert.equal(invoxia.requests.length, 1);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /refused the e-mail address.*HTTP 401/);
  assert.match(gladys.fake.connectionStatus.message.en, /stops for 1 h/);
  assert.match(gladys.fake.connectionStatus.message.fr, /a refusé l’adresse e-mail/);
  assert.deepEqual(timers.delays(), [HOUR]);
  assert.ok(gladys.fake.transports.every((t) => t.transport === 'unreachable'));
  // Gladys comes back, the test button: nothing reaches Invoxia.
  await reconnect(gladys, app);
  assert.match(gladys.fake.connectionStatus.message.en, /refused these credentials earlier/);
  const ack = await gladys.fake.action(ACTIONS.TEST);
  assert.equal(ack.success, false);
  assert.equal(invoxia.requests.length, 1);
  // A restart of the container: the stop holds (read from /data).
  await running.stop();
  const second = await setup({ config: { password: WRONG }, dataDir, invoxia, now: T0 + 10 * MIN });
  assert.equal(invoxia.requests.length, 1, 'the restart sent nothing');
  assert.deepEqual(second.timers.delays(), [50 * MIN]);
  // The end of the stop: one attempt, refused again: 6 h, then 24 h, 24 h.
  second.clock.now = T0 + HOUR;
  await second.timers.run();
  assert.equal(invoxia.requests.length, 2);
  assert.deepEqual(second.timers.delays(), [6 * HOUR]);
  second.clock.now += 6 * HOUR;
  await second.timers.run();
  assert.deepEqual(second.timers.delays(), [24 * HOUR]);
  second.clock.now += 24 * HOUR;
  await second.timers.run();
  assert.deepEqual(second.timers.delays(), [24 * HOUR]);
  assert.equal(invoxia.requests.length, 4);
  // Saving the configuration: one attempt at once (refused: still 24 h).
  await second.gladys.fake.configUpdated({ ...BASE_CONFIG, password: WRONG });
  assert.equal(invoxia.requests.length, 5);
  assert.deepEqual(second.timers.delays(), [24 * HOUR]);
  // The right password works and the refusal is forgotten.
  await second.gladys.fake.configUpdated({ ...BASE_CONFIG });
  assert.equal(second.gladys.fake.connectionStatus.connected, true);
  assert.doesNotMatch(storeText(dataDir), /"refusals": \{\s*"/, 'no refusal left');
});

test('403 of the API on the list is a refusal; a 403 page of a proxy is retried', async () => {
  const invoxia = createFakeInvoxia();
  invoxia.failures.push({ status: 403, body: '{"detail":"You do not have permission."}' });
  const first = await setup({ invoxia });
  assert.match(first.gladys.fake.connectionStatus.message.en, /HTTP 403/);
  assert.deepEqual(first.timers.delays(), [HOUR]);
  await running.stop();
  const proxy = createFakeInvoxia();
  proxy.failures.push(
    { status: 403, body: '<html>Forbidden</html>' },
    { status: 403, body: '<html>Forbidden</html>' },
  );
  const { gladys, timers } = await setup({ invoxia: proxy });
  assert.match(gladys.fake.connectionStatus.message.en, /not about the credentials/);
  assert.deepEqual(timers.delays(), [POLL], 'never faster than the interval');
  await timers.run();
  assert.deepEqual(timers.delays(), [2 * POLL], 'doubling');
  await timers.run();
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('HTTP 429: a bounded pause of every path, kept across a restart', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'invoxia-app-'));
  const invoxia = createFakeInvoxia();
  invoxia.failures.push({ status: 429, headers: { 'retry-after': '99999999' } });
  const { gladys, timers, app } = await setup({ invoxia, dataDir });
  assert.match(gladys.fake.connectionStatus.message.en, /slow down/);
  assert.deepEqual(timers.delays(), [INTERVALS.BUSY_MAX_MS], 'capped at 6 h');
  await reconnect(gladys, app);
  assert.equal(invoxia.requests.length, 1, 'a reconnection does not read');
  assert.match(gladys.fake.connectionStatus.message.en, /pause goes on/);
  await running.stop();
  const second = await setup({ invoxia, dataDir, now: T0 + HOUR });
  assert.equal(invoxia.requests.length, 1, 'nor a restart');
  assert.deepEqual(second.timers.delays(), [5 * HOUR]);
  second.clock.now = T0 + 6 * HOUR;
  await second.timers.run();
  assert.equal(second.gladys.fake.connectionStatus.connected, true);
  assert.ok(!storeText(dataDir).includes('pausedUntil'), 'forgotten after a reading that works');
});

test('HTTP 429 without Retry-After, and 5xx: paused at least for the interval', async () => {
  const invoxia = createFakeInvoxia();
  invoxia.failures.push({ status: 429 }, { status: 503 });
  const { gladys, timers } = await setup({ invoxia, config: { poll_interval: '600' } });
  assert.deepEqual(timers.delays(), [600_000]);
  await timers.run();
  assert.match(gladys.fake.connectionStatus.message.en, /server error \(HTTP 503/);
  assert.deepEqual(timers.delays(), [600_000]);
  await timers.run();
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('the locations endpoint fails: the status of the trackers is still published', async () => {
  const invoxia = createFakeInvoxia();
  // A 403 on one tracker: that position only is skipped.
  invoxia.failures.push({ status: 403, path: `/devices/${REX}/`, body: '{"detail":"no"}' });
  const { gladys, timers, dataDir } = await setup({ invoxia });
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(last(gladys, REX, 'latitude'), undefined);
  assert.equal(last(gladys, REX, 'battery'), 15);
  assert.equal(last(gladys, VELO, 'latitude'), 48.8566);
  // A 503 on a location: the states go, then every path pauses.
  invoxia.failures.push({ status: 503, path: `/devices/${REX}/` });
  statusOf(invoxia, REX).battery = 14;
  await poll(timers);
  assert.equal(last(gladys, REX, 'battery'), 14);
  assert.match(gladys.fake.connectionStatus.message.en, /server error \(HTTP 503/);
  assert.ok(storeText(dataDir).includes('pausedUntil'));
  assert.deepEqual(timers.delays(), [POLL]);
  // A timeout: the other location reads of the round are skipped, still connected.
  await timers.run();
  assert.equal(gladys.fake.connectionStatus.connected, true);
  const before = invoxia.locationRequests().length;
  statusOf(invoxia, VELO).last_event = '2026-10-18T08:20:00Z';
  statusOf(invoxia, REX).last_event = '2026-10-18T08:20:00Z';
  const original = invoxia.request;
  invoxia.request = async (url, options) => {
    if (url.includes('tracker_data')) {
      invoxia.requests.push({ url, path: new URL(url).pathname, headers: {} });
      const { InvoxiaError, CODES } = await import('../src/invoxia/errors.js');
      throw new InvoxiaError(CODES.TIMEOUT, 'No answer within 30 s');
    }
    return original(url, options);
  };
  running.request = invoxia.request;
  running.client.request = invoxia.request;
  await poll(timers);
  assert.equal(invoxia.locationRequests().length, before + 1, 'one timeout, then none');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(last(gladys, VELO, 'last_seen'), '2026-10-18 08:20 UTC');
});

test('a 401 on the locations is a refusal too (after the states)', async () => {
  const invoxia = createFakeInvoxia();
  invoxia.failures.push({ status: 401, path: `/devices/${REX}/` });
  const { gladys, timers } = await setup({ invoxia });
  assert.equal(last(gladys, REX, 'battery'), 15);
  assert.match(gladys.fake.connectionStatus.message.en, /refused the e-mail address/);
  assert.deepEqual(timers.delays(), [HOUR]);
});

test('after a stop, credentials that work then a 429 on a location: a pause, no refusal', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'invoxia-app-'));
  const invoxia = createFakeInvoxia();
  invoxia.failures.push(REFUSED);
  const { gladys, timers, clock } = await setup({ invoxia, dataDir });
  assert.deepEqual(timers.delays(), [HOUR]);
  invoxia.failures.push({
    status: 429,
    path: `/devices/${REX}/`,
    headers: { 'retry-after': '600' },
  });
  clock.now = T0 + HOUR;
  await timers.run();
  assert.match(gladys.fake.connectionStatus.message.en, /slow down/);
  assert.deepEqual(timers.delays(), [600_000]);
  assert.doesNotMatch(storeText(dataDir), /"refusals": \{\s*"/, 'the refusal is forgotten');
});

test('a failure is never read again faster than the interval, even after a reconnection', async () => {
  const invoxia = createFakeInvoxia();
  const { gladys, timers, app } = await setup({ invoxia });
  invoxia.unreachable = true;
  await poll(timers);
  assert.match(gladys.fake.connectionStatus.message.en, /does not answer: no connection/);
  assert.deepEqual(timers.delays(), [POLL]);
  const before = invoxia.requests.length;
  await reconnect(gladys, app);
  assert.equal(invoxia.requests.length, before, 'the wait is not skipped');
  assert.equal(gladys.fake.discoveredDevices.length, 2, 'Discovery from the trackers known');
  assert.ok(gladys.fake.transports.at(-1).transport === 'unreachable');
  invoxia.unreachable = false;
  const ack = await gladys.fake.action(ACTIONS.TEST);
  assert.equal(ack.success, true, ack.error);
  assert.match(ack.data.message.en, /Connected: 2 trackers, 0 silent/);
});

test('the status and Discovery are sent again at every connection to Gladys', async () => {
  const { gladys, app } = await setup();
  const statuses = gladys.fake.connectionStatuses.length;
  const discoveries = gladys.fake.bodies('POST', '/discovered_device').length;
  await reconnect(gladys, app);
  assert.equal(gladys.fake.connectionStatuses.length, statuses + 1);
  assert.equal(gladys.fake.bodies('POST', '/discovered_device').length, discoveries + 1);
});

test('a published device never loses a feature of the created one', async () => {
  const rex = device(REX, 'Rex', { hasMoving: true });
  rex.features.push({ ...rex.features[0], external_id: `${rex.external_id}:old_feature` });
  const { gladys } = await setup({ created: [device(VELO, 'Vélo'), rex] });
  const published = gladys.fake.discoveredDevices.find((d) => d.name === 'Rex');
  const kept = published.features.map((f) => f.external_id.split(':').at(-1));
  assert.ok(kept.includes('moving'), 'moving of the created device kept');
  assert.ok(kept.includes('old_feature'));
  // Vélo was created without "moving": no state until "Update".
  assert.equal(last(gladys, VELO, 'moving'), undefined);
});

test('the cap of 20 keeps the created trackers first; one request per new location', async () => {
  const invoxia = createFakeInvoxia();
  invoxia.trackers = [];
  invoxia.locations = {};
  for (let i = 0; i < 25; i += 1) {
    const id = 100 + i;
    invoxia.trackers.push(tracker(id, `T${String(i).padStart(2, '0')}`));
    invoxia.locations[id] = [location()];
  }
  const { gladys } = await setup({ invoxia, created: [device(124, 'T24')] });
  assert.match(
    gladys.fake.connectionStatus.message.en,
    /25 trackers.*5 more trackers are left out/,
  );
  assert.equal(last(gladys, 124, 'latitude'), 48.8566, 'created: followed beyond the 20th');
  const names = gladys.fake.discoveredDevices.map((d) => d.name);
  assert.equal(names.length, LIMITS.DEVICES);
  assert.ok(names.includes('T24') && !names.includes('T19'));
  assert.equal(invoxia.locationRequests().length, LIMITS.DEVICES);
  assert.ok(gladys.fake.states.length <= LIMITS.STATES_PER_MINUTE);
});

test('read only: every command is refused, nothing reaches Invoxia', async () => {
  const { gladys, invoxia } = await setup();
  const velo = device(VELO, 'Vélo', { hasMoving: true });
  const before = invoxia.requests.length;
  for (const feature of velo.features) {
    const ack = await gladys.fake.setValue(velo, feature, 0);
    assert.equal(ack.success, false);
    assert.match(ack.error, /only reads Invoxia/);
  }
  assert.equal(invoxia.requests.length, before);
});

test('configuration errors: said, nothing sent', async () => {
  const cases = [
    [{ username: '' }, /Type the e-mail address and the password/],
    [{ password: '' }, /Type the e-mail address and the password/],
    [{ username: 'a:b@example.org' }, /cannot hold ":"/],
    [{ password: 'pass\u0007word' }, /control character/],
  ];
  for (const [config, message] of cases) {
    const { gladys, invoxia, timers } = await setup({ config });
    assert.equal(gladys.fake.connectionStatus.connected, false);
    assert.match(gladys.fake.connectionStatus.message.en, message);
    assert.equal(invoxia.requests.length, 0);
    assert.equal(timers.pending.size, 0);
    await running.stop();
  }
});

test('a password pasted with its line end works; the e-mail address is trimmed', async () => {
  const { gladys } = await setup({
    config: { username: `  ${USERNAME} `, password: `${PASSWORD}\r\n` },
  });
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('an empty account; a tracker removed from the account turns unreachable', async () => {
  const invoxia = createFakeInvoxia();
  const { gladys, timers } = await setup({ invoxia });
  invoxia.trackers = invoxia.trackers.filter((t) => t.id !== REX);
  await poll(timers);
  const badges = Object.fromEntries(
    gladys.fake.transports.map((t) => [t.device_external_id, t.transport]),
  );
  assert.equal(badges[deviceId(REX)], 'unreachable');
  assert.equal(badges[deviceId(VELO)], 'cloud');
  invoxia.trackers = [];
  await poll(timers);
  assert.match(gladys.fake.connectionStatus.message.en, /has no tracker/);
});

test('Discovery (scan): one reading, published', async () => {
  const { gladys, invoxia } = await setup();
  const before = invoxia.listRequests().length;
  await gladys.fake.scanRequest();
  assert.equal(invoxia.listRequests().length, before + 1);
  assert.equal(gladys.fake.discoveredDevices.length, 2);
});

const REFUSED = { status: 401, body: '{"detail":"Invalid username/password."}' };
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
/** Hold the next answers of the fake Invoxia until release() is called. */
function hold(invoxia) {
  let release;
  invoxia.gate = new Promise((resolve) => {
    release = () => {
      invoxia.gate = null;
      resolve();
    };
  });
  return () => release();
}

for (const [label, failure, delay, message] of [
  ['a refusal', REFUSED, HOUR, /refused these credentials earlier/],
  ['a 429', { status: 429, headers: { 'retry-after': '3600' } }, HOUR, /pause goes on/],
]) {
  test(`${label} answered while Gladys was away is kept: the reconnection waits`, async () => {
    const { gladys, invoxia, timers, app } = await setup();
    invoxia.failures.push(failure);
    const release = hold(invoxia);
    const sent = invoxia.requests.length;
    const polling = poll(timers);
    for (let i = 0; i < 100 && invoxia.requests.length === sent; i += 1) await tick();
    assert.equal(invoxia.requests.length, sent + 1, 'the request left');
    gladys.emit('disconnected');
    await tick();
    release();
    await polling;
    const requests = invoxia.requests.length;
    await reconnect(gladys, app);
    assert.equal(invoxia.requests.length, requests, 'nothing sent at the reconnection');
    assert.deepEqual(timers.delays(), [delay]);
    assert.match(gladys.fake.connectionStatus.message.en, message);
  });
}

test('an attempt after a refusal still in flight at a restart counts as a refusal', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'invoxia-app-'));
  const { invoxia, timers, clock } = await setup({ config: { password: WRONG }, dataDir });
  clock.now = T0 + HOUR;
  const release = hold(invoxia);
  const attempt = timers.run();
  for (let i = 0; i < 100 && invoxia.requests.length < 2; i += 1) await tick();
  assert.equal(invoxia.requests.length, 2, 'the attempt left');
  // The container restarts before the answer.
  const second = await setup({ config: { password: WRONG }, dataDir, invoxia, now: T0 + HOUR });
  assert.equal(invoxia.requests.length, 2);
  assert.deepEqual(second.timers.delays(), [6 * HOUR], 'one more step');
  release();
  await attempt;
});

/** Wait (real time) until the fake has received `count` requests. */
async function untilRequests(invoxia, count) {
  for (let i = 0; i < 400 && invoxia.requests.length < count; i += 1) await tick();
  assert.equal(invoxia.requests.length, count);
}

test('a reconnection during the attempt after a stop waits for it: a success stays a success', async () => {
  const { gladys, invoxia, timers, clock, app } = await setup({ config: { password: WRONG } });
  // The credentials work again, then one refusal: the attempt after the stop leaves.
  await gladys.fake.configUpdated({ ...BASE_CONFIG });
  invoxia.failures.push(REFUSED);
  clock.now += 5 * MIN;
  await poll(timers);
  assert.deepEqual(timers.delays(), [HOUR]);
  clock.now += HOUR;
  const sent = invoxia.requests.length;
  const release = hold(invoxia);
  const attempt = timers.run();
  await untilRequests(invoxia, sent + 1);
  // Gladys reconnects while the attempt is in flight; then it succeeds.
  gladys.emit('connected');
  await tick();
  assert.equal(invoxia.inFlight, 1, 'the reconnection waits: no second request');
  release();
  await attempt;
  for (let i = 0; i < 5; i += 1) await tick();
  await app.queue;
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.deepEqual(timers.delays(), [POLL], 'no 6 h wait');
  assert.equal(invoxia.maxInFlight, 1);
});

test('saving the same refused credentials: one forced attempt per series of refusals', async () => {
  const { gladys, invoxia } = await setup({ config: { password: WRONG } });
  assert.equal(invoxia.requests.length, 1);
  for (let i = 0; i < 5; i += 1) {
    await gladys.fake.configUpdated({ ...BASE_CONFIG, password: WRONG });
  }
  assert.equal(invoxia.requests.length, 2, '5 saves, 1 request');
  assert.match(gladys.fake.connectionStatus.message.en, /Already tried again.*next attempt in 6 h/);
  // Other credentials are tried at once.
  await gladys.fake.configUpdated({ ...BASE_CONFIG });
  assert.equal(invoxia.listRequests().length, 3);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('within a series of refusals, a timeout waits for the end of the step', async () => {
  const { gladys, invoxia, timers, clock } = await setup({ config: { password: WRONG } });
  invoxia.unreachable = true;
  clock.now = T0 + HOUR;
  await timers.run();
  assert.equal(invoxia.requests.length, 2);
  assert.deepEqual(timers.delays(), [HOUR], 'not 5 minutes');
  assert.match(gladys.fake.connectionStatus.message.en, /does not answer/);
});

test('a refusal read back is capped by the delay of its own step', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'invoxia-app-'));
  const { invoxia } = await setup({ config: { password: WRONG }, dataDir });
  await running.stop();
  // The clock went back 20 h: the 1 h stop would otherwise last 21 h.
  const second = await setup({
    config: { password: WRONG },
    dataDir,
    invoxia,
    now: T0 - 20 * HOUR,
  });
  assert.deepEqual(second.timers.delays(), [HOUR]);
});

test('one tracker with an absurd answer never blocks the others', async () => {
  const invoxia = createFakeInvoxia();
  statusOf(invoxia, REX).last_event = '3026-01-01T00:00:00Z';
  statusOf(invoxia, REX).battery = 'lots';
  invoxia.trackers.push({ id: 'x', name: 'Bad' }, null, { id: 5, type: 'android', name: 'Phone' });
  invoxia.locations[REX] = [location({ datetime: 'yesterday' }), location({ lat: '999' })];
  const { gladys } = await setup({ invoxia });
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(gladys.fake.discoveredDevices.length, 2, 'no phone, no tracker without id');
  assert.equal(last(gladys, VELO, 'latitude'), 48.8566);
  assert.equal(last(gladys, REX, 'last_seen'), undefined, 'no date');
  assert.equal(last(gladys, REX, 'battery'), undefined);
  assert.equal(last(gladys, REX, 'latitude'), undefined);
});

test('an internal error is never shown as Invoxia not answering; too large is said', async () => {
  const { gladys, timers, app, logs } = await setup();
  app.statesOf = () => {
    throw new TypeError('boom');
  };
  await poll(timers);
  assert.match(gladys.fake.connectionStatus.message.en, /Internal error of the integration/);
  assert.ok(logs.some((l) => l.startsWith('error Internal error')));
  delete app.statesOf;
  const big = createFakeInvoxia();
  big.request = async () => {
    const { InvoxiaError, CODES } = await import('../src/invoxia/errors.js');
    throw new InvoxiaError(CODES.TOO_LARGE, 'Answer above 1048576 bytes');
  };
  const second = await setup({ invoxia: big });
  assert.match(second.gladys.fake.connectionStatus.message.en, /answer is too large/);
  assert.doesNotMatch(second.gladys.fake.connectionStatus.message.en, /does not answer/);
});

test('only the trackers created in Gladys fire; a date in the future is no baseline', async () => {
  const invoxia = createFakeInvoxia();
  // Carl is not created; Dan's last event is 10 min in the future (Gladys late).
  invoxia.trackers.push(
    tracker(1, 'Carl'),
    tracker(2, 'Dan', { last_event: '2026-10-18T08:10:00Z' }),
  );
  const { gladys, timers, clock } = await setup({
    invoxia,
    created: [device(VELO, 'Vélo', { hasMoving: true }), device(REX, 'Rex'), device(2, 'Dan')],
  });
  // The clock of Gladys is set right: Dan is in fact 65 min silent.
  clock.now = T0 + 75 * MIN;
  await poll(timers);
  const names = gladys.fake.sceneEvents.map((e) => e.data.device_name);
  assert.ok(!names.includes('Carl'), 'not created: no event');
  assert.ok(!names.includes('Dan'), 'first real reading of Dan: baseline');
  assert.ok(names.includes('Vélo'));
});

test('a jump of the wall clock makes the reading a new baseline', async () => {
  const { gladys, timers, clock } = await setup();
  clock.now = T0 + 70 * MIN;
  clock.jump = 69 * MIN; // the wall clock moved 69 min more than the monotonic one
  await poll(timers);
  assert.equal(gladys.fake.sceneEvents.length, 0, 'Vélo crossed 60 min only through the jump');
  clock.now = T0 + 125 * MIN;
  await poll(timers);
  assert.deepEqual(
    gladys.fake.sceneEvents.map((e) => [e.data.device_name, e.data.minutes]),
    [
      ['Rex', '240'],
      ['Vélo', '120'],
    ],
    'only what was crossed after the jump',
  );
});

test('the configuration of Gladys cannot be read: the last one, or a status and a timer', async () => {
  const { gladys, invoxia, timers, app } = await setup();
  gladys.getConfig = async () => {
    throw new Error('HTTP 500');
  };
  const before = invoxia.listRequests().length;
  await reconnect(gladys, app);
  assert.equal(invoxia.listRequests().length, before + 1, 'the last configuration received');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  gladys.config = {};
  await reconnect(gladys, app);
  assert.match(gladys.fake.connectionStatus.message.en, /did not give the configuration/);
  assert.deepEqual(timers.delays(), [60_000]);
});
