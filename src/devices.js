// -----------------------------------------------------------------------------
// The zones of the hub -> Gladys devices and states (pure).
//
// `ext:<selector>:neohub:<hub>-<zone>`: one Gladys device per thermostat zone,
// keyed by the hub id (its MAC address, 12 hex digits, from the `device_id`
// of every answer) and the `DEVICE_ID` of the zone; `ext:<selector>:neohub:
// <hub>-hub` is the hub itself (the away mode, which acts on every zone). The
// zone name is a parameter (`zone_name`), checked before every command: a
// zone renamed in the app is commanded again once the device is updated from
// the Discovery tab. The feature roles (the last part of the feature external
// ids) and the select values are published forever: never rename them.
//
// A device published again never loses a feature: those of the device
// already created in Gladys are kept as they are.
//
// No switch, no writable binary: a "turn everything off" must never reach
// the heating. The commands are the setpoint (`thermostat/target-temperature`),
// the mode of a zone and the away mode of the hub (`text/select`).
//
// Units are those the core lists (DEVICE_FEATURE_UNITS_BY_CATEGORY): °C on
// `temperature-sensor` and `thermostat`. A hub set to °F publishes no
// temperature (src/app.js).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import {
  AWAY,
  FEATURES as F,
  HUB_KEY,
  ID_TYPE,
  MODES,
  SETPOINT,
  TEMPERATURE_RANGE,
} from './constants.js';
import { AWAY_NAMES, FEATURE_NAMES, MODE_NAMES, hubName, zoneName, word } from './i18n.js';

const select = {
  category: C.TEXT,
  type: T.TEXT.SELECT,
  min: 0,
  max: 0,
  read_only: false,
  has_feedback: true,
  keep_history: false,
};

/** The features, by role. */
export function definitionOf(role) {
  switch (role) {
    case F.TEMPERATURE:
      return {
        category: C.TEMPERATURE_SENSOR,
        type: T.SENSOR.DECIMAL,
        unit: U.CELSIUS,
        min: TEMPERATURE_RANGE.min,
        max: TEMPERATURE_RANGE.max,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      };
    case F.TARGET:
      return {
        category: C.THERMOSTAT,
        type: T.THERMOSTAT.TARGET_TEMPERATURE,
        unit: U.CELSIUS,
        // The slider stops at the hard bounds; the ceiling refuses within them.
        min: SETPOINT.min,
        max: SETPOINT.max,
        read_only: false,
        has_feedback: true,
        keep_history: true,
      };
    case F.MODE:
    case F.AWAY:
      return { ...select };
    default:
      throw new Error(`unknown role ${role}`);
  }
}

export const ZONE_ROLES = [F.TEMPERATURE, F.TARGET, F.MODE];
export const HUB_ROLES = [F.AWAY];
export const COMMAND_ROLES = [F.TARGET, F.MODE, F.AWAY];

/** The fields of a feature Gladys stores (what is kept of a created feature). */
const DECLARED = [
  'name',
  'external_id',
  'category',
  'type',
  'unit',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
  'supported_options',
];

/** `<hub>-<zone>` or `<hub>-hub`. */
export const targetKey = (hub, zone) => `${hub}-${zone}`;

export const idsOf = (gladys, key) => gladys.externalIds(ID_TYPE, key);

const KEY = new RegExp(`:${ID_TYPE}:([0-9a-f]{12})-(\\d{1,5}|${HUB_KEY})`);

/** `{ hub, zone, key, role }` of one of our feature external ids (zone: a number, or 'hub'), else undefined. */
export function parseFeatureId(externalId) {
  if (typeof externalId !== 'string') {
    return undefined;
  }
  const match = new RegExp(`${KEY.source}:([a-z-]{1,40})$`).exec(externalId);
  if (!match) {
    return undefined;
  }
  const isHub = match[2] === HUB_KEY;
  const role = match[3];
  if (!(isHub ? HUB_ROLES : ZONE_ROLES).includes(role)) {
    return undefined;
  }
  return {
    hub: match[1],
    zone: isHub ? HUB_KEY : Number(match[2]),
    key: targetKey(match[1], match[2]),
    role,
  };
}

