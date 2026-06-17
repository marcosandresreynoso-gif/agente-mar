// src/report.js — Reporte de actividad para el dueño
const { db } = require('./db');
const { complete } = require('./groq');
const { notifyEmail } = require('./notify');

function sinceISO(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function buildStats(days = 7) {
  const since = sinceISO(days);
  const totalConsultas = db.prepare('SELECT COUNT(*) n FROM consultas WHERE created_at >= ?').get(since).n;
  const totalLeads = db.prepare('SELECT COUNT(*) n FROM leads WHERE created_at >= ?').get(since).n;
  const porModulo = db
    .prepare('SELECT modulo, COUNT(*) n FROM consultas WHERE created_at >= ? GROUP BY modulo ORDER BY n DESC')
    .all(since);
  const turnos = db.prepare('SELECT COUNT(*) n FROM turnos WHERE created_at >= ?').get(since).n;
  const preguntas = db
    .prepare('SELECT pregunta FROM consultas WHERE created_at >= ? ORDER BY id DESC LIMIT 200')
    .all(since)
    .map((r) => r.pregunta);
  const leads = db.prepare('SELECT nombre, email, telefono, interes FROM leads WHERE created_at >= ? ORDER BY id DESC').all(since);
  return { days, totalConsultas, totalLeads, turnos, porModulo, preguntas, leads };
}

// Agrupa las preguntas en temas usando el modelo (con fallback simple)
async function topTemas(preguntas) {
  if (!preguntas.length) return [];
  try {
    const sys =
      'Recibís una lista de preguntas de clientes. Agrupá en máximo 5 temas frecuentes. ' +
      'Devolvé SOLO JSON: {"temas":[{"tema":"...","cantidad":N}]} ordenado por cantidad desc.';
    const out = await complete(sys, preguntas.slice(0, 120).join('\n'), { json: true, maxTokens: 400 });
    const data = JSON.parse(out);
    return data.temas || [];
  } catch {
    return [{ tema: `${preguntas.length} consultas recibidas`, cantidad: preguntas.length }];
  }
}

async function generate(days = 7) {
  const s = buildStats(days);
  const temas = await topTemas(s.preguntas);

  const lines = [];
  lines.push(`REPORTE DE ACTIVIDAD — últimos ${days} días`);
  lines.push(`Generado: ${new Date().toLocaleString('es-AR')}`);
  lines.push('');
  lines.push(`Consultas recibidas: ${s.totalConsultas}`);
  lines.push(`Potenciales clientes (leads): ${s.totalLeads}`);
  lines.push(`Turnos solicitados: ${s.turnos}`);
  lines.push('');
  lines.push('Consultas por módulo:');
  for (const m of s.porModulo) lines.push(`  - ${m.modulo || 'sin módulo'}: ${m.n}`);
  lines.push('');
  lines.push('Temas más frecuentes:');
  for (const t of temas) lines.push(`  - ${t.tema} (${t.cantidad})`);
  lines.push('');
  lines.push('Leads generados:');
  if (s.leads.length === 0) lines.push('  (ninguno en el período)');
  for (const l of s.leads)
    lines.push(`  - ${l.nombre || 's/n'} | ${l.email || '-'} | ${l.telefono || '-'} | ${l.interes || ''}`);

  const text = lines.join('\n');
  return { text, stats: s, temas };
}

async function generateAndSend(days = 7) {
  const r = await generate(days);
  await notifyEmail(`Reporte de actividad (${days} días)`, r.text);
  return r;
}

module.exports = { generate, generateAndSend, buildStats };
