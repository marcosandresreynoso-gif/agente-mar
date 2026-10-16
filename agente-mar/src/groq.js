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

async function fetchGroq(body, { maxEsperaMs = 15000 } = {}) {
  if (GROQ_KEYS.length === 0) throw new Error('No hay ninguna GROQ_API_KEY configurada en Render.');
  const limite = Date.now() + maxEsperaMs;
  for (;;) {
    let esperaSugerida = 0;
    for (let i = 0; i < GROQ_KEYS.length; i++) {
      const key = nextKey();
      const res = await fetch(GROQ_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body)
      });
      if (res.status !== 429) return res;
      // Groq dice cuántos segundos esperar (retry-after); si no, 6 s
      const ra = parseFloat(res.headers.get('retry-after')) || 6;
      esperaSugerida = esperaSugerida ? Math.min(esperaSugerida, ra) : ra;
      await res.text().catch(() => {});
    }
    const espera = Math.min(Math.max(esperaSugerida, 1) * 1000 + 500, 30000);
    if (Date.now() + espera > limite) {
      throw new Error(
        `Groq está al límite (${GROQ_KEYS.length} key${GROQ_KEYS.length === 1 ? '' : 's'} cargada${GROQ_KEYS.length === 1 ? '' : 's'}). Probá de nuevo en un minuto.`
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
async function complete(systemMsg, userMsg, { json = false, maxTokens = 700, temperature = 0.1, maxEsperaMs = 15000 } = {}) {
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

  let res = await fetchGroq(body, { maxEsperaMs });
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
async function buscarWeb(pregunta, { maxEsperaMs = 60000 } = {}) {
  const hoy = new Date().toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
  const body = {
    model: MODELO_BUSQUEDA,
    messages: [
      { role: 'system', content:
        `Sos investigador. Hoy es ${hoy}. Buscá en internet información ACTUAL y verificable para Argentina sobre lo que se pide. ` +
        'Priorizá fuentes oficiales (argentina.gob.ar, arca.gob.ar, cnv.gob.ar, boletinoficial.gob.ar, infoleg) y medios especializados reconocidos. ' +
        'Respondé en español: primero los hechos concretos en viñetas (con fecha o vigencia cuando corresponda), ' +
        'después "Fuentes:" con la URL de cada dato. Si no encontrás algo, decí "No encontrado" en vez de suponer. No inventes.' },
      { role: 'user', content: String(pregunta).slice(0, 2000) }
    ],
    tools: [{ type: 'browser_search' }],
    tool_choice: 'required',
    reasoning_effort: 'low',
    temperature: 0.2,
    max_tokens: 3500
  };
  try {
    const res = await fetchGroq(body, { maxEsperaMs });
    if (!res.ok) { console.error('[buscarWeb] Groq', res.status, (await res.text().catch(() => '')).slice(0, 200)); return ''; }
    const data = await res.json();
    return (data.choices?.[0]?.message?.content || '').replace(/【[^】]*】/g, '').trim();
  } catch (e) {
    console.error('[buscarWeb]', e.message);
    return '';
  }
}

module.exports = { chat, complete, MODULOS, cantidadKeys, buscarWeb };
