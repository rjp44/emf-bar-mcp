// The four voice-friendly tools. Every handler returns a short spoken-style
// `content` string plus machine-readable `structuredContent`.
import { z } from 'zod';
import { searchDrinks, resolveDrink, resolveBar, listBars, getState } from './catalog.js';
import { liveStocktype, liveOnTap, liveSessions, sessionStatus } from './liveStock.js';
import { toNum, levelWord, servingsLeft, money, clock, weekday } from './format.js';

// Departments that can appear "on tap" (casks / kegs / draught cider). Only for
// these is the extra on-tap call worthwhile when checking stock.
const TAP_DEPTS = new Set([10, 20, 22, 25, 30, 35]);

// --- small presentation helpers ---------------------------------------------
const label = (d) => {
  const m = (d.manufacturer || d.producer || '').trim();
  const name = d.name || '';
  if (!m || name.toLowerCase().startsWith(m.toLowerCase())) return name;
  return `${m} ${name}`;
};
const abvBit = (d) => (d.abv || d.abv === 0 ? `${d.abv}%` : d.category || '');
const ok = (text, structured) => ({
  content: [{ type: 'text', text }],
  structuredContent: structured,
});
const listAnd = (arr) =>
  arr.length <= 1 ? arr.join('') : `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`;

// Compact drink DTO for discovery results.
const dto = (d) => ({
  id: d.id,
  name: label(d),
  abv: d.abv,
  price: d.price,
  priceLabel: money(d.price),
  category: d.category,
  bars: d.bars,
  available: d.available,
  ...(d.dietary?.glutenFree ? { glutenFree: true } : {}),
  ...(d.dietary?.vegan ? { vegan: true } : {}),
});

