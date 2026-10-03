// Tracks requests between reading them and writing their response, so `lhr mcp`
// can close at stdin EOF without dropping the answers to calls still running.
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

type Id = string | number;

const requestId = (m: JSONRPCMessage): Id | undefined =>
  'method' in m && 'id' in m ? m.id : undefined;

const responseId = (m: JSONRPCMessage): Id | undefined =>
  !('method' in m) && 'id' in m ? m.id : undefined;

/** The request a `notifications/cancelled` names; the SDK sends no response for it. */
const cancelledId = (m: JSONRPCMessage): Id | undefined => {
  if (!('method' in m) || m.method !== 'notifications/cancelled') return undefined;
  const id = (m.params as { requestId?: unknown } | undefined)?.requestId;
  return typeof id === 'string' || typeof id === 'number' ? id : undefined;
};

export interface InFlight {
  /** Resolves once every request read so far has had its response written. */
  idle(): Promise<void>;
}

/**
 * Wraps `transport` (after `server.connect`, which installs `onmessage`) to count
 * requests from the moment they are read until their response has been written.
 */
export function trackInFlight(transport: Transport): InFlight {
  const pending = new Set<Id>();
  let waiters: (() => void)[] = [];
  const done = (id: Id | undefined) => {
    if (id === undefined || !pending.delete(id) || pending.size > 0) return;
    const ready = waiters;
    waiters = [];
    for (const w of ready) w();
  };

  const onmessage = transport.onmessage;
  transport.onmessage = (message, extra) => {
    const id = requestId(message);
    if (id !== undefined) pending.add(id);
    done(cancelledId(message));
    onmessage?.(message, extra);
  };
  const send = transport.send.bind(transport);
  transport.send = async (message, options) => {
    try {
      await send(message, options);
    } finally {
      done(responseId(message));
    }
  };

  return {
    idle: () =>
      pending.size === 0 ? Promise.resolve() : new Promise((resolve) => waiters.push(resolve)),
  };
}
