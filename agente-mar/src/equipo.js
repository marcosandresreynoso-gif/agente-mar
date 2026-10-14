// src/equipo.js — Oficina MARTOKEN: equipo de agentes con una Directora que reparte misiones.
//
// Cómo funciona:
//  1) Marcos escribe un pedido en el Centro de Misiones.
//  2) La Directora lo divide en 1 a 4 tareas y elige qué agente hace cada una.
//  3) Cada agente trabaja con su rol, la documentación (RAG) y los datos del sistema que le tocan.
//  4) La Directora junta todo en un informe final.
//
// Regla de oro: los agentes NUNCA ejecutan acciones por su cuenta (enviar mensajes, publicar,
// pagar, firmar). Solo las PROPONEN y quedan pendientes hasta que Marcos las aprueba en el panel.

const { db } = require('./db');
const { complete } = require('./groq');
const rag = require('./rag');

const now = () => new Date().toISOString();

/* ============================ EL EQUIPO ============================ */
// nivel = hasta qué nivel de riesgo puede avanzar solo (1 = solo analiza; todo lo demás requiere aprobación)
const AGENTES = {
  directora: {
    nombre: 'Victoria',
    puesto: 'Directora de Operaciones',
    area: 'Dirección',
    color: '#b8923f',
    inicial: 'V',
    lema: 'Divide lo imposible en pasos chicos.',
    responsabilidades: ['Analizar tus pedidos', 'Dividirlos en tareas', 'Asignar a cada agente', 'Unir los resultados en un informe', 'Avisarte qué necesita tu aprobación'],
    herramientas: ['Equipo completo', 'Historial de misiones'],
    autonomia: 'Organiza y reparte. No ejecuta acciones externas.',
    rag: 'todos',
    prompt:
      'Sos la Directora de Operaciones de MARTOKEN. Coordinás al equipo, priorizás con el criterio ' +
      '"Demanda primero. Terreno después." y presentás conclusiones claras y accionables para Marcos.'
  },
  captacion: {
    nombre: 'Lucía',
    puesto: 'Captación de Inversores',
    area: 'Comercial',
    color: '#25d366',
    inicial: 'L',
    lema: 'Cada lead es una persona, no un número.',
    responsabilidades: ['Analizar los leads de Facebook y WhatsApp', 'Calificar interés (frío / tibio / caliente)', 'Redactar respuestas y seguimientos', 'Detectar inversores desde USD 100'],
    herramientas: ['Contactos de WhatsApp', 'Leads', 'Documentación MARTOKEN'],
    autonomia: 'Redacta mensajes. Enviar requiere tu aprobación.',
    rag: 'comercial',
    datos: 'whatsapp',
    prompt:
      'Sos la responsable de Captación de Inversores de MARTOKEN. Convertís interesados en inversores de MAR-01 y ' +
      'preinscriptos de MAR-50. Escribís mensajes de WhatsApp cortos (4-5 líneas), cálidos y concretos. ' +
      'Nunca prometés rentabilidad garantizada ni pedís claves o datos bancarios.'
  },
  prospeccion: {
    nombre: 'Tomás',
    puesto: 'Prospección de Empresas',
    area: 'Comercial',
    color: '#5b8cff',
    inicial: 'T',
    lema: 'Primero la lista correcta, después el mensaje.',
    responsabilidades: ['Definir rubros y ciudades a prospectar', 'Analizar los leads del buscador', 'Redactar el primer contacto', 'Proponer campañas de plantillas'],
    herramientas: ['Leads del buscador', 'Contactos de WhatsApp'],
    autonomia: 'Propone listas y textos. Lanzar campañas requiere tu aprobación.',
    rag: 'comercial',
    datos: 'leads',
    prompt:
      'Sos el responsable de Prospección de Empresas de MARTOKEN. Buscás empresas y profesionales de la región ' +
      '(General Villegas y zona) que puedan invertir, ser socios o derivar inversores. Proponés rubros, ciudades y mensajes de primer contacto.'
  },
  atencion: {
    nombre: 'Sofía',
    puesto: 'Atención al Inversor',
    area: 'Inversores',
    color: '#46c98b',
    inicial: 'S',
    lema: 'La confianza se construye respuesta por respuesta.',
    responsabilidades: ['Responder dudas de tenedores de MAR-01', 'Explicar cómo se genera el retorno', 'Guiar con wallet y tokens', 'Armar preguntas frecuentes'],
    herramientas: ['Documentación MARTOKEN', 'Base de conocimiento MAR-01 y MAR-50'],
    autonomia: 'Redacta respuestas. Enviar a inversores requiere tu aprobación.',
    rag: 'todos',
    prompt:
      'Sos la responsable de Atención al Inversor de MARTOKEN. Respondés con paciencia y precisión a quienes ya ' +
      'invirtieron o están por invertir: cómo funciona el token, el fideicomiso, el retorno por alquiler o venta, y la wallet. ' +
      'Nunca pedís frases semilla ni claves.'
  },
  marketing: {
    nombre: 'Bruno',
    puesto: 'Marketing y Contenido',
    area: 'Marketing',
    color: '#e0618a',
    inicial: 'B',
    lema: 'Cada publicación cuenta una historia.',
    responsabilidades: ['Analizar el mercado y la competencia', 'Armar publicaciones para Facebook e Instagram', 'Calendario editorial', 'Textos de anuncios'],
    herramientas: ['Documentación MARTOKEN', 'Resumen de leads por fuente'],
    autonomia: 'Redacta contenido. Publicar requiere tu aprobación.',
    rag: 'comercial',
    datos: 'fuentes',
    prompt:
      'Sos el responsable de Marketing y Contenido de MARTOKEN. Escribís publicaciones y anuncios para Facebook e ' +
      'Instagram en español rioplatense, con gancho, claridad y llamada a la acción. Respetás que no se puede prometer rentabilidad garantizada.'
  },
  legal: {
    nombre: 'Martina',
    puesto: 'Legal y Fiduciario',
    area: 'Legal',
    color: '#9b7bff',
    inicial: 'M',
    lema: 'Lo que no está escrito, no existe.',
    responsabilidades: ['Revisar contratos y adendas', 'Estructura de cada fideicomiso', 'Detectar riesgos legales', 'Redactar borradores'],
    herramientas: ['Documentación legal', 'Base de conocimiento'],
    autonomia: 'Redacta borradores. Firmar o enviar documentos requiere tu aprobación.',
    rag: 'legal',
    prompt:
      'Sos la responsable Legal y Fiduciaria de MARTOKEN. Trabajás con fideicomisos (Fideicomiso Madre MARTOKEN y ' +
      'fideicomisos operativos por proyecto), contratos de adhesión y riesgos legales en Argentina. Señalás cuándo hace falta un abogado matriculado.'
  },
  finanzas: {
    nombre: 'Diego',
    puesto: 'Finanzas y Retornos',
    area: 'Finanzas',
    color: '#41b6c4',
    inicial: 'D',
    lema: 'Los números no mienten si se miran bien.',
    responsabilidades: ['Calcular retornos y flujos', 'Preparar distribuciones en USDT', 'Costos y márgenes de cada proyecto', 'Escenarios de inversión'],
    herramientas: ['Documentación financiera', 'Base de conocimiento'],
    autonomia: 'Calcula y prepara. Cualquier pago lo firmás vos con MetaMask.',
    rag: 'finanzas',
    prompt:
      'Sos el responsable de Finanzas y Retornos de MARTOKEN. Hacés cuentas claras (mostrá los números paso a paso), ' +
      'armás escenarios conservador / base / optimista y preparás distribuciones. Nunca ejecutás pagos.'
  },
  analista: {
    nombre: 'Ramiro',
    puesto: 'Analista de Proyectos',
    area: 'Proyectos',
    color: '#f08c3c',
    inicial: 'R',
    lema: 'Demanda primero. Terreno después.',
    responsabilidades: ['Evaluar proyectos nuevos para tokenizar', 'Validar la demanda antes de invertir', 'Comparar oportunidades', 'Detectar riesgos del negocio'],
    herramientas: ['Base de conocimiento', 'Historial de misiones'],
    autonomia: 'Solo analiza y recomienda.',
    rag: 'todos',
    prompt:
      'Sos el Analista de Proyectos de MARTOKEN. Evaluás oportunidades nuevas de tokenización (inmuebles, campo, ' +
      'deudas, acciones de empresas) con el criterio "Demanda primero. Terreno después.": primero validar quién compra y por qué, después ejecutar.'
  },
  cumplimiento: {
    nombre: 'Elena',
    puesto: 'Cumplimiento Regulatorio',
    area: 'Legal',
    color: '#ef6b6b',
    inicial: 'E',
    lema: 'Crecer sin sorpresas.',
    responsabilidades: ['Seguir normas de CNV y ARCA', 'Revisar textos públicos (sin promesas indebidas)', 'Prevención de lavado (KYC)', 'Alertar riesgos regulatorios'],
    herramientas: ['Base de conocimiento'],
    autonomia: 'Solo revisa y alerta.',
    rag: 'legal',
    prompt:
      'Sos la responsable de Cumplimiento Regulatorio de MARTOKEN. Revisás que lo que se comunica y se hace respete ' +
      'la normativa argentina (CNV, ARCA, UIF/KYC). Marcás con claridad qué es riesgo alto, medio o bajo. Si no estás segura de una norma, lo decís.'
  }
};

