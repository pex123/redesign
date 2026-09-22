// Aggregates events from Serbian ticketing platforms (Gigstix, Cooltix,
// Tickets.rs) into the `external_events` table, on a periodic schedule (see
// server.js — daily). The Events/Tickets tab then reads from that cache, so
// a slow or broken source never blocks a page load.
//
// ══════════════════════════════════════════════════════════════════════
// IMPORTANT — read this before relying on these parsers:
//
// This code was written without the ability to load gigstix.rs, cooltix.rs,
// or tickets.rs from the environment it was built in (outbound network
// access there is restricted to package registries only, not arbitrary
// websites). That means the CSS selectors below are a best-effort guess at
// a typical event-listing page structure, NOT verified against the real
// HTML of these sites. They will very likely need adjusting once this runs
// somewhere with real internet access and you can inspect actual responses
// (browser devtools → Elements, on each site's events/listing page).
//
// Two other things worth doing before shipping this to production:
//   1. Check whether any of these platforms offer an official API or a
//      partner/affiliate feed. That would be far more robust than scraping
//      HTML that can change without notice, and is usually the intended,
//      ToS-compliant way to redistribute another platform's listings.
//   2. Check each site's robots.txt and terms of service for scraping
//      restrictions before deploying this. Sites vary a lot here, and this
//      is a legal/business judgment call for you to make, not something
//      that should be assumed fine by default.
//
// Each fetchX() function below is isolated and wrapped in try/catch by the
// caller, so one broken/blocked source never takes down the others or the
// sync job as a whole — you'll just see that source's error logged and its
// listings simply won't update until the selector is fixed.
// ══════════════════════════════════════════════════════════════════════

const store = require('./store');

const UA = 'Mozilla/5.0 (compatible; AxisEventBot/1.0; +https://example.com/bot)';

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${url} responded ${res.status}`);
  return res.text();
}

// Minimal, dependency-free HTML attribute/text extraction so this module
// doesn't need a parsing library. Deliberately simple — swap in `cheerio`
// (npm install cheerio) if the real page structure needs proper DOM
// traversal once you can see it.
function extractAll(html, regex) {
  const out = [];
  let m;
  while ((m = regex.exec(html))) out.push(m);
  return out;
}
function stripTags(s) { return (s || '').replace(/<[^>]+>/g, '').trim(); }

// ── Gigstix ── UNVERIFIED selector guesses.
async function fetchGigstix() {
  const html = await fetchHtml('https://gigstix.rs/events');
  const cards = extractAll(html, /<a[^>]+class="[^"]*event-card[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi);
  return cards.map((m, i) => {
    const url = m[1].startsWith('http') ? m[1] : 'https://gigstix.rs' + m[1];
    const block = m[2];
    const title = stripTags((block.match(/<h\d[^>]*>([\s\S]*?)<\/h\d>/i) || [, ''])[1]) || 'Untitled event';
    const dateText = stripTags((block.match(/class="[^"]*date[^"]*"[^>]*>([\s\S]*?)<\//i) || [, ''])[1]);
    const venue = stripTags((block.match(/class="[^"]*venue[^"]*"[^>]*>([\s\S]*?)<\//i) || [, ''])[1]);
    const priceText = stripTags((block.match(/class="[^"]*price[^"]*"[^>]*>([\s\S]*?)<\//i) || [, ''])[1]);
    const imageUrl = (block.match(/<img[^>]+src="([^"]+)"/i) || [, ''])[1];
    return { source: 'gigstix', sourceId: url, title, venue, city: '', dateText, startsAt: null, priceText, url, imageUrl };
  }).filter(e => e.title && e.url);
}

// ── Cooltix ── UNVERIFIED selector guesses.
async function fetchCooltix() {
  const html = await fetchHtml('https://cooltix.rs/dogadjaji');
  const cards = extractAll(html, /<a[^>]+class="[^"]*event[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi);
  return cards.map((m) => {
    const url = m[1].startsWith('http') ? m[1] : 'https://cooltix.rs' + m[1];
    const block = m[2];
    const title = stripTags((block.match(/<h\d[^>]*>([\s\S]*?)<\/h\d>/i) || [, ''])[1]) || 'Untitled event';
    const dateText = stripTags((block.match(/class="[^"]*date[^"]*"[^>]*>([\s\S]*?)<\//i) || [, ''])[1]);
    const venue = stripTags((block.match(/class="[^"]*venue[^"]*"[^>]*>([\s\S]*?)<\//i) || [, ''])[1]);
    const priceText = stripTags((block.match(/class="[^"]*price[^"]*"[^>]*>([\s\S]*?)<\//i) || [, ''])[1]);
    const imageUrl = (block.match(/<img[^>]+src="([^"]+)"/i) || [, ''])[1];
    return { source: 'cooltix', sourceId: url, title, venue, city: '', dateText, startsAt: null, priceText, url, imageUrl };
  }).filter(e => e.title && e.url);
}

// ── Tickets.rs ── UNVERIFIED selector guesses.
async function fetchTicketsRs() {
  const html = await fetchHtml('https://tickets.rs/events');
  const cards = extractAll(html, /<a[^>]+class="[^"]*event[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi);
  return cards.map((m) => {
    const url = m[1].startsWith('http') ? m[1] : 'https://tickets.rs' + m[1];
    const block = m[2];
    const title = stripTags((block.match(/<h\d[^>]*>([\s\S]*?)<\/h\d>/i) || [, ''])[1]) || 'Untitled event';
    const dateText = stripTags((block.match(/class="[^"]*date[^"]*"[^>]*>([\s\S]*?)<\//i) || [, ''])[1]);
    const venue = stripTags((block.match(/class="[^"]*venue[^"]*"[^>]*>([\s\S]*?)<\//i) || [, ''])[1]);
    const priceText = stripTags((block.match(/class="[^"]*price[^"]*"[^>]*>([\s\S]*?)<\//i) || [, ''])[1]);
    const imageUrl = (block.match(/<img[^>]+src="([^"]+)"/i) || [, ''])[1];
    return { source: 'ticketsrs', sourceId: url, title, venue, city: '', dateText, startsAt: null, priceText, url, imageUrl };
  }).filter(e => e.title && e.url);
}

const SOURCES = [
  { name: 'gigstix', fetch: fetchGigstix },
  { name: 'cooltix', fetch: fetchCooltix },
  { name: 'ticketsrs', fetch: fetchTicketsRs },
];

async function syncExternalEvents() {
  const now = Date.now();
  let totalUpserted = 0;
  for (const src of SOURCES) {
    try {
      const events = await src.fetch();
      for (const e of events) {
        await store.upsertExternalEvent({ ...e, fetchedAt: now });
        totalUpserted++;
      }
      console.log(`[external-events] ${src.name}: ${events.length} listing(s) synced`);
    } catch (e) {
      // A broken/blocked source is expected until the selectors above are
      // verified against real page HTML — log and move on to the next one.
      console.error(`[external-events] ${src.name} failed (selectors likely need adjusting — see comment at top of this file): ${e.message}`);
    }
  }
  return totalUpserted;
}

module.exports = { syncExternalEvents };
