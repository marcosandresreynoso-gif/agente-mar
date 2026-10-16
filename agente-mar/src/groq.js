// src/groq.js — Cliente del modelo (Groq) con prompts por módulo + contexto de documentos
const { getConfig } = require('./db');
const rag = require('./rag');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

// Rotación de keys Groq — usa GROQ_API_KEY, GROQ_API_KEY_2, GROQ_API_KEY_3, GROQ_API_KEY_4
// Si una key está al límite (429), pasa automáticamente a la siguiente.
const GROQ_KEYS = [
  process.env.GROQ_API_KEY,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
  process.env.GROQ_API_KEY_4,
].filter(Boolean);

let keyIndex = 0;
function nextKey() {
  const key = GROQ_KEYS[keyIndex % GROQ_KEYS.length];
  keyIndex++;
  return key;
}

// Groq gratis limita pedidos y "tokens por minuto" por cada key.
// Si todas las keys están al límite, en vez de fallar de una, ESPERA lo que Groq indica y reintenta,
// hasta un máximo (maxEsperaMs). Las misiones del equipo esperan más; el chat público, poco.
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// Keys que agotaron el cupo DIARIO de un modelo: no se vuelven a usar con ese modelo hasta que se renueve
const agotadas = new Map();   // `${key}|${modelo}` -> timestamp hasta cuando
// "Please try again in 7m12.5s" -> ms
function esperaDeMensaje(txt) {
  const m = String(txt).match(/try again in\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:([\d.]+)s)?/i);
  if (!m || !(m[1] || m[2] || m[3])) return 0;
  return ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (parseFloat(m[3]) || 0)) * 1000;
}
const errorGroq = (msg, extra) => Object.assign(new Error(msg), extra);

async function fetchGroq(body, { maxEsperaMs = 15000 } = {}) {
  if (GROQ_KEYS.length === 0) throw new Error('No hay ninguna GROQ_API_KEY configurada en Render.');
  const limite = Date.now() + maxEsperaMs;
  const modelo = body.model;
  for (;;) {
    let esperaSugerida = 0, probadas = 0;
    for (let i = 0; i < GROQ_KEYS.length; i++) {
      const key = nextKey();
      const hasta = agotadas.get(`${key}|${modelo}`);
      if (hasta && hasta > Date.now()) continue;           // esta key ya gastó el cupo del día con este modelo
      probadas++;
      const res = await fetch(GROQ_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body)
      });
      if (res.status !== 429) return res;
      const txt = await res.text().catch(() => '');
      if (/per day|\(TPD\)|\(RPD\)/i.test(txt)) {
        // Cupo diario agotado: esperar no sirve; se marca la key y se sigue con las otras
        const ms = esperaDeMensaje(txt) || 60 * 60 * 1000;
        agotadas.set(`${key}|${modelo}`, Date.now() + ms);
        console.warn(`[groq] key …${key.slice(-4)} sin cupo diario para ${modelo} por ${Math.round(ms / 60000)} min`);
        continue;
      }
      // Límite por minuto: Groq dice cuántos segundos esperar (retry-after); si no, 6 s
      const ra = parseFloat(res.headers.get('retry-after')) || esperaDeMensaje(txt) / 1000 || 6;
      esperaSugerida = esperaSugerida ? Math.min(esperaSugerida, ra) : ra;
    }
    if (!probadas || !esperaSugerida) {
      throw errorGroq(`Se terminó el cupo diario gratis de Groq para ${modelo} en las ${GROQ_KEYS.length} keys.`, { cupoDiario: true });
    }
    const espera = Math.min(Math.max(esperaSugerida, 1) * 1000 + 500, 30000);
    if (Date.now() + espera > limite) {
      throw errorGroq(
        `Groq está al límite (${GROQ_KEYS.length} key${GROQ_KEYS.length === 1 ? '' : 's'} cargada${GROQ_KEYS.length === 1 ? '' : 's'}). Probá de nuevo en un minuto.`,
        { alLimite: true }
      );
    }
    console.log(`[groq] keys al límite, espero ${Math.round(espera / 1000)} s y reintento`);
    await dormir(espera);
  }
}

