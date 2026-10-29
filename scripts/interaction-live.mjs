import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
if (!process.argv.includes('--real-synthetic')) throw new Error('EXPLICIT_REAL_SYNTHETIC_FLAG_REQUIRED');
const require = createRequire(new URL('../package.json', import.meta.url));
const out = path.resolve(process.argv.find(x => x.startsWith('--out='))?.slice(6) ?? 'output/interaction-live');
mkdirSync(out, { recursive: true });
const runId = Date.now().toString(36), report = { mocked: false, syntheticOnly: true, originalChatsOpened: false,
  consentChanged: false, clockChanged: false, automaticInitiativeManuallyInvoked: false, plannedModelAttempts: 8, events: [], replies: [] };
let mini, roleId, stage = 'connect'; const ownConversations = [];
const pause = ms => new Promise(r => setTimeout(r, ms));
async function rpc(action, payload = {}, clientRequestId) {
  await mini.evaluate(input => {
    getApp().__interactionCheck = { pending: true };
    wx.cloud.callFunction({ name: 'assistantApiV2', config: { env: 'g030411-d6gbju74084607dd0' }, data: input })
      .then(r => { getApp().__interactionCheck = { pending: false, result: r.result }; })
      .catch(() => { getApp().__interactionCheck = { pending: false, result: { ok: false, error: { code: 'TRANSPORT_FAILED' } } }; });
    return true;
  }, { action, payload, ...(clientRequestId ? { clientRequestId } : {}) });
  const deadline = Date.now() + 48000;
  while (Date.now() < deadline) {
    await pause(400); const state = await mini.evaluate(() => getApp().__interactionCheck);
    if (state?.pending) continue;
    await mini.evaluate(() => { delete getApp().__interactionCheck; });
    if (!state?.result?.ok) throw new Error(state?.result?.error?.code ?? 'INVALID_RESPONSE');
    return state.result.data;
  }
  throw new Error('RPC_TIMEOUT_NO_RETRY');
}
async function detail(id) { return rpc('companion.conversation.get', { id }); }
async function openChat(id) {
  stage = 'open-own-native-chat'; const p = await mini.navigateTo(`/pages/chat/index?id=${id}&mode=cloud`);
  const until = Date.now() + 18000;
  while (Date.now() < until) {
    if (!await p.data('loading') && (await p.data('role'))?.id === roleId && await p.data('bootstrap')) {
      if (await p.data('loadError')) throw new Error('NATIVE_LOAD_FAILED'); return p;
    }
    await pause(400);
  }
  throw new Error('NATIVE_PAGE_TIMEOUT');
}
async function input(p, text) {
  const element = await p.$('.chat-input'); await element.input(text);
  const until = Date.now() + 5000;
  while (Date.now() < until) { if (await p.data('text') === text) return; await pause(200); }
  report.inputDiagnostic = { elementValue: await element.value(), boundText: await p.data('text'), loading: await p.data('loading'), busy: await p.data('busy') };
  throw new Error('NATIVE_INPUT_FAILED');
}
async function send(p, id, text) {
  const readyUntil = Date.now() + 18000;
  while (await p.data('loading') && Date.now() < readyUntil) await pause(300);
  if (await p.data('loading')) throw new Error('NATIVE_LOADING_BEFORE_INPUT');
  const before = (await p.data('messages')).length;
  await input(p, text);
  await (await p.$('.send-button')).tap();
  const until = Date.now() + 48000;
  while (Date.now() < until) {
    if (!await p.data('busy') && !await p.data('loading') && (await p.data('messages')).length > before && !await p.data('pendingText')) {
      const d = await detail(id), latest = d.conversation.messages.at(-1);
      if (latest?.mode !== 'cloud') throw new Error('NOT_REAL_MODEL');
      report.replies.push({ stage, text: latest.text, metrics: d.jobs.at(-1)?.metrics }); return;
    }
    if (await p.data('error')) throw new Error('NATIVE_SEND_FAILED_NO_RETRY');
    await pause(500);
  }
  throw new Error('NATIVE_SEND_TIMEOUT_NO_RETRY');
}
async function wait(seconds, label) {
  console.log(JSON.stringify({ stage: label, waitSeconds: seconds }));
  for (let n = 0; n < seconds; n += 5) await pause(Math.min(5, seconds - n) * 1000);
}
async function automatic(p, id, label, maximumMs = 95000) {
  stage = label;
  const before = await detail(id), count = before.conversation.messages.filter(m => m.kind === 'initiative').length;
  const userCount = before.conversation.messages.filter(m => m.speaker === 'user').length;
  console.log(JSON.stringify({ stage: label, automaticTimerOnly: true }));
  const until = Date.now() + maximumMs;
  while (Date.now() < until) {
    await pause(2500);
    const messages = await p.data('messages');
    if (messages.filter(m => m.kind === 'initiative').length > count) {
      const d = await detail(id), msg = d.conversation.messages.at(-1);
      if (msg.kind !== 'initiative' || msg.mode !== 'cloud' || d.conversation.messages.filter(m => m.speaker === 'user').length !== userCount)
        throw new Error('INITIATIVE_PROTOCOL_FAILED');
      const event = { stage: label, mode: d.conversation.interaction.mode, text: msg.text, metrics: d.jobs.at(-1)?.metrics, attemptStartedAt: d.jobs.at(-1)?.createdAt,
        consumedOnce: d.initiative.reason === 'already-attempted', topics: (d.conversation.interaction.recentTopics ?? []).map(k => k.startsWith('follow:') ? 'follow-up' : k) };
      report.events.push(event); console.log(JSON.stringify({ stage: label, automaticSucceeded: true })); return d;
    }
  }
  const d = await detail(id); report.failedJobStatus = d.jobs.at(-1)?.status; report.failedJobCode = d.jobs.at(-1)?.errorCode;
  throw new Error('NATIVE_AUTOMATIC_TIMER_TIMEOUT_NO_RETRY');
}
try {
  mini = await require('miniprogram-automator').connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
  if (await mini.evaluate(() => wx.getAccountInfoSync().miniProgram.appId) !== 'wxcf99a03236cc4eca') throw new Error('TARGET_APP');
  const b = await rpc('session.bootstrap'); report.chatRemainingBefore = b.chatRemaining;
  if (!b.enabled || !b.accepted || !b.settings.historyEnabled || !b.contentReview?.eligible || b.chatRemaining < 10) throw new Error('MANUAL_ACCESS_REQUIRED');
  if (await mini.evaluate(() => wx.getStorageSync('communication-assistant.v0.1.mode') === 'demo')) throw new Error('MANUAL_CLOUD_MODE_REQUIRED');
  report.limits = { daily: b.chatDailyLimit, global: b.globalDailyCallLimit };
  const role = await rpc('companion.role.save', { name: '验收-相处话题', relationship: 'partner', personality: '活泼有趣',
    description: '临时虚构AI角色，不对应真人。', boundaries: '不催促，不声称现实活动，不诱导排他依赖。',
    habits: '自然简短，可以有自己的角色观点；一次最多提出一个邀请。', proactiveEnabled: true, bubbleStyle: 'natural' }); roleId = role.id;
  const light = await rpc('companion.conversation.create', { roleId }); ownConversations.push(light.id);
  let p = await openChat(light.id); stage = 'light-user-message'; await send(p, light.id, '换个话题');
  await automatic(p, light.id, 'light-first-fresh-topic'); await mini.screenshot({ path: path.join(out, '轻松模式自动话题.png') });
  const listening = await rpc('companion.conversation.create', { roleId }); ownConversations.push(listening.id);
  p = await openChat(listening.id); stage = 'listening-user-message'; await send(p, listening.id, '今天想聊聊我的虚构小花园，还没想好怎么布置。');
  await mini.navigateTo(`/pages/chat-settings/index?id=${listening.id}`);
  await wait(50, 'hidden-page-no-new-call');
  report.hiddenPassed = (await detail(listening.id)).conversation.messages.length === 2;
  if (!report.hiddenPassed) throw new Error('HIDDEN_PAGE_GENERATED');
  await mini.navigateBack(); p = await mini.currentPage(); await pause(1500);
  await input(p, '正在写的虚构草稿'); await wait(50, 'draft-blocks-proactive');
  report.draftPassed = (await detail(listening.id)).conversation.messages.length === 2 && await p.data('text') === '正在写的虚构草稿';
  if (!report.draftPassed) throw new Error('DRAFT_WAS_NOT_RESPECTED');
  await input(p, ''); await automatic(p, listening.id, 'listening-follow-up-after-draft-clear');
  let d = await detail(listening.id);
  await rpc('companion.interaction.configure', { id: listening.id, version: d.conversation.settingsVersion ?? 1, mode: 'quiet' });
  p = await openChat(listening.id); stage = 'quiet-acknowledgement'; await send(p, listening.id, '嗯');
  const quietCount = (await detail(listening.id)).conversation.messages.length; await wait(50, 'quiet-persists-after-ack');
  d = await detail(listening.id); report.quietPassed = d.conversation.interaction.mode === 'quiet' && d.initiative.reason === 'quiet' && d.conversation.messages.length === quietCount;
  if (!report.quietPassed) throw new Error('QUIET_RESUMED_WITHOUT_CHOICE');
  stage = 'explicit-resume'; await send(p, listening.id, '我又想聊了'); d = await detail(listening.id);
  report.resumePassed = d.conversation.interaction.mode === 'listening' && d.initiative.reason === 'waiting';
  if (!report.resumePassed) throw new Error('EXPLICIT_RESUME_FAILED');
  p = await openChat(light.id); stage = 'light-next-turn'; await send(p, light.id, '收到，继续轻松聊聊');
  const beforeRotation = await detail(light.id); report.cooldownRemainingMs = Math.max(0, beforeRotation.initiative.availableAt - beforeRotation.serverTime);
  await automatic(p, light.id, 'light-rotated-topic-after-real-cooldown', 190000);
  const finalLight = await detail(light.id); const keys = finalLight.conversation.interaction.recentTopics;
  report.rotationPassed = keys.length === 2 && keys[0] !== keys[1];
  report.cooldownPassed = report.events[2].attemptStartedAt - report.events[0].attemptStartedAt >= 300000;
  await mini.navigateTo(`/pages/chat-settings/index?id=${light.id}`); await pause(1500);
  await mini.screenshot({ path: path.join(out, '相处状态设置.png') });
  const jobs = []; for (const id of ownConversations) jobs.push(...(await detail(id)).jobs);
  report.modelJobs = jobs.map(j => ({ status: j.status, kind: j.kind, metrics: j.metrics }));
  report.observedModelAttempts = jobs.length; report.chatRemainingAfter = (await rpc('session.bootstrap')).chatRemaining;
  report.success = report.hiddenPassed && report.draftPassed && report.quietPassed && report.resumePassed && report.rotationPassed && report.cooldownPassed && report.events.every(e => e.consumedOnce);
} catch (e) { report.success = false; report.failedStage = stage; report.errorCode = /^[A-Z_]{1,90}$/.test(String(e?.message)) ? e.message : 'AUTOMATION_FAILED';
  report.failureDetail = String(e?.message ?? '').replace(/(?:https?:|wss?:)\S+/g, '[url]').replace(/[a-f0-9]{32,}/gi, '[identifier]').slice(0, 240); }
finally {
  if (mini && roleId) {
    try { await mini.reLaunch('/pages/chats/index'); } catch {}
    try {
      const jobs = []; for (const id of ownConversations) jobs.push(...(await detail(id)).jobs);
      report.observedModelAttempts = jobs.length;
      await rpc('companion.delete', { kind: 'role', id: roleId }); report.syntheticDataRemoved = true;
    } catch { report.syntheticDataRemoved = false; }
  }
  await mini?.disconnect();
}
writeFileSync(path.join(out, `真实相处状态与自动话题验收-${runId}.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2)); if (!report.success) process.exitCode = 1;
