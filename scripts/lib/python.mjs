// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Python interpreter fallback for spawned contract checks, mirroring
// scripts/dev-stack.sh: hosts that only ship python3 still work and an
// explicit PYTHON always wins.
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export function preferPython3(env = process.env, hasCommand = commandOnPath) {
  if (env.PYTHON || hasCommand("python")) return env.PYTHON;
  env.PYTHON = "python3";
  return "python3";
}

export function commandOnPath(command, path = process.env.PATH) {
  for (const directory of path?.split(delimiter) ?? []) {
    const candidate = directory && join(directory, command);
    if (!candidate) continue;
    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, constants.X_OK);
        return true;
      }
    } catch { /* keep looking */ }
  }
  return false;
}
