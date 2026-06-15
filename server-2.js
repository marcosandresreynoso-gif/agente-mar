// server-2.js — M-AR & Asociados
// Places API Legacy (la que ya tenés habilitada) + enriquecimiento web + calificación A/B/C

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const GROQ_KEY = process.env.GROQ_API_KEY;
const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};

const CONTACTOS_FILE = path.join(__dirname, 'contactos-enviados.json');
if (!fs.existsSync(CONTACTOS_FILE)) {
  fs.writeFileSync(CONTACTOS_FILE, JSON.stringify({ whatsapp: [], email: [] }, null, 2));
}

// ═══════════════════════════════════════════════════════════
// MÓDULO DE ENRIQUECIMIENTO
// Entra a la web de cada empresa y saca mail/WhatsApp/teléfono
// ═══════════════════════════════════════════════════════════

const UA = 'Mozilla/5.0 (compatible; MAR-LeadBot/1.0)';
const TIMEOUT_MS = 8000;
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const JUNK_EMAIL = /(noreply|no-reply|mailer|sentry|wixpress|example\.|tudominio|yourdomain|sitename|\.(png|jpg|gif|svg|css|js)$)/i;

function normalizeUrl(raw) {
  if (!raw) return null;
  let u = String(raw).trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { return new URL(u).toString(); } catch { return null; }
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/html') && !ct.includes('application/xhtml')) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > 1_500_000) return null;
    return Buffer.from(buf).toString('utf8');
  } catch { return null; }
  finally { clearTimeout(timer); }
}

function extractEmails(html) {
  if (!html) return [];
  let t = html
    .replace(/\s*[\[\(]\s*(?:at|arroba)\s*[\]\)]\s*/gi, '@')
    .replace(/\s*[\[\(]\s*(?:dot|punto)\s*[\]\)]\s*/gi, '.');
  const mailtos = [...(t.matchAll(/href="mailto:([^"?]+)/gi))].map(m => m[1].toLowerCase());
  const plain = (t.match(EMAIL_RE) || []).map(e => e.toLowerCase());
  return [...new Set([...mailtos, ...plain])].filter(e => !JUNK_EMAIL.test(e));
}

function extractWhatsApp(html) {
  if (!html) return [];
  const nums = new Set();
  const links = [...(html.matchAll(/(?:wa\.me|api\.whatsapp\.com\/send[?&]phone=)[\/?]?(\d{8,15})/gi))];
  links.forEach(m => nums.add('+' + m[1]));
  return [...nums];
}

function extractPhones(html) {
  if (!html) return [];
  const links = [...(html.matchAll(/href="tel:([^"]+)"/gi))].map(m => m[1].replace(/[^\d+]/g, ''));
  return [...new Set(links)].filter(p => p.replace(/\D/g, '').length >= 7);
}

function findContactLinks(html, baseUrl) {
  if (!html) return [];
  const links = new Set();
  const matches = html.matchAll(/href="([^"]+)"/gi);
  for (const m of matches) {
    const href = m[1];
    if (/contact|contacto|nosotros|about|quienes/i.test(href)) {
      try { links.add(new URL(href, baseUrl).toString()); } catch {}
    }
  }
  return [...links].slice(0, 2);
}

async function enrichEmpresa(empresa) {
  const url = normalizeUrl(empresa.web || empresa.website);
  const result = {
    ...empresa,
    emailsWeb: [],
    whatsappWeb: [],
    phonesWeb: [],
    webActiva: false,
  };
  if (!url) return result;

  const homeHtml = await fetchHtml(url);
  if (!homeHtml) return result;

  result.webActiva = true;
  result.emailsWeb = extractEmails(homeHtml);
  result.whatsappWeb = extractWhatsApp(homeHtml);
  result.phonesWeb = extractPhones(homeHtml);

  for (const link of findContactLinks(homeHtml, url)) {
    const html2 = await fetchHtml(link);
    if (!html2) continue;
    extractEmails(html2).forEach(e => { if (!result.emailsWeb.includes(e)) result.emailsWeb.push(e); });
    extractWhatsApp(html2).forEach(w => { if (!result.whatsappWeb.includes(w)) result.whatsappWeb.push(w); });
    extractPhones(html2).forEach(p => { if (!result.phonesWeb.includes(p)) result.phonesWeb.push(p); });
  }

  return result;
}

function scoreEmpresa(e) {
  let score = 0;
  if (e.emailsWeb?.length)    score += 35;
  if (e.whatsappWeb?.length)  score += 30;
  if (e.phonesWeb?.length || e.telefono) score += 15;
  if (e.webActiva)            score += 10;
  if ((e.emailsWeb?.length || 0) + (e.whatsappWeb?.length || 0) >= 2) score += 10;
  const tier = score >= 70 ? 'A' : score >= 45 ? 'B' : 'C';
  return { ...e, score: Math.min(100, score), tier };
}

