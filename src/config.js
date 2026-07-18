// Central configuration, all overridable via environment variables.
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export const config = {
  // Upstream EMF bar API.
  baseUrl: (process.env.EMF_BAR_BASE || 'https://bar.emf.camp').replace(/\/+$/, ''),

  // Transport: 'http' (default, for public/container hosting) or 'stdio' (local).
  transport: (process.env.MCP_TRANSPORT || 'http').toLowerCase(),
  port: num(process.env.PORT, 8787),
  host: process.env.HOST || '0.0.0.0',

  // How often to re-pull the (expensive) full catalog in the background.
  catalogRefreshMs: num(process.env.CATALOG_REFRESH_MS, 15 * 60 * 1000),
  // Short caches so bursts of voice traffic don't hammer the upstream API.
  stockTtlMs: num(process.env.STOCK_TTL_MS, 20 * 1000),
  onTapTtlMs: num(process.env.ONTAP_TTL_MS, 30 * 1000),
  sessionsTtlMs: num(process.env.SESSIONS_TTL_MS, 5 * 60 * 1000),

  // Per-request timeout to the upstream API.
  httpTimeoutMs: num(process.env.HTTP_TIMEOUT_MS, 8000),
};
