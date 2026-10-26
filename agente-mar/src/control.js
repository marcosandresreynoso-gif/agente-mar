// src/control.js — Control de calidad automático de lo que escriben los agentes.
// No usa IA: revisa el texto con reglas fijas, corrige lo que es seguro corregir solo
// y avisa (⚠️) lo que Marcos tiene que revisar. Se aplica a TODA respuesta antes de mostrarla.

const SITIO = 'martoken.com.ar';

// Correcciones automáticas: [patrón, reemplazo, descripción]
const CORRECCIONES = [
  // Errores de escritura que ya aparecieron en informes
  [/\bfideicomicio(s?)\b/gi, (m, s) => (m[0] === 'F' ? 'Fideicomiso' : 'fideicomiso') + s, 'fideicomicio → fideicomiso'],
  [/\bse escribe una sola vez\b/gi, () => 'se escritura una sola vez', '"se escribe" → "se escritura"'],
  // Dominio mal escrito: martoken.com.au, martoken.com, martoken.ar, martoken.com.ar.ar, martokn.com.ar, etc.
  [/\b(?:www\.)?mar\s?tok[e]?n\.(?:com\.(?!ar\b)[a-z]{2,3}|com(?!\.ar)|ar|net|org|io)\b/gi, () => SITIO, 'página web mal escrita → martoken.com.ar'],
  [/\bmartokn\.com\.ar\b/gi, () => SITIO, 'página web mal escrita → martoken.com.ar'],
  // Link con seguimiento mal armado: martoken.com.ar/#mar50?utm_... -> martoken.com.ar/?utm_...#mar50
  [/(martoken\.com\.ar\/?)#([\w-]+)\?((?:utm_[\w-]+=[^\s&)#]*&?)+)/gi, (m, base, ancla, params) => `${base.replace(/\/?$/, '/')}?${params.replace(/&$/, '')}#${ancla}`, 'link con seguimiento corregido (los parámetros van antes del #)'],
  // Cantidad de viviendas de MAR-50 (acordado: no se publica una cantidad fija)
  [/\b(?:de\s+)?(?:50|cincuenta)\s+(viviendas|casas|unidades|hogares)\b/gi, (m, p1) => (/^de\s/i.test(m) ? 'de ' : '') + p1, 'se sacó "50 viviendas" (no se publica cantidad)'],
  // Jerga técnica en piezas para el público ("verificable con Chainlink VRF" → "verificable", sin repetir)
  [/\b(verificable)\s+(?:con|mediante|usando|a\s+trav[eé]s\s+de)\s+Chainlink\s+VRF\b/gi, (m, p1) => p1, 'se sacó "Chainlink VRF" (jerga técnica)'],
  [/\s*\(?\s*(?:con|mediante|usando|a\s+trav[eé]s\s+de)\s+Chainlink\s+VRF\)?/gi, () => ' público y verificable', 'se cambió "Chainlink VRF" por "público y verificable"'],
  // Nombres de agentes hacia afuera → firma de Marcos
  [/\bsoy\s+(?:Luc[ií]a|Tom[aá]s|Sof[ií]a|Bruno|Martina|Diego|Ramiro|Elena|Victoria)(?=[\s,.]|$)/gi, (m) => (m[0] === 'S' ? 'Soy Marcos' : 'soy Marcos'), 'se cambió el nombre de agente por "Marcos" en la presentación'],
  [/^([\s>]*)[*_]*(?:Luc[ií]a|Tom[aá]s|Sof[ií]a|Bruno|Martina|Diego|Ramiro|Elena|Victoria)[*_]*\s*[–—-]\s*[^\n]*?(Captaci|Prospecci|Atenci|Marketing|Contenido|Legal|Finanzas|Analista|Cumplimiento|Directora|Operaciones)[^\n]*$/gim,
    // Si es el encabezado del informe (primera línea), se borra: un informe interno no lleva la firma de Marcos
    (m, pre, g2, off, str) => (str.slice(0, off).trim() === '' ? '' : `${pre}**Marcos Reynoso – MARTOKEN**`), 'firma de agente corregida (sacada del encabezado o cambiada por la de Marcos)'],
  // Frases que suenan informales o ilegales
  [/\bsin\s+escritura(?:r)?\b/gi, () => 'con gastos de escritura incluidos', 'se cambió "sin escritura" por "gastos de escritura incluidos"'],
];

// Alertas: no se corrigen solas, Marcos las tiene que revisar
const ALERTAS = [
  [/(autorizad[oa]s?|aprobad[oa]s?|regulad[oa]s?|registrad[oa]s?)\s+(por|ante|en)\s+(la\s+)?CNV|cumple\w*\s+(con\s+)?(la\s+)?(normativa\s+de\s+la\s+)?CNV|tokens?\s+como\s+valores\s+negociables/gi, 'Afirma que MARTOKEN está autorizado o cumple con la CNV: hoy NO hace oferta pública ni está en el sandbox. Revisar.', 'negable'],
  [/\bsoy\s+(Luc[ií]a|Tom[aá]s|Sof[ií]a|Bruno|Martina|Diego|Ramiro|Elena|Victoria)\b/gi, 'Se presenta con un nombre de agente. Los mensajes hacia afuera los firma Marcos.'],
  [/rentabilidad\s+garantizada|renta\s+garantizada|ganancia\s+(segura|garantizada)|sin\s+riesgo/gi, 'Promete rentabilidad o ausencia de riesgo.', 'negable'],
  [/\b(EE\.?\s?UU\.?|Estados\s+Unidos|USA)\b/g, '⚖️ Captación o publicidad fuera de Argentina: REQUIERE CONSULTA LEGAL PREVIA (en EE.UU. puede ser oferta de valores regulada por la SEC).'],
  [/\b[\w.+-]+@(?!gmail\.com\b)[\w-]*martoken[\w.-]*\.[a-z]{2,}\b/gi, 'Email no oficial (el contacto es martokenoficial@gmail.com).'],
  [/\b(BlockFi|FTX|Celsius|Voyager\s+Digital)\b/g, 'Nombra una empresa que quebró / ya no opera.'],
  [/cupos?\s+limitados?|[uú]ltimos\s+cupos|cuenta\s+regresiva|\btimer\b/gi, 'Urgencia falsa (cupos limitados, timer): solo si es real.', 'negable'],
  [/(USD|US\$|u\$s|\$)\s?\d{2,}[\d.,]*\s*(USD\s*)?(\/|por|al)\s*d[ií]a/gi, 'Propone un presupuesto diario de publicidad: confirmalo con tu presupuesto real.'],
  [/\b(ITBI|ITP)\b/g, 'Menciona un impuesto que no existe en Argentina (ITBI es de Brasil, ITP de España).'],
  [/\bexent[oa]s?\b|libre\s+de\s+impuestos|sin\s+impuestos|no\s+pag[aá]s\s+(impuesto|ganancias)/gi, 'Afirma una exención de impuestos que no está confirmada.'],
  [/retenci[oó]n\s+del?\s+31\s*%/gi, 'Menciona una retención del 31% que no existe.'],
  [/\b(8[,.]31|7[,.]6)\s*%/g, 'Publica un porcentaje de renta de MAR-50 (no se publica durante la preinscripción).'],
  [/\bLey(?:es)?\s+(27\.551|27\.442)\b/gi, 'Cita una ley que no tiene relación con tokens.'],
  // Cosas que MARTOKEN no tiene: si aparecen, casi seguro son inventadas
  [/\b(Juan|Mar[ií]a|Pedro|Carlos|Ana)\s+P[eé]rez\b|\bKYC\s+Lead\b|responsable\s+de\s+(KYC|TI|sistemas|cumplimiento)\b|equipo\s+de\s+(TI|sistemas|KYC)\b|\b(responsables?|[aá]rea)\s+de\s+TI\b/gi, 'Nombra personas o áreas que MARTOKEN no tiene (el único humano es Marcos): dato INVENTADO.'],
  [/\b(Onfido|Jumio|Sumsub|Veriff)\b|dashboard\s+de\s+KYC|plataforma\s+(de\s+gesti[oó]n\s+)?KYC|correo\s+institucional/gi, 'Nombra herramientas o cuentas que MARTOKEN no tiene: dato INVENTADO.'],
  [/\b\d+\s+(?:de\s+(?:los|las)\s+\d+\s+)?(preinscript\w*|inscript\w*|interesad\w*|inversor\w*|en\s+proceso\s+de\s+KYC)/gi, 'Da una cantidad de personas: confirmá que salga de tus datos reales (la oficina NO ve las preinscripciones ni las compras).'],
  [/https?:\/\/(?!(?:www\.)?martoken\.com\.ar)[^\s)]+/gi, null],   // links externos: se listan para revisar (no es error)
];

