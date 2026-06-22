// Web-push opt-in helpers. The VAPID public key is public by design (safe to embed);
// the private key lives only in the push-send edge function's secrets.
const VAPID_PUBLIC = 'BI6R0g_vLRzjK0VA_ir1iGSHOGgjgy9BvJTXkTM38-BjpTl9Eo785CReN1cgZ7O_JOSbpq2752Srpavx6i7mRVk';

function b64ToU8(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const s = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function pushSupported() {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof window !== 'undefined' && 'PushManager' in window && 'Notification' in window;
}

export async function pushState() {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  try { const reg = await navigator.serviceWorker.getRegistration(); const sub = reg && (await reg.pushManager.getSubscription()); return sub ? 'on' : 'off'; } catch (e) { return 'off'; }
}

export async function enablePush(supabase, user) {
  if (!pushSupported()) return { ok: false, reason: 'unsupported' };
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return { ok: false, reason: 'denied' };
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(VAPID_PUBLIC) });
  const j = sub.toJSON();
  if (!j.endpoint || !j.keys) return { ok: false, reason: 'subscribe-failed' };
  const { error } = await supabase.from('push_subscriptions').upsert(
    { user_id: user.id, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, user_agent: (navigator.userAgent || null) },
    { onConflict: 'endpoint' },
  );
  if (error) return { ok: false, reason: error.message };
  return { ok: true };
}

export async function disablePush(supabase) {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && (await reg.pushManager.getSubscription());
    if (sub) { const ep = sub.endpoint; await sub.unsubscribe(); await supabase.from('push_subscriptions').delete().eq('endpoint', ep); }
  } catch (e) {}
  return { ok: true };
}
