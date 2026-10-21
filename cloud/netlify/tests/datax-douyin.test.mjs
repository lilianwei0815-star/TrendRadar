import test from 'node:test';
import assert from 'node:assert/strict';
import {dataxVideo,collectDataxDouyin} from '../lib/datax-douyin.mjs';
import {normalizeItems,loadRules,makePayloads,collectSources,runDigest} from '../lib/hotspot.mjs';
import {settings} from '../.generated/settings.mjs';

const now=Date.parse('2026-10-21T04:00:00Z');
const source={id:'douyin-datax-video',name:'抖音爆款视频线索',expected_domain:'douyin.com',
  provider:'dataxapi-douyin',kind:'video_chart',priority:0,required_video_discovery:true};
const secrets={DATAXAPI_DOUYIN_ENABLED:'true',DATAXAPI_API_KEY:'test-only-not-a-real-key'};
const json=data=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
const raw=(i=0,more={})=>({id:String(7698253259862421400n+BigInt(i)),
  url:'https://www.douyin.com/video/'+String(7698253259862421400n+BigInt(i)),
  type:'video',text:'橘猫陪伴家人的温暖故事，大家一起度过平凡又幸福的一天。',
  published_at:'2026-10-20T05:54:23.000Z',author:{name:'示例作者',followers:3000},
  metrics:{likes:150000,views:1000000},...more});

test('DataX rejects images, tutorials, old works, spoofed URLs, ID mismatches and invalid counters',()=>{
  assert.ok(dataxVideo(raw(),{now}));
  for (const item of [raw(0,{type:'image'}),raw(0,{text:'AI萌宠保姆级教程'}),
    raw(0,{published_at:'2026-01-01T00:00:00Z'}),raw(0,{published_at:'2026-10-22T00:00:00Z'}),
    raw(0,{url:'https://www.douyin.com.evil.test/video/7698253259862421400'}),
    raw(0,{url:'https://www.douyin.com/video/7698253259862421401'}),
    raw(0,{url:'https://secret@www.douyin.com/video/7698253259862421400'}),
    raw(0,{metrics:{likes:'150000'}}),raw(0,{metrics:{likes:-1}})]) assert.equal(dataxVideo(item,{now}),null);
});

test('DataX only calls enabled runtime sources; build probes and missing credentials never call',async()=>{
  const fetcher=()=>{throw Error('must not call');};
  for (const options of [{secrets:{}},{secrets:{DATAXAPI_DOUYIN_ENABLED:'true'}},
    {secrets,allowCredentialSources:false}]) {
    const result=await collectDataxDouyin(source,fetcher,AbortSignal.timeout(1000),options);
    assert.equal(result.items.length,0); assert.ok(result.error);
  }
  const results=await collectSources({...settings,sources:[source]},fetcher,AbortSignal.timeout(1000),
    {secrets,allowCredentialSources:false});
  assert.match(results[0].error,/构建不调用/);
});

test('DataX rechecks detail likes, never combines chart views/fans with current counters, and labels captions',async()=>{
  const calls=[];
  const fetcher=async(url,options)=>{
    calls.push(String(url));
    assert.equal(url.origin,'https://api.dataxapi.com');
    assert.equal(options.redirect,'error');
    assert.equal(options.headers.Authorization,'Bearer test-only-not-a-real-key');
    assert.equal(url.href.includes('test-only-not-a-real-key'),false);
    assert.equal(options.headers['X-Max-Price'],url.pathname.endsWith('/search')?'0.020':'0.002');
    if (url.pathname.endsWith('/trending')) return json({code:'ok',data:{items:[raw()]}});
    if (url.pathname.endsWith('/search')) return json({code:'ok',data:{items:[]}});
    return json({code:'ok',data:{item:raw(0,{author:{name:'示例作者'},
      metrics:{likes:1440146,comments:27000,shares:1550000}})},meta:{fetched_at:new Date(now).toISOString()}});
  };
  const result=await collectDataxDouyin(source,fetcher,AbortSignal.timeout(1000),{secrets,now});
  assert.equal(calls.length,4); assert.equal(result.items.length,1);
  assert.match(result.items[0].extra.info,/1440146点赞/);
  assert.doesNotMatch(result.items[0].extra.info,/观看|粉丝|150000点赞/);
  const items=normalizeItems([result],loadRules());
  assert.equal(items[0].kind,'video'); assert.ok(items[0].video_evidence);
  const payload=JSON.stringify(makePayloads(items.map(x=>({...x,summary:'原文',summary_origin:'视频文案摘录'})),settings,[],1,'normal'));
  assert.match(payload,/数据查询：/);
});

