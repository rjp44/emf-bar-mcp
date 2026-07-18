// In-memory catalog: pulled once at startup (+ slow background refresh) from the
// single expensive /api/stocktypes.json call, which also embeds each drink's
// stocklines (i.e. which bar carries it). Everything discovery-related is served
// from here with zero upstream calls.
import Fuse from 'fuse.js';
import { config } from './config.js';
import { getStocktypes } from './emfApi.js';
import { toNum, stripHtml } from './format.js';

// --- Synonym expansion so 1–2 fuzzy keywords from a voice model hit the mark ---
const DEPT_TAGS = {
  'Real Ale': ['ale', 'beer', 'bitter', 'cask', 'real ale'],
  'Craft Keg >0.5%': ['beer', 'craft', 'keg'],
  'Craft keg ≤0.5%': ['beer', 'craft', 'keg', 'low alcohol', 'alcohol free', 'non alcoholic', 'af'],
  'Lager': ['lager', 'beer', 'pilsner', 'pils'],
  'Real Cider': ['cider', 'real cider'],
  'Keg Cider': ['cider', 'keg cider'],
  'Spirits': ['spirit', 'spirits'],
  'Snacks': ['snack', 'snacks', 'food', 'crisps'],
  'Frozen snacks': ['frozen', 'ice cream', 'snack', 'food'],
  'Craft cans >0.5%': ['beer', 'can', 'craft'],
  'Craft cans ≤0.5%': ['beer', 'can', 'craft', 'low alcohol', 'alcohol free', 'non alcoholic', 'af'],
  'Cocktail cans >0.5%': ['cocktail', 'can', 'mixed drink'],
  'Cocktail cans ≤0.5%': ['cocktail', 'can', 'alcohol free', 'non alcoholic'],
  'Soft Drink Cartons': ['soft drink', 'soft', 'non alcoholic', 'juice'],
  'Soft Drink Prepacked': ['soft drink', 'soft', 'non alcoholic', 'pop', 'fizzy', 'cola'],
  'Club Mate': ['club mate', 'mate', 'soft', 'caffeine', 'non alcoholic'],
  'Wine Bottles': ['wine'],
  'Wine cans >0.5%': ['wine', 'can'],
  'Wine cans ≤0.5%': ['wine', 'can', 'alcohol free', 'non alcoholic'],
  'Misc': [],
  'Cup re-use': ['cup'],
};

// Style / product words to canonicalise if they appear in name or notes.
const STYLE_WORDS = [
  'ipa', 'neipa', 'pale ale', 'pale', 'stout', 'porter', 'session', 'sour', 'saison',
  'blonde', 'blond', 'amber', 'hazy', 'milk stout', 'pilsner', 'pils', 'lager', 'perry',
  'gin', 'vodka', 'rum', 'whisky', 'whiskey', 'tequila', 'brandy', 'negroni', 'margarita',
  'espresso martini', 'martini', 'mojito', 'prosecco', 'malbec', 'shiraz', 'merlot',
  'cabernet', 'sauvignon', 'chardonnay', 'pinot', 'rosé', 'rose', 'red wine', 'white wine',
];

// Flavour / mouthfeel descriptors a user might ask for by feel ("something hoppy").
// Matched against tasting notes so descriptor queries resolve to real drinks.
const FLAVOUR_WORDS = [
  'hoppy', 'malty', 'citrus', 'citrusy', 'tropical', 'chocolate', 'coffee', 'caramel',
  'fruity', 'floral', 'bitter', 'sweet', 'dry', 'smooth', 'crisp', 'refreshing', 'roasty',
  'spicy', 'sour', 'tart', 'juicy', 'session', 'light', 'full bodied', 'rich', 'zesty',
  'berry', 'apple', 'cherry', 'vanilla', 'nutty', 'creamy', 'toffee', 'honey', 'ginger',
];

