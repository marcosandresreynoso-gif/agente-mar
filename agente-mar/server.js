// server.js — Agente Integral Profesional M-AR & Asociados
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

const { initDb, db, getConfig, setConfig, DATA_DIR } = require('./src/db');
const { chat } = require('./src/groq');
const rag = require('./src/rag');
const leads = require('./src/leads');
const report = require('./src/report');
const whatsapp = require('./src/whatsapp');
const { notifyEmail } = require('./src/notify');

initDb();

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

function now() {
  return new Date().toISOString();
}

/* ---------------------- CHAT (atención al cliente) ---------------------- */
app.post('/api/chat', async (req, res) => {
  try {
    const { sessionId, modulo = 'todos', message, history = [] } = req.body || {};
    if (!message || !String(message).trim()) return res.status(400).json({ error: 'Mensaje vacío.' });

    const reply = await chat({ modulo, message, history });

    db.prepare(
      'INSERT INTO consultas (created_at, session_id, modulo, canal, pregunta, respuesta) VALUES (?,?,?,?,?,?)'
    ).run(now(), sessionId || null, modulo, 'web', String(message), reply);

    // Captura de leads en segundo plano (no bloquea la respuesta)
    const fullHistory = [...history, { role: 'user', content: message }, { role: 'assistant', content: reply }];
    leads
      .extractFromConversation({ session_id: sessionId, history: fullHistory })
      .then((lead) => {
        if (lead) leads.saveLead(lead);
      })
      .catch(() => {});

    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Error en el servidor.' });
  }
});

/* ---------------------- LEAD MANUAL (formulario) ---------------------- */
app.post('/api/lead', (req, res) => {
  try {
    const { nombre, telefono, email, empresa, interes, sessionId } = req.body || {};
    if (!email && !telefono) return res.status(400).json({ error: 'Dejá al menos un email o teléfono.' });
    const id = leads.saveLead({ nombre, telefono, email, empresa, interes, fuente: 'formulario', session_id: sessionId });
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------------------- TURNOS (agendamiento) ---------------------- */
app.post('/api/turno', (req, res) => {
  try {
    const { nombre, email, telefono, fecha, hora, motivo } = req.body || {};
    if (!fecha || !nombre) return res.status(400).json({ error: 'Faltan datos (nombre y fecha).' });
    const info = db
      .prepare('INSERT INTO turnos (created_at, nombre, email, telefono, fecha, hora, motivo, estado) VALUES (?,?,?,?,?,?,?,?)')
      .run(now(), nombre, email || null, telefono || null, fecha, hora || null, motivo || null, 'pendiente');
    notifyEmail(
      `Nuevo turno solicitado — ${nombre}`,
      `Fecha: ${fecha} ${hora || ''}\nNombre: ${nombre}\nEmail: ${email || '-'}\nTel: ${telefono || '-'}\nMotivo: ${motivo || '-'}`
    ).catch(() => {});
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/config-publica', (req, res) => {
  const c = getConfig();
  res.json({ empresa_nombre: c.empresa_nombre, empresa_descripcion: c.empresa_descripcion });
});

/* ---------------------- WHATSAPP ---------------------- */
app.get('/webhook/whatsapp', whatsapp.verify);
app.post('/webhook/whatsapp', whatsapp.receive);

/* ---------------------- REPORTE (cron externo) ---------------------- */
// Para que un cron gratuito (cron-job.org) lo dispare semanal: GET /api/report/run?token=XXXX
app.get('/api/report/run', async (req, res) => {
  if (process.env.REPORT_TOKEN && req.query.token !== process.env.REPORT_TOKEN) {
    return res.status(403).json({ error: 'Token inválido.' });
  }
  try {
    const days = parseInt(req.query.days, 10) || 7;
    const r = await report.generateAndSend(days);
    res.json({ ok: true, enviado: true, resumen: r.text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ============================ ADMIN ============================ */
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (!process.env.ADMIN_PASSWORD) return res.status(500).json({ error: 'ADMIN_PASSWORD no configurada.' });
  if (key !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'No autorizado.' });
  next();
}

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (!process.env.ADMIN_PASSWORD) return res.status(500).json({ error: 'ADMIN_PASSWORD no configurada en el servidor.' });
  if (password === process.env.ADMIN_PASSWORD) return res.json({ ok: true });
  res.status(401).json({ error: 'Contraseña incorrecta.' });
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const s7 = report.buildStats(7);
  const totalLeads = db.prepare('SELECT COUNT(*) n FROM leads').get().n;
  const totalConsultas = db.prepare('SELECT COUNT(*) n FROM consultas').get().n;
  const totalTurnos = db.prepare('SELECT COUNT(*) n FROM turnos').get().n;
  const totalDocs = db.prepare('SELECT COUNT(*) n FROM documentos').get().n;
  res.json({ semana: s7, totales: { leads: totalLeads, consultas: totalConsultas, turnos: totalTurnos, documentos: totalDocs } });
});

app.get('/api/admin/leads', requireAdmin, (req, res) => res.json(leads.listLeads()));

app.get('/api/admin/leads.csv', requireAdmin, (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="leads-mar.csv"');
  res.send(leads.toCSV());
});

app.get('/api/admin/consultas', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM consultas ORDER BY id DESC LIMIT 300').all();
  res.json(rows);
});

app.get('/api/admin/turnos', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM turnos ORDER BY id DESC').all());
});

app.post('/api/admin/turno/:id', requireAdmin, (req, res) => {
  const { estado } = req.body || {};
  db.prepare('UPDATE turnos SET estado = ? WHERE id = ?').run(estado || 'pendiente', req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/documentos', requireAdmin, (req, res) => res.json(rag.listDocs()));

app.post('/api/admin/documentos', requireAdmin, upload.single('archivo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo.' });
    const name = req.file.originalname || 'documento';
    let text = '';
    if (name.toLowerCase().endsWith('.pdf')) {
      const parsed = await pdfParse(req.file.buffer);
      text = parsed.text || '';
    } else {
      text = req.file.buffer.toString('utf-8');
    }
    if (!text.trim()) return res.status(400).json({ error: 'No se pudo leer texto del archivo (¿PDF escaneado?).' });
    const result = rag.indexDocument({
      nombre_archivo: name,
      titulo: req.body.titulo || name,
      modulo: req.body.modulo || 'todos',
      text
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/documentos/:id', requireAdmin, (req, res) => {
  rag.deleteDoc(req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/config', requireAdmin, (req, res) => res.json(getConfig()));
app.post('/api/admin/config', requireAdmin, (req, res) => {
  setConfig(req.body || {});
  res.json({ ok: true });
});

app.get('/api/admin/report', requireAdmin, async (req, res) => {
  try {
    const days = parseInt(req.query.days, 10) || 7;
    const send = req.query.send === '1';
    const r = send ? await report.generateAndSend(days) : await report.generate(days);
    res.json({ ok: true, enviado: send, ...r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------------------- HEALTH ---------------------- */
app.get('/api/health', (req, res) => res.json({ ok: true, ts: now() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Agente Integral M-AR escuchando en :${PORT}`));
