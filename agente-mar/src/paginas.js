// src/paginas.js — Búsqueda gratuita de empresas en Páginas Amarillas (sin navegador)
// La página es Next.js: el listado completo viene como JSON dentro de <script id="__NEXT_DATA__">.
const { normalizarTelefono } = require('./telefono');

const PA_BASE = 'https://www.paginasamarillas.com.ar';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function slug(t) {
  return String(t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
}
function sinTildes(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Celular argentino: lleva "15" después del código de área, o viene marcado como WhatsApp
function esCelular(texto) {
  const t = String(texto || '');
  return /\b15[\s-]?\d{3,}/.test(t.replace(/^\(?0?\d{2,4}\)?\s*/, '')) || /^\+?54\s?9/.test(t.replace(/\s/g, '').replace(/^(\+?54)9/, '$1 9'));
}

async function pedirPagina(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'es-AR,es;q=0.9' }, redirect: 'follow' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Páginas Amarillas respondió ${res.status}`);
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('Páginas Amarillas no devolvió el listado (puede estar bloqueando el acceso automático).');
  return JSON.parse(m[1]);
}

async function buscarPaginasAmarillas({ rubro, localidad, cantidad = 30 }) {
  if (!rubro || !localidad) throw new Error('Completá rubro y localidad.');
  const max = Math.min(Math.max(parseInt(cantidad, 10) || 30, 1), 60);
  const palabras = sinTildes(localidad).split(/\s+/).filter((p) => p.length > 3);

  const out = [];
  const vistos = new Set();
  for (let pagina = 1; pagina <= 3 && out.length < max; pagina++) {
    const url = `${PA_BASE}/b/${slug(rubro)}/${slug(localidad)}` + (pagina > 1 ? `/p-${pagina}` : '');
    let datos;
    try {
      datos = await pedirPagina(url);
    } catch (e) {
      if (pagina === 1) throw e;
      break;
    }
    const lista = datos?.props?.pageProps?.results || [];
    if (!lista.length) break;

    for (const r of lista) {
      if (out.length >= max) break;
      const ma = r.mainAddress || {};
      const loc = sinTildes([ma.localityForSEO, ma.localityToShow, ma.addressLocality].filter(Boolean).join(' '));
      if (palabras.length && !palabras.every((p) => loc.includes(p))) continue;

      const clave = (r.name || '') + (ma.streetName || '');
      if (vistos.has(clave)) continue;
      vistos.add(clave);

      const telefonos = [r.mainPhone, ...(r.allPhones || [])].filter(Boolean)
        .map((p) => p.phoneToShow || p.number).filter(Boolean);
      const waDeclarado = r.contactMap?.WHATSAPP?.[0] || '';
      const celular = waDeclarado || telefonos.find(esCelular) || '';
      const whatsapp = celular ? normalizarTelefono(celular) : null;
      const telefonoVista = celular || telefonos[0] || '';
      const calle = [ma.streetName, ma.streetNumber].filter(Boolean).join(' ');

      out.push({
        nombre: r.name || 'Sin nombre',
        rubro,
        localidad,
        direccion: [calle, ma.localityToShow].filter(Boolean).join(', '),
        telefono_vista: telefonoVista,
        tipo_telefono: whatsapp ? (waDeclarado ? 'whatsapp' : 'celular') : (telefonoVista ? 'fijo' : ''),
        whatsapp,
        web: r.contactMap?.WEB?.[0] || '',
        email: Array.isArray(r.emails) ? r.emails[0] || '' : ''
      });
    }
  }
  return out;
}

module.exports = { buscarPaginasAmarillas, esCelular };

// Usa el buscador-empresas-mar (Render Starter, con Chrome) como fuente de Páginas Amarillas.
// Descarta los resultados inventados por IA que el buscador devuelve cuando falla.
async function buscarConBuscadorMar({ rubro, localidad, cantidad = 30 }) {
  const base = (process.env.BUSCADOR_URL || 'https://buscador-empresas-mar.onrender.com').replace(/\/$/, '');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 120000);
  let d;
  try {
    const r = await fetch(`${base}/buscar-empresas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: rubro, location: `${localidad} Argentina`, cantidad: Math.min(parseInt(cantidad, 10) || 30, 30), fuente: 'paginas_amarillas' }),
      signal: ctrl.signal
    });
    d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `El buscador respondió ${r.status}`);
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'El buscador tardó demasiado (puede estar arrancando). Probá de nuevo en un minuto.' : 'No pude usar el buscador: ' + e.message);
  } finally {
    clearTimeout(t);
  }
  if (String(d.fuenteUsada || '').startsWith('ia')) {
    throw new Error('El buscador no pudo leer Páginas Amarillas para esa búsqueda (sus resultados de respaldo son inventados, así que los descarto). Probá otro rubro o localidad.');
  }
  return (d.empresas || []).map((e) => {
    const telefonos = [e.whatsapp, e.telefono].filter(Boolean);
    const celular = e.whatsapp || telefonos.find(esCelular) || '';
    const wa = celular ? normalizarTelefono(celular) : null;
    return {
      nombre: e.nombre || 'Sin nombre',
      rubro,
      localidad,
      direccion: e.direccion || '',
      telefono_vista: celular || e.telefono || '',
      tipo_telefono: wa ? (e.whatsapp ? 'whatsapp' : 'celular') : (e.telefono ? 'fijo' : ''),
      whatsapp: wa,
      web: e.web || '',
      email: e.email || ''
    };
  });
}

module.exports.buscarConBuscadorMar = buscarConBuscadorMar;