function buildTags(st, plainNotes) {
  const tags = new Set();
  const add = (t) => t && tags.add(String(t).toLowerCase());

  (DEPT_TAGS[st.department?.description] || []).forEach(add);
  const hay = `${st.name} ${st.manufacturer} ${plainNotes}`.toLowerCase();
  // Word-boundary match so "gin" tags a gin, not "ori-gin-al" / "ima-gin-e".
  const hayWords = new Set(hay.split(/[^a-z0-9]+/).filter(Boolean));
  const present = (w) => (/[^a-z0-9]/.test(w) ? hay.includes(w) : hayWords.has(w));
  for (const w of STYLE_WORDS) if (present(w)) add(w);
  for (const w of FLAVOUR_WORDS) if (present(w)) add(w);

  const abv = toNum(st.abv);
  if (abv !== null) {
    if (abv <= 0.5) ['alcohol free', 'non alcoholic', 'zero', '0%', 'low alcohol'].forEach(add);
    if (abv >= 7) add('strong');
  }
  const dietary = {
    glutenFree: /gluten\s*free|\(gf\)|\bgf\b/i.test(hay),
    vegan: /\bvegan\b/i.test(hay) && !/not vegan/i.test(hay),
  };
  if (dietary.glutenFree) ['gluten free', 'gf'].forEach(add);
  if (dietary.vegan) add('vegan');
  return { tags: [...tags], dietary };
}

function toDrink(st) {
  const notes = stripHtml(st.tasting_notes);
  const { tags, dietary } = buildTags(st, notes);
  const lines = (st.stocklines || []).map((sl) => ({
    line: sl.name,
    linetype: sl.linetype,
    barSlug: sl.location_display?.slug || 'unknown',
    barName: sl.location_display?.name || sl.location || 'Unknown',
    maplink: sl.location_display?.maplink || null,
  }));
  const barSlugs = [...new Set(lines.map((l) => l.barSlug))];
  const barNames = [...new Set(lines.map((l) => l.barName))];
  const baseRemaining = toNum(st.base_units_remaining) ?? 0;
  const baseBought = toNum(st.base_units_bought) ?? 0;

  return {
    id: st.id,
    name: st.name,
    manufacturer: st.manufacturer || '',
    fullname: st.fullname || `${st.manufacturer || ''} ${st.name}`.trim(),
    abv: toNum(st.abv),
    price: toNum(st.price),
    category: st.department?.description || 'Other',
    departmentId: st.department?.id ?? null,
    notes,
    dietary,
    baseUnit: st.base_unit_name || 'unit',
    saleUnit: st.sale_unit_name || st.base_unit_name || 'serving',
    saleUnitPlural: st.sale_unit_name_plural || `${st.sale_unit_name || 'serving'}s`,
    basePerSale: toNum(st.base_units_per_sale_unit) || 1,
    baseBought,
    baseRemaining,
    lines,
    bars: barNames,
    barSlugs,
    // Currently orderable somewhere: placed on a line AND stock left.
    available: lines.length > 0 && baseRemaining > 0,
    tags,
    logo: st.logo || null,
  };
}

// --- Bar registry with voice-friendly aliases -------------------------------
const BAR_ALIASES = {
  robotarms: ['robot arms', 'robot', 'robotarms', 'main bar', 'main', 'the bar'],
  cybar: ['cybar', 'cy bar', 'null sector', 'nullsector', 'null'],
  spacebar: ['spacebar', 'space bar', 'space'],
};

let state = { drinks: [], byId: new Map(), fuse: null, bars: [], loadedAt: null, error: null };

function buildBars(drinks) {
  const map = new Map();
  for (const d of drinks) {
    for (const l of d.lines) {
      if (!map.has(l.barSlug)) {
        map.set(l.barSlug, { slug: l.barSlug, name: l.barName, maplink: l.maplink, drinkCount: 0 });
      }
      const b = map.get(l.barSlug);
      if (!b.maplink && l.maplink) b.maplink = l.maplink;
    }
  }
  // Count distinct available drinks per bar.
  for (const d of drinks) {
    if (!d.available) continue;
    for (const slug of d.barSlugs) map.get(slug) && (map.get(slug).drinkCount += 1);
  }
  return [...map.values()];
}

