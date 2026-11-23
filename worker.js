// Handletur – mellomtjeneste for Cloudflare Workers
// Skjuler API-nøklene, legger på CORS og mellomlagrer Kassalapp-svar i 6 timer.
//
// Hemmeligheter (Settings → Variables and Secrets i Cloudflare):
//   KASSAL_API_KEY     – fra https://kassal.app/api
//   ANTHROPIC_API_KEY  – fra https://console.anthropic.com (for kundeavis-tolkning)
//   APP_TOKEN          – felles passord du gir til de som skal bruke appen
//   ADMIN_TOKEN        – ditt eget passord; bare dette får bruke kundeavis-tolkning (AI koster penger)
// Binding:
//   DB                 – D1-database for delte tilbud (se schema.sql)
// Valgfrie variabler:
//   ALLOWED_ORIGINS    – f.eks. https://dittnavn.github.io  (standard: *)
//   CLAUDE_MODEL       – standard: claude-sonnet-5-5

const KASSAL = 'https://kassal.app/api/v1/';
const ALLOWED_KASSAL_PATHS = /^(products(\/ean\/[\w-]+|\/id\/\d+)?|physical-stores(\/\d+)?)$/;

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
    const allowOrigin = allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : allowed[0]);
    const cors = {
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Headers': 'content-type,x-app-token',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    };
    const json = (obj, status = 200, extra = {}) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, 'content-type': 'application/json; charset=utf-8', ...extra } });

    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const token = req.headers.get('x-app-token') || '';
    const isAdmin = !!env.ADMIN_TOKEN && token === env.ADMIN_TOKEN;
    if (!isAdmin && (!env.APP_TOKEN || token !== env.APP_TOKEN)) return json({ error: 'Ugyldig app-token' }, 401);

    const url = new URL(req.url);

    if (url.pathname === '/health') {
      return json({ ok: true, kassal: !!env.KASSAL_API_KEY, ai: !!env.ANTHROPIC_API_KEY, db: !!env.DB, admin: isAdmin || !env.ADMIN_TOKEN });
    }

    // ---------- Personlig profil (synk mellom telefoner) ----------
    if (url.pathname === '/profile/get' || url.pathname === '/profile/put') {
      if (!env.DB) return json({ error: 'Databasen (DB) er ikke koblet til mellomtjenesten' }, 500);
      if (req.method !== 'POST') return json({ error: 'Ikke tillatt' }, 405);
      let body = {};
      try { body = await req.json(); } catch { }
      const code = String(body.code || '');
      if (code.length < 16 || code.length > 64) return json({ error: 'Ugyldig profilkode' }, 400);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('handletur:' + code));
      const key = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
      if (url.pathname === '/profile/get') {
        const row = await env.DB.prepare(`SELECT data, updated_at FROM profiles WHERE key = ?`).bind(key).first();
        return json(row ? { data: JSON.parse(row.data), updated_at: row.updated_at } : { data: null, updated_at: 0 });
      }
      const data = JSON.stringify(body.data ?? null);
      if (data.length > 500000) return json({ error: 'Profilen er for stor' }, 413);
      const ts = Math.min(Date.now() + 60000, +body.updated_at || Date.now());
      await env.DB.prepare(`INSERT INTO profiles (key, data, updated_at) VALUES (?,?,?)
                            ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`).bind(key, data, ts).run();
      return json({ ok: true, updated_at: ts });
    }

    // ---------- Delte tilbud ----------
    if (url.pathname === '/offers' || url.pathname.startsWith('/offers/')) {
      if (!env.DB) return json({ error: 'Databasen (DB) er ikke koblet til mellomtjenesten' }, 500);
      return sharedOffers(req, url, env, json);
    }

    // ---------- Kassalapp ----------
    if (url.pathname.startsWith('/kassal/') && req.method === 'GET') {
      const path = url.pathname.slice('/kassal/'.length);
      if (!ALLOWED_KASSAL_PATHS.test(path)) return json({ error: 'Ikke tillatt' }, 404);
      if (!env.KASSAL_API_KEY) return json({ error: 'KASSAL_API_KEY mangler i mellomtjenesten' }, 500);
      const target = KASSAL + path + url.search;
      const cache = caches.default;
      const key = new Request(target);
      let hit = await cache.match(key);
      if (hit) {
        const body = await hit.text();
        return new Response(body, { headers: { ...cors, 'content-type': 'application/json; charset=utf-8', 'x-cache': 'HIT' } });
      }
      const r = await fetch(target, { headers: { Authorization: `Bearer ${env.KASSAL_API_KEY}`, Accept: 'application/json' } });
      const body = await r.text();
      if (r.ok) {
        ctx.waitUntil(cache.put(key, new Response(body, { headers: { 'content-type': 'application/json', 'Cache-Control': 'max-age=21600' } })));
      }
      return new Response(body, { status: r.status, headers: { ...cors, 'content-type': 'application/json; charset=utf-8', 'x-cache': 'MISS' } });
    }

    // ---------- Kundeavis-tolkning med Claude ----------
    if (url.pathname === '/parse' && req.method === 'POST') {
      if (env.ADMIN_TOKEN && !isAdmin) return json({ error: 'Kundeavis-tolkning er bare tilgjengelig for administrator. Legg inn tilbud manuelt.' }, 403);
      if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY mangler i mellomtjenesten' }, 500);
      let input;
      try { input = await req.json(); } catch { return json({ error: 'Ugyldig forespørsel' }, 400); }
      const files = Array.isArray(input.files) ? input.files.slice(0, 20) : [];
      if (!files.length) return json({ error: 'Ingen filer' }, 400);

      const content = files.map(f => f.type === 'pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data } }
        : { type: 'image', source: { type: 'base64', media_type: f.media_type || 'image/jpeg', data: f.data } });

      content.push({ type: 'text', text:
`Dette er en kundeavis (eller skjermbilder av en) fra en norsk dagligvarekjede${input.chainHint ? ' – trolig ' + input.chainHint : ''}. Dagens dato er ${input.today}.
Hent ut ALLE tilbud på varer. Svar KUN med gyldig JSON, uten forklaring, i dette formatet:
{"kjede":"navn på kjeden eller null","gyldig_fra":"YYYY-MM-DD eller null","gyldig_til":"YYYY-MM-DD eller null",
 "tilbud":[{"vare":"varenavn","merke":"merke eller tom","mengde":"f.eks. 400 g, 1 l, per kg","pris":tall,"betingelse":"f.eks. 3 for 2, maks 2 per kunde, eller tom","kun_medlem":true/false,"normalpris":tall eller null}]}
Regler:
- "pris" er pris per stk/enhet etter tilbudet. Ved "2 for 50" blir pris 25 og betingelse "2 for 50". Ved "3 for 2" bruk 2/3 av stykkprisen og skriv betingelsen.
- kun_medlem = true når tilbudet krever medlemskap/app/kundekort (Trumf, Coop medlem, Æ, Kiwi Pluss o.l.).
- Bruk året ut fra dagens dato når avisen bare viser dag og måned.
- Hopp over varer uten tydelig pris.` });

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: env.CLAUDE_MODEL || 'claude-sonnet-5-5', max_tokens: 16000, messages: [{ role: 'user', content }] })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: 'AI-feil: ' + (data.error?.message || r.status) }, 502);
      const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      const a = text.indexOf('{'), b = text.lastIndexOf('}');
      try { return json(JSON.parse(text.slice(a, b + 1))); }
      catch { return json({ error: 'Klarte ikke å tolke svaret fra AI. Prøv færre sider om gangen.' }, 502); }
    }

    return json({ error: 'Ukjent adresse' }, 404);
  },

  // Rydder bort tilbud som gikk ut for mer enn 7 dager siden (cron, f.eks. daglig kl. 04)
  async scheduled(event, env) {
    if (!env.DB) return;
    const cutoff = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
    await env.DB.prepare(`DELETE FROM votes WHERE offer_id IN (SELECT id FROM offers WHERE valid_to <> '' AND valid_to < ?)`).bind(cutoff).run();
    await env.DB.prepare(`DELETE FROM offers WHERE (valid_to <> '' AND valid_to < ?) OR reports >= 3`).bind(cutoff).run();
  }
};

