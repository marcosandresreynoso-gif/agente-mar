// src/osm.js — Búsqueda gratuita de comercios en OpenStreetMap (sin clave ni tarjeta)
// 1) Nominatim ubica la localidad  2) Overpass trae los comercios con teléfono dentro de ese radio.
const { normalizarTelefono } = require('./telefono');
const { esCelular } = require('./paginas');

const UA = 'agente-mar/1.0 (MARTOKEN; martokenoficial@gmail.com)';
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];

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
  const errores = [];
  for (const base of OVERPASS) {
    const host = new URL(base).host;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 30000);
      const r = await fetch(base + '?data=' + encodeURIComponent(query), {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: ctrl.signal
      }).finally(() => clearTimeout(t));
      const txt = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status} ${txt.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 120)}`);
      return JSON.parse(txt);
    } catch (e) {
      const msg = e.name === 'AbortError' ? 'tardó más de 30 s' : e.message;
      console.error(`[OSM] ${host}: ${msg}`);
      errores.push(`${host}: ${msg}`);
    }
  }
  throw new Error('OpenStreetMap no respondió. Detalle: ' + errores.join(' | '));
}

function armarConsulta({ rubro, lat, lon, radioKm = 8 }) {
  const radio = Math.round(radioKm * 1000);
  const r0 = sinTildes(rubro);
  const etiquetas = (RUBROS.find(([re]) => re.test(r0)) || [null, []])[1];
  const area = `(around:${radio},${(+lat).toFixed(5)},${(+lon).toFixed(5)})`;
  const filtrosTag = etiquetas.map((t) => {
    const [k, v] = t.split('=');
    return `nwr["${k}"="${v}"]${area};`;
  });
  const palabra = r0.replace(/[^a-z0-9 ]/g, '').split(' ').filter((p) => p.length > 3)[0] || r0;
  const raiz = (palabra.length > 6 ? palabra.slice(0, palabra.length - 2) : palabra).replace(/[^a-z0-9]/g, '');
  const filtrosNombre = raiz.length >= 4
    ? ['shop', 'office', 'amenity', 'craft'].map((k) => `nwr["${k}"]["name"~"${raiz}",i]${area};`)
    : [];
  return `[out:json][timeout:25];(${filtrosTag.join('')}${filtrosNombre.join('')});out center tags 300;`;
}

function procesarElementos(elements, { rubro, localidad, cantidad = 200 }) {
  const max = Math.min(Math.max(parseInt(cantidad, 10) || 200, 1), 300);
  const out = [];
  const vistos = new Set();
  for (const el of elements || []) {
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
  const orden = (e) => (e.whatsapp ? 0 : e.telefono_vista ? 1 : 2);
  return out.sort((a, b) => orden(a) - orden(b));
}

// Versión 100% servidor (por si algún día los servidores de OSM dejan de bloquear a Render)
async function buscarOSM({ rubro, localidad, cantidad = 60, radioKm = 8 }) {
  if (!rubro || !localidad) throw new Error('Completá rubro y localidad.');
  const { lat, lon } = await ubicar(localidad);
  const d = await overpass(armarConsulta({ rubro, lat, lon, radioKm }));
  return procesarElementos(d.elements, { rubro, localidad, cantidad });
}

module.exports = { buscarOSM, armarConsulta, procesarElementos };
