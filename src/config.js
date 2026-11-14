// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized. Nothing here
// talks to the network.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { API, POLL_INTERVAL, SETPOINT } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). No default for the token. */
export const DEFAULTS = {
  certificate_fingerprint: '',
  allow_heating: false,
  max_setpoint: SETPOINT.ceilingDefault,
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};

export const LANGUAGES = ['fr', 'en'];

/**
 * An API token of the hub: printable ASCII, 8 to 256 characters, without
 * quotes, backslash nor space (it travels inside two JSON strings).
 */
export const TOKEN = /^[\x21\x23-\x26\x28-\x5b\x5d-\x7e]{8,256}$/;

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/** Broadcast, multicast, "this network" and unspecified addresses are never a hub. */
function notAHub(host) {
  if (isIP(host) === 4) {
    const parts = host.split('.').map(Number);
    return parts[0] === 0 || (parts[0] >= 224 && parts[0] <= 239) || parts.every((p) => p === 255);
  }
  if (isIP(host) === 6) {
    return /^ff/i.test(host) || host === '::';
  }
  return false;
}

/**
 * The address typed by the user: `{ host, port }`, or `{ error }`:
 * 'path' (a path, a query or credentials: a pasted URL), 'invalid',
 * 'broadcast', 'local-name' (an mDNS name: it does not resolve in the
 * container). `{}` when empty. "wss://" and ":port" are accepted.
 */
export function parseAddress(raw) {
  let text = String(raw ?? '').trim();
  if (text === '') {
    return {};
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    return { error: 'invalid' };
  }
  text = text.replace(/^wss?:\/\//i, '').replace(/\/$/, '');
  if (/[/?#@\s]/.test(text)) {
    return { error: 'path' };
  }
  let host = text;
  let port;
  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(text);
  if (bracketed) {
    host = bracketed[1];
    port = bracketed[2];
  } else if (isIP(text) !== 6) {
    const withPort = /^([^:]+):(\d{1,5})$/.exec(text);
    if (withPort) {
      host = withPort[1];
      port = withPort[2];
    } else if (text.includes(':')) {
      return { error: 'invalid' };
    }
  }
  host = host.toLowerCase();
  if (isIP(host) === 0 && !HOSTNAME.test(host)) {
    return { error: 'invalid' };
  }
  if (isIP(host) === 0 && /\.local$/.test(host)) {
    return { error: 'local-name' };
  }
  if (notAHub(host)) {
    return { error: 'broadcast' };
  }
  const portNumber = port === undefined ? API.defaultPort : Number(port);
  if (!(portNumber >= 1 && portNumber <= 65535)) {
    return { error: 'invalid' };
  }
  return { host, port: portNumber };
}

/**
 * A SHA-256 certificate fingerprint as Node shows it (`AB:CD:…`, 32 bytes),
 * from hex with or without colons; `{}` when empty.
 */
export function parseFingerprint(raw) {
  const text = String(raw ?? '')
    .trim()
    .replace(/^sha-?256[:=\s]*/i, '');
  if (text === '') {
    return {};
  }
  const hex = text.replace(/[:\s]/g, '');
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    return { error: 'fingerprint' };
  }
  return { fingerprint: hex.toUpperCase().match(/../g).join(':') };
}

/** The key of a hub address in /data: a hash of its address and port (the address is never written). */
export const addressKey = (host, port) =>
  host
    ? createHash('sha256')
        .update(`heatmiser-neohub:${host}:${port}`, 'utf8')
        .digest('hex')
        .slice(0, 32)
    : '';

/**
 * The tag of a refused token kept in /data: 8 bits of a salted hash, enough
 * to tell "the same token again" from "a new token" (a new one is always
 * tried), useless to guess it (one token in 256 shares a tag).
 */
export const tokenTag = (salt, token) =>
  createHash('sha256').update(`${salt}:${token}`, 'utf8').digest('hex').slice(0, 2);

const number = (value) =>
  value === undefined || value === null || value === '' || typeof value === 'boolean'
    ? NaN
    : Number(value);

const clamp = (value, { min, max }, fallback) =>
  Number.isFinite(value) ? Math.round(Math.max(min, Math.min(max, value))) : fallback;

/** The ceiling of the setpoints: bounded, rounded DOWN to the step of 0.5 °C (22.7 -> 22.5). */
const ceilingOf = (value) =>
  Number.isFinite(value)
    ? Math.floor(Math.max(SETPOINT.ceilingMin, Math.min(SETPOINT.max, value)) * 2) / 2
    : DEFAULTS.max_setpoint;

/** Only true (or "true") turns an option on: anything else keeps it off. */
const on = (value) => value === true || value === 'true';

export function normalizeConfig(raw = {}) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const address = parseAddress(c.host);
  const pin = parseFingerprint(c.certificate_fingerprint);
  const token = typeof c.api_token === 'string' ? c.api_token.trim() : '';
  const language = String(c.language ?? DEFAULTS.language)
    .trim()
    .toLowerCase();
  let error = address.error ?? pin.error;
  if (!error && token !== '' && !TOKEN.test(token)) {
    error = 'token';
  }
  const port = address.port ?? API.defaultPort;
  return {
    host: address.host ?? '',
    port,
    key: addressKey(address.host, port),
    token: error === 'token' ? '' : token,
    fingerprint: pin.fingerprint,
    error,
    allowHeating: on(c.allow_heating),
    ceiling: ceilingOf(number(c.max_setpoint)),
    pollInterval: clamp(number(c.poll_interval), POLL_INTERVAL, DEFAULTS.poll_interval),
    language: LANGUAGES.includes(language) ? language : DEFAULTS.language,
  };
}

/** True when the address and the token are there and valid. */
export const isComplete = (config) =>
  config.host !== '' && config.token !== '' && config.error === undefined;
