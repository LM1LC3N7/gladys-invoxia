# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-10-18

### Added

- First version, never tested with a real Invoxia tracker nor account: the
  Invoxia GPS trackers of one account, read through the cloud of Invoxia
  (the API of the Invoxia app, as gps-tracker uses it). Read only.
- One Gladys device per tracker: latitude, longitude, accuracy, battery,
  moving (when the tracker gives it), last seen and silent (read only).
  Positions keep no history by default.
- Scene trigger "Tracker silent" (1 hour to 48 hours, chosen in the scene):
  once per silence, never for a delay already reached at start.
- Refresh every 5 minutes to every hour (5 minutes by default); the location
  of a tracker is read again only when its status moved on. "Silent after"
  delay of 1 hour to 48 hours (24 hours by default).
- The password kept by Gladys and never shown again, never logged; refused
  credentials (HTTP 401 or 403 of the API on the list) stop for 1 h, then
  6 h, then 24 h, kept in `/data`; HTTP 429 and 5xx pause every request,
  bounded and kept in `/data`.
- Button "Test the connection".

### Changed (review before the first release)

- The position of one tracker that fails (5xx, timeout) no longer stops
  the integration: only that tracker waits (2 to 16 readings, or until its
  status changes); a pause only when the list fails, on a 429, or when
  several trackers fail in the same reading. A single 401 on a position
  only skips that tracker; a 403, 404 or unreadable position is kept until
  the status changes.
- A 429 or 5xx answered on a position during a reconnection of Gladys is
  kept in `/data`; a restart waits for the retry of a failed reading too.
- A date more than a day in the future is ignored; newer news arms again
  the "silent" thresholds above its age.
- Saving the configuration uses its one attempt only when the request
  leaves, never during a pause; `/data` keeps a 4-character digest of the
  credentials instead of a full one.
- A tracker already in its own back-off never fails the whole reading; a
  location dated in the far future no longer hides the real position of
  the page; a failed reading answered during a reconnection keeps its
  retry wait in `/data`.
- Docs: what Gladys keeps of the positions, the external id a non-secret
  digest, the terms of use as stated by the author of gps-tracker.

[Unreleased]: https://github.com/LM1LC3N7/gladys-invoxia/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-invoxia/releases/tag/v0.1.1
