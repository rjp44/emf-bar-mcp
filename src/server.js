// Builds an McpServer instance with the bar tools registered.
// The heavy state (catalog cache) lives in catalog.js as a singleton, so making
// a fresh McpServer per request (stateless HTTP) is cheap.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from './tools.js';

export function createServer() {
  const server = new McpServer(
    { name: 'emf-bar', version: '1.0.0' },
    {
      instructions:
        'Tools for the EMF Camp bars. Discovery flow for a voice assistant: ' +
        'find_drinks (fuzzy keyword search of the menu, cheap) -> check_stock (live stock for the chosen drink). ' +
        'Use whats_on_tap for "what beer/cider is on now", and list_bars for the bar names and open/closed status. ' +
        'Bars: Robot Arms (main), Cybar (Null Sector), SpaceBAR (cans/bottles only).',
    },
  );
  registerTools(server);
  return server;
}
