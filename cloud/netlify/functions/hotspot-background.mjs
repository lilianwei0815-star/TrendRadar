import {authenticate} from '../lib/auth.mjs';
import {createHistoryStore} from '../lib/history-store.mjs';
import {runDigest} from '../lib/hotspot.mjs';
export default async function(request) {
  if (request.method !== 'POST') return;
  const body = await request.text();
  if (body.length>4096) return;
  const event = authenticate(body,request.headers.get('x-hotspot-signature'),process.env.HOTSPOT_INTERNAL_SECRET);
  if (!event) { console.warn('拒绝未验证或过期的内部调用'); return; }
  try {
    const report = await runDigest({mode:event.mode,webhook:process.env.FEISHU_WEBHOOK_URL,
      historyStore:event.mode==='normal'?createHistoryStore():null});
    console.log(JSON.stringify(report));
  } catch (error) {
    // A batch may already have reached Feishu. Do not throw and automatically
    // resend the entire digest on Netlify's asynchronous retry policy.
    console.error(`热点推送失败：${error.safeMessage || '任务执行异常，请检查配置及运行记录'}`);
  }
}
export const config = {background:true};
