// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Strict multipart/form-data reader for object uploads. The parser works on
// bytes so file parts stay binary, rejects duplicate or unknown parts, and
// treats the boundary as pure transport framing: the same file and metadata
// with a different boundary form the same logical request.
import { HttpError } from "../../platform/http/http.mjs";

const CRLF = Buffer.from("\r\n");
const maxParts = 8;
const maxHeaderBytes = 8192;

// RFC 2045 boundary token: up to 70 boundary characters, no trailing space.
const boundaryPattern = /^[0-9A-Za-z'()+_,\-./:=? ]{0,69}[0-9A-Za-z'()+_,\-./:=?]$/;

export function boundaryOf(contentType) {
  if (typeof contentType !== "string") return null;
  const [type, ...parameters] = contentType.split(";");
  if (type.trim().toLowerCase() !== "multipart/form-data" || !parameters.length) return null;
  let boundary;
  for (const parameter of parameters) {
    const equals = parameter.indexOf("=");
    if (equals === -1 || parameter.slice(0, equals).trim().toLowerCase() !== "boundary") continue;
    const value = parameter.slice(equals + 1).trim();
    boundary = value.startsWith('"') && value.endsWith('"') && value.length >= 2
      ? value.slice(1, -1) : value;
  }
  if (boundary === undefined || !boundaryPattern.test(boundary)) return null;
  return boundary;
}

function headerValue(headers, name) {
  const match = headers.find(header => header.name.toLowerCase() === name);
  return match?.value;
}

function unquote(value, where) {
  if (value.startsWith('"') !== value.endsWith('"') || value.length < (value.startsWith('"') ? 2 : 0)) {
    throw new HttpError(400, "invalid_multipart");
  }
  const raw = value.startsWith('"') ? value.slice(1, -1) : value;
  let decoded = "";
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index];
    if (character === "\\") {
      if (index + 1 >= raw.length) throw new HttpError(400, "invalid_multipart");
      decoded += raw[++index];
      continue;
    }
    if (character === '"') throw new HttpError(400, "invalid_multipart");
    if (/[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(character)) {
      throw new HttpError(400, "invalid_multipart");
    }
    decoded += character;
  }
  if (!decoded.length && where !== "filename") throw new HttpError(400, "invalid_multipart");
  return decoded;
}

function parseDisposition(line) {
  const [type, ...parameters] = line.split(";");
  if (type.trim().toLowerCase() !== "form-data") throw new HttpError(400, "invalid_multipart");
  const part = {};
  for (const parameter of parameters) {
    const equals = parameter.indexOf("=");
    if (equals === -1) throw new HttpError(400, "invalid_multipart");
    const name = parameter.slice(0, equals).trim().toLowerCase();
    const value = parameter.slice(equals + 1).trim();
    if (name === "name") part.name = unquote(value, "name");
    else if (name === "filename") part.filename = unquote(value, "filename");
    else if (name.endsWith("*")) throw new HttpError(400, "invalid_multipart");
  }
  if (part.name === undefined) throw new HttpError(400, "invalid_multipart");
  return part;
}

function parsePart(headerBlock, value) {
  if (headerBlock.length > maxHeaderBytes) throw new HttpError(400, "invalid_multipart");
  const headers = [];
  for (const line of headerBlock.toString("utf8").split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon === -1 || colon === 0) throw new HttpError(400, "invalid_multipart");
    headers.push({ name: line.slice(0, colon), value: line.slice(colon + 1).trim() });
  }
  const disposition = headerValue(headers, "content-disposition");
  if (disposition === undefined) throw new HttpError(400, "invalid_multipart");
  const part = { ...parseDisposition(disposition), value };
  const contentType = headerValue(headers, "content-type");
  if (contentType !== undefined) part.contentType = contentType.split(";", 1)[0].trim().toLowerCase();
  if (headers.length !== 1 + (contentType === undefined ? 0 : 1)) throw new HttpError(400, "invalid_multipart");
  return part;
}

export function parseMultipart(buffer, boundary) {
  const delimiter = Buffer.from(`--${boundary}`, "utf8");
  const closing = Buffer.concat([CRLF, delimiter]);
  // The first delimiter may sit at the very start or end a short preamble.
  let position = buffer.indexOf(delimiter);
  if (position === -1 || (position > 0 &&
      buffer.subarray(position - 2, position).toString("latin1") !== "\r\n")) {
    throw new HttpError(400, "invalid_multipart");
  }
  position += delimiter.length;
  const parts = [];
  for (;;) {
    if (buffer.subarray(position, position + 2).toString("latin1") === "--") break;
    if (buffer.subarray(position, position + 2).toString("latin1") !== "\r\n") {
      throw new HttpError(400, "invalid_multipart");
    }
    const headerEnd = buffer.indexOf("\r\n\r\n", position + 2);
    if (headerEnd === -1) throw new HttpError(400, "invalid_multipart");
    const closeIndex = buffer.indexOf(closing, headerEnd + 4);
    if (closeIndex === -1) throw new HttpError(400, "invalid_multipart");
    if (parts.length >= maxParts) throw new HttpError(400, "invalid_multipart");
    const part = parsePart(buffer.subarray(position + 2, headerEnd), buffer.subarray(headerEnd + 4, closeIndex));
    if (parts.some(existing => existing.name === part.name)) throw new HttpError(400, "invalid_multipart");
    parts.push(part);
    position = closeIndex + closing.length;
  }
  return parts;
}
