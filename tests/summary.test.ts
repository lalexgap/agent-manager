import { describe, expect, test } from "bun:test";
import type { Fleet, FleetRow } from "../src/fleet";
import { buildFleetSummary, formatFleetSummary, STALE_STARTING_SECONDS } from "../src/summary";

const NOW = new Date("2026-07-22T12:00:00.000Z");

function row(name: string, status: FleetRow["status"], overrides: Partial<FleetRow> = {}): FleetRow {
  return {
    name,
    status,
    provider: "claude",
    queued: 0,
    updatedAt: "2026-07-22T11:59:30.000Z",
    statusChangedAt: "2026-07-22T11:59:30.000Z",
    dir: "/tmp",
    ...overrides,
  };
}

describe("fleet summary", () => {
  test("prioritizes attention, then separates active, idle, and exited agents", () => {
    const fleet: Fleet = {
      rows: [
        row("worker", "working", { task: "implement the reporting view" }),
        row("blocked", "needs-attention", { statusReason: "approval requested — shell" }),
        row("watcher", "waiting", { statusDetail: "next wake-up in 4m" }),
        row("quiet", "idle"),
        row("done", "exited"),
      ],
      unreachable: ["build-box"],
    };

    const summary = buildFleetSummary(fleet, NOW);
    expect(summary.attention.map((item) => item.status)).toEqual(["needs-attention", "unreachable"]);
    expect(summary.attention[0]?.reason).toBe("approval requested — shell");
    expect(summary.active.map((item) => item.name)).toEqual(["worker", "watcher"]);
    expect(summary.active.find((item) => item.name === "watcher")?.reason).toBe("next wake-up in 4m");
    expect(summary.idle.map((item) => item.name)).toEqual(["quiet"]);
    expect(summary.exited.map((item) => item.name)).toEqual(["done"]);
  });

  test("promotes an agent stuck in starting to attention", () => {
    const changedAt = new Date(NOW.getTime() - STALE_STARTING_SECONDS * 1000).toISOString();
    const summary = buildFleetSummary({
      rows: [row("stuck", "starting", { statusChangedAt: changedAt })],
      unreachable: [],
    }, NOW);

    expect(summary.active).toHaveLength(0);
    expect(summary.attention[0]).toMatchObject({ name: "stuck", status: "starting" });
    expect(summary.attention[0]?.reason).toContain("still starting after 2m");
  });

  test("uses host-qualified keys and renders queue depth", () => {
    const summary = buildFleetSummary({
      rows: [row("remote-worker", "working", { host: "server", queued: 2 })],
      unreachable: [],
    }, NOW);
    const text = formatFleetSummary(summary).join("\n");
    expect(text).toContain("server:remote-worker");
    expect(text).toContain("2 queued");
  });

  test("carries roles into JSON and the human report", () => {
    const summary = buildFleetSummary({
      rows: [row("audit", "working", { role: "security-reviewer" })],
      unreachable: [],
    }, NOW);
    expect(summary.active[0]?.role).toBe("security-reviewer");
    expect(formatFleetSummary(summary).join("\n")).toContain("working · security-reviewer");
  });

  test("collapses historical exited agents in the human report", () => {
    const summary = buildFleetSummary({
      rows: [row("old-agent", "exited"), row("current", "working")],
      unreachable: [],
    }, NOW);
    const text = formatFleetSummary(summary).join("\n");
    expect(text).toContain("Exited (1)");
    expect(text).not.toContain("old-agent");
  });

  test("renders an empty fleet tersely", () => {
    expect(formatFleetSummary(buildFleetSummary({ rows: [], unreachable: [] }, NOW))).toEqual(["No agents."]);
  });
});
