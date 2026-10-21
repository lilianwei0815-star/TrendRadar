// Fixed provider routes; never forward credentials to redirects or video pages.
const ORIGIN='https://api.dataxapi.com';
const count=x=>typeof x==='number' && Number.isSafeInteger(x) && x>=0;
const text=x=>typeof x==='string'?x.replace(/<[^>]*>/g,' ').replace(/\s+/gu,' ').trim():'';
const tutorial=/教程|教学|保姆级|零基础|手把手|制作全流程|节省积分|省着花/u;
const paths={chart:'/v1/douyin/videos/trending',search:'/v1/douyin/videos/search',detail:'/v1/douyin/videos/get'};

export function dataxVideo(raw,{now=Date.now(),maxAgeDays=7}={}) {
  if (!raw || raw.type!=='video' || !/^\d{15,22}$/.test(raw.id || '')) return null;
  let url;
  try { url=new URL(raw.url); } catch { return null; }
  if (url.protocol!=='https:' || url.hostname!=='www.douyin.com' || url.username || url.password || url.port
      || url.pathname!=='/video/'+raw.id) return null;
  const description=text(raw.text),title=text(raw.title) || description.split(/[#\n]/u)[0].trim();
  const author=text(raw.author?.name),published=Date.parse(raw.published_at);
  if (!title || !author || tutorial.test(title+' '+description) || !count(raw.metrics?.likes)
      || !Number.isFinite(published) || published>now+300000 || published<now-maxAgeDays*86400000) return null;
  return {id:raw.id,title:title.slice(0,1024),description:description.slice(0,10000),author,
    url:'https://www.douyin.com/video/'+raw.id,published,likes:raw.metrics.likes,
    followers:count(raw.author?.followers)?raw.author.followers:null,
    comments:count(raw.metrics.comments)?raw.metrics.comments:null,
    shares:count(raw.metrics.shares)?raw.metrics.shares:null};
}

export function dataxCategory(item) {
  const body=(item.title+' '+item.description).normalize('NFKC').toLowerCase();
  const ai=/\bai\b|aigc|ai创作|ai动画|ai短片|ai短剧|ai萌宠|ai猫|ai狗|人工智能生成/.test(body);
  return ai && /猫|狗|萌宠|宠物/.test(body)?'pet':ai && /动画|短片|短剧|剧情|故事/.test(body)?'film':'other';
}

function eligible(item,config) {
  const ai=dataxCategory(item)!=='other';
  return item.likes>=(ai?config.ai_min_likes:config.min_likes)
    || (item.followers!==null && item.followers<=config.low_fan_max_followers
      && item.likes>=config.low_fan_min_likes && item.likes>=Math.max(1,item.followers)*config.low_fan_like_ratio);
}

export async function collectDataxDouyin(source,fetcher,signal,
    {secrets=process.env,allowCredentialSources=true,now=Date.now()}={}) {
  const empty=error=>({source,items:[],error});
  if (!allowCredentialSources) return empty('构建不调用付费接口；仅运行时验证');
  if (secrets.DATAXAPI_DOUYIN_ENABLED!=='true') return empty('抖音视频接口尚未启用');
  const key=secrets.DATAXAPI_API_KEY?.trim();
  if (!key) return empty('待配置 DATAXAPI_API_KEY');
  const cfg={max_age_days:7,min_likes:100000,ai_min_likes:10000,low_fan_max_followers:10000,
    low_fan_min_likes:5000,low_fan_like_ratio:2,...source.discovery};
  // One page per query, no pagination/retries. Hard ceilings survive config mistakes.
  const maxDetails=Math.min(6,Math.max(0,Math.floor(cfg.max_detail_requests ?? 6)));
  let spent=0,calls=0,stopped=false,failures=0;
  const failureKinds=[];
  const get=async(kind,params)=> {
    const units=kind==='search'?20:2; // units of $0.001; at most $0.054 per digest
    if (stopped || signal.aborted || calls>=9 || spent+units>54) return null;
    calls++; spent+=units;
    const url=new URL(paths[kind],ORIGIN);
    for (const [name,value] of Object.entries({...params,view:'full'})) url.searchParams.set(name,value);
    let failureKind='network_or_timeout';
    try {
      const response=await fetcher(url,{headers:{Authorization:'Bearer '+key,Accept:'application/json',
        'X-Max-Price':(units/1000).toFixed(3)},redirect:'error',
        signal:AbortSignal.any([signal,AbortSignal.timeout(12000)])});
      if (!response.ok) {
        failureKind='http_'+response.status;
        if ([401,402,403,429].includes(response.status)) stopped=true;
        await response.body?.cancel(); throw Error();
      }
      failureKind='invalid_response';
      if (!response.body) throw Error();
      const reader=response.body.getReader(),chunks=[]; let size=0;
      try {
        while (true) {
          const part=await reader.read(); if (part.done) break;
          size+=part.value.byteLength; if (size>1000000) throw Error(); chunks.push(part.value);
        }
      } finally { await reader.cancel().catch(()=>{}); }
      const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (data.code!=='ok') { stopped=true; throw Error(); }
      return data;
    } catch { failures++; failureKinds.push(failureKind); return null; } // Never log provider bodies, headers, URLs or secrets.
  };
  const options={now,maxAgeDays:Math.min(7,Math.max(1,cfg.max_age_days))};
  const pools=[new Map(),new Map(),new Map()];
  const add=data=> {
    if (!Array.isArray(data?.data?.items)) return;
    for (const raw of data.data.items) {
      const item=dataxVideo(raw,options); if (!item || !eligible(item,cfg)) continue;
      for (const pool of pools) pool.delete(item.id);
      pools[dataxCategory(item)==='pet'?0:dataxCategory(item)==='film'?1:2].set(item.id,item);
    }
  };
  add(await get('chart',{board:'low_fan'}));
  for (const query of ['AI萌宠','AI短片']) add(await get('search',{query,sort:'popular',published_within:'week'}));
  const buckets=pools.map(pool=>[...pool.values()].sort((a,b)=>b.likes-a.likes));
  const candidates=[];
  while (candidates.length<maxDetails && buckets.some(x=>x.length)) {
    for (const bucket of buckets) if (bucket.length && candidates.length<maxDetails) candidates.push(bucket.shift());
  }
  const items=[];
  for (const candidate of candidates) {
    const response=await get('detail',{id:candidate.id});
    const item=dataxVideo(response?.data?.item,options);
    if (!item || item.id!==candidate.id || !eligible({...item,followers:candidate.followers},cfg)) continue;
    const metrics=[item.author,`${item.likes}点赞`,
      ...(item.comments!==null?[`${item.comments}评论`]:[]),...(item.shares!==null?[`${item.shares}分享`]:[])];
    const at=Date.parse(response.meta?.fetched_at);
    // Do not present chart views/fans as verified current detail metrics.
    items.push({title:item.title,url:item.url,description:item.description,pubDate:item.published,
      detail_verified:true,detail_likes:item.likes,
      video_evidence:'榜单或搜索发现；详情互动数据已复核；播放量、实时粉丝及增速未核实',
      metrics_checked_at:Number.isFinite(at)&&Math.abs(at-now)<86400000?new Date(at).toISOString():new Date(now).toISOString(),
      extra:{info:metrics.join(' · '),hover:item.description}});
  }
  return {source,items,error:failures && !items.length?'抖音视频接口未能取得可核实作品；请检查额度及服务状态':null,
    diagnostics:{requests:calls,max_request_cost_usd:spent/1000,failed_requests:failures,
      failure_kinds:failureKinds,verified:items.length}};
}
