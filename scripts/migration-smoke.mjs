import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(process.argv[2] ?? process.cwd());
const require = createRequire(path.join(root, 'package.json'));
const automator = require('miniprogram-automator');
const project = JSON.parse(await readFile(path.join(root, 'project.config.json'), 'utf8'));
const evidence = path.join(root, '.local/migration-acceptance');
await mkdir(evidence, { recursive: true });
let mini;
const exceptions = [];
let timer;
try {
  const result = await Promise.race([(async () => {
    mini = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
    mini.on('exception', error => exceptions.push(String(error)));
    const page = await mini.reLaunch('/pages/compose/index');
    assert(page, 'No application page available');
    await page.waitFor(300);
    const bootstrap = await page.data('bootstrap');
    assert(bootstrap?.mode === 'demo', 'Migration must keep local demo mode');
    assert.equal(await page.data('error'), '');
    await (await page.$('.sample[data-key="work"]')).tap();
    if (!(await page.data('accepted'))) await (await page.$('.consent-check')).tap();
    await page.waitFor(100);
    await (await page.$('button.primary')).tap();
    await page.waitFor(1000);
    const generation = await page.data('result');
    assert.equal(generation?.status, 'SUCCEEDED', await page.data('error'));
    assert.equal(generation.replies?.length, 3);
    const offset = await (await page.$('.results')).offset();
    await mini.pageScrollTo(Math.max(0, offset.top - 12));
    await page.waitFor(150);
    await mini.screenshot({ path: path.join(evidence, 'results.png') });
    return { ok: true, project: root, appid: project.appid, page: page.path,
      mode: bootstrap.mode, replies: generation.replies.length, exceptions,
      cloudDeployed: false, published: false };
  })(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('AUTOMATION_TIMEOUT')), 20000); })]);
  await writeFile(path.join(evidence, 'report.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const report = { ok: false, project: root, appid: project.appid,
    error: error instanceof Error ? error.message : 'UNKNOWN', exceptions,
    cloudDeployed: false, published: false };
  await writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await mini?.disconnect();
}
