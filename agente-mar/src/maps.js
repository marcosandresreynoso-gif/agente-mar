// src/maps.js — Búsqueda de empresas en Google Maps (Places API) para el panel de WhatsApp
// Requiere GOOGLE_MAPS_API_KEY con "Places API" habilitada y facturación activa en Google Cloud.
const { normalizarTelefono } = require('./telefono');


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

  // Places API (New): una sola llamada ya trae el teléfono. Hasta 20 por página, 3 páginas.
  const campos = 'places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.internationalPhoneNumber,places.websiteUri,places.businessStatus,nextPageToken';
  const out = [];
  let pageToken = '';
  for (let pagina = 0; pagina < 3 && out.length < max; pagina++) {
    const body = { textQuery: `${rubro} en ${localidad}, Argentina`, languageCode: 'es', regionCode: 'AR', pageSize: 20 };
    if (pageToken) body.pageToken = pageToken;
    const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': campos },
      body: JSON.stringify(body)
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) {
      const msg = d.error?.message || `Error ${r.status}`;
      if (/not been used|disabled|PERMISSION_DENIED|API key not valid/i.test(msg + (d.error?.status || ''))) {
        throw new Error('Google rechazó la búsqueda: habilitá "Places API (New)" en el proyecto de la clave y revisá que la clave en Render sea la nueva. (' + msg + ')');
      }
      throw new Error('Google Maps: ' + msg);
    }
    for (const p of d.places || []) {
      if (out.length >= max) break;
      if (p.businessStatus && p.businessStatus !== 'OPERATIONAL') continue;
      const tipo = tipoTelefono(p.internationalPhoneNumber, p.nationalPhoneNumber);
      out.push({
        nombre: p.displayName?.text || '',
        rubro,
        localidad,
        direccion: p.formattedAddress || '',
        telefono_vista: p.nationalPhoneNumber || p.internationalPhoneNumber || '',
        tipo_telefono: tipo,
        whatsapp: telefonoWhatsApp(p.internationalPhoneNumber, tipo),
        web: p.websiteUri || ''
      });
    }
    pageToken = d.nextPageToken || '';
    if (!pageToken) break;
  }
  return out;
}

module.exports = { buscarEmpresas, tipoTelefono };
