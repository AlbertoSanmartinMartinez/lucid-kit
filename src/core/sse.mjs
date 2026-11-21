// SPDX-License-Identifier: Apache-2.0
// Server-sent events, read from a response body.
//
// Yields { event, data } for each event that carries data. Comments and heartbeats are skipped.
// Used by whoever listens to a stream of the hub: an agent's SDK, and a hub that follows another.
//
// An event is held in memory until it ends, and whoever sends the stream is not trusted to end
// it: one that grows past `maxEventLength` characters makes the reading fail.

export const MAX_SSE_EVENT_LENGTH = 1024 * 1024;

export async function* parseSSE(stream, { maxEventLength = MAX_SSE_EVENT_LENGTH } = {}) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed = { event: 'message', data: null };
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') parsed.event = value;
        else if (field === 'data') parsed.data = parsed.data === null ? value : `${parsed.data}\n${value}`;
      }
      if (parsed.data !== null) yield parsed;
    }
    if (buffer.length > maxEventLength) throw new Error('the stream sent an event that does not end');
  }
}

/**
 * The chunks of the body of a response, for as long as `signal` is not aborted: what to hand
 * parseSSE instead of the body itself, when a stream is read until somebody says to stop.
 *
 * Aborting the request that brought a response does not always stop the reading of its body. The
 * runtime keeps what ties one to the other only weakly, and may have let go of it by the time the
 * signal fires: seen with Node 22, whenever a garbage collection ran in between. Whoever waited
 * for the reading to end, to close, then waited for good. So the body is read through a reader
 * of its own, and that reader is cancelled when the signal says so: the reading ends, and the
 * connection goes with it.
 */
export function chunksUntil(body, signal) {
  const reader = body.getReader();
  const stop = () => reader.cancel().catch(() => {});
  if (signal.aborted) stop();
  else signal.addEventListener('abort', stop, { once: true });
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => reader.read(),
      // Whoever stops reading before the end: the connection is not left open behind it.
      return: async () => {
        signal.removeEventListener('abort', stop);
        await stop();
        return { done: true, value: undefined };
      },
    }),
  };
}
