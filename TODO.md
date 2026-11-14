# TODO

## Status

Milestone 1: the zones (temperature, setpoint, mode) and the away mode of the
hub, local WebSocket API with a token, pinned certificate. Never tested with a
real hub.

## Decisions

- **Version 0.1.0** set by hand once (package.json, lock, manifest,
  `docker_image`); the Release workflow owns it from now on.
- **Reference**: the official "neoHub API" PDF of IMI Heatmiser (Rev 3.01, on
  dev.heatmiser.com, read on 2026-11-14). The MIT client hypercat-net/
  heatmiser-neohub (2.0.0) was read as an example only (single-quoted
  `COMMAND`). No code copied.
- **WebSocket 4243 only**: the legacy TCP API on 4242 is closed by default from
  firmware 2153 and has no token: not used.
- **Certificate**: the PDF says to skip the check of the self-made certificate
  of the hub. It is pinned instead (typed fingerprint, or learnt on the first
  click of "Test the connection": said "learnt, not verified" with the
  fingerprint, the guide tells how to compare it with openssl; decision of the
  coordinator, r1 m-1); a changed certificate is never learnt again by itself:
  the user types the new fingerprint shown in the status.
- **Token refused**: the exact words of the hub are not documented; an error
  naming the token with a refusal word, or a connection closed right after
  the first command twice in a row, is a refusal. Kept in /data as an 8-bit
  salted tag; a new token is always tried; the button tries again.
- **Protective commands**: standby (FROST_ON) and away (AWAY_ON), never behind
  an option. Sensitive: SET_TEMP, FROST_OFF (Schedule), AWAY_OFF (Home), behind
  `allow_heating`. A setpoint is refused while the zone is not on its schedule
  (standby, away, holiday): whether SET_TEMP leaves the standby is not
  documented. 10-minute stop guard after a standby or an away, lifted only by
  Schedule / Home.
- **Token after a restart**: a standby kept in /data cannot leave before the
  configuration of Gladys is read (the token is never in /data); it leaves
  right after, before the first read.
- **Identity**: external ids `<hub MAC>-<DEVICE_ID>`; every command addresses
  zones by their device number (PDF p. 8: "the device zone name or device
  number"), never by name; a sensitive command also checks the name against
  the previous read. To confirm on a real hub: a list of numbers accepted by
  FROST_ON / SET_TEMP.
- **Stops** (r3 B-3): done as soon as a read shows them; one the hub answered
  is "not yet visible" until a read sent 90 s after the answer (live data
  refreshed about every 90 s, PDF p. 13), then contradicted if still not shown:
  resent by number and by name (3 times at most, never with a refused token),
  told in the status and the badge; a change made in the app in that window
  may be overwritten. "Names only" for a hub only on proof (numbers refused
  then a name taken; never when both forms left together), kept in /data; a
  zone whose name cannot be sent always goes by number. Setpoints, Schedule
  and Home are judged the same way (not shown yet before a read 90 s after,
  follow-up at 95 s).
- **Open (r4 m-26, kept as is)**: a Schedule (or Home) the hub answers with an
  error still lifts the stop guard (its number is set when it leaves), so a
  standby not yet applied is not sent again; this follows the latest choice of
  the user.
- **Acks** by ~3.4 s (send by 2.8 s, the turn in the queue and in the lane
  bounded); a stop not sent by its ack stays in the lane and leaves as soon as
  the hub is free.
- **Scenes**: the standbys waiting for the lane leave in one FROST_ON; equal
  setpoints (or Schedules) of several zones in one command, after one shared
  fresh read; different setpoints one after the other, each within its 2.8 s,
  the others refused unsent (not done: several different setpoints in one
  message, the PDF has one COMMAND per id and the rule is one command per
  message).
- **°F hubs**: temperatures not published, setpoints refused (°C only); the
  unit becomes unknown as soon as a read shows another `TIMESTAMP_SYSTEM`.
- **Unit unknown** (GET_SYSTEM not read): temperatures wait, modes are
  published; the unit is read again when `TIMESTAMP_SYSTEM` changes.
- **Confirmation**: by a read back of GET_LIVE_DATA; a battery thermostat that
  sleeps is simulated by the hub (PDF), so the read back is the hub's view.
- **No `keywords`** in the manifest; `countries: ["GB"]` with
  `gladys_version >= 5.3.0` (decision of 2026-11-12).

## Next

- Test with a real hub (token refusal words, SET_TEMP in standby, 0.5 °C steps
  on old neoStats).
- Holiday (HOLIDAY / CANCEL_HOLIDAY), hold, time clocks and plugs, floor
  temperature, battery.
- Discovery of the hub by UDP `hubseek` (port 19790) if the network of the
  container allows it.
