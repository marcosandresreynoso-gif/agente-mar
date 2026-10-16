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

const { db, getConfig, setConfig } = require('./db');
const { complete, cantidadKeys, buscarWeb, recortar } = require('./groq');
const rag = require('./rag');
const { controlarYAnotar } = require('./control');
const { initAdjuntos, obtenerAdjuntos, bloqueAdjuntos } = require('./adjuntos');

const now = () => new Date().toISOString();

// Foco del equipo: lo leen TODOS los agentes en cada tarea. Se edita desde la Oficina.
const FOCO_INICIAL =
  'OBJETIVO PRINCIPAL: conseguir la mayor cantidad de PREINSCRIPTOS para MAR-50 en https://www.martoken.com.ar/#mar50\n' +
  '- MAR-50 está en preinscripción (lista de interés): todavía NO se venden tokens. Anotarse es gratis y no obliga a nada.\n' +
  '- Mensaje central: vivienda accesible con renta para el inversor. No es vivienda social ni un plan del Estado.\n' +
  '- Los primeros anotados tienen prioridad en el sorteo: usarlo como motivo para anotarse YA.\n' +
  '- Sorteo público y verificable con Chainlink VRF, transmitido en vivo. Respaldo en fideicomiso inmobiliario. Token de USD 100, se entra desde 1.\n' +
  '- "Demanda primero. Terreno después.": se construye donde haya más preinscriptos, por etapas. Pedir a cada persona que elija su localidad.\n' +
  '- En difusión NO decir cantidad fija de viviendas, NO decir "en General Villegas", NO dar cantidad total de tokens, monto de la emisión ni porcentaje de renta.\n' +
  '- No prometer rentabilidad ni que la persona gane el sorteo.\n' +
  'OBJETIVO SECUNDARIO: a quien quiera invertir hoy, derivarlo a MAR-01 (https://www.martoken.com.ar/mar01/).';

