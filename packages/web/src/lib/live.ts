import { accessToken } from './auth';

export type LiveEvent =
  | { type: 'ready'; data: { tokenExpiresAt: string | null } }
  | { type: 'execution'; data: { id: string; status: string; transactionOutcome: string } }
  | { type: 'export'; data: { id: string; executionId: string; status: string } }
  | { type: 'approval'; data: { id: string; executionId: string; status: string } };

/**
 * Server-sent events over fetch (EventSource cannot send the bearer token). Reconnects after a
 * drop or at token expiry; after each (re)connect `onConnected` lets the caller fetch the state it
 * follows by ID, so nothing is lost while the stream was down (AC7).
 */
export function connectLive(handlers: {
  onEvent: (event: LiveEvent) => void;
  onConnected?: () => void;
  onState?: (state: 'connecting' | 'live' | 'offline') => void;
}): () => void {
  let stopped = false;
  let controller: AbortController | null = null;
  let retry = 3000;

  const run = async () => {
    while (!stopped) {
      handlers.onState?.('connecting');
      controller = new AbortController();
      try {
        const response = await fetch('/api/v1/events', {
          headers: { authorization: `Bearer ${await accessToken()}`, accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error(`events ${response.status}`);
        handlers.onState?.('live');
        handlers.onConnected?.();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let at: number;
          while ((at = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, at);
            buffer = buffer.slice(at + 2);
            const retryLine = /^retry: (\d+)$/m.exec(block);
            if (retryLine) retry = Number(retryLine[1]);
            const type = /^event: (.+)$/m.exec(block)?.[1];
            const data = /^data: (.+)$/m.exec(block)?.[1];
            if (type && data) handlers.onEvent({ type, data: JSON.parse(data) } as LiveEvent);
          }
        }
      } catch {
        if (stopped) return;
        handlers.onState?.('offline');
      }
      if (!stopped) await new Promise((r) => setTimeout(r, retry));
    }
  };
  void run();
  return () => {
    stopped = true;
    controller?.abort();
  };
}
