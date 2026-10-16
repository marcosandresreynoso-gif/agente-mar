// src/control.js — Control de calidad automático de lo que escriben los agentes.
// No usa IA: revisa el texto con reglas fijas, corrige lo que es seguro corregir solo
// y avisa (⚠️) lo que Marcos tiene que revisar. Se aplica a TODA respuesta antes de mostrarla.

const SITIO = 'martoken.com.ar';

// Correcciones automáticas: [patrón, reemplazo, descripción]
const CORRECCIONES = [
  // Dominio mal escrito: martoken.com.au, martoken.com, martoken.ar, martoken.com.ar.ar, martokn.com.ar, etc.
  [/\b(?:www\.)?mar\s?tok[e]?n\.(?:com\.(?!ar\b)[a-z]{2,3}|com(?!\.ar)|ar|net|org|io)\b/gi, () => SITIO, 'página web mal escrita → martoken.com.ar'],
  [/\bmartokn\.com\.ar\b/gi, () => SITIO, 'página web mal escrita → martoken.com.ar'],
  // Cantidad de viviendas de MAR-50 (acordado: no se publica una cantidad fija)
  [/\b(?:de\s+)?(?:50|cincuenta)\s+(viviendas|casas|unidades|hogares)\b/gi, (m, p1) => (/^de\s/i.test(m) ? 'de ' : '') + p1, 'se sacó "50 viviendas" (no se publica cantidad)'],
  // Jerga técnica en piezas para el público ("verificable con Chainlink VRF" → "verificable", sin repetir)
  [/\b(verificable)\s+(?:con|mediante|usando|a\s+trav[eé]s\s+de)\s+Chainlink\s+VRF\b/gi, (m, p1) => p1, 'se sacó "Chainlink VRF" (jerga técnica)'],
  [/\s*\(?\s*(?:con|mediante|usando|a\s+trav[eé]s\s+de)\s+Chainlink\s+VRF\)?/gi, () => ' público y verificable', 'se cambió "Chainlink VRF" por "público y verificable"'],
  // Nombres de agentes hacia afuera → firma de Marcos
  [/\bsoy\s+(?:Luc[ií]a|Tom[aá]s|Sof[ií]a|Bruno|Martina|Diego|Ramiro|Elena|Victoria)(?=[\s,.]|$)/gi, (m) => (m[0] === 'S' ? 'Soy Marcos' : 'soy Marcos'), 'se cambió el nombre de agente por "Marcos" en la presentación'],
  [/^([\s>]*)[*_]*(?:Luc[ií]a|Tom[aá]s|Sof[ií]a|Bruno|Martina|Diego|Ramiro|Elena|Victoria)[*_]*\s*[–—-]\s*[^\n]*?(Captaci|Prospecci|Atenci|Marketing|Contenido|Legal|Finanzas|Analista|Cumplimiento|Directora|Operaciones)[^\n]*$/gim,
    (m, pre) => `${pre}**Marcos Reynoso – MARTOKEN**`, 'se reemplazó la firma de agente por "Marcos Reynoso – MARTOKEN"'],
  // Frases que suenan informales o ilegales
  [/\bsin\s+escritura(?:r)?\b/gi, () => 'con gastos de escritura incluidos', 'se cambió "sin escritura" por "gastos de escritura incluidos"'],
];

// Alertas: no se corrigen solas, Marcos las tiene que revisar
const ALERTAS = [
  [/\bsoy\s+(Luc[ií]a|Tom[aá]s|Sof[ií]a|Bruno|Martina|Diego|Ramiro|Elena|Victoria)\b/gi, 'Se presenta con un nombre de agente. Los mensajes hacia afuera los firma Marcos.'],
  [/rentabilidad\s+garantizada|renta\s+garantizada|ganancia\s+(segura|garantizada)|sin\s+riesgo/gi, 'Promete rentabilidad o ausencia de riesgo.'],
  [/\b(ITBI|ITP)\b/g, 'Menciona un impuesto que no existe en Argentina (ITBI es de Brasil, ITP de España).'],
  [/\bexent[oa]s?\b|libre\s+de\s+impuestos|sin\s+impuestos|no\s+pag[aá]s\s+(impuesto|ganancias)/gi, 'Afirma una exención de impuestos que no está confirmada.'],
  [/retenci[oó]n\s+del?\s+31\s*%/gi, 'Menciona una retención del 31% que no existe.'],
  [/\b(8[,.]31|7[,.]6)\s*%/g, 'Publica un porcentaje de renta de MAR-50 (no se publica durante la preinscripción).'],
  [/\bLey(?:es)?\s+(27\.551|27\.442)\b/gi, 'Cita una ley que no tiene relación con tokens.'],
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
  for (const [re, desc] of ALERTAS) {
    const ms = t.match(re);
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
