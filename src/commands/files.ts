import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { artifactsCacheDir, sharedRootDir } from "../paths";
import { loadConfig } from "../config";
import { runAsync, sshAmAsync } from "../remote";
import { shQuote } from "../tmux";
import { chooseOpener } from "./click";
import { relativeTime } from "./ls";
import { artifactCopyPath, latestArtifacts, readManifest } from "./share";

// Operator side of shared artifacts: `am files` lists what agents have
// published (merging local rows with `am files --json --local-only` over ssh
// per config.remotes, the fleet pattern), and `am open` pulls one down and
// opens it. Remotes report their own absolute paths, so a remote
// AGENTMGR_HOME override is respected — nothing reconstructs ~/.agent-manager
// on the far side.

export interface FileRow {
  agent: string;
  name: string;
  path: string; // absolute, on `host` (or this machine when host is unset)
  size: number;
  mtimeMs: number;
  at: string;
  message?: string;
  origPath?: string;
  host?: string; // ssh alias, tagged laptop-side; undefined = local
}

export function localArtifactRows(): FileRow[] {
  if (!existsSync(sharedRootDir())) return [];
  const rows: FileRow[] = [];
  for (const owner of readdirSync(sharedRootDir())) {
    for (const entry of latestArtifacts(owner, readManifest(owner))) {
      rows.push({
        agent: owner,
        name: entry.name,
        path: artifactCopyPath(owner, entry.name),
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        at: entry.at,
        message: entry.message,
        origPath: entry.origPath,
      });
    }
  }
  return rows;
}

function parseRemoteRows(host: string, stdout: string): FileRow[] {
  try {
    return (JSON.parse(stdout) as FileRow[]).map((row) => ({ ...row, host }));
  } catch {
    return [];
  }
}

// Local rows + per-remote fan-out. An unreachable host (or one running an am
// too old to know `files`) is warned about, never fatal — same contract as
// fleetRows.
async function gatherRows(localOnly: boolean): Promise<FileRow[]> {
  const rows = localArtifactRows();
  if (localOnly) return rows;
  const remotes = loadConfig().remotes ?? [];
  const fetched = await Promise.all(
    remotes.map((host) => sshAmAsync(host, ["files", "--json", "--local-only"], { timeoutMs: 8000 })),
  );
  remotes.forEach((host, i) => {
    const result = fetched[i]!;
    if (result.exitCode !== 0) {
      console.error(`${host}: unreachable (or its am predates \`files\`) — skipped`);
      return;
    }
    rows.push(...parseRemoteRows(host, result.stdout));
  });
  return rows;
}

// The exact→prefix→ambiguous ladder used everywhere agents are addressed
// (resolveFileTarget, maybeForwardToFleet), over artifact owners.
export function filterByAgent(rows: FileRow[], ref: string): FileRow[] {
  const label = (r: FileRow) => (r.host ? `${r.host}:${r.agent}` : r.agent);
  const owners = (matched: FileRow[]) => [...new Set(matched.map(label))];
  const exact = rows.filter((r) => r.agent === ref);
  if (owners(exact).length === 1) return exact;
  if (owners(exact).length > 1) {
    throw new Error(`"${ref}" is ambiguous across hosts: ${owners(exact).join(", ")}`);
  }
  const prefix = rows.filter((r) => r.agent.startsWith(ref));
  if (owners(prefix).length === 1) return prefix;
  if (owners(prefix).length > 1) {
    throw new Error(`"${ref}" is ambiguous across hosts: ${owners(prefix).join(", ")}`);
  }
  throw new Error(`no shared artifacts from "${ref}" — see \`am files\``);
}

function newestFirst(rows: FileRow[]): FileRow[] {
  return [...rows].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// Pick one artifact from an agent's rows: newest by default, `n` = nth newest
// (1-based, matching the numbering `am files` prints), else a name / unique
// substring.
export function resolveArtifact(rows: FileRow[], selector?: string): FileRow {
  const ordered = newestFirst(rows);
  if (!selector) return ordered[0]!;
  if (/^\d+$/.test(selector)) {
    const nth = ordered[Number(selector) - 1];
    if (!nth) throw new Error(`only ${ordered.length} artifact(s) shared — see \`am files\``);
    return nth;
  }
  const exact = ordered.filter((r) => r.name === selector);
  if (exact.length > 0) return exact[0]!;
  const partial = ordered.filter((r) => r.name.includes(selector));
  if (partial.length === 1) return partial[0]!;
  if (partial.length > 1) {
    throw new Error(`"${selector}" matches several artifacts: ${partial.map((r) => r.name).join(", ")}`);
  }
  throw new Error(`no artifact matches "${selector}" — see \`am files\``);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1_048_576) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1_048_576).toFixed(1)}MB`;
}

export async function filesCommand(agent: string | undefined, opts: { json: boolean; localOnly: boolean }): Promise<void> {
  let rows = await gatherRows(opts.localOnly);
  if (agent) rows = filterByAgent(rows, agent);
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log(agent ? `no shared artifacts from "${agent}"` : "no shared artifacts — agents publish them with `am share <file>`");
    return;
  }
  const byOwner = new Map<string, FileRow[]>();
  for (const row of rows) {
    const key = row.host ? `${row.host}:${row.agent}` : row.agent;
    byOwner.set(key, [...(byOwner.get(key) ?? []), row]);
  }
  for (const [owner, ownerRows] of byOwner) {
    console.log(owner);
    newestFirst(ownerRows).forEach((row, i) => {
      const msg = row.message ? `  ${row.message}` : "";
      console.log(`  ${i + 1}  ${row.name}  ${formatSize(row.size)}  ${relativeTime(row.at)}${msg}`);
    });
  }
  console.log("\nopen one with `am open <agent> [n|name]`");
}

// Freshness check for the pull cache: the manifest row carries the shared
// copy's size and mtime, and scp -p preserves both, so a matching cached file
// is the same bytes. Pure for testing.
export function cacheIsFresh(row: FileRow, cached: { size: number; mtimeMs: number } | null): boolean {
  return !!cached && cached.size === row.size && cached.mtimeMs >= row.mtimeMs;
}

export async function openCommand(agentRef: string, selector: string | undefined): Promise<void> {
  const rows = filterByAgent(await gatherRows(false), agentRef);
  const row = resolveArtifact(rows, selector);

  let path = row.path;
  if (row.host) {
    path = join(artifactsCacheDir(), row.host, row.agent, row.name);
    let cached: { size: number; mtimeMs: number } | null = null;
    try {
      const stat = statSync(path);
      cached = { size: stat.size, mtimeMs: stat.mtimeMs };
    } catch {
      // not cached yet
    }
    if (!cacheIsFresh(row, cached)) {
      mkdirSync(join(artifactsCacheDir(), row.host, row.agent), { recursive: true });
      const scp = await runAsync(["scp", "-p", "-q", `${row.host}:${shQuote(row.path)}`, path], { timeoutMs: 120_000 });
      if (scp.exitCode !== 0) throw new Error(`pull from ${row.host} failed: ${scp.stderr.trim()}`);
    }
  }

  const opener = chooseOpener({
    platform: process.platform,
    has: (binary) => !!Bun.which(binary),
    display: !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY),
  });
  if (opener) {
    Bun.spawn({ cmd: [opener, path], stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
    console.log(`opened ${path}`);
  } else {
    console.log(`artifact at: ${path}`);
  }
}
