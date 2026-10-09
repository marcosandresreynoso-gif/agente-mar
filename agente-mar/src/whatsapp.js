// src/whatsapp.js — WhatsApp M-AR: Cloud API de Meta (coexistencia con la app WhatsApp Business)
//
// Variables de entorno (Render → Environment):
//   WHATSAPP_TOKEN          token permanente de usuario del sistema (Meta Business)
//   WHATSAPP_PHONE_ID       ID del número (Phone number ID)
//   WHATSAPP_WABA_ID        ID de la cuenta de WhatsApp Business (para listar plantillas)
//   WHATSAPP_VERIFY_TOKEN   texto que inventás vos, el mismo que ponés en Meta al configurar el webhook
//   WHATSAPP_APP_SECRET     (recomendado) clave secreta de la app, para validar que el webhook viene de Meta
//   WHATSAPP_API_VERSION    (opcional) por defecto v24.0

const crypto = require('crypto');
const { chat } = require('./groq');
const { db, getConfig } = require('./db');
const { notifyEmail } = require('./notify');
const { normalizarTelefono, mostrarTelefono } = require('./telefono');

const API_VERSION = () => process.env.WHATSAPP_API_VERSION || 'v24.0';
const GRAPH = () => `https://graph.facebook.com/${API_VERSION()}`;
const VENTANA_MS = 24 * 60 * 60 * 1000;
const PAUSA_ECO_MS = 12 * 60 * 60 * 1000; // si Marcos contesta desde el celular, el bot se calla 12 hs con ese contacto

const now = () => new Date().toISOString();

/* ============================ CONTACTOS ============================ */

function getContacto(tel) {
  return db.prepare('SELECT * FROM wa_contactos WHERE telefono = ?').get(tel);
}

// Crea o actualiza sin pisar datos existentes con vacíos
function upsertContacto(tel, datos = {}) {
  const actual = getContacto(tel);
  if (!actual) {
    db.prepare(
      `INSERT INTO wa_contactos (telefono, created_at, nombre, empresa, rubro, fuente, anuncio, estado, notas)
       VALUES (@telefono, @created_at, @nombre, @empresa, @rubro, @fuente, @anuncio, @estado, @notas)`
    ).run({
      telefono: tel,
      created_at: now(),
      nombre: datos.nombre || null,
      empresa: datos.empresa || null,
      rubro: datos.rubro || null,
      fuente: datos.fuente || 'manual',
      anuncio: datos.anuncio || null,
      estado: datos.estado || 'nuevo',
      notas: datos.notas || null
    });
    return { creado: true, contacto: getContacto(tel) };
  }
  const campos = ['nombre', 'empresa', 'rubro', 'anuncio', 'notas'];
  const sets = [];
  const vals = { telefono: tel };
  for (const c of campos) {
    if (datos[c] && !actual[c]) {
      sets.push(`${c} = @${c}`);
      vals[c] = datos[c];
    }
  }
  if (sets.length) db.prepare(`UPDATE wa_contactos SET ${sets.join(', ')} WHERE telefono = @telefono`).run(vals);
  return { creado: false, contacto: getContacto(tel) };
}

function setContacto(tel, campos) {
  const permitidos = ['estado', 'bot_activo', 'pausa_hasta', 'notas', 'nombre', 'empresa', 'rubro', 'no_leidos'];
  const sets = [];
  const vals = { telefono: tel };
  for (const [k, v] of Object.entries(campos)) {
    if (!permitidos.includes(k)) continue;
    sets.push(`${k} = @${k}`);
    vals[k] = v;
  }
  if (!sets.length) return;
  db.prepare(`UPDATE wa_contactos SET ${sets.join(', ')} WHERE telefono = @telefono`).run(vals);
}

