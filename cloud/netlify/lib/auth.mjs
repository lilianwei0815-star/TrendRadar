import {createHmac, timingSafeEqual} from 'node:crypto';
export function signature(body, secret) {
  if (!secret || secret.length < 32) throw new Error('缺少内部调用密钥或长度不足');
  return createHmac('sha256', secret).update(body).digest('hex');
}
export function authenticate(body, supplied, secret, now=Date.now()) {
  if (!secret || secret.length < 32 || !/^[a-f0-9]{64}$/.test(supplied || '')) return null;
  if (!timingSafeEqual(Buffer.from(signature(body, secret), 'hex'), Buffer.from(supplied, 'hex'))) return null;
  try {
    const event = JSON.parse(body);
    if (!Number.isFinite(event.requested_at) || Math.abs(now-event.requested_at)>300000) return null;
    return ['normal','test','preview'].includes(event.mode) ? event : null;
  } catch { return null; }
}