const MODULOS = {
  comercial: {
    nombre: 'Comercial',
    foco:
      'Ventas, captación de clientes, propuesta de valor, marketing, pricing de servicios y posicionamiento.'
  },
  contable: {
    nombre: 'Contable',
    foco:
      'AFIP, monotributo, categorías, inscripciones, facturación, retenciones y obligaciones impositivas en Argentina.'
  },
  finanzas: {
    nombre: 'Finanzas',
    foco:
      'Organización de finanzas personales y del negocio, flujo de caja, costos, márgenes, inversión y rentabilidad.'
  },
  legal: {
    nombre: 'Legal',
    foco:
      'Contratos, protección de propiedad intelectual, formas societarias, fideicomisos y riesgos legales del emprendedor.'
  },
  martoken: {
    nombre: 'MARTOKEN (WhatsApp)',
    foco:
      'MARTOKEN: tokenización inmobiliaria sobre Polygon, el proyecto MAR-01, cómo invertir, cómo se genera el retorno, respaldo legal en fideicomiso.'
  },
  todos: {
    nombre: 'Integral',
    foco:
      'Visión integral: combina lo comercial, contable, financiero y legal según lo que necesite la consulta.'
  }
};

function systemPrompt(modulo, contexto, extra) {
  const cfg = getConfig();
  const m = MODULOS[modulo] || MODULOS.todos;
  let base =
    `Sos el Agente Integral de ${cfg.empresa_nombre}. ` +
    `${cfg.empresa_descripcion} Ubicación: ${cfg.empresa_ubicacion}.\n\n` +
    `Estás operando en el módulo ${m.nombre}. Foco: ${m.foco}\n\n` +
    `Tono: ${cfg.tono}\n` +
    `Reglas:\n` +
    `- Respuestas concretas y accionables, sin relleno.\n` +
    `- Si la consulta excede tu módulo, respondés igual pero aclarás brevemente desde qué área.\n` +
    `- Si no sabés algo con certeza, lo decís; no inventás datos legales ni impositivos.\n` +
    `- Cuando detectes interés real, invitá a dejar nombre y contacto para que un asesor siga la conversación.\n`;

  if (extra && String(extra).trim()) {
    base += `\nINSTRUCCIONES DEL CANAL (tienen prioridad sobre las reglas anteriores):\n${extra}\n`;
  }

  if (contexto && contexto.trim()) {
    base +=
      `\nDOCUMENTACIÓN DE LA EMPRESA (usá esto como fuente principal cuando aplique; ` +
      `si la respuesta está acá, basate en esto antes que en conocimiento general):\n"""\n${contexto}\n"""\n`;
  }
  return base;
}

