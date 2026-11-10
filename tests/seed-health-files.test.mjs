// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { plannedFileTree, seedNamedFiles } from "../scripts/lib/seed-health-files.mjs";
import { generateHealthDataset } from "../scripts/lib/seed-health-data.mjs";

async function fakeFiler() {
  const files = new Map();
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    const path = decodeURIComponent(new URL(request.url, "http://filer").pathname);
    if (request.method === "HEAD") {
      response.writeHead(files.has(path) ? 200 : 404);
      return response.end();
    }
    if (request.method === "PUT") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      files.set(path, Buffer.concat(chunks).toString("utf8"));
      response.writeHead(201);
      return response.end("{}");
    }
    response.writeHead(405);
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    files,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("planned file trees use deterministic Vietnamese folders and masked-safe names", () => {
  const dataset = generateHealthDataset();
  const tree = plannedFileTree("so-suc-khoe", dataset);
  assert.ok(tree.length >= 8);
  assert.ok(tree.some((item) => item.folder.startsWith("ho-so/chuyen-tuyen/")));
  assert.ok(tree.some((item) => item.folder.startsWith("ho-so/don-thuoc/")));
  assert.ok(tree.some((item) => item.folder.startsWith("giay-to/ket-qua-xet-nghiem/")));
  assert.ok(tree.some((item) => item.name.startsWith("giấy chuyển tuyến")));
  assert.ok(tree.some((item) => item.name.startsWith("đơn thuốc")));
  assert.ok(tree.some((item) => item.name.startsWith("kết quả xét nghiệm")));
  assert.equal(new Set(tree.map((item) => item.objectId)).size, tree.length);
});

test("named files are uploaded through the object client and the filer tree is idempotent", async () => {
  const filer = await fakeFiler();
  const uploaded = new Map();
  const client = {
    async putObject(id, bytes) {
      const created = !uploaded.has(id);
      uploaded.set(id, bytes);
      return { created };
    },
  };
  const dataset = generateHealthDataset();
  const apps = { "so-suc-khoe": { appId: "07e23185-ea1e-43d6-bfa1-81d063930577" } };
  const args = { clients: { "so-suc-khoe": client }, tenant: "tenant-a", apps, dataset, objectsUrl: filer.url };
  try {
    const first = await seedNamedFiles(args);
    assert.ok(first.filesCreated > 0);
    assert.equal(first.filesExisting, 0);
    assert.equal(filer.files.size, plannedFileTree("so-suc-khoe", dataset).length);
    const second = await seedNamedFiles(args);
    assert.equal(second.filesCreated, 0);
    assert.equal(second.filesExisting, first.filesCreated);
    assert.equal(filer.files.size, plannedFileTree("so-suc-khoe", dataset).length);
    const key = [...filer.files.keys()].find((path) => decodeURIComponent(path).includes("giấy chuyển tuyến"));
    assert.ok(key);
    assert.ok(!key.includes("0120b996-711d-526b-a836-69fee754b79e"));
  } finally {
    await filer.close();
  }
});
