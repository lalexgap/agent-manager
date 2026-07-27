import { homedir } from "node:os";
import { readAgent, recordAttached, type AgentState } from "../state";
import { attachOrSwitch, hasSession } from "../tmux";
import { CONCIERGE_NAME } from "../providers";
import { newCommand, type NewOptions } from "./new";
import { reviveAgent } from "./resume";
import { sendCommand } from "./send";

// The concierge is a Claude session whose whole value is the fleet-management
// system prompt (selected by name in providers.ts). Claude is required — with
// codex it would just be a chat with no fleet primer — so provider is pinned
// rather than following config.defaultProvider; newCommand fails loudly when
// claude isn't installed. It manages agents, not code: home dir, no worktree.
export function conciergeNewOptions(question?: string): NewOptions {
  return {
    name: CONCIERGE_NAME,
    concierge: true,
    provider: "claude",
    dir: homedir(),
    inPlace: true,
    message: question ?? "Introduce yourself in a sentence, then give a fleet status report.",
    jump: false,
    quiet: true,
  };
}

// Singleton lifecycle, shared by the CLI and the hub's `c` key: exactly one
// local concierge, created on first use, revived when its session is gone.
// A question rides the create/revive message queue; a live concierge gets it
// as a normal queued send.
export async function ensureConcierge(question?: string): Promise<AgentState> {
  const existing = readAgent(CONCIERGE_NAME);
  if (!existing) {
    await newCommand(conciergeNewOptions(question));
    return readAgent(CONCIERGE_NAME)!;
  }
  if (!hasSession(existing.tmuxSession)) {
    await reviveAgent(existing, question ? { message: question } : {});
  } else if (question) {
    await sendCommand(CONCIERGE_NAME, question, { now: false });
  }
  return existing;
}

export async function conciergeCommand(opts: { question?: string; jump?: boolean }): Promise<void> {
  const agent = await ensureConcierge(opts.question);
  const jump = opts.jump ?? (!!process.stdout.isTTY && !!process.stdin.isTTY);
  if (jump) {
    recordAttached(CONCIERGE_NAME);
    attachOrSwitch(agent.tmuxSession);
    return;
  }
  console.log(`concierge ready${opts.question ? " — your question is queued" : ""}`);
  console.log(`  jump to it:  am j ${CONCIERGE_NAME}`);
}
