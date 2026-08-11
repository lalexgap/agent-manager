import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { expandHome, sharedDir } from "../paths";
import { localHostIdentity } from "../config";
import { parseJsonl, recordComms, resolveSender } from "../comms";
import { notify } from "../notify";

// `am share <file> [msg...]`: publish a file (screenshot, report) for the
// operator. The bytes are copied out of the agent's worktree — which am rm
// --clean or gc may delete — into ~/.agent-manager/shared/<owner>/files/,
// with a manifest line per share. The operator is notified and pulls it to
// their own machine with `am open <owner>` (see commands/files.ts).

// Artifacts are screenshots and rendered reports, not build outputs — cap the
// copy so a stray tarball doesn't fill ~/.agent-manager.
const MAX_SHARE_BYTES = 100_000_000;

export interface ArtifactEntry {
  at: string;
  name: string; // basename — the artifact's address for `am open`
  origPath: string;
  size: number;
  mtimeMs: number;
  message?: string;
  host: string; // informational (announcement text); scp uses the ssh alias
}

function manifestFile(owner: string): string {
  return join(sharedDir(owner), "manifest.jsonl");
}

// Where the shared copy of an artifact lives. Copies sit under files/ so the
// manifest can never collide with an artifact named "manifest.jsonl".
export function artifactCopyPath(owner: string, name: string): string {
  return join(sharedDir(owner), "files", name);
}

export function readManifest(owner: string): ArtifactEntry[] {
  const file = manifestFile(owner);
  if (!existsSync(file)) return [];
  return parseJsonl<ArtifactEntry>(readFileSync(file, "utf8"));
}

// One row per artifact name, newest wins (a re-share overwrites the copy and
// appends a manifest line). Entries whose copy was deleted out-of-band are
// dropped rather than offered for an open that would fail.
export function latestArtifacts(owner: string, entries: ArtifactEntry[]): ArtifactEntry[] {
  const byName = new Map<string, ArtifactEntry>();
  for (const entry of entries) byName.set(entry.name, entry);
  return [...byName.values()].filter((e) => existsSync(artifactCopyPath(owner, e.name)));
}

// The announcement the operator sees (comms ledger + notification). Pure for
// testing, like fileNote.
export function shareAnnouncement(name: string, message?: string): string {
  const msg = message?.trim();
  return msg ? `shared ${name} — ${msg}` : `shared ${name}`;
}

export async function shareCommand(filePath: string, message: string | undefined, opts: { from?: string } = {}): Promise<void> {
  const src = resolve(expandHome(filePath));
  if (!existsSync(src) || !statSync(src).isFile()) {
    throw new Error(`not a file: ${src}`);
  }
  const stat = statSync(src);
  if (stat.size > MAX_SHARE_BYTES) {
    throw new Error(`too large to share (${Math.round(stat.size / 1_000_000)} MB) — scp it manually`);
  }

  // Owner = the managed agent running this (AGENTMGR_AGENT), else the
  // operator's own bucket. "operator" is never an agent name (validateName
  // would allow it, but gc exempts the bucket explicitly).
  const owner = resolveSender(opts.from) ?? "operator";
  const name = basename(src);
  const dest = artifactCopyPath(owner, name);
  mkdirSync(join(sharedDir(owner), "files"), { recursive: true });
  copyFileSync(src, dest);
  appendFileSync(
    manifestFile(owner),
    JSON.stringify({
      at: new Date().toISOString(),
      name,
      origPath: src,
      size: stat.size,
      mtimeMs: statSync(dest).mtimeMs,
      message: message?.trim() || undefined,
      host: localHostIdentity(),
    } satisfies ArtifactEntry) + "\n",
  );

  const announcement = shareAnnouncement(name, message);
  if (owner !== "operator") {
    // Recorded directly, not through attribute(): a share is operator-facing,
    // not peer traffic, so the rate limiter has no say.
    recordComms({ at: new Date().toISOString(), from: owner, to: "operator", kind: "share", body: announcement });
  }
  notify(`am: ${owner}`, `${announcement} · am open ${owner}`);
  console.log(`shared ${name} → ${dest}`);
  console.log(`the operator can open it from their machine with \`am open ${owner}\``);
}