async function enrichBatch(empresas, concurrency = 3) {
  const out = [];
  for (let i = 0; i < empresas.length; i += concurrency) {
    const chunk = empresas.slice(i, i + concurrency);
    const enriched = await Promise.all(chunk.map(enrichEmpresa));
    out.push(...enriched);
  }
  return out.map(scoreEmpresa).sort((a, b) => b.score - a.score);
}

// ═══════════════════════════════════════════════════════════
// MÓDULO DE DESCUBRIMIENTO — Places API LEGACY
// La que ya tenés habilitada, sin pago extra
// ═══════════════════════════════════════════════════════════

async function buscarPlacesLegacy(query, location, maxResults) {
  let empresas = [];
  let pageToken = null;
  const max = Math.min(maxResults, 20);

  while (empresas.length < max) {
    let url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query + ' ' + location)}&key=${MAPS_KEY}&language=es`;
    if (pageToken) url += `&pagetoken=${pageToken}`;

    const r = await fetch(url);
    const d = await r.json();

    if (d.status === 'REQUEST_DENIED' || d.status === 'INVALID_REQUEST') {
      throw new Error(`Google Maps error: ${d.status} — ${d.error_message || ''}`);
    }

    if (d.results) {
      for (const p of d.results) {
        if (empresas.length >= max) break;

        // Detalles: teléfono + web en una sola llamada
        const detUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${p.place_id}&fields=name,formatted_address,formatted_phone_number,website,types&key=${MAPS_KEY}&language=es`;
        const detR = await fetch(detUrl);
        const detD = await detR.json();
        const det = detD.result || {};

        empresas.push({
          nombre: det.name || p.name || '',
          rubro: (det.types || p.types || ['empresa'])[0].replace(/_/g, ' '),
          direccion: det.formatted_address || p.formatted_address || '',
          telefono: det.formatted_phone_number || '',
          email: '',
          web: det.website || '',
          emailsWeb: [],
          whatsappWeb: [],
          phonesWeb: [],
          webActiva: false,
          tier: 'C',
          score: 0,
        });
      }
    }

    pageToken = d.next_page_token;
    if (!pageToken || empresas.length >= max) break;
    // Google requiere esperar 2s antes de usar el next_page_token
    await new Promise(r => setTimeout(r, 2000));
  }

  return empresas;
}

// ═══════════════════════════════════════════════════════════
// SERVIDOR HTTP
// ═══════════════════════════════════════════════════════════

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── CHAT (Groq) ──────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/chat') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { system, messages } = JSON.parse(body);
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_KEY}` },
          body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 1000, messages: [{ role: 'system', content: system }, ...messages] }),
        });
        const d = await r.json();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: d.choices?.[0]?.message?.content || 'Error' }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  // ── BUSCAR: Legacy + enriquecer + calificar ──────────────
  if (req.method === 'POST' && req.url === '/buscar-empresas') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { query, location, cantidad } = JSON.parse(body);

        // 1) Descubrir con Places Legacy
        const encontradas = await buscarPlacesLegacy(query, location, cantidad || 20);

        // 2) Enriquecer webs + calificar
        const leads = await enrichBatch(encontradas, 3);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          empresas: leads,
          resumen: {
            total: leads.length,
            A: leads.filter(l => l.tier === 'A').length,
            B: leads.filter(l => l.tier === 'B').length,
            C: leads.filter(l => l.tier === 'C').length,
          }
        }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── GUARDAR CONTACTOS ────────────────────────────────────
  if (req.method === 'POST' && req.url === '/guardar-contactos') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { tipo, contactos, mensaje, fecha } = JSON.parse(body);
        const data = JSON.parse(fs.readFileSync(CONTACTOS_FILE, 'utf8'));
        data[tipo] = data[tipo] || [];
        data[tipo].push({ fecha, mensaje, contactos });
        fs.writeFileSync(CONTACTOS_FILE, JSON.stringify(data, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  // ── VER CONTACTOS ────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/ver-contactos') {
    try {
      const data = fs.readFileSync(CONTACTOS_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  // ── ARCHIVOS ESTÁTICOS ───────────────────────────────────
  if (req.method === 'GET') {
    let urlPath = req.url.split('?')[0];
    let filePath;
    if (urlPath === '/' || urlPath === '/index.html') {
      filePath = path.join(__dirname, 'index.html');
    } else {
      filePath = path.join(__dirname, urlPath);
      if (!path.extname(filePath)) filePath += '.html';
    }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('404'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
      res.end(data);
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`M-AR servidor en puerto ${PORT}`));
