import { describe, expect, test } from "bun:test";
import { createEventPump } from "../src/fleet";

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await Bun.sleep(5);
  }
}

describe("createEventPump", () => {
  test("coalesces a burst of events into one refresh", async () => {
    const calls: string[] = [];
    const pump = createEventPump(async (host) => {
      calls.push(host);
    }, 20);
    pump("srv");
    pump("srv");
    pump("srv");
    await Bun.sleep(80);
    expect(calls).toEqual(["srv"]);
  });

  test("an event landing mid-refresh triggers exactly one follow-up", async () => {
    let release: () => void = () => {};
    const calls: string[] = [];
    const pump = createEventPump(async (host) => {
      calls.push(host);
      if (calls.length === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    }, 10);
    pump("srv");
    await until(() => calls.length === 1);
    // The first refresh is in flight and predates these events.
    pump("srv");
    pump("srv");
    release();
    await until(() => calls.length === 2);
    await Bun.sleep(60);
    expect(calls).toEqual(["srv", "srv"]);
  });

  test("hosts pump independently", async () => {
    const calls: string[] = [];
    const pump = createEventPump(async (host) => {
      calls.push(host);
    }, 10);
    pump("a");
    pump("b");
    await until(() => calls.length === 2);
    expect(calls.sort()).toEqual(["a", "b"]);
  });

  test("a refresh failure does not wedge the pump", async () => {
    let attempts = 0;
    const pump = createEventPump(async () => {
      attempts++;
      throw new Error("ssh exploded");
    }, 10);
    pump("srv");
    await until(() => attempts === 1);
    pump("srv");
    await until(() => attempts === 2);
  });
});
