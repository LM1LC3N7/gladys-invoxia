// -----------------------------------------------------------------------------
// InvoxiaApp: the integration. One Invoxia account, read through the API of
// the Invoxia app (HTTP Basic, e-mail address and password). Read only.
//
//   start(config)  (re)connects: the trackers read, Discovery published, the
//                  loop started
//   loop           every `poll_interval` s (5 min by default):
//                  GET /devices/?type=tracker -> battery, moving, last seen,
//                  silent; GET /devices/<id>/tracker_data/ only for a tracker
//                  whose last location or event changed (the API is not
//                  meant for frequent reads) -> position and accuracy; the
//                  trigger `device_silent` (once per silence and threshold,
//                  never for what was already silent at start)
//   failures       refused credentials (HTTP 401, or the API's own 403 on the
//                  list) stop for 1 h, then 6 h, then 24 h, kept in /data:
//                  never a loop, a wrong password tried again and again may
//                  lock the account; HTTP 429 and 5xx pause every request
//                  (bounded, kept in /data); anything else is retried, never
//                  faster than the poll interval, doubling up to 1 h
//
// No position, tracker name or id, e-mail address or password is ever logged
// or written to /data. The loop is one chain of timers: halt() bumps an
// epoch, and a run of an older epoch (still in flight when Invoxia failed)
// never schedules itself again.
// -----------------------------------------------------------------------------

import { createHash, createHmac } from 'node:crypto';
import { join } from 'node:path';
import { createLogger } from '@gladysassistant/integration-sdk';
import { Budget } from './budget.js';
import { normalizeConfig } from './config.js';
import {
  FEATURES,
  INTERVALS,
  LIMITS,
  SCENE_TRIGGERS,
  SILENT_MINUTES,
  STORE_FILE,
  TIMEOUTS,
} from './constants.js';
import { buildDevice, createdDevices, deviceIds, trackerKey } from './devices.js';
import { T } from './i18n.js';
import { Store } from './store.js';
import { InvoxiaClient } from './invoxia/client.js';
import { CODES, InvoxiaError, isRefused } from './invoxia/errors.js';
import { httpRequest } from './invoxia/http.js';
import { formatDate } from './invoxia/parse.js';

/** The "Test the connection" button waits 60 s: answer within 55 s. */
const TEST_BUDGET_MS = 55_000;
/** A date this far in the future (clock of Gladys late) is not a baseline. */
const FUTURE_MS = 5 * 60_000;
/** Wall clock and monotonic clock apart by more than this: the clock jumped. */
const CLOCK_JUMP_MS = 5 * 60_000;
/** The configuration could not be read from Gladys: try again after this. */
const CONFIG_RETRY_MS = 60_000;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** A tracker whose locations fail waits 2, 4, 8, then 16 rounds at most. */
const LOCATION_BACKOFF_ROUNDS = 16;
/** Entries per publishTransports call (the SDK refuses more). */
export const TRANSPORTS_PER_CALL = 100;
const THRESHOLDS = SILENT_MINUTES.map(Number);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
/** The value of a state entry, number or text, as one comparable key. */
const valueOf = (s) => (s.text !== undefined ? `t:${s.text}` : `s:${s.state}`);
const newest = (...values) => {
  const known = values.filter((v) => v !== null && v !== undefined);
  return known.length > 0 ? Math.max(...known) : null;
};
/** A failure of a location read that stops the other location reads of the round. */
const TRANSPORT = new Set([CODES.UNREACHABLE, CODES.TIMEOUT, CODES.TLS_UNTRUSTED, CODES.CLOSED]);

