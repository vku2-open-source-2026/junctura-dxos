// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateVisibilityBody } from "../src/modules/capability/registry/capabilities.mjs";

const appId = "11111111-1111-4111-8111-111111111111";

test("visibility bodies accept the four levels with matching designations", () => {
  assert.deepEqual(validateVisibilityBody({ visibility: "hidden" }), { visibility: "hidden" });
  assert.deepEqual(validateVisibilityBody({ visibility: "tenant" }), { visibility: "tenant" });
  const units = validateVisibilityBody({ visibility: "units", units: ["unit-a", "unit-b"] });
  assert.deepEqual(units, { visibility: "units", units: ["unit-a", "unit-b"] });
  const apps = validateVisibilityBody({ visibility: "applications", applications: [appId] });
  assert.deepEqual(apps, { visibility: "applications", applications: [appId] });
});

test("visibility bodies reject malformed levels and designations", () => {
  for (const body of [
    {}, { visibility: "public" }, { visibility: "" }, { visibility: null }, [],
    { visibility: "hidden", units: ["unit-a"] }, { visibility: "tenant", applications: [appId] },
    { visibility: "units" }, { visibility: "applications" },
    { visibility: "units", units: [] }, { visibility: "units", units: ["unit-a", "unit-a"] },
    { visibility: "units", units: ["unit-a", "unit-b", "unit-c", ...Array.from({ length: 62 }, (_, index) => `unit-${index}`)] },
    { visibility: "units", units: ["unit-a"], extra: 1 },
    { visibility: "units", units: ["Unit-A"] }, { visibility: "units", units: ["unit_a"] },
    { visibility: "units", units: ["-unit"] }, { visibility: "units", units: ["unit a"] },
    { visibility: "units", units: [1] }, { visibility: "applications", applications: ["not-a-uuid"] },
    { visibility: "applications", applications: [] },
    { visibility: "applications", applications: [appId, appId] },
    { visibility: "applications", applications: ["11111111-1111-4111-8111-1111111111111"] },
  ]) {
    assert.throws(() => validateVisibilityBody(body), (error) => error.status === 400 &&
      error.message === "invalid_capability_visibility", JSON.stringify(body));
  }
  const overflow = Array.from({ length: 65 }, (_, index) => `unit-${index}`);
  assert.throws(() => validateVisibilityBody({ visibility: "units", units: overflow }), (error) => error.status === 400);
});
