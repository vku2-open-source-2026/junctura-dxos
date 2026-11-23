// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { main as provisionDirectory } from "../../scripts/provision-directory.mjs";

export function provisionFixtureDirectory(base, env = process.env) {
  return provisionDirectory(["--base", base], { env, log: () => {} });
}
