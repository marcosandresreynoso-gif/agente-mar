// server-2.js — M-AR & Asociados
// Fuente: OpenStreetMap / Overpass API — gratuita, sin key, sin tarjeta
// + enriquecimiento web + calificación A/B/C

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const GROQ_KEY = process.env.GROQ_API_KEY;

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

const CIUDADES = {
  'General Villegas':     { lat: -35.0323, lon: -63.0147, r: 8000 },
  'Trenque Lauquen':      { lat: -35.9726, lon: -62.7312, r: 8000 },
  'Pehuajó':              { lat: -35.8457, lon: -61.8978, r: 8000 },
  'Lincoln':              { lat: -34.8653, lon: -61.5283, r: 8000 },
  '9 de Julio':           { lat: -35.4519, lon: -60.8836, r: 8000 },
  'Bragado':              { lat: -35.1193, lon: -60.4897, r: 8000 },
  'Chivilcoy':            { lat: -34.8976, lon: -60.0169, r: 8000 },
  'Junín':                { lat: -34.5928, lon: -60.9456, r: 10000 },
  'Pergamino':            { lat: -33.8897, lon: -60.5731, r: 10000 },
  'La Plata':             { lat: -34.9205, lon: -57.9536, r: 15000 },
  'Mar del Plata':        { lat: -38.0023, lon: -57.5575, r: 15000 },
  'Bahía Blanca':         { lat: -38.7196, lon: -62.2724, r: 15000 },
  'Tandil':               { lat: -37.3217, lon: -59.1332, r: 10000 },
  'Olavarría':            { lat: -36.8924, lon: -60.3222, r: 10000 },
  'Azul':                 { lat: -36.7762, lon: -59.8581, r: 8000 },
  'Necochea':             { lat: -38.5548, lon: -58.7381, r: 8000 },
  'Tres Arroyos':         { lat: -38.3754, lon: -60.2757, r: 8000 },
  'Quilmes':              { lat: -34.7206, lon: -58.2539, r: 10000 },
  'Lomas de Zamora':      { lat: -34.7560, lon: -58.4009, r: 10000 },
  'Morón':                { lat: -34.6534, lon: -58.6190, r: 10000 },
  'Tigre':                { lat: -34.4261, lon: -58.5796, r: 10000 },
  'Zárate':               { lat: -34.0983, lon: -59.0297, r: 8000 },
  'Campana':              { lat: -34.1636, lon: -58.9594, r: 8000 },
  'San Nicolás':          { lat: -33.3354, lon: -60.2269, r: 8000 },
  'Luján':                { lat: -34.5697, lon: -59.1050, r: 8000 },
  'General Pico La Pampa':{ lat: -35.6564, lon: -63.7568, r: 8000 },
  'Santa Rosa La Pampa':  { lat: -36.6210, lon: -64.2899, r: 10000 },
  'Córdoba capital':      { lat: -31.4201, lon: -64.1888, r: 20000 },
  'Villa María Córdoba':  { lat: -32.4073, lon: -63.2397, r: 8000 },
  'Río Cuarto Córdoba':   { lat: -33.1307, lon: -64.3499, r: 10000 },
  'Rosario Santa Fe':     { lat: -32.9468, lon: -60.6393, r: 20000 },
  'Santa Fe capital':     { lat: -31.6333, lon: -60.7000, r: 15000 },
  'Rafaela Santa Fe':     { lat: -31.2522, lon: -61.4869, r: 8000 },
  'Mendoza capital':      { lat: -32.8908, lon: -68.8272, r: 15000 },
  'Tucumán capital':      { lat: -26.8241, lon: -65.2226, r: 15000 },
  'Salta capital':        { lat: -24.7859, lon: -65.4117, r: 15000 },
  'Neuquén capital':      { lat: -38.9516, lon: -68.0591, r: 15000 },
  'Corrientes capital':   { lat: -27.4806, lon: -58.8341, r: 15000 },
  'Posadas Misiones':     { lat: -27.3671, lon: -55.8962, r: 10000 },
  'Resistencia Chaco':    { lat: -27.4514, lon: -58.9867, r: 10000 },
};

const RUBROS_OSM = {
  'empresas':                     [['office','*'],['shop','*']],
  'estudio contable':             [['office','accountant'],['office','tax_advisor'],['office','financial']],
  'estudio juridico abogados':    [['office','lawyer'],['office','legal']],
  'constructora construccion':    [['office','construction_company'],['craft','construction'],['shop','trade']],
  'inmobiliaria':                 [['office','estate_agent']],
  'supermercado comercio':        [['shop','supermarket'],['shop','convenience'],['shop','general']],
  'restaurante bar gastronomia':  [['amenity','restaurant'],['amenity','cafe'],['amenity','bar'],['amenity','fast_food']],
  'empresa tecnologia software':  [['office','it'],['office','software']],
  'transporte logistica':         [['office','logistics'],['amenity','bus_station']],
  'agropecuaria campo':           [['shop','agrarian'],['office','agricultural']],
  'clinica medico salud':         [['amenity','clinic'],['amenity','hospital'],['amenity','doctors']],
  'educacion colegio instituto':  [['amenity','school'],['amenity','college'],['amenity','university']],
  'ferreteria materiales':        [['shop','hardware'],['shop','doityourself'],['shop','building_materials']],
  'hotel turismo':                [['tourism','hotel'],['tourism','hostel'],['tourism','guest_house']],
  'banco financiera':             [['amenity','bank'],['office','financial']],
};

