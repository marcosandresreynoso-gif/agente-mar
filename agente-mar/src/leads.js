// src/leads.js — Captura automática de leads + export + aviso por email
const { db } = require('./db');
const { complete } = require('./groq');
const { notifyEmail } = require('./notify');

function saveLead(lead) {
  const stmt = db.prepare(
    `INSERT INTO leads (created_at, nombre, telefono, email, empresa, interes, fuente, session_id, notas)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  const info = stmt.run(
    new Date().toISOString(),
    lead.nombre || null,
    lead.telefono || null,
    lead.email || null,
    lead.empresa || null,
    lead.interes || null,
    lead.fuente || 'web',
    lead.session_id || null,
    lead.notas || null
  );
  // Aviso al dueño
  notifyEmail(
    `Nuevo lead — ${lead.nombre || lead.email || lead.telefono || 'sin nombre'}`,
    [
      `Nombre: ${lead.nombre || '-'}`,
      `Teléfono: ${lead.telefono || '-'}`,
      `Email: ${lead.email || '-'}`,
      `Empresa: ${lead.empresa || '-'}`,
      `Interés: ${lead.interes || '-'}`,
      `Fuente: ${lead.fuente || 'web'}`
    ].join('\n')
  ).catch(() => {});
  return info.lastInsertRowid;
}

function existsLead(session_id, email, telefono) {
  if (!session_id && !email && !telefono) return false;
  const row = db
    .prepare(
      `SELECT id FROM leads WHERE
        (session_id IS NOT NULL AND session_id = @s) OR
        (email IS NOT NULL AND email = @e) OR
        (telefono IS NOT NULL AND telefono = @t)
       LIMIT 1`
    )
    .get({ s: session_id || '', e: email || '', t: telefono || '' });
  return !!row;
}

// Extrae datos de contacto de la conversación usando el modelo. Devuelve null si no hay nada útil.
async function extractFromConversation({ session_id, history }) {
  try {
    const convo = (history || [])
      .map((h) => `${h.role === 'user' ? 'Cliente' : 'Agente'}: ${h.content}`)
      .join('\n')
      .slice(0, 6000);
    if (!convo.trim()) return null;

    const sys =
      'Extraés datos de contacto de una conversación comercial. Devolvés SOLO un objeto JSON con las claves ' +
      'nombre, telefono, email, empresa, interes. Si un dato no aparece, poné cadena vacía. ' +
      'No inventes nada. "interes" es un resumen de 1 línea de qué busca el cliente.';
    const out = await complete(sys, convo, { json: true, maxTokens: 300 });
    let data;
    try {
      data = JSON.parse(out);
    } catch {
      return null;
    }
    const email = (data.email || '').trim();
    const telefono = (data.telefono || '').trim();
    if (!email && !telefono) return null; // sin forma de contactar, no es lead
    if (existsLead(session_id, email, telefono)) return null;

    return {
      nombre: (data.nombre || '').trim(),
      telefono,
      email,
      empresa: (data.empresa || '').trim(),
      interes: (data.interes || '').trim(),
      fuente: 'chat (auto)',
      session_id
    };
  } catch {
    return null;
  }
}

function listLeads() {
  return db.prepare('SELECT * FROM leads ORDER BY id DESC').all();
}

function toCSV() {
  const rows = listLeads();
  const cols = ['created_at', 'nombre', 'telefono', 'email', 'empresa', 'interes', 'fuente', 'notas'];
  const head = ['fecha', 'nombre', 'telefono', 'email', 'empresa', 'interes', 'fuente', 'notas'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [head.join(',')];
  for (const r of rows) lines.push(cols.map((c) => esc(r[c])).join(','));
  // BOM para que Excel respete acentos
  return '\uFEFF' + lines.join('\r\n');
}

module.exports = { saveLead, extractFromConversation, listLeads, toCSV };
