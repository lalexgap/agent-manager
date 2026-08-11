import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { cacheIsFresh, filterByAgent, localArtifactRows, resolveArtifact, type FileRow } from "../src/commands/files";
import { shareCommand } from "../src/commands/share";

let home: string;
let work: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-files-"));
  work = mkdtempSync(join(tmpdir(), "am-files-work-"));
  process.env.AGENTMGR_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
  delete process.env.AGENTMGR_HOME;
});

async function share(owner: string, name: string, content = "data"): Promise<void> {
  const src = join(work, name);
  writeFileSync(src, content);
  await shareCommand(src, undefined, { from: owner });
}

function row(agent: string, name: string, extra: Partial<FileRow> = {}): FileRow {
  return {
    agent,
    name,
    path: `/shared/${agent}/files/${name}`,
    size: 1,
    mtimeMs: 1000,
    at: "2026-01-01T00:00:00Z",
    ...extra,
  };
}

describe("localArtifactRows", () => {
  test("scans every owner and reports absolute paths", async () => {
    await share("web", "a.png");
    await share("web", "b.md");
    await share("api", "c.txt");

    const rows = localArtifactRows();
    expect(rows.map((r) => `${r.agent}/${r.name}`).sort()).toEqual(["api/c.txt", "web/a.png", "web/b.md"]);
    for (const r of rows) {
      expect(isAbsolute(r.path)).toBe(true);
      expect(r.host).toBeUndefined();
    }
  });

  test("empty without a shared root", () => {
    expect(localArtifactRows()).toEqual([]);
  });
});

describe("filterByAgent", () => {
  test("exact match, then unique prefix", () => {
    const rows = [row("web", "a.png"), row("web-old", "b.png")];
    expect(filterByAgent(rows, "web").map((r) => r.name)).toEqual(["a.png"]);
    expect(filterByAgent([row("worker", "c.png")], "wor").map((r) => r.name)).toEqual(["c.png"]);
  });

  test("ambiguity across hosts names the candidates", () => {
    const rows = [row("web", "a.png"), row("web", "b.png", { host: "gapserver" })];
    expect(() => filterByAgent(rows, "web")).toThrow(/ambiguous across hosts: web, gapserver:web/);
  });

  test("unknown agent errors, pointing at am files", () => {
    expect(() => filterByAgent([row("web", "a.png")], "ghost")).toThrow(/no shared artifacts from "ghost"/);
  });
});

describe("resolveArtifact", () => {
  const rows = [
    row("web", "oldest.png", { mtimeMs: 1 }),
    row("web", "middle.md", { mtimeMs: 2 }),
    row("web", "newest.png", { mtimeMs: 3 }),
  ];

  test("defaults to the newest", () => {
    expect(resolveArtifact(rows).name).toBe("newest.png");
  });

  test("numeric selector is nth-newest, 1-based, bounds-checked", () => {
    expect(resolveArtifact(rows, "2").name).toBe("middle.md");
    expect(() => resolveArtifact(rows, "4")).toThrow(/only 3 artifact/);
  });

  test("name selector: exact wins, unique substring works, ambiguity throws", () => {
    expect(resolveArtifact(rows, "oldest.png").name).toBe("oldest.png");
    expect(resolveArtifact(rows, "middle").name).toBe("middle.md");
    expect(() => resolveArtifact(rows, ".png")).toThrow(/matches several/);
    expect(() => resolveArtifact(rows, "zzz")).toThrow(/no artifact matches/);
  });
});

describe("cacheIsFresh", () => {
  const remote = row("web", "a.png", { host: "gapserver", size: 10, mtimeMs: 2000 });

  test("fresh only when size matches and the cached mtime is not older", () => {
    expect(cacheIsFresh(remote, null)).toBe(false);
    expect(cacheIsFresh(remote, { size: 10, mtimeMs: 2000 })).toBe(true);
    expect(cacheIsFresh(remote, { size: 10, mtimeMs: 1000 })).toBe(false); // re-shared since
    expect(cacheIsFresh(remote, { size: 9, mtimeMs: 2000 })).toBe(false); // different bytes
  });
});
