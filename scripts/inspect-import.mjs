import { buildSync } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
const input = process.argv[2], output = process.argv[3];
if (!input) throw new Error('Usage: node scripts/inspect-import.mjs INPUT.txt [NEW_OUTPUT.txt]');
const bytes = readFileSync(input);
const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
if (text.includes('\uFFFD')) throw new Error('Expected UTF-8 TXT');
const code = buildSync({ entryPoints: [path.join(import.meta.dirname, '../src/shared/import-cleaning.ts')], bundle: true,
  write: false, format: 'cjs', platform: 'node' }).outputFiles[0].text;
const mod = { exports: {} }; vm.runInNewContext(code, { module: mod, exports: mod.exports });
const a = mod.exports.analyzeImport(text, '用户', '女朋友'), r = mod.exports.reviewImport(a);
mod.exports.validateImportReview(r);
// A mechanical local transformation only; never overwrites an existing file.
const cleaned = r.turns.map(v => `${v.speaker === 'user' ? '用户' : '女朋友'}：${v.text}`).join('\n');
if (output) {
  if (path.resolve(input) === path.resolve(output)) throw new Error('Must not overwrite source');
  writeFileSync(output, cleaned, { encoding: 'utf8', flag: 'wx' });
}
console.log(JSON.stringify({ format: a.format, inputBytes: bytes.length, inputCharacters: text.length,
  inputSha256: createHash('sha256').update(bytes).digest('hex'), turns: r.turns.length,
  userTurns: r.turns.filter(v => v.speaker === 'user').length, referenceTurns: r.turns.filter(v => v.speaker === 'reference').length,
  pending: r.pending, metadataLines: a.rows.filter(v => v.kind === 'metadata').length, blankLines: a.blankLines,
  normalizedBreaks: a.normalizedBreaks, englishMessages: r.english, duplicateMessages: r.duplicates,
  outputBytes: Buffer.byteLength(cleaned), savedOutput: Boolean(output), modelCalls: 0 }, null, 2));
