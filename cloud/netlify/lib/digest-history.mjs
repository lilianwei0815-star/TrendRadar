import {createHash} from 'node:crypto';

// Store identifiers only: never persist captions, webhook credentials or API keys.
export function itemIdentity(item) {
  let identity;
  if (item.kind==='video') {
    const url=new URL(item.url);
    identity='video:'+url.hostname.toLowerCase()+url.pathname.replace(/\/$/,'');
  } else {
    identity='topic:'+String(item.title).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
  }
  return createHash('sha256').update(identity).digest('hex');
}

export function validateSnapshot(snapshot) {
  if (snapshot===null) return null;
  if (!snapshot || snapshot.version!==1 || !Number.isFinite(Date.parse(snapshot.sent_at))
      || !Array.isArray(snapshot.keys) || snapshot.keys.length>120
      || snapshot.keys.some(key=>typeof key!=='string' || !/^[a-f0-9]{64}$/.test(key))) {
    throw new Error('Invalid digest history');
  }
  return snapshot;
}

export function compareDigest(items,previous,status='ready') {
  const known=new Set(previous?.keys || []);
  const comparisonStatus=status==='unavailable'?'unavailable':previous?'compared':'baseline';
  const marked=items.map(item=>({...item,novelty:comparisonStatus==='compared'
    ? known.has(itemIdentity(item))?'continuing':'new':comparisonStatus}));
  return {items:marked,status:comparisonStatus,previous_sent_at:previous?.sent_at || null,
    new_items:marked.filter(x=>x.novelty==='new').length,
    continuing_items:marked.filter(x=>x.novelty==='continuing').length};
}

export async function prepareComparison(items,historyStore) {
  if (!historyStore) return compareDigest(items,null,'unavailable');
  try { return compareDigest(items,validateSnapshot(await historyStore.load())); }
  catch {
    console.warn('上次推送记录暂不可读；本轮标记未比较，不将内容误报为新增');
    return compareDigest(items,null,'unavailable');
  }
}

export async function saveDeliveredDigest(items,historyStore,comparison) {
  if (!historyStore || comparison.status==='unavailable') return false;
  try {
    await historyStore.save({version:1,sent_at:new Date().toISOString(),keys:[...new Set(items.map(itemIdentity))]});
    console.log('已保存本轮完整送达的推送清单，供下一轮比较');
    return true;
  } catch {
    console.warn('消息已发送，但推送比较记录保存失败；未重发消息，下一轮沿用原基准');
    return false;
  }
}