/** `{ hub, zone, key }` of one of our device external ids, else undefined. */
export function parseDeviceId(externalId) {
  const match = new RegExp(`${KEY.source}$`).exec(String(externalId ?? ''));
  if (!match) {
    return undefined;
  }
  return {
    hub: match[1],
    zone: match[2] === HUB_KEY ? HUB_KEY : Number(match[2]),
    key: targetKey(match[1], match[2]),
  };
}

/** The options of a select: string values, string labels (the core requires both), ordered. */
export const modeOptions = (language) =>
  [MODES.SCHEDULE, MODES.STANDBY].map((value, i) => ({
    value,
    label: word(MODE_NAMES[value], language),
    sort_order: i,
  }));
export const awayOptions = (language) =>
  [AWAY.HOME, AWAY.AWAY].map((value, i) => ({
    value,
    label: word(AWAY_NAMES[value], language),
    sort_order: i,
  }));

/**
 * The states of a zone read: `[role, state]` pairs, only for the values
 * known. `celsius`: the hub reports °C (a hub in °F, or whose unit is not
 * known, publishes no temperature). An offline zone publishes nothing.
 */
export function zoneStates(zone, { celsius }) {
  if (zone.offline !== false) {
    return [];
  }
  const states = [];
  if (celsius && zone.temperatureTenths !== undefined) {
    states.push([F.TEMPERATURE, { state: zone.temperatureTenths / 10 }]);
  }
  if (celsius && zone.targetTenths !== undefined) {
    states.push([F.TARGET, { state: zone.targetTenths / 10 }]);
  }
  if (zone.standby !== undefined) {
    states.push([F.MODE, { text: zone.standby ? MODES.STANDBY : MODES.SCHEDULE }]);
  }
  return states;
}

/** The away state of the hub; nothing during a holiday (neither home nor away) or when unknown. */
export function hubStates(live) {
  if (live.hubHoliday !== false || live.hubAway === undefined) {
    return [];
  }
  return [[F.AWAY, { text: live.hubAway ? AWAY.AWAY : AWAY.HOME }]];
}

/** The features of the created device that the new build lacks, kept as they are. */
export function keepCreatedFeatures(built, created) {
  if (!created) {
    return built;
  }
  const have = new Set(built.features.map((f) => f.external_id));
  const kept = (created.features ?? [])
    .filter((f) => typeof f?.external_id === 'string' && !have.has(f.external_id))
    .map((f) =>
      Object.fromEntries(
        DECLARED.filter((k) => f[k] !== undefined && f[k] !== null).map((k) => [k, f[k]]),
      ),
    );
  return { ...built, features: [...built.features, ...kept] };
}

/**
 * The Gladys device of a zone. `zone`: the last read (or undefined for a
 * created device not read now); `created`: the device already created in
 * Gladys, whose name and features are kept.
 */
export function buildZoneDevice(gladys, { hub, id }, { zone, language, created }) {
  const ids = idsOf(gladys, targetKey(hub, id));
  const params = [
    { name: 'hub_id', value: hub },
    { name: 'zone_id', value: String(id) },
  ];
  const rawName = zone?.rawName ?? created?.params?.find((p) => p?.name === 'zone_name')?.value;
  if (typeof rawName === 'string') {
    params.push({ name: 'zone_name', value: rawName });
  }
  const built = {
    name: created?.name ?? word(zoneName(zone?.name, id), language),
    external_id: ids.device,
    model: 'Heatmiser neoStat',
    should_poll: false,
    features: ZONE_ROLES.map((role) => ({
      name: word(FEATURE_NAMES[role], language),
      external_id: ids.feature(role),
      ...definitionOf(role),
      ...(role === F.MODE ? { supported_options: modeOptions(language) } : {}),
    })),
    params,
  };
  return keepCreatedFeatures(built, created);
}

/** The Gladys device of the hub itself: its away mode. */
export function buildHubDevice(gladys, hub, { language, created }) {
  const ids = idsOf(gladys, targetKey(hub, HUB_KEY));
  const built = {
    name: created?.name ?? word(hubName, language),
    external_id: ids.device,
    model: 'Heatmiser neoHub',
    should_poll: false,
    features: HUB_ROLES.map((role) => ({
      name: word(FEATURE_NAMES[role], language),
      external_id: ids.feature(role),
      ...definitionOf(role),
      supported_options: awayOptions(language),
    })),
    params: [{ name: 'hub_id', value: hub }],
  };
  return keepCreatedFeatures(built, created);
}
