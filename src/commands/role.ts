import { addRole, getRole, listRoles, removeRole } from "../roles";

export interface RoleCommandOptions {
  json?: boolean;
  instructions?: string;
  description?: string;
  force?: boolean;
}

export function roleCommand(action: string | undefined, name: string | undefined, opts: RoleCommandOptions = {}): void {
  if (!action || action === "list" || action === "ls") {
    const roles = listRoles();
    if (opts.json) console.log(JSON.stringify(roles, null, 2));
    else if (!roles.length) console.log("no roles defined");
    else for (const role of roles) {
      console.log(`${role.name}${role.builtIn ? "  [built-in]" : ""}${role.description ? `  · ${role.description}` : ""}`);
    }
    return;
  }

  if (!name) throw new Error(`am role ${action} requires a role name`);
  if (action === "show") {
    const role = getRole(name);
    if (!role) throw new Error(`unknown role "${name}"`);
    if (opts.json) console.log(JSON.stringify(role, null, 2));
    else {
      console.log(`${role.name}${role.builtIn ? "  [built-in]" : ""}`);
      if (role.description) console.log(role.description);
      console.log("");
      console.log(role.instructions);
    }
    return;
  }
  if (action === "add") {
    if (!opts.instructions) throw new Error("role instructions required: pass -m <text>, -m -, or --file <path>");
    const role = addRole({ name, description: opts.description, instructions: opts.instructions, force: opts.force });
    console.log(`${opts.force ? "saved" : "added"} role "${role.name}"`);
    return;
  }
  if (action === "rm" || action === "remove") {
    removeRole(name);
    console.log(`removed role "${name}"`);
    return;
  }
  throw new Error(`unknown role action "${action}" — use list, show, add, or rm`);
}
