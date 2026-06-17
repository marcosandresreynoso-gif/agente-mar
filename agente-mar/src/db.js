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
  `);

  // Config por defecto de la empresa
  const defaults = {
    empresa_nombre: 'Organización M-AR & Asociados',
    empresa_descripcion:
      'Servicios profesionales para emprendedores y profesionales que recién se independizan: asesoramiento comercial, contable, financiero y legal.',
    empresa_ubicacion: 'General Villegas, Buenos Aires, Argentina',
    empresa_contacto: 'marcosandresreynoso@gmail.com',
    tono: 'Directo, claro y práctico. Español rioplatense. Sin rodeos.'
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
