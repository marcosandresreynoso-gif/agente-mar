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
    // Logueamos el error completo para poder verlo en los logs de Render
    console.error('[/api/chat] ERROR:', e && e.stack ? e.stack : e);
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

/* ---------------------- IMPORTAR LEADS DESDE EL BUSCADOR ---------------------- */
// Recibe empresas contactadas desde buscador-empresas-mar y las guarda como leads.
// Protegido con el mismo ADMIN_PASSWORD. Manda UN solo aviso por lote (no uno por empresa).
app.post('/api/leads/import', async (req, res) => {
  try {
    const { token, empresas, canal } = req.body || {};

    if (!process.env.ADMIN_PASSWORD) {
      return res.status(500).json({ error: 'ADMIN_PASSWORD no configurada en el servidor.' });
    }
    if (token !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'No autorizado.' });
    }
    if (!Array.isArray(empresas) || empresas.length === 0) {
      return res.status(400).json({ error: 'No se recibió ninguna empresa.' });
    }

    const fuente = canal === 'email' ? 'buscador-email' : 'buscador-whatsapp';
    const ins = db.prepare(
      `INSERT INTO leads (created_at, nombre, telefono, email, empresa, interes, fuente, session_id, notas)
       VALUES (?,?,?,?,?,?,?,?,?)`
    );

    let guardados = 0;
    let repetidos = 0;

    const tx = db.transaction(() => {
      for (const e of empresas) {
        const telefono = (e.telefono || '').trim() || null;
        const email = (e.email || '').trim() || null;
        const empresa = (e.nombre || '').trim() || null;

        // Evitar duplicados por teléfono o email
        if (telefono || email) {
          const yaEsta = db
            .prepare(
              `SELECT id FROM leads WHERE
                 (telefono IS NOT NULL AND telefono = @t) OR
                 (email IS NOT NULL AND email = @e)
               LIMIT 1`
            )
            .get({ t: telefono || '', e: email || '' });
          if (yaEsta) {
            repetidos++;
            continue;
          }
        }

        const notas = [
          e.rubro ? `Rubro: ${e.rubro}` : null,
          e.direccion ? `Dirección: ${e.direccion}` : null,
          e.web ? `Web: ${e.web}` : null,
        ]
          .filter(Boolean)
          .join(' | ') || null;

        ins.run(
          now(),
          empresa,          // usamos el nombre de la empresa como nombre del lead
          telefono,
          email,
          empresa,
          'Prospección saliente',
          fuente,
          null,
          notas
        );
        guardados++;
      }
    });
    tx();

    // Un solo aviso por lote
    if (guardados > 0) {
      notifyEmail(
        `${guardados} lead(s) importado(s) desde el buscador`,
        [
          `Canal: ${canal === 'email' ? 'Email' : 'WhatsApp'}`,
          `Nuevos: ${guardados}`,
          `Ya existían: ${repetidos}`,
          '',
          'Empresas:',
          ...empresas.slice(0, 50).map((e) => `- ${e.nombre || 's/n'} ${e.telefono || e.email || ''}`),
        ].join('\n')
      ).catch(() => {});
    }

    res.json({ ok: true, guardados, repetidos });
  } catch (e) {
    console.error('[/api/leads/import] ERROR:', e && e.stack ? e.stack : e);
    res.status(500).json({ error: e.message });
  }
});

/* ---------------------- HEALTH ---------------------- */
app.get('/api/health', (req, res) => res.json({ ok: true, ts: now() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Agente Integral M-AR escuchando en :${PORT}`);
  // Carga los documentos base del repo si no están indexados.
  // Necesario porque el disco del plan Free se borra al reiniciar.
  try {
    const r = rag.seedFromRepo();
    if (r.cargados > 0) console.log(`[RAG] ${r.cargados} documento(s) base cargado(s) al arrancar.`);
  } catch (e) {
    console.error('[RAG] Error al cargar documentos base:', e.message);
  }
});
