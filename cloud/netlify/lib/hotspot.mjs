import {settings,ruleText} from '../.generated/settings.mjs';
import {collectDataxDouyin} from './datax-douyin.mjs';

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const missing = '暂未获取到可靠的中文原文摘要，请查看原文。';
const safeError = message => Object.assign(new Error(message),{safeMessage:message});
const normalized = value => String(value).normalize('NFKC').toLowerCase();
const textRow = text => [{tag:'text',text}];

export function decodeEntities(value) {
  const entities = {amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' '};
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (match,key)=> {
    if (key[0]!=='#') return entities[key.toLowerCase()];
    const point = key[1].toLowerCase()==='x' ? parseInt(key.slice(2),16) : parseInt(key.slice(1),10);
    return point>0 && point<=0x10ffff && !(point>=0xd800 && point<=0xdfff) ? String.fromCodePoint(point) : '';
  });
}
export const cleanText = value => decodeEntities(String(value).replace(/<[^>]+>/g,' ')).replace(/\s+/gu,' ').trim();

export function loadRules(text=ruleText) {
  const groups=[], blocked=[];
  let current;
  for (const raw of text.split(/\r?\n/)) {
    const line=raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('!')) blocked.push(normalized(line.slice(1)));
    else if (line.startsWith('[') && line.endsWith(']')) {
      current={name:line.slice(1,-1),words:[]}; groups.push(current);
    } else if (current) current.words.push(line);
  }
  if (!groups.length || !blocked.length) throw safeError('关键词分组或屏蔽词为空');
  return {groups,blocked};
}

export function classify(title,rules) {
  const text=normalized(title);
  if (rules.blocked.some(word=>text.includes(word))) return null;
  let best=null, score=-1;
  for (const group of rules.groups) for (const phrase of group.words) {
    const tokens=normalized(phrase).split(/\s+/).filter(Boolean);
    const length=tokens.reduce((n,token)=>n+[...token].length,0);
    if (length>score && tokens.length && tokens.every(token=>text.includes(token))) {
      best=group.name; score=length;
    }
  }
  return best;
}

export function allowedUrl(raw,domain) {
  try {
    const url=new URL(raw);
    return url.protocol==='https:' && !url.username && !url.password && !url.port &&
      (url.hostname===domain || url.hostname.endsWith('.'+domain));
  } catch { return false; }
}

export async function mapLimit(values,concurrency,fn) {
  const result=new Array(values.length);
  let next=0;
  await Promise.all(Array.from({length:Math.min(concurrency,values.length)},async()=> {
    while (next<values.length) { const index=next++; result[index]=await fn(values[index],index); }
  }));
  return result;
}

async function readLimited(response,maxBytes) {
  if (!response.body) return '';
  const reader=response.body.getReader(), chunks=[];
  let length=0;
  try {
    while (true) {
      const {value,done}=await reader.read();
      if (done) break;
      length+=value.byteLength;
      if (length>maxBytes) throw safeError('来源响应超过大小限制');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(()=>{}); }
  const bytes=new Uint8Array(length);
  let offset=0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset+=chunk.byteLength; }
  const charset=/charset\s*=\s*([^;\s]+)/i.exec(response.headers.get('content-type') || '')?.[1];
  let decoder;
  try { decoder=new TextDecoder(charset || 'utf-8'); } catch { decoder=new TextDecoder(); }
  return decoder.decode(bytes);
}

function requestSignal(signal,ms) { return AbortSignal.any([signal,AbortSignal.timeout(ms)]); }

