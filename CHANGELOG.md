# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- First version: the thermostat zones of a Heatmiser neoHub, read locally
  through its WebSocket API (port 4243) with an API token of the hub: the
  temperature, the setpoint and the mode (schedule or standby) of each zone,
  and the away mode of the hub.
- Standby (frost protection) of a zone and the away mode of the hub need no
  option; setpoints, the return to the schedule and leaving the away mode stay
  off until "Allow heating commands" is on, with a ceiling (24 °C by default).
- The certificate of the hub is pinned: confirmed on the first click of "Test
  the connection" or typed; the token is never sent to another certificate.
- Store: `countries: ["GB"]` (Heatmiser is a UK brand), hence
  `gladys_version >= 5.3.0`.
