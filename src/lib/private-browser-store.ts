const PREFIX = 'contract-private:';
const TTL = 30 * 60 * 1000;
const memory = new Map<string,string>();
function availableStorage():Storage|undefined {try{return typeof window==='undefined'?undefined:window.sessionStorage;}catch{return undefined;}}
export function privateKey(userId: string, name: string): string { return `${PREFIX}${userId}:${name}`; }
export function readPrivate<T>(key: string, store: Storage | undefined = availableStorage(), now = Date.now()): T | undefined {
  let raw=memory.get(key);
  try { raw=store?.getItem(key)||raw; } catch {}
  try {
    const record=JSON.parse(raw||'null');
    if (record && Number.isFinite(record.expires) && record.expires > now) return record.value as T;
  } catch {}
  memory.delete(key);
  try { store?.removeItem(key); } catch {}
}
export function writePrivate(key: string, value: unknown, store: Storage | undefined = availableStorage(), now = Date.now()): void {
  const raw=JSON.stringify({expires: now + TTL, value});memory.set(key,raw);
  try { store?.setItem(key,raw); } catch {}
}
export function removePrivate(key: string): void { memory.delete(key);try { availableStorage()?.removeItem(key); } catch {} }
export function clearPrivateBrowserData(): void {
  memory.clear();
  for (const type of ['localStorage','sessionStorage'] as const) {
    try {
      const store = window[type];
      for (const key of Object.keys(store)) if (key.startsWith(PREFIX) || key.startsWith('contract-pending-') || key.startsWith('contract-composer:')) store.removeItem(key);
    } catch {}
  }
}
export function purgeLegacyAndExpired(): void {
  for(const key of memory.keys())readPrivate(key);
  for (const type of ['localStorage','sessionStorage'] as const) {
    try { const store = window[type]; for (const key of Object.keys(store)) {
      if (key.startsWith('contract-pending-') || key.startsWith('contract-composer:') || (type === 'localStorage' && key.startsWith(PREFIX))) store.removeItem(key);
      else if (key.startsWith(PREFIX)) readPrivate(key, store);
    }} catch {}
  }
}
export function broadcastLogout(): void {
  clearPrivateBrowserData();
  try { localStorage.setItem('contract-auth-event', crypto.randomUUID()); } catch {}
}
