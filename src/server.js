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
        'Use whats_on_tap for "what beer/cider is on now", opening_hours for "is the bar open / when does it open", ' +
        'and list_bars for the bar names. Bars: Robot Arms (main), Cybar (Null Sector), SpaceBAR (cans/bottles only). ' +
        'IMPORTANT: only ever name drinks, breweries, prices and ABVs that appear in a tool result — never offer a ' +
        'drink from your own knowledge (e.g. famous brands). If a drink is not returned by a tool, it is not stocked here.',
    },
  );
  registerTools(server);
  return server;
}