export async function loadCatalog() {
  const data = await getStocktypes();
  const drinks = (data.stocktypes || []).map(toDrink);
  const byId = new Map(drinks.map((d) => [d.id, d]));
  const fuse = new Fuse(
    drinks.map((d) => ({
      id: d.id,
      name: d.name,
      fullname: d.fullname,
      manufacturer: d.manufacturer,
      category: d.category,
      blob: d.tags.join(' '),
    })),
    {
      includeScore: true,
      ignoreLocation: true,
      threshold: 0.4,
      minMatchCharLength: 2,
      keys: [
        { name: 'name', weight: 0.45 },
        { name: 'manufacturer', weight: 0.2 },
        { name: 'blob', weight: 0.25 },
        { name: 'category', weight: 0.15 },
        { name: 'fullname', weight: 0.15 },
      ],
    },
  );
  state = { drinks, byId, fuse, bars: buildBars(drinks), loadedAt: new Date(), error: null };
  return state;
}

let refreshTimer = null;
export function startCatalogRefresh() {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    loadCatalog().catch((e) => {
      state.error = e.message; // keep serving previous good data
      console.error(`[catalog] refresh failed: ${e.message}`);
    });
  }, config.catalogRefreshMs);
  refreshTimer.unref?.();
}

export const getState = () => state;
export const getDrinkById = (id) => state.byId.get(Number(id));
export const listBars = () => state.bars;

export function resolveBar(input) {
  if (!input) return null;
  const q = String(input).trim().toLowerCase();
  for (const b of state.bars) {
    if (b.slug === q || b.name.toLowerCase() === q) return b;
  }
  for (const [slug, aliases] of Object.entries(BAR_ALIASES)) {
    if (aliases.some((a) => q === a || q.includes(a) || a.includes(q))) {
      return state.bars.find((b) => b.slug === slug) || { slug, name: slug, maplink: null };
    }
  }
  return null;
}

// --- Hybrid matcher: deterministic token/tag scoring first (precise), with a
// Fuse fuzzy fallback only when nothing matches exactly (rescues typos and
// mis-transcriptions). This keeps "gin" from ranking "Ori-gin-al" above a gin. -
const tokenize = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2);

function deterministicScore(drink, qToks) {
  if (qToks.length === 0) return 0;
  const nameToks = new Set(tokenize(`${drink.name} ${drink.fullname}`));
  const manToks = new Set(tokenize(drink.manufacturer));
  const catToks = new Set(tokenize(drink.category));
  const tagSet = new Set(drink.tags); // may include multi-word phrases
  const tagWordSet = new Set(drink.tags.flatMap((t) => t.split(' ')));
  let score = 0;
  let hit = 0;
  for (const q of qToks) {
    let s = 0;
    if (nameToks.has(q)) s = Math.max(s, 0.55);
    else if (q.length >= 4 && [...nameToks].some((t) => t.length > q.length && t.startsWith(q))) s = Math.max(s, 0.3);
    if (tagSet.has(q) || tagWordSet.has(q)) s = Math.max(s, 0.5);
    if (manToks.has(q)) s = Math.max(s, 0.35);
    if (catToks.has(q)) s = Math.max(s, 0.25);
    if (s > 0) hit += 1;
    score += s;
  }
  // Reward matching every query token (e.g. "ledbury gold" both hit).
  if (hit === qToks.length && qToks.length > 1) score += 0.3;
  return score;
}

function fuzzyFallback(query, poolIds) {
  return state.fuse
    .search(query.trim())
    .filter((r) => poolIds.has(r.item.id))
    .map((r) => ({ drink: getDrinkById(r.item.id), score: 1 - (r.score ?? 1) }));
}

