# gladys-heatmiser-neohub

A [Gladys Assistant](https://gladysassistant.com) external integration for
**Heatmiser neoStat / neoAir thermostats through the neoHub**, on the local
network: the official WebSocket API of the hub (port 4243) with an API token
created in the Heatmiser Neo app. Unofficial, not affiliated with Heatmiser.
Never tested with a real device yet.

- Zones: temperature, setpoint, mode (schedule or standby / frost protection).
- Hub: away mode.
- Standby and away need no option; setpoints, the return to the schedule and
  leaving the away mode are off by default (option "Allow heating commands"),
  bounded (5 °C to a ceiling, 24 °C by default).
- The certificate of the hub is pinned; the token is sent to it only.

User guide: [English](docs/en.md) · [Français](docs/fr.md).

## Development

```bash
npm install
npm test            # node --test
npm run lint
npm run format:check
```

See [CLAUDE.md](CLAUDE.md) for the architecture and the rules, and
[TODO.md](TODO.md) for the decisions and the next milestones.

## License

Apache-2.0 (see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