const CHAIN_IDS = ['rema', 'kiwi', 'meny', 'spar', 'joker', 'extra', 'prix', 'mega', 'obs', 'marked', 'bunnpris'];
const MEMBER_IDS = ['', 'trumf', 'kiwipluss', 'coop', 'ae'];
const isDate = s => s === '' || /^\d{4}-\d{2}-\d{2}$/.test(s);
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

async function sharedOffers(req, url, env, json) {
  const DB = env.DB;
  const today = new Date().toISOString().slice(0, 10);

  // Hent tilbud i nærheten
  if (url.pathname === '/offers' && req.method === 'GET') {
    const lat = +url.searchParams.get('lat'), lng = +url.searchParams.get('lng');
    const km = Math.min(100, Math.max(1, +url.searchParams.get('km') || 25));
    if (!isFinite(lat) || !isFinite(lng)) return json({ error: 'lat/lng mangler' }, 400);
    const dLat = km / 111, dLng = km / (111 * Math.cos(lat * Math.PI / 180));
    const { results } = await DB.prepare(
      `SELECT id, chain, name, price, condition, member, valid_from, valid_to, source, nick, confirms, reports, created_at, device
         FROM offers
        WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
          AND (valid_to = '' OR valid_to >= ?) AND reports < 3
        ORDER BY created_at DESC LIMIT 1000`
    ).bind(lat - dLat, lat + dLat, lng - dLng, lng + dLng, today).all();
    const me = url.searchParams.get('device') || '';
    return json({ offers: results.map(({ device, ...o }) => ({ ...o, mine: device === me })) });
  }

  let body = {};
  try { body = await req.json(); } catch { }
  const device = clean(body.device, 40);
  if (device.length < 8) return json({ error: 'Mangler enhets-ID' }, 400);

  // Legg inn tilbud
  if (url.pathname === '/offers' && req.method === 'POST') {
    const lat = Math.round(+body.lat * 100) / 100, lng = Math.round(+body.lng * 100) / 100;
    if (!isFinite(lat) || !isFinite(lng)) return json({ error: 'Posisjon mangler' }, 400);
    const list = Array.isArray(body.offers) ? body.offers.slice(0, 300) : [];
    const recent = await DB.prepare(`SELECT COUNT(*) AS n FROM offers WHERE device = ? AND created_at > ?`)
      .bind(device, Date.now() - 3600e3).first();
    if ((recent?.n || 0) + list.length > 600) return json({ error: 'For mange tilbud på kort tid. Prøv igjen senere.' }, 429);
    const nick = clean(body.nick, 30);
    const stmt = DB.prepare(`INSERT INTO offers (chain,name,price,condition,member,valid_from,valid_to,lat,lng,source,device,nick,created_at)
                             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`);
    const batch = [], keys = [];
    for (const o of list) {
      const price = +o.price, name = clean(o.name, 120), from = clean(o.from, 10), to = clean(o.to, 10);
      if (!CHAIN_IDS.includes(o.chain) || !name || !(price > 0 && price < 100000) || !isDate(from) || !isDate(to)) continue;
      batch.push(stmt.bind(o.chain, name, price, clean(o.condition, 80), MEMBER_IDS.includes(o.member) ? o.member : '',
        from, to, lat, lng, clean(o.source, 20), device, nick, Date.now()));
      keys.push(o.localId || null);
    }
    if (!batch.length) return json({ ids: [] });
    const res = await DB.batch(batch);
    return json({ ids: res.map((r, i) => ({ localId: keys[i], id: r.results?.[0]?.id })) });
  }

  const m = url.pathname.match(/^\/offers\/(\d+)(?:\/(confirm|report))?$/);
  if (!m) return json({ error: 'Ukjent adresse' }, 404);
  const id = +m[1];

  // Bekreft / rapporter
  if (m[2] && req.method === 'POST') {
    const kind = m[2];
    const prev = await DB.prepare(`SELECT kind FROM votes WHERE offer_id = ? AND device = ?`).bind(id, device).first();
    if (prev?.kind === kind) return json({ ok: true });
    const ops = [DB.prepare(`INSERT OR REPLACE INTO votes (offer_id, device, kind) VALUES (?,?,?)`).bind(id, device, kind),
                 DB.prepare(`UPDATE offers SET ${kind === 'confirm' ? 'confirms' : 'reports'} = ${kind === 'confirm' ? 'confirms' : 'reports'} + 1 WHERE id = ?`).bind(id)];
    if (prev) ops.push(DB.prepare(`UPDATE offers SET ${prev.kind === 'confirm' ? 'confirms' : 'reports'} = MAX(0, ${prev.kind === 'confirm' ? 'confirms' : 'reports'} - 1) WHERE id = ?`).bind(id));
    await DB.batch(ops);
    return json({ ok: true });
  }

  // Slett eget tilbud
  if (!m[2] && req.method === 'DELETE') {
    await DB.batch([
      DB.prepare(`DELETE FROM offers WHERE id = ? AND device = ?`).bind(id, device),
      DB.prepare(`DELETE FROM votes WHERE offer_id = ? AND NOT EXISTS (SELECT 1 FROM offers WHERE id = ?)`).bind(id, id)
    ]);
    return json({ ok: true });
  }
  return json({ error: 'Ikke tillatt' }, 405);
}
