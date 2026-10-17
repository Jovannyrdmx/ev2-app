// Who a request counts against in the general rate limit.
'use strict';

const jwt = require('jsonwebtoken');

/**
 * El límite general se contaba por IP, y en el club eso es contar a todos juntos: los
 * celulares, tablets y PCs de barras, cajas, puerta y valet salen a internet por el
 * mismo módem, con UNA sola IP pública. En una noche llena, cada pedido o cobro hace
 * recargar a todas las pantallas a la vez y entre todas se acababan las 300 por minuto;
 * el que tenía la mala suerte de pedir justo después recibía "Too many requests".
 *
 * Con sesión, cada quien cuenta por su cuenta (`user:<id>`). El token se VERIFICA con
 * la firma, no solo se lee: si bastara con mandar un token cualquiera, un atacante
 * inventaría uno por petición y tendría cupo infinito. Un token falso, vencido o
 * ausente cae a la IP, que es exactamente el comportamiento de antes.
 *
 * Los límites de acceso (login, PIN, pases, emparejamiento) NO usan esta llave: siguen
 * por IP, que es lo que frena a quien prueba contraseñas.
 */
function rateLimitKey(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    const secret = process.env.JWT_SECRET;
    if (secret && secret.length >= 16) {
      try {
        const payload = jwt.verify(header.slice(7), secret, { issuer: 'ev2' });
        if (payload && payload.sub) return `user:${payload.sub}`;
      } catch {
        // Firma inválida o vencido: cuenta por IP, como cualquier anónimo.
      }
    }
  }
  return `ip:${req.ip}`;
}

module.exports = { rateLimitKey };
