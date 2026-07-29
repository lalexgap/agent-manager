import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONCIERGE_ROLE,
  addRole,
  getRole,
  listRoles,
  removeRole,
  requireRole,
  roleForAgent,
} from "../src/roles";
import { roleOptionsForHost } from "../src/commands/ui";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "am-test-"));
  process.env.AGENTMGR_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.AGENTMGR_HOME;
});

describe("role registry", () => {
  test("includes the protected concierge role", () => {
    const concierge = requireRole(CONCIERGE_ROLE);
    expect(concierge.builtIn).toBe(true);
    expect(concierge.instructions).toContain("am role add");
    expect(() => removeRole(CONCIERGE_ROLE)).toThrow(/built in/);
    expect(() => addRole({ name: CONCIERGE_ROLE, instructions: "replace it" })).toThrow(/built in/);
  });

  test("adds, lists, reads, replaces, and removes a custom role", () => {
    addRole({ name: "security-reviewer", description: "Reviews auth", instructions: "Inspect trust boundaries." });
    expect(getRole("security-reviewer")).toMatchObject({
      name: "security-reviewer",
      description: "Reviews auth",
      instructions: "Inspect trust boundaries.",
    });
    expect(listRoles().map((role) => role.name)).toEqual(["concierge", "security-reviewer"]);
    expect(() => addRole({ name: "security-reviewer", instructions: "new" })).toThrow(/--force/);
    addRole({ name: "security-reviewer", instructions: "New instructions", force: true });
    expect(requireRole("security-reviewer").instructions).toBe("New instructions");
    removeRole("security-reviewer");
    expect(getRole("security-reviewer")).toBeNull();
  });

  test("rejects unsafe names and empty instructions", () => {
    expect(() => addRole({ name: "../escape", instructions: "no" })).toThrow(/role name/);
    expect(() => addRole({ name: "Reviewer", instructions: "no" })).toThrow(/role name/);
    expect(() => addRole({ name: "reviewer", instructions: "  " })).toThrow(/empty/);
    expect(() => addRole({ name: "none", instructions: "no" })).toThrow(/reserved/);
    expect(() => addRole({ name: "unassigned", instructions: "no" })).toThrow(/reserved/);
    expect(getRole("../config")).toBeNull();
  });

  test("valid names inherited from Object.prototype remain custom roles", () => {
    addRole({ name: "constructor", instructions: "Construct a review." });
    expect(requireRole("constructor")).toMatchObject({ name: "constructor", instructions: "Construct a review." });
    removeRole("constructor");
  });

  test("loads create-form role options asynchronously from the selected remote host", async () => {
    let calledWith: string[] = [];
    let resolveRun!: (value: { exitCode: number; stdout: string; stderr: string }) => void;
    const pending = new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
      resolveRun = resolve;
    });
    const options = roleOptionsForHost("server", async (_host, args) => {
      calledWith = args;
      return pending;
    });
    expect(calledWith).toEqual(["role", "list", "--json"]);
    expect(options).toBeInstanceOf(Promise);
    resolveRun({
      exitCode: 0,
      stdout: JSON.stringify([
        { name: "concierge", builtIn: true, instructions: "built in" },
        { name: "remote-reviewer", description: "Remote only", instructions: "review" },
      ]),
      stderr: "",
    });
    expect(await options).toEqual([{ name: "remote-reviewer", description: "Remote only" }]);
  });

  test("legacy concierge state infers the built-in role", () => {
    expect(roleForAgent({ name: "concierge" })).toBe("concierge");
    expect(roleForAgent({ name: "worker" })).toBeUndefined();
    expect(roleForAgent({ name: "worker", role: "reviewer" })).toBe("reviewer");
  });
});
