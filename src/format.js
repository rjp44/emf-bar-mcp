// Pure formatting / normalisation helpers. No I/O.

// Upstream sends all decimals as JSON strings; parse leniently.
export const toNum = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Strip HTML tags/entities from tasting notes -> plain text.
export function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Coarse, voice-friendly stock level from fraction remaining (0..1).
export function levelWord(fraction) {
  if (fraction === null || fraction === undefined) return 'unknown';
  if (fraction <= 0) return 'out';
  if (fraction <= 0.15) return 'low';
  if (fraction <= 0.5) return 'ok';
  return 'plenty';
}

// Round a serving count to a "spoken" precision (don't imply false accuracy).
export function roughCount(n) {
  if (n === null || n === undefined) return null;
  if (n <= 0) return 0;
  if (n < 20) return Math.round(n);
  if (n < 200) return Math.round(n / 5) * 5;
  return Math.round(n / 10) * 10;
}

// Number of sale-unit servings left, with a unit label.
export function servingsLeft(drink) {
  const { baseRemaining, basePerSale, saleUnit, saleUnitPlural } = drink;
  if (!baseRemaining || !basePerSale) return null;
  const n = roughCount(baseRemaining / basePerSale);
  const unit = n === 1 ? saleUnit : saleUnitPlural;
  return { count: n, unit, phrase: `about ${n} ${unit}` };
}

export const money = (n) => (n === null || n === undefined ? null : `£${Number(n).toFixed(2)}`);

// Format an ISO instant as London wall-clock, regardless of server timezone.
const LONDON = 'Europe/London';
export function clock(iso) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: LONDON,
    }).format(new Date(iso));
  } catch {
    return String(iso || '').slice(11, 16);
  }
}
export function weekday(iso) {
  try {
    return new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: LONDON }).format(new Date(iso));
  } catch {
    return '';
  }
}

// Title-case-ish helper for bar names is unnecessary — API already gives display names.
export const titleUnit = (drink) => drink.saleUnit || drink.baseUnit || 'serving';
