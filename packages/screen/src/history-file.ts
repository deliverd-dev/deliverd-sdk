/**
 * Opens a ChatGPT or Claude export in Node: the .zip as downloaded, the
 * folder it unpacks to, or its `conversations.json`. The zip is read here
 * with Node's own zlib, so there is nothing to install.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { parseExport, type HistoryConversation } from "./history.js";

/** The bytes of one file in a zip, by its name at any depth; null when it isn't there. */
export function fileInZip(zip: Buffer, name: string): Buffer | null {
  // The end of central directory record: the last "PK\x05\x06" in the file.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65_535); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("This is not a zip file.");
  const entries = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries; n++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error("The zip's directory is damaged.");
    const method = zip.readUInt16LE(at + 10);
    const compressed = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const entryName = zip.toString("utf8", at + 46, at + 46 + nameLength);
    if (entryName === name || entryName.endsWith("/" + name)) {
      const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(dataAt, dataAt + compressed);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      throw new Error(`${name} is compressed in a way this can't read (method ${method}). Unzip it and pass conversations.json.`);
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

/** The conversations in an export file or folder. */
export function readExport(path: string): HistoryConversation[] {
  let raw: string;
  if (statSync(path).isDirectory()) raw = readFileSync(join(path, "conversations.json"), "utf8");
  else if (path.toLowerCase().endsWith(".zip")) {
    const file = fileInZip(readFileSync(path), "conversations.json");
    if (!file) throw new Error("There is no conversations.json in this zip. Is it a ChatGPT or Claude data export?");
    raw = file.toString("utf8");
  } else raw = readFileSync(path, "utf8");
  const conversations = parseExport(JSON.parse(raw));
  if (conversations.length === 0) throw new Error("No ChatGPT or Claude conversations were found in this file.");
  return conversations;
}
