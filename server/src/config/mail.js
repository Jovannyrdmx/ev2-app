/**
 * Correo saliente: de dónde sale y si está configurado.
 *
 * Mismo criterio que `config/oauth.js` y `config/payments.js`: las credenciales viven
 * **solo** en el `.env`, y mientras falten, el correo se reporta como no configurado
 * **diciendo qué variable falta**. Nada finge mandar: la ruta que lo necesita responde
 * 501 con el motivo, en vez de un "te mandamos el correo" que nunca llega.
 *
 * Se habla SMTP a secas porque es lo que todos los proveedores ofrecen (Gmail con
 * contraseña de aplicación, Brevo, Resend, Amazon SES, Mailgun, el servidor del
 * dominio...). Así el club escoge proveedor poniendo cuatro variables, sin tocar código.
 *
 *   SMTP_HOST      smtp.gmail.com, smtp-relay.brevo.com, email-smtp.us-east-1.amazonaws.com...
 *   SMTP_PORT      587 (STARTTLS, lo normal) o 465 (TLS directo). Por omisión 587.
 *   SMTP_USER      usuario del proveedor.
 *   SMTP_PASSWORD  su contraseña o llave de API.
 *   MAIL_FROM      remitente que ve la persona: "EV2 Clandestinoz <no-reply@ev2.mx>".
 *                  Tiene que ser una dirección que el proveedor permita (dominio
 *                  verificado), si no el correo cae en spam o se rechaza.
 *   SMTP_SECURE    opcional. `true` fuerza TLS directo (465); si falta, se deduce del puerto.
 */
'use strict';

/** Las variables, una por una, para que `deploy-env.test.js` vea que viajan al contenedor. */
const fromEnv = () => ({
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: process.env.SMTP_PORT,
  SMTP_SECURE: process.env.SMTP_SECURE,
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASSWORD: process.env.SMTP_PASSWORD,
  MAIL_FROM: process.env.MAIL_FROM,
});

function smtpConfig(env = fromEnv()) {
  const port = Number(env.SMTP_PORT || 587);
  const secure = env.SMTP_SECURE !== undefined
    ? /^(1|true|yes|si|sí)$/i.test(String(env.SMTP_SECURE).trim())
    : port === 465;
  return {
    host: (env.SMTP_HOST || '').trim(),
    port,
    secure,
    user: (env.SMTP_USER || '').trim(),
    password: env.SMTP_PASSWORD || '',
    from: (env.MAIL_FROM || '').trim(),
  };
}

/** Qué falta, en el orden en que se pone en el .env. Vacío = todo listo. */
function missing(env = fromEnv()) {
  const c = smtpConfig(env);
  const out = [];
  if (!c.host) out.push('SMTP_HOST');
  if (!Number.isInteger(c.port) || c.port <= 0) out.push('SMTP_PORT');
  if (!c.user) out.push('SMTP_USER');
  if (!c.password) out.push('SMTP_PASSWORD');
  if (!c.from) out.push('MAIL_FROM');
  return out;
}

const isConfigured = (env = fromEnv()) => missing(env).length === 0;

/** El motivo, escrito para quien administra el servidor, o `null` si está bien. */
function configProblem(env = fromEnv()) {
  const falta = missing(env);
  if (falta.length === 0) return null;
  return `Falta ${falta.join(', ')} en el .env del servidor. Pon los datos SMTP de tu `
    + 'proveedor de correo (ver docs/CORREO_SETUP.md) y vuelve a crear el contenedor '
    + '(`up -d`; `restart` NO relee el .env).';
}

module.exports = { smtpConfig, missing, isConfigured, configProblem };