export function parseNativeSource(type,body) {
  if (type==='kuaishou-topics') {
    const match=body.match(/window\.__APOLLO_STATE__\s*=\s*(\{[\s\S]+?\});/);
    if (!match) throw safeError('快手页面未提供公开热榜数据');
    const client=JSON.parse(match[1]).defaultClient;
    const rank=client[client.ROOT_QUERY['visionHotRank({"page":"home"})'].id];
    if (!Array.isArray(rank.items)) throw safeError('快手热榜格式异常');
    return rank.items.map(ref=>client[ref.id]).filter(item=>item && item.tagType!=='置顶' && typeof item.name==='string')
      .map(item=>({title:item.name,url:'https://www.kuaishou.com/search/video?searchKey='+encodeURIComponent(item.name)}));
  }
  const data=JSON.parse(body);
  if (data.code!==0 || !Array.isArray(data.data?.list)) throw safeError('B站接口未返回有效榜单');
  return data.data.list.filter(raw=>typeof raw.bvid==='string' && /^BV[0-9A-Za-z]+$/.test(raw.bvid)
    && typeof raw.owner?.name==='string' && Number.isFinite(raw.stat?.view) && Number.isFinite(raw.stat?.like))
    .map(raw=>({title:raw.title,url:'https://www.bilibili.com/video/'+raw.bvid,
      pubDate:Number(raw.pubdate)*1000,duration:Number(raw.duration),
      source_category:raw.tname==='电子竞技'?'游戏':raw.tname || '',
      extra:{info:`${raw.owner.name} · ${raw.stat.view}观看 · ${raw.stat.like}点赞`,hover:raw.desc || ''}}));
}

export function parseDouyinVideos(body) {
  const data=JSON.parse(body);
  // Do not surface provider errors: they may echo request credentials.
  if (data.error_code!==0 || !Array.isArray(data.result)) throw safeError('抖音视频接口未返回有效榜单');
  return data.result.flatMap(raw=> {
    if (!raw || typeof raw.title!=='string' || typeof raw.author!=='string') return [];
    let url;
    try { url=new URL(raw.share_url); } catch { return []; }
    const id=allowedUrl(url.href,'iesdouyin.com') ? /^\/share\/video\/(\d{15,22})\/?$/.exec(url.pathname)?.[1]
      : allowedUrl(url.href,'douyin.com') ? /^\/video\/(\d{15,22})\/?$/.exec(url.pathname)?.[1] : null;
    const counts=[raw.play_count,raw.digg_count,raw.comment_count];
    if (!id || !counts.every(value=>typeof value==='number' && Number.isSafeInteger(value) && value>=0)) return [];
    // Strip tracking parameters and use the canonical work URL, never a topic search.
    return [{title:raw.title,url:'https://www.douyin.com/video/'+id,
      extra:{info:`${raw.author} · ${raw.play_count}观看 · ${raw.digg_count}点赞 · ${raw.comment_count}评论`}}];
  });
}

