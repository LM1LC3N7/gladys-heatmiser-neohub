// -----------------------------------------------------------------------------
// The WebSocket messages of the neoHub (official "neoHub API" PDF, section
// "Websocket command structure"): the request envelope, the command in the
// single-quoted form of the PDF, and the answer envelope. Pure, no network.
// -----------------------------------------------------------------------------

import { API, LIMITS } from '../constants.js';

/** A zone name that can travel inside a single-quoted command: no quote, backslash nor control. */
// eslint-disable-next-line no-control-regex
const SAFE_NAME = /^[^'"\\\u0000-\u001f\u007f]{1,60}$/u;

export const isSafeName = (name) => typeof name === 'string' && SAFE_NAME.test(name);

function encodeValue(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('not a finite number');
    }
    return String(value);
  }
  if (typeof value === 'string') {
    if (!isSafeName(value)) {
      throw new Error('a name the hub cannot be sent');
    }
    return `'${value}'`;
  }
  if (Array.isArray(value)) {
    return `[${value.map(encodeValue).join(',')}]`;
  }
  throw new Error('unsupported value');
}

/** `{'SET_TEMP':[21.5,['Living room']]}`: the command as the PDF writes it. */
export function encodeCommand(name, argument = 0) {
  if (!Object.values(API.commands).includes(name)) {
    throw new Error('unknown command');
  }
  return `{'${name}':${encodeValue(argument)}}`;
}

/** The text sent on the socket: the token and one command, under its id. */
export function buildRequest(token, command, id) {
  return JSON.stringify({
    message_type: API.requestType,
    message: JSON.stringify({ token, COMMANDS: [{ COMMAND: command, COMMANDID: id }] }),
  });
}

/** `D8:80:39:AD:0D:F0` (spaces, dashes, any case) -> `d88039ad0df0`; undefined when unreadable. */
export function hubIdOf(raw) {
  if (typeof raw !== 'string' || raw.length > 40) {
    return undefined;
  }
  const hex = raw.trim().replace(/[:-]/g, '').toLowerCase();
  return /^[0-9a-f]{12}$/.test(hex) && !/^0{12}$|^f{12}$/.test(hex) ? hex : undefined;
}

/** A short printable text of the hub, safe for a status (never more than 80 characters). */
export function cleanText(text, token) {
  let out = typeof text === 'string' ? text : '';
  if (token) {
    out = out.split(token).join('…');
  }
  return out
    .replace(/[^\x20-\x7e\u00a0-\u024f\u2026]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LIMITS.reasonLength);
}

/** The hub says the token is refused (its exact words are not documented: a token word and a refusal word). */
const TOKEN_REFUSED = (text) =>
  /token/i.test(text) &&
  /invalid|incorrect|unauthori[sz]ed|denied|not valid|expired|wrong|unknown|revoked/i.test(text);

/**
 * One frame of the hub -> `{ commandId, hubId, type, response }` or
 * `{ invalid: true }` when it is not an answer envelope. `response` is the
 * parsed JSON of the `response` field (an object, an array, a value), or
 * `{ text }` when that field is not JSON. Only the fields used are copied.
 */
export function parseFrame(text) {
  let outer;
  try {
    outer = JSON.parse(text);
  } catch {
    return { invalid: true };
  }
  if (!outer || typeof outer !== 'object' || Array.isArray(outer)) {
    return { invalid: true };
  }
  const commandId = Number.isSafeInteger(outer.command_id) ? outer.command_id : undefined;
  const type = typeof outer.message_type === 'string' ? outer.message_type : undefined;
  let response = outer.response;
  if (typeof response === 'string') {
    try {
      response = JSON.parse(response);
    } catch {
      response = { text: response };
    }
  }
  return { commandId, hubId: hubIdOf(outer.device_id), type, response };
}

/**
 * The error a response carries, if any: `{ token: true }` when the hub says
 * the token is refused, `{ text }` for another error, undefined when none.
 */
export function responseError(response) {
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    const text =
      typeof response.error === 'string'
        ? response.error
        : typeof response.text === 'string'
          ? response.text
          : undefined;
    if (text !== undefined) {
      return TOKEN_REFUSED(text) ? { token: true, text } : { text };
    }
  }
  return undefined;
}
