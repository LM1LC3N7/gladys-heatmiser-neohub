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
  thermostat in standby and turns the time clocks and neoPlugs off (PDF of
  Heatmiser): it acts on everything the hub drives.
- Time clocks, plugs and the time clock half of a combined neoAir are not
  shown in this version.

## Setup

1. In the **Heatmiser Neo** app: Settings > API Access > Tokens, create a token.
2. In Gladys, open the integration: type the **IP address** of the hub (shown in
   your router; give the hub a fixed address there) and the **token**, save.
3. Click **Test the connection** once, **from your home network**: it reads the
   certificate the hub shows and **learns** its fingerprint (shown in the
   answer and in the status). It is learnt, **not verified**: the hub makes
   its own certificate, there is no authority to check it against. Someone who
   controls your local network at that very click could have his own
   certificate learnt instead and receive the token. To verify, compare the
   fingerprint shown with the one of your hub, read from a computer of your
   network: `openssl s_client -connect <hub address>:4243 </dev/null 2>/dev/null
| openssl x509 -noout -fingerprint -sha256`. You may also type the
   fingerprint yourself instead of clicking. From then on, the token goes to
   that certificate only.
4. Open the **Discovery** tab and add the zones and the hub.

The token is kept by Gladys in its database, never shown again, and sent only
to the hub at the address you typed, over the learnt certificate. It does not
appear in the logs, the status nor the files of the integration.

## Commands

**Standby** on a zone and **Away** on the hub need no option. Standby only
lowers the heating of its zone; away puts every thermostat in standby and
turns the time clocks and neoPlugs off. They are sent at once, before any
other command waiting (a read of the hub stuck for 1 s is cut for them),
addressed by the device number of the zone; the standbys of a scene leave
together in one command. A hub that refuses device numbers, or answers them
without doing anything, gets the zone by the name its last read gave (one
command per zone), at once and from then on. Gladys gets its answer within about
3.4 s; a stop that could not leave by then stays in line and leaves as soon as
the hub is free. A stop is decided by the first read of the hub sent after its
answer: if it shows it, it is done, and a change you make later in the app
wins (never sent again); if it does not, or the hub did not answer, the stop
is sent again with the next reads, 3 times at most, and the status and the
badge of the zone say so. A newer Schedule (or Home) that left
lifts the stop: it is not sent again, not even after a restart. A Schedule (or
Home) refused before leaving (option off, pause, too late) leaves the stop to
be sent. A command asked before a standby on the same zone (before an away, on
any zone) that has not left yet is cancelled. What a stop needs all the same:
the address, the token and the learnt certificate (without them nothing can be
sent to the hub); it is refused when another hub answers at the address, and
it is not sent again by itself after the hub refused the token (a click sends
it, or a new token).

These commands are **off by default** and need the option **Allow heating
commands**:

- the **setpoint** of a zone (5 °C to the ceiling, 24 °C by default, rounded
  down to 0.5 °C, by steps of 0.5 °C);
- **Schedule** on a zone (leaves the standby);
- **Home** on the hub (leaves the away mode).

Each is decided on a fresh read of the hub (a read sent after the command
arrived; the hub, the zone at its device number and its name at the previous
read checked), addressed by the device number of the zone, sent within 2.8 s
or refused unsent, then read back when no other command waits; Gladys gets its
answer within about 3.4 s. The same setpoint (or Schedule) asked of several
zones at once leaves in one command; different setpoints leave one after the
other, each within its own 2.8 s, the others refused unsent ("too late"). A
setpoint is refused:

- when the option is off, or the value is outside 5 °C to the ceiling or not a
  multiple of 0.5 °C;
- while the zone is in standby, away or on holiday, or the hub is away or on
  holiday (choose Schedule or Home first);
- for 10 minutes after a standby of the zone or an away of the hub, unless
  Schedule or Home has left since;
- when the hub is set to °F (only °C is supported), or its unit is not read
  yet (again after any change of the system of the hub);
- when the zone is offline, gone, or renamed since the previous read (try
  again); right after a restart, the name kept at the Scan and a read of the
  unit within the command are used;
- when 8 commands already wait, during a pause after failed reads, after a
  refused token, or when its turn does not come in time (nothing sent).

Schedule and Home are refused when /data cannot keep that they lift a stop
(nothing sent).

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
the learnt certificate fingerprints, the stop commands still to send, and,
for a refused token, an 8-bit tag (never the token).
