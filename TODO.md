# TODO — Invoxia v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm audit --omit=dev`,
  `npx github:GladysAssistant/integration-store .`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only. No forum topic of its own (Louis's rule: one message per wave in
  /t/10385). Lot 7, wave 1 (reserved in post 262 of the thread).

## Status

- [x] **Milestone 1 — MVP** (2026-10-18): gps-tracker 0.9.2 ported to
      JavaScript (two GETs, HTTP Basic); one device per tracker (latitude,
      longitude, accuracy, battery, moving when given, last seen, silent),
      read only; positions without history by default; trigger
      `device_silent` (threshold chosen in the scene, once per silence, not
      at the first reading); refusal ladder 1 h / 6 h / 24 h persisted; 429
      / 5xx pause bounded and persisted; status and Discovery sent again at
      every `connected`; never a smaller device; 250 states/min budget; no
      position, name, id or credential in logs or `/data`; docs en/fr.
      Tested with unit tests against the SDK's fake Gladys, a fake Invoxia
      API (shapes of gps-tracker's fixtures) and loopback http servers.
      **Never tested with a real tracker nor account.** No Docker on this
      PC: no e2e test in a container.
- [ ] **Milestone 2 — real account** (a tester with an Invoxia tracker):
      record real answers as fixtures (ids, names, positions removed), fix
      what differs. To check first:
  - the order of `tracker_data` (newest first, as gps-tracker's paging
    assumes? the code takes the newest of the page anyway) and whether
    `last_location` / `last_loc_latitude` are in the status of every
    model (only `tracker_04` in gps-tracker's fixtures);
  - the meaning of `stationary` (read as 0 = moving, > 0 = still, < 0 =
    unknown: a guess from gps-tracker's fixtures, which do not say);
  - the unit of `precision` (meters assumed: "to be confirmed" in
    gps-tracker too);
  - how the API answers a wrong password (401 `{"detail": ...}` as in
    gps-tracker's fixture?) and whether it locks an account after a few
    refusals; whether it answers 429 at all, and with Retry-After;
  - a tracker whose subscription ended: 403 on `tracker_data`? (skipped
    alone today);
  - the date of the last event when the tracker sleeps (does
    `last_event` move on heartbeats?), to tune the silence thresholds.
- [ ] **Milestone 3 — the position of a Gladys user** (needs a change of the
      Gladys core): requested in
      https://github.com/GladysAssistant/Gladys/issues/3224 (the same need
      as gladys-phonetrack). Then: an option per tracker "Gladys user to
      move" (a `users` source), off by default.
- [ ] **Later, if users ask** (not now): the tracker mode as text, the
      "lost" state, several accounts, a "zone only" privacy option.
- [ ] **Milestone 4 — first release**: Docker image build check, Release
      workflow, topic, GHCR package public (the main session publishes),
      then the store validator once the image is published.

## Decisions

- **Duplicate check**: done by the main session before the brief (lot 7,
  post 262); not repeated here.
- **Reuse**: gps-tracker 0.9.2 (MIT, Python) cannot run in this Node image:
  its client is ported to JavaScript (`src/invoxia/`), the MIT notice in
  `THIRD_PARTY_NOTICES.md`, copied into the image. Structure and protections
  from LM1LC3N7/gladys-phonetrack (same author, Apache-2.0). The standard
  Apache-2.0 `LICENSE` (no personal name).
- **Version**: 0.1.0 set by hand in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag
  (`ghcr.io/lm1lc3n7/gladys-invoxia:0.1.0`); the first patch release gives
  0.1.1.
- **Endpoints** (gps-tracker's `url_provider.py`): `GET
https://labs.invoxia.io/devices/?type=tracker` (the trackers with their
  status: battery, last event, motion, sometimes the last position) and
  `GET /devices/<id>/tracker_data/` (one page, up to 20 locations: the
  newest is taken whatever the order). `users/` is not read (nothing
  needed from it). No other route, no command.
- **Gentle polling** (gps-tracker's README asks to keep the rate to the bare
  minimum; Invoxia does not open the API to consumers): 5 min by default
  and at least, up to 1 h. The location of a tracker is read again only
  when its `last_location` (else its `last_event`) changed; a tracker
  without either is read at every round. A newer position in the status
  wins over the location read (its accuracy is then not published: no
  invented value).
- **Credentials**: `username` (string, the e-mail address of the account)
  and `password` (`secret`: kept in clear in the Gladys database, masked in
  the UI, never shown again: never written "encrypted"). Basic header built
  once in the client; the e-mail address is trimmed, the password keeps its
  spaces but loses a pasted line end; a ':' in the address or a control
  character refused before any request.
- **User position: not possible** (as for PhoneTrack: no host API endpoint
  for it): issue https://github.com/GladysAssistant/Gladys/issues/3224 on
  the core; nothing worked around; the docs say the Gladys map and zones do
  not react to the trackers yet.
- **External ids**: `device:<16 hex of SHA-256("gladys-invoxia:tracker:<id>")>`
  (the Invoxia id is stable and unique; the id itself and the serial never
  appear in Gladys). Feature keys: `latitude`, `longitude`, `accuracy`,
  `battery`, `moving`, `last_seen`, `silent`. A tracker without a name gets
  `Invoxia <4 hex of its key>`.
- **Feature types** (core constants; units only those of
  `DEVICE_FEATURE_UNITS_BY_CATEGORY`): latitude / longitude
  `unknown`/`unknown` without unit (no coordinates category), ±90 / ±180;
  accuracy `distance-sensor`/`decimal` `m`; battery `battery`/`integer`
  `percent`; moving `unknown`/`binary` (never `motion-sensor`: the core
  and the scenes take those as presence in the house; never a switch);
  last seen `text`/`text` (`YYYY-MM-DD HH:MM UTC`); silent
  `unknown`/`binary`. All read only. History: battery and silent kept;
  latitude, longitude, accuracy, moving not by default (privacy).
- **Moving only when given**: the feature is in the Discovery blueprint once
  a reading gave `stationary` >= 0 for that tracker (memory) or when the
  created device has it; a state only for a feature the created device has.
- **Silent**: from the newest of `last_event`, `last_location` and the date
  of the last location read, against the clock of Gladys; thresholds 1 h to
  48 h (trackers sleep for hours to save their battery), 24 h by default for
  the feature. Same trigger rules as gladys-phonetrack (approved there):
  created trackers only, re-armed when the age falls under 1 h, marked once
  the event left, 30 per reading, no event at the first reading, for a new
  tracker, for a date more than 5 min in the future, nor after a clock
  jump; memory in RAM only, kept across a reconnection to Gladys for the
  same account.
- **Refusals**: HTTP 401 on any request, or 403 with the API's own
  `{"detail": ...}` on the list of trackers (the account may not read its
  trackers). A 403 page that is not the API's (firewall, CDN) is not a
  refusal: retried with the back-off, never faster than the interval. A 403
  of the API on the locations of one tracker only skips that position.
  Ladder 1 h, 6 h, then 24 h, persisted as JSON `{ k: HMAC of the
credentials, s: step, u: end, p: pending, f: forced }` under a salted
  digest of the e-mail address; same rules as gladys-phonetrack (context
  captured with the request, written as soon as the answer arrives whatever
  the generation, pending attempt counted, one forced attempt per series
  when the configuration is saved, read-back end capped by its step, any
  other failure within a series waits for the end of the step).
- **Pauses**: HTTP 429 pauses every path for its Retry-After, bounded
  max(1 min, poll interval) to 6 h; 5xx for the back-off delay (or a longer
  Retry-After, up to 6 h). Persisted, capped when read back, removed after
  a reading that works. Saving the configuration does not lift a pause.
  Other failures retry from max(1 min, poll interval), doubling up to 1 h.
- **Secondary endpoint** (`tracker_data`): never blocks the status of the
  trackers. A 401, 429 or 5xx there stops the location reads of the round,
  the states are published, then the refusal or the pause takes the usual
  path; a transport failure (timeout, network) stops the location reads of
  the round, still connected; any other failure (403, 404, unexpected
  answer) skips that tracker's position only. Locations are kept in memory
  only, never in `/data`.
- **Timeout 30 s per request, test button 60 s** (budget 55 s).
- **Caps**: 20 trackers (created ones first, then by id), answers of 1 MB at
  most, 250 states/min by priority (silent, position, battery, other
  numbers, last seen), badges in calls of 100. One reading at a time.
- **Dates**: RFC 3339 with or without microseconds, without an offset read
  as UTC (as gps-tracker), outside 2000-2100 or impossible: no date. Every
  date shown is UTC; `test/timezone.test.js` runs `test/app.test.js` again
  with TZ=Europe/Lisbon and TZ=Europe/Helsinki.
- **Privacy**: no position, tracker name or id, e-mail address or password
  in a log, an error message or `/data`; no URL logged; the serial number,
  the subscription and the network operator are never read into Gladys.
  Positions rounded to 6 decimals; 0/0 is no position.
- **Transport badge**: `cloud` when Invoxia answers and the tracker is in the
  reading, `unreachable` otherwise. `transports: ["cloud"]`.
- `gladys_version >=5.1.0` (scene triggers). Categories `services`,
  `security` (anti-theft). No `location: true`: the houses of Gladys are
  never read.
