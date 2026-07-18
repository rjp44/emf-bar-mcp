// Thin, timeout-guarded client for the EMF Camp bar HTTP API.
// Docs: https://developer.emfcamp.org/bar/
import { config } from './config.js';

async function getJson(path) {
  const url = `${config.baseUrl}${path}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.httpTimeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { accept: 'application/json', 'user-agent': 'emf-bar-mcp/1.0' },
    });
    if (!res.ok) throw new Error(`EMF API ${path} -> HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// --- Catalog (pull rarely; /stocktypes is flagged "expensive, do not poll") ---
export const getStocktypes = () => getJson('/api/stocktypes.json'); // { stocktypes: [...] }

// --- Real-time, cheap single-object lookups ---
export const getStocktype = (id) => getJson(`/api/stocktype/${id}.json`); // single stocktype
export const getSessions = () => getJson('/api/sessions.json'); // { sessions: [...] }
export const getOnTap = () => getJson('/api/on-tap.json'); // Robot Arms casks/kegs/ciders now pouring
export const getCybarOnTap = () => getJson('/api/cybar-on-tap.json'); // Null Sector kegs/ciders now pouring
