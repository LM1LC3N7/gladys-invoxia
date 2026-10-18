# gladys-invoxia

[Gladys Assistant](https://gladysassistant.com) external integration for
**Invoxia GPS trackers** (bike, car, pets...): each tracker of an Invoxia
account becomes a Gladys device (latitude, longitude, accuracy, battery,
moving, last seen, silent), and a tracker that stops reporting a scene
trigger. Read only, through the cloud of Invoxia (the API of the Invoxia
app, as the gps-tracker library uses it).
**Unofficial integration, not affiliated with Invoxia. Never tested with a
real tracker nor account yet.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/app.js (InvoxiaApp)
                 ├─ src/invoxia/client.js   GET /devices/?type=tracker, /devices/<id>/tracker_data/
                 ├─ src/invoxia/http.js     the only network access (node:https, no redirect)
                 ├─ src/invoxia/parse.js    answers -> plain objects (dates, ranges)
                 ├─ src/invoxia/errors.js   error codes, what a refusal is
                 ├─ src/budget.js           states per minute
                 ├─ src/store.js            /data: refusals, pauses (digests only)
                 └─ src/devices.js          devices (pure), never fewer features
```

- **Access**: HTTP Basic with the e-mail address and password of the
  Invoxia account, on `https://labs.invoxia.io` (gps-tracker 0.9.2, ported
  to JavaScript). The credentials travel in the Authorization header only;
  no URL is ever logged (a tracker id is part of a path).
- **Reading** (every 5 min by default, never less: the API is not meant for
  frequent reads): one request for the trackers and their status (battery,
  last event, motion, sometimes the last position), plus one
  `tracker_data` request per tracker whose status moved on (the last
  location and its accuracy), the tracker tried longest ago first. 20
  trackers at most (created ones first); one unreadable tracker is skipped
  alone; a failure of a location read never blocks the status of the
  trackers: a 5xx or a timeout makes only that tracker wait (its own
  back-off of 2 to 16 rounds, or until its status changes), unless several
  trackers fail in the same round.
- **Refusals** (HTTP 401 or the API's own 403 on the list, or two 401 in a
  row on the locations): a wrong password tried again and again may lock
  the account, so the integration stops 1 h, then 6 h, then 24 h
  (persisted in `/data` with 4 hex of a salted HMAC of the credentials,
  only to see a change, with the step and the end; an attempt in flight at
  a stop counts as a refusal); saving the same credentials makes one
  attempt per series of refusals, used when its request leaves. HTTP 429
  (any request) and 5xx (the list) pause every request (Retry-After, 1 min
  to 6 h, never under the poll interval, kept in `/data`); other failures
  retry from the poll interval, doubling to 1 h (the wait kept in `/data`).
- **External ids**: `device:<non-secret digest of the Invoxia id>`. Every state within
  250 states/min: silent, then the position (latitude with longitude),
  battery, other numbers, last seen. Positions keep no history by default.
- **Trigger** `device_silent`: per tracker and threshold (1 h to 48 h,
  required in the scene), trackers created in Gladys only, once per
  silence; never for a delay already reached at start, for a new tracker,
  or at a reading after a clock jump.
- **Privacy**: no position, tracker name or id, e-mail address or password
  in the logs or `/data`.
- **User position on the Gladys map**: not possible for an external
  integration today (as for PhoneTrack); requested on the core in
  [GladysAssistant/Gladys#3224](https://github.com/GladysAssistant/Gladys/issues/3224).

## Development

```bash
npm install
npm test                                        # node --test, no network (loopback only)
npm run lint && npm run format:check
npm run audit                                   # production dependencies
npm run cover                                   # regenerate cover.png
npx github:GladysAssistant/integration-store .  # store admission checks
```

The tests run against the SDK's fake Gladys and a fake Invoxia API
(`test/helpers/fakeInvoxia.js`), plus loopback http servers for the
transport. No test touches the real Invoxia API or the Internet.

## Credits

- [gps-tracker](https://gitlab.com/ezlo.picori/gps_tracker) (MIT, 0.9.2):
  the API, its authentication and the shapes of its answers, ported to
  JavaScript (see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
- [gladys-phonetrack](https://github.com/LM1LC3N7/gladys-phonetrack): the
  structure of the app, the retry policy and the "silent" trigger.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release.

## License

Apache-2.0.
