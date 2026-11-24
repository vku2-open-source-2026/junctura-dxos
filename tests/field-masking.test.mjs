// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFieldMaskingPolicy } from "../src/modules/data/records.mjs";

test("field masking validates exact rules and permits an empty policy", () => {
  const shareId = "11111111-1111-4111-8111-111111111111";
  const policy = { fields: {
    nationalId: { mask: "full", owner: true },
    phone: { mask: "last4", roles: ["manager", "core-writer"], shareIds: [shareId] },
  } };
  assert.deepEqual(parseFieldMaskingPolicy(policy), policy);
  assert.deepEqual(parseFieldMaskingPolicy({ fields: {} }), { fields: {} });
  for (const body of [
    null, [], {}, { fields: [] }, { fields: {}, role: "manager" },
    { fields: { "details.phone": { mask: "full" } } },
    { fields: { phone: "last4" } },
    { fields: { phone: {} } },
    { fields: { phone: { mask: "last8" } } },
    { fields: { phone: { mask: "full", owner: "true" } } },
    { fields: { phone: { mask: "full", roles: ["unknown"] } } },
    { fields: { phone: { mask: "full", roles: ["manager", "manager"] } } },
    { fields: { phone: { mask: "full", shareIds: [shareId, shareId] } } },
    { fields: { phone: { mask: "full", shareIds: ["not-a-uuid"] } } },
    { fields: { phone: { mask: "full", allowEverybody: true } } },
    { fields: Object.fromEntries(Array.from({ length: 101 }, (_, index) => [
      `field${index}`, { mask: "full" },
    ])) },
  ]) assert.throws(() => parseFieldMaskingPolicy(body), { status: 400, message: "invalid_request" });
});