function guardarMensaje(m) {
  const info = db
    .prepare(
      `INSERT INTO wa_mensajes (created_at, telefono, direccion, autor, tipo, contenido, wa_id, estado, error)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(now(), m.telefono, m.direccion, m.autor || null, m.tipo || 'text', m.contenido || '', m.wa_id || null, m.estado || null, m.error || null);
  const campo = m.direccion === 'in' ? 'ultimo_entrante_at' : 'ultimo_saliente_at';
  db.prepare(`UPDATE wa_contactos SET ${campo} = ? WHERE telefono = ?`).run(now(), m.telefono);
  return info.lastInsertRowid;
}

function ventanaAbierta(contacto) {
  if (!contacto || !contacto.ultimo_entrante_at) return false;
  return Date.now() - new Date(contacto.ultimo_entrante_at).getTime() < VENTANA_MS;
}

/* ============================ API DE META ============================ */

function credenciales() {
  return {
    token: process.env.WHATSAPP_TOKEN,
    phoneId: process.env.WHATSAPP_PHONE_ID,
    wabaId: process.env.WHATSAPP_WABA_ID
  };
}

async function graphPost(pathname, body) {
  const { token } = credenciales();
  const res = await fetch(`${GRAPH()}/${pathname}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const e = data.error || {};
    const err = new Error(e.error_user_msg || e.message || `Error ${res.status} de Meta`);
    err.code = e.code;
    throw err;
  }
  return data;
}

async function enviarAMeta(payload) {
  const { token, phoneId } = credenciales();
  if (!token || !phoneId) throw new Error('Faltan WHATSAPP_TOKEN o WHATSAPP_PHONE_ID en Render.');
  const data = await graphPost(`${phoneId}/messages`, { messaging_product: 'whatsapp', recipient_type: 'individual', ...payload });
  return data.messages?.[0]?.id || null;
}

// Texto libre: solo dentro de la ventana de 24 hs
async function enviarTexto(tel, texto, autor = 'bot') {
  const cuerpo = String(texto || '').slice(0, 4000);
  try {
    const wa_id = await enviarAMeta({ to: tel, type: 'text', text: { body: cuerpo, preview_url: true } });
    guardarMensaje({ telefono: tel, direccion: 'out', autor, tipo: 'text', contenido: cuerpo, wa_id, estado: 'sent' });
    return { ok: true, wa_id };
  } catch (e) {
    guardarMensaje({ telefono: tel, direccion: 'out', autor, tipo: 'text', contenido: cuerpo, estado: 'failed', error: e.message });
    return { ok: false, error: e.message };
  }
}

// Compatibilidad con código viejo
async function sendMessage(to, text) {
  return enviarTexto(to, text, 'bot');
}

/* ============================ PLANTILLAS ============================ */

let cachePlantillas = { ts: 0, data: [] };

async function listarPlantillas(forzar = false) {
  const { token, wabaId } = credenciales();
  if (!token || !wabaId) throw new Error('Faltan WHATSAPP_TOKEN o WHATSAPP_WABA_ID en Render.');
  if (!forzar && Date.now() - cachePlantillas.ts < 5 * 60 * 1000) return cachePlantillas.data;
  const url = `${GRAPH()}/${wabaId}/message_templates?fields=name,status,language,category,components&limit=200`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error?.message || `Error ${res.status} al leer plantillas`);
  const lista = (data.data || []).map((p) => {
    const body = (p.components || []).find((c) => c.type === 'BODY');
    const header = (p.components || []).find((c) => c.type === 'HEADER');
    const variables = body?.text ? (body.text.match(/\{\{\s*\d+\s*\}\}/g) || []).length : 0;
    return {
      nombre: p.name,
      idioma: p.language,
      estado: p.status,
      categoria: p.category,
      texto: body?.text || '',
      variables,
      header_formato: header?.format || null, // TEXT | IMAGE | VIDEO | DOCUMENT
      header_texto: header?.format === 'TEXT' ? header.text : null
    };
  });
  cachePlantillas = { ts: Date.now(), data: lista };
  return lista;
}

function reemplazarVars(valor, contacto) {
  return String(valor || '')
    .replace(/\{empresa\}/gi, contacto.empresa || contacto.nombre || '')
    .replace(/\{nombre\}/gi, contacto.nombre || contacto.empresa || '')
    .replace(/\{rubro\}/gi, contacto.rubro || '')
    .trim();
}

