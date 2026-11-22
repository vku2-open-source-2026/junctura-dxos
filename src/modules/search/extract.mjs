// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Text extraction for search indexing without external dependencies. Object
// bytes are opaque octet streams, so the format is sniffed: JSON, tabular text,
// plain or Markdown text and PDF files with a text layer. Binary content and
// PDFs without extractable text yield no document rather than a guess.
import { inflateSync } from "node:zlib";

const maxTextLength = 65_536;
const maxStreams = 64;

function printable(value) {
  if (!value.length) return null;
  let controls = 0;
  for (const character of value) {
    const code = character.codePointAt(0);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) controls++;
  }
  return controls / value.length < 0.05 ? value : null;
}

function pdfStrings(decoded) {
  const chunks = [];
  // Show-text operators inside text blocks: (text) Tj, [(a) n (b)] TJ, and the
  // quote forms that also break the line. Everything else is ignored.
  const tokens = decoded.matchAll(/\((?:\\.|[^\\()])*\)\s*(?:Tj|')|\[(?:[^\]\\]|\\.)*\]\s*TJ|T\*|Td|TD|ET/gs);
  for (const token of tokens) {
    const literal = token[0];
    if (literal === "T*" || literal === "Td" || literal === "TD" || literal === "ET") {
      chunks.push("\n");
      continue;
    }
    for (const raw of literal.matchAll(/\((?:\\.|[^\\()])*\)/gs)) {
      const body = raw[0].slice(1, -1);
      let text = "";
      for (let index = 0; index < body.length; index++) {
        const character = body[index];
        if (character === "\\" && index + 1 < body.length) {
          const next = body[++index];
          if (next >= "0" && next <= "7") {
            let octal = next;
            while (octal.length < 3 && index + 1 < body.length && body[index + 1] >= "0" && body[index + 1] <= "7") {
              octal += body[++index];
            }
            text += String.fromCharCode(parseInt(octal, 8));
            continue;
          }
          text += { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" }[next] ?? next;
          continue;
        }
        text += character;
      }
      chunks.push(text);
    }
  }
  return chunks.join("");
}

function pdfText(bytes) {
  const latin = bytes.toString("latin1");
  const chunks = [];
  let start = 0;
  for (let count = 0; count < maxStreams; count++) {
    const open = latin.indexOf("stream", start);
    if (open === -1) break;
    const header = latin.slice(Math.max(0, open - 400), open);
    let bodyStart = open + "stream".length;
    if (latin[bodyStart] === "\r") bodyStart++;
    if (latin[bodyStart] === "\n") bodyStart++;
    const close = latin.indexOf("endstream", bodyStart);
    if (close === -1) break;
    start = close + "endstream".length;
    const stream = bytes.subarray(bodyStart, close);
    if (/FlateDecode/.test(header)) {
      try {
        chunks.push(pdfStrings(inflateSync(stream).toString("latin1")));
      } catch { /* A damaged or encrypted stream contributes no text. */ }
    } else {
      chunks.push(pdfStrings(stream.toString("latin1")));
    }
  }
  const text = chunks.join("").replace(/[ \t]+\n/g, "\n").trim();
  return text.length ? text : null;
}

function jsonStrings(value, depth = 0) {
  if (depth > 32 || value === null) return [];
  if (typeof value === "string") return value.isWellFormed() ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(item => jsonStrings(item, depth + 1));
  if (typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => [key, ...jsonStrings(item, depth + 1)]);
  }
  if (typeof value === "number" && Number.isFinite(value)) return [String(value)];
  return [];
}

function tabular(text) {
  return text.split(/\r?\n/).map(line => line.replace(/["'`]/g, " ").replace(/[,;\t|]+/g, " ").trim())
    .join("\n").replace(/[ \t]{2,}/g, " ").trim();
}

function markdown(text) {
  return text.replace(/^#{1,6}\s+/gm, "").replace(/(\*\*|\*|`|~~)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/^\s*[-+>]+\s?/gm, "").trim();
}

// Returns the extracted document text, or null when the bytes carry no
// searchable text layer. A leading UTF-8 byte-order mark is tolerated.
export function extractText(bytes) {
  if (!bytes?.length) return null;
  const head = bytes.subarray(0, 5).toString("latin1");
  if (head === "%PDF-") return pdfText(bytes);
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return null; }
  if (text.includes("\u0000")) return null;
  const trimmed = text.trim();
  if (!trimmed.length) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      return printable(jsonStrings(parsed).join("\n")?.slice(0, maxTextLength)) ?? null;
    } catch { /* Not JSON after all; fall through to the text readers. */ }
  }
  const plain = printable(trimmed);
  if (plain === null) return null;
  if (/^###? |\n## |^\s*[-*+] |\]\(|\*\*/.test(trimmed.slice(0, 512))) {
    return markdown(plain).slice(0, maxTextLength) || null;
  }
  if (/[,;\t]/.test(trimmed.split(/\r?\n/, 2)[0]) && trimmed.split(/\r?\n/).length > 1) {
    return tabular(plain).slice(0, maxTextLength) || null;
  }
  return plain.slice(0, maxTextLength);
}
