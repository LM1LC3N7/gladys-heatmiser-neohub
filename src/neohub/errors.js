// -----------------------------------------------------------------------------
// The errors of the transport. A message never holds the token nor the
// address of the hub.
// -----------------------------------------------------------------------------

export class NeoHubError extends Error {
  /**
   * @param {'nopin'|'pin'|'token'|'hub'|'protocol'|'identity'|'timeout'|'late'|'network'|'closed'|'cut'|'size'|'stopped'} kind
   * @param {string} message never a token
   * @param {{ sent?: boolean, fingerprint?: string, text?: string, first?: boolean }} details
   *   sent: the command was written on the socket (it may have been done);
   *   text: the words of the hub (cleaned); first: the first command of its connection
   */
  constructor(kind, message, { sent = false, fingerprint, text, first = false } = {}) {
    super(message);
    this.name = 'NeoHubError';
    this.kind = kind;
    this.sent = sent;
    this.fingerprint = fingerprint;
    this.text = text;
    this.first = first;
  }
}

const NETWORK = {
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  ENOTFOUND: 'unknown host name',
  EAI_AGAIN: 'host name not resolved',
  ETIMEDOUT: 'connection timed out',
  EPIPE: 'connection closed',
};

/** Any error of a socket -> a NeoHubError of kind 'network' (its own text is never kept). */
export const networkError = (err, sent) =>
  err instanceof NeoHubError
    ? err
    : new NeoHubError('network', NETWORK[err?.code] ?? 'network error', { sent });