async function fetchSource(source,config,fetcher,signal,{secrets=process.env,allowCredentialSources=true}={}) {
  if (source.provider==='dataxapi-douyin') return collectDataxDouyin(source,fetcher,signal,{secrets,allowCredentialSources});
  if (source.provider==='juhe-douyin') {
    if (!allowCredentialSources) return {source,items:[],error:'需运行时凭证验证；构建不调用此接口'};
    const key=secrets.JUHE_DOUYIN_API_KEY?.trim();
    if (!key) return {source,items:[],error:'待配置 JUHE_DOUYIN_API_KEY 并验收实际视频数据'};
    try {
      // One call per digest, no retries, no paid fallback. Key goes only to this fixed HTTPS endpoint.
      const response=await fetcher('https://apis.juhe.cn/fapig/douyin/billboard',{
        method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({key,type:'hot_video',size:'50'}).toString(),
        redirect:'error',signal:requestSignal(signal,12000)});
      if (!response.ok) { await response.body?.cancel(); throw Error(); }
      return {source,items:parseDouyinVideos(await readLimited(response,1000000)),error:null};
    } catch { return {source,items:[],error:'抖音视频接口失败，请检查免费额度、Key权限及来源数据'}; }
  }
  let failure='网络错误';
  const nativeRoutes={'bilibili-popular':'https://api.bilibili.com/x/web-interface/popular?ps=20&pn=1',
    'bilibili-ranking':'https://api.bilibili.com/x/web-interface/ranking/v2',
    'kuaishou-topics':'https://www.kuaishou.com/?isHome=1'};
  const failures=[];
  for (let attempt=0;attempt<2;attempt++) {
    if (attempt) await new Promise(resolve=>setTimeout(resolve,1000));
    try {
      const use60s=source.provider==='60s' || (attempt===1 && source.fallback_url);
      const native=attempt===0 && nativeRoutes[source.native_type];
      const url=native ? new URL(native) : use60s ? new URL(source.provider==='60s' ? source.api_urls[Math.min(attempt,source.api_urls.length-1)] : source.fallback_url) : new URL(config.api_url);
      if (!use60s && !native) url.search=`?id=${encodeURIComponent(source.id)}&latest`;
      const response=await fetcher(url,{headers:{'User-Agent':UA,Accept:'application/json'},
        redirect:'error',signal:requestSignal(signal,12000)});
      if (!response.ok) { await response.body?.cancel(); failure=`${native?'直连':'聚合源'} HTTP ${response.status}`; failures.push(failure); continue; }
      const body=await readLimited(response,3000000);
      if (native) return {source,items:parseNativeSource(source.native_type,body),error:null};
      const data=JSON.parse(body);
      if (use60s) {
        if (data.code!==200 || !Array.isArray(data.data)) throw safeError('来源格式异常');
        return {source,items:data.data.map(raw=>({...raw,url:raw.link,heat:raw.score ?? raw.hot_value})),error:null};
      }
      if (!['success','cache'].includes(data.status) || !Array.isArray(data.items)) throw safeError('来源格式异常');
      return {source,items:data.items,error:null};
    } catch { failure=signal.aborted ? '任务达到时限' : '网络或来源格式错误'; failures.push(failure); }
    if (signal.aborted) break;
  }
  return {source,items:[],error:failures.join('；') || failure};
}

export async function collectSources(config,fetcher=fetch,signal=AbortSignal.timeout(90000),options={}) {
  const sourceSignal=AbortSignal.any([signal,AbortSignal.timeout(90000)]);
  return mapLimit([...config.sources].sort((a,b)=>(a.priority ?? 100)-(b.priority ?? 100)),3,
    source=>fetchSource(source,config,fetcher,sourceSignal,options));
}

export function videoCategory(title,description='') {
  const text=normalized(title+' '+description);
  const ai=/\bai\b|aigc|ai动画|ai短片|ai短剧|ai萌宠|ai猫|ai狗|人工智能生成/.test(text);
  if (ai && /猫|狗|萌宠|宠物/.test(text)) return 'AI萌宠热门视频';
  if (ai && /动画|短片|短剧|剧情|故事/.test(text)) return 'AI短片热门视频';
  return '热门视频作品';
}

