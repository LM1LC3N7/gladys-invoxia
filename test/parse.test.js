// -----------------------------------------------------------------------------
// The answers of the Invoxia API, from the fixtures of gps-tracker 0.9.2
// (MIT, tests/fixtures: the shapes, with made-up values).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDate,
  parseDate,
  parseLocations,
  parseTracker,
  parseTrackers,
} from '../src/invoxia/parse.js';

// The shape of gps-tracker's 200_devices_type-tracker.json (an old tracker
// without a last location in its status) and 200_device_issue_9.json.
const OLD = {
  id: 878858,
  name: 'MyTracker',
  type: 'tracker_01',
  serial: '18b79eff372a6495',
  created: '2020-05-11T16:15:40.175649Z',
  version: 'tracker_LWTv2-9.34.0-LoRa+Sigfox',
  tracker_config: { mode: '6', icon: 19, usage: 'vehicle' },
  tracker_status: {
    battery: 58,
    begin_date: '2019-04-19T19:43:32.197349Z',
    last_event: '2021-12-24T11:42:06.012000Z',
    state: 'online',
    sub_end_date: '2023-02-28',
    sub_state: 'normal',
    network_operator: 'parrot',
    stationary: 12,
  },
};
const NEW = {
  id: 444000,
  name: 'Tracker 23104',
  type: 'tracker_04',
  caps: {},
  tracker_status: {
    battery: 99,
    last_event: '2024-01-30T00:40:57.132008Z',
    last_location: '2023-05-12T23:14:10Z',
    stationary: 0,
    boost_state: 0,
    last_loc_latitude: 34.6679674,
    last_loc_longitude: 135.4303226,
  },
};

test('a tracker: battery, dates, position of the status, motion; nothing else kept', () => {
  assert.deepEqual(parseTracker(OLD), {
    id: '878858',
    name: 'MyTracker',
    battery: 58,
    lastEventMs: Date.parse('2021-12-24T11:42:06.012Z'),
    lastLocationMs: null,
    statusLat: null,
    statusLon: null,
    moving: 0,
  });
  const tracker = parseTracker(NEW);
  assert.equal(tracker.statusLat, 34.667967);
  assert.equal(tracker.statusLon, 135.430323);
  assert.equal(tracker.lastLocationMs, Date.parse('2023-05-12T23:14:10Z'));
  assert.equal(tracker.moving, 1);
  assert.ok(!JSON.stringify(tracker).includes('18b79e'), 'no serial');
  // gps-tracker's 200_tracker_status_issue_2.json: stationary -1.
  assert.equal(parseTracker({ ...NEW, tracker_status: { stationary: -1 } }).moving, null);
  assert.equal(parseTracker({ ...NEW, tracker_status: { battery: -1 } }).battery, null);
});

test('not trackers: phones, missing ids, a lone coordinate, 0/0', () => {
  assert.equal(parseTracker({ id: 1, type: 'android', name: 'Phone' }), null);
  assert.equal(parseTracker({ name: 'No id' }), null);
  assert.equal(parseTracker({ id: 1.5 }), null);
  assert.equal(parseTracker([]), null);
  const lone = parseTracker({ id: 3, tracker_status: { last_loc_latitude: 45 } });
  assert.equal(lone.statusLat, null);
  const zero = parseTracker({
    id: 3,
    tracker_status: { last_loc_latitude: 0, last_loc_longitude: 0 },
  });
  assert.equal(zero.statusLat, null);
  assert.equal(parseTracker({ id: 3 }).name, null);
});

test('the list: not a list is null; duplicates and bad entries skipped; sorted by id', () => {
  assert.equal(parseTrackers({ detail: 'x' }), null);
  const list = parseTrackers([NEW, OLD, OLD, null, 'x', { id: 'abc' }]);
  assert.deepEqual(
    list.map((t) => t.id),
    ['444000', '878858'],
  );
});

test('locations: the newest of the page whatever its order, strings read as numbers', () => {
  // gps-tracker's 200_tracker_data_deviceid-878858.json: unsorted, one date without "Z".
  const page = [
    { datetime: '2019-11-06T22:57:45.911989Z', lat: '23.966175', lng: '-41.220703', precision: 25 },
    { datetime: '2019-11-07T14:12:13.798307', lat: '25.562265', lng: '-46.318359', precision: 75 },
    { datetime: '2019-11-05T13:54:37.516958Z', lat: '28.690587', lng: '-49.658203', precision: 75 },
  ];
  assert.deepEqual(parseLocations(page), {
    lat: 25.562265,
    lon: -46.318359,
    accuracy: 75,
    timestampMs: Date.parse('2019-11-07T14:12:13.798Z'),
  });
  assert.equal(parseLocations([]), null);
  assert.equal(parseLocations([{ datetime: 'x', lat: 1, lng: 1 }]), null);
  assert.equal(parseLocations({}), undefined);
  assert.equal(
    parseLocations([{ datetime: '2020-01-01T00:00:00Z', lat: '1', lng: '1' }]).accuracy,
    null,
  );
});

test('dates: microseconds, offsets, no offset is UTC, impossible dates refused', () => {
  assert.equal(parseDate('2021-12-24T11:42:06.012000Z'), Date.parse('2021-12-24T11:42:06.012Z'));
  assert.equal(parseDate('2023-05-12T23:14:10Z'), Date.parse('2023-05-12T23:14:10Z'));
  assert.equal(parseDate('2023-05-12T23:14:10'), Date.parse('2023-05-12T23:14:10Z'));
  assert.equal(parseDate('2023-05-12T23:14:10+02:00'), Date.parse('2023-05-12T21:14:10Z'));
  assert.equal(parseDate('2023-05-12T23:14:10-0130'), Date.parse('2023-05-13T00:44:10Z'));
  for (const bad of [
    '2023-02-30T00:00:00Z',
    '2023-05-12T24:00:00Z',
    '1970-01-01T00:00:00Z',
    'x',
    3,
    null,
  ]) {
    assert.equal(parseDate(bad), null, String(bad));
  }
  assert.equal(formatDate(Date.parse('2026-10-18T07:58:30Z')), '2026-10-18 07:58 UTC');
  assert.equal(formatDate(null), null);
});