export function registerTools(server) {
  // 1) list_bars ------------------------------------------------------------
  server.registerTool(
    'list_bars',
    {
      title: 'List bars',
      description:
        'List the EMF bars (Robot Arms / main, Cybar / Null Sector, SpaceBAR) and whether the bar is open right now. Call this to know the valid bar names before filtering by bar.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const bars = listBars();
      let status = { open: null };
      try {
        status = sessionStatus((await liveSessions()).value);
      } catch { /* sessions optional */ }
      const barText = bars
        .map((b) => `${b.name}${b.slug === 'robotarms' ? ' (main bar)' : b.slug === 'cybar' ? ' (Null Sector)' : ''}`)
        .join(', ');
      const openText =
        status.open === true
          ? ` The bar is open now until ${clock(status.closingTime)}.`
          : status.open === false && status.openingTime
            ? ` The bar is closed; it next opens ${weekday(status.openingTime)} ${clock(status.openingTime)}.`
            : '';
      return ok(`${bars.length} bars: ${barText}.${openText}`, {
        bars: bars.map((b) => ({ slug: b.slug, name: b.name, drinkCount: b.drinkCount, maplink: b.maplink })),
        open: status.open,
        closingTime: status.closingTime || null,
        nextOpening: status.openingTime || null,
      });
    },
  );

  // 1b) opening_hours ------------------------------------------------------
  server.registerTool(
    'opening_hours',
    {
      title: 'Bar opening hours',
      description:
        'Whether the bar is open right now and, if not, when it next opens — plus today\'s closing time and the upcoming schedule. Use for "is the bar open?", "when do you open / close?", "what time do you shut?". Note: EMF publishes ONE site-wide bar schedule (the main Robot Arms licence); the other bars broadly follow it and are not listed separately, so the answer is the same whichever bar is asked about.',
      inputSchema: {
        bar: z.string().optional().describe('Optional bar name. The schedule is site-wide, so the times are the same; a note is added for non-main bars.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ bar }) => {
      const barObj = bar ? resolveBar(bar) : null;
      let sessions = [];
      let checkedAt = new Date().toISOString();
      let isLive = false;
      try {
        const r = await liveSessions();
        sessions = r.value;
        checkedAt = new Date(r.at).toISOString();
        isLive = true;
      } catch { /* fall through to no-data */ }
      if (!sessions.length) {
        return ok("I don't have the bar opening times right now.", { open: null, source: 'unavailable' });
      }
      const now = Date.now();
      const at = (s) => new Date(s).getTime();
      const status = sessionStatus(sessions, now);
      const schedule = sessions
        .filter((s) => at(s.closing_time) > now)
        .slice(0, 4)
        .map((s) => ({
          day: weekday(s.opening_time),
          open: clock(s.opening_time),
          close: clock(s.closing_time),
          opensAt: s.opening_time,
          closesAt: s.closing_time,
        }));

      let text;
      if (status.open === true) {
        text = `The bar is open now until ${clock(status.closingTime)}.`;
      } else if (status.openingTime) {
        text = `The bar is closed. It next opens ${weekday(status.openingTime)} at ${clock(status.openingTime)}.`;
      } else {
        text = 'The bar is closed for the rest of the event.';
      }
      const barNote = barObj && barObj.slug !== 'robotarms'
        ? ` (These are the site's published bar hours; ${barObj.name} broadly follows them but isn't listed separately.)`
        : '';
      const staleTail = isLive ? '' : ' (schedule from last refresh)';
      return ok(text + barNote + staleTail, {
        bar: barObj?.slug || null,
        open: status.open,
        closesAt: status.open ? status.closingTime : null,
        nextOpen: status.open ? null : status.openingTime || null,
        schedule,
        scope: 'site-wide (main-bar licence; not per-bar)',
        source: isLive ? 'live' : 'cache',
        checkedAt,
      });
    },
  );

  // 2) find_drinks ----------------------------------------------------------
  server.registerTool(
    'find_drinks',
    {
      title: 'Find drinks',
      description:
        'Fuzzy-search the drinks menu by one or two keywords (e.g. "hoppy", "cider", "gin", "alcohol free", "Ledbury"). Optional bar and category filters. Returns a short ranked list from the cached menu — no live stock check, so it is fast and cheap. Use check_stock afterwards to confirm a specific drink is pouring.',
      inputSchema: {
        query: z.string().describe('One or two keywords: a style, name, brewery, or category.'),
        bar: z.string().optional().describe('Limit to a bar: "Robot Arms", "Cybar"/"Null Sector", or "SpaceBAR".'),
        category: z.string().optional().describe('Optional category word, e.g. beer, cider, wine, spirits, soft.'),
        include_unavailable: z.boolean().optional().describe('Include drinks not currently on the bar (default false).'),
        limit: z.number().int().min(1).max(15).optional().describe('Max results (default 5).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, bar, category, include_unavailable, limit }) => {
      const { bar: barObj, drinks } = searchDrinks(query, {
        bar, category, includeUnavailable: !!include_unavailable, limit: limit || 5,
      });
      const where = barObj ? ` at ${barObj.name}` : '';
      if (drinks.length === 0) {
        return ok(
          `No drinks match "${query}"${where}. Try a broader word like beer, cider, wine, spirits, or soft drink.`,
          { query, bar: barObj?.slug || null, count: 0, drinks: [] },
        );
      }
      const items = drinks.map((d) => `${label(d)} (${abvBit(d)}, ${money(d.price)}${barObj ? '' : `, ${d.bars.join('/')}`})`);
      const text = `${drinks.length} match${drinks.length > 1 ? 'es' : ''}${where} for "${query}": ${items.join('; ')}.`;
      return ok(text, {
        query,
        bar: barObj?.slug || null,
        count: drinks.length,
        drinks: drinks.map(dto),
      });
    },
  );

  // 3) check_stock ----------------------------------------------------------
  server.registerTool(
    'check_stock',
    {
      title: 'Check stock',
      description:
        'Check LIVE stock for one specific drink (by name or the id from find_drinks), optionally at a specific bar. Makes one real-time upstream call. Returns: inStock; how much is left as a real quantity — servingsRemaining + servingUnit (e.g. 52 pints, 30 bottles, 24 cans), percentRemaining, and containerPercentRemaining for a cask/keg on tap; a coarse level (plenty/ok/low/out); the bar(s) serving it; the price; and freshness (source "live" vs "cache" with checkedAt). Cite the quantity when you answer. If the name is ambiguous it returns a short list to choose from.',
      inputSchema: {
        drink: z.string().describe('Drink name or the numeric id from find_drinks.'),
        bar: z.string().optional().describe('Optional bar to check: "Robot Arms", "Cybar"/"Null Sector", or "SpaceBAR".'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ drink, bar }) => {
      const { match, candidates } = resolveDrink(drink);
      const barObj = bar ? resolveBar(bar) : null;
      if (!match) {
        if (candidates.length) {
          return ok(`Did you mean: ${listAnd(candidates.map(label))}? Say which one.`, {
            ambiguous: true, candidates: candidates.map(dto),
          });
        }
        return ok(`I couldn't find a drink like "${drink}". Try find_drinks first.`, { found: false });
      }

      // One live upstream call for fresh stock + current placement.
      let live = null;
      let dataAt = getState().loadedAt?.getTime() ?? Date.now(); // fallback: catalog age
      let isLive = false;
      try {
        const res = await liveStocktype(match.id);
        live = res.value;
        dataAt = res.at;
        isLive = true;
      } catch { /* upstream down: fall back to cached catalog figures */ }

      const baseRemaining = live ? toNum(live.base_units_remaining) ?? 0 : match.baseRemaining;
      const baseBought = (live ? toNum(live.base_units_bought) : null) ?? match.baseBought;
      const rawLines = live?.stocklines || match.lines.map((l) => ({
        name: l.line, linetype: l.linetype, location_display: { slug: l.barSlug, name: l.barName },
      }));
      const lines = rawLines.map((sl) => ({
        line: sl.name,
        linetype: sl.linetype,
        barSlug: sl.location_display?.slug || 'unknown',
        barName: sl.location_display?.name || 'Unknown',
      }));
      const frac = baseBought > 0 ? baseRemaining / baseBought : baseRemaining > 0 ? 1 : 0;
      const level = levelWord(frac);
      const servings = servingsLeft({ ...match, baseRemaining });
      const inStock = baseRemaining > 0 && lines.length > 0;
      const barsNow = [...new Set(lines.map((l) => l.barName))];
      const percentRemaining = baseBought > 0 ? Math.round(frac * 100) : null;

      // Cask enrichment: % left of the connected container, if on tap. Only
      // worth the extra call for draught departments (ales/kegs/ciders).
      let caskPct = null;
      if (TAP_DEPTS.has(match.departmentId)) {
        try {
          const onTap = (await liveOnTap()).value;
          const hit = onTap
            .filter((t) => t.stocktypeId === match.id && (!barObj || t.barSlug === barObj.slug))
            .sort((a, b) => (b.remainingPct || 0) - (a.remainingPct || 0))[0];
          if (hit) caskPct = hit.remainingPct;
        } catch { /* on-tap optional */ }
      }

      const priceTail = match.price != null ? ` ${money(match.price)} a ${match.saleUnit}.` : '';
      const checkedAt = new Date(dataAt).toISOString();
      const structured = {
        found: true, id: match.id, name: label(match), inStock, level,
        // How much is left, expressed the way this product is sold:
        servingsRemaining: servings?.count ?? null,   // approx count in sale units
        servingUnit: servings?.unit ?? null,          // e.g. "pints", "330ml cans", "75cl bottles"
        percentRemaining,                             // 0–100 of the total bought (coarse)
        containerPercentRemaining: caskPct != null ? Math.round(caskPct) : null, // cask/keg on tap
        price: match.price, priceLabel: money(match.price),
        abv: match.abv, category: match.category, bars: barsNow,
        lines: lines.map((l) => ({ line: l.line, bar: l.barName })),
        // Freshness so the agent can describe the figure accurately:
        source: isLive ? 'live' : 'cache', live: isLive, checkedAt,
      };
      const staleTail = isLive ? '' : ` (last refreshed ${clock(checkedAt)}, live check unavailable)`;

      if (!inStock) {
        const msg = baseRemaining > 0
          ? `${label(match)} is in stock but not currently on the bar.`
          : `${label(match)} is out of stock right now.`;
        return ok(msg + staleTail, structured);
      }
      if (barObj && !match.barSlugs.includes(barObj.slug) && !lines.some((l) => l.barSlug === barObj.slug)) {
        return ok(
          `${label(match)} isn't at ${barObj.name} right now. It's on at ${listAnd(barsNow)}.${priceTail}`,
          structured,
        );
      }
      const atLines = barObj ? lines.filter((l) => l.barSlug === barObj.slug) : lines;
      // Only physical cask/pump identifiers are useful to speak; continuous
      // lines are usually just named after the product, which is noise.
      const lineNames = [...new Set(atLines.filter((l) => l.linetype === 'regular').map((l) => l.line))].filter(Boolean);
      const whereNow = barObj ? barObj.name : listAnd(barsNow);
      const levelPhrase = level === 'plenty' ? 'plenty left' : level === 'ok' ? 'a fair bit left' : level === 'low' ? 'running low' : 'low stock';
      // Always cite a concrete number: cask % if on tap, else a serving count,
      // else fall back to a percentage of stock.
      const quantity = caskPct != null
        ? `~${Math.round(caskPct)}% of the cask left`
        : servings && servings.count > 0
          ? `${servings.phrase} left`
          : percentRemaining != null
            ? `about ${percentRemaining}% of stock left`
            : 'some left';
      const lineTail = lineNames.length ? ` (${lineNames.join(', ')})` : '';
      return ok(
        `Yes — ${label(match)} is on at ${whereNow}${lineTail}: ${levelPhrase}, ${quantity}.${priceTail}${staleTail}`,
        structured,
      );
    },
  );

  // 4) whats_on_tap ---------------------------------------------------------
  server.registerTool(
    'whats_on_tap',
    {
      title: "What's on tap",
      description:
        'List the cask ales, kegs and ciders pouring RIGHT NOW, with live "how full" levels. Optional bar filter. Robot Arms and Cybar have taps; SpaceBAR is cans/bottles only (use find_drinks for it).',
      inputSchema: {
        bar: z.string().optional().describe('Optional bar: "Robot Arms" or "Cybar"/"Null Sector".'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ bar }) => {
      const barObj = bar ? resolveBar(bar) : null;
      if (barObj?.slug === 'spacebar') {
        return ok('SpaceBAR serves cans and bottles, nothing on tap. Use find_drinks to see what it stocks.', {
          bar: 'spacebar', onTap: [],
        });
      }
      let items = [];
      let checkedAt = new Date().toISOString();
      try {
        const res = await liveOnTap();
        items = res.value;
        checkedAt = new Date(res.at).toISOString();
      } catch {
        return ok('The live tap list is unavailable right now. Try find_drinks instead.', { onTap: [] });
      }
      if (barObj) items = items.filter((t) => t.barSlug === barObj.slug);
      if (items.length === 0) {
        return ok(`Nothing is on tap${barObj ? ` at ${barObj.name}` : ''} right now.`, { onTap: [], checkedAt });
      }
      const byBar = new Map();
      for (const t of items) {
        if (!byBar.has(t.barName)) byBar.set(t.barName, []);
        byBar.get(t.barName).push(t);
      }
      const parts = [];
      for (const [barName, list] of byBar) {
        const bits = list.map((t) => {
          const pct = t.remainingPct != null ? `, ${Math.round(t.remainingPct)}%` : '';
          const a = t.abv != null ? `, ${t.abv}%` : '';
          return `${label(t)} (${t.kind}${a}${pct})`;
        });
        parts.push(`${barName}: ${bits.join('; ')}`);
      }
      return ok(`On tap now — ${parts.join('. ')}.`, {
        bar: barObj?.slug || null,
        source: 'live', checkedAt,
        onTap: items.map((t) => ({
          name: label(t), kind: t.kind, bar: t.barName, abv: t.abv,
          price: t.price, priceLabel: money(t.price),
          remainingPct: t.remainingPct != null ? Math.round(t.remainingPct) : null,
          level: levelWord(t.remainingPct != null ? t.remainingPct / 100 : null),
          id: t.stocktypeId,
        })),
      });
    },
  );
}