export class InvoxiaApp {
  /**
   * @param {object} options
   * @param {import('@gladysassistant/integration-sdk').GladysIntegration} options.gladys
   * @param {object} [options.logger]
   * @param {Function} [options.request] the HTTP transport (tests inject a fake Invoxia)
   * @param {string} [options.dataDir] the writable volume
   * @param {() => number} [options.now] the wall clock (ms)
   * @param {() => number} [options.monotonic] a clock that never jumps (ms)
   * @param {{ setTimeout: Function, clearTimeout: Function }} [options.timers]
   */
  constructor({
    gladys,
    logger = createLogger({ name: 'invoxia' }),
    request = httpRequest,
    dataDir = process.env.DATA_DIR ?? '/data',
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.request = request;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = new Store({ filePath: join(dataDir, STORE_FILE), logger });
    this.budget = new Budget({ perMinute: LIMITS.STATES_PER_MINUTE, now: monotonic });
    /** Both clocks at the last reading (a jump of the wall clock is a new baseline). */
    this.lastClock = null;
    this.rawConfig = {};
    this.config = normalizeConfig();
    this.client = null;
    this.generation = 0;
    this.epoch = 0;
    this.handles = new Set();
    this.queue = Promise.resolve();
    this.lastStatus = null;
    /** The /data key of the account: a salted digest of its e-mail address (set by run()). */
    this.baseKey = null;
    /**
     * In memory only, kept across a restart of the app for the same account
     * (a reconnection to Gladys), forgotten for another one:
     *   known      the trackers last read (Discovery during a pause)
     *   silence    key -> { since, reached }: the date of the news that
     *              opened the current silence, and the thresholds (minutes)
     *              already reached in it (fired, or reached before the
     *              tracker was first seen: never fired then)
     *   moving     the keys of the trackers whose status gave a motion
     *   locations  key -> { mark, location, tried, failedMark?, failCount?,
     *              retryRound? }: the last location read, the date of the
     *              status it was read for (read again only when that date
     *              changes), the round of the last attempt, and the back-off
     *              of a tracker whose locations fail. Never written to /data.
     */
    this.memoryKey = null;
    this.known = null;
    this.silence = new Map();
    this.moving = new Set();
    this.locations = new Map();
    /** Readings done (the back-off of a tracker counts in rounds). */
    this.round = 0;
    /** The last answer of the locations endpoint was a 401. */
    this.locations401 = false;
    /**
     * After a failed reading: { key (HMAC of the credentials), at, delay,
     * message }, so that a reconnection to Gladys does not skip the wait.
     */
    this.retryWait = null;
    /** Values last accepted by Gladys (feature -> value), to budget only changes. */
    this.published = new Map();
    /** Where the next cut of each group of states starts (they take turns). */
    this.cursors = new Map();
    /** The reading in flight: one at a time (loop, Discovery). */
    this.reading = null;
    this.reset();
  }

  reset() {
    this.online = false;
    this.blocked = false;
    this.pausedUntil = 0;
    this.refusalStep = 0;
    /** A saved configuration may make its one attempt within a stop (see run()). */
    this.forceAttempt = false;
    this.retryDelay = this.minRetry();
    /** key -> tracker, the followed trackers of the last reading. */
    this.devices = new Map();
    /** Trackers above the cap of LIMITS.DEVICES. */
    this.capped = 0;
    this.silentCount = 0;
    this.discoveredKey = null;
    this.transports = new Map();
    this.published.clear();
  }

  /** A failure is never read again faster than the poll interval. */
  minRetry() {
    return Math.max(INTERVALS.RETRY_MIN_MS, (this.config?.pollSeconds ?? 300) * 1000);
  }

  pollMs() {
    return this.config.pollSeconds * 1000;
  }

  // --- Lifecycle -------------------------------------------------------------

  /** Run `task` after every start / restart already queued. */
  enqueue(task) {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * (Re)start with a configuration. Calls are serialized. `force`: the user
   * saved the configuration: one attempt at once, even within the stop that
   * follows a refusal (a new refusal moves to the next, longer step).
   * `immediate`: read now even within the retry wait of a failure (the test
   * button); neither lifts a pause asked by Invoxia.
   */
  start(rawConfig, { force = false, immediate = false } = {}) {
    return this.enqueue(() => this.run(rawConfig, { force, immediate }));
  }

  /**
   * Which credentials a refusal or a wait is about: 4 hex of an HMAC (salt of
   * /data) of the credentials. Short on purpose: it only tells a change of
   * credentials, and is useless to check a guessed password (1 chance in
   * 65536 that other credentials look the same: they then wait the stop).
   */
  async refusalKey(config) {
    return createHmac('sha256', await this.store.salt())
      .update(JSON.stringify([config.username.toLowerCase(), config.password]))
      .digest('hex')
      .slice(0, 4);
  }

  async stop() {
    this.generation += 1;
    this.halt();
    this.dropClient();
  }

  /** Clear every timer; the runs still in flight will not schedule again. */
  halt() {
    this.epoch += 1;
    for (const handle of this.handles) this.timers.clearTimeout(handle);
    this.handles.clear();
  }

  dropClient() {
    this.client?.close();
    this.client = null;
  }

  /**
   * The refusal kept for this account: { key, step, until, pending, forced }
   * or null. `pending`: an attempt was in flight (counted as a refusal if
   * the app stopped before its answer); `forced`: the one attempt a saved
   * configuration may make in this series of refusals was used.
   */
  storedRefusal(baseKey) {
    const raw = baseKey ? this.store.get('refusals', baseKey) : null;
    if (!raw) return null;
    try {
      const value = JSON.parse(raw);
      if (typeof value?.k !== 'string' || !value.k) return null;
      return {
        key: value.k,
        step: Math.max(1, Math.floor(Number(value.s)) || 1),
        until: Number(value.u) || 0,
        pending: value.p === true,
        forced: value.f === true,
      };
    } catch {
      return null;
    }
  }

  async writeRefusal(baseKey, refusal) {
    const value = refusal
      ? JSON.stringify({
          k: refusal.key,
          s: refusal.step,
          u: refusal.until,
          p: refusal.pending === true,
          f: refusal.forced === true,
        })
      : null;
    await this.store.set('refusals', baseKey, value);
  }

  /** Wait for the reading in flight, if any, at most the time of its requests. */
  async settleReading() {
    const reading = this.reading;
    if (!reading) return;
    let handle;
    const limit = new Promise((resolve) => {
      handle = this.timers.setTimeout(resolve, TIMEOUTS.API * 2);
    });
    await Promise.race([reading.catch(() => {}), limit]);
    this.timers.clearTimeout(handle);
  }

  /** The stop after the n-th refusal in a row: 1 h, 6 h, then 24 h. */
  stepDelay(step) {
    const steps = INTERVALS.REFUSAL_STEPS_MS;
    return steps[Math.min(Math.max(1, step), steps.length) - 1];
  }

  /**
   * Start from the configuration kept by Gladys (at every connection). If it
   * cannot be read, the last one the SDK received is used; without any, the
   * status says so and a timer tries again: never without status nor timer.
   */
  async startFromGladys() {
    let config;
    try {
      config = await this.gladys.getConfig();
    } catch (err) {
      this.logger.warn(`Configuration not read from Gladys: ${err.message}`);
      const kept = this.gladys.config;
      if (kept && typeof kept === 'object' && Object.keys(kept).length > 0) {
        config = kept;
      } else {
        await this.enqueue(async () => {
          this.halt();
          await this.setStatus(false, T.status.configUnreadable);
          this.schedule(CONFIG_RETRY_MS, () => this.startFromGladys());
        });
        return;
      }
    }
    await this.start(config);
  }

  async run(rawConfig, { force = false, immediate = false } = {}) {
    this.halt();
    this.dropClient();
    const generation = ++this.generation;
    this.rawConfig = rawConfig ?? {};
    const config = normalizeConfig(rawConfig);
    this.config = config;
    this.reset();
    // The core keeps the status and Discovery in memory: a start (a
    // reconnection to Gladys included) always sends them again.
    this.lastStatus = null;
    await this.store.load();
    // A reading of this process still in flight (a reconnection or a saved
    // configuration during the attempt that follows a stop): wait for its
    // outcome, written to /data by read(), before looking at the refusal
    // kept there. `pending` then only counts for a process that really died,
    // and never two readings run at once.
    await this.settleReading();

    if (!config.username || !config.password) {
      await this.stopWith(T.status.missingCredentials);
      return;
    }
    if (config.usernameInvalid) {
      await this.stopWith(T.status.usernameInvalid);
      return;
    }
    if (config.passwordInvalid) {
      await this.stopWith(T.status.passwordInvalid);
      return;
    }
    const memoryKey = createHash('sha256').update(config.username.toLowerCase()).digest('hex');
    if (memoryKey !== this.memoryKey) {
      this.memoryKey = memoryKey;
      this.known = null;
      this.silence = new Map();
      this.moving = new Set();
      this.locations = new Map();
      this.locations401 = false;
      this.retryWait = null;
    }
    this.client = new InvoxiaClient({
      username: config.username,
      password: config.password,
      request: this.request,
    });
    // Never the e-mail address.
    this.logger.info('Reading the configured Invoxia account');

    // /data never holds the e-mail address: its entries are keyed by a salted digest.
    this.baseKey = createHmac('sha256', await this.store.salt())
      .update(`account:${config.username.toLowerCase()}`)
      .digest('hex')
      .slice(0, 32);
    // A refusal of these very credentials: wait for the end of its stop (1 h,
    // 6 h, 24 h). Saving the configuration makes one attempt per series of
    // refusals; other credentials are tried at once.
    const base = this.baseKey;
    let refusal = this.storedRefusal(base);
    const key = await this.refusalKey(config);
    if (refusal && refusal.key !== key) {
      await this.writeRefusal(base, null);
      refusal = null;
    }
    if (refusal) {
      if (refusal.pending) {
        // An attempt was in flight when the app stopped: its answer is
        // unknown, so it counts as one more refusal (never a loop).
        const step = refusal.step + 1;
        refusal = { ...refusal, step, until: this.now() + this.stepDelay(step), pending: false };
        await this.writeRefusal(base, refusal);
      }
      this.refusalStep = refusal.step;
      // The end read back is capped by the delay of its own step.
      const until = Math.min(refusal.until, this.now() + this.stepDelay(refusal.step));
      if (until < refusal.until) {
        refusal = { ...refusal, until };
        await this.writeRefusal(base, refusal);
      }
      if (this.now() < until) {
        if (force && !refusal.forced) {
          // The one forced attempt of this series: marked used by read(),
          // when its request really leaves (never during a pause).
          this.forceAttempt = true;
        } else {
          this.blocked = true;
          await this.publishKnown();
          const message =
            force && refusal.forced
              ? T.status.alreadyRetried(until - this.now())
              : T.status.stillRefused(until - this.now(), refusal.forced);
          await this.setStatus(false, message);
          this.schedule(until - this.now(), () => this.retryAfterRefusal(generation));
          return;
        }
      }
    }
    // A pause (HTTP 429 or 5xx) outlives a restart, a reconnection to Gladys
    // and a saved configuration; its end is capped (a clock jump, a file
    // written by hand) and the capped end is written back.
    const stored = Number(this.store.get('meta', this.pauseKey())) || 0;
    const pausedUntil = Math.min(stored, this.now() + INTERVALS.BUSY_MAX_MS);
    if (pausedUntil < stored) await this.store.set('meta', this.pauseKey(), String(pausedUntil));
    if (this.now() < pausedUntil) {
      this.pausedUntil = pausedUntil;
      const delay = pausedUntil - this.now();
      await this.publishKnown();
      await this.setStatus(false, T.status.paused(delay));
      this.schedule(delay, () => this.connect(generation));
      return;
    }
    // After a failed reading, a reconnection to Gladys waits for the retry
    // like the loop would (never faster than the interval); the button and
    // a saved configuration read at once.
    // The wait is also kept in /data: a restart of the container waits too.
    const waiting = this.retryWait?.key === key ? this.retryWait : this.storedRetry(key);
    if (!force && !immediate && waiting) {
      if (this.now() < waiting.at) {
        this.retryDelay = waiting.delay;
        await this.publishKnown();
        await this.setStatus(
          false,
          waiting.message ?? T.status.retryPending(waiting.at - this.now()),
        );
        this.schedule(waiting.at - this.now(), () => this.connect(generation));
        return;
      }
      this.retryDelay = waiting.delay;
    }
    await this.connect(generation);
  }

  /** The stop after a refusal is over: one attempt (a new refusal goes one step further). */
  async retryAfterRefusal(generation) {
    if (generation !== this.generation) return;
    this.blocked = false;
    await this.connect(generation);
  }

  /** Discovery from the trackers last read, and the badges (during a stop). */
  async publishKnown() {
    if (this.known) {
      for (const device of this.known.devices) this.devices.set(device.key, device);
      await this.publishDiscovered();
    }
    await this.publishTransports();
  }

  pauseKey() {
    return `pausedUntil|${this.baseKey}`;
  }

  /**
   * The retry wait after a failed reading, kept in /data as `retryAt|<account
   * digest>` = `<credential key>|<end ms>|<delay ms>`: { key, at, delay } or
   * null. Its end is capped by the longest retry delay.
   */
  storedRetry(key, baseKey = this.baseKey) {
    const raw = baseKey ? this.store.get('meta', `retryAt|${baseKey}`) : null;
    if (!raw) return null;
    const [k, at, delay] = raw.split('|');
    if (k !== key) return null;
    const end = Math.min(Number(at) || 0, this.now() + INTERVALS.RETRY_MAX_MS);
    const wait = Math.min(Math.max(Number(delay) || 0, this.minRetry()), INTERVALS.RETRY_MAX_MS);
    return { key, at: end, delay: wait };
  }

  /** Stopped before any request (configuration): status and badges. */
  async stopWith(message) {
    await this.publishTransports();
    await this.setStatus(false, message);
  }

  schedule(delay, task) {
    const handle = this.timers.setTimeout(async () => {
      this.handles.delete(handle);
      try {
        await task();
      } catch (err) {
        this.logger.error('Loop failed', err);
      }
    }, delay);
    this.handles.add(handle);
    return handle;
  }

  /** Schedule the next reading of the current epoch. */
  scheduleLoop(delay, generation) {
    const epoch = this.epoch;
    this.schedule(delay, () => this.loop(generation, epoch));
  }

  /** May a loop of this generation and epoch schedule its next run? */
  current(generation, epoch) {
    return generation === this.generation && epoch === this.epoch && !this.blocked;
  }

  /** The first reading, then the loop. Never throws. */
  async connect(generation) {
    if (!this.client || generation !== this.generation) return;
    try {
      await this.refresh({ publish: true });
      if (generation !== this.generation) return;
      this.logger.info(`Invoxia answers: ${this.devices.size} tracker(s) followed`);
    } catch (err) {
      await this.failed(err, generation);
      return;
    }
    this.scheduleLoop(this.pollMs(), generation);
  }

  async loop(generation, epoch) {
    if (!this.current(generation, epoch)) return;
    if (this.reading) {
      // A Discovery reading is in flight: it is this round's.
      await this.reading.catch(() => {});
      if (this.current(generation, epoch)) this.scheduleLoop(this.pollMs(), generation);
      return;
    }
    try {
      await this.refresh({ publish: false });
    } catch (err) {
      // What Invoxia answered is kept in /data even when this loop is no
      // longer the current one; only the rescheduling is skipped then.
      if (this.current(generation, epoch)) await this.failed(err, generation);
      else await this.persistFailure(err);
      return;
    }
    if (this.current(generation, epoch)) this.scheduleLoop(this.pollMs(), generation);
  }

  /**
   * Write what a failed reading means to /data, whatever the generation (a
   * refusal or a 429 answered while Gladys disconnected, or while a new
   * configuration started, is never lost). Uses the context captured when
   * the reading started (account key, HMAC, step). Returns the plan:
   * { kind: 'refused' | 'stepWait' | 'pause' | 'retry', step?, delay? }.
   */
  async persistFailure(err) {
    // Already written by read() when the answer arrived: never twice.
    if (err?.plan) return err.plan;
    const ctx = err?.context ?? {
      baseKey: this.baseKey,
      key: null,
      step: this.refusalStep,
      pollMs: this.pollMs(),
      retryDelay: this.retryDelay,
    };
    if (!ctx.baseKey || !this.config.username) return { kind: 'retry' };
    const key = ctx.key ?? (await this.refusalKey(this.config));
    const stored = this.storedRefusal(ctx.baseKey);
    const forced = stored?.key === key ? stored.forced : false;
    const now = this.now();
    if (isRefused(err)) {
      // 1 h, 6 h, then 24 h for every refusal after: never a loop.
      const step = ctx.step + 1;
      const delay = this.stepDelay(step);
      await this.writeRefusal(ctx.baseKey, { key, step, until: now + delay, forced });
      return { kind: 'refused', step, delay };
    }
    let pause = null;
    if (err?.status === 429) {
      // Too many requests: a bounded pause of every path.
      pause = clamp(
        err.retryAfterMs ?? INTERVALS.BUSY_MIN_MS,
        Math.max(INTERVALS.BUSY_MIN_MS, ctx.pollMs),
        INTERVALS.BUSY_MAX_MS,
      );
    } else if (err?.status >= 500) {
      const floor = ctx.retryDelay ?? this.retryDelay;
      pause = clamp(err.retryAfterMs ?? floor, floor, INTERVALS.BUSY_MAX_MS);
    }
    if (pause !== null) {
      await this.store.set('meta', `pausedUntil|${ctx.baseKey}`, String(now + pause));
    }
    if (ctx.step > 0) {
      // Within a series of refusals, no failure (a timeout...) is ever
      // retried before the end of the current step.
      const delay = Math.max(this.stepDelay(ctx.step), pause ?? 0);
      await this.writeRefusal(ctx.baseKey, {
        key,
        step: ctx.step,
        until: now + delay,
        forced,
      });
      return { kind: 'stepWait', step: ctx.step, delay };
    }
    return pause !== null ? { kind: 'pause', delay: pause } : { kind: 'retry' };
  }

  /** A reading failed: a long stop on a refusal, a pause, or a retry with a growing delay. */
  async failed(err, generation) {
    const plan = await this.persistFailure(err);
    if (generation !== this.generation) return;
    const wasOnline = this.online;
    this.online = false;
    this.halt();
    await this.publishTransports();
    if (plan.kind === 'refused' || plan.kind === 'stepWait') {
      this.refusalStep = plan.step;
      this.blocked = true;
      if (plan.kind === 'refused') {
        this.logger.warn(
          `Credentials refused by Invoxia (HTTP ${err.status}, refusal ${plan.step} in a row): next attempt in ${Math.round(plan.delay / MINUTE)} min`,
        );
      } else {
        this.logger.warn(`Invoxia fails after a refusal: ${this.describe(err)}`);
      }
      const message =
        plan.kind === 'refused'
          ? T.status.refused(err.status, plan.delay)
          : this.errorMessage(err, plan.delay);
      await this.setStatus(false, message);
      this.schedule(plan.delay, () => this.retryAfterRefusal(generation));
      return;
    }
    let delay = this.retryDelay;
    const pause = plan.kind === 'pause';
    if (pause) {
      delay = plan.delay;
      this.pausedUntil = this.now() + delay;
    }
    if (err?.status !== 429)
      this.retryDelay = Math.min(this.retryDelay * 2, INTERVALS.RETRY_MAX_MS);
    if (!(err instanceof InvoxiaError)) {
      this.logger.error(`Internal error of the integration: ${this.describe(err)}`);
    } else if (wasOnline || delay === this.minRetry() || pause) {
      this.logger.warn(`Invoxia fails: ${this.describe(err)}`);
    }
    const message = this.errorMessage(err, delay);
    this.retryWait = {
      key: await this.refusalKey(this.config),
      at: this.now() + delay,
      delay: this.retryDelay,
      message,
    };
    if (this.baseKey) {
      const { key, at, delay: next } = this.retryWait;
      await this.store.set('meta', `retryAt|${this.baseKey}`, `${key}|${at}|${next}`);
    }
    if (generation !== this.generation) return;
    await this.setStatus(false, message);
    this.schedule(delay, () => this.connect(generation));
  }

  /** A failure in a few words for the logs: never a URL (src/invoxia/http.js). */
  describe(err) {
    return `${err?.name ?? 'Error'}: ${err?.message ?? String(err)}`;
  }

  errorMessage(err, delay) {
    // A fault of the integration itself is never shown as a fault of Invoxia.
    if (!(err instanceof InvoxiaError)) return T.status.internal(delay);
    if (err.code === CODES.TOO_LARGE) return T.status.tooLarge(delay);
    if (err.code === CODES.TLS_UNTRUSTED) return T.status.tlsUntrusted(delay);
    if (err.status === 429) return T.status.busy(delay);
    if (err.status >= 500) return T.status.serverError(err.status, delay);
    if (err.status === 403) return T.status.forbidden(delay);
    if (err.code === CODES.BAD_ANSWER || err.code === CODES.HTTP) {
      return T.status.badAnswer(delay);
    }
    return T.status.unreachable(err, delay);
  }

  paused() {
    return this.now() < this.pausedUntil;
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys.setConnectionStatus(connected, message).catch((err) => {
      this.lastStatus = null;
      this.logger.warn(`Connection status not sent: ${err.message}`);
    });
  }

  // --- Reading -----------------------------------------------------------------

  /** Read the trackers and publish them. Throws when they cannot be read. */
  refresh(options) {
    const reading = this.read(options).finally(() => {
      if (this.reading === reading) this.reading = null;
    });
    this.reading = reading;
    return reading;
  }

  /** Attach the context of the reading to a failure and write its outcome to /data. */
  async fail(err, context) {
    if (err && typeof err === 'object') {
      err.context = context;
      // The outcome is in /data before anyone (a restart waiting for this
      // reading) looks at it; failed() reuses this plan.
      err.plan = await this.persistFailure(err);
    }
    return err;
  }

  async read({ publish }) {
    const client = this.client;
    if (!client) return;
    // The context of this reading, kept with its failure: what is written to
    // /data never depends on what the app became in between.
    const context = {
      baseKey: this.baseKey,
      key: await this.refusalKey(this.config),
      step: this.refusalStep,
      pollMs: this.pollMs(),
      retryDelay: this.retryDelay,
    };
    if (context.step > 0) {
      // An attempt after a refusal: if the app stops before the answer, the
      // next start counts it as a refusal.
      const stored = this.storedRefusal(context.baseKey);
      await this.writeRefusal(context.baseKey, {
        key: context.key,
        step: context.step,
        until: stored?.key === context.key ? stored.until : this.now(),
        pending: true,
        // The one forced attempt of a saved configuration is used now that
        // its request leaves.
        forced: (stored?.key === context.key && stored.forced) || this.forceAttempt,
      });
      this.forceAttempt = false;
    }
    let all;
    try {
      all = await client.trackers();
    } catch (err) {
      throw await this.fail(err, context);
    }
    // The credentials work: forget a refusal and a pause asked earlier (even
    // if the app moved on meanwhile: the answer is true for these values).
    if (this.storedRefusal(context.baseKey)?.key === context.key) {
      await this.writeRefusal(context.baseKey, null);
    }
    for (const name of ['pausedUntil', 'retryAt']) {
      if (this.store.get('meta', `${name}|${context.baseKey}`)) {
        await this.store.set('meta', `${name}|${context.baseKey}`, null);
      }
    }
    // A later failure of this reading (the locations) is no longer within a
    // series of refusals.
    context.step = 0;
    if (client !== this.client) return;
    this.refusalStep = 0;
    this.pausedUntil = 0;

    const createdKeys = new Set(createdDevices(this.gladys).map((c) => c.key));
    const withKeys = all.map((tracker) => {
      const key = trackerKey(tracker.id);
      return { ...tracker, key, name: tracker.name ?? `Invoxia ${key.slice(0, 4)}` };
    });
    // The cap keeps the trackers created in Gladys first, then the others by id.
    const followed = [
      ...withKeys.filter((d) => createdKeys.has(d.key)),
      ...withKeys.filter((d) => !createdKeys.has(d.key)),
    ]
      .slice(0, LIMITS.DEVICES)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    // The locations: one request per tracker whose status moved on (or
    // without a date to compare), the tracker tried longest ago first. A
    // failure of this secondary endpoint never blocks the status of the
    // trackers:
    //   429                    every path pauses (after the publication);
    //   5xx, timeout, network  that tracker only waits (its own back-off,
    //                          or until its status moves on); two trackers
    //                          failing in the same round fail the round
    //                          (pause for a 5xx, retry otherwise);
    //   401                    that tracker only waits, unless the previous
    //                          answer of this endpoint was a 401 too: then
    //                          the credentials are refused;
    //   403, 404, unreadable   that position is kept as it was until the
    //                          status of the tracker moves on.
    this.round += 1;
    const round = this.round;
    const tried = (tracker) => this.locations.get(tracker.key)?.tried ?? -1;
    const order = [...followed].sort((a, b) => tried(a) - tried(b));
    let secondary = null;
    let failures = 0;
    for (const tracker of order) {
      if (secondary) break;
      const mark = tracker.lastLocationMs ?? tracker.lastEventMs ?? null;
      const cached = this.locations.get(tracker.key);
      const changed = !cached || mark === null || cached.mark !== mark;
      const waiting = cached?.failedMark === mark && round < (cached?.retryRound ?? 0);
      if (!changed || waiting) continue;
      try {
        const location = await client.lastLocation(tracker.id);
        this.locations.set(tracker.key, { mark, location, tried: round });
        this.locations401 = false;
      } catch (err) {
        if (!(err instanceof InvoxiaError)) throw err;
        this.logger.debug(`A location was not read: ${this.describe(err)}`);
        const kept = cached?.location ?? null;
        const backOff = () => {
          const count = (cached?.failedMark === mark ? (cached.failCount ?? 0) : 0) + 1;
          this.locations.set(tracker.key, {
            mark: cached?.mark ?? null,
            location: kept,
            tried: round,
            failedMark: mark,
            failCount: count,
            retryRound: round + Math.min(2 ** count, LOCATION_BACKOFF_ROUNDS),
          });
        };
        if (err.status === 429) {
          secondary = err;
        } else if (err.status === 401) {
          if (this.locations401) secondary = err;
          else backOff();
          this.locations401 = true;
        } else if (err.status >= 500 || TRANSPORT.has(err.code)) {
          backOff();
          failures += 1;
          if (failures >= 2) secondary = err;
        } else {
          this.locations.set(tracker.key, { mark, location: kept, tried: round });
        }
      }
      if (client !== this.client) {
        // What the API answered is kept in /data even after a reconnection.
        if (secondary) await this.fail(secondary, context);
        return;
      }
    }

    const now = this.now();
    // A date more than a day ahead is no date (a tracker with a wrong
    // clock): dropped field by field, before the newest is taken.
    const plausible = (ms) => (ms !== null && ms !== undefined && ms <= now + DAY ? ms : null);
    for (const tracker of followed) {
      const read = this.locations.get(tracker.key)?.location ?? null;
      const location = read && plausible(read.timestampMs) !== null ? read : null;
      const lastLocationMs = plausible(tracker.lastLocationMs);
      // The newer of the location read and the one of the status.
      const fromStatus =
        tracker.statusLat !== null &&
        lastLocationMs !== null &&
        (!location || lastLocationMs > location.timestampMs);
      tracker.lat = fromStatus ? tracker.statusLat : (location?.lat ?? null);
      tracker.lon = fromStatus ? tracker.statusLon : (location?.lon ?? null);
      tracker.accuracy = fromStatus ? null : (location?.accuracy ?? null);
      tracker.timestampMs = newest(
        plausible(tracker.lastEventMs),
        lastLocationMs,
        location?.timestampMs,
      );
      if (tracker.moving !== null) this.moving.add(tracker.key);
      tracker.hasMoving = this.moving.has(tracker.key);
    }

    // A jump of the wall clock between two readings (NTP after a start with
    // a wrong clock): this reading is a new baseline, no event.
    const mono = this.monotonic();
    const jumped =
      this.lastClock !== null &&
      Math.abs(now - this.lastClock.wall - (mono - this.lastClock.mono)) > CLOCK_JUMP_MS;
    if (jumped) this.logger.info('The clock jumped: no silence event at this reading');
    this.lastClock = { wall: now, mono };
    const silentMs = this.config.silentMinutes * MINUTE;
    /** [tracker, minutes, reached]: thresholds to fire (marked reached once sent). */
    const candidates = [];
    let silentCount = 0;
    for (const tracker of followed) {
      try {
        const age = tracker.timestampMs === null ? null : Math.max(0, now - tracker.timestampMs);
        tracker.age = age;
        tracker.silent = age === null ? null : age >= silentMs;
        if (tracker.silent) silentCount += 1;
        if (age === null) continue;
        // A date far in the future (the clock of Gladys late at start): no
        // baseline from it.
        if (tracker.timestampMs - now > FUTURE_MS) continue;
        // A tracker seen for the first time: what is already reached is
        // never fired (no event at the first reading, nor for a new tracker).
        const state = this.silence.get(tracker.key);
        const first = jumped || !state;
        const entry = state ?? { since: tracker.timestampMs, reached: new Set() };
        if (state && tracker.timestampMs > state.since) {
          // Newer news, even old ones: the thresholds above the new age are
          // armed again (a late batch of the same news never is).
          for (const minutes of [...entry.reached]) {
            if (minutes * MINUTE > age) entry.reached.delete(minutes);
          }
          entry.since = tracker.timestampMs;
        }
        this.silence.set(tracker.key, entry);
        const reached = entry.reached;
        if (age < THRESHOLDS[0] * MINUTE) {
          // Newer news: the silence is over.
          reached.clear();
          continue;
        }
        for (const minutes of THRESHOLDS) {
          if (age < minutes * MINUTE || reached.has(minutes)) continue;
          // Only the trackers created in Gladys fire; the others only record.
          if (first || !createdKeys.has(tracker.key)) reached.add(minutes);
          else candidates.push([tracker, minutes, reached]);
        }
      } catch (err) {
        this.logger.debug(`A tracker was skipped: ${this.describe(err)}`);
      }
    }
    this.devices = new Map(followed.map((tracker) => [tracker.key, tracker]));
    this.capped = all.length - followed.length;
    this.silentCount = silentCount;
    this.online = true;
    this.retryDelay = this.minRetry();
    this.retryWait = null;
    this.known = { devices: followed };

    const discoveredKey = JSON.stringify(followed.map((d) => [d.key, d.name, d.hasMoving]));
    if (publish || discoveredKey !== this.discoveredKey) await this.publishDiscovered();
    this.discoveredKey = discoveredKey;
    await this.publishStates();
    await this.publishTransports();
    // A threshold is marked reached only once its event left; beyond 30,
    // the rest waits for the next reading.
    for (const [tracker, minutes, reached] of candidates.slice(0, LIMITS.EVENTS_PER_ROUND)) {
      if (await this.fire(tracker, minutes)) reached.add(minutes);
    }
    if (candidates.length > LIMITS.EVENTS_PER_ROUND) {
      this.logger.info(
        `${candidates.length - LIMITS.EVENTS_PER_ROUND} silence event(s) left for the next reading`,
      );
    }
    // What the trackers said is published; a refusal or a pause asked by the
    // locations endpoint now takes the usual path.
    if (secondary) throw await this.fail(secondary, context);
    await this.setStatus(true, this.okMessage());
  }

  okMessage() {
    if (this.devices.size === 0) return T.status.noDevice;
    return T.status.ok({
      total: this.devices.size + this.capped,
      silent: this.silentCount,
      silentMinutes: this.config.silentMinutes,
      capped: this.capped,
    });
  }

  /** Resolves true when the event left, false otherwise (never throws). */
  async fire(tracker, minutes) {
    return this.gladys
      .publishSceneEvent(SCENE_TRIGGERS.DEVICE_SILENT, {
        device: deviceIds(this.gladys, tracker.key).device,
        minutes: String(minutes),
        device_name: tracker.name.slice(0, LIMITS.NAME_LENGTH),
        silent_for: Math.floor(tracker.age / MINUTE),
        last_seen: formatDate(tracker.timestampMs) ?? '',
      })
      .then(
        () => true,
        (err) => {
          this.logger.warn(`Scene event not sent: ${err.message}`);
          return false;
        },
      );
  }

  /** Never throws: a refusal of Gladys is not an Invoxia failure. */
  async publishDiscovered() {
    const devices = [...this.devices.values()].map((tracker) => buildDevice(this.gladys, tracker));
    await this.gladys.publishDiscoveredDevices(devices).catch((err) => {
      this.logger.warn(`Discovery not published: ${err.message}`);
    });
  }

  /** Discovery (scan button): read again when connected, else what is known. */
  async publishDiscovery() {
    if (this.reading) {
      // A reading is in flight: no second request, publish what it brings.
      await this.reading.catch(() => {});
      await this.publishDiscovered();
      return;
    }
    if (this.online && !this.paused() && this.client) {
      const generation = this.generation;
      const done = await this.refresh({ publish: true }).then(
        () => true,
        async (err) => {
          // Any failure takes the usual path (refusal, pause, retry); an
          // older generation only keeps what Invoxia answered.
          if (generation !== this.generation) {
            await this.persistFailure(err);
            return true;
          }
          await this.failed(err, generation);
          return false;
        },
      );
      if (done) return;
    }
    if (this.devices.size === 0 && this.known) {
      for (const device of this.known.devices) this.devices.set(device.key, device);
    }
    await this.publishDiscovered();
  }

  /**
   * The states of the created devices, by priority: silent, the position
   * (latitude and longitude always together), the battery, the other
   * numbers, the last seen text. Only the features of the created device get
   * a state (a feature it lacks, moving added later, waits for "Update").
   * A created device missing from the reading gets nothing.
   */
  statesOf() {
    const groups = { silent: [], position: [], battery: [], numbers: [], texts: [] };
    for (const created of this.gladys.devices ?? []) {
      const tracker = this.devices.get(this.keyOf(created));
      if (!tracker) continue;
      const ids = deviceIds(this.gladys, tracker.key);
      const has = new Set((created.features ?? []).map((f) => f?.external_id));
      const state = (key, value) =>
        value === null || value === undefined || !has.has(ids.feature(key))
          ? null
          : { device_feature_external_id: ids.feature(key), state: value };
      const bundle = (...states) => states.filter(Boolean);
      groups.silent.push(
        bundle(state(FEATURES.SILENT, tracker.silent === null ? null : +tracker.silent)),
      );
      const lat = state(FEATURES.LATITUDE, tracker.lat);
      const lon = state(FEATURES.LONGITUDE, tracker.lon);
      if (lat && lon) groups.position.push([lat, lon]);
      groups.battery.push(bundle(state(FEATURES.BATTERY, tracker.battery)));
      for (const [key, value] of [
        [FEATURES.ACCURACY, tracker.accuracy],
        [FEATURES.MOVING, tracker.moving],
      ]) {
        groups.numbers.push(bundle(state(key, value)));
      }
      const lastSeen = formatDate(tracker.timestampMs);
      if (lastSeen && has.has(ids.feature(FEATURES.LAST_SEEN))) {
        groups.texts.push([
          { device_feature_external_id: ids.feature(FEATURES.LAST_SEEN), text: lastSeen },
        ]);
      }
    }
    return groups;
  }

  keyOf(created) {
    const prefix = this.gladys.externalId('device:');
    const id = created?.external_id;
    if (typeof id !== 'string' || !id.startsWith(prefix)) return null;
    const key = id.slice(prefix.length);
    return key.includes(':') ? null : key;
  }

  /**
   * Publish what changed, every state within the minute budget (POST /state
   * admits 300 per minute; this integration stays under 250), group by group
   * in priority order. A bundle (latitude with longitude) is never split;
   * when a group is cut, its bundles take turns. What is held back goes at a
   * later reading.
   */
  async publishStates() {
    const changed = (bundle) =>
      bundle.filter((s) => this.published.get(s.device_feature_external_id) !== valueOf(s));
    let room = this.budget.remaining();
    const list = [];
    let held = 0;
    for (const [name, bundles] of Object.entries(this.statesOf())) {
      const fresh = bundles.map(changed).filter((b) => b.length > 0);
      const size = fresh.reduce((sum, b) => sum + b.length, 0);
      if (size <= room) {
        for (const b of fresh) list.push(...b);
        room -= size;
        continue;
      }
      const start = fresh.length > 0 ? (this.cursors.get(name) ?? 0) % fresh.length : 0;
      let taken = 0;
      for (let i = 0; i < fresh.length; i += 1) {
        const b = fresh[(start + i) % fresh.length];
        if (b.length > room) break;
        list.push(...b);
        room -= b.length;
        taken += 1;
      }
      this.cursors.set(name, start + taken);
      held += fresh.slice(taken).reduce((sum, b) => sum + b.length, 0);
    }
    if (held > 0) this.logger.debug(`${held} state(s) held back (state budget)`);
    if (list.length === 0) return;
    try {
      const result = await this.gladys.publishChangedStates(list);
      this.budget.record(result?.count ?? list.length);
      for (const s of list) this.published.set(s.device_feature_external_id, valueOf(s));
    } catch (err) {
      // Gladys may have counted them anyway: the budget does too.
      this.budget.record(list.length);
      this.logger.warn(`States not published: ${err.message}`);
    }
  }

  /** Forget what was published for a device (Gladys forgot it too). */
  forget(externalId) {
    if (typeof externalId !== 'string') return;
    const prefix = `${externalId}:`;
    for (const id of [...this.published.keys()]) {
      if (id === externalId || id.startsWith(prefix)) this.published.delete(id);
    }
  }

  async publishTransports() {
    const entries = createdDevices(this.gladys).map(({ key, externalId }) => ({
      external_id: externalId,
      transport: this.online && this.devices.has(key) ? 'cloud' : 'unreachable',
    }));
    const changed = entries.filter((e) => this.transports.get(e.external_id) !== e.transport);
    for (let start = 0; start < changed.length; start += TRANSPORTS_PER_CALL) {
      const batch = changed.slice(start, start + TRANSPORTS_PER_CALL);
      for (const entry of batch) this.transports.set(entry.external_id, entry.transport);
      await this.gladys.publishTransports(batch).catch((err) => {
        for (const entry of batch) this.transports.delete(entry.external_id);
        this.logger.debug(`Transports not published: ${err.message}`);
      });
    }
  }

  // --- Devices created / deleted in Gladys -----------------------------------

  /** Created or updated: the SDK forgot the values of this device, so do we. */
  async deviceCreated(device) {
    this.forget(device?.external_id);
    this.transports.delete(device?.external_id);
    if (this.online) await this.publishStates();
    await this.publishTransports();
  }

  async deviceUpdated(device) {
    await this.deviceCreated(device);
  }

  deviceDeleted(device) {
    this.forget(device?.external_id);
    this.transports.delete(device?.external_id);
  }

  /** Read only: nothing is ever sent to Invoxia. */
  async setValue() {
    throw new Error(T.errors.readOnly);
  }

  // --- Configuration button --------------------------------------------------

  /** Resolves `promise`, or rejects with `message` after `ms`. */
  within(promise, ms, message) {
    let handle;
    const limit = new Promise((_, reject) => {
      handle = this.timers.setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, limit]).finally(() => this.timers.clearTimeout(handle));
  }

  /**
   * Reconnects, then reports, within 55 s. Never shortens the stop after a
   * refusal (only saving the configuration does) nor a pause.
   */
  async testConnection() {
    await this.within(
      this.start(this.rawConfig, { immediate: true }),
      TEST_BUDGET_MS,
      T.errors.testTooLong,
    );
    if (!this.online) {
      const message = this.lastStatus ? JSON.parse(this.lastStatus)[1] : null;
      throw new Error(message?.en ?? T.errors.notConnected);
    }
    return T.test.ok({ total: this.devices.size + this.capped, silent: this.silentCount });
  }
}
