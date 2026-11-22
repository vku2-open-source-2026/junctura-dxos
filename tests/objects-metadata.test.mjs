// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { boundaryOf, parseMultipart } from "../src/modules/objects/multipart.mjs";
import {
  decodeMetadataCursor,
  encodeMetadataCursor,
  metadataEnvelope,
  parseMetadataQuery,
  uploadDigest,
} from "../src/modules/objects/objects.mjs";

function envelope(boundary, parts, { close = true, preamble = "" } = {}) {
  const sections = parts.map(([headers, body]) => {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
    return Buffer.concat([Buffer.from(`--${boundary}\r\n${headers}\r\n\r\n`, "utf8"), bytes, Buffer.from("\r\n", "utf8")]);
  });
  return Buffer.concat([
    Buffer.from(preamble, "utf8"),
    ...sections,
    close ? Buffer.from(`--${boundary}--\r\n`, "utf8") : Buffer.alloc(0),
  ]);
}

const fileHeaders = 'Content-Disposition: form-data; name="file"; filename="a.bin"\r\nContent-Type: application/octet-stream';
const refHeaders = 'Content-Disposition: form-data; name="recordRef"\r\nContent-Type: application/json';
const tagHeaders = 'Content-Disposition: form-data; name="tags"\r\nContent-Type: application/json';

test("multipart parses binary parts exactly and ignores the boundary value", () => {
  const bytes = Buffer.from([0, 13, 10, 45, 45, 82, 69, 70, 13, 10, 255, 254, 13, 10]);
  const body = envelope("BOUND", [[fileHeaders, bytes],
    [refHeaders, '{"collection":"entries","id":"44444444-4444-4444-8444-444444444444"}'],
    [tagHeaders, '["source","other"]']]);
  assert.equal(boundaryOf('multipart/form-data; boundary=BOUND'), "BOUND");
  const parts = parseMultipart(body, "BOUND");
  assert.deepEqual(parts.map(part => part.name), ["file", "recordRef", "tags"]);
  assert.deepEqual(parts[0].value, bytes);
  assert.deepEqual(JSON.parse(parts[1].value.toString()), { collection: "entries", id: "44444444-4444-4444-8444-444444444444" });
  assert.deepEqual(JSON.parse(parts[2].value.toString()), ["source", "other"]);
  assert.equal(parts[0].contentType, "application/octet-stream");
  assert.equal(parts[0].filename, "a.bin");
});

test("multipart framing with a different boundary yields the same logical request", () => {
  const first = envelope("one", [[fileHeaders, Buffer.from("payload")], [tagHeaders, '["a"]']]);
  const second = envelope("two-with.dots", [[fileHeaders, Buffer.from("payload")], [tagHeaders, '["a"]']]);
  const left = parseMultipart(first, "one");
  const right = parseMultipart(second, "two-with.dots");
  assert.deepEqual(left.map(part => [part.name, part.value, part.contentType]),
    right.map(part => [part.name, part.value, part.contentType]));
  assert.deepEqual(
    createHash("sha256").update(left[0].value).digest(),
    createHash("sha256").update(right[0].value).digest());
});

test("multipart rejects duplicate, unnamed and misdeclared parts", () => {
  const reference = envelope("B", [[fileHeaders, Buffer.from("x")], [tagHeaders, "[]"]]);
  assert.equal(parseMultipart(reference, "B").length, 2);
  assert.throws(() => parseMultipart(envelope("B", [[fileHeaders, Buffer.from("x")], [fileHeaders, Buffer.from("y")]]), "B"));
  assert.throws(() => parseMultipart(envelope("B", [["Content-Disposition: form-data", "v"]]), "B"));
  assert.throws(() => parseMultipart(envelope("B", [['Content-Disposition: form-data; name="file"',
    "x"], ['Content-Disposition: form-data; name*="bad"', "v"]]), "B"));
});

test("the object envelope policy requires one binary file and only metadata parts", () => {
  const file = { name: "file", filename: "a.bin", contentType: "application/octet-stream", value: Buffer.from("x") };
  const ref = { name: "recordRef", contentType: "application/json", value: Buffer.from("null") };
  const tags = { name: "tags", contentType: "application/json", value: Buffer.from('["a"]') };
  const envelopeParts = metadataEnvelope([file, ref, tags]);
  assert.deepEqual(envelopeParts.file, Buffer.from("x"));
  assert.deepEqual(envelopeParts.recordRef, { present: true, value: null });
  assert.deepEqual(envelopeParts.tags, { present: true, value: ["a"] });
  assert.deepEqual(metadataEnvelope([file]).recordRef, { present: false, value: undefined });
  assert.throws(() => metadataEnvelope([tags, ref])); // missing file
  assert.throws(() => metadataEnvelope([file, ref, ref])); // duplicate part
  assert.throws(() => metadataEnvelope([file, { ...ref, name: "extra" }])); // unknown part
  assert.throws(() => metadataEnvelope([{ ...file, contentType: "text/plain" }, ref]));
  assert.throws(() => metadataEnvelope([{ ...file, contentType: undefined }, ref]));
});