function getFoco() {
  const c = getConfig();
  return (c.eq_foco && c.eq_foco.trim()) ? c.eq_foco : FOCO_INICIAL;
}
function setFoco(texto) {
  const t = String(texto ?? '').trim().slice(0, 4000);
  setConfig({ eq_foco: t || FOCO_INICIAL });
  return getFoco();
}

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
    autonomia: 'Escribile tu pedido por chat: arma la misión, la reparte al equipo y te deja el informe ahí mismo. No ejecuta acciones externas.',
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
    responsabilidades: ['Convertir interesados en preinscriptos de MAR-50', 'Calificar interés (frío / tibio / caliente)', 'Redactar respuestas y seguimientos por WhatsApp', 'Derivar a MAR-01 a quien quiere invertir ya'],
    herramientas: ['Contactos de WhatsApp', 'Leads', 'Documentación MARTOKEN'],
    autonomia: 'Redacta mensajes. Enviar requiere tu aprobación.',
    rag: 'comercial',
    datos: 'whatsapp',
    prompt:
      'Sos la responsable de Captación de MARTOKEN. Tu meta principal es sumar PREINSCRIPTOS a MAR-50 ' +
      '(https://www.martoken.com.ar/#mar50); a quien quiere invertir ya lo derivás a MAR-01. ' +
      'Escribís mensajes de WhatsApp cortos (4-5 líneas), cálidos y concretos, siempre con el link de preinscripción. ' +
      'Nunca prometés rentabilidad garantizada ni pedís claves o datos bancarios.'
  },
  prospeccion: {
    nombre: 'Tomás',
    puesto: 'Prospección de Empresas',
    area: 'Comercial',
    color: '#5b8cff',
    inicial: 'T',
    lema: 'Primero la lista correcta, después el mensaje.',
    responsabilidades: ['Encontrar canales que traigan preinscriptos a MAR-50', 'Municipios, gremios, cooperativas, inmobiliarias y empresas con empleados', 'Redactar el primer contacto', 'Proponer campañas de plantillas'],
    herramientas: ['Leads del buscador', 'Contactos de WhatsApp'],
    autonomia: 'Propone listas y textos. Lanzar campañas requiere tu aprobación.',
    rag: 'comercial',
    datos: 'leads',
    prompt:
      'Sos el responsable de Prospección de MARTOKEN. Buscás organizaciones que puedan multiplicar las preinscripciones de MAR-50: ' +
      'municipios y concejos deliberantes, gremios y mutuales, cooperativas, inmobiliarias, corralones y empresas con muchos empleados ' +
      '(la preinscripción como beneficio para su gente). También empresas y profesionales que puedan invertir. Proponés a quién, en qué ciudades y con qué mensaje.'
  },
  atencion: {
    nombre: 'Sofía',
    puesto: 'Atención al Inversor',
    area: 'Inversores',
    color: '#46c98b',
    inicial: 'S',
    lema: 'La confianza se construye respuesta por respuesta.',
    responsabilidades: ['Responder dudas de preinscriptos de MAR-50', 'Responder a tenedores de MAR-01', 'Explicar el sorteo y cómo funciona el token', 'Armar preguntas frecuentes'],
    herramientas: ['Documentación MARTOKEN', 'Base de conocimiento MAR-01 y MAR-50'],
    autonomia: 'Redacta respuestas. Enviar a inversores requiere tu aprobación.',
    rag: 'todos',
    prompt:
      'Sos la responsable de Atención al Inversor de MARTOKEN. Respondés con paciencia y precisión a los preinscriptos de MAR-50 ' +
      '(qué es la preinscripción, el sorteo verificable, por qué los primeros anotados tienen prioridad, qué pasa cuando abre la emisión) ' +
      'y a quienes invirtieron en MAR-01 (token, fideicomiso, retorno por alquiler o venta, wallet). ' +
      'Nunca pedís frases semilla ni claves.'
  },
  marketing: {
    nombre: 'Bruno',
    puesto: 'Marketing y Contenido',
    area: 'Marketing',
    color: '#e0618a',
    inicial: 'B',
    lema: 'Cada publicación cuenta una historia.',
    responsabilidades: ['Anuncios y publicaciones para sumar preinscriptos a MAR-50', 'Calendario editorial para Facebook e Instagram', 'Analizar qué anuncios traen más contactos', 'Mensajes clave y ganchos'],
    herramientas: ['Documentación MARTOKEN', 'Resumen de leads por fuente'],
    autonomia: 'Redacta contenido. Publicar requiere tu aprobación.',
    rag: 'comercial',
    datos: 'fuentes',
    prompt:
      'Sos el responsable de Marketing y Contenido de MARTOKEN. Tu prioridad es llenar la preinscripción de MAR-50: escribís ' +
      'publicaciones y anuncios para Facebook e Instagram en español rioplatense, con gancho, claridad y una sola llamada a la acción ' +
      '(preinscribirse en https://www.martoken.com.ar/#mar50). Respetás que no se puede prometer rentabilidad garantizada. ' +
      'Identidad MARTOKEN: colores marino #0B1D3B, dorado #B8923F y crema #F4F1E9; tipografías Fraunces (títulos) e Inter (textos). ' +
      'Eslogan: "Con MARTOKEN primero la demanda. Después la inversión." Tono humilde, sin parecer una gran empresa. Los anuncios siempre llevan a martoken.com.ar.'
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
    responsabilidades: ['Leer la demanda de MAR-50 por localidad', 'Proponer dónde y en qué etapas construir', 'Evaluar proyectos nuevos para tokenizar', 'Detectar riesgos del negocio'],
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
    CREATE TABLE IF NOT EXISTS eq_chat (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dia TEXT NOT NULL,                    -- YYYY-MM-DD, hora de Argentina
      agente TEXT NOT NULL,
      role TEXT NOT NULL,                   -- user | assistant
      content TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_eq_chat_dia ON eq_chat(dia, agente, id);
  `);
  try { db.exec('ALTER TABLE eq_misiones ADD COLUMN investigacion TEXT'); } catch (e) { /* ya existe */ }
  try { db.exec('ALTER TABLE eq_misiones ADD COLUMN adjuntos TEXT'); } catch (e) { /* ya existe */ }
  initAdjuntos();
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
  '- MENSAJES HACIA AFUERA (WhatsApp, mails, posts, cartas a municipios o empresas): se firman SIEMPRE como "Marcos Reynoso – MARTOKEN" y se escriben en primera persona de Marcos. NUNCA te presentes ni firmes con tu nombre de agente: los agentes son internos y nadie de afuera los conoce.\n' +
  '- Página web: SIEMPRE https://www.martoken.com.ar (con .com.ar). MAR-50: https://www.martoken.com.ar/#mar50 · MAR-01: https://www.martoken.com.ar/mar01/\n' +
  '- MAR-50: NUNCA pongas la cantidad de viviendas (nada de "50 viviendas"), ni monto de la emisión, ni porcentaje de renta, ni "en General Villegas".\n' +
  '- ORGANIZACIONES Y EMPRESAS: nombrá solo las que estén en la documentación o en la investigación web con su URL. Si sugerís otras, escribí el tipo ("cooperativas eléctricas de la zona") y no inventes nombres propios. Si nombrás una sin fuente, marcala "(a verificar)".\n' +
  '- Zona: salvo que Marcos pida otra cosa, priorizá General Villegas y el oeste bonaerense (la región de MARTOKEN) antes que ciudades lejanas.\n' +
  '- DATOS: NUNCA afirmes resultados, métricas o situaciones (CPL, clics, leads, preinscriptos, ventas, "la campaña está funcionando") que Marcos no informó y que no están en DATOS ACTUALES DEL SISTEMA ni en ARCHIVOS ADJUNTOS DE MARCOS. Los adjuntos son datos reales: usalos y citá sus números tal cual, sin redondear ni completar lo que no figura. Si no hay datos, escribí "sin datos todavía" y pedí cuáles necesitás.\n' +
  '- PRESUPUESTO: no propongas montos de publicidad ni gastos concretos si Marcos no dio su presupuesto. Pedíselo, o proponé cómo repartir el que tenga.\n' +
  '- FUERA DE ARGENTINA: toda publicidad, captación u oferta de tokens a personas de otros países (EE.UU., España, etc.) se marca "⚖️ REQUIERE CONSULTA LEGAL PREVIA". En EE.UU., ofrecer tokens de inversión al público puede ser oferta de valores regulada por la SEC. No lo propongas como algo para hacer ya.\n' +
  '- No propongas pedir difusión a empresas competidoras (plataformas de inversión inmobiliaria o cripto) ni a gobiernos extranjeros. No nombres empresas sin verificar que existan y sigan activas.\n' +
  '- CONTACTO OFICIAL: martokenoficial@gmail.com y el WhatsApp de MARTOKEN. No inventes otros emails.\n' +
  '- LINKS CON SEGUIMIENTO (UTM): los parámetros van ANTES del #. Ejemplo correcto: https://www.martoken.com.ar/?utm_source=facebook&utm_campaign=mar50#mar50\n' +
  '- Sin urgencia falsa: nada de contadores, "últimos cupos" ni "cupos limitados" si no es real.\n' +
  '- Idioma: las piezas van en español rioplatense. Si el público no habla español, avisá que hace falta traducción en vez de mandar el texto en español.\n' +
  '- NO uses tablas: Marcos lee desde el celular. Presentá todo en listas o párrafos cortos, uno debajo del otro.\n' +
  '- Trabajás en ARGENTINA. El organismo fiscal es ARCA (ex AFIP). No uses impuestos ni normas de otros países (por ejemplo "ITP" es de España).\n' +
  '- Si recibís una "INVESTIGACIÓN WEB", usala para datos actuales y citá la fuente (URL) de cada dato que tomes de ahí. Si un dato no está ni en la documentación ni en la investigación, decí que no lo encontraste: no lo inventes.\n' +
  '- NUNCA cites números de ley, artículos, resoluciones ni alícuotas que no estén en la documentación. Si no estás seguro, escribí "(a verificar con contador/abogado)". Inventar una norma es el peor error posible.\n' +
  '- Si revisás el trabajo de un compañero, revisá TODO lo que hizo. Si algo no lo recibiste completo, decilo; no lo supongas.\n' +
  '- La GUÍA IMPOSITIVA VERIFICADA manda sobre la investigación web. Si la web menciona otras ventajas impositivas, exenciones o leyes que no están en la guía, NO las presentes como ventajas: listalas aparte como "A verificar con contador". Lo que la guía marca A CONFIRMAR tampoco se presenta como hecho.\n' +
  '- IMPUESTOS: cuando el tema sea impositivo, usá SOLO la "GUÍA IMPOSITIVA VERIFICADA". Explicá con claridad las ventajas que ahí figuran; no agregues otras ni afirmes lo que la guía marca como falso o A CONFIRMAR. Cerrá con: "Información general. Consultá tu caso con tu contador."\n' +
  '- No inventes datos: si algo no está en la documentación ni en los datos, decilo y sugerí cómo conseguirlo.\n' +
  '- NUNCA ejecutás acciones externas (enviar mensajes, publicar, pagar, firmar, lanzar campañas). ' +
  'Si hace falta una, la proponés al final para que Marcos la apruebe.\n' +
  '- Si proponés acciones, terminá tu respuesta con una sección exacta así:\n' +
  'ACCIONES PROPUESTAS:\n- (acción concreta 1)\n- (acción concreta 2)\n' +
  'Si no hay acciones, no pongas esa sección.';

// Guía impositiva verificada (conocimiento/impuestos.md): se agrega completa cuando el tema es impositivo
let GUIA_IMPUESTOS = null;
function guiaImpuestos() {
  if (GUIA_IMPUESTOS === null) {
    try { GUIA_IMPUESTOS = require('fs').readFileSync(require('path').join(__dirname, '..', 'conocimiento', 'impuestos.md'), 'utf8'); }
    catch (e) { GUIA_IMPUESTOS = ''; }
  }
  return GUIA_IMPUESTOS;
}
// Temas que necesitan datos actuales: el equipo busca en internet antes de trabajar
const NECESITA_BUSQUEDA = /impuest|imposit|fiscal|tribut|arca|afip|ganancia|bienes personales|sellos|ley|norma|decreto|resoluci|cnv|regula|legal|mercado|competen|precio|tasa|d[oó]lar|inflaci|alquiler|tendencia|estad[ií]stica|actual|hoy|202[5-9]|noticia|buscá|busca|investig/i;
const ES_IMPOSITIVO = /impuest|imposit|fiscal|tribut|arca|afip|ganancia|bienes personales|sellos|escritur|inocencia|exenci|declara/i;

function promptAgente(id, consulta, investigacion = '') {
  const a = AGENTES[id];
  const foco = getFoco();
  let contexto = '';
  // La búsqueda en la documentación incluye el foco, así trae lo de MAR-50 (u otro proyecto) aunque el pedido no lo nombre
  try { contexto = rag.retrieve(`${consulta} ${foco.slice(0, 300)}`, a.rag || 'todos', 3); } catch (e) { contexto = ''; }
  const datos = a.datos ? datosDelSistema(a.datos) : '';
  let s = `Te llamás ${a.nombre} y sos ${a.puesto} en la oficina de MARTOKEN (Organización M-AR & Asociados, General Villegas). ` +
    `Tu jefe es Marcos Reynoso, fundador y fiduciario.\n${a.prompt}\n\n` +
    `FOCO ACTUAL DEL EQUIPO (tiene prioridad; todo tu trabajo apunta a esto salvo que Marcos pida otra cosa):\n${foco}\n\n${REGLAS_COMUNES}\n`;
  if (datos) s += `\nDATOS ACTUALES DEL SISTEMA:\n${datos}\n`;
  if (investigacion) s += `\nINVESTIGACIÓN WEB (hecha hoy, con fuentes):\n"""\n${investigacion.slice(0, 6000)}\n"""\n`;
  if (ES_IMPOSITIVO.test(consulta) && guiaImpuestos()) s += `\nGUÍA IMPOSITIVA VERIFICADA (única fuente válida para impuestos):\n"""\n${guiaImpuestos()}\n"""\n`;
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

/* ============================ HISTORIAL DE CHATS POR DÍA ============================ */
const hoyAR = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
const DIA_OK = /^\d{4}-\d{2}-\d{2}$/;

function guardarChat(agente, role, content, dia = hoyAR()) {
  if (!AGENTES[agente] || !content) return;
  db.prepare('INSERT INTO eq_chat (dia, agente, role, content, created_at) VALUES (?,?,?,?,?)')
    .run(dia, agente, role === 'user' ? 'user' : 'assistant', String(content).slice(0, 20000), now());
}
function diasDeChat() {
  return db.prepare('SELECT dia, agente, COUNT(*) n FROM eq_chat GROUP BY dia, agente ORDER BY dia DESC').all();
}
function chatsDelDia(dia) {
  if (!DIA_OK.test(dia || '')) dia = hoyAR();
  const out = {};
  for (const r of db.prepare('SELECT agente, role, content FROM eq_chat WHERE dia = ? ORDER BY id').all(dia)) {
    (out[r.agente] = out[r.agente] || []).push({ role: r.role, content: r.content });
  }
  return { dia, chats: out };
}
// Si el servidor se borró (deploy en el plan gratis), el celular vuelve a subir su copia
function restaurarChat(dia, agente, mensajes) {
  if (!DIA_OK.test(dia || '') || !AGENTES[agente] || !Array.isArray(mensajes)) return 0;
  const ya = db.prepare('SELECT COUNT(*) n FROM eq_chat WHERE dia = ? AND agente = ?').get(dia, agente).n;
  if (ya > 0) return 0;
  const lista = mensajes.slice(0, 500).filter((m) => m && m.content);
  db.transaction(() => { for (const m of lista) guardarChat(agente, m.role, m.content, dia); })();
  return lista.length;
}

/* ============================ CHAT DIRECTO CON UN AGENTE ============================ */
async function chatConAgente({ agente, message, history = [], adjuntos = [] }) {
  if (!AGENTES[agente]) throw new Error('Ese agente no existe.');
  const adj = obtenerAdjuntos(adjuntos);
  const marcaAdj = adj.length ? `\n\n📎 Adjuntos: ${adj.map((a) => a.nombre).join(', ')}` : '';
  // Victoria (Directora): si le pedís un trabajo, arma una misión y la reparte al equipo.
  // Saludos o mensajes muy cortos los contesta ella sola.
  if (agente === 'directora' && (String(message).trim().length >= 20 || adj.length)) {
    const previos = history.filter((h) => h.role === 'user').slice(-2).map((h) => String(h.content || '').slice(0, 800));
    const pedido = (previos.length ? `Contexto de lo que Marcos venía hablando: ${previos.join(' / ')}\n\n` : '') + String(message).slice(0, 2500);
    const id = crearMision(pedido, adj.map((a) => a.id));
    const respuesta = 'Recibido. Armo la misión y la reparto al equipo. Te voy contando acá quién trabaja en qué y, cuando terminen, te dejo el informe en este chat.';
    guardarChat(agente, 'user', message + marcaAdj); guardarChat(agente, 'assistant', respuesta);
    return {
      reply: respuesta,
      acciones: [],
      mision_id: id
    };
  }
  const hist = history.slice(-6).map((h) => `${h.role === 'user' ? 'Marcos' : AGENTES[agente].nombre}: ${String(h.content || '').slice(0, 1500)}`).join('\n');
  const user = (hist ? `Conversación hasta ahora:\n${hist}\n\n` : '') + `Marcos: ${String(message).slice(0, 4000)}` + bloqueAdjuntos(adj, 7000, recortar);
  const investigacion = NECESITA_BUSQUEDA.test(message) ? await buscarWeb(`${message}\n(Contexto: MARTOKEN, tokenización inmobiliaria en Argentina, fideicomiso, tokens en Polygon.)`) : '';
  const out = await complete(promptAgente(agente, message, investigacion), user, { maxTokens: 1000, temperature: 0.4, maxEsperaMs: 45000 });
  const sep = separarAcciones(out);
  const texto = controlarYAnotar(sep.texto), acciones = sep.acciones;
  // Las acciones que propone en el chat también quedan para aprobar
  const ins = db.prepare('INSERT INTO eq_acciones (created_at, mision_id, agente, descripcion) VALUES (?,?,?,?)');
  for (const ac of acciones) ins.run(now(), null, agente, ac);
  guardarChat(agente, 'user', message + marcaAdj); guardarChat(agente, 'assistant', texto);
  return { reply: texto, acciones };
}

/* ============================ MISIONES ============================ */
async function planificar(pedido, adjTexto = '') {
  const equipo = ORDEN.filter((id) => id !== 'directora')
    .map((id) => `- ${id}: ${AGENTES[id].nombre}, ${AGENTES[id].puesto}. Hace: ${AGENTES[id].responsabilidades.join('; ')}`)
    .join('\n');
  const sys =
    'Sos la Directora de Operaciones de MARTOKEN. Recibís un pedido de Marcos y lo dividís en tareas para tu equipo.\n' +
    `Foco actual del equipo:\n${getFoco()}\n\n` +
    `Equipo disponible:\n${equipo}\n\n` +
    'Respondé SOLO un JSON con esta forma: {"resumen":"qué vas a hacer en 1 frase","tareas":[{"agente":"id","tarea":"instrucción concreta"}]}\n' +
    'Reglas: entre 1 y 4 tareas, solo los agentes necesarios, en orden lógico (los que dependen de otros van después). ' +
    'Usá exactamente los id de la lista.';
  const raw = await complete(sys, pedido + adjTexto, { json: true, maxTokens: 500, maxEsperaMs: 90000 });
  let plan;
  try { plan = JSON.parse(raw); } catch (e) { plan = null; }
  let tareas = (plan && Array.isArray(plan.tareas) ? plan.tareas : [])
    .filter((t) => t && AGENTES[t.agente] && t.agente !== 'directora' && t.tarea)
    .slice(0, 4);
  if (!tareas.length) tareas = [{ agente: 'analista', tarea: pedido }];
  // Todo lo que va a publicidad, captación o inversores pasa SIEMPRE por Cumplimiento, al final
  if (/publicidad|anuncio|campa[ñn]a|publicar|post|carrusel|video|inversor|captaci|difusi[oó]n|marketing|exterior|EE\.?\s?UU|Estados Unidos/i.test(pedido)) {
    tareas = tareas.filter((t) => t.agente !== 'cumplimiento');
    tareas.push({ agente: 'cumplimiento', tarea: 'Revisá TODO lo que hicieron tus compañeros: promesas de rentabilidad, datos inventados, normas (CNV/ARCA), captación fuera de Argentina, urgencia falsa, links y firmas. Indicá qué corregir antes de publicar.' });
  }
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
    let adj = [];
    try { adj = obtenerAdjuntos(JSON.parse(m.adjuntos || '[]')); } catch (e) { adj = []; }
    const plan = await planificar(m.pedido, bloqueAdjuntos(adj, 2500, recortar));
    const insT = db.prepare('INSERT INTO eq_tareas (mision_id, orden, agente, tarea) VALUES (?,?,?,?)');
    plan.tareas.forEach((t, i) => insT.run(misionId, i + 1, t.agente, String(t.tarea).slice(0, 1000)));
    let investigacion = '';
    if (NECESITA_BUSQUEDA.test(m.pedido)) {
      upd({ estado: 'trabajando', resumen_plan: plan.resumen + ' (investigando en internet…)' });
      investigacion = await buscarWeb(`${m.pedido}\n(Contexto: MARTOKEN, tokenización inmobiliaria en Argentina, fideicomiso, tokens en Polygon. Buscá los datos actuales que el equipo necesita.)`, { maxEsperaMs: 90000 });
    }
    upd({ estado: 'trabajando', resumen_plan: plan.resumen, investigacion: investigacion || null });

    const tareas = db.prepare('SELECT * FROM eq_tareas WHERE mision_id = ? ORDER BY orden').all(misionId);
    const hechos = [];
    const insA = db.prepare('INSERT INTO eq_acciones (created_at, mision_id, agente, descripcion) VALUES (?,?,?,?)');

    // Lo que hicieron los compañeros: se reparte un máximo de 9.000 caracteres entre todos (para no pasar el límite de Groq)
    const contextoPrevio = (lista, total) => {
      if (!lista.length) return '';
      const porUno = Math.floor(total / lista.length);
      return '\n\nLo que ya hicieron tus compañeros en esta misión:\n' +
        lista.map((h) => `### ${h.nombre} (${h.puesto})\n${recortar(h.texto, porUno)}`).join('\n\n');
    };
    const fallidas = [];

    for (const t of tareas) {
      db.prepare('UPDATE eq_tareas SET estado = ?, started_at = ? WHERE id = ?').run('trabajando', now(), t.id);
      let hecho = false, ultimoError = '';
      // Hasta 2 intentos: el segundo con menos contexto y después de una pausa
      for (const intento of [1, 2]) {
        try {
          const user = `Pedido original de Marcos: ${m.pedido}${bloqueAdjuntos(adj, intento === 1 ? 6000 : 3000, recortar)}\n\nTu tarea: ${t.tarea}${contextoPrevio(hechos, intento === 1 ? (adj.length ? 6000 : 9000) : 3500)}`;
          const inv = intento === 1 ? investigacion : recortar(investigacion, 2000);
          const out = await complete(promptAgente(t.agente, `${m.pedido} ${t.tarea}`, inv), user, { maxTokens: 1100, temperature: 0.4, maxEsperaMs: 90000 });
          if (!out || !out.trim()) throw new Error('respuesta vacía');
          const sep = separarAcciones(out);
          const texto = controlarYAnotar(sep.texto), acciones = sep.acciones;
          for (const ac of acciones) insA.run(now(), misionId, t.agente, ac);
          db.prepare('UPDATE eq_tareas SET estado = ?, resultado = ?, finished_at = ? WHERE id = ?').run('lista', texto, now(), t.id);
          hechos.push({ nombre: AGENTES[t.agente].nombre, puesto: AGENTES[t.agente].puesto, texto });
          hecho = true;
          break;
        } catch (e) {
          ultimoError = e.message;
          console.error(`[equipo] ${t.agente} intento ${intento}:`, e.message.slice(0, 200));
          if (intento === 1) await new Promise((r) => setTimeout(r, 15000));
        }
      }
      if (!hecho) {
        const aviso = `⚠️ ${AGENTES[t.agente].nombre} (${AGENTES[t.agente].puesto}) no pudo completar su tarea después de 2 intentos. ` +
          'Volvé a pedírsela por su chat en unos minutos.\n\nDetalle técnico: ' + ultimoError.slice(0, 300);
        db.prepare('UPDATE eq_tareas SET estado = ?, resultado = ?, finished_at = ? WHERE id = ?').run('error', aviso, now(), t.id);
        fallidas.push(`${AGENTES[t.agente].nombre} (${AGENTES[t.agente].puesto})`);
      }
    }

    // Informe final de la Directora
    let informe = '';
    const avisoFallas = fallidas.length
      ? `\n\n⚠️ **No terminaron su parte:** ${fallidas.join(', ')}. Su revisión NO está incluida en este informe: pediles la tarea de nuevo antes de usar este material.`
      : '';
    if (hechos.length > 1) {
      const sys = promptAgente('directora', m.pedido, recortar(investigacion, 2500)) +
        '\nAhora escribí el INFORME FINAL para Marcos: conclusión en 2-3 líneas, lo más importante de cada área, ' +
        'y próximos pasos numerados. Máximo 300 palabras. No repitas todo: sintetizá. No incluyas sección de acciones propuestas.\n' +
        'PROHIBIDO inventar resultados, métricas o situaciones (CPL, leads, inscriptos, ventas, "la campaña está generando…"): ' +
        'usá SOLO lo que dijo Marcos en su pedido y lo que hizo el equipo. Si faltan datos, decilo y pedilos.' +
        (fallidas.length ? `\nIMPORTANTE: ${fallidas.join(', ')} no pudo/pudieron completar su tarea. Decilo claramente en el informe.` : '');
      const user = `Pedido: ${m.pedido}${bloqueAdjuntos(adj, 2500, recortar)}\n\nTrabajo del equipo:\n` + hechos.map((h) => `### ${h.nombre} (${h.puesto})\n${recortar(h.texto, Math.floor(9000 / hechos.length))}`).join('\n\n');
      try {
        informe = controlarYAnotar(separarAcciones(await complete(sys, user, { maxTokens: 800, temperature: 0.3, maxEsperaMs: 90000 })).texto) + avisoFallas;
      } catch (e) {
        informe = '⚠️ Victoria no pudo escribir el informe final (' + e.message.slice(0, 150) + '). Abajo tenés el trabajo de cada agente completo.' + avisoFallas;
      }
    } else if (hechos.length === 1) {
      informe = hechos[0].texto + avisoFallas;
    } else {
      throw new Error('Ningún agente pudo completar su tarea. Probá de nuevo en unos minutos.');
    }
    upd({ estado: 'terminada', informe, finished_at: now() });
  } catch (e) {
    console.error('[equipo] misión', misionId, e.message);
    upd({ estado: 'error', error: e.message, finished_at: now() });
  }
}

