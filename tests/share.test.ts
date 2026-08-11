import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactCopyPath, latestArtifacts, readManifest, shareAnnouncement, shareCommand } from "../src/commands/share";
import { commsFor } from "../src/comms";
import { sharedDir } from "../src/paths";
import { writeAgent, type AgentState } from "../src/state";

let home: string;
let work: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-share-"));
  work = mkdtempSync(join(tmpdir(), "am-share-work-"));
  process.env.AGENTMGR_HOME = home;
  delete process.env.AGENTMGR_AGENT;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
  delete process.env.AGENTMGR_HOME;
  delete process.env.AGENTMGR_AGENT;
});

function agent(name: string): void {
  const now = new Date().toISOString();
  const s: AgentState = {
    name,
    status: "idle",
    dir: work,
    tmuxSession: `agentmgr-${name}`,
    createdAt: now,
    updatedAt: now,
  };
  writeAgent(s);
}

describe("shareAnnouncement", () => {
  test("with and without a message", () => {
    expect(shareAnnouncement("a.png")).toBe("shared a.png");
    expect(shareAnnouncement("a.png", "  ")).toBe("shared a.png");
    expect(shareAnnouncement("a.png", "login page")).toBe("shared a.png — login page");
  });
});

describe("shareCommand", () => {
  test("copies the file, appends a manifest entry, and records operator-facing comms", async () => {
    agent("web");
    process.env.AGENTMGR_AGENT = "web";
    const src = join(work, "shot.png");
    writeFileSync(src, "pixels");

    await shareCommand(src, "login page");

    const copy = artifactCopyPath("web", "shot.png");
    expect(existsSync(copy)).toBe(true);
    const entries = readManifest("web");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: "shot.png", origPath: src, size: 6, message: "login page" });
    expect(entries[0]!.mtimeMs).toBeGreaterThan(0);
    expect(entries[0]!.host).toBeTruthy();
    expect(commsFor("web").at(-1)).toMatchObject({ from: "web", to: "operator", kind: "share" });
  });

  test("falls back to the operator bucket outside a managed session, without a comms entry", async () => {
    const src = join(work, "notes.md");
    writeFileSync(src, "# notes");

    await shareCommand(src, undefined);

    expect(existsSync(artifactCopyPath("operator", "notes.md"))).toBe(true);
    expect(commsFor("operator")).toEqual([]);
  });

  test("re-sharing a name overwrites the copy; listings dedupe newest-wins", async () => {
    agent("web");
    const src = join(work, "shot.png");
    writeFileSync(src, "v1");
    await shareCommand(src, "first", { from: "web" });
    writeFileSync(src, "v2!!");
    await shareCommand(src, "second", { from: "web" });

    expect(readManifest("web")).toHaveLength(2);
    const latest = latestArtifacts("web", readManifest("web"));
    expect(latest).toHaveLength(1);
    expect(latest[0]).toMatchObject({ name: "shot.png", message: "second", size: 4 });
  });

  test("drops manifest entries whose copy was deleted out-of-band", async () => {
    const src = join(work, "gone.txt");
    writeFileSync(src, "x");
    await shareCommand(src, undefined, { from: "web" });
    rmSync(artifactCopyPath("web", "gone.txt"));

    expect(latestArtifacts("web", readManifest("web"))).toEqual([]);
  });

  test("rejects a missing file, a directory, and an oversized file", async () => {
    await expect(shareCommand(join(work, "nope.txt"), undefined)).rejects.toThrow(/not a file/);
    await expect(shareCommand(work, undefined)).rejects.toThrow(/not a file/);
    const big = join(work, "big.bin");
    writeFileSync(big, "");
    truncateSync(big, 101_000_000); // sparse — no real disk usage
    await expect(shareCommand(big, undefined)).rejects.toThrow(/too large/);
    expect(existsSync(sharedDir("operator"))).toBe(false);
  });
});