function controlar(texto) {
  if (!texto) return { texto: texto || '', correcciones: [], alertas: [], linksExternos: [] };
  let t = String(texto);
  const correcciones = [];
  for (const [re, fn, desc] of CORRECCIONES) {
    let n = 0;
    t = t.replace(re, (...args) => { n++; return fn(...args); });
    if (n) correcciones.push(`${desc} (${n} vez/veces)`);
  }
  const alertas = []; let linksExternos = [];
  for (const [re, desc, modo] of ALERTAS) {
    let ms = t.match(re);
    if (ms && modo === 'negable') {
      // Ignora "sin promesas de rentabilidad garantizada", "no prometer…", "evitar cupos limitados", etc.
      const negado = /\b(sin|no|ni|nunca|jam[aá]s|evit\w*|prohib\w*|nada\s+de)\b[^.\n]{0,40}$/i;
      const reG = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      ms = []; let x;
      while ((x = reG.exec(t))) { if (!negado.test(t.slice(Math.max(0, x.index - 60), x.index))) ms.push(x[0]); }
      if (!ms.length) ms = null;
    }
    if (!ms) continue;
    if (desc === null) { linksExternos = [...new Set(ms)].slice(0, 10); continue; }
    alertas.push(`${desc} → "${[...new Set(ms)].slice(0, 3).join('", "')}"`);
  }
  return { texto: t, correcciones, alertas, linksExternos };
}

// Devuelve el texto corregido con un bloque "Control de calidad" al final (si hubo algo)
function controlarYAnotar(texto) {
  const r = controlar(texto);
  if (!r.correcciones.length && !r.alertas.length) return r.texto;
  let nota = '\n\n---\n**🛡️ Control de calidad**';
  if (r.correcciones.length) nota += '\n' + r.correcciones.map((c) => `- ✅ Corregido: ${c}`).join('\n');
  if (r.alertas.length) nota += '\n' + r.alertas.map((a) => `- ⚠️ Revisar: ${a}`).join('\n');
  return r.texto + nota;
}

module.exports = { controlar, controlarYAnotar };