test('DataX preserves category diversity, applies thresholds, and has a hard nine-request/$0.054 ceiling',async()=>{
  const requests=[];
  const chart=Array.from({length:15},(_,i)=>raw(i));
  const pet=Array.from({length:15},(_,i)=>raw(20+i,{text:'AI萌宠短片：小猫帮助大家的故事'}));
  const film=Array.from({length:15},(_,i)=>raw(40+i,{text:'AI短片：暖心的城市故事'}));
  const all=[...chart,...pet,...film];
  const result=await collectDataxDouyin({...source,discovery:{max_detail_requests:10000}},async(url,options)=>{
    requests.push({path:url.pathname,price:Number(options.headers['X-Max-Price'])});
    if (url.pathname.endsWith('/trending')) return json({code:'ok',data:{items:chart}});
    if (url.pathname.endsWith('/search')) return json({code:'ok',data:{items:url.searchParams.get('query')==='AI萌宠'?pet:film}});
    return json({code:'ok',data:{item:all.find(x=>x.id===url.searchParams.get('id'))}});
  },AbortSignal.timeout(1000),{secrets,now});
  assert.equal(requests.length,9); assert.equal(result.diagnostics.max_request_cost_usd,0.054);
  assert.equal(result.items.length,6);
  assert.equal(new Set(normalizeItems([result],loadRules()).map(x=>x.category)).size,3);
  const rejected=await collectDataxDouyin(source,async url=>json({code:'ok',data:url.pathname.endsWith('/get')?
    {item:raw(0,{metrics:{likes:10}})}:{items:[raw()]}}),AbortSignal.timeout(1000),{secrets,now});
  assert.equal(rejected.items.length,0);
});

test('DataX errors stop credentials/paid calls without retries or leaking response bodies',async()=>{
  let calls=0;
  const failed=await collectDataxDouyin(source,async()=>{calls++;return new Response('test-only-not-a-real-key',{status:402});},
    AbortSignal.timeout(1000),{secrets,now});
  assert.equal(calls,1); assert.ok(failed.error);
  assert.deepEqual(failed.diagnostics.failure_kinds,['http_402']);
  assert.equal(JSON.stringify(failed).includes('test-only-not-a-real-key'),false);
  assert.equal(failed.items.length,0);
});

test('DataX detail ID mismatches cannot promote a different video into the digest',async()=>{
  const result=await collectDataxDouyin(source,async url=>json({code:'ok',data:url.pathname.endsWith('/get')?
    {item:raw(1)}:{items:[raw()]}}),AbortSignal.timeout(1000),{secrets,now});
  assert.equal(result.items.length,0);
  const forged=normalizeItems([{source,items:[{title:'AI猫咪故事',url:raw().url,
    extra:{info:'作者 · 100万观看 · 10万点赞'}}],error:null}],loadRules());
  assert.equal(forged.length,0);
});

test('DataX candidates repeated across searches are only detail-checked once',async()=>{
  let details=0;
  const result=await collectDataxDouyin(source,async url=>{
    if (url.pathname.endsWith('/get')) { details++; return json({code:'ok',data:{item:raw()}}); }
    return json({code:'ok',data:{items:[raw()]}});
  },AbortSignal.timeout(1000),{secrets,now});
  assert.equal(details,1); assert.equal(result.items.length,1);
});

test('disabled DataX integration does not alter ordinary runtime digests',async()=>{
  const report=await runDigest({mode:'preview',secrets:{},config:{...settings,sources:[source,
    {id:'baidu',name:'百度',expected_domain:'baidu.com'}]},fetcher:async url=>{
    assert.equal(String(url).includes('dataxapi'),false);
    return json({status:'success',items:[]});
  }});
  assert.equal(report.successful_sources,1); assert.deepEqual(report.failed_sources,[]);
});
