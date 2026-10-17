# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for Invoxia GPS trackers: a
Node.js service (Node 22+, ESM, no build step) that runs in its own sandboxed
Docker container and talks to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It reads the trackers of one Invoxia account
through the API of the Invoxia app (HTTP Basic, e-mail address and password),
as the gps-tracker library (MIT) does; that library is ported, not installed.
Read only, pull only. See `TODO.md` for the status and every decision.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "429"     # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run cover                             # regenerate cover.png (plain Node)
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only (src/handlers.js)
src/handlers.js                   every SDK handler, registered before connect()
src/app.js                        InvoxiaApp: start queue, loop, failures, states, trigger
src/invoxia/client.js             GET /devices/?type=tracker, /devices/<id>/tracker_data/
src/invoxia/http.js               the only network access (node:https, no redirect)
src/invoxia/parse.js              answers -> plain objects (no serial kept)
src/invoxia/errors.js             error codes; what a refusal is
src/devices.js                    devices (pure), external ids, never fewer features
src/config.js                     DEFAULTS (mirror the manifest) + normalization
src/store.js                      /data: refusals, pauses, salt (digests only)
src/budget.js                     sliding window of the states sent per minute
src/i18n.js                       statuses and messages (en / fr)
gladys-assistant-integration.json manifest
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, fake Gladys (SDK) + fake Invoxia
```

## Rules

- **External ids are forever**: `device:<16 hex of SHA-256 of the Invoxia
id>` and the feature keys of `src/constants.js`. Changing the digest
  recipe creates new devices and orphans the old ones. The same goes for
  every key users store: manifest `config_schema`, `actions`, the scene
  trigger key, its fields and their option values.
- **Read only**: no request other than the two GETs, no command (mode, lost
  mode, alerts). Adding one needs Louis's decision, off by default, never a
  switch.
- **Gentle on the API**: Invoxia does not open it to consumers; never poll
  faster than 5 minutes, read a location only when the status moved on.
- **Privacy**: never log a URL (a tracker id is part of some paths), never
  put the e-mail address, the password, a position, a tracker name or id in
  a log, an error message or `/data`.
- **Refusals** (401, or the API's own 403 on the list): the stop ladder
  (1 h, 6 h, 24 h) must never become a loop (a wrong password tried again
  and again may lock the account).
- **The container rootfs is read-only.** Write only under `/data`.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand (0.1.0 was set by hand once, before the first release).
  `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md`. Never write a version heading.
- **Manifest.** Texts are `{ "en": ..., "fr": ... }` objects; the catalog
  `description` holds 10 to 100 characters per language.
  `test/manifest.test.js` ties the manifest to the code.
- **Encoding.** Files are UTF-8 without BOM; `test/encoding.test.js` refuses
  mojibake in the manifest, docs, README, CHANGELOG, TODO, CLAUDE.md, the
  notices and `src/**/*.js`. Write files with an editor, never through a
  shell that guesses a code page.
- **gps-tracker is MIT**: its notice stays in `THIRD_PARTY_NOTICES.md`,
  copied into the image.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network (loopback only).
