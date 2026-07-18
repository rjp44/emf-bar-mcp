#!/usr/bin/env node
// Entrypoint: warm the catalog cache, then start the chosen transport.
//   MCP_TRANSPORT=http  (default) -> stateless Streamable HTTP at /mcp  (public hosting)
//   MCP_TRANSPORT=stdio           -> stdio                              (local / desktop clients)
import { config } from './config.js';
import { loadCatalog, startCatalogRefresh, getState } from './catalog.js';
import { createServer } from './server.js';

// All logs go to stderr so they never corrupt the stdio JSON-RPC channel.
const log = (...a) => console.error('[emf-bar-mcp]', ...a);

async function warmCatalog() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const s = await loadCatalog();
      log(`catalog loaded: ${s.drinks.length} drinks across ${s.bars.length} bars`);
      return;
    } catch (e) {
      log(`catalog load attempt ${attempt} failed: ${e.message}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  log('WARNING: starting without a catalog; background refresh will retry.');
}

async function startStdio() {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const server = createServer();
  await server.connect(new StdioServerTransport());
  log('stdio transport ready');
}

async function startHttp() {
  const express = (await import('express')).default;
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/healthz', (_req, res) => {
    const s = getState();
    res.json({
      ok: s.drinks.length > 0,
      drinks: s.drinks.length,
      bars: s.bars.length,
      loadedAt: s.loadedAt,
      lastError: s.error,
    });
  });

  // Stateless Streamable HTTP: a fresh server+transport per request.
  const handle = async (req, res) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      log(`request error: ${e.message}`);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
      }
    }
  };
  app.post('/mcp', handle);
  // Stateless server has no standalone SSE stream / session to delete.
  const methodNotAllowed = (_req, res) =>
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed; POST to /mcp.' }, id: null });
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  await new Promise((resolve) => app.listen(config.port, config.host, resolve));
  log(`HTTP transport ready at http://${config.host}:${config.port}/mcp`);
}

async function main() {
  await warmCatalog();
  startCatalogRefresh();
  if (config.transport === 'stdio') await startStdio();
  else await startHttp();
}

main().catch((e) => {
  log('fatal:', e.stack || e.message);
  process.exit(1);
});
