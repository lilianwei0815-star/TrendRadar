import {settings,ruleText} from '../.generated/settings.mjs';

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

async function fetchSource(source,config,fetcher,signal) {
  const url=new URL(config.api_url);
  url.search=`?id=${encodeURIComponent(source.id)}&latest`;
  let failure='网络错误';
  for (let attempt=0;attempt<2;attempt++) {
    if (attempt) await new Promise(resolve=>setTimeout(resolve,1000));
    try {
      const response=await fetcher(url,{headers:{'User-Agent':UA,Accept:'application/json'},
        redirect:'error',signal:requestSignal(signal,12000)});
      if (!response.ok) { await response.body?.cancel(); failure=`HTTP ${response.status}`; continue; }
      const data=JSON.parse(await readLimited(response,3000000));
      if (!['success','cache'].includes(data.status) || !Array.isArray(data.items)) throw safeError('来源格式异常');
      return {source,items:data.items,error:null};
    } catch { failure=signal.aborted ? '任务达到时限' : '网络或来源格式错误'; }
    if (signal.aborted) break;
  }
  return {source,items:[],error:failure};
}

export function normalizeItems(results,rules) {
  const items=[],seen=new Map();
  for (const {source,items:rawItems,error} of results) {
    if (error) continue;
    for (let i=0;i<rawItems.length;i++) {
      const raw=rawItems[i];
      if (!raw || typeof raw.title!=='string') continue;
      const title=cleanText(raw.title).slice(0,1024), category=classify(title,rules);
      const rawUrl=raw.url || raw.mobileUrl;
      const url=typeof rawUrl==='string' ? decodeEntities(rawUrl) : '';
      if (!category || !allowedUrl(url,source.expected_domain)) continue;
      const key=normalized(title).replace(/[^\p{L}\p{N}]/gu,'');
      if (seen.has(key)) {
        const old=seen.get(key);
        if (!old.sources.includes(source.name)) old.sources.push(source.name);
        old.rank=Math.min(old.rank,i+1); continue;
      }
      const description=['description','summary','desc'].map(k=>typeof raw[k]==='string' ? cleanText(raw[k]).slice(0,10000) : '').find(Boolean) || '';
      const item={title,url,category,sources:[source.name],rank:i+1,domain:source.expected_domain,description};
      seen.set(key,item); items.push(item);
    }
  }
  return items;
}

export function selectItems(items,rules,limit) {
  const buckets=rules.groups.map(group=>items.filter(x=>x.category===group.name)
    .sort((a,b)=>b.sources.length-a.sources.length || a.rank-b.rank));
  const selected=[];
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
    textRow('计划：北京时间每天 08:00、12:00、18:00，标题＋原文链接＋中文摘要。')] :
    [textRow(`本次筛选匹配 ${total} 条，展示 ${items.length} 条；同标题跨平台合并。`)];
  if (mode!=='test') {
    if (!items.length) content.push(textRow('本次暂无匹配内容。已按全部屏蔽词过滤。'));
    // A hot-search phrase or an AI-related title is not evidence of a viral video.
    // Viral-video sections are reserved for a future verified video source.
    // Current hot-list adapters never assign a viral-video section.
    const sections=config.presentation?.sections || [];
    const grouped=new Map();
    for (const item of items) {
      const section=sections.find(section=>!section.requires_video_evidence && section.categories.includes(item.category));
      const label=section?.name || '其他创作线索';
      if (!grouped.has(label)) grouped.set(label,[]);
      grouped.get(label).push(item);
    }
    let number=0;
    const ordered=[...sections.map(section=>section.name),'其他创作线索'];
    for (const label of [...new Set([...ordered,...grouped.keys()])]) {
      const entries=grouped.get(label);
      if (!entries?.length) continue;
      content.push([{tag:'text',text:`━━ ${label}（${entries.length}条）━━`,style:['bold']}]);
      entries.forEach(item=>content.push(textRow(`${++number}. ${item.title}`),
        [{tag:'a',text:'查看原文',href:item.url}],textRow(`摘要：${item.summary}`),
        textRow(`来源：${item.sources.join('、')}｜${item.summary_origin}`)));
    }
    if (failed.length) content.push(textRow('部分平台抓取失败：'+failed.join('、')));
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
    try {
      const response=await fetcher(webhook,{method:'POST',redirect:'error',signal:requestSignal(signal,20000),
        headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      if (!response.ok) { await response.body?.cancel(); throw Error(); }
      const data=JSON.parse(await readLimited(response,100000));
      const code=data.code ?? data.StatusCode;
      if (code!==0) throw Error();
      delivered++;
      console.log(`飞书已确认接收第 ${delivered}/${payloads.length} 条消息`);
    } catch { throw safeError(`飞书发送失败（此前已确认 ${delivered} 条）；未自动重发，请检查机器人及运行记录`); }
    if (delivered<payloads.length) await new Promise(resolve=>setTimeout(resolve,1000));
  }
  return delivered;
}

export async function runDigest({mode='normal',webhook,fetcher=fetch,config=settings}={}) {
  if (!['normal','test','preview'].includes(mode)) throw safeError('推送模式无效');
  if (mode!=='preview' && !webhook) throw safeError('缺少环境变量 FEISHU_WEBHOOK_URL');
  const signal=AbortSignal.timeout(240000);
  let items=[],failed=[],total=0,sourceResults=[];
  if (mode!=='test') {
    const rules=loadRules();
    sourceResults=await mapLimit(config.sources,2,source=>fetchSource(source,config,fetcher,signal));
    failed=sourceResults.filter(x=>x.error).map(x=>x.source.name);
    for (const result of sourceResults) console.log(`${result.source.name}：${result.error || `获取 ${result.items.length} 条`}`);
    if (failed.length===config.sources.length) throw safeError('所有平台均抓取失败，停止发送，避免误报暂无新闻');
    const candidates=normalizeItems(sourceResults,rules);
    total=candidates.length;
    items=await mapLimit(selectItems(candidates,rules,config.max_items),6,item=>summarize(item,fetcher,signal));
  }
  if (mode!=='test' && !items.length) {
    console.log('本次没有匹配内容，不发送凑数消息');
    return {mode,matched:total,selected:0,summaries:0,successful_sources:config.sources.length-failed.length,
      failed_sources:failed,messages:0,delivered:0,...(mode==='preview'?{items:[]}: {})};
  }
  const payloads=makePayloads(items,config,failed,total,mode);
  const delivered=mode==='preview' ? 0 : await sendFeishu(payloads,webhook.trim(),fetcher,signal);
  return {mode,matched:total,selected:items.length,summaries:items.filter(x=>x.summary_origin!=='摘要暂缺').length,
    successful_sources:mode==='test'?0:config.sources.length-failed.length,failed_sources:failed,
    messages:payloads.length,delivered,...(mode==='preview'?{items}: {})};
}
