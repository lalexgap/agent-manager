import { describe, expect, test } from "bun:test";
import { nextBackoffMs, watchRemoteFleetEvents, type RemoteEventStream } from "../src/fleetEvents";

const encoder = new TextEncoder();

// A fake `ssh host am __events` child: a controllable stdout stream plus a
// kill() that closes it, mirroring what killing the real ssh process does.
function fakeStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const handle = {
    killed: false,
    push(text: string) {
      controller.enqueue(encoder.encode(text));
    },
    close() {
      try {
        controller.close();
      } catch {
        // already closed
      }
    },
  };
  const stream: RemoteEventStream = {
    stdout,
    kill() {
      handle.killed = true;
      handle.close();
    },
  };
  return { stream, handle };
}

const READY = 'event: ready\ndata: {"type":"ready","startedAt":"x"}\n\n';
const FLEET = 'event: fleet\ndata: {"id":1,"type":"fleet","event":"changed","at":"x"}\n\n';

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await Bun.sleep(5);
  }
}

describe("nextBackoffMs", () => {
  test("doubles and caps", () => {
    expect(nextBackoffMs(1000, 60_000)).toBe(2000);
    expect(nextBackoffMs(40_000, 60_000)).toBe(60_000);
    expect(nextBackoffMs(60_000, 60_000)).toBe(60_000);
  });
});

describe("watchRemoteFleetEvents", () => {
  test("surfaces ready as health and fleet blocks as events", async () => {
    const fakes: ReturnType<typeof fakeStream>[] = [];
    const events: string[] = [];
    const health: [string, boolean][] = [];
    const stop = watchRemoteFleetEvents(
      ["srv"],
      {
        onEvent: (host) => events.push(host),
        onHealth: (host, healthy) => health.push([host, healthy]),
      },
      {
        spawn: () => {
          const fake = fakeStream();
          fakes.push(fake);
          return fake.stream;
        },
        reconnectMinMs: 10,
        reconnectMaxMs: 40,
        livenessMs: 60_000,
      },
    );
    try {
      await until(() => fakes.length === 1);
      fakes[0]!.handle.push(READY);
      await until(() => health.length === 1);
      expect(health[0]).toEqual(["srv", true]);

      fakes[0]!.handle.push(FLEET + FLEET);
      await until(() => events.length === 2);
      expect(events).toEqual(["srv", "srv"]);

      // Stream dies → health goes false and a new connection is dialed.
      fakes[0]!.handle.close();
      await until(() => health.length === 2 && fakes.length === 2);
      expect(health[1]).toEqual(["srv", false]);
    } finally {
      stop();
    }
  });

  test("kills a silent stream once the liveness window passes", async () => {
    const fakes: ReturnType<typeof fakeStream>[] = [];
    const stop = watchRemoteFleetEvents(
      ["srv"],
      { onEvent: () => {} },
      {
        spawn: () => {
          const fake = fakeStream();
          fakes.push(fake);
          return fake.stream;
        },
        reconnectMinMs: 10,
        reconnectMaxMs: 40,
        livenessMs: 30,
      },
    );
    try {
      await until(() => fakes.length === 1);
      await until(() => fakes[0]!.handle.killed);
      // ...and it reconnects afterwards.
      await until(() => fakes.length >= 2);
    } finally {
      stop();
    }
  });

  test("stop kills the child and prevents redials", async () => {
    const fakes: ReturnType<typeof fakeStream>[] = [];
    const stop = watchRemoteFleetEvents(
      ["srv"],
      { onEvent: () => {} },
      {
        spawn: () => {
          const fake = fakeStream();
          fakes.push(fake);
          return fake.stream;
        },
        reconnectMinMs: 10,
        reconnectMaxMs: 20,
        livenessMs: 60_000,
      },
    );
    await until(() => fakes.length === 1);
    stop();
    await until(() => fakes[0]!.handle.killed);
    await Bun.sleep(60); // several reconnect windows
    expect(fakes.length).toBe(1);
  });

  test("short-lived ready connections keep compounding backoff; stable ones reset it", async () => {
    // A crash-looping remote daemon says ready then dies instantly — the
    // redial gaps must grow. With stableMs=0 the same pattern counts as
    // stable and redials at the floor.
    const gaps = async (stableMs: number): Promise<number[]> => {
      const spawns: number[] = [];
      const stop = watchRemoteFleetEvents(
        ["srv"],
        { onEvent: () => {} },
        {
          spawn: () => {
            spawns.push(Date.now());
            const fake = fakeStream();
            fake.handle.push(READY);
            fake.handle.close();
            return fake.stream;
          },
          reconnectMinMs: 20,
          reconnectMaxMs: 300,
          livenessMs: 60_000,
          stableMs,
        },
      );
      try {
        await until(() => spawns.length >= 4);
      } finally {
        stop();
      }
      return [spawns[1]! - spawns[0]!, spawns[2]! - spawns[1]!, spawns[3]! - spawns[2]!];
    };

    const compounding = await gaps(10_000);
    expect(compounding[2]!).toBeGreaterThanOrEqual(compounding[0]! * 2);

    const resetting = await gaps(0);
    expect(resetting[2]!).toBeLessThan(60);
  });

  test("a stream that never says ready reports no health transitions", async () => {
    const health: [string, boolean][] = [];
    let spawns = 0;
    const stop = watchRemoteFleetEvents(
      ["srv"],
      { onEvent: () => {}, onHealth: (host, healthy) => health.push([host, healthy]) },
      {
        spawn: () => {
          spawns++;
          const fake = fakeStream();
          // an old remote: `am` errors out immediately, stdout just closes
          fake.handle.close();
          return fake.stream;
        },
        reconnectMinMs: 5,
        reconnectMaxMs: 10,
        livenessMs: 60_000,
      },
    );
    try {
      await until(() => spawns >= 3);
      expect(health).toEqual([]);
    } finally {
      stop();
    }
  });
});
