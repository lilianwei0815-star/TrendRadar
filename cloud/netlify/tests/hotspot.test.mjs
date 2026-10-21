import test from 'node:test';
import assert from 'node:assert/strict';
import {settings} from '../.generated/settings.mjs';
import {loadRules,classify,allowedUrl,normalizeItems,selectItems,metadataDescriptions,usefulDescription,
  makePayloads,sendFeishu,runDigest,mapLimit} from '../lib/hotspot.mjs';
import {signature,authenticate} from '../lib/auth.mjs';

const rules=loadRules();
const source={id:'baidu',name:'百度',expected_domain:'baidu.com'};
const result=(items,s=source)=>({source:s,items,error:null});
const webhook='https://open.feishu.cn/open-apis/bot/v2/hook/test-only-not-a-real-token';
const json=data=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});

test('retains original interests, adds memes, and preserves every exclusion',()=> {
  assert.equal(rules.groups.length,7); assert.equal(rules.blocked.length,24);
  for (const word of rules.blocked) assert.equal(classify(`猫咪治愈${word}`,rules),null);
  assert.equal(classify('社会关注',rules),null); assert.equal(classify('宠物 点赞',rules),null);
});
test('groups news into distinct sections without claiming hot-search titles are viral videos',()=> {
  const item=(category,title)=>({category,title,url:'https://www.baidu.com/a',summary:'来源摘要',sources:['百度'],summary_origin:'原文摘要摘录'});
  const payloads=makePayloads([
    item('社会热点与舆情','热点事件：官方通报'),item('萌宠垂类','流浪猫被救助'),
    item('网络热梗','这个新梗是什么梗'),item('AI萌宠博主与爆款','AI萌宠短片爆款话题')],settings,[],4,'normal');
  const rows=payloads.flatMap(p=>p.content.post.zh_cn.content);
  const headings=rows.filter(row=>row[0]?.style?.includes('bold')).map(row=>row[0].text);
  assert.deepEqual(headings,[
    '━━ 萌宠与猫狗热点（1条）━━','━━ 网络热梗（1条）━━',
    '━━ 公共社会热点（1条）━━','━━ 其他创作线索（视频热度未核实）（1条）━━']);
  assert.equal(headings.some(x=>/AI萌宠短片爆款|AI短片爆款|短视频爆款/.test(x)),false);
  assert.equal(classify('这个新梗是什么梗',rules),'网络热梗');
  assert.equal(rows.filter(row=>/^\d+\. /.test(row[0]?.text || '')).length,4);
});
test('successful collection with no useful matches sends no filler message',async()=> {
  let sends=0;
  const report=await runDigest({mode:'normal',webhook,config:{...settings,sources:[source]},fetcher:async url=> {
    if (String(url).includes('open.feishu.cn')) { sends++; return json({code:0}); }
    return json({status:'success',items:[{title:'普通内容无关键词',url:'https://www.baidu.com/a'}]});
  }});
  assert.equal(report.messages,0); assert.equal(report.delivered,0); assert.equal(sends,0);
});
test('uses most specific category and treats spaces as AND',()=> {
  assert.match(classify('AI萌宠博主新作',rules),/AI萌宠/);
  const synthetic={groups:[{name:'目标',words:['萌宠 百万赞']}],blocked:['广告']};
  assert.equal(classify('百万赞的萌宠视频',synthetic),'目标');
  assert.equal(classify('萌宠视频',synthetic),null);
});
test('restricts source domains and merges equivalent titles',()=> {
  const selected=normalizeItems([result([{title:'猫咪很治愈',url:'https://www.baidu.com/a?a=1&amp;b=2'},
    {title:'猫咪广告',url:'https://www.baidu.com/a'}, {title:'狗狗',url:'https://baidu.com.evil.test/a'}]),
    result([{title:'猫咪 很治愈',url:'https://www.douyin.com/a'}],{name:'抖音',expected_domain:'douyin.com'})],rules);
  assert.equal(selected.length,1); assert.equal(selected[0].sources.length,2);
  assert.equal(selected[0].url,'https://www.baidu.com/a?a=1&b=2');
  for (const url of ['http://baidu.com','https://baidu.com.evil.test','https://x@baidu.com','https://baidu.com:444']) assert.equal(allowedUrl(url,'baidu.com'),false);
});
test('round robin includes smaller categories',()=> {
  const custom={groups:[{name:'A'},{name:'B'}]};
  const selected=selectItems([{category:'A',sources:['x'],rank:1},{category:'A',sources:['x'],rank:2},
    {category:'B',sources:['y'],rank:10}],custom,2);
  assert.deepEqual(selected.map(x=>x.category),['A','B']);
});
test('metadata parser handles quotes, entities and greater-than signs',()=> {
  const meta=metadataDescriptions(`<meta content='猫咪救助：社区一起为流浪猫寻找安全住所，&quot;新家&quot; &gt; 漂泊。' property="og:description">`);
  assert.ok(meta['og:description'].includes('"新家" > 漂泊。'));
  assert.equal(usefulDescription('猫咪救助时遇到安全验证，请登录后查看完整内容','猫咪救助'),false);
});
test('messages use Beijing time and every full request stays below 20KB',()=> {
  const items=Array.from({length:60},(_,i)=>({category:'萌宠',title:'猫咪'+i,url:'https://www.baidu.com/a',
    summary:'猫咪'.repeat(90),sources:['百度'],summary_origin:'原文摘要摘录'}));
  const payloads=makePayloads(items,settings,[],60,'normal',new Date('2026-10-20T00:00:00Z'));
  assert.ok(payloads.length>1); assert.match(payloads[0].content.post.zh_cn.title,/2026-10-20 08:00/);
  for (const payload of payloads) assert.ok(Buffer.byteLength(JSON.stringify(payload))<20000);
});
test('connection-test message cannot be confused with a scheduled digest',()=> {
  const payload=makePayloads([],settings,[],0,'test');
  assert.match(JSON.stringify(payload),/不代表新闻抓取或定时任务已验证/);
});
test('rejects Feishu business errors and never leaks webhook credentials',async()=> {
  await assert.rejects(sendFeishu([{}],webhook,async()=>json({code:19024}),AbortSignal.timeout(1000)),
    e=>!e.message.includes('test-only-not-a-real-token') && /飞书发送失败/.test(e.safeMessage));
});
test('all source failures stop sending rather than claiming no matches',async()=> {
  let sends=0;
  await assert.rejects(runDigest({mode:'normal',webhook,config:{...settings,sources:[source]},fetcher:async url=>{
    if (String(url).includes('open.feishu.cn')) sends++;
    return new Response(null,{status:503});
  }}),/所有平台均抓取失败/);
  assert.equal(sends,0);
});
test('normal run sends source summary and labels unavailable summaries honestly',async()=> {
  const sent=[];
  const report=await runDigest({mode:'normal',webhook,config:{...settings,sources:[source]},fetcher:async (url,options)=> {
    if (String(url).includes('open.feishu.cn')) { sent.push(JSON.parse(options.body)); return json({code:0}); }
    if (String(url).includes('newsnow')) return json({status:'success',items:[
      {title:'社区救助流浪猫',url:'https://www.baidu.com/a',description:'社区居民共同救助流浪猫，为受伤猫咪提供食物和临时住所。'},
      {title:'狗狗陪伴老人',url:'https://www.baidu.com/b'}]});
    return new Response('验证',{headers:{'Content-Type':'text/html'}});
  }});
  assert.equal(report.matched,2); assert.equal(report.summaries,1); assert.equal(report.delivered,1);
  assert.match(JSON.stringify(sent),/暂未获取到可靠的中文原文摘要/);
});
test('article redirects cannot request an unrelated server',async()=> {
  const calls=[];
  await runDigest({mode:'preview',config:{...settings,sources:[source]},fetcher:async url=> {
    calls.push(String(url));
    if (String(url).includes('newsnow')) return json({status:'success',items:[{title:'狗狗陪伴老人',url:'https://www.baidu.com/b'}]});
    return new Response(null,{status:302,headers:{Location:'https://unrelated.test/private'}});
  }});
  assert.equal(calls.some(x=>x.includes('unrelated.test')),false);
});
test('internal calls require matching body, a strong secret, allowed mode and recent timestamp',()=> {
  const secret='test-secret-'.repeat(4),now=1000000;
  const body=JSON.stringify({mode:'normal',requested_at:now});
  assert.equal(authenticate(body,signature(body,secret),secret,now).mode,'normal');
  assert.equal(authenticate(body,signature(body,secret),'different-secret-'.repeat(3),now),null);
  assert.equal(authenticate(body,signature(body,secret),secret,now+300001),null);
  assert.equal(authenticate(body+' ',signature(body,secret),secret,now),null);
  const bad=JSON.stringify({mode:'anything',requested_at:now});
  assert.equal(authenticate(bad,signature(bad,secret),secret,now),null);
});
test('concurrent work stays bounded and results retain source order',async()=> {
  let active=0,peak=0;
  const output=await mapLimit([1,2,3,4],2,async x=> {
    active++; peak=Math.max(peak,active); await new Promise(resolve=>setTimeout(resolve,2)); active--; return x*2;
  });
  assert.equal(peak,2); assert.deepEqual(output,[2,4,6,8]);
});
test('background handler refuses unauthenticated requests without fetching',async()=> {
  const {default:handler}=await import('../functions/hotspot-background.mjs');
  const oldFetch=globalThis.fetch,oldSecret=process.env.HOTSPOT_INTERNAL_SECRET;
  process.env.HOTSPOT_INTERNAL_SECRET='test-secret-'.repeat(4);
  globalThis.fetch=()=>{throw Error('should not request anything');};
  try { await handler(new Request('https://example.test',{method:'POST',body:'{}'})); }
  finally { globalThis.fetch=oldFetch; if (oldSecret===undefined) delete process.env.HOTSPOT_INTERNAL_SECRET; else process.env.HOTSPOT_INTERNAL_SECRET=oldSecret; }
});
test('scheduler signs the exact event sent to its own background function',async()=> {
  const {default:schedule}=await import('../functions/hotspot-schedule.mjs');
  const previous={fetch:globalThis.fetch,URL:process.env.URL,secret:process.env.HOTSPOT_INTERNAL_SECRET,mode:process.env.HOTSPOT_MODE};
  process.env.URL='https://test-only-hotspot.netlify.app';
  process.env.HOTSPOT_INTERNAL_SECRET='test-secret-'.repeat(4); process.env.HOTSPOT_MODE='normal';
  let event;
  globalThis.fetch=async (url,options)=> {
    assert.equal(String(url),'https://test-only-hotspot.netlify.app/.netlify/functions/hotspot-background');
    event=authenticate(options.body,options.headers['X-Hotspot-Signature'],process.env.HOTSPOT_INTERNAL_SECRET);
    return new Response(null,{status:202});
  };
  try { assert.equal((await schedule()).status,204); assert.equal(event.mode,'normal'); }
  finally {
    globalThis.fetch=previous.fetch;
    for (const [key,value] of [['URL',previous.URL],['HOTSPOT_INTERNAL_SECRET',previous.secret],['HOTSPOT_MODE',previous.mode]]) {
      if (value===undefined) delete process.env[key]; else process.env[key]=value;
    }
  }
});
