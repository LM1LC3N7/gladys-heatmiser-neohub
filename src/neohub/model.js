// -----------------------------------------------------------------------------
// The answers of the hub -> checked values (official "neoHub API" PDF,
// "Live data" and "System Files"). Only the fields used are copied (never
// PIN_NUMBER, the lock code of a thermostat). A value that is missing, of
// the wrong type or out of range is unknown (undefined), never 0.
// -----------------------------------------------------------------------------

import { LIMITS, TEMPERATURE_RANGE } from '../constants.js';

/** A temperature in tenths of °C: "21.5" or 21.5 within the range, else undefined ('' and null are not 0). */
export function tenthsOf(raw) {
  let value;
  if (typeof raw === 'number') {
    value = raw;
  } else if (typeof raw === 'string' && /^-?\d{1,3}(\.\d{1,2})?$/.test(raw.trim())) {
    value = Number(raw.trim());
  } else {
    return undefined;
  }
  if (!Number.isFinite(value) || value < TEMPERATURE_RANGE.min || value > TEMPERATURE_RANGE.max) {
    return undefined;
  }
  return Math.round(value * 10);
}

const bool = (raw) => (raw === true || raw === false ? raw : undefined);

/** A zone name: trimmed, cut to 60 characters, without control characters; undefined when empty. */
function nameOf(raw) {
  if (typeof raw !== 'string') {
    return undefined;
  }
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return name === '' ? undefined : name;
}

/**
 * One device of the live data -> a zone, or undefined when it is not a
 * thermostat (a time clock, a plug) or its id cannot be read.
 */
export function parseZone(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const id = raw.DEVICE_ID;
  if (!Number.isSafeInteger(id) || id < 0 || id > 99_999) {
    return undefined;
  }
  // A neoAir in combined mode is two devices: the time clock half has THERMOSTAT false.
  if (raw.THERMOSTAT !== true || raw.TIMECLOCK === true) {
    return undefined;
  }
  const name = nameOf(raw.ZONE_NAME);
  const writeCount = Number.isSafeInteger(raw.WRITE_COUNT) ? raw.WRITE_COUNT : undefined;
  return {
    id,
    name,
    /** The name is exactly what the hub reported and can be sent back in a command. */
    rawName: typeof raw.ZONE_NAME === 'string' ? raw.ZONE_NAME : undefined,
    temperatureTenths: tenthsOf(raw.ACTUAL_TEMP),
    targetTenths: tenthsOf(raw.SET_TEMP),
    standby: bool(raw.STANDBY),
    away: bool(raw.AWAY),
    holiday: bool(raw.HOLIDAY),
    offline: bool(raw.OFFLINE),
    // Bits 6 and 7: the hub holds a command for a sleeping (battery) thermostat.
    waking: writeCount === undefined ? undefined : (writeCount & 0xc0) !== 0,
  };
}

/**
 * The answer to GET_LIVE_DATA -> `{ hubAway, hubHoliday, systemStamp, zones,
 * skipped }`, or undefined when it is not live data. Two devices with the same
 * id are both dropped (their values would mix).
 */
export function parseLive(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.devices)) {
    return undefined;
  }
  const zones = [];
  const counts = new Map();
  for (const entry of raw.devices.slice(0, LIMITS.zones * 2)) {
    const zone = parseZone(entry);
    if (zone) {
      zones.push(zone);
      counts.set(zone.id, (counts.get(zone.id) ?? 0) + 1);
    }
  }
  const unique = zones.filter((z) => counts.get(z.id) === 1).slice(0, LIMITS.zones);
  return {
    hubAway: bool(raw.HUB_AWAY),
    hubHoliday: bool(raw.HUB_HOLIDAY),
    systemStamp: Number.isSafeInteger(raw.TIMESTAMP_SYSTEM) ? raw.TIMESTAMP_SYSTEM : undefined,
    zones: unique,
    duplicates: zones.length - unique.length > 0,
  };
}

/** The answer to GET_SYSTEM -> `{ unit: 'C' | 'F' | undefined }`, or undefined. */
export function parseSystem(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  return { unit: raw.CORF === 'C' || raw.CORF === 'F' ? raw.CORF : undefined };
}
