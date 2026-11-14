# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for
human contributors. Read **[TODO.md](./TODO.md) first**: status, decisions
already taken and the next milestones.

## What this is

A Gladys Assistant **external integration** of type `device`: a Node.js
service (Node 22+, ESM, no build step) in its own sandboxed Docker container,
talking to Gladys through `@gladysassistant/integration-sdk` (v0.16) and to a
Heatmiser neoHub through its local WebSocket API (port 4243, `ws`), with an API
token of the hub, over a pinned TLS certificate. One Gladys device per
thermostat zone, plus the hub (away mode). Never tested with a real hub, not
affiliated with Heatmiser.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run audit                             # npm audit --omit=dev
npm run cover                             # cover.png (800x534), plain Node
node scripts/mutants.mjs                  # mutation check of the guards (slow)
```

## Architecture

```
index.js                     SDK bootstrap only
src/handlers.js              every SDK handler -> the app (shared with the tests)
src/app.js                   NeoHubApp: pace, failures, pause, refused token, pin,
                             devices, states, badges, status, the button, the commands
                             (protective: standby, away; sensitive: setpoint, schedule, home)
src/neohub/client.js         one WebSocket, one command at a time, protective first, cut of a stuck read
src/neohub/tls.js            the pinned TLS socket, the fingerprint read on a bare handshake
src/neohub/protocol.js       the envelopes and the single-quoted commands of the PDF
src/neohub/model.js          answers -> checked values (never PIN_NUMBER)
src/neohub/errors.js         NeoHubError (kind, sent)
src/devices.js               -> the Gladys devices and their states (pure)
src/store.js                 /data/heatmiser-neohub-state.json
src/publisher.js             states within 300/min
src/config.js                config_schema normalized; token tag
src/constants.js             the API, feature roles, limits, timings
src/i18n.js                  runtime texts, names, refusals (en/fr)
test/helpers/fakeHub.js      the fake client and hub of the app tests
test/helpers/wssHub.js       a real local WSS hub (client and real-clock tests)
scripts/mutants.mjs          mutants of scripts/mutants.json, one copy each
```

## Rules

- **External ids are forever.** `ext:<selector>:neohub:<hub MAC>-<DEVICE_ID>`
  and `…-hub`, the feature roles of `src/constants.js` `FEATURES` and the
  select values (`schedule`, `standby`, `home`, `away`): never rename them.
- **Safety of the commands.** Standby and away are never behind an option,
  a pause, a refused token, the queue or a read in progress. Setpoint,
  schedule and home are off by default (`allow_heating`), decided on a fresh
  read (hub and zone name checked), bounded (5 °C to the ceiling), re-checked
  in `beforeSend`, sent by 3.5 s or refused unsent; a command that may have
  left is never "not sent". No switch, no writable binary. Only the commands of
  `API.commands` can ever be encoded.
- **Secrets.** The token goes only into the request frames, on a pinned
  connection; never in logs, status, errors, /data. The address of the hub
  and the PIN of a thermostat are never logged nor stored.
- **Pace.** Never two reads within the interval, whatever asks; the clock is
  read once per decision; durations on the monotonic clock, /data on the wall
  clock; every app test uses a clock that moves at each read, and
  `test/realclock.test.js` proves the reads on a real clock.
- **The container rootfs is read-only.** Write only under `/data`.
- **Versions belong to the Release workflow.** Never edit `version` nor the
  `docker_image` tag by hand. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`.
- **User-facing text** is bilingual (English and French), kept in sync with
  the code; list the refusals exactly, without absolute claims. A secret field is
  described as kept by Gladys in its database, never with a word of cipher.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network (local servers only).
