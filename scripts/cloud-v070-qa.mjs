import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const require = createRequire(path.resolve('package.json'));
// --workdir selects the operator's private evidence directory, never a model
// input directory. Keep this directory out of source control and release zips.
const workRoot=path.resolve(process.argv.find(x=>x.startsWith('--workdir='))?.slice(10)??process.cwd());
const dir = path.join(workRoot,'.local/cloud-v070-qa'); await mkdir(dir, { recursive:true });
const phase = process.argv.find(x => x.startsWith('--phase='))?.slice(8) ?? 'preflight';
// Paid phases must be named explicitly. This flag never accepts account/privacy
// consent: the real server bootstrap must already report the user's acceptance.
if(['chat','native-send','arm-autonomy'].includes(phase)&&!process.argv.includes('--real-synthetic'))throw new Error('EXPLICIT_REAL_SYNTHETIC_FLAG_REQUIRED');
const stateFile = path.join(dir, 'fixture.json');
let fixture;
try{fixture=JSON.parse(await readFile(stateFile,'utf8'));}
catch(e){if(e.code!=='ENOENT')throw e;fixture={run:'qa070_'+Date.now().toString(36),replies:[]};}
const pause = ms => new Promise(r => setTimeout(r, ms));
const report = { phase, realCloud:true, syntheticModelInputOnly:true, consentChanged:false, clockChanged:false, events:[] };
let mini;
const digest = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
async function rpc(action, payload={}, clientRequestId) {
  await mini.evaluate(input => {
    getApp().__cloud070qa = { pending:true };
    wx.cloud.callFunction({ name:'assistantApiV2', config:{env:'g030411-d6gbju74084607dd0'}, data:input })
      .then(r => { getApp().__cloud070qa = { pending:false, result:r.result }; })
      .catch(() => { getApp().__cloud070qa = { pending:false, result:{ok:false,error:{code:'TRANSPORT_FAILED'}} }; });
    return true;
  }, {action,payload,...(clientRequestId?{clientRequestId}:{})});
  const until = Date.now()+55000;
  while(Date.now()<until) { await pause(450); const s=await mini.evaluate(()=>getApp().__cloud070qa); if(s?.pending)continue;
    await mini.evaluate(()=>{delete getApp().__cloud070qa;});
    if(!s?.result?.ok) { const e=new Error(s?.result?.error?.code??'INVALID_RESPONSE'); e.api=true; throw e; }
    return s.result.data;
  }
  throw new Error('RPC_TIMEOUT_NO_PAID_RETRY');
}
const detail = () => rpc('companion.conversation.get',{id:fixture.conversationId});
async function saveFixture(){await writeFile(stateFile,JSON.stringify(fixture,null,2));}
async function send(text) {
  const requestId=fixture.run+'_r'+(fixture.replies.length+1);
  // Persist the pending ID before starting. Never automatically issue another paid ID on failure.
  if(fixture.pending)throw new Error('PREVIOUS_REQUEST_UNRESOLVED');
  fixture.pending={requestId,text};await saveFixture();
  const start=Date.now();
  const r=await rpc('companion.send',{conversationId:fixture.conversationId,text},requestId);
  if(r.job.status!=='SUCCEEDED'||r.message?.mode!=='cloud')throw new Error('REAL_REPLY_NOT_SUCCEEDED');
  fixture.replies.push({requestId,input:text,reply:r.message.text,messageId:r.message.id,metrics:r.job.metrics,elapsed:Date.now()-start});
  fixture.pending=null; await saveFixture();
  report.events.push({round:fixture.replies.length,status:r.job.status,historyMessages:r.job.metrics?.historyMessages});
  console.log(JSON.stringify(report.events.at(-1)));
  // Bound rate without changing server quota or retrying a failed paid request.
  await pause(Math.max(0,6500-(Date.now()-start)));
  return r;
}
try {
  mini=await require('miniprogram-automator').connect({wsEndpoint:'ws://127.0.0.1:9420'});
  if(await mini.evaluate(()=>wx.getAccountInfoSync().miniProgram.appId)!=='wxcf99a03236cc4eca')throw new Error('WRONG_APP');
  const b=await rpc('session.bootstrap');
  report.access={enabled:b.enabled,accepted:b.accepted,historyEnabled:b.settings.historyEnabled,memoryEnabled:b.settings.memoryEnabled,remaining:b.chatRemaining};
  if(phase==='preflight') {
    // Compare private messages in memory; only counts and match booleans enter the report.
    const old=JSON.parse(await readFile(path.join(workRoot,'.local/cloud-before-v070-20261030/companion-export.private.json'),'utf8'));
    const backup=old.data??old;
    let checked=0,matched=0;
    for(const c of backup.conversations??[]) {
      const page=await rpc('companion.history.page',{conversationId:c.id});
      for(const m of c.messages??[]) {checked++; if(page.messages.some(v=>v.id===m.id && digest([v.text,v.createdAt,v.speaker])===digest([m.text,m.createdAt,m.speaker]))) matched++;}
    }
    report.migration={checked,matched,passed:checked>0&&checked===matched};
    report.clientCollections=[];
    for(const collection of ['assistant_chat_messages','assistant_chat_tails','assistant_chat_cleanup']) {
      const denied=await mini.evaluate(async name=>{try{await wx.cloud.database({env:'g030411-d6gbju74084607dd0'}).collection(name).limit(1).get();return false;}catch{return true;}},collection);
      report.clientCollections.push({collection,readDenied:denied});
    }
  } else {
    if(!b.enabled||!b.accepted||!b.settings.historyEnabled||!b.contentReview?.eligible)throw new Error('MANUAL_CONSENT_OR_ACCESS_REQUIRED');
    if(phase==='chat') {
      if(!fixture.roleId){
        const role=await rpc('companion.role.save',{name:'研发验收070',relationship:'friend',personality:'活泼有趣',description:'完全虚构的测试朋友，喜欢讨论小花园。',boundaries:'不承诺定时提醒，不催促，不声称真实线下活动。',userAddress:'小禾',habits:'简短自然，不要每条都问问题。',proactiveEnabled:false,autonomousEnabled:false,bubbleStyle:'natural'});
        fixture.roleId=role.id;fixture.roleName=role.name;await saveFixture();
        const c=await rpc('companion.conversation.create',{roleId:role.id});fixture.conversationId=c.id;await saveFixture();
      }
      const c2=await rpc('companion.conversation.create',{roleId:fixture.roleId});
      report.samePrimary=c2.id===fixture.conversationId;
      const texts=['你好，今天我们随便聊几句，叫我小禾。','记住：在这个虚构测试里，我的小花园种的是薄荷。','我的虚构小花园种的是什么？','我想在虚构花园里摆一把蓝色椅子。','今天看了一部很轻松的虚构电影，心情挺好。','现在北京时间是多少？直接告诉我。'];
      while(fixture.replies.length<texts.length)await send(texts[fixture.replies.length]);
      const data=await rpc('companion.data',{id:fixture.roleId});
      const candidate=data.memories.find(m=>m.status==='pending'&&m.text.includes('薄荷'));
      report.candidateCreated=!!candidate;
      if(candidate&&b.settings.memoryEnabled&&!fixture.memoryId){
        const base={id:candidate.id,version:candidate.version,roleId:fixture.roleId,text:candidate.text,confirmed:true,subject:'user',topic:'虚构花园植物',kind:'fact',importance:3};
        const confirmed=await rpc('companion.memory.save',base);
        const source=await rpc('companion.memory.source',{id:confirmed.id});report.sourceAvailable=source.available===true;
        const corrected=await rpc('companion.memory.save',{...base,version:confirmed.version,text:'在这个虚构测试里，我的小花园种的是迷迭香。'});
        fixture.memoryId=corrected.id;await saveFixture();
        const before=await rpc('session.bootstrap');const audit=await rpc('companion.memory.inspect',{roleId:fixture.roleId,text:'我的虚构花园种的什么植物'});const after=await rpc('session.bootstrap');
        report.inspect={selected:audit.entries.filter(x=>x.selected).length,quotaUnchanged:before.chatRemaining===after.chatRemaining};
      } else report.memoryConfirmation=b.settings.memoryEnabled?'candidate-unavailable':'manual-memory-enable-required';
      // 35 rounds exceed both the 40-message page and the 60-message working tail.
      // A 25-round test alone cannot prove that old bodies survive tail eviction.
      while(fixture.replies.length<35) {
        const n=fixture.replies.length;
        const text=n===6?'我纠正了虚构花园植物，现在种的是什么？':n===34?'回想一下刚才的话题，简单接着聊一句。':`虚构测试第${n+1}轮：我在花园里放了第${n-5}块小石头，随便说句感想就好。`;
        await send(text);
      }
      const final=await detail(); report.modelWindow={configured:final.conversation.contextRounds,lastHistoryMessages:fixture.replies.at(-1).metrics?.historyMessages};
      const all=[];let cursor;for(let i=0;i<10;i++){const p=await rpc('companion.history.page',{conversationId:fixture.conversationId,...(cursor?{cursor}:{})});all.unshift(...p.messages);if(!p.hasMore)break;cursor=p.cursor;}
      report.archive={count:all.length,unique:new Set(all.map(x=>x.id)).size,firstInputPresent:all.some(x=>x.text===texts[0]),expectedMinimum:70,workingTailCount:final.conversation.messages.length};
      const firstUser=all.find(x=>x.speaker==='user'&&x.text===texts[0]);
      if(firstUser){const lookup=await rpc('companion.history.message',{conversationId:fixture.conversationId,messageId:firstUser.id});report.oldestMessageLookup=lookup.message?.text===firstUser.text;}
      const beforeReplay=await rpc('session.bootstrap');const last=fixture.replies.at(-1);await rpc('companion.send',{conversationId:fixture.conversationId,text:last.input},last.requestId);const afterReplay=await rpc('session.bootstrap');
      report.replayQuotaUnchanged=beforeReplay.chatRemaining===afterReplay.chatRemaining;
      report.realReplies=fixture.replies;
    } else if(phase==='native-recover') {
      if(!fixture.nativePending)throw new Error('NO_NATIVE_REQUEST_TO_RESOLVE');
      const d=await detail(),user=[...d.conversation.messages].reverse().find(m=>m.speaker==='user'&&m.text===fixture.nativePending.text);
      const job=user&&d.jobs.find(j=>j.id===user.requestId),reply=user&&d.conversation.messages.find(m=>m.speaker==='assistant'&&m.requestId===user.requestId);
      if(job?.status!=='SUCCEEDED'||!reply)throw new Error('NATIVE_ORIGINAL_NOT_RESOLVED');
      fixture.nativeOriginal={jobId:job.id,messageId:reply.id,text:reply.text,metrics:job.metrics,uiTimingVerified:false};fixture.nativePending=null;await saveFixture();
      report.originalRequestSucceeded=true;report.providerReplayed=false;
    } else if(phase==='native-send') {
      if(fixture.nativeRound||fixture.nativePending)throw new Error('NATIVE_REQUEST_ALREADY_STARTED');
      const p=await mini.navigateTo(`/pages/chat/index?id=${fixture.conversationId}&mode=cloud`);
      const ready=Date.now()+20000;
      while(Date.now()<ready){const d=await p.data();if(!d.loading&&d.role?.id===fixture.roleId&&d.bootstrap?.accepted)break;await pause(400);}
      let data=await p.data();if(data.loading||data.role?.id!==fixture.roleId||!data.bootstrap?.accepted||data.loadError)throw new Error('NATIVE_PAGE_NOT_READY');
      const text=fixture.nativeOriginal?'第二次界面验收：刚才的测试回复已收到，请简短接一句。':'真实页面验收：你好，请自然接一句就好。',draft='这是下一条虚构草稿，先不发送。';
      const input=await p.$('.chat-input');await input.input(text);
      let boundUntil=Date.now()+5000;while(await p.data('text')!==text&&Date.now()<boundUntil)await pause(100);
      if(await p.data('text')!==text)throw new Error('NATIVE_INPUT_BINDING_FAILED');
      fixture.nativePending={text,startedAt:Date.now()};await saveFixture();
      await(await p.$('.send-button')).tap();
      // Native input dispatch is asynchronous. Observe the first pending state,
      // instead of mistaking the stale pre-event data for the UI's behavior.
      const pendingUntil=Date.now()+4000;
      do{data=await p.data();if(data.pendingText===text&&data.busy)break;await pause(100);}while(Date.now()<pendingUntil);
      report.pendingObservedMs=Date.now()-fixture.nativePending.startedAt;
      report.immediateBubble=data.pendingText===text;report.composerCleared=data.text==='';report.waitingOnModel=data.busy===true;
      fixture.nativePending.requestId=data.requestId;await saveFixture();
      if(!report.immediateBubble||!report.composerCleared||!report.waitingOnModel)throw new Error('NATIVE_IMMEDIATE_SEND_FAILED');
      await mini.screenshot({path:path.join(dir,'native-immediate-send.png')});
      await input.input(draft);
      boundUntil=Date.now()+5000;while(await p.data('text')!==draft&&Date.now()<boundUntil)await pause(100);
      if(await p.data('text')!==draft)throw new Error('NATIVE_DRAFT_BINDING_FAILED');
      const until=Date.now()+55000;while(Date.now()<until){data=await p.data();if(!data.busy&&!data.loading&&!data.pendingText)break;if(data.error)throw new Error('NATIVE_SEND_FAILED_NO_RETRY');await pause(500);}
      if(data.busy||data.pendingText)throw new Error('NATIVE_SEND_TIMEOUT_NO_RETRY');
      report.draftPreserved=data.text===draft;
      const d=await detail(),message=d.conversation.messages.at(-1);if(message?.mode!=='cloud'||message.speaker!=='assistant')throw new Error('NATIVE_NOT_REAL_MODEL');
      fixture.nativeRound={messageId:message.id,text:message.text,metrics:d.jobs.at(-1)?.metrics};fixture.nativePending=null;await saveFixture();report.realReply=fixture.nativeRound;
      await mini.screenshot({path:path.join(dir,'native-reply-and-draft.png')});
      await mini.navigateBack();
    } else if(phase==='isolation-checks') {
      const d=await detail();if(d.role.name!==fixture.roleName)throw new Error('FIXTURE_OWNERSHIP_MISMATCH');
      if(!fixture.isolationRoleId){
        const role=await rpc('companion.role.save',{name:'隔离验收070',relationship:'friend',personality:'理性坦诚',description:'仅用于虚构角色隔离验证。',boundaries:'不启用主动。',proactiveEnabled:false,autonomousEnabled:false});
        fixture.isolationRoleId=role.id;await saveFixture();
      }
      let page=await rpc('companion.history.page',{conversationId:fixture.conversationId});
      while(page.hasMore)page=await rpc('companion.history.page',{conversationId:fixture.conversationId,cursor:page.cursor});
      const first=page.messages.find(m=>m.speaker==='user');if(!first)throw new Error('MISSING_SYNTHETIC_SOURCE');
      try{await rpc('companion.memory.save',{roleId:fixture.isolationRoleId,text:first.text.slice(0,20),confirmed:false,source:{kind:'message',conversationId:fixture.conversationId,messageId:first.id}});report.crossRoleSourceRejected=false;}
      catch(e){if(!e.api)throw e;report.crossRoleSourceRejected=e.message==='RESOURCE_UNAVAILABLE';}
      const before=await rpc('session.bootstrap');
      const own=await rpc('companion.data',{id:fixture.roleId}),other=await rpc('companion.data',{id:fixture.isolationRoleId});
      const ownAudit=await rpc('companion.memory.inspect',{roleId:fixture.roleId,text:'虚构花园植物'});
      const otherAudit=await rpc('companion.memory.inspect',{roleId:fixture.isolationRoleId,text:'虚构花园植物'});
      report.ownMemorySelected=ownAudit.entries.some(x=>x.id===fixture.memoryId&&x.selected);
      report.otherRoleHasOwnMemory=other.memories.some(x=>x.id===fixture.memoryId)||otherAudit.entries.some(x=>x.id===fixture.memoryId);
      const memory=own.memories.find(x=>x.id===fixture.memoryId);
      if(memory){try{await rpc('companion.memory.save',{id:memory.id,roleId:fixture.roleId,version:memory.version-1,text:memory.text,confirmed:true});report.staleVersionRejected=false;}catch(e){if(!e.api)throw e;report.staleVersionRejected=e.message==='VERSION_CONFLICT';}}
      // Transport lookalikes must not let the client choose the server identity.
      const forged=await mini.evaluate(async()=>{const r=await wx.cloud.callFunction({name:'assistantApiV2',config:{env:'g030411-d6gbju74084607dd0'},data:{action:'session.bootstrap',payload:{},userId:'synthetic-forged-user'}});return {ok:r.result?.ok,code:r.result?.error?.code};});
      report.forgedIdentityRejected=forged.ok===false&&forged.code==='INVALID_INPUT';
      const after=await rpc('session.bootstrap');report.nonGenerationQuotaUnchanged=before.chatRemaining===after.chatRemaining;
      report.realTwoAccountTest=false;
      await rpc('companion.delete',{kind:'role',id:fixture.isolationRoleId});fixture.isolationRoleId=null;await saveFixture();report.isolationFixtureRemoved=true;
    } else if(phase==='arm-autonomy') {
      if(fixture.armedAt)throw new Error('AUTONOMY_ALREADY_ARMED');
      // Leave every chat page before enabling background mode. Otherwise a
      // foreground page timer could be mistaken for the cloud timer under test.
      await mini.reLaunch('/pages/chats/index');
      if((await mini.currentPage()).path!=='pages/chats/index')throw new Error('CHAT_PAGE_NOT_HIDDEN');
      const d=await detail();if(d.role.name!==fixture.roleName)throw new Error('FIXTURE_OWNERSHIP_MISMATCH');
      await rpc('companion.role.save',{...Object.fromEntries(Object.entries(d.role).filter(([k])=>!['createdAt'].includes(k))),proactiveEnabled:true,autonomousEnabled:true});
      await send('我在想虚构花园的小路该怎么铺，还想给角落取个名字。');
      report.autonomyArmedAt=Date.now();report.expected='actual-cloud-timer-only';fixture.armedAt=report.autonomyArmedAt;await saveFixture();
    } else if(phase==='status') {
      const d=await detail();report.serverTime=d.serverTime;report.clock=d.clock;report.initiative=d.initiative;report.jobs=d.jobs.map(j=>({id:j.id,kind:j.kind,status:j.status,errorCode:j.errorCode,createdAt:j.createdAt}));report.proactiveMessages=d.conversation.messages.filter(m=>m.kind==='initiative').map(m=>({text:m.text,createdAt:m.createdAt,mode:m.mode}));
    } else throw new Error('UNKNOWN_PHASE');
  }
  report.completed=true;
}catch(e){report.completed=false;report.errorCode=/^[A-Z0-9_]{1,100}$/.test(e.message)?e.message:'QA_SCRIPT_FAILED';console.log(JSON.stringify({phase,errorCode:report.errorCode}));process.exitCode=1;}
finally{await mini?.disconnect();}
const reportPath=path.join(dir,phase+'-'+Date.now()+'.json');await writeFile(reportPath,JSON.stringify(report,null,2));
console.log(JSON.stringify({phase,completed:report.completed,reportPath,...(phase==='preflight'?report:{events:report.events,access:report.access,errorCode:report.errorCode})}));