test("multipart rejects broken framing and boundaries", () => {
  assert.throws(() => parseMultipart(envelope("B", [[fileHeaders, Buffer.from("x")]], { close: false }), "B"));
  assert.throws(() => parseMultipart(Buffer.from("garbage"), "B"));
  assert.throws(() => parseMultipart(envelope("B", [[fileHeaders, Buffer.from("x")]]), "C"));
  assert.throws(() => parseMultipart(envelope("B", [["Content-Length: 3\r\nContent-Disposition: form-data; name=file", "x"]]), "B"));
  assert.equal(boundaryOf("application/octet-stream"), null);
  assert.equal(boundaryOf("multipart/form-data"), null);
  assert.equal(boundaryOf("multipart/form-data; boundary="), null);
  assert.equal(boundaryOf('multipart/form-data; boundary="q"'), "q");
  // A preamble before the first delimiter is tolerated, a missing one is not invented.
  assert.doesNotThrow(() => parseMultipart(envelope("B", [[fileHeaders, Buffer.from("x")]], { preamble: "preamble\r\n" }), "B"));
});

test("metadata parts must be JSON and only file bytes may be binary", () => {
  const body = envelope("B", [[fileHeaders, Buffer.from("x")], [refHeaders, "not json"]]);
  const parts = parseMultipart(body, "B");
  assert.throws(() => JSON.parse(parts[1].value.toString()));
  const textPart = envelope("B", [[fileHeaders, Buffer.from("x")],
    ['Content-Disposition: form-data; name="recordRef"\r\nContent-Type: text/plain', "null"]]);
  assert.equal(parseMultipart(textPart, "B")[1].contentType, "text/plain");
});

test("the upload digest separates an omitted part from null and from an empty array", () => {
  const bytes = Buffer.from("same-bytes");
  const omitted = uploadDigest(bytes, { present: false }, { present: false });
  const cleared = uploadDigest(bytes, { present: true, value: null }, { present: true, value: [] });
  const kept = uploadDigest(bytes, { present: true, value: { collection: "entries", id: "44444444-4444-4444-8444-444444444444" } },
    { present: true, value: ["a"] });
  assert.notEqual(omitted, cleared);
  assert.notEqual(omitted, kept);
  assert.notEqual(cleared, kept);
  // Identical logical requests share one digest regardless of the boundary.
  assert.equal(uploadDigest(bytes, { present: true, value: null }, { present: true, value: [] }),
    uploadDigest(bytes, { present: true, value: null }, { present: true, value: [] }));
  // The digest covers the file bytes.
  assert.notEqual(omitted, uploadDigest(Buffer.from("other-bytes"), { present: false }, { present: false }));
});

test("upload digest validates metadata shape", () => {
  const bytes = Buffer.from("x");
  assert.throws(() => uploadDigest(bytes, { present: true, value: { collection: "entries" } }, { present: false }));
  assert.throws(() => uploadDigest(bytes, { present: true, value: { collection: "Bad", id: "44444444-4444-4444-8444-444444444444" } }, { present: false }));
  assert.throws(() => uploadDigest(bytes, { present: true, value: { collection: "entries", id: "nope" } }, { present: false }));
  assert.throws(() => uploadDigest(bytes, { present: false }, { present: true, value: ["Bad"] }));
  assert.throws(() => uploadDigest(bytes, { present: false }, { present: true, value: ["a", "a"] }));
  assert.throws(() => uploadDigest(bytes, { present: false }, { present: true, value: Array.from({ length: 21 }, () => "a") }));
  assert.doesNotThrow(() => uploadDigest(bytes, { present: false },
    { present: true, value: Array.from({ length: 20 }, (_, index) => `t${index}`) }));
});

test("metadata listing accepts only the closed recordRef, tag and paging query", () => {
  const parse = query => parseMetadataQuery(new URL(`http://core/v2/objects${query}`));
  const id = "44444444-4444-4444-8444-444444444444";
  assert.deepEqual(parse(""), { limit: 50, recordRef: null, tag: undefined, cursor: undefined });
  assert.deepEqual(parse("?limit=25"), { limit: 25, recordRef: null, tag: undefined, cursor: undefined });
  assert.deepEqual(parse(`?recordRef[collection]=entries&recordRef[id]=${id}`),
    { limit: 50, recordRef: { collection: "entries", id }, tag: undefined, cursor: undefined });
  assert.deepEqual(parse("?tag=source"), { limit: 50, recordRef: null, tag: "source", cursor: undefined });
  for (const bad of ["?unknown=1", "?limit=0", "?limit=101", "?limit=abc", "?limit=1&limit=1",
    `?recordRef[collection]=entries`, `?recordRef[id]=${id}`, `?recordRef[collection]=Bad&recordRef[id]=${id}`,
    `?recordRef[collection]=entries&recordRef[id]=nope`, "?tag=Bad"]) {
    assert.throws(() => parse(bad), undefined, `expected rejection of ${bad}`);
  }
});

test("metadata cursors bind to the caller and filters", () => {
  const id = "44444444-4444-4444-8444-444444444444";
  const filters = { appId: "22222222-2222-4222-8222-222222222222", recordRef: null, tag: undefined };
  const cursor = encodeMetadataCursor(filters, id);
  assert.equal(decodeMetadataCursor(cursor, filters), id);
  assert.throws(() => decodeMetadataCursor(cursor, { ...filters, tag: "other" }));
  assert.throws(() => decodeMetadataCursor(cursor, { ...filters, recordRef: { collection: "entries", id } }));
  assert.throws(() => decodeMetadataCursor("broken", filters));
  assert.throws(() => decodeMetadataCursor(Buffer.from('{"a":"nope","f":"x"}').toString("base64url"), filters));
  assert.throws(() => decodeMetadataCursor(Buffer.from('{"a":"x"}').toString("base64url"), filters));
});