async function chat({ modulo = 'todos', message, history = [], extra = '', maxTokens = 900 }) {
  // Recuperar fragmentos relevantes de los documentos cargados
  let contexto = '';
  try {
    contexto = rag.retrieve(message, MODULOS[modulo] && modulo !== 'martoken' ? modulo : 'todos', 4);
  } catch (e) {
    contexto = '';
  }

  const msgs = [
    { role: 'system', content: systemPrompt(modulo, contexto, extra) },
    ...history.slice(-8).map((h) => ({
      role: h.role === 'user' ? 'user' : 'assistant',
      content: String(h.content || '').slice(0, 4000)
    })),
    { role: 'user', content: String(message).slice(0, 4000) }
  ];

  const res = await fetchGroq({
    model: MODEL,
    messages: msgs,
    temperature: 0.4,
    max_tokens: maxTokens
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Groq ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || 'No pude generar una respuesta en este momento.';
}

// Llamada genérica al modelo (para extracción de leads y reportes)
// Groq gratis limita los tokens por minuto POR PEDIDO (gpt-oss-120b: 8000, contando texto enviado + max_tokens).
// Si el pedido es más grande, Groq responde 413 y la tarea se pierde. Por eso se recorta ANTES de enviar.
const LIMITE_TPM = parseInt(process.env.GROQ_TPM_LIMIT, 10) || 7600;
const estimarTokens = (t) => Math.ceil(String(t || '').length / 3);   // estimación conservadora para español
// Recorta un texto largo dejando el principio y el final (lo del medio suele ser lo menos importante)
function recortar(texto, maxChars) {
  const t = String(texto || '');
  if (t.length <= maxChars) return t;
  const cabeza = Math.floor(maxChars * 0.7), cola = maxChars - cabeza - 40;
  return t.slice(0, cabeza) + '\n[…texto recortado para no exceder el límite…]\n' + t.slice(t.length - Math.max(cola, 0));
}
function ajustarAlLimite(body, factor = 1) {
  const limite = Math.floor(LIMITE_TPM * factor);
  const msgs = body.messages;
  const total = () => msgs.reduce((n, m) => n + estimarTokens(m.content), 0) + body.max_tokens;
  if (total() <= limite) return false;
  // 1º: el mensaje del usuario (trabajo de compañeros, pedido); 2º: el system (documentación al final)
  for (const idx of [1, 0]) {
    const sobra = total() - limite;
    if (sobra <= 0) break;
    const m = msgs[idx];
    const nuevo = Math.max(m.content.length - sobra * 3 - 200, idx === 0 ? 4000 : 1500);
    m.content = recortar(m.content, nuevo);
  }
  if (total() > limite) body.max_tokens = Math.max(limite - (total() - body.max_tokens), 900);
  return true;
}

// Modelo de respaldo: tiene su propio cupo en Groq. Se usa si el principal se quedó sin cupo.
const MODEL_RESPALDO = process.env.GROQ_MODEL_RESPALDO || 'openai/gpt-oss-20b';

async function complete(systemMsg, userMsg, opciones = {}) {
  try {
    return await completeCon(MODEL, systemMsg, userMsg, opciones);
  } catch (e) {
    if (!(e.cupoDiario || e.alLimite) || !MODEL_RESPALDO || MODEL_RESPALDO === MODEL) throw e;
    console.warn(`[groq] ${MODEL} sin cupo (${e.message.slice(0, 80)}): uso el respaldo ${MODEL_RESPALDO}`);
    return await completeCon(MODEL_RESPALDO, systemMsg, userMsg, { ...opciones, maxEsperaMs: Math.min(opciones.maxEsperaMs || 15000, 45000) });
  }
}

async function completeCon(MODEL, systemMsg, userMsg, { json = false, maxTokens = 700, temperature = 0.1, maxEsperaMs = 15000 } = {}) {
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: systemMsg },
      { role: 'user', content: userMsg }
    ],
    temperature,
    max_tokens: maxTokens
  };
  // Los modelos gpt-oss "piensan" antes de responder y ese razonamiento consume max_tokens:
  // con poco margen la respuesta queda cortada y Groq rechaza el JSON (error 400).
  const razona = /gpt-oss/i.test(MODEL);
  if (razona) {
    body.reasoning_effort = 'low';
    body.max_tokens = Math.max(maxTokens + 1500, 2000);
  }
  if (json) body.response_format = { type: 'json_object' };
  if (ajustarAlLimite(body)) console.warn('[groq] pedido recortado para no exceder el límite de tokens');

  let res = await fetchGroq(body, { maxEsperaMs });
  if (!res.ok && res.status === 413) {
    // Igual se pasó: se recorta más fuerte y se reintenta una vez
    const t = await res.text().catch(() => '');
    console.warn('[groq] 413 (pedido muy grande), reintento recortado:', t.slice(0, 160));
    ajustarAlLimite(body, 0.7);
    res = await fetchGroq(body, { maxEsperaMs });
  }
  if (!res.ok && res.status === 400 && json) {
    // Segundo intento sin el modo JSON estricto; el JSON se extrae del texto.
    const t = await res.text().catch(() => '');
    console.warn('[groq] 400 en modo JSON, reintento sin response_format:', t.slice(0, 200));
    delete body.response_format;
    body.max_tokens = Math.max(body.max_tokens, 3000);
    res = await fetchGroq(body, { maxEsperaMs });
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Groq ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  let out = data.choices?.[0]?.message?.content?.trim() || '';
  if (json) {
    const ini = out.indexOf('{');
    const fin = out.lastIndexOf('}');
    if (ini > 0 || (fin >= 0 && fin < out.length - 1)) out = out.slice(ini, fin + 1);
  }
  return out;
}

