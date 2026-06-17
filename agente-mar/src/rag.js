// src/rag.js — Entrenamiento con documentos: chunking + recuperación por relevancia (TF-IDF liviano)
const { db } = require('./db');

const STOP = new Set(
  ('de la el en y a los las un una que se del por con para es su al lo como mas pero sus le ya o este si ' +
    'porque esta entre cuando muy sin sobre tambien me hasta hay donde quien desde todo nos durante todos uno ' +
    'les ni contra otros ese eso ante ellos e esto mi antes algunos que unos yo otro otras otra el tanto esa ' +
    'estos mucho quienes nada muchos cual sea poco ella estar haber estas estaba estamos algunas algo nosotros')
    .split(' ')
);

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s) {
  return norm(s)
    .split(' ')
    .filter((t) => t.length > 2 && !STOP.has(t));
}

// Divide el texto en fragmentos de ~900 caracteres con solapamiento
function chunkText(text, size = 900, overlap = 150) {
  const clean = String(text).replace(/\s+\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  const chunks = [];
  let i = 0;
  while (i < clean.length) {
    chunks.push(clean.slice(i, i + size));
    i += size - overlap;
  }
  return chunks.filter((c) => c.trim().length > 40);
}

function indexDocument({ nombre_archivo, titulo, modulo, text }) {
  const pieces = chunkText(text);
  if (pieces.length === 0) throw new Error('No se pudo extraer texto del documento.');

  const insDoc = db.prepare(
    'INSERT INTO documentos (created_at, nombre_archivo, titulo, modulo, num_chunks) VALUES (?,?,?,?,?)'
  );
  const insChunk = db.prepare('INSERT INTO chunks (doc_id, idx, contenido) VALUES (?,?,?)');
  const tx = db.transaction(() => {
    const info = insDoc.run(new Date().toISOString(), nombre_archivo, titulo || nombre_archivo, modulo || 'todos', pieces.length);
    const docId = info.lastInsertRowid;
    pieces.forEach((c, idx) => insChunk.run(docId, idx, c));
    return docId;
  });
  return { docId: tx(), num_chunks: pieces.length };
}

// Recupera los fragmentos más relevantes a la consulta
function retrieve(query, modulo, limit = 4) {
  const qTerms = tokens(query);
  if (qTerms.length === 0) return '';

  let rows;
  if (modulo && modulo !== 'todos') {
    rows = db
      .prepare(
        `SELECT c.contenido, d.titulo FROM chunks c JOIN documentos d ON c.doc_id = d.id
         WHERE d.modulo = ? OR d.modulo = 'todos'`
      )
      .all(modulo);
  } else {
    rows = db.prepare(`SELECT c.contenido, d.titulo FROM chunks c JOIN documentos d ON c.doc_id = d.id`).all();
  }
  if (rows.length === 0) return '';

  // IDF por término sobre el corpus de chunks
  const N = rows.length;
  const dfCache = {};
  function idf(term) {
    if (dfCache[term] != null) return dfCache[term];
    let df = 0;
    for (const r of rows) if (norm(r.contenido).includes(term)) df++;
    const v = Math.log((N + 1) / (df + 1)) + 1;
    dfCache[term] = v;
    return v;
  }

  const scored = rows.map((r) => {
    const ntext = norm(r.contenido);
    let score = 0;
    for (const t of qTerms) {
      const matches = ntext.split(t).length - 1;
      if (matches > 0) score += matches * idf(t);
    }
    return { ...r, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.filter((s) => s.score > 0).slice(0, limit);
  if (top.length === 0) return '';

  return top.map((t) => `[${t.titulo}] ${t.contenido}`).join('\n---\n');
}

function listDocs() {
  return db.prepare('SELECT id, created_at, titulo, nombre_archivo, modulo, num_chunks FROM documentos ORDER BY id DESC').all();
}

function deleteDoc(id) {
  db.prepare('DELETE FROM chunks WHERE doc_id = ?').run(id);
  db.prepare('DELETE FROM documentos WHERE id = ?').run(id);
}

module.exports = { indexDocument, retrieve, listDocs, deleteDoc };
