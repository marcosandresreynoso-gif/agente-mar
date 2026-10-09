// src/db.js — Base de datos SQLite (leads, conversaciones, documentos, turnos, config)
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'agente.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      nombre TEXT,
      telefono TEXT,
      email TEXT,
      empresa TEXT,
      interes TEXT,
      fuente TEXT,
      session_id TEXT,
      notas TEXT
    );

    CREATE TABLE IF NOT EXISTS consultas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      session_id TEXT,
      modulo TEXT,
      canal TEXT,
      pregunta TEXT,
      respuesta TEXT
    );

    CREATE TABLE IF NOT EXISTS documentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      nombre_archivo TEXT,
      titulo TEXT,
      modulo TEXT,
      num_chunks INTEGER
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id INTEGER,
      idx INTEGER,
      contenido TEXT,
      FOREIGN KEY (doc_id) REFERENCES documentos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS turnos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      nombre TEXT,
      email TEXT,
      telefono TEXT,
      fecha TEXT,
      hora TEXT,
      motivo TEXT,
      estado TEXT DEFAULT 'pendiente'
    );

    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- ===== WhatsApp M-AR =====
    CREATE TABLE IF NOT EXISTS wa_contactos (
      telefono TEXT PRIMARY KEY,          -- formato WhatsApp: 549XXXXXXXXXX
      created_at TEXT NOT NULL,
      nombre TEXT,                        -- nombre de perfil de WhatsApp o de la empresa
      empresa TEXT,
      rubro TEXT,
      fuente TEXT,                        -- anuncio | whatsapp | buscador | manual
      anuncio TEXT,                       -- título/ID del anuncio de Facebook que lo trajo
      estado TEXT DEFAULT 'nuevo',        -- nuevo | contactado | respondio | interesado | cliente | descartado | baja
      bot_activo INTEGER DEFAULT 1,       -- 0 = lo atiende Marcos a mano
      pausa_hasta TEXT,                   -- bot pausado hasta esta fecha (cuando Marcos responde desde el celu)
      ultimo_entrante_at TEXT,            -- abre la ventana de 24 hs
      ultimo_saliente_at TEXT,
      ultima_plantilla_at TEXT,
      no_leidos INTEGER DEFAULT 0,
      notas TEXT
    );

    CREATE TABLE IF NOT EXISTS wa_mensajes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      telefono TEXT NOT NULL,
      direccion TEXT NOT NULL,            -- in | out
      autor TEXT,                         -- cliente | bot | marcos | celular | campania
      tipo TEXT,                          -- text | template | image | audio | ...
      contenido TEXT,
      wa_id TEXT,
      estado TEXT,                        -- sent | delivered | read | failed | recibido
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_wa_msg_tel ON wa_mensajes(telefono, id);
    CREATE INDEX IF NOT EXISTS idx_wa_msg_waid ON wa_mensajes(wa_id);
  `);

  // Config por defecto de la empresa
  const defaults = {
    empresa_nombre: 'Organización M-AR & Asociados',
    empresa_descripcion:
      'Servicios profesionales para emprendedores y profesionales que recién se independizan: asesoramiento comercial, contable, financiero y legal.',
    empresa_ubicacion: 'General Villegas, Buenos Aires, Argentina',
    empresa_contacto: 'marcosandresreynoso@gmail.com',
    tono: 'Directo, claro y práctico. Español rioplatense. Sin rodeos.',
    // WhatsApp M-AR
    wa_bot_activo: '1',
    wa_bot_modo: 'comercial',
    wa_limite_diario: '30',
    wa_instrucciones:
      'Atendés por WhatsApp a personas que llegaron por los anuncios de MARTOKEN en Facebook e Instagram. ' +
      'Objetivo: explicar MARTOKEN y sus proyectos con claridad, generar confianza y llevar a la persona a la acción: ' +
      'invertir en MAR-01 (https://www.martoken.com.ar/mar01/), preinscribirse en MAR-50 (https://www.martoken.com.ar/#mar50) o charlar con Marcos.\n' +
      '- Mensajes cortos: máximo 4 o 5 líneas. Es WhatsApp, no un mail.\n' +
      '- Sin títulos ni tablas. Para resaltar usá *negrita* (asteriscos simples).\n' +
      '- Hacé UNA pregunta por mensaje para conocer a la persona: qué le interesó del anuncio, si ya invirtió en inmuebles o cripto, qué monto aproximado piensa.\n' +
      '- Nunca prometas rentabilidad garantizada. Explicá cómo se genera el retorno según la documentación.\n' +
      '- Nunca pidas claves, frases semilla ni datos bancarios.\n' +
      '- Si la persona quiere hablar con alguien, decile que Marcos le escribe personalmente a la brevedad.'
  };
  const get = db.prepare('SELECT value FROM config WHERE key = ?');
  const set = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(defaults)) {
    if (!get.get(k)) set.run(k, v);
  }
}

function getConfig() {
  const rows = db.prepare('SELECT key, value FROM config').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

function setConfig(obj) {
  const stmt = db.prepare(
    'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  const tx = db.transaction((entries) => {
    for (const [k, v] of entries) stmt.run(k, String(v ?? ''));
  });
  tx(Object.entries(obj));
}

module.exports = { db, initDb, getConfig, setConfig, DATA_DIR };