export function normalizeItems(results,rules) {
  const items=[],seen=new Map();
  for (const {source,items:rawItems,error} of results) {
    if (error) continue;
    for (let i=0;i<rawItems.length;i++) {
      const raw=rawItems[i];
      if (!raw || typeof raw.title!=='string') continue;
      const title=cleanText(raw.title).slice(0,1024);
      const filterText=normalized(title+' '+(typeof raw.source_category==='string'?raw.source_category:''));
      if (rules.blocked.some(word=>filterText.includes(word))) continue;
      const rawUrl=raw.url || raw.mobileUrl;
      const url=typeof rawUrl==='string' ? decodeEntities(rawUrl) : '';
      if (!allowedUrl(url,source.expected_domain)) continue;
      const description=['description','summary','desc'].map(k=>typeof raw[k]==='string' ? cleanText(raw[k]).slice(0,10000) : '').find(Boolean)
        || (typeof raw.extra?.hover==='string' ? cleanText(raw.extra.hover).slice(0,10000) : '');
      const metrics=typeof raw.extra?.info==='string' ? cleanText(raw.extra.info).slice(0,500) : '';
      const videoPath=new URL(url).pathname;
      const workLink=(source.expected_domain==='bilibili.com' && /^\/video\/(?:BV[0-9A-Za-z]+|av\d+)\/?$/.test(videoPath))
        || (['juhe-douyin','dataxapi-douyin'].includes(source.provider) && source.expected_domain==='douyin.com' && /^\/video\/\d{15,22}\/?$/.test(videoPath));
      const verifiedDouyin=source.provider==='dataxapi-douyin' && raw.detail_verified===true
        && Number.isSafeInteger(raw.detail_likes) && raw.detail_likes>=0;
      const video=source.kind==='video_chart' && workLink
        && (source.provider==='dataxapi-douyin'?verifiedDouyin:
          /\d[\d.,wW万亿+]*\s*观看/.test(metrics) && /\d[\d.,wW万亿+]*\s*点赞/.test(metrics));
      if (source.kind==='video_chart' && !video) continue;
      const matched=classify(title,rules);
      const category=video ? videoCategory(title,description) : matched || (source.discover_topics ? '短视频平台热榜线索' : null);
      if (!category) continue;
      const key=video ? 'video:'+source.expected_domain+new URL(url).pathname : 'topic:'+normalized(title).replace(/[^\p{L}\p{N}]/gu,'');
      if (seen.has(key)) {
        const old=seen.get(key);
        if (!old.sources.includes(source.name)) old.sources.push(source.name);
        if ((source.priority ?? 100)<old.priority) {
          Object.assign(old,{url,domain:source.expected_domain,priority:source.priority,source_id:source.id});
        }
        old.rank=Math.min(old.rank,i+1); continue;
      }
      const item={title,url,category,sources:[source.name],rank:i+1,domain:source.expected_domain,description,
        priority:source.priority ?? 100,source_id:source.id,source_provider:source.provider,kind:video?'video':'topic',metrics:video?metrics:'',
        metrics_checked_at:verifiedDouyin?raw.metrics_checked_at:null,
        required_video_discovery:video && source.required_video_discovery===true,
        published_at:video && Number.isFinite(raw.pubDate) && raw.pubDate>0 && raw.pubDate<8640000000000000 ? new Date(raw.pubDate).toISOString() : null,
        duration:video && Number.isFinite(raw.duration) && raw.duration>0 ? raw.duration : null,
        heat:typeof raw.heat==='string' || typeof raw.heat==='number' ? String(raw.heat) : '',
        video_evidence:video?(verifiedDouyin?raw.video_evidence:
          `平台热门/排行榜上榜；${Number.isFinite(raw.duration) && raw.duration>0?'时长来自接口，':'时长、'}增速与账号历史未核实`):null};
      seen.set(key,item); items.push(item);
    }
  }
  return items;
}

export function selectItems(items,rules,limit) {
  const required=items.filter(item=>item.required_video_discovery).sort((a,b)=>a.rank-b.rank);
  items=items.filter(item=>!item.required_video_discovery);
  const names=[...new Set(['AI萌宠热门视频','AI短片热门视频','热门视频作品',...rules.groups.map(x=>x.name),'短视频平台热榜线索'])];
  const orderCategory=entries=> {
    const ordered=[];
    // Prioritize social/video platforms while interleaving them so that one
    // platform's long hot list cannot crowd every other platform out.
    for (const priorityTier of [true,false]) {
      const sources=new Map();
      const tier=entries.filter(item=>((item.priority ?? 100)<10)===priorityTier)
        .sort((a,b)=>(a.priority ?? 100)-(b.priority ?? 100)
          || (a.kind==='video' && b.kind==='video' ? Number(!(a.duration && a.duration<=600))-Number(!(b.duration && b.duration<=600)) : 0)
          || b.sources.length-a.sources.length || a.rank-b.rank);
      for (const item of tier) {
        const key=item.source_id || item.sources[0];
        if (!sources.has(key)) sources.set(key,[]);
        sources.get(key).push(item);
      }
      while ([...sources.values()].some(values=>values.length)) {
        for (const values of sources.values()) if (values.length) ordered.push(values.shift());
      }
    }
    return ordered;
  };
  const buckets=names.map(name=>orderCategory(items.filter(x=>x.category===name)));
  const selected=required.slice(0,limit);
  while (selected.length<limit && buckets.some(x=>x.length)) {
    for (const bucket of buckets) if (bucket.length && selected.length<limit) selected.push(bucket.shift());
  }
  return selected;
}

