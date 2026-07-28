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
    expect(getRole("../config")).toBeNull();
  });

  test("legacy concierge state infers the built-in role", () => {
    expect(roleForAgent({ name: "concierge" })).toBe("concierge");
    expect(roleForAgent({ name: "worker" })).toBeUndefined();
    expect(roleForAgent({ name: "worker", role: "reviewer" })).toBe("reviewer");
  });
});