const cantidadKeys = () => GROQ_KEYS.length;
console.log(`[groq] ${GROQ_KEYS.length} key(s) de Groq cargada(s)`);

// Búsqueda en internet con la herramienta browser_search de Groq (modelos gpt-oss).
// Devuelve un resumen con hechos y una lista de fuentes con URL. Si falla, devuelve '' y el agente sigue sin búsqueda.
const MODELO_BUSQUEDA = process.env.GROQ_MODEL_BUSQUEDA || 'openai/gpt-oss-120b';
// Comprueba que cada URL citada exista de verdad. Solo quedan los datos con una fuente que responde.
async function urlExiste(url) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (agente-mar verificador)' } });
    return r.status < 400 || r.status === 403 || r.status === 429;   // 403/429: la página existe pero bloquea robots
  } catch (e) { return false; } finally { clearTimeout(t); }
}
// Fecha más reciente que aparece en una viñeta (texto o URL). Devuelve {anio, fecha|null}
const MESES = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };
// La fecha de PUBLICACIÓN es la primera fecha del texto que no está en el futuro
// ("hasta el 31/12/2027" es un vencimiento, no la publicación). Si el texto no tiene, se usa la de la URL.
function fechaDe(linea) {
  const urls = (linea.match(/https?:\/\/\S+/g) || []).join(' ');
  const texto = linea.replace(/https?:\/\/\S+/g, ' ');
  const enOrden = (s, pats) => {
    const hall = [];
    for (const [re, f] of pats) for (const m of s.matchAll(re)) { const d = f(m); if (d && !isNaN(d)) hall.push({ i: m.index, d }); }
    return hall.sort((a, b) => a.i - b.i).map((h) => h.d);
  };
  const PAT_TEXTO = [
    [/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](20\d{2})\b/g, (m) => new Date(+m[3], +m[2] - 1, +m[1])],
    [/\b(\d{1,2})\s+(?:de\s+)?([a-záéíóú]+)\s+(?:de\s+)?(20\d{2})\b/gi, (m) => MESES[m[2].toLowerCase()] ? new Date(+m[3], MESES[m[2].toLowerCase()] - 1, +m[1]) : null]
  ];
  const PAT_URL = [
    [/(20[12]\d)(\d{2})(\d{2})(?!\d)/g, (m) => new Date(+m[1], +m[2] - 1, +m[3])],                    // /20241017
    [/(?:^|[^\d])(\d{2})-(\d{2})-(2\d)(?=[\/-]|$|[^\d])/g, (m) => new Date(2000 + +m[3], +m[2] - 1, +m[1])] // 23-10-24
  ];
  const manana = Date.now() + 864e5;
  const fecha = enOrden(texto, PAT_TEXTO).find((d) => d <= manana) || enOrden(urls, PAT_URL).find((d) => d <= manana) || null;
  const anios = [...texto.matchAll(/\b(20[12]\d)\b/g)].map((m) => +m[1]).filter((a) => a <= new Date().getFullYear());
  return { anio: fecha ? fecha.getFullYear() : (anios.length ? Math.min(...anios) : null), fecha };
}

