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

// Archivo para guardar contactos enviados
const CONTACTOS_FILE = path.join(__dirname, 'contactos-enviados.json');
if (!fs.existsSync(CONTACTOS_FILE)) {
  fs.writeFileSync(CONTACTOS_FILE, JSON.stringify({ whatsapp: [], email: [] }, null, 2));
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── API CHAT (Groq) ──────────────────────────────────────
  if (req.method === 'POST' && req.url === '/chat') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { system, messages } = JSON.parse(body);
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
          body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 1000, messages: [{ role: 'system', content: system }, ...messages] })
        });
        const d = await r.json();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: d.choices?.[0]?.message?.content || 'Error' }));
      } catch (e) {
        res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── API GOOGLE MAPS PLACES ───────────────────────────────
  if (req.method === 'POST' && req.url === '/buscar-empresas') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { query, location, cantidad } = JSON.parse(body);
        const maxResults = Math.min(cantidad || 20, 60);
        let empresas = [];
        let pageToken = null;

        while (empresas.length < maxResults) {
          let url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query + ' ' + location)}&key=${MAPS_KEY}&language=es`;
          if (pageToken) url += `&pagetoken=${pageToken}`;

          const r = await fetch(url);
          const d = await r.json();

          if (d.results) {
            for (const p of d.results) {
              if (empresas.length >= maxResults) break;
              
              // Obtener detalles del lugar
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
                web: det.website || ''
              });
            }
          }

          pageToken = d.next_page_token;
          if (!pageToken || empresas.length >= maxResults) break;
          await new Promise(r => setTimeout(r, 2000));
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ empresas }));
      } catch (e) {
        res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── GUARDAR CONTACTOS ENVIADOS ───────────────────────────
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
      } catch (e) {
        res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── VER CONTACTOS ARCHIVADOS ─────────────────────────────
  if (req.method === 'GET' && req.url === '/ver-contactos') {
    try {
      const data = fs.readFileSync(CONTACTOS_FILE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
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
      if (err) { res.writeHead(404); res.end('404 - Página no encontrada'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
      res.end(data);
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
