// -----------------------------------------------------------------------------
// Keys, limits and timings. The manifest keys, the trigger keys and the
// external id shapes are stored in user scenes and devices: never rename them
// (test/manifest.test.js ties them to the manifest).
// -----------------------------------------------------------------------------

export const ACTIONS = Object.freeze({
  TEST: 'test_connection',
});

export const SCENE_TRIGGERS = Object.freeze({
  DEVICE_SILENT: 'device_silent',
});

/**
 * Device external ids: `ext:<selector>:device:<tracker key>`, the tracker key
 * a hexadecimal digest of the Invoxia id of the tracker (src/devices.js).
 */
export const DEVICE_TYPE = 'device';

export const FEATURES = Object.freeze({
  LATITUDE: 'latitude',
  LONGITUDE: 'longitude',
  ACCURACY: 'accuracy',
  BATTERY: 'battery',
  MOVING: 'moving',
  LAST_SEEN: 'last_seen',
  SILENT: 'silent',
});

/**
 * Seconds between two readings. The author of gps-tracker asks to keep the
 * rate of requests to the bare minimum: 5 minutes at least.
 */
export const POLL_INTERVALS = Object.freeze(['300', '600', '900', '1800', '3600']);

/**
 * Minutes without any news from a tracker after which it is silent: the
 * choices of the configuration (the "Silent" feature) and of the trigger.
 * Invoxia trackers save their battery: hours without news are normal.
 */
export const SILENT_MINUTES = Object.freeze(['60', '120', '240', '480', '720', '1440', '2880']);

/** Caps: what is read, published and fired. */
export const LIMITS = Object.freeze({
  /** Trackers followed on the account (the rest is counted in the status). */
  DEVICES: 20,
  /** Scene events sent in one reading. */
  EVENTS_PER_ROUND: 30,
  /** POST /state admits 300 states per minute per integration: stay under 250. */
  STATES_PER_MINUTE: 250,
  /** A tracker name published to Gladys is cut to this length. */
  NAME_LENGTH: 100,
});

export const TIMEOUTS = Object.freeze({
  /** One request. */
  API: 30_000,
});

export const INTERVALS = Object.freeze({
  /** A failure (network, unexpected answer) is retried after max(this, the poll interval), doubling. */
  RETRY_MIN_MS: 60_000,
  RETRY_MAX_MS: 60 * 60_000,
  /** HTTP 429 or 5xx: pause of every request, within these bounds (Retry-After if given). */
  BUSY_MIN_MS: 60_000,
  BUSY_MAX_MS: 6 * 3600_000,
  /**
   * The credentials refused (HTTP 401, or 403 from the API itself): a stop
   * of 1 h, then 6 h, then 24 h for every refusal after (never a loop: a
   * wrong password tried again and again may lock the account).
   */
  REFUSAL_STEPS_MS: Object.freeze([3600_000, 6 * 3600_000, 24 * 3600_000]),
});

/** Size cap of an answer read from Invoxia. */
export const MAX_BYTES = 1024 * 1024;

/** The persistent store (refusals, pauses: see src/store.js). */
export const STORE_FILE = 'invoxia.json';

/** The API of the Invoxia app (the default of gps-tracker). */
export const API_URL = 'https://labs.invoxia.io';
