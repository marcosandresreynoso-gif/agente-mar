// src/osm.js — Búsqueda gratuita de comercios en OpenStreetMap (sin clave ni tarjeta)
// 1) Nominatim ubica la localidad  2) Overpass trae los comercios con teléfono dentro de ese radio.
const { normalizarTelefono } = require('./telefono');
const { esCelular } = require('./paginas');

const UA = 'agente-mar/1.0 (MARTOKEN; martokenoficial@gmail.com)';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

function sinTildes(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

// Rubro en castellano → etiquetas de OpenStreetMap
const RUBROS = [
  [/ferreter/, ['shop=hardware', 'shop=doityourself']],
  [/corralon|materiales|construcc/, ['shop=trade', 'shop=doityourself', 'shop=hardware']],
  [/farmac/, ['amenity=pharmacy']],
  [/supermerc|almacen|autoserv/, ['shop=supermarket', 'shop=convenience', 'shop=general']],
  [/kiosco|kiosko/, ['shop=kiosk', 'shop=convenience']],
  [/carnic/, ['shop=butcher']],
  [/panader/, ['shop=bakery']],
  [/veterin/, ['amenity=veterinary']],
  [/restaur|parrill|comida/, ['amenity=restaurant', 'amenity=fast_food']],
  [/bar|cafe/, ['amenity=cafe', 'amenity=bar']],
  [/hotel|hosped|alojam/, ['tourism=hotel', 'tourism=guest_house', 'tourism=motel']],
  [/inmobil/, ['office=estate_agent']],
  [/contad|estudio contable/, ['office=accountant']],
  [/abogad|estudio juridico/, ['office=lawyer']],
  [/escriban/, ['office=notary']],
  [/seguro/, ['office=insurance']],
  [/taller|mecanic/, ['shop=car_repair']],
  [/gomer/, ['shop=tyres']],
  [/concesion|autos/, ['shop=car']],
  [/agro|veterinaria rural|semill|forraj/, ['shop=agrarian', 'shop=farm']],
  [/ropa|indument/, ['shop=clothes']],
  [/zapat|calzado/, ['shop=shoes']],
  [/muebl/, ['shop=furniture']],
  [/electro/, ['shop=electronics', 'shop=appliance']],
  [/optica/, ['shop=optician']],
  [/peluq|barber|estetic/, ['shop=hairdresser', 'shop=beauty']],
  [/gimnas/, ['leisure=fitness_centre']],
  [/odontol|dentist/, ['amenity=dentist']],
  [/medic|clinic|consultor/, ['amenity=clinic', 'amenity=doctors']],
  [/libreri/, ['shop=stationery', 'shop=books']],
  [/pintur/, ['shop=paint']],
  [/estacion de servicio|combustib|nafta/, ['amenity=fuel']]
];

async function ubicar(localidad) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=ar&q=${encodeURIComponent(localidad + ', Argentina')}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'es' } });
  if (!r.ok) throw new Error(`No pude ubicar la localidad (OpenStreetMap respondió ${r.status}).`);
  const d = await r.json();
  if (!d.length) throw new Error(`No encontré "${localidad}" en el mapa. Probá escribiéndola completa (ej: "General Villegas, Buenos Aires").`);
  return { lat: +d[0].lat, lon: +d[0].lon, nombre: d[0].display_name };
}

async function overpass(query) {
  let ultimoError;
  for (const base of OVERPASS) {
    try {
      const r = await fetch(base, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query)
      });
      if (!r.ok) throw new Error(`Overpass ${r.status}`);
      return await r.json();
    } catch (e) {
      ultimoError = e;
    }
  }
  throw new Error('OpenStreetMap no respondió (' + (ultimoError?.message || 'error') + '). Probá de nuevo en un minuto.');
}

async function buscarOSM({ rubro, localidad, cantidad = 60, radioKm = 8 }) {
  if (!rubro || !localidad) throw new Error('Completá rubro y localidad.');
  const max = Math.min(Math.max(parseInt(cantidad, 10) || 60, 1), 200);
  const { lat, lon } = await ubicar(localidad);
  const radio = Math.round(radioKm * 1000);
  const r0 = sinTildes(rubro);

  const etiquetas = (RUBROS.find(([re]) => re.test(r0)) || [null, []])[1];
  const filtrosTag = etiquetas.map((t) => {
    const [k, v] = t.split('=');
    return `nwr(around:${radio},${lat},${lon})["${k}"="${v}"];`;
  });
  // Además, cualquier comercio cuyo nombre contenga la palabra buscada
  const palabra = r0.replace(/[^a-z0-9 ]/g, '').split(' ').filter((p) => p.length > 3)[0] || r0;
  const raiz = palabra.length > 6 ? palabra.slice(0, palabra.length - 2) : palabra;
  const filtroNombre = `nwr(around:${radio},${lat},${lon})["name"~"${raiz}",i][~"^(shop|office|amenity|craft|tourism)$"~"."];`;

  const query = `[out:json][timeout:25];(${filtrosTag.join('')}${filtroNombre});out center tags 400;`;
  const d = await overpass(query);

  const out = [];
  const vistos = new Set();
  for (const el of d.elements || []) {
    const t = el.tags || {};
    if (!t.name) continue;
    const telefonos = [t['contact:whatsapp'], t.whatsapp, t['contact:mobile'], t.mobile, t.phone, t['contact:phone']]
      .filter(Boolean)
      .flatMap((x) => String(x).split(/[;,/]/))
      .map((x) => x.trim())
      .filter(Boolean);
    const waDeclarado = t['contact:whatsapp'] || t.whatsapp || '';
    const celular = waDeclarado || t['contact:mobile'] || t.mobile || telefonos.find(esCelular) || '';
    const wa = celular ? normalizarTelefono(celular) : null;
    const clave = sinTildes(t.name) + '|' + (wa || telefonos[0] || '');
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    const calle = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' ');
    out.push({
      nombre: t.name,
      rubro,
      localidad,
      direccion: [calle, t['addr:city']].filter(Boolean).join(', '),
      telefono_vista: celular || telefonos[0] || '',
      tipo_telefono: wa ? (waDeclarado ? 'whatsapp' : 'celular') : (telefonos[0] ? 'fijo' : ''),
      whatsapp: wa,
      web: t.website || t['contact:website'] || '',
      email: t.email || t['contact:email'] || ''
    });
    if (out.length >= max) break;
  }
  // Primero los que tienen WhatsApp/celular, después fijos, después sin teléfono
  const orden = (e) => (e.whatsapp ? 0 : e.telefono_vista ? 1 : 2);
  return out.sort((a, b) => orden(a) - orden(b));
}

module.exports = { buscarOSM };
