// adjuntos.js — Fotos y archivos que Marcos les pasa a los agentes (datos reales).
// Se extrae el TEXTO de cada archivo y se guarda; el archivo original no se guarda (ahorra disco).
//  - Fotos / capturas: las lee un modelo de visión de Groq y transcribe números y textos.
//  - PDF: texto con pdf-parse.  - Excel (.xlsx): cada hoja pasa a CSV.  - CSV / TXT: texto tal cual.
const pdfParse = require('pdf-parse/lib/pdf-parse.js');
const { db } = require('./db');
const { leerImagen } = require('./groq');

const MAX_TEXTO = 40000;  // lo que se guarda por archivo (a los agentes les llega recortado)
const now = () => new Date().toISOString();

function initAdjuntos() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS eq_adjuntos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      nombre TEXT NOT NULL,
      tipo TEXT NOT NULL,        -- imagen | pdf | excel | texto
      texto TEXT
    );
  `);
}

function tipoDe(nombre, mime) {
  const n = String(nombre || '').toLowerCase();
  if (/^image\//.test(mime || '') || /\.(jpe?g|png|webp|gif)$/.test(n)) return 'imagen';
  if (mime === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
  if (/\.xlsx$/.test(n) || /spreadsheetml/.test(mime || '')) return 'excel';
  if (/\.(csv|txt|md|json|tsv)$/.test(n) || /^text\//.test(mime || '')) return 'texto';
  return null;
}

async function excelATexto(buffer) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const partes = [];
  wb.eachSheet((hoja) => {
    const filas = [];
    hoja.eachRow({ includeEmpty: false }, (fila) => {
      const celdas = (fila.values || []).slice(1).map((v) => {
        if (v == null) return '';
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        if (typeof v === 'object') return v.result ?? v.text ?? (v.richText ? v.richText.map((r) => r.text).join('') : '');
        return v;
      }).map((v) => { const s = String(v).replace(/\s+/g, ' ').trim(); return /[",;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; });
      if (celdas.some((c) => c !== '')) filas.push(celdas.join(';'));
    });
    if (filas.length) partes.push(`Hoja "${hoja.name}" (${filas.length} filas):\n${filas.join('\n')}`);
  });
  return partes.join('\n\n');
}

// Recibe el archivo subido (multer) y devuelve { id, nombre, tipo, texto }
async function procesarAdjunto(file) {
  if (!file || !file.buffer) throw new Error('No llegó ningún archivo.');
  const nombre = String(file.originalname || 'archivo').slice(0, 120);
  const tipo = tipoDe(nombre, file.mimetype);
  if (!tipo) throw new Error('Ese tipo de archivo no se puede leer. Usá fotos (JPG/PNG), PDF, Excel (.xlsx), CSV o TXT.');
  let texto = '';
  if (tipo === 'imagen') {
    const mime = /^image\//.test(file.mimetype || '') ? file.mimetype : 'image/jpeg';
    texto = await leerImagen(`data:${mime};base64,${file.buffer.toString('base64')}`, nombre);
  } else if (tipo === 'pdf') {
    texto = (await pdfParse(file.buffer)).text || '';
  } else if (tipo === 'excel') {
    texto = await excelATexto(file.buffer);
  } else {
    texto = file.buffer.toString('utf8');
  }
  texto = String(texto).replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!texto) throw new Error(tipo === 'pdf'
    ? 'El PDF no tiene texto (parece escaneado). Mandalo como foto o captura.'
    : 'No se pudo leer nada en ese archivo.');
  if (texto.length > MAX_TEXTO) texto = texto.slice(0, MAX_TEXTO) + '\n[…archivo muy largo: se guardó solo el principio…]';
  const id = db.prepare('INSERT INTO eq_adjuntos (created_at, nombre, tipo, texto) VALUES (?,?,?,?)').run(now(), nombre, tipo, texto).lastInsertRowid;
  return { id, nombre, tipo, texto };
}

function obtenerAdjuntos(ids) {
  const lista = (Array.isArray(ids) ? ids : []).map((x) => parseInt(x, 10)).filter((x) => x > 0).slice(0, 5);
  if (!lista.length) return [];
  const st = db.prepare('SELECT id, nombre, tipo, texto FROM eq_adjuntos WHERE id = ?');
  return lista.map((id) => st.get(id)).filter(Boolean);
}

// Bloque de texto para el agente, repartiendo un máximo de caracteres entre los archivos
function bloqueAdjuntos(adjuntos, maxChars, recortar) {
  if (!adjuntos || !adjuntos.length) return '';
  const porUno = Math.floor(maxChars / adjuntos.length);
  return '\n\nARCHIVOS ADJUNTOS DE MARCOS (datos REALES de MARTOKEN: usalos, citá los números tal cual y no inventes otros):\n' +
    adjuntos.map((a) => `--- 📎 ${a.nombre} (${a.tipo}) ---\n${recortar(a.texto, porUno)}`).join('\n\n') + '\n--- fin de los adjuntos ---';
}

module.exports = { initAdjuntos, procesarAdjunto, obtenerAdjuntos, bloqueAdjuntos, tipoDe };
