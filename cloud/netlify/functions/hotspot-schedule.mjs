import {signature} from '../lib/auth.mjs';
export default async function() {
  const origin = new URL(process.env.URL || '');
  if (origin.protocol !== 'https:' || !origin.hostname.endsWith('.netlify.app') || origin.username || origin.password) {
    throw new Error('缺少有效的 Netlify 站点 URL');
  }
  const mode = process.env.HOTSPOT_MODE || 'normal';
  if (!['normal','test','preview'].includes(mode)) throw new Error('HOTSPOT_MODE 无效');
  const body = JSON.stringify({mode, requested_at:Date.now()});
  const response = await fetch(new URL('/.netlify/functions/hotspot-background', origin), {
    method:'POST', redirect:'error', signal:AbortSignal.timeout(15000),
    headers:{'Content-Type':'application/json','X-Hotspot-Signature':signature(body,process.env.HOTSPOT_INTERNAL_SECRET)}, body
  });
  if (response.status !== 202) throw new Error(`后台任务启动失败（HTTP ${response.status}）`);
  console.log('后台任务已接受调用；此记录不代表飞书已经收到消息');
  return new Response(null,{status:204});
}
