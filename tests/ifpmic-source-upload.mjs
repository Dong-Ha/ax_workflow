import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(root, 'workflow-artifacts/verification/V0');
const report = { kind: 'ifpmic-original-source-upload-verification', checks: [], verdict: 'fail' };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function check(name, action) {
  try {
    const details = await action();
    report.checks.push({ name, verdict: 'pass', details });
  } catch (error) {
    report.checks.push({ name, verdict: 'fail', finding: String(error?.message || error) });
  }
}

let manifest;
let members;
await check('source manifest and required original attachments are present', async () => {
  manifest = JSON.parse(await readFile(path.join(root, 'docs/ifpmic/source-manifest.json'), 'utf8'));
  const zip = await readFile(path.join(root, manifest.source_files.zip.path));
  const docx = await readFile(path.join(root, manifest.source_files.docx.path));
  assert.equal(hash(zip), manifest.source_files.zip.sha256, 'uploaded ZIP SHA-256');
  assert.equal(hash(docx), manifest.source_files.docx.sha256, 'uploaded DOCX SHA-256');
  members = readZipMembers(zip);
  assert.equal(members.size, 18, 'expected 18 archive entries (17 imported files plus source DOCX)');
  assert.ok(members.has(manifest.source_files.docx.zip_member), 'DOCX archive member exists');
  assert.deepEqual(docx, members.get(manifest.source_files.docx.zip_member), 'uploaded DOCX bytes equal archive member');
  assert.equal(hash(members.get(manifest.source_files.docx.zip_member)), manifest.source_files.docx.zip_member_sha256);
  assert.equal(Object.keys(manifest.imported_files).length, 17, '17 imported files recorded');
  return { zipSha256: hash(zip), docxSha256: hash(docx), archiveEntries: members.size, importedFiles: 17 };
});

if (manifest && members) {
  await check('all imported specification files match archive bytes and manifest hashes', async () => {
    for (const [relativePath, expectedHash] of Object.entries(manifest.imported_files)) {
      const diskBytes = await readFile(path.join(root, 'docs/ifpmic/design-v1', relativePath));
      const archivePath = `IFPMIC_AX_Design_v1/${relativePath}`;
      assert.ok(members.has(archivePath), `archive member exists: ${archivePath}`);
      assert.equal(hash(diskBytes), expectedHash, `disk SHA-256: ${relativePath}`);
      assert.deepEqual(diskBytes, members.get(archivePath), `disk bytes equal archive: ${relativePath}`);
    }
    return { comparedFiles: Object.keys(manifest.imported_files).length, byteMismatches: 0 };
  });
}

report.verdict = report.checks.length === 2 && report.checks.every(result => result.verdict === 'pass') ? 'pass' : 'fail';
report.evidence = 'workflow-artifacts/verification/V0/source-upload.json';
await mkdir(outputDir, { recursive: true });
await writeFile(path.join(outputDir, 'source-upload.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`IFPMIC source upload verification: ${report.checks.filter(result => result.verdict === 'pass').length}/${report.checks.length} checks passed (${report.verdict}).`);
if (report.verdict !== 'pass') process.exitCode = 1;

function readZipMembers(bytes) {
  const endSignature = 0x06054b50;
  let endOffset = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === endSignature) { endOffset = offset; break; }
  }
  assert.notEqual(endOffset, -1, 'ZIP end-of-central-directory record exists');
  const count = bytes.readUInt16LE(endOffset + 10);
  let cursor = bytes.readUInt32LE(endOffset + 16);
  const result = new Map();
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50, 'central directory entry signature');
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const filenameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + filenameLength).toString('utf8');
    assert.ok(method === 0 || method === 8, `supported ZIP compression method ${method}`);
    assert.equal(bytes.readUInt32LE(localOffset), 0x04034b50, 'local file header signature');
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    result.set(name, method === 0 ? compressed : inflateRawSync(compressed));
    cursor += 46 + filenameLength + extraLength + commentLength;
  }
  return result;
}
