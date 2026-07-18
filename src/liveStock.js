// Real-time upstream lookups, wrapped in short TTL caches so a burst of voice
// sessions asking about the same drink collapses to one upstream request.
import { config } from './config.js';
import { getStocktype, getOnTap, getCybarOnTap, getSessions } from './emfApi.js';
import { toNum } from './format.js';

// Returns { value, at, fresh } — `at` is when the data was actually fetched
// upstream (ms epoch), so callers can report data freshness truthfully.
function ttlCache(fn, ttlMs) {
  const store = new Map(); // key -> { at, value }
  const inflight = new Map();
  return async (key = '_') => {
    const hit = store.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return { value: hit.value, at: hit.at, fresh: false };
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      try {
        const value = await fn(key);
        const at = Date.now();
        store.set(key, { at, value });
        return { value, at, fresh: true };
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  };
}

// Fresh stock for a single drink. Cheap upstream call (not the expensive catalog).
export const liveStocktype = ttlCache((id) => getStocktype(id), config.stockTtlMs);

// Currently-connected casks/kegs/ciders, tagged by bar. SpaceBAR pours nothing
// on tap (cans/fridge only), so it never appears here.
export const liveOnTap = ttlCache(async () => {
  const [main, cybar] = await Promise.allSettled([getOnTap(), getCybarOnTap()]);
  const items = [];
  const push = (barSlug, barName, list, kind) => {
    for (const it of list || []) {
      const st = it.stocktype || {};
      items.push({
        barSlug,
        barName,
        kind, // ale | keg | cider
        container: it.description || null,
        remainingPct: toNum(it.remaining_pct),
        stocktypeId: st.id ?? null,
        name: st.name || 'Unknown',
        manufacturer: st.manufacturer || '',
        abv: toNum(st.abv),
        price: toNum(st.price),
        category: st.department?.description || '',
      });
    }
  };
  if (main.status === 'fulfilled') {
    push('robotarms', 'Robot Arms', main.value.ales, 'ale');
    push('robotarms', 'Robot Arms', main.value.kegs, 'keg');
    push('robotarms', 'Robot Arms', main.value.ciders, 'cider');
  }
  if (cybar.status === 'fulfilled') {
    push('cybar', 'Cybar', cybar.value.kegs, 'keg');
    push('cybar', 'Cybar', cybar.value.ciders, 'cider');
  }
  return items;
}, config.onTapTtlMs);

// Bar opening times are global (not per-bar). Report current/next session.
export const liveSessions = ttlCache(async () => {
  const data = await getSessions();
  return data.sessions || [];
}, config.sessionsTtlMs);

export function sessionStatus(sessions, nowMs = Date.now()) {
  const parse = (s) => new Date(s).getTime();
  for (const s of sessions) {
    const open = parse(s.opening_time);
    const close = parse(s.closing_time);
    if (nowMs >= open && nowMs < close) return { open: true, closingTime: s.closing_time };
  }
  const next = sessions
    .map((s) => ({ s, open: parse(s.opening_time) }))
    .filter((x) => x.open > nowMs)
    .sort((a, b) => a.open - b.open)[0];
  return { open: false, openingTime: next?.s.opening_time || null };
}