// params: textos para {{1}}, {{2}}... Pueden usar {empresa} {nombre} {rubro}
async function enviarPlantilla(tel, { nombre, idioma = 'es_AR', params = [], headerImagen = null, texto = '' }, autor = 'campania') {
  const contacto = getContacto(tel) || { telefono: tel };
  const componentes = [];
  if (headerImagen) {
    componentes.push({ type: 'header', parameters: [{ type: 'image', image: { link: headerImagen } }] });
  }
  if (params.length) {
    componentes.push({
      type: 'body',
      parameters: params.map((p) => ({ type: 'text', text: reemplazarVars(p, contacto) || '-' }))
    });
  }
  // Texto de referencia para ver en el panel qué se mandó
  let vista = texto || `[Plantilla ${nombre}]`;
  params.forEach((p, i) => {
    vista = vista.replace(new RegExp(`\\{\\{\\s*${i + 1}\\s*\\}\\}`, 'g'), reemplazarVars(p, contacto));
  });

  try {
    const wa_id = await enviarAMeta({
      to: tel,
      type: 'template',
      template: { name: nombre, language: { code: idioma }, ...(componentes.length ? { components: componentes } : {}) }
    });
    guardarMensaje({ telefono: tel, direccion: 'out', autor, tipo: 'template', contenido: vista, wa_id, estado: 'sent' });
    db.prepare('UPDATE wa_contactos SET ultima_plantilla_at = ? WHERE telefono = ?').run(now(), tel);
    if (contacto.estado === 'nuevo') setContacto(tel, { estado: 'contactado' });
    return { ok: true, wa_id };
  } catch (e) {
    guardarMensaje({ telefono: tel, direccion: 'out', autor, tipo: 'template', contenido: vista, estado: 'failed', error: e.message });
    return { ok: false, error: e.message, code: e.code };
  }
}

/* ============================ CAMPAÑAS (envío controlado) ============================ */

function inicioDelDiaAR() {
  // Medianoche de Argentina (UTC-3) en ISO
  const d = new Date(Date.now() - 3 * 3600 * 1000);
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() + 3 * 3600 * 1000).toISOString();
}

function enviosHoy() {
  return db
    .prepare(`SELECT COUNT(*) n FROM wa_mensajes WHERE direccion='out' AND tipo='template' AND autor='campania' AND estado != 'failed' AND created_at >= ?`)
    .get(inicioDelDiaAR()).n;
}

