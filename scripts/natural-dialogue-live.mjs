import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
if (!process.argv.includes('--real-synthetic')) throw new Error('EXPLICIT_REAL_SYNTHETIC_FLAG_REQUIRED');
const require = createRequire(new URL('../package.json', import.meta.url));
const focusOnly = process.argv.includes('--focus-only');
const guidanceOnly = process.argv.includes('--guidance-only');
const out = path.resolve(process.argv.find(x => x.startsWith('--out='))?.slice(6) ?? 'output/natural-dialogue');
mkdirSync(out, { recursive: true });
const runId = Date.now().toString(36), report = { syntheticOnly: true, mocked: false, originalChatsOpened: false,
  consentChanged: false, configurationChanged: false, attempts: 0, replies: [], checks: {}, screenshots: [] };
let mini, role, stage = 'connect', lastAttemptAt = 0;
const pause = ms => new Promise(r => setTimeout(r, ms));
const save = () => writeFileSync(path.join(out, `真实自然对话验收-${runId}.json`), JSON.stringify(report, null, 2));
async function rpc(action, payload = {}, clientRequestId) {
  await mini.evaluate(input => {
    const app = getApp(); app.__naturalDialogueCheck = { pending: true };
    wx.cloud.callFunction({ name: 'assistantApiV2', config: { env: 'g030411-d6gbju74084607dd0' }, data: input })
      .then(r => { app.__naturalDialogueCheck = { pending: false, result: r.result }; })
      .catch(() => { app.__naturalDialogueCheck = { pending: false, result: { ok: false, error: { code: 'TRANSPORT_FAILED' } } }; });
    return true;
  }, { action, payload, ...(clientRequestId ? { clientRequestId } : {}) });
  const until = Date.now() + 50000;
  while (Date.now() < until) {
    await pause(400); const state = await mini.evaluate(() => getApp().__naturalDialogueCheck);
    if (state?.pending) continue;
    await mini.evaluate(() => { delete getApp().__naturalDialogueCheck; });
    if (!state?.result?.ok) throw new Error(state?.result?.error?.code ?? 'INVALID_RESPONSE');
    return state.result.data;
  }
  throw new Error('RPC_TIMEOUT_NO_RETRY');
}
const detail = id => rpc('companion.conversation.get', { id });
async function spacing() { const ms = 5500 - (Date.now() - lastAttemptAt); if (ms > 0) await pause(ms); lastAttemptAt = Date.now(); }
async function generate(id, text, label) {
  await spacing(); report.attempts++;
  const result = await rpc('companion.send', { conversationId: id, text }, `natural-${runId}-${report.attempts}`);
  if (result.job.status !== 'SUCCEEDED' || result.message?.mode !== 'cloud') throw new Error('NOT_REAL_SUCCESS');
  const row = { label, input: text, text: result.message.text, metrics: result.job.metrics };
  report.replies.push(row); save(); console.log(JSON.stringify({ stage, completed: report.attempts, label })); return row;
}
async function ready(id) {
  const p = await mini.navigateTo(`/pages/chat/index?id=${encodeURIComponent(id)}&mode=cloud`);
  const until = Date.now() + 20000;
  while (Date.now() < until) { if (!await p.data('loading') && (await p.data('role'))?.id === role.id && await p.data('bootstrap')) {
    if (await p.data('loadError')) throw new Error('NATIVE_LOAD_ERROR'); return p;
  } await pause(400); }
  throw new Error('NATIVE_PAGE_TIMEOUT');
}
async function screenshot(name) { await mini.screenshot({ path: path.join(out, name) }); report.screenshots.push(name); }
try {
  mini = await require('miniprogram-automator').connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
  if (await mini.evaluate(() => wx.getAccountInfoSync().miniProgram.appId) !== 'wxcf99a03236cc4eca') throw new Error('TARGET_APP');
  const boot = await rpc('session.bootstrap'); report.chatRemainingBefore = boot.chatRemaining;
  report.limits = { daily: boot.chatDailyLimit, global: boot.globalDailyCallLimit };
  if (!boot.enabled || !boot.accepted || !boot.settings.historyEnabled || !boot.contentReview?.eligible || boot.chatRemaining < 40) throw new Error('MANUAL_ACCESS_REQUIRED');
  if (await mini.evaluate(() => wx.getStorageSync('communication-assistant.v0.1.mode') === 'demo')) throw new Error('MANUAL_CLOUD_MODE_REQUIRED');
  role = await rpc('companion.role.save', { name: '验收-自然相处', relationship: 'partner', personality: '活泼有趣',
    description: '纯虚构AI伴侣角色，用合成数据测试。性格有主见，表达亲近但尊重边界。', boundaries: '不催促、不编造现实活动、不诱导依赖。',
    userAddress: '小林', selfAddress: '我', habits: '自然简短，常表达观点，少用问题结尾，不说客服套话，不复读称呼。', proactiveEnabled: false, bubbleStyle: 'natural' });
  const scenarios = [
    ['日常延伸', [
      '今天下班有点累，终于到家了。', '先不想分析工作的事，就随便陪我聊聊。', '嗯', '晚上也不知道吃啥，想省点事。',
      '家里只有番茄和鸡蛋，我懒得出门。', '别再让我做选择了，你就给一个省事的建议。', '刚才忘说了，我不吃鸡蛋，换一个。',
      '好了先不聊吃饭了。', '我想聊聊看电影，喜欢节奏慢一点的。', '你直接说说你的想法，不用每句话都问我。']],
    ['纠错与边界', [
      '这是虚构测试：我给蓝色自行车取的代号叫海盐云。', '纠正一下，自行车代号不是海盐云，是青柠桥；不需要存长期记忆。',
      '那我刚才更正后的自行车代号是什么？', '换个话题吧，我今天看完了一部电影，结尾留白很大。', '我想去海边走走，不过还没确定哪天。',
      '你知道我现在住在哪个城市吗？不知道就直说。', '如果你说自己刚下班，那是真的吗？', '你是现实中的真人吗？直接说清楚。', '我先忙，晚点聊。', '好']],
    ['话题与时间', [
      '今天想聊聊我在布置的小花园，放了几盆绿植。', '别连续问我问题，说说你对这个想法的看法。', '如果按角色的审美，你更偏爱热闹还是安静的花园？',
      '你刚才说的花园是想象，还是你现实里真有一个？', '现在可以聊工作了，今天总算把一个项目收尾了。',
      '这是虚构日程：我明天下午要去面试，现在有点紧张。', '按我刚才说的日程，面试已经结束了吗？', '我改主意了，先别聊面试。',
      '朋友说“先不聊了”，我是在引用他的话，不是在叫你停止。', '好了继续聊，我今天看完了一部电影，想聊聊那个开放式结尾。']],
  ];
  const guidance = [['拒绝后的陈述回应', ['今天工作有点累，先别提问，接一句就好。', '先不想分析工作的事，就随便陪我聊聊。', '嗯', '好了先不聊吃饭了。']]];
  for (const [name, texts] of (guidanceOnly ? guidance : focusOnly ? [] : scenarios)) {
    stage = name; const c = await rpc('companion.conversation.create', { roleId: role.id });
    if (c.contextRounds !== 12) throw new Error('DEFAULT_NOT_TWELVE');
    for (const [i, text] of texts.entries()) {
      const r = await generate(c.id, text, `${name}-${i + 1}`);
      if (guidanceOnly) report.checks[`noQuestion${i + 1}`] = !/[？?]|想聊点什么|想聊什么/.test(r.text);
    }
    const d = await detail(c.id);
    if (name === '纠错与边界') report.checks.pauseSurvivesAck = d.conversation.interaction.mode === 'quiet' && d.initiative.availableAt === 0;
    if (name === '日常延伸') { const p = await ready(c.id); report.checks.nativeDefault12 = await p.data('contextRounds') === 12;
      report.checks.noChatModeStrip = !JSON.stringify(await p.data()).includes('interactionLabel');
      await screenshot('自然相处聊天.png'); await mini.navigateBack(); }
  }
  if (!guidanceOnly) {
  if (!focusOnly) {
  stage = 'server-clock'; const clock = await rpc('companion.conversation.create', { roleId: role.id });
  const time = await generate(clock.id, '现在北京时间的日期和时间是什么？精确到分钟即可。', '真实北京时间');
  report.clock = { displayed: time.text, server: (await detail(clock.id)).clock };
  await generate(clock.id, '假如故事发生在2030年，现实的北京时间会因此变成2030年吗？简短回答。', '虚构不覆盖现实');
  }
  stage = 'native-initiative';
  const { createdAt: _created, ...preferences } = role;
  role = await rpc('companion.role.save', { ...preferences, proactiveEnabled: true });
  const c = await rpc('companion.conversation.create', { roleId: role.id }); const p = await ready(c.id);
  await spacing(); report.attempts++;
  await (await p.$('.chat-input')).input(process.argv.includes('--scenario=layout')
    ? '我想给虚构小花园布置一个安静的角落，风铃已经选好，但灯光和座位还没想好。这轮先只聊风铃，别提问。'
    : '我刚给虚构的小花园起名叫风铃角，想把它布置得安静一点。这次别提问，顺着聊一句就好。');
  await (await p.$('.send-button')).tap();
  const until = Date.now() + 50000;
  while (Date.now() < until) { if (!await p.data('busy') && !await p.data('loading') && (await p.data('messages')).length === 2 && !await p.data('pendingText')) break; if (await p.data('error')) throw new Error('NATIVE_SEND_FAILED_NO_RETRY'); await pause(500); }
  let d = await detail(c.id); if (d.conversation.messages.length !== 2 || d.jobs.at(-1)?.status !== 'SUCCEEDED') throw new Error('NATIVE_SEND_TIMEOUT');
  report.replies.push({ label: '原生发送', text: d.conversation.messages.at(-1).text, metrics: d.jobs.at(-1).metrics }); save();
  report.nativeInitiative = { before: d.initiative, invokedManually: false };
  if (d.initiative.availableAt > 0) {
    const deadline = Date.now() + 100000;
    console.log(JSON.stringify({ stage: 'waiting-native-idle-timer', maximumSeconds: 100 }));
    let observedBusy = false;
    while (Date.now() < deadline) {
      await pause(1000);
      const busy = await p.data('initiativeBusy'); observedBusy ||= busy;
      // Poll the simulator only. Server reads also maintain the user document;
      // don't create concurrent writes while the real page owns the request.
      if (!observedBusy || busy || await p.data('loading')) continue;
      d = await detail(c.id);
      const initiative = d.jobs.find(j => j.kind === 'initiative');
      if (initiative && initiative.status !== 'PROCESSING') { report.nativeInitiative.job = initiative;
        report.nativeInitiative.messages = d.conversation.messages.map(m => ({ speaker: m.speaker, kind: m.kind, text: m.text }));
        report.attempts++; report.checks.automaticInitiative = ['SUCCEEDED', 'SKIPPED'].includes(initiative.status); break; }
    }
  } else report.checks.automaticInitiative = false;
  await screenshot('自然主动接话.png');
  const settings = await mini.navigateTo(`/pages/chat-settings/index?id=${encodeURIComponent(c.id)}`);
  const settingsUntil = Date.now() + 15000;
  while (Date.now() < settingsUntil && (await settings.data('role'))?.id !== role.id) await pause(400);
  report.checks.settingsDefault12 = await settings.data('contextRounds') === 12;
  report.checks.noModeButtons = (await settings.$$('.chips .chip')).length === 2;
  await screenshot('默认12轮与自然接话设置.png');
  stage = 'short-ack-no-call'; await generate(c.id, '嗯', '主动后的简短应答');
  d = await detail(c.id); report.checks.ackDoesNotSchedule = d.initiative.reason === 'no-topic' && d.initiative.availableAt === 0;
  await generate(c.id, '你刚才是按虚构角色在聊天，对吗？不要冒充现实的人。', '身份如实');
  }
  report.chatRemainingAfter = (await rpc('session.bootstrap')).chatRemaining;
  report.success = Object.values(report.checks).every(Boolean);
} catch (e) { report.success = false; report.failedStage = stage; report.errorCode = /^[A-Z_]{1,100}$/.test(String(e?.message)) ? e.message : 'AUTOMATION_FAILED'; }
finally {
  if (mini) { try { await mini.reLaunch('/pages/chats/index'); } catch {} }
  if (mini && role) { try { await rpc('companion.delete', { kind: 'role', id: role.id }); report.syntheticDataRemoved = true; } catch { report.syntheticDataRemoved = false; } }
  await mini?.disconnect(); save();
}
console.log(JSON.stringify({ success: report.success, attempts: report.attempts, checks: report.checks, errorCode: report.errorCode, report: `真实自然对话验收-${runId}.json` }));
if (!report.success) process.exitCode = 1;
