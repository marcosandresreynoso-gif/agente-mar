// src/notify.js — Avisos por email al dueño usando Web3Forms (no requiere SMTP)
const { getConfig } = require('./db');

const W3F_URL = 'https://api.web3forms.com/submit';

async function notifyEmail(subject, body) {
  const key = process.env.WEB3FORMS_KEY;
  if (!key) return false; // si no está configurado, no falla nada
  const cfg = getConfig();
  try {
    const res = await fetch(W3F_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        access_key: key,
        subject: `[Agente M-AR] ${subject}`,
        from_name: 'Agente Integral M-AR',
        email: cfg.empresa_contacto || 'noreply@example.com',
        message: body
      })
    });
    return res.ok;
  } catch {
    return false;
  }
}

module.exports = { notifyEmail };
