import test from 'node:test';
import assert from 'node:assert/strict';
import {settings} from '../.generated/settings.mjs';
import {itemIdentity,compareDigest,validateSnapshot} from '../lib/digest-history.mjs';
import {runDigest,makePayloads,sendFeishu} from '../lib/hotspot.mjs';
const json=x=>new Response(JSON.stringify(x),{headers:{'Content-Type':'application/json'}});
const webhook='https://open.feishu.cn/open-apis/bot/v2/hook/test-only-not-a-real-token';
const source={id:'baidu',name:'百度',expected_domain:'baidu.com'};
const config={...settings,sources:[source]};
const topic=(title,url='https://www.baidu.com/a')=>({title,url,kind:'topic',category:'萌宠垂类',sources:['百度'],summary:'猫咪与狗狗相互陪伴，社区居民为它们提供了温暖的住所。',summary_origin:'来源摘要'});
const snapshot=items=>({version:1,sent_at:'2026-10-21T10:00:00Z',keys:items.map(itemIdentity)});
const reader=(titles,sent,sendResult=()=>json({code:0}))=>async(url,opts)=>{
  if (String(url)===webhook) {sent.push(JSON.parse(opts.body));return sendResult(sent.length);}
  assert.equal(new URL(url).hostname,'newsnow.busiyi.world');
  return json({status:'success',items:titles.map((title,i)=>({title,url:'https://www.baidu.com/'+i,
    description:title+'：社区居民共同为流浪动物提供食物和住所，动物之间温柔陪伴、互相帮助。'}))});
};

test('topics match across platforms and punctuation; video identity survives changed title and tracking URL',()=>{
  assert.equal(itemIdentity(topic('猫咪 救助！')),itemIdentity(topic('猫咪救助','https://www.douyin.com/hot/1')));
  const a={...topic('作品原名'),kind:'video',url:'https://www.bilibili.com/video/BVtest1?track=old'};
  assert.equal(itemIdentity(a),itemIdentity({...a,title:'作品新名',url:'https://www.bilibili.com/video/BVtest1/'}));
  assert.notEqual(itemIdentity(a),itemIdentity({...a,url:'https://www.bilibili.com/video/BVtest2'}));
});
test('comparison is relative to last delivered selection, not ever-seen history or numeric heat',()=>{
  const old=topic('猫咪救助'),fresh=topic('狗狗暖心');
  const report=compareDigest([fresh,{...old,heat:'999999'}],snapshot([old]));
  assert.deepEqual(report.items.map(x=>x.novelty),['new','continuing']);
  assert.equal(report.new_items,1);assert.equal(report.continuing_items,1);
  assert.equal(compareDigest([old],snapshot([fresh])).items[0].novelty,'new');
});
test('missing baseline and inaccessible or malformed history cannot falsely mark everything new',async()=>{
  assert.equal(compareDigest([topic('猫咪救助')],null).items[0].novelty,'baseline');
  assert.equal(compareDigest([topic('猫咪救助')],null,'unavailable').new_items,0);
  assert.throws(()=>validateSnapshot({version:1,sent_at:'bad',keys:[]}));
  assert.throws(()=>validateSnapshot({version:1,sent_at:'2026-10-21',keys:['raw title']}));
});
test('two complete runs persist a private identifier baseline and visibly distinguish new vs continuing',async()=>{
  let saved=null,writes=0; const sent=[];
  const store={load:async()=>saved,save:async value=>{saved=value;writes++;}};
  const first=await runDigest({webhook,config,historyStore:store,fetcher:reader(['猫咪救助'],sent)});
  assert.equal(first.comparison_status,'baseline');assert.equal(first.history_saved,true);
  assert.match(JSON.stringify(sent),/首次建立推送记录/);
  assert.equal(JSON.stringify(saved).includes('猫咪'),false);assert.equal(saved.keys.length,1);
  sent.length=0;
  const next=await runDigest({webhook,config,historyStore:store,fetcher:reader(['猫咪救助','狗狗救助'],sent)});
  assert.equal(next.new_items,1);assert.equal(next.continuing_items,1);assert.equal(writes,2);
  const titles=sent.flatMap(x=>x.card.body.elements.filter(e=>e.text_size==='heading-3').map(e=>e.content));
  assert.match(titles[0],/🆕 新增.*狗狗救助/);assert.match(titles[1],/🔁 持续热点.*猫咪救助/);
  assert.match(JSON.stringify(sent),/新增1/);
});
test('partial delivery never advances the last fully delivered baseline',async()=>{
  const sent=[];const before=snapshot([topic('猫咪救助')]);let writes=0;
  const titles=Array.from({length:7},(_,i)=>'猫咪救助'+i);
  await assert.rejects(runDigest({webhook,config,historyStore:{load:async()=>before,save:async()=>{writes++;}},
    fetcher:reader(titles,sent,n=>json({code:n===1?0:19024}))}),/此前已确认 1 条/);
  assert.equal(sent.length,2);assert.equal(writes,0);
});
test('read failure labels items un-compared; save failure does not resend delivered messages',async()=>{
  const sent=[];let writes=0;
  const unreadable=await runDigest({webhook,config,historyStore:{load:async()=>{throw Error('private');},save:async()=>{writes++;}},
    fetcher:reader(['猫咪救助'],sent)});
  assert.equal(unreadable.comparison_status,'unavailable');assert.equal(unreadable.new_items,0);
  assert.equal(writes,0);assert.match(JSON.stringify(sent),/⚪ 未比较/);
  sent.length=0;
  const unsaved=await runDigest({webhook,config,historyStore:{load:async()=>null,save:async()=>{throw Error('private');}},
    fetcher:reader(['猫咪救助'],sent)});
  assert.equal(unsaved.delivered,1);assert.equal(unsaved.history_saved,false);assert.equal(sent.length,1);
});
test('test/preview/empty digests never change history',async()=>{
  let reads=0,writes=0;const store={load:async()=>{reads++;return null;},save:async()=>{writes++;}};
  const sent=[];
  await runDigest({mode:'preview',config,historyStore:store,fetcher:reader(['猫咪救助'],sent)});
  await runDigest({webhook,config,historyStore:store,fetcher:reader([],sent)});
  assert.equal(reads,0);assert.equal(writes,0);assert.equal(sent.length,0);
});
test('text fallback retains novelty badges and original links',async()=>{
  const marked=compareDigest([topic('狗狗救助')],snapshot([topic('猫咪救助')]));
  const payload=makePayloads(marked.items,settings,[],1,'normal',new Date(),marked)[0];const sent=[];
  await sendFeishu([payload],webhook,async(url,opts)=>{sent.push(JSON.parse(opts.body));return json({code:sent.length===1?19002:0});},AbortSignal.timeout(1000));
  assert.match(sent[1].content.text,/🆕 新增/);assert.match(sent[1].content.text,/https:\/\/www.baidu.com\/a/);
});