const ORDEN = ['directora', 'captacion', 'prospeccion', 'atencion', 'marketing', 'legal', 'finanzas', 'analista', 'cumplimiento'];

function listarAgentes() {
  return ORDEN.map((id) => {
    const a = AGENTES[id];
    return { id, nombre: a.nombre, puesto: a.puesto, area: a.area, color: a.color, inicial: a.inicial, lema: a.lema,
      responsabilidades: a.responsabilidades, herramientas: a.herramientas, autonomia: a.autonomia };
  });
}

/* ============================ BASE DE DATOS ============================ */
function initEquipo() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS eq_misiones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      finished_at TEXT,
      pedido TEXT NOT NULL,
      estado TEXT DEFAULT 'planificando',   -- planificando | trabajando | terminada | error
      resumen_plan TEXT,
      informe TEXT,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS eq_tareas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mision_id INTEGER NOT NULL,
      orden INTEGER,
      agente TEXT,
      tarea TEXT,
      estado TEXT DEFAULT 'pendiente',      -- pendiente | trabajando | lista | error
      resultado TEXT,
      started_at TEXT,
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS eq_acciones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      mision_id INTEGER,
      agente TEXT,
      descripcion TEXT,
      estado TEXT DEFAULT 'pendiente',      -- pendiente | aprobada | rechazada
      decidida_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_eq_tareas_m ON eq_tareas(mision_id, orden);
  `);
}

/* ============================ DATOS PARA CADA AGENTE ============================ */
function datosDelSistema(tipo) {
  try {
    if (tipo === 'whatsapp') {
      const porEstado = db.prepare('SELECT estado, COUNT(*) n FROM wa_contactos GROUP BY estado').all();
      const calientes = db.prepare(
        `SELECT nombre, empresa, estado, fuente, anuncio, notas, ultimo_entrante_at FROM wa_contactos
         WHERE estado IN ('respondio','interesado') ORDER BY ultimo_entrante_at DESC LIMIT 12`
      ).all();
      return 'Contactos de WhatsApp por estado: ' + (porEstado.map((r) => `${r.estado}: ${r.n}`).join(', ') || 'sin contactos') +
        '\nContactos que respondieron o están interesados (sin teléfonos):\n' +
        (calientes.map((c) => `- ${c.nombre || c.empresa || 's/n'} · ${c.estado} · vino por ${c.fuente || '?'}${c.anuncio ? ' (' + c.anuncio + ')' : ''}${c.notas ? ' · notas: ' + c.notas : ''}`).join('\n') || '- ninguno todavía');
    }
    if (tipo === 'leads') {
      const porFuente = db.prepare('SELECT fuente, COUNT(*) n FROM leads GROUP BY fuente').all();
      const ultimos = db.prepare('SELECT empresa, nombre, interes, fuente, notas FROM leads ORDER BY id DESC LIMIT 12').all();
      return 'Leads por fuente: ' + (porFuente.map((r) => `${r.fuente || 'sin fuente'}: ${r.n}`).join(', ') || 'sin leads') +
        '\nÚltimos leads (sin datos de contacto):\n' +
        (ultimos.map((l) => `- ${l.empresa || l.nombre || 's/n'} · ${l.interes || ''} · ${l.fuente || ''}${l.notas ? ' · ' + l.notas : ''}`).join('\n') || '- ninguno');
    }
    if (tipo === 'fuentes') {
      const porFuente = db.prepare('SELECT fuente, COUNT(*) n FROM wa_contactos GROUP BY fuente').all();
      const anuncios = db.prepare(`SELECT anuncio, COUNT(*) n FROM wa_contactos WHERE anuncio IS NOT NULL GROUP BY anuncio ORDER BY n DESC LIMIT 8`).all();
      return 'Contactos por fuente: ' + (porFuente.map((r) => `${r.fuente || '?'}: ${r.n}`).join(', ') || 'sin datos') +
        '\nAnuncios que más contactos trajeron:\n' + (anuncios.map((a) => `- ${a.anuncio}: ${a.n}`).join('\n') || '- sin datos de anuncios');
    }
  } catch (e) {
    return '';
  }
  return '';
}

const REGLAS_COMUNES =
  'Reglas del equipo:\n' +
  '- Español rioplatense, directo y sin relleno. Usá títulos cortos y viñetas cuando ayuden.\n' +
  '- No inventes datos: si algo no está en la documentación ni en los datos, decilo y sugerí cómo conseguirlo.\n' +
  '- NUNCA ejecutás acciones externas (enviar mensajes, publicar, pagar, firmar, lanzar campañas). ' +
  'Si hace falta una, la proponés al final para que Marcos la apruebe.\n' +
  '- Si proponés acciones, terminá tu respuesta con una sección exacta así:\n' +
  'ACCIONES PROPUESTAS:\n- (acción concreta 1)\n- (acción concreta 2)\n' +
  'Si no hay acciones, no pongas esa sección.';

function promptAgente(id, consulta) {
  const a = AGENTES[id];
  let contexto = '';
  try { contexto = rag.retrieve(consulta, a.rag || 'todos', 4); } catch (e) { contexto = ''; }
  const datos = a.datos ? datosDelSistema(a.datos) : '';
  let s = `Te llamás ${a.nombre} y sos ${a.puesto} en la oficina de MARTOKEN (Organización M-AR & Asociados, General Villegas). ` +
    `Tu jefe es Marcos Reynoso, fundador y fiduciario.\n${a.prompt}\n\n${REGLAS_COMUNES}\n`;
  if (datos) s += `\nDATOS ACTUALES DEL SISTEMA:\n${datos}\n`;
  if (contexto && contexto.trim()) s += `\nDOCUMENTACIÓN DE MARTOKEN (fuente principal):\n"""\n${contexto}\n"""\n`;
  return s;
}

// Separa el texto del agente de su lista de acciones propuestas
function separarAcciones(texto) {
  const m = String(texto || '').split(/\n\s*\**ACCIONES PROPUESTAS:?\**\s*\n/i);
  if (m.length < 2) return { texto: String(texto || '').trim(), acciones: [] };
  const acciones = m[1].split('\n').map((l) => l.replace(/^\s*[-*•\d.)]+\s*/, '').trim()).filter((l) => l.length > 3).slice(0, 6);
  return { texto: m[0].trim(), acciones };
}

/* ============================ CHAT DIRECTO CON UN AGENTE ============================ */
async function chatConAgente({ agente, message, history = [] }) {
  if (!AGENTES[agente]) throw new Error('Ese agente no existe.');
  const hist = history.slice(-6).map((h) => `${h.role === 'user' ? 'Marcos' : AGENTES[agente].nombre}: ${String(h.content || '').slice(0, 1500)}`).join('\n');
  const user = (hist ? `Conversación hasta ahora:\n${hist}\n\n` : '') + `Marcos: ${String(message).slice(0, 4000)}`;
  const out = await complete(promptAgente(agente, message), user, { maxTokens: 1200, temperature: 0.4 });
  const { texto, acciones } = separarAcciones(out);
  // Las acciones que propone en el chat también quedan para aprobar
  const ins = db.prepare('INSERT INTO eq_acciones (created_at, mision_id, agente, descripcion) VALUES (?,?,?,?)');
  for (const ac of acciones) ins.run(now(), null, agente, ac);
  return { reply: texto, acciones };
}

/* ============================ MISIONES ============================ */
async function planificar(pedido) {
  const equipo = ORDEN.filter((id) => id !== 'directora')
    .map((id) => `- ${id}: ${AGENTES[id].nombre}, ${AGENTES[id].puesto}. Hace: ${AGENTES[id].responsabilidades.join('; ')}`)
    .join('\n');
  const sys =
    'Sos la Directora de Operaciones de MARTOKEN. Recibís un pedido de Marcos y lo dividís en tareas para tu equipo.\n' +
    `Equipo disponible:\n${equipo}\n\n` +
    'Respondé SOLO un JSON con esta forma: {"resumen":"qué vas a hacer en 1 frase","tareas":[{"agente":"id","tarea":"instrucción concreta"}]}\n' +
    'Reglas: entre 1 y 4 tareas, solo los agentes necesarios, en orden lógico (los que dependen de otros van después). ' +
    'Usá exactamente los id de la lista.';
  const raw = await complete(sys, pedido, { json: true, maxTokens: 700 });
  let plan;
  try { plan = JSON.parse(raw); } catch (e) { plan = null; }
  let tareas = (plan && Array.isArray(plan.tareas) ? plan.tareas : [])
    .filter((t) => t && AGENTES[t.agente] && t.agente !== 'directora' && t.tarea)
    .slice(0, 4);
  if (!tareas.length) tareas = [{ agente: 'analista', tarea: pedido }];
  return { resumen: (plan && plan.resumen) || 'Organizo el pedido con el equipo.', tareas };
}

async function ejecutarMision(misionId) {
  const m = db.prepare('SELECT * FROM eq_misiones WHERE id = ?').get(misionId);
  if (!m) return;
  const upd = (campos) => {
    const keys = Object.keys(campos);
    db.prepare(`UPDATE eq_misiones SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...campos, id: misionId });
  };
  try {
    const plan = await planificar(m.pedido);
    const insT = db.prepare('INSERT INTO eq_tareas (mision_id, orden, agente, tarea) VALUES (?,?,?,?)');
    plan.tareas.forEach((t, i) => insT.run(misionId, i + 1, t.agente, String(t.tarea).slice(0, 1000)));
    upd({ estado: 'trabajando', resumen_plan: plan.resumen });

    const tareas = db.prepare('SELECT * FROM eq_tareas WHERE mision_id = ? ORDER BY orden').all(misionId);
    const hechos = [];
    const insA = db.prepare('INSERT INTO eq_acciones (created_at, mision_id, agente, descripcion) VALUES (?,?,?,?)');

    for (const t of tareas) {
      db.prepare('UPDATE eq_tareas SET estado = ?, started_at = ? WHERE id = ?').run('trabajando', now(), t.id);
      try {
        const previo = hechos.length
          ? '\n\nLo que ya hicieron tus compañeros en esta misión:\n' + hechos.map((h) => `### ${h.nombre} (${h.puesto})\n${h.texto.slice(0, 1800)}`).join('\n\n')
          : '';
        const user = `Pedido original de Marcos: ${m.pedido}\n\nTu tarea: ${t.tarea}${previo}`;
        const out = await complete(promptAgente(t.agente, `${m.pedido} ${t.tarea}`), user, { maxTokens: 1400, temperature: 0.4 });
        const { texto, acciones } = separarAcciones(out);
        for (const ac of acciones) insA.run(now(), misionId, t.agente, ac);
        db.prepare('UPDATE eq_tareas SET estado = ?, resultado = ?, finished_at = ? WHERE id = ?').run('lista', texto, now(), t.id);
        hechos.push({ nombre: AGENTES[t.agente].nombre, puesto: AGENTES[t.agente].puesto, texto });
      } catch (e) {
        db.prepare('UPDATE eq_tareas SET estado = ?, resultado = ?, finished_at = ? WHERE id = ?').run('error', e.message, now(), t.id);
      }
    }

    // Informe final de la Directora
    let informe = '';
    if (hechos.length > 1) {
      const sys = promptAgente('directora', m.pedido) +
        '\nAhora escribí el INFORME FINAL para Marcos: conclusión en 2-3 líneas, lo más importante de cada área, ' +
        'y próximos pasos numerados. Máximo 300 palabras. No repitas todo: sintetizá. No incluyas sección de acciones propuestas.';
      const user = `Pedido: ${m.pedido}\n\nTrabajo del equipo:\n` + hechos.map((h) => `### ${h.nombre} (${h.puesto})\n${h.texto.slice(0, 2500)}`).join('\n\n');
      informe = separarAcciones(await complete(sys, user, { maxTokens: 900, temperature: 0.3 })).texto;
    } else if (hechos.length === 1) {
      informe = hechos[0].texto;
    } else {
      throw new Error('Ningún agente pudo completar su tarea.');
    }
    upd({ estado: 'terminada', informe, finished_at: now() });
  } catch (e) {
    console.error('[equipo] misión', misionId, e.message);
    upd({ estado: 'error', error: e.message, finished_at: now() });
  }
}

