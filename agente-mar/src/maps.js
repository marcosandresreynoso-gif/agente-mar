// src/maps.js — Búsqueda de empresas en Google Maps (Places API) para el panel de WhatsApp
// Requiere GOOGLE_MAPS_API_KEY con "Places API" habilitada y facturación activa en Google Cloud.
const { normalizarTelefono } = require('./telefono');

const BASE = 'https://maps.googleapis.com/maps/api/place';

// Argentina: el número internacional de un celular trae el 9 después del 54 ("+54 9 2388 ...").
function tipoTelefono(internacional, local) {
  const i = String(internacional || '').replace(/\s+/g, ' ');
  if (/^\+54 9 /.test(i)) return 'celular';
  if (/\b15[\s-]?\d/.test(String(local || ''))) return 'celular';
  if (i.startsWith('+54')) return 'fijo';
  return i ? 'otro' : '';
}

function telefonoWhatsApp(internacional, tipo) {
  if (tipo !== 'celular') return null;
  return normalizarTelefono(internacional);
}

async function buscarEmpresas({ rubro, localidad, cantidad = 20 }) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error('Falta GOOGLE_MAPS_API_KEY en Render.');
  if (!rubro || !localidad) throw new Error('Completá rubro y localidad.');
  const max = Math.min(Math.max(parseInt(cantidad, 10) || 20, 1), 60);

  const lugares = [];
  let pageToken = null;
  for (let pagina = 0; pagina < 3 && lugares.length < max; pagina++) {
    let url = `${BASE}/textsearch/json?query=${encodeURIComponent(`${rubro} en ${localidad}`)}&language=es&region=ar&key=${key}`;
    if (pageToken) url = `${BASE}/textsearch/json?pagetoken=${pageToken}&key=${key}`;
    const d = await (await fetch(url)).json();
    if (d.status === 'REQUEST_DENIED') throw new Error('Google rechazó la búsqueda: ' + (d.error_message || 'revisá que la clave tenga habilitada "Places API" y facturación activa.'));
    if (d.status === 'OVER_QUERY_LIMIT') throw new Error('Se alcanzó el límite de búsquedas de Google por hoy.');
    for (const p of d.results || []) {
      if (lugares.length >= max) break;
      lugares.push(p);
    }
    pageToken = d.next_page_token;
    if (!pageToken) break;
    await new Promise((ok) => setTimeout(ok, 2000)); // Google exige esperar antes de pedir la página siguiente
  }

  // Detalles (teléfono) en paralelo, de a 5
  const out = [];
  for (let i = 0; i < lugares.length; i += 5) {
    const tanda = lugares.slice(i, i + 5);
    const dets = await Promise.all(
      tanda.map(async (p) => {
        try {
          const u = `${BASE}/details/json?place_id=${p.place_id}&fields=name,formatted_address,formatted_phone_number,international_phone_number,website,business_status&language=es&key=${key}`;
          return (await (await fetch(u)).json()).result || {};
        } catch {
          return {};
        }
      })
    );
    tanda.forEach((p, j) => {
      const det = dets[j];
      if (det.business_status && det.business_status !== 'OPERATIONAL') return;
      const tipo = tipoTelefono(det.international_phone_number, det.formatted_phone_number);
      out.push({
        nombre: det.name || p.name || '',
        rubro,
        localidad,
        direccion: det.formatted_address || p.formatted_address || '',
        telefono_vista: det.formatted_phone_number || '',
        tipo_telefono: tipo,
        whatsapp: telefonoWhatsApp(det.international_phone_number, tipo),
        web: det.website || ''
      });
    });
  }
  return out;
}

module.exports = { buscarEmpresas, tipoTelefono };