async function buscarOverpass(rubroKey, ciudadKey, maxResults) {
  const ciudad = CIUDADES[ciudadKey];
  if (!ciudad) throw new Error('Ciudad no encontrada: ' + ciudadKey);

  const tags = RUBROS_OSM[rubroKey] || RUBROS_OSM['empresas'];
  const { lat, lon, r } = ciudad;

  const filtros = tags.map(([k, v]) =>
    v === '*'
      ? `node["${k}"](around:${r},${lat},${lon});\nway["${k}"](around:${r},${lat},${lon});`
      : `node["${k}"="${v}"](around:${r},${lat},${lon});\nway["${k}"="${v}"](around:${r},${lat},${lon});`
  ).join('\n');

  const query = `[out:json][timeout:25];\n(\n${filtros}\n);\nout body center ${maxResults * 3};`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error('Overpass error: ' + res.status);
    const data = await res.json();

    const empresas = [];
    for (const el of (data.elements || [])) {
      if (empresas.length >= maxResults) break;
      const t = el.tags || {};
      if (!t.name) continue;

      const telefono = t.phone || t['contact:phone'] || t['contact:mobile'] || '';
      const web = t.website || t['contact:website'] || t.url || '';
      const email = t.email || t['contact:email'] || '';
      const addr = [
        t['addr:street'] ? t['addr:street'] + (t['addr:housenumber'] ? ' ' + t['addr:housenumber'] : '') : '',
        t['addr:city'] || ciudadKey.split(' ')[0],
        'Argentina'
      ].filter(Boolean).join(', ');

      empresas.push({
        nombre: t.name,
        rubro: rubroKey,
        direccion: addr || ciudadKey,
        telefono: telefono.replace(/[\s\-]/g, ''),
        email,
        web,
        emailsWeb: [],
        whatsappWeb: [],
        phonesWeb: [],
        webActiva: false,
        tier: 'C',
        score: 0,
      });
    }
    return empresas;
  } finally {
    clearTimeout(timer);
  }
}

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
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: controller.signal, redirect: 'follow' });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/html')) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > 1_500_000) return null;
    return Buffer.from(buf).toString('utf8');
  } catch { return null; }
  finally { clearTimeout(timer); }
}

function extractEmails(html) {
  if (!html) return [];
  let t = html.replace(/\s*[\[\(]\s*(?:at|arroba)\s*[\]\)]\s*/gi, '@').replace(/\s*[\[\(]\s*(?:dot|punto)\s*[\]\)]\s*/gi, '.');
  const mailtos = [...(t.matchAll(/href="mailto:([^"?]+)/gi))].map(m => m[1].toLowerCase());
  const plain = (t.match(EMAIL_RE) || []).map(e => e.toLowerCase());
  return [...new Set([...mailtos, ...plain])].filter(e => !JUNK_EMAIL.test(e));
}

function extractWhatsApp(html) {
  if (!html) return [];
  const nums = new Set();
  [...(html.matchAll(/(?:wa\.me|api\.whatsapp\.com\/send[?&]phone=)[\/?]?(\d{8,15})/gi))].forEach(m => nums.add('+' + m[1]));
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
  for (const m of html.matchAll(/href="([^"]+)"/gi)) {
    if (/contact|contacto|nosotros|about|quienes/i.test(m[1])) {
      try { links.add(new URL(m[1], baseUrl).toString()); } catch {}
    }
  }
  return [...links].slice(0, 2);
}

async function enrichEmpresa(empresa) {
  const url = normalizeUrl(empresa.web);
  const result = { ...empresa, emailsWeb: [], whatsappWeb: [], phonesWeb: [], webActiva: false };
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
  if (e.emailsWeb?.length) score += 35;
  if (e.whatsappWeb?.length) score += 30;
  if (e.phonesWeb?.length || e.telefono) score += 15;
  if (e.webActiva) score += 10;
  if ((e.emailsWeb?.length || 0) + (e.whatsappWeb?.length || 0) >= 2) score += 10;
  return { ...e, score: Math.min(100, score), tier: score >= 70 ? 'A' : score >= 45 ? 'B' : 'C' };
}

async function enrichBatch(empresas, concurrency = 3) {
  const out = [];
  for (let i = 0; i < empresas.length; i += concurrency) {
    const enriched = await Promise.all(empresas.slice(i, i + concurrency).map(enrichEmpresa));
    out.push(...enriched);
  }
  return out.map(scoreEmpresa).sort((a, b) => b.score - a.score);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

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

  if (req.method === 'POST' && req.url === '/buscar-empresas') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { query, location, cantidad } = JSON.parse(body);
        const ciudadKey = (location || '').replace(' Argentina', '').trim();
        const encontradas = await buscarOverpass(query, ciudadKey, Math.min(cantidad || 20, 20));
        if (!encontradas.length) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ empresas: [], resumen: { total: 0, A: 0, B: 0, C: 0 } }));
          return;
        }
        const leads = await enrichBatch(encontradas, 3);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ empresas: leads, resumen: { total: leads.length, A: leads.filter(l => l.tier === 'A').length, B: leads.filter(l => l.tier === 'B').length, C: leads.filter(l => l.tier === 'C').length } }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

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

  if (req.method === 'GET' && req.url === '/ver-contactos') {
    try {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(fs.readFileSync(CONTACTOS_FILE, 'utf8'));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  if (req.method === 'GET') {
    let urlPath = req.url.split('?')[0];
    let filePath = urlPath === '/' || urlPath === '/index.html'
      ? path.join(__dirname, 'index.html')
      : path.join(__dirname, urlPath);
    if (!path.extname(filePath)) filePath += '.html';
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
