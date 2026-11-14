# Heatmiser neoHub

Brings the thermostat zones of a **Heatmiser neoHub** into Gladys, on your
local network, through the official local API of the hub (a secure WebSocket on
port 4243, authenticated by an API token of the hub). Unofficial, not
affiliated with Heatmiser. **Never tested with a real device yet**: written
from the official "neoHub API" document of IMI Heatmiser; your feedback is
welcome.

## What you get

- One device per **thermostat zone** (neoStat, neoAir): the room temperature,
  the setpoint, and the mode: **Schedule** (the zone follows its program) or
  **Standby** (frost protection: the zone holds its frost temperature).
- One device for the **hub**: the **away mode** (Home / Away). Away puts every
  zone in standby.
- Time clocks, plugs and the time clock half of a combined neoAir are not
  shown in this version.

## Setup

1. In the **Heatmiser Neo** app: Settings > API Access > Tokens, create a token.
2. In Gladys, open the integration: type the **IP address** of the hub (shown in
   your router; give the hub a fixed address there) and the **token**, save.
3. Click **Test the connection** once: it reads the certificate the hub shows
   and confirms it (the fingerprint is shown). From then on, the token goes to
   that certificate only. You may instead type the SHA-256 fingerprint yourself.
4. Open the **Discovery** tab and add the zones and the hub.

The token is kept by Gladys in its database, never shown again, and sent only
to the hub at the address you typed, over its confirmed certificate. It never
appears in the logs, the status nor the files of the integration.

## Commands

**Standby** on a zone and **Away** on the hub only lower the heating: they are
allowed whatever the options, and are sent at once, before any other
command waiting (a read of the hub that is stuck for 1 s is cut for them). If
one cannot be sent, or the hub does not show it yet, it is sent again with the
next reads of the hub, 3 times at most. A command asked before a standby on the
same zone (before an away, on any zone) that has not left yet is cancelled.
What a standby or an away needs all the same: the address, the token and the
confirmed certificate (without them nothing can be sent to the hub). A standby
is also refused when the name of the zone is not known yet or holds a quote or
a backslash, and both are refused when another hub answers at the address.

These commands are **off by default** and need the option **Allow heating
commands**:

- the **setpoint** of a zone (5 °C to the ceiling, 24 °C by default, by steps
  of 0.5 °C);
- **Schedule** on a zone (leaves the standby);
- **Home** on the hub (leaves the away mode).

Each is decided on a fresh read of the hub (the hub and the zone checked: a
zone renamed in the app is commanded again once you update the device from the
Discovery tab), sent within 3.5 s or refused unsent, then read back. A setpoint
is refused:

- when the option is off, or the value is outside 5 °C to the ceiling or not a
  multiple of 0.5 °C;
- while the zone is in standby, away or on holiday, or the hub is away or on
  holiday (choose Schedule or Home first);
- for 10 minutes after a standby of the zone or an away of the hub, unless
  Schedule or Home was chosen since;
- when the hub is set to °F (only °C is supported), or its unit is not read
  yet;
- when the zone is offline, renamed, gone, or its name holds a quote or a
  backslash;
- when 8 commands already wait, during a pause after failed reads, after a
  refused token, or when the hub is too slow (nothing sent).

A command that may have reached the hub is never told "not sent": you get
"sent, without confirmation" and the next reads show the result. No command
goes through a switch: a "turn everything off" never reaches the heating.

## Reads and pace

The hub is read every 60 s by default (30 to 600 s; the hub refreshes its own
data about every 90 s); the button, the Discovery tab or a restart never read
it sooner than the interval. A command adds its own reads: one before it, one
right after it, then 5 s and 20 s later. After a failure the integration waits 1, 2, 5, 10
then 15 minutes. A token refused by the hub stops the automatic reads until you
type a new token or click Test the connection.

If the hub is replaced or reset, its certificate changes: nothing is sent and
the status shows the new fingerprint; type it in the configuration once you
have checked it is your hub.

## Data

`/data/heatmiser-neohub-state.json` keeps the time of the last read, the pause,
the confirmed certificate fingerprints, the stop commands still to send, and,
for a refused token, an 8-bit tag (never the token).
