import { createSseParser } from "./sse";
import { sshAmStreamArgv } from "./remote";

// Cross-host status push: hold one `ssh <host> am __events` per remote and
// surface every fleet event, so the hub hears about a remote status change in
// ~ssh latency instead of on the next poll. Polling (fleet.ts) remains the
// consistency fallback — an old remote without __events just exits fast here
// and the watcher backs off to its max interval while polling carries on.

// The minimal slice of Bun.Subprocess the watcher needs, so tests can hand in
// a fake stream instead of a real ssh child.
export interface RemoteEventStream {
  stdout: ReadableStream<Uint8Array>;
  kill(): void;
}

export interface RemoteWatchHooks {
  // A fleet event arrived from this host (raw — the fleet cache debounces).
  onEvent: (host: string) => void;
  // The push channel came up (remote daemon's `ready` seen) or went away.
  // Drives poll relaxation and the catch-up refresh on reconnect.
  onHealth?: (host: string, healthy: boolean) => void;
}

export interface RemoteWatchOptions {
  spawn?: (host: string) => RemoteEventStream;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  // Kill and redial a stream silent for this long. The daemon emits a
  // keepalive every 15s, so silence means the pipe is dead, not just quiet.
  livenessMs?: number;
}

export function nextBackoffMs(current: number, maxMs: number): number {
  return Math.min(current * 2, maxMs);
}

function spawnEventStream(host: string): RemoteEventStream {
  return Bun.spawn(sshAmStreamArgv(host, ["__events"]), {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
}

export function watchRemoteFleetEvents(
  hosts: string[],
  hooks: RemoteWatchHooks,
  opts: RemoteWatchOptions = {},
): () => void {
  const spawn = opts.spawn ?? spawnEventStream;
  const minMs = opts.reconnectMinMs ?? 1000;
  const maxMs = opts.reconnectMaxMs ?? 60_000;
  const livenessMs = opts.livenessMs ?? 45_000;
  let stopped = false;
  const children = new Set<RemoteEventStream>();

  const watchHost = async (host: string) => {
    let backoff = minMs;
    while (!stopped) {
      let ready = false;
      let child: RemoteEventStream | null = null;
      let liveness: ReturnType<typeof setTimeout> | undefined;
      try {
        child = spawn(host);
        children.add(child);
        const armLiveness = () => {
          clearTimeout(liveness);
          liveness = setTimeout(() => child?.kill(), livenessMs);
        };
        armLiveness();
        const decoder = new TextDecoder();
        const parse = createSseParser((data) => {
          let event: { type?: string };
          try {
            event = JSON.parse(data) as { type?: string };
          } catch {
            return;
          }
          if (event.type === "ready" && !ready) {
            // The remote daemon answered: the push channel works. Reset the
            // backoff and let the poller relax. A flapping daemon therefore
            // redials at minMs — bounded, and no worse than the hot poll was.
            ready = true;
            backoff = minMs;
            hooks.onHealth?.(host, true);
          } else if (event.type === "fleet") {
            hooks.onEvent(host);
          }
        });
        const reader = child.stdout.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          armLiveness(); // any bytes, keepalives included, prove liveness
          if (value) parse(decoder.decode(value, { stream: true }));
        }
      } catch {
        // spawn/read failure — same handling as a clean close below
      } finally {
        clearTimeout(liveness);
        if (child) {
          children.delete(child);
          try {
            child.kill();
          } catch {
            // already gone
          }
        }
      }
      if (ready) hooks.onHealth?.(host, false);
      if (stopped) return;
      const jitter = 0.9 + Math.random() * 0.2;
      await Bun.sleep(Math.floor(backoff * jitter));
      backoff = nextBackoffMs(backoff, maxMs);
    }
  };

  for (const host of hosts) void watchHost(host);

  return () => {
    stopped = true;
    for (const child of children) {
      try {
        child.kill();
      } catch {
        // already gone
      }
    }
  };
}