function crearMision(pedido, adjuntos = []) {
  const adj = obtenerAdjuntos(adjuntos);
  let texto = String(pedido || '').trim().slice(0, 3000);
  if (!texto && adj.length) texto = 'Analizá los archivos adjuntos y decime qué conclusiones y próximos pasos sacás para MAR-50.';
  if (adj.length) texto += `\n\n📎 Adjuntos: ${adj.map((a) => a.nombre).join(', ')}`;
  if (!texto) throw new Error('Escribí qué necesitás.');
  const enCurso = db.prepare(`SELECT COUNT(*) n FROM eq_misiones WHERE estado IN ('planificando','trabajando')`).get().n;
  if (enCurso >= 2) throw new Error('Ya hay 2 misiones en curso. Esperá a que termine alguna.');
  const id = db.prepare('INSERT INTO eq_misiones (created_at, pedido, adjuntos) VALUES (?,?,?)').run(now(), texto, JSON.stringify(adj.map((a) => a.id))).lastInsertRowid;
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
  return { ocupados, actividad, acciones_pendientes: pendientes, groq_keys: cantidadKeys() };
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
  hoyAR, guardarChat, diasDeChat, chatsDelDia, restaurarChat,
  getFoco, setFoco,
  AGENTES, initEquipo, limpiarMisionesColgadas, listarAgentes, chatConAgente,
  crearMision, obtenerMision, listarMisiones, estadoOficina, listarAcciones, decidirAccion
};
