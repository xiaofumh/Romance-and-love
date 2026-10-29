import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { transformSync } from 'esbuild';

// One real wx.cloud.callFunction bootstrap request. Never generates, accepts consent,
// changes storage/mode, supplies OPENID, mocks wx, or prints user state/secrets.
const root = path.resolve(process.argv[2] ?? process.cwd());
const source = await readFile(path.join(root, 'src/miniprogram/config.ts'), 'utf8');
const compiled = transformSync(source, { loader: 'ts', format: 'esm' }).code;
const { config } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const project = JSON.parse(await readFile(path.join(root, 'project.config.json'), 'utf8'));
if (project.appid !== 'wxcf99a03236cc4eca' || config.cloudEnvId !== 'g030411-d6gbju74084607dd0' ||
    config.apiFunction !== 'assistantApiV2') throw new Error('UNEXPECTED_DEPLOYMENT_TARGET');
const require = createRequire(path.join(root, 'package.json'));
const automator = require('miniprogram-automator');
const report = { timestamp: new Date().toISOString(), env: config.cloudEnvId, function: config.apiFunction,
  action: 'session.bootstrap', generationInvoked: false, mocked: false, evidence: undefined, result: undefined };
const directory = path.join(root, '.local/cloud-bootstrap', report.timestamp.replace(/[:.]/g, '-'));
let mini, timer, stopped = false, stage = 'connect';
try {
  report.result = await Promise.race([(async () => {
    // Enable the previously authorized port explicitly through the official CLI first.
    // Do not launch/replace DevTools sessions or change project trust from this check.
    mini = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
    if (stopped) { await mini.disconnect(); throw new Error('AUTOMATION_TIMEOUT'); }
    stage = 'verify-project';
    const actualAppId = await mini.evaluate(() => wx.getAccountInfoSync().miniProgram.appId);
    if (actualAppId !== project.appid) throw new Error('UNEXPECTED_AUTOMATION_PROJECT');
    stage = 'call';
    return await mini.evaluate(async target => {
      try {
        const response = await wx.cloud.callFunction({ name: target.function, config: { env: target.env },
          data: { action: 'session.bootstrap', payload: {} } });
        const result = response.result;
        return { cloudCallCompleted: true, handlerReturned: typeof result?.ok === 'boolean',
          bootstrapPassed: result?.ok === true && result.data?.mode === 'cloud',
          modelEnabled: result?.ok === true ? result.data?.enabled === true : null,
          errorCode: result?.ok === false && typeof result.error?.code === 'string' && /^[A-Z_]{1,60}$/.test(result.error.code)
            ? result.error.code : null };
      } catch (error) {
        return { cloudCallCompleted: false, bootstrapPassed: false, errorCode: 'WX_CLOUD_CALL_FAILED',
          platformCode: typeof error?.errCode === 'number' ? error.errCode : null };
      }
    }, { env: config.cloudEnvId, function: config.apiFunction });
  })(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('AUTOMATION_TIMEOUT')), 45000); })]);
} catch (error) {
  report.result = { bootstrapPassed: false, errorCode: error?.message === 'AUTOMATION_TIMEOUT'
    ? 'AUTOMATION_TIMEOUT' : error?.message === 'UNEXPECTED_AUTOMATION_PROJECT'
      ? 'UNEXPECTED_AUTOMATION_PROJECT' : 'AUTOMATION_UNAVAILABLE', stage,
    hints: [
      ['PORT_IN_USE', /EADDRINUSE|address already|端口.*占用/i],
      ['SERVICE_PORT_DISABLED', /服务端口.*关闭|service.*port.*(?:closed|disabled)/i],
      ['CONNECTION_FAILED', /ECONNREFUSED|fail.*connect|connect.*fail/i],
      ['PROJECT_TRUST_REQUIRED', /trust.*project|项目信任/i],
      ['RESTART_REQUIRED', /please.*quit|请.*退出|restart/i],
      ['ACCESS_DENIED', /access denied|EPERM/i],
      ['TIMEOUT', /timeout|timed out/i],
      ['COMPILE_ERROR', /compile|编译/i],
      ['INVALID_PROJECT', /project.*(?:invalid|not found)|项目.*(?:不存在|无效)/i],
    ].filter(([, pattern]) => pattern.test(String(error?.message ?? ''))).map(([label]) => label) };
} finally {
  stopped = true; clearTimeout(timer); await mini?.disconnect();
}
await mkdir(directory, { recursive: true });
report.evidence = path.join(directory, 'report.json');
await writeFile(report.evidence, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!report.result?.bootstrapPassed) process.exitCode = 1;
