// src/whatsapp.js — Integración WhatsApp Cloud API (Meta)
// Requiere variables: WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, WHATSAPP_VERIFY_TOKEN
const { chat } = require('./groq');
const { db } = require('./db');

// Verificación del webhook (Meta hace un GET la primera vez)
function verify(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
}

async function sendMessage(to, text) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  if (!token || !phoneId) return;
  await fetch(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text.slice(0, 4000) }
    })
  }).catch(() => {});
}

// Recepción de mensajes
async function receive(req, res) {
  res.sendStatus(200); // responder rápido a Meta
  try {
    const entry = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = entry?.messages?.[0];
    if (!msg || msg.type !== 'text') return;
    const from = msg.from;
    const text = msg.text?.body || '';
    if (!text.trim()) return;

    const reply = await chat({ modulo: 'todos', message: text, history: [] });

    db.prepare(
      'INSERT INTO consultas (created_at, session_id, modulo, canal, pregunta, respuesta) VALUES (?,?,?,?,?,?)'
    ).run(new Date().toISOString(), `wa:${from}`, 'todos', 'whatsapp', text, reply);

    await sendMessage(from, reply);
  } catch (e) {
    // no romper el webhook
  }
}

module.exports = { verify, receive, sendMessage };
