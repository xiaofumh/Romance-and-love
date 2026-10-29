import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = path.resolve(import.meta.dirname, '..');
const project = JSON.parse(await readFile(path.join(root, 'project.config.json'), 'utf8'));
assert(project.compileType === 'miniprogram', 'Project must use miniprogram compilation');
assert(typeof project.miniprogramRoot === 'string' && project.miniprogramRoot.length > 0,
  'Project must explicitly point miniprogramRoot at the compiled application');
const mini = path.resolve(root, project.miniprogramRoot);
assert(mini.startsWith(root + path.sep), 'Mini-program entry must stay inside the project directory');
const app = JSON.parse(await readFile(path.join(mini, 'app.json'), 'utf8'));
let total = 0;
async function scan(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const f = path.join(dir, entry.name);
    if (entry.isDirectory()) { await scan(f); continue; }
    total += (await stat(f)).size;
    const text = await readFile(f, 'utf8');
    if (f.endsWith('.json')) JSON.parse(text);
    assert(!text.includes('MODEL_API_KEY'), `Server configuration leaked into ${f}`);
    for (const key of ['INTERNAL_TEST_USER_IDS', 'ASSISTANT_RELEASE_STAGE', 'CONTENT_REVIEW_MODE', 'TENCENT_SECRET_KEY'])
      assert(!text.includes(key), `Server access/review configuration leaked into ${f}`);
    assert(!text.includes('你是沟通表达辅助工具'), `Server system prompt leaked into ${f}`);
    assert(!text.includes('你是小程序中的AI陪伴角色'), `Companion server prompt leaked into ${f}`);
    assert(!text.includes('你只做聊天截图转录'), `Screenshot system prompt leaked into ${f}`);
    if (f.endsWith('.wxml')) {
      const js = await readFile(f.replace(/\.wxml$/, '.js'), 'utf8');
      for (const m of text.matchAll(/wx:(?:if|elif|for)="([^"]*)"/g))
        assert(m[1].startsWith('{{') && m[1].endsWith('}}'), `Unbound WXML directive ${m[0]} in ${f}`);
      for (const m of text.matchAll(/\{\{([\s\S]*?)\}\}/g))
        assert(!m[1].includes('&amp;'), `HTML-escaped operator in WXML expression in ${f}`);
      for (const m of text.matchAll(/(?:bind|catch)(?:tap|input|change)="([A-Za-z]\w*)"/g))
        assert(js.includes(m[1]), `Missing handler ${m[1]} in ${f}`);
    }
  }
}
await scan(mini);
for (const page of app.pages) {
  for (const ext of ['js', 'json', 'wxml', 'wxss']) await stat(path.join(mini, `${page}.${ext}`));
}
assert(total < 2 * 1024 * 1024, 'Mini program main package exceeds the project 2MB target');
console.log(`Verified project entry, ${app.pages.length} pages, JSON, handler presence, frontend boundary; ${(total / 1024).toFixed(0)} KiB.`);
