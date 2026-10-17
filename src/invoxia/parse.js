// -----------------------------------------------------------------------------
// The answers of the Invoxia API -> plain objects. The shapes come from
// gps-tracker 0.9.2 (MIT, src/gps_tracker/client/datatypes.py and the
// fixtures of its tests), ported to JavaScript; never checked against a real
// account (TODO.md).
//
//   GET /devices/?type=tracker  [{ id, name, type: 'tracker_01' | ..., serial,
//     tracker_status: { battery, last_event, last_location,
//       last_loc_latitude, last_loc_longitude, stationary, state, ... },
//     tracker_config: { usage, ... } }]
//   GET /devices/<id>/tracker_data/  [{ datetime, lat, lng, precision,
//     method, pkt_drop, uuid }] (strings or numbers, up to 20 per page)
//
// Dates are RFC 3339, with or without microseconds, sometimes without an
// offset (UTC then, as gps-tracker reads them). The serial number, the
// subscription and the network operator are never kept.
// -----------------------------------------------------------------------------

const number = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const within = (value, min, max) => {
  const n = number(value);
  return n !== null && n >= min && n <= max ? n : null;
};
const round = (value, digits) => {
  if (value === null) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

const DATE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?$/i;
/** From 2000 to 2100: anything else is no date. */
const MIN_MS = Date.UTC(2000, 0, 1);
const MAX_MS = Date.UTC(2100, 0, 1);

/** An RFC 3339 date of the API -> ms since 1970 (UTC without an offset), or null. */
export function parseDate(value) {
  if (typeof value !== 'string') return null;
  const m = DATE.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, fraction = '', zone = 'Z'] = m;
  const ms = Number(fraction.padEnd(3, '0').slice(0, 3));
  let at = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, ms);
  // Date.UTC rolls an impossible date over (Feb 30): refuse it.
  const check = new Date(at);
  if (
    check.getUTCDate() !== +d ||
    check.getUTCMonth() !== +mo - 1 ||
    +h > 23 ||
    +mi > 59 ||
    +s > 59
  ) {
    return null;
  }
  if (zone.toUpperCase() !== 'Z') {
    const sign = zone[0] === '-' ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    at -= sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60_000;
  }
  return at >= MIN_MS && at <= MAX_MS ? at : null;
}

/** A position needs both coordinates, rounded to 6 decimals (a lone one is never kept). */
function position(rawLat, rawLon) {
  const lat = within(rawLat, -90, 90);
  const lon = within(rawLon, -180, 180);
  if (lat === null || lon === null) return { lat: null, lon: null };
  // 0, 0 is the "no fix" of many trackers, never a real place here.
  if (lat === 0 && lon === 0) return { lat: null, lon: null };
  return { lat: round(lat, 6), lon: round(lon, 6) };
}

/** One tracker of the list, or null when it is not a usable tracker. */
export function parseTracker(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const id = number(entry.id);
  if (id === null || !Number.isSafeInteger(id) || id <= 0) return null;
  if (typeof entry.type === 'string' && !entry.type.startsWith('tracker')) return null;
  const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : null;
  const status =
    entry.tracker_status && typeof entry.tracker_status === 'object' ? entry.tracker_status : {};
  const stationary = number(status.stationary);
  const battery = within(status.battery, 0, 100);
  const { lat, lon } = position(status.last_loc_latitude, status.last_loc_longitude);
  return {
    id: String(id),
    name,
    battery: battery === null ? null : Math.round(battery),
    lastEventMs: parseDate(status.last_event),
    lastLocationMs: parseDate(status.last_location),
    statusLat: lat,
    statusLon: lon,
    // gps-tracker reads `stationary` as an integer without saying what it
    // means; seen: 12, 0 and -1. Read here as 0 = moving, > 0 = still,
    // < 0 = unknown (to confirm on a real tracker: TODO.md).
    moving: stationary === null || stationary < 0 ? null : stationary === 0 ? 1 : 0,
  };
}

/**
 * The trackers of the account (sorted by id), or null when the answer is not
 * a list. One unreadable tracker never blocks the others.
 */
export function parseTrackers(value) {
  if (!Array.isArray(value)) return null;
  const trackers = [];
  const seen = new Set();
  for (const entry of value) {
    try {
      const tracker = parseTracker(entry);
      if (tracker && !seen.has(tracker.id)) {
        seen.add(tracker.id);
        trackers.push(tracker);
      }
    } catch {
      // skipped
    }
  }
  trackers.sort((a, b) => Number(a.id) - Number(b.id));
  return trackers;
}

/**
 * The newest location of a page of `tracker_data` (whatever its order), or
 * null when it holds none: { lat, lon, accuracy, timestampMs }. Undefined
 * when the answer is not a list.
 */
export function parseLocations(value) {
  if (!Array.isArray(value)) return undefined;
  let best = null;
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const timestampMs = parseDate(entry.datetime);
    const { lat, lon } = position(entry.lat, entry.lng);
    if (timestampMs === null || lat === null) continue;
    if (best && best.timestampMs >= timestampMs) continue;
    const precision = within(entry.precision, 0, 1_000_000);
    best = { lat, lon, accuracy: round(precision, 1), timestampMs };
  }
  return best;
}

/** `YYYY-MM-DD HH:MM UTC`, or null. */
export function formatDate(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
