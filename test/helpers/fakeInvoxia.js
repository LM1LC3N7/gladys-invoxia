// -----------------------------------------------------------------------------
// A fake Invoxia API (in memory): the two GETs the integration uses, behind
// HTTP Basic. The shapes come from the fixtures of gps-tracker 0.9.2 (MIT);
// never checked against a real account (TODO.md). Test data is made up.
// -----------------------------------------------------------------------------

import { CODES, InvoxiaError } from '../../src/invoxia/errors.js';

export const USERNAME = 'someone@example.org';
export const PASSWORD = 's3cr3t-Pa55';

export function tracker(id, name, status = {}, extra = {}) {
  return {
    id,
    name,
    type: 'tracker_04',
    serial: 'abcdef0123456789',
    created: '2025-05-11T16:15:40.175649Z',
    version_build: 'bee9147',
    timezone: 'Europe/Paris',
    version: 'tracker_LWT4v2-1.24.3',
    tracker_config: { mode: '1', usage: 'bike', network: 'ltem' },
    tracker_status: {
      battery: 80,
      begin_date: '2025-05-11T16:19:34.463480Z',
      last_event: '2026-10-18T07:58:00.000000Z',
      state: 'online',
      sub_end_date: '2027-10-12',
      sub_state: 'normal',
      network_operator: 'soracom',
      stationary: 12,
      ...status,
    },
    ...extra,
  };
}

export function location(options = {}) {
  return {
    uuid: 'dd4175dd-7a13-4b84-b191-bb990f63ae62',
    datetime: '2026-10-18T07:55:00.000000Z',
    lat: '48.856600',
    lng: '2.352200',
    precision: 25,
    method: 2,
    pkt_drop: 0,
    ...options,
  };
}

export function createFakeInvoxia() {
  const fake = {
    requests: [],
    trackers: [
      tracker(878858, 'Vélo', { stationary: 0 }),
      tracker(444000, 'Rex', {
        battery: 15,
        last_event: '2026-10-18T05:30:00Z',
        stationary: -1,
      }),
    ],
    /** id -> list of locations (tracker_data, newest first). */
    locations: {
      878858: [location(), location({ datetime: '2026-10-18T07:00:00Z', lat: '48.8' })],
      444000: [
        location({ datetime: '2026-10-18T05:29:00Z', lat: '45.764', lng: '4.8357', precision: 75 }),
      ],
    },
    /** { status, headers, body, path } answered once each (FIFO); `path` limits it to a prefix. */
    failures: [],
    /** path prefix -> HTTP status answered every time. */
    broken: {},
    unreachable: false,
    inFlight: 0,
    maxInFlight: 0,
    /** A promise the API waits for before answering (a slow reading). */
    gate: null,
  };

  const json = (status, value, headers = {}) => ({
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: Buffer.from(JSON.stringify(value)),
  });

  function answer(url, headers) {
    const broken = Object.entries(fake.broken).find(([path]) => url.pathname.startsWith(path));
    if (broken) return json(broken[1], { detail: 'broken' });
    const index = fake.failures.findIndex((f) => !f.path || url.pathname.startsWith(f.path));
    if (index >= 0) {
      const [f] = fake.failures.splice(index, 1);
      if (f.body !== undefined) {
        return { status: f.status, headers: f.headers ?? {}, body: Buffer.from(f.body) };
      }
      return json(f.status, { detail: 'failure' }, f.headers ?? {});
    }
    const expected = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64')}`;
    if (headers.authorization !== expected) {
      return json(401, { detail: 'Invalid username/password.' });
    }
    if (url.pathname === '/devices/' && url.search === '?type=tracker') {
      return json(200, fake.trackers);
    }
    const m = /^\/devices\/(\d+)\/tracker_data\/$/.exec(url.pathname);
    if (m) {
      if (!fake.trackers.some((t) => String(t.id) === m[1])) {
        return json(403, { detail: 'You do not have permission to perform this action.' });
      }
      return json(200, fake.locations[m[1]] ?? []);
    }
    return { status: 404, headers: {}, body: Buffer.from('<html>Not found</html>') };
  }

  /** The transport of src/invoxia/http.js, in memory. */
  fake.request = async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    const headers = Object.fromEntries(
      Object.entries(options.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    fake.requests.push({ url: rawUrl, path: url.pathname, headers, options });
    fake.inFlight += 1;
    fake.maxInFlight = Math.max(fake.maxInFlight, fake.inFlight);
    try {
      if (fake.gate) await fake.gate;
      if (fake.unreachable) throw new InvoxiaError(CODES.UNREACHABLE, 'ECONNREFUSED');
      return answer(url, headers);
    } finally {
      fake.inFlight -= 1;
    }
  };

  /** The requests to the list of trackers only. */
  fake.listRequests = () => fake.requests.filter((r) => r.path === '/devices/');
  /** The requests to the locations only. */
  fake.locationRequests = () => fake.requests.filter((r) => r.path.endsWith('/tracker_data/'));

  return fake;
}