function crearMision(pedido) {
  const texto = String(pedido || '').trim().slice(0, 3000);
  if (!texto) throw new Error('Escribí qué necesitás.');
  const enCurso = db.prepare(`SELECT COUNT(*) n FROM eq_misiones WHERE estado IN ('planificando','trabajando')`).get().n;
  if (enCurso >= 2) throw new Error('Ya hay 2 misiones en curso. Esperá a que termine alguna.');
  const id = db.prepare('INSERT INTO eq_misiones (created_at, pedido) VALUES (?,?)').run(now(), texto).lastInsertRowid;
  // Corre en segundo plano; el panel consulta el estado cada pocos segundos
  setImmediate(() => ejecutarMision(id));
  return id;
}

function obtenerMision(id) {
  const m = db.prepare('SELECT * FROM eq_misiones WHERE id = ?').get(id);
  if (!m) return null;
  m.tareas = db.prepare('SELECT * FROM eq_tareas WHERE mision_id = ? ORDER BY orden').all(id);
  m.acciones = db.prepare('SELECT * FROM eq_acciones WHERE mision_id = ? ORDER BY id').all(id);
  return m;
}

function listarMisiones(limit = 30) {
  return db.prepare('SELECT id, created_at, finished_at, pedido, estado, resumen_plan FROM eq_misiones ORDER BY id DESC LIMIT ?').all(limit);
}