export function usefulDescription(description,title) {
  if (description.length<20 || description===title || !/[\u4e00-\u9fff]/u.test(description)) return false;
  const boilerplate=['请开启javascript','启用javascript','验证码','安全验证','访问验证','登录后查看',
    '专题，为您展现','相关内容及最新','百度一下，你就知道'];
  if (boilerplate.some(x=>description.toLowerCase().includes(x))) return false;
  const chars=new Set(title.match(/[\u4e00-\u9fff]/gu) || []);
  return [...chars].filter(c=>description.includes(c)).length>=Math.min(4,chars.size);
}

export function metadataDescriptions(html) {
  const descriptions={};
  const tags=html.match(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi) || [];
  for (const tag of tags) {
    const fields={};
    for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      fields[match[1].toLowerCase()]=match[2] ?? match[3] ?? match[4];
    }
    const key=(fields.property || fields.name || '').toLowerCase();
    if (['og:description','description','twitter:description'].includes(key)) descriptions[key]=cleanText(fields.content || '');
  }
  return descriptions;
}

async function summarize(item,fetcher,signal) {
  if (item.source_provider==='dataxapi-douyin') {
    const caption=cleanText(item.description.replace(/#[^\s#]+/gu,' '));
    const description=/[\u4e00-\u9fff]/u.test(caption)?caption:'';
    return {...item,summary:description?description.slice(0,180)+(description.length>180?'…':''):missing,
      summary_origin:description?'视频文案摘录':'摘要暂缺'};
  }
  let description=item.description, origin='热榜来源摘要';
  if (!usefulDescription(description,item.title)) {
    description=''; origin='原文摘要摘录';
    try {
      let url=item.url;
      for (let hops=0;hops<4;hops++) {
        if (!allowedUrl(url,item.domain)) break;
        const response=await fetcher(url,{headers:{'User-Agent':UA},redirect:'manual',signal:requestSignal(signal,7000)});
        if ([301,302,303,307,308].includes(response.status)) {
          const location=response.headers.get('location'); await response.body?.cancel();
          if (!location) break;
          url=new URL(location,url).href; continue;
        }
        if (!response.ok || !/html/i.test(response.headers.get('content-type') || '')) { await response.body?.cancel(); break; }
        const meta=metadataDescriptions(await readLimited(response,800000));
        description=['og:description','description','twitter:description']
          .map(k=>meta[k] || '').find(x=>usefulDescription(x,item.title)) || '';
        break;
      }
    } catch { /* Missing source text is labelled explicitly. */ }
  }
  return {...item,summary:description ? description.slice(0,180)+(description.length>180?'…':'') : missing,
    summary_origin:description ? origin : '摘要暂缺'};
}

export function makePayloads(items,config,failed,total,mode,now=new Date()) {
  const stamp=new Intl.DateTimeFormat('sv-SE',{timeZone:config.timezone,year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(now);
  const content=mode==='test' ? [textRow('连接测试：飞书机器人接口已收到请求。此消息不代表新闻抓取或定时任务已验证。'),
    textRow('计划：北京时间每天 08:00、18:00，标题＋原文链接＋中文摘要。')] :
    [textRow(`本次筛选匹配 ${total} 条，展示 ${items.length} 条；同标题跨平台合并。`)];
  if (mode!=='test') {
    if (!items.length) content.push(textRow('本次暂无匹配内容。已按全部屏蔽词过滤。'));
    // Only actual video-chart entries with a video URL and metrics can enter video sections.
    const sections=config.presentation?.sections || [];
    const grouped=new Map();
    for (const item of items) {
      const section=sections.find(section=>section.categories.includes(item.category)
        && (!section.requires_video_evidence || (item.kind==='video' && item.video_evidence)));
      const label=section?.name || '其他创作线索';
      if (!grouped.has(label)) grouped.set(label,[]);
      grouped.get(label).push(item);
    }
    let number=0;
    const ordered=[...sections.map(section=>section.name),'其他创作线索'];
    for (const label of [...new Set([...ordered,...grouped.keys()])]) {
      const entries=grouped.get(label);
      if (!entries?.length) continue;
      content.push([{tag:'text',text:`━━ ${label}（${entries.length}条）━━`}]);
      for (const item of entries) {
        content.push(textRow(`${++number}. ${item.title}`),
          [{tag:'a',text:item.kind==='video'?'观看视频':item.category==='短视频平台热榜线索'?'查看平台热榜话题':'查看原文',href:item.url}],
          textRow(`摘要：${item.summary}`));
        if (item.kind==='video') content.push(textRow(`作者与热度：${item.metrics}`),
          textRow(`视频时长：${item.duration ? Math.floor(item.duration/60)+'分'+Math.floor(item.duration%60)+'秒' : '来源未提供'}`),
          textRow(`发布时间：${item.published_at ? new Intl.DateTimeFormat('sv-SE',{timeZone:config.timezone,dateStyle:'short',timeStyle:'short'}).format(new Date(item.published_at)) : '来源未提供'}`),
          textRow(`依据：${item.video_evidence}；AI类型按标题及简介归类。`));
        if (item.metrics_checked_at) content.push(textRow(`互动数据查询时间：${new Intl.DateTimeFormat('sv-SE',
          {timeZone:config.timezone,dateStyle:'short',timeStyle:'short'}).format(new Date(item.metrics_checked_at))}`));
        else if (item.heat) content.push(textRow(`话题热度：${item.heat}（不是单条视频播放量）`));
        content.push(textRow(`来源：${item.sources.join('、')}｜${item.summary_origin}`));
      }
    }
    if (failed.length) content.push(textRow('部分平台抓取失败：'+failed.join('、')));
    if (config.coverage?.pending?.length) content.push(textRow('尚未接通：'+config.coverage.pending.map(x=>x.name).join('、')+'；不代表这些平台没有热点。'));
    content.push(textRow('覆盖配置中的公开热榜，不包含平台全部视频或私有数据；摘要仅摘录来源。'));
  }
  const payload=(rows,part)=>({msg_type:'post',content:{post:{zh_cn:{title:`萌宠创作热点｜${stamp}｜第${part}条消息`,content:rows}}}});
  const batches=[];
  let rows=[];
  for (const row of content) {
    if (rows.length && Buffer.byteLength(JSON.stringify(payload([...rows,row],batches.length+1)),'utf8')>17000) {
      batches.push(payload(rows,batches.length+1)); rows=[];
    }
    rows.push(row);
  }
  if (rows.length) batches.push(payload(rows,batches.length+1));
  return batches;
}

export async function sendFeishu(payloads,webhook,fetcher,signal) {
  if (!allowedUrl(webhook,'open.feishu.cn') || new URL(webhook).hostname!=='open.feishu.cn' ||
      !new URL(webhook).pathname.startsWith('/open-apis/bot/v2/hook/')) throw safeError('FEISHU_WEBHOOK_URL 格式不正确');
  let delivered=0;
  for (const payload of payloads) {
    let failure='网络或超时';
    try {
      let outgoing=payload;
      for (let attempt=0;attempt<2;attempt++) {
        const response=await fetcher(webhook,{method:'POST',redirect:'error',signal:requestSignal(signal,20000),
          headers:{'Content-Type':'application/json'},body:JSON.stringify(outgoing)});
        if (!response.ok) { failure=`HTTP ${response.status}`; await response.body?.cancel(); throw Error(); }
        const data=JSON.parse(await readLimited(response,100000));
        const code=data.code ?? data.StatusCode;
        // Only a definitive format rejection permits one alternate representation.
        // Never resend on network errors, ambiguous responses or other business errors.
        if (code===19002 && attempt===0 && payload.msg_type==='post') {
          const post=payload.content.post.zh_cn;
          outgoing={msg_type:'text',content:{text:[post.title,...post.content.map(row=>row.map(node=>
            node.tag==='a'?node.text+' '+node.href:node.text || '').join(''))].join('\n')}};
          console.log('飞书明确拒绝富文本格式；改用保留标题、链接和摘要的文本格式发送本条');
          continue;
        }
        if (code!==0) { failure=`机器人业务码 ${Number.isSafeInteger(code)?code:'未知'}`; throw Error(); }
        delivered++;
        console.log(`飞书已确认接收第 ${delivered}/${payloads.length} 条消息`);
        break;
      }
    } catch { throw safeError(`飞书发送失败（此前已确认 ${delivered} 条；${failure}）；未自动重发，请检查机器人及运行记录`); }
    if (delivered<payloads.length) await new Promise(resolve=>setTimeout(resolve,1000));
  }
  return delivered;
}

export async function runDigest({mode='normal',webhook,fetcher=fetch,config=settings,secrets=process.env}={}) {
  if (!['normal','test','preview'].includes(mode)) throw safeError('推送模式无效');
  if (mode!=='preview' && !webhook) throw safeError('缺少环境变量 FEISHU_WEBHOOK_URL');
  const signal=AbortSignal.timeout(240000);
  let items=[],failed=[],total=0,sourceResults=[];
  if (mode!=='test') {
    const rules=loadRules();
    // Disabled credential integrations are absent from normal digests until explicitly enabled.
    config={...config,sources:config.sources.filter(source=>source.provider!=='dataxapi-douyin'
      || secrets.DATAXAPI_DOUYIN_ENABLED==='true')};
    sourceResults=await collectSources(config,fetcher,signal,{secrets});
    if (sourceResults.some(x=>x.source.provider==='dataxapi-douyin' && !x.error)) {
      config={...config,coverage:{...config.coverage,pending:(config.coverage?.pending || [])
        .filter(x=>x.name!=='抖音具体热门视频')}};
    }
    failed=sourceResults.filter(x=>x.error).map(x=>x.source.name);
    for (const result of sourceResults) console.log(`${result.source.name}：${result.error || `获取 ${result.items.length} 条`}`
      +(result.diagnostics?'；'+JSON.stringify(result.diagnostics):''));
    if (failed.length===config.sources.length) throw safeError('所有平台均抓取失败，停止发送，避免误报暂无新闻');
    const candidates=normalizeItems(sourceResults,rules);
    total=candidates.length;
    // Reserve time for delivery even when article pages are slow or inaccessible.
    const summarySignal=AbortSignal.any([signal,AbortSignal.timeout(Math.min(config.summary_budget_ms || 75000,75000))]);
    items=await mapLimit(selectItems(candidates,rules,config.max_items),6,item=>summarize(item,fetcher,summarySignal));
  }
  const sourceDiagnostics=sourceResults.map(result=>({id:result.source.id,name:result.source.name,
    fetched:result.items.length,error:result.error,matched:normalizeItems([result],loadRules()).length,
    selected:items.filter(item=>item.sources.includes(result.source.name)).length,
    ...(result.diagnostics?{diagnostics:result.diagnostics}:{})}));
  if (mode!=='test' && !items.length) {
    console.log('本次没有匹配内容，不发送凑数消息');
    return {mode,matched:total,selected:0,summaries:0,successful_sources:config.sources.length-failed.length,
      failed_sources:failed,source_diagnostics:sourceDiagnostics,messages:0,delivered:0,...(mode==='preview'?{items:[]}: {})};
  }
  const payloads=makePayloads(items,config,failed,total,mode);
  const delivered=mode==='preview' ? 0 : await sendFeishu(payloads,webhook.trim(),fetcher,signal);
  return {mode,matched:total,selected:items.length,summaries:items.filter(x=>x.summary_origin!=='摘要暂缺').length,
    successful_sources:mode==='test'?0:config.sources.length-failed.length,failed_sources:failed,
    source_diagnostics:sourceDiagnostics,
    messages:payloads.length,delivered,...(mode==='preview'?{items}: {})};
}