async function verificarFuentes(texto, { novedades = false, diasMax = 45 } = {}) {
  if (!texto) return '';
  const lineas = texto.split('\n').map((l) => l.trim()).filter(Boolean);
  const urlsDe = (l) => (l.match(/https?:\/\/[^\s)\]>"']+/g) || []).map((u) => u.replace(/[.,;]+$/, ''));
  const todas = [...new Set(lineas.flatMap(urlsDe))].slice(0, 15);
  const ok = new Set();
  await Promise.all(todas.map(async (u) => { if (await urlExiste(u)) ok.add(u); }));
  const validas = [], descartadas = [], viejas = [];
  const hoy = new Date(), anioActual = hoy.getFullYear();
  for (const l0 of lineas) {
    let l = l0;
    if (!/^[-•*]/.test(l)) continue;                                   // solo viñetas con hechos
    if (/no encontrado/i.test(l)) { validas.push(l); continue; }
    const us = urlsDe(l);
    if (!(us.length && us.some((u) => ok.has(u)))) { descartadas.push(l); continue; }
    const { anio, fecha } = fechaDe(l);
    if (novedades) {
      // Pidieron novedades: solo vale lo publicado en los últimos días, con fecha
      const vieja = fecha ? (hoy - fecha) / 864e5 > diasMax : (anio ? anio < anioActual : true);
      if (vieja) { viejas.push(l); continue; }
    } else if (anio && anio <= anioActual - 2) {
      l += ` ⚠️ (dato de ${anio}: verificar si sigue vigente)`;
    }
    validas.push(l);
  }
  if (novedades && viejas.length) console.warn(`[buscarWeb] ${viejas.length} dato(s) viejos descartados (se pidieron novedades)`);
  if (!validas.filter((l) => !/no encontrado/i.test(l)).length) {
    if (novedades) return `- No encontrado: novedades confirmadas de los últimos ${diasMax} días con fecha y fuente verificable.` +
      (viejas.length ? ` (Se descartaron ${viejas.length} dato(s) de fechas anteriores: no son novedades.)` : '');
    console.error('[buscarWeb] ninguna fuente verificable: se descarta la investigación');
    return '';
  }
  let out = validas.join('\n');
  if (descartadas.length) out += `\n\n(Se descartaron ${descartadas.length} dato(s) cuya fuente no existe o no se pudo verificar.)`;
  if (viejas.length) out += `\n(Se descartaron ${viejas.length} dato(s) de fechas anteriores: no son novedades.)`;
  return out;
}

async function buscarWeb(pregunta, { maxEsperaMs = 60000, novedades = false } = {}) {
  const hoy = new Date().toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
  const mesAnio = new Date().toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', month: 'long', year: 'numeric' });
  const extraNovedades = novedades
    ? ` IMPORTANTE: piden NOVEDADES. Buscá solo lo publicado en los últimos 30 días (${mesAnio}): en el Boletín Oficial, ARCA y CNV las normas de este año tienen números altos. ` +
      'Cada viñeta EMPIEZA con la fecha de publicación en formato DD/MM/AAAA. Ignorá notas de años anteriores aunque aparezcan primero en el buscador. ' +
      'Si no hay novedades recientes de un tema, escribí "- No encontrado: novedades recientes sobre ...".'
    : '';
  const body = {
    model: MODELO_BUSQUEDA,
    messages: [
      { role: 'system', content:
        `Sos investigador. Hoy es ${hoy}. Buscá en internet información ACTUAL y verificable para Argentina sobre lo que se pide. ` +
        'Priorizá fuentes oficiales (argentina.gob.ar, arca.gob.ar, cnv.gob.ar, boletinoficial.gob.ar, infoleg) y medios especializados reconocidos. ' +
        'Respondé en español, SOLO con viñetas. Cada viñeta es UN hecho que leíste en una página, con fecha o vigencia si corresponde, ' +
        'y termina con la URL exacta de esa página entre paréntesis. Ejemplo: "- La Ley X está vigente desde ... (https://...)". ' +
        'No escribas nada que no hayas leído en una página que abriste. Si no encontrás algo, escribí "- No encontrado: ...". ' +
        'No cites números de ley ni artículos que no figuren textualmente en la página.' + extraNovedades },
      { role: 'user', content: (novedades ? `Novedades de ${mesAnio}. ` : '') + String(pregunta).slice(0, 2000) }
    ],
    tools: [{ type: 'browser_search' }],
    tool_choice: 'required',
    reasoning_effort: 'low',
    temperature: 0.2,
    max_tokens: 3500
  };
  try {
    let res;
    try { res = await fetchGroq(body, { maxEsperaMs }); } catch (e) {
      if (!(e.cupoDiario || e.alLimite) || MODEL_RESPALDO === body.model || !/gpt-oss/.test(MODEL_RESPALDO)) throw e;
      console.warn('[buscarWeb] sin cupo, busco con', MODEL_RESPALDO);
      body.model = MODEL_RESPALDO;
      res = await fetchGroq(body, { maxEsperaMs: 45000 });
    }
    if (!res.ok) { console.error('[buscarWeb] Groq', res.status, (await res.text().catch(() => '')).slice(0, 200)); return ''; }
    const data = await res.json();
    const msg = data.choices?.[0]?.message || {};
    // Si el modelo no ejecutó la búsqueda de verdad, lo que escribió no tiene respaldo: se descarta
    if (Array.isArray(msg.executed_tools) && msg.executed_tools.length === 0) {
      console.error('[buscarWeb] el modelo no buscó: se descarta la respuesta'); return '';
    }
    return await verificarFuentes((msg.content || '').replace(/【[^】]*】/g, '').trim(), { novedades });
  } catch (e) {
    console.error('[buscarWeb]', e.message);
    return '';
  }
}

// Lee una foto o captura (Meta Ads, planillas, WhatsApp, etc.) con el modelo de visión de Groq
// y devuelve TODO lo que se ve, en texto, para que los agentes trabajen con datos reales.
const MODELO_VISION = process.env.GROQ_MODEL_VISION || 'qwen/qwen3.8-27b';
const MODELO_VISION_RESPALDO = process.env.GROQ_MODEL_VISION_2 || 'meta-llama/llama-4-scout-17b-16e-instruct';
async function leerImagen(dataUrl, nombre = 'imagen') {
  const body = {
    model: MODELO_VISION,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text:
          `Esta imagen ("${nombre}") la subió Marcos, fundador de MARTOKEN, para que su equipo trabaje con datos reales. ` +
          'Transcribí en español TODO lo que se ve: títulos, nombres de campañas, fechas, períodos y cada número con su etiqueta ' +
          '(alcance, impresiones, clics, CTR, costo, CPL, resultados, preinscriptos, montos, etc.). ' +
          'Si hay una tabla, pasala fila por fila en líneas "etiqueta: valor". Si hay un gráfico, describí la tendencia y los valores visibles. ' +
          'Copiá los números EXACTAMENTE como aparecen. Si algo no se lee bien, escribí "(ilegible)". ' +
          'No interpretes, no opines y no agregues nada que no esté en la imagen.' },
        { type: 'image_url', image_url: { url: dataUrl } }
      ]
    }],
    temperature: 0.1,
    max_tokens: 2500
  };
  let res = await fetchGroq(body, { maxEsperaMs: 60000 });
  if (!res.ok && (res.status === 404 || res.status === 400) && MODELO_VISION_RESPALDO !== body.model) {
    // Si Groq dio de baja o no habilita el modelo, se prueba con el de respaldo
    console.warn('[leerImagen] modelo', body.model, 'falló (', res.status, '): pruebo', MODELO_VISION_RESPALDO, (await res.text().catch(() => '')).slice(0, 200));
    body.model = MODELO_VISION_RESPALDO;
    res = await fetchGroq(body, { maxEsperaMs: 60000 });
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    console.error('[leerImagen] Groq', res.status, t.slice(0, 300));
    throw new Error(res.status === 413
      ? 'La imagen es muy pesada. Probá con una captura más chica.'
      : `No se pudo leer la imagen (Groq ${res.status}).`);
  }
  const data = await res.json();
  // Algunos modelos escriben su razonamiento entre <think>…</think>: se descarta
  return String(data.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

module.exports = { chat, complete, MODULOS, cantidadKeys, buscarWeb, verificarFuentes, recortar, leerImagen, fechaDe };