function limiteDiario() {
  const n = parseInt(getConfig().wa_limite_diario, 10);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

let campania = { activa: false, total: 0, enviados: 0, fallidos: 0, salteados: 0, detalle: [], inicio: null, fin: null };

function estadoCampania() {
  return { ...campania, detalle: campania.detalle.slice(-200) };
}

// Revisa a quién se puede mandar y arranca el envío en segundo plano (con pausas entre mensajes)
function iniciarCampania({ telefonos = [], plantilla, forzar = false }) {
  if (campania.activa) throw new Error('Ya hay una campaña enviándose. Esperá que termine.');
  if (!plantilla || !plantilla.nombre) throw new Error('Elegí una plantilla.');

  const disponibles = Math.max(limiteDiario() - enviosHoy(), 0);
  const hace30 = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const cola = [];
  const salteados = [];

  for (const t of [...new Set(telefonos)]) {
    const c = getContacto(t);
    if (!c) { salteados.push({ telefono: t, motivo: 'no existe' }); continue; }
    if (c.estado === 'baja') { salteados.push({ telefono: t, motivo: 'pidió la baja' }); continue; }
    if (!forzar && c.ultima_plantilla_at && c.ultima_plantilla_at > hace30) {
      salteados.push({ telefono: t, motivo: 'ya recibió plantilla en los últimos 30 días' }); continue;
    }
    if (cola.length >= disponibles) { salteados.push({ telefono: t, motivo: 'tope diario alcanzado' }); continue; }
    cola.push(t);
  }

  campania = {
    activa: cola.length > 0,
    total: cola.length,
    enviados: 0,
    fallidos: 0,
    salteados: salteados.length,
    detalle: salteados.map((s) => ({ ...s, resultado: 'salteado' })),
    inicio: now(),
    fin: cola.length ? null : now(),
    plantilla: plantilla.nombre
  };

  (async () => {
    for (const t of cola) {
      const r = await enviarPlantilla(t, plantilla, 'campania');
      if (r.ok) campania.enviados++;
      else {
        campania.fallidos++;
        // 131050: la persona frenó los mensajes de marketing de empresas
        if (r.code === 131050) setContacto(t, { estado: 'baja' });
      }
      campania.detalle.push({ telefono: t, resultado: r.ok ? 'enviado' : 'error', motivo: r.error || '' });
      // Si Meta corta por calidad o límite, frenamos todo
      if (!r.ok && [131048, 131056, 130429, 368].includes(r.code)) {
        campania.detalle.push({ telefono: '-', resultado: 'frenada', motivo: 'Meta limitó los envíos. Campaña detenida para cuidar el número.' });
        break;
      }
      await new Promise((ok) => setTimeout(ok, 4000 + Math.random() * 3000));
    }
    campania.activa = false;
    campania.fin = now();
    notifyEmail(
      `Campaña WhatsApp terminada — ${campania.enviados} enviados`,
      `Plantilla: ${campania.plantilla}\nEnviados: ${campania.enviados}\nCon error: ${campania.fallidos}\nSalteados: ${campania.salteados}`
    ).catch(() => {});
  })();

  return { aEnviar: cola.length, salteados, disponiblesHoy: disponibles };
}

/* ============================ WEBHOOK ============================ */

function verify(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && process.env.WHATSAPP_VERIFY_TOKEN && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
}

function firmaValida(req) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return true; // sin secreto configurado no se valida (recomendado configurarlo)
  const firma = req.headers['x-hub-signature-256'] || '';
  if (!req.rawBody || !firma.startsWith('sha256=')) return false;
  const esperado = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  const a = Buffer.from(firma);
  const b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function textoDeMensaje(msg) {
  switch (msg.type) {
    case 'text': return msg.text?.body || '';
    case 'button': return msg.button?.text || '';
    case 'interactive':
      return msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '';
    case 'image': return msg.image?.caption ? `[imagen] ${msg.image.caption}` : '[imagen]';
    case 'audio': return '[audio]';
    case 'video': return '[video]';
    case 'document': return `[documento] ${msg.document?.filename || ''}`;
    case 'sticker': return '[sticker]';
    case 'location': return '[ubicación]';
    case 'reaction': return `[reacción ${msg.reaction?.emoji || ''}]`;
    default: return `[${msg.type}]`;
  }
}

const RE_BAJA = /^\s*(baja|stop|no me escriban|no me escribas|no quiero (recibir )?(m[aá]s )?mensajes)\s*[.!]*\s*$/i;
const RE_HUMANO = /(hablar|comunicarme|charlar) con (una persona|alguien|marcos|un asesor|un humano)|\bhumano\b|\basesor\b/i;

// Mensajes que se procesan en orden por contacto, para que no se pisen las respuestas
const colas = new Map();
function encolar(tel, fn) {
  const prev = colas.get(tel) || Promise.resolve();
  const next = prev.then(fn).catch((e) => console.error('[WA] error procesando', tel, e.message));
  colas.set(tel, next);
  next.finally(() => { if (colas.get(tel) === next) colas.delete(tel); });
  return next;
}

async function procesarEntrante(msg, perfil) {
  const tel = normalizarTelefono(msg.from) || msg.from;
  const texto = textoDeMensaje(msg);
  const referral = msg.referral; // viene cuando la persona tocó un anuncio "Click to WhatsApp"
  const desdeAnuncio = !!referral;

  // Evitar procesar dos veces el mismo mensaje (Meta reintenta)
  if (msg.id && db.prepare('SELECT 1 FROM wa_mensajes WHERE wa_id = ?').get(msg.id)) return;

  const { creado, contacto: c0 } = upsertContacto(tel, {
    nombre: perfil?.name,
    fuente: desdeAnuncio ? 'anuncio' : 'whatsapp',
    anuncio: referral ? (referral.headline || referral.source_id || 'anuncio') : null,
    estado: 'respondio'
  });

  guardarMensaje({ telefono: tel, direccion: 'in', autor: 'cliente', tipo: msg.type, contenido: texto, wa_id: msg.id, estado: 'recibido' });
  db.prepare('UPDATE wa_contactos SET no_leidos = COALESCE(no_leidos,0) + 1 WHERE telefono = ?').run(tel);

  let c = getContacto(tel);

  // Avisos por email
  if (creado) {
    try {
      const leads = require('./leads');
      leads.saveLead({
        nombre: c.nombre,
        telefono: tel,
        empresa: c.empresa,
        interes: texto.slice(0, 200),
        fuente: desdeAnuncio ? 'whatsapp-anuncio' : 'whatsapp',
        session_id: `wa:${tel}`,
        notas: referral ? `Anuncio: ${referral.headline || ''} ${referral.source_url || ''}`.trim() : null
      });
    } catch (e) { /* no frenar */ }
  } else if (['nuevo', 'contactado'].includes(c0.estado)) {
    setContacto(tel, { estado: 'respondio' });
    notifyEmail(
      `Te respondió por WhatsApp: ${c.empresa || c.nombre || mostrarTelefono(tel)}`,
      `Contacto: ${c.empresa || c.nombre || '-'} (${mostrarTelefono(tel)})\nFuente: ${c.fuente}\nMensaje: ${texto}`
    ).catch(() => {});
    c = getContacto(tel);
  }

  // Pedido de baja
  if (msg.type === 'text' && RE_BAJA.test(texto)) {
    setContacto(tel, { estado: 'baja', bot_activo: 0 });
    await enviarTexto(tel, 'Listo, no te vamos a escribir más. Si algún día querés saber de MARTOKEN, escribinos acá. ¡Gracias!', 'bot');
    return;
  }

  // ¿Responde el bot?
  const cfg = getConfig();
  if (cfg.wa_bot_activo === '0') return;
  if (!c.bot_activo || c.estado === 'baja') return;
  if (c.pausa_hasta && c.pausa_hasta > now()) return;
  if (msg.type === 'reaction') return;

  // Pide hablar con una persona → pasa a Marcos
  if (msg.type === 'text' && RE_HUMANO.test(texto)) {
    setContacto(tel, { bot_activo: 0, estado: 'interesado' });
    await enviarTexto(tel, 'Perfecto, le aviso a Marcos y te escribe personalmente en un rato. 🙌', 'bot');
    notifyEmail(
      `Pide hablar con vos por WhatsApp: ${c.nombre || mostrarTelefono(tel)}`,
      `Contacto: ${c.nombre || '-'} (${mostrarTelefono(tel)})\nÚltimo mensaje: ${texto}\n\nEl bot quedó pausado con este contacto. Respondé desde el celular o desde el panel /whatsapp.`
    ).catch(() => {});
    return;
  }

  if (!['text', 'button', 'interactive'].includes(msg.type)) {
    await enviarTexto(tel, 'Recibí tu mensaje 🙌 Por ahora leo solo texto. ¿Me lo escribís así te respondo?', 'bot');
    return;
  }

  // Historial reciente de la conversación para que el bot tenga contexto
  const previos = db
    .prepare(`SELECT direccion, contenido FROM wa_mensajes WHERE telefono = ? AND estado != 'failed' ORDER BY id DESC LIMIT 13`)
    .all(tel)
    .reverse()
    .slice(0, -1) // el último es el mensaje actual
    .map((m) => ({ role: m.direccion === 'in' ? 'user' : 'assistant', content: m.contenido }));

  let extra = cfg.wa_instrucciones || '';
  if (c.nombre) extra += `\nLa persona se llama (según su perfil de WhatsApp): ${c.nombre}.`;
  if (referral) extra += `\nLlegó tocando el anuncio: "${referral.headline || ''} ${referral.body || ''}". Arrancá retomando ese tema.`;
  if (c.fuente === 'buscador') extra += `\nEs una empresa (${c.empresa || ''}${c.rubro ? ', rubro ' + c.rubro : ''}) a la que le escribimos primero; está respondiendo a nuestro mensaje.`;

  let respuesta;
  try {
    respuesta = await chat({ modulo: 'martoken', message: texto, history: previos, extra, maxTokens: 500 });
  } catch (e) {
    console.error('[WA] Groq:', e.message);
    return; // si falla la IA, no mandamos nada raro; queda para responder a mano
  }

  // Formato WhatsApp: **negrita** → *negrita*, sin títulos markdown
  respuesta = respuesta.replace(/\*\*(.+?)\*\*/g, '*$1*').replace(/^#{1,6}\s*/gm, '');

  // Registro en consultas (para el reporte general del agente)
  try {
    db.prepare('INSERT INTO consultas (created_at, session_id, modulo, canal, pregunta, respuesta) VALUES (?,?,?,?,?,?)')
      .run(now(), `wa:${tel}`, 'martoken', 'whatsapp', texto, respuesta);
  } catch {}

  await enviarTexto(tel, respuesta, 'bot');
}

// Mensajes que Marcos manda desde la app WhatsApp Business del celular (coexistencia)
function procesarEco(eco) {
  const tel = normalizarTelefono(eco.to) || eco.to;
  if (eco.id && db.prepare('SELECT 1 FROM wa_mensajes WHERE wa_id = ?').get(eco.id)) return;
  upsertContacto(tel, { fuente: 'whatsapp' });
  guardarMensaje({ telefono: tel, direccion: 'out', autor: 'celular', tipo: eco.type, contenido: textoDeMensaje(eco), wa_id: eco.id, estado: 'sent' });
  // Marcos tomó la conversación: el bot se calla un rato con este contacto
  setContacto(tel, { pausa_hasta: new Date(Date.now() + PAUSA_ECO_MS).toISOString() });
}

function procesarEstado(st) {
  if (!st.id) return;
  const error = st.errors?.[0];
  db.prepare('UPDATE wa_mensajes SET estado = ?, error = COALESCE(?, error) WHERE wa_id = ?')
    .run(st.status, error ? `${error.code}: ${error.title || error.message || ''}` : null, st.id);
  if (error && error.code === 131050 && st.recipient_id) {
    setContacto(normalizarTelefono(st.recipient_id) || st.recipient_id, { estado: 'baja' });
  }
}

async function receive(req, res) {
  if (!firmaValida(req)) return res.sendStatus(401);
  res.sendStatus(200); // responder rápido a Meta
  try {
    for (const entry of req.body?.entry || []) {
      for (const change of entry.changes || []) {
        const v = change.value || {};
        const perfiles = Object.fromEntries((v.contacts || []).map((c) => [c.wa_id, c.profile]));
        for (const st of v.statuses || []) procesarEstado(st);
        for (const eco of v.message_echoes || []) procesarEco(eco);
        for (const msg of v.messages || []) {
          const tel = normalizarTelefono(msg.from) || msg.from;
          encolar(tel, () => procesarEntrante(msg, perfiles[msg.from]));
        }
      }
    }
  } catch (e) {
    console.error('[WA] webhook:', e.message);
  }
}

/* ============================ CONSULTAS PARA EL PANEL ============================ */

function listarContactos({ filtro = '', q = '' } = {}) {
  let sql = `SELECT c.*,
      (SELECT contenido FROM wa_mensajes m WHERE m.telefono = c.telefono ORDER BY id DESC LIMIT 1) AS ultimo_texto,
      (SELECT MAX(created_at) FROM wa_mensajes m WHERE m.telefono = c.telefono) AS ultima_actividad
    FROM wa_contactos c WHERE 1=1`;
  const params = {};
  if (filtro === 'conversaciones') sql += ` AND EXISTS (SELECT 1 FROM wa_mensajes m WHERE m.telefono = c.telefono AND m.direccion = 'in')`;
  else if (filtro && filtro !== 'todos') { sql += ' AND (c.estado = @f OR c.fuente = @f)'; params.f = filtro; }
  if (q) { sql += ' AND (c.nombre LIKE @q OR c.empresa LIKE @q OR c.telefono LIKE @q OR c.rubro LIKE @q)'; params.q = `%${q}%`; }
  sql += ' ORDER BY COALESCE(ultima_actividad, c.created_at) DESC LIMIT 1000';
  return db.prepare(sql).all(params).map((c) => ({ ...c, ventana_abierta: ventanaAbierta(c), telefono_vista: mostrarTelefono(c.telefono) }));
}

function conversacion(tel) {
  const c = getContacto(tel);
  if (!c) return null;
  setContacto(tel, { no_leidos: 0 });
  const mensajes = db.prepare('SELECT * FROM wa_mensajes WHERE telefono = ? ORDER BY id ASC LIMIT 500').all(tel);
  return { contacto: { ...c, ventana_abierta: ventanaAbierta(c), telefono_vista: mostrarTelefono(tel) }, mensajes };
}

function resumen() {
  const cfg = getConfig();
  const porEstado = Object.fromEntries(db.prepare('SELECT estado, COUNT(*) n FROM wa_contactos GROUP BY estado').all().map((r) => [r.estado, r.n]));
  const porFuente = Object.fromEntries(db.prepare('SELECT fuente, COUNT(*) n FROM wa_contactos GROUP BY fuente').all().map((r) => [r.fuente, r.n]));
  const noLeidos = db.prepare('SELECT COALESCE(SUM(no_leidos),0) n FROM wa_contactos').get().n;
  return {
    configurado: {
      token: !!process.env.WHATSAPP_TOKEN,
      phone_id: !!process.env.WHATSAPP_PHONE_ID,
      waba_id: !!process.env.WHATSAPP_WABA_ID,
      verify_token: !!process.env.WHATSAPP_VERIFY_TOKEN,
      app_secret: !!process.env.WHATSAPP_APP_SECRET,
      disco_persistente: !!process.env.DATA_DIR && process.env.DATA_DIR.startsWith('/var/data')
    },
    bot_activo: cfg.wa_bot_activo !== '0',
    instrucciones: cfg.wa_instrucciones || '',
    limite_diario: limiteDiario(),
    envios_hoy: enviosHoy(),
    por_estado: porEstado,
    por_fuente: porFuente,
    no_leidos: noLeidos,
    campania: estadoCampania()
  };
}

// Importa contactos (del buscador o pegados a mano). Cada item: { nombre, telefono, whatsapp, rubro, ... }
function importarContactos(items = [], fuente = 'buscador', estado = 'nuevo') {
  let nuevos = 0, existentes = 0, invalidos = 0;
  const tx = db.transaction(() => {
    for (const it of items) {
      const tel = normalizarTelefono(it.whatsapp || it.telefono);
      if (!tel) { invalidos++; continue; }
      const { creado } = upsertContacto(tel, {
        nombre: it.nombre || it.empresa || null,
        empresa: it.empresa || it.nombre || null,
        rubro: it.rubro || null,
        fuente,
        estado,
        notas: [it.direccion && `Dirección: ${it.direccion}`, it.web && `Web: ${it.web}`, it.localidad && `Localidad: ${it.localidad}`]
          .filter(Boolean).join(' | ') || null
      });
      creado ? nuevos++ : existentes++;
    }
  });
  tx();
  return { nuevos, existentes, invalidos };
}

module.exports = {
  verify,
  receive,
  sendMessage,
  enviarTexto,
  enviarPlantilla,
  listarPlantillas,
  iniciarCampania,
  estadoCampania,
  listarContactos,
  conversacion,
  resumen,
  importarContactos,
  getContacto,
  setContacto,
  upsertContacto,
  ventanaAbierta
};
