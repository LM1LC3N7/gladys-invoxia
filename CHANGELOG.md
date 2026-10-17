# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

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
  credentials (HTTP 401) stop for 1 h, then 6 h, then 24 h, kept in
  `/data`; HTTP 429 and 5xx pause every request, bounded and kept in `/data`.
- Button "Test the connection".
