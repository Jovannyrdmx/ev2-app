/**
 * Mandar un correo. Una sola puerta de salida para todo el servidor.
 *
 * Hoy lo usa "olvidé mi contraseña" (D127); mañana el recibo por correo o el aviso de
 * reserva entran por aquí y no inventan otro transporte. Por eso el módulo es chico y
 * no sabe nada de contraseñas: recibe destinatario, asunto, texto y HTML, y lo entrega.
 *
 * El transporte es SMTP vía nodemailer, con la configuración de `config/mail.js`. Se
 * crea una sola vez (pool de conexiones) y se puede sustituir desde las pruebas con
 * `useTransport()` para capturar lo que se mandó sin tocar la red.
 */
'use strict';

const nodemailer = require('nodemailer');
const mailConfig = require('../config/mail');

let transport = null;
let transportKey = null;

/** El transporte real, creado con lo que hay en el .env al momento de usarlo. */
function realTransport() {
  const c = mailConfig.smtpConfig();
  // Si el .env cambió entre llamadas (solo pasa en pruebas), se vuelve a crear.
  const key = JSON.stringify([c.host, c.port, c.secure, c.user]);
  if (!transport || transportKey !== key) {
    transport = nodemailer.createTransport({
      host: c.host,
      port: c.port,
      secure: c.secure,
      auth: { user: c.user, pass: c.password },
      pool: true,
      maxConnections: 2,
      // Un proveedor caído no puede colgar la petición HTTP un minuto entero.
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    });
    transportKey = key;
  }
  return transport;
}

let override = null;

/**
 * Sustituir el transporte (pruebas, o un adaptador local). Recibe un objeto con
 * `sendMail(message)`; `null` vuelve al SMTP real.
 */
function useTransport(t) {
  override = t;
}

const isConfigured = () => Boolean(override) || mailConfig.isConfigured();
const configProblem = () => (override ? null : mailConfig.configProblem());

/**
 * Entregar un correo. Lanza si no hay cómo mandarlo o si el proveedor lo rechaza; quien
 * llama decide si eso se le cuenta a la persona o solo se registra.
 */
async function send({ to, subject, text, html }) {
  if (!to || !subject || !(text || html)) {
    throw new Error('mailer.send: faltan destinatario, asunto o cuerpo');
  }
  const problem = configProblem();
  if (problem) throw new Error(`Correo no configurado. ${problem}`);
  const from = override ? (mailConfig.smtpConfig().from || 'EV2 <no-reply@localhost>')
    : mailConfig.smtpConfig().from;
  const t = override || realTransport();
  return t.sendMail({ from, to, subject, text, html });
}

module.exports = { send, isConfigured, configProblem, useTransport };
