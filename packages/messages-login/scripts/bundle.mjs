import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const outputPath = path.join(projectRoot, "dist", "messages-login-helper.zip");
const temporaryPath = `${outputPath}.tmp`;
const archiveRoot = "messages-login-helper";
const fixedDosDate = 33;
const utf8Flag = 0x0800;

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

async function collectFiles(relativeDirectory) {
  const directory = path.join(projectRoot, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

function localHeader(name, bytes, checksum) {
  const nameBytes = Buffer.from(name, "utf8");
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(utf8Flag, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(fixedDosDate, 12);
  header.writeUInt32LE(checksum, 14);
  header.writeUInt32LE(bytes.length, 18);
  header.writeUInt32LE(bytes.length, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, nameBytes]);
}

function centralHeader(name, bytes, checksum, localOffset) {
  const nameBytes = Buffer.from(name, "utf8");
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE((3 << 8) | 20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(utf8Flag, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(fixedDosDate, 14);
  header.writeUInt32LE(checksum, 16);
  header.writeUInt32LE(bytes.length, 20);
  header.writeUInt32LE(bytes.length, 24);
  header.writeUInt16LE(nameBytes.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  header.writeUInt32LE(localOffset, 42);
  return Buffer.concat([header, nameBytes]);
}

function endOfCentralDirectory(entryCount, centralSize, centralOffset) {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(0x06054b50, 0);
  record.writeUInt16LE(0, 4);
  record.writeUInt16LE(0, 6);
  record.writeUInt16LE(entryCount, 8);
  record.writeUInt16LE(entryCount, 10);
  record.writeUInt32LE(centralSize, 12);
  record.writeUInt32LE(centralOffset, 16);
  record.writeUInt16LE(0, 20);
  return record;
}

const relativeFiles = [
  "README.md",
  "biome.json",
  "package.json",
  "tsconfig.json",
  ...(await collectFiles("dist/src")),
  ...(await collectFiles("scripts")),
  ...(await collectFiles("src")),
  ...(await collectFiles("test")),
].sort();

const localParts = [];
const centralParts = [];
let localOffset = 0;
for (const relativePath of relativeFiles) {
  const bytes = await readFile(path.join(projectRoot, relativePath));
  const archiveName = path.posix.join(archiveRoot, relativePath);
  const checksum = crc32(bytes);
  const header = localHeader(archiveName, bytes, checksum);
  localParts.push(header, bytes);
  centralParts.push(centralHeader(archiveName, bytes, checksum, localOffset));
  localOffset += header.length + bytes.length;
}

const centralDirectory = Buffer.concat(centralParts);
const archive = Buffer.concat([
  ...localParts,
  centralDirectory,
  endOfCentralDirectory(
    relativeFiles.length,
    centralDirectory.length,
    localOffset,
  ),
]);

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(temporaryPath, archive, { mode: 0o600 });
await rm(outputPath, { force: true });
await rename(temporaryPath, outputPath);
process.stdout.write(`${outputPath}\n`);
