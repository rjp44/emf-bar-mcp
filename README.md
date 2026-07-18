# emf-bar-mcp

A small, public **MCP server** over the [EMF Camp bar API](https://developer.emfcamp.org/bar/),
built for a **low‑context voice model**: fuzzy drink discovery by one or two keywords, the bar
each drink is served at, and **live** stock — while touching the upstream API as little as
possible.

- **Discovery is free.** The whole menu (124 drinks) and which bar carries each one is pulled in
  **one** call to `/api/stocktypes.json` at container start, then refreshed slowly in the
  background. `find_drinks` and `list_bars` never hit the network.
- **Live checks are cheap and targeted.** `check_stock` reads one drink via
  `/api/stocktype/<id>.json`; `whats_on_tap` reads the two on‑tap endpoints. Both sit behind short
  TTL caches, so a burst of voice traffic collapses to one upstream request.

The paste‑into‑a‑prompt guide for the voice model is **[PROMPT.md](PROMPT.md)**.

**Live instance:** `https://emf-bar-mcp-37viybmxjq-ew.a.run.app/mcp` — Cloud Run (`llm-voice`, europe‑west1), public, scale‑to‑zero. Health: [`/health`](https://emf-bar-mcp-37viybmxjq-ew.a.run.app/health).

## Quick start

```bash
npm install
npm start                 # HTTP server on http://0.0.0.0:8787/mcp  (default)
# or
npm run stdio             # stdio transport, for desktop MCP clients
```

Health check: `curl localhost:8787/health`

### Docker

```bash
docker build -t emf-bar-mcp .
docker run -p 8787:8787 emf-bar-mcp
```

## Connecting a client

**Streamable HTTP** (remote / public) — point your MCP client at `http://<host>:8787/mcp`.

**stdio** (e.g. Claude Desktop `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "emf-bar": { "command": "node", "args": ["/abs/path/to/emf-bar-mcp/src/index.js"], "env": { "MCP_TRANSPORT": "stdio" } }
  }
}
```

## Tools

| Tool | Args | Live call? | Returns |
|------|------|-----------|---------|
| `list_bars` | — | no | The 3 bars (slug, name, drink count, map link) + open/closed now |
| `find_drinks` | `query` (1–2 keywords), `bar?`, `category?`, `include_unavailable?`, `limit?` | no | Ranked drinks: `id`, `name`, `abv`, `price`, `category`, `bars`, dietary flags |
| `check_stock` | `drink` (name or `id`), `bar?` | **1** | `inStock`, `level`, `servingsLeft`, `caskRemainingPct`, `price`, `bars`, cask/pump lines |
| `whats_on_tap` | `bar?` | **1** (cached) | Casks/kegs/ciders pouring now, each with `remainingPct` / `level` |

Every tool returns a short spoken‑style `content` string **and** machine‑readable
`structuredContent`. `check_stock` returns a `candidates` list when a name is ambiguous.

Bar names are fuzzy: `robotarms`/"Robot Arms"/"main bar", `cybar`/"Cybar"/"Null Sector",
`spacebar`/"SpaceBAR"/"space bar" all resolve.

## Configuration (env vars)

| Var | Default | Purpose |
|-----|---------|---------|
| `MCP_TRANSPORT` | `http` | `http` or `stdio` |
| `PORT` / `HOST` | `8787` / `0.0.0.0` | HTTP bind |
| `EMF_BAR_BASE` | `https://bar.emf.camp` | Upstream API base |
| `CATALOG_REFRESH_MS` | `900000` (15 min) | Background catalog refresh interval |
| `STOCK_TTL_MS` | `20000` | Per‑drink live‑stock cache TTL |
| `ONTAP_TTL_MS` | `30000` | On‑tap cache TTL |
| `SESSIONS_TTL_MS` | `300000` | Opening‑times cache TTL |
| `HTTP_TIMEOUT_MS` | `8000` | Upstream request timeout |

## How it works

```
                 startup + every CATALOG_REFRESH_MS
  /api/stocktypes.json ───────────────► catalog cache (drinks, tags, bar placement, Fuse index)
                                              │
  find_drinks / list_bars  ◄──────────────────┘   (0 upstream calls)

  check_stock   ──► /api/stocktype/<id>.json      (TTL STOCK_TTL_MS)
  whats_on_tap  ──► /api/on-tap.json + /api/cybar-on-tap.json  (TTL ONTAP_TTL_MS)
```

Discovery matching is deterministic (keyword/synonym/style/flavour tags derived from each drink,
including "hoppy"/"gluten free"/"alcohol free"), with a [Fuse.js](https://fusejs.io) fuzzy fallback
for typos and mis‑transcriptions. The HTTP transport is **stateless** (a fresh MCP server per
request; the catalog cache is a shared singleton), so it scales and hosts simply.

The upstream `/api/stocktypes.json` is flagged *expensive — do not poll*; this server honours that
by pulling it only at start‑up and on the slow refresh timer, never per request.

## Notes
- Not affiliated with EMF; uses the public read‑only bar API. Data © EMF.
- Node ≥ 18 (uses global `fetch`). MIT licensed.