const byRelevance = (a, b) =>
  b.score - a.score ||
  (b.drink.available ? 1 : 0) - (a.drink.available ? 1 : 0) ||
  b.drink.baseRemaining - a.drink.baseRemaining;

// Rank a pool of drinks for a query. Returns [{drink, score, mode}] sorted best-first.
function rankPool(query, pool) {
  const q = (query || '').trim();
  if (!q) {
    return pool
      .map((drink) => ({ drink, score: 0, mode: 'browse' }))
      .sort((a, b) => (b.drink.available ? 1 : 0) - (a.drink.available ? 1 : 0) || a.drink.name.localeCompare(b.drink.name));
  }
  const qToks = tokenize(q);
  const exact = pool
    .map((drink) => ({ drink, score: deterministicScore(drink, qToks), mode: 'exact' }))
    .filter((x) => x.score > 0)
    .sort(byRelevance);
  if (exact.length) return exact;
  const poolIds = new Set(pool.map((d) => d.id));
  return fuzzyFallback(q, poolIds).map((x) => ({ ...x, mode: 'fuzzy' })).sort(byRelevance);
}

// Discovery over the cached catalog. No upstream call.
export function searchDrinks(query, { bar, category, includeUnavailable = false, limit = 5 } = {}) {
  const barObj = bar ? resolveBar(bar) : null;
  let pool = state.drinks;
  if (barObj) pool = pool.filter((d) => d.barSlugs.includes(barObj.slug));
  if (category) {
    const c = category.toLowerCase();
    pool = pool.filter((d) => d.category.toLowerCase().includes(c) || d.tags.includes(c));
  }
  if (!includeUnavailable) pool = pool.filter((d) => d.available);

  const ranked = dedupeByLabel(rankPool(query, pool).map((x) => x.drink));
  return { bar: barObj, drinks: ranked.slice(0, Math.max(1, Math.min(limit, 25))) };
}

// Collapse keg/can twins (same brewery + name across formats) into one line for
// a voice list, merging the bars they're available at. Keeps the best-ranked id.
function dedupeByLabel(drinks) {
  const out = [];
  const idx = new Map();
  for (const d of drinks) {
    const key = `${d.manufacturer}|${d.name}`.toLowerCase();
    if (idx.has(key)) {
      const rep = out[idx.get(key)];
      rep.bars = [...new Set([...rep.bars, ...d.bars])];
      rep.barSlugs = [...new Set([...rep.barSlugs, ...d.barSlugs])];
      rep.formats = (rep.formats || 1) + 1;
      continue;
    }
    idx.set(key, out.length);
    out.push({ ...d, bars: [...d.bars], barSlugs: [...d.barSlugs] });
  }
  return out;
}

// Resolve a free-text drink reference (name or numeric id) to one drink,
// or a short candidate list to disambiguate. Used by check_stock.
export function resolveDrink(input) {
  const raw = String(input ?? '').trim();
  if (/^\d+$/.test(raw) && state.byId.has(Number(raw))) {
    return { match: getDrinkById(Number(raw)), candidates: [] };
  }
  if (!raw) return { match: null, candidates: [] };
  const ranked = rankPool(raw, state.drinks);
  if (ranked.length === 0) return { match: null, candidates: [] };

  const best = ranked[0];
  const second = ranked[1];
  const gap = best.score - (second?.score ?? 0);
  const confident = ranked.length === 1 || gap >= (best.mode === 'exact' ? 0.4 : 0.25) || best.score >= 1.1;
  if (confident) return { match: best.drink, candidates: [] };

  // Collapse same-name twins (keg/can) so we don't ask "did you mean X or X?".
  const seen = new Map();
  for (const x of ranked) {
    const k = `${x.drink.manufacturer}|${x.drink.name}`.toLowerCase();
    if (!seen.has(k)) seen.set(k, x.drink);
  }
  const distinct = [...seen.values()];
  if (distinct.length === 1) return { match: distinct[0], candidates: [] };
  return { match: null, candidates: distinct.slice(0, 4) };
}