// Lo que está haciendo cada agente ahora (para la oficina) + actividad reciente
function estadoOficina() {
  const ocupados = db.prepare(`SELECT t.agente, t.tarea FROM eq_tareas t JOIN eq_misiones m ON m.id = t.mision_id WHERE t.estado = 'trabajando'`).all();
  const actividad = db.prepare(
    `SELECT t.agente, t.tarea, t.estado, t.finished_at, t.mision_id FROM eq_tareas t
     WHERE t.finished_at IS NOT NULL ORDER BY t.finished_at DESC LIMIT 15`
  ).all();
  const pendientes = db.prepare(`SELECT COUNT(*) n FROM eq_acciones WHERE estado = 'pendiente'`).get().n;
  return { ocupados, actividad, acciones_pendientes: pendientes };
}

function listarAcciones(estado = 'pendiente') {
  return db.prepare('SELECT * FROM eq_acciones WHERE estado = ? ORDER BY id DESC LIMIT 100').all(estado);
}

function decidirAccion(id, aprobar) {
  db.prepare('UPDATE eq_acciones SET estado = ?, decidida_at = ? WHERE id = ?').run(aprobar ? 'aprobada' : 'rechazada', now(), id);
}

// Si el servidor se reinició con misiones a medio hacer, las marcamos como cortadas
function limpiarMisionesColgadas() {
  db.prepare(`UPDATE eq_misiones SET estado = 'error', error = 'El servidor se reinició durante la misión.' WHERE estado IN ('planificando','trabajando')`).run();
  db.prepare(`UPDATE eq_tareas SET estado = 'error' WHERE estado IN ('pendiente','trabajando') AND mision_id IN (SELECT id FROM eq_misiones WHERE estado = 'error')`).run();
}

module.exports = {
  AGENTES, initEquipo, limpiarMisionesColgadas, listarAgentes, chatConAgente,
  crearMision, obtenerMision, listarMisiones, estadoOficina, listarAcciones, decidirAccion
};
