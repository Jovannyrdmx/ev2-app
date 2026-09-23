/**
 * EV2 — la autorización de un gerente, tecleada en el aparato de otro (D54).
 *
 * ---------------------------------------------------------------------------
 * Qué problema resuelve
 * ---------------------------------------------------------------------------
 * Sacar efectivo de la bolsa de un mesero a media noche, y cerrar su corte, son las
 * dos cosas de la noche donde el dinero cambia de manos sin que quede un voucher de
 * por medio. La regla del dueño es que un gerente o un admin esté ahí y lo autorice
 * en el acto, y la forma de probarlo con las manos ocupadas es la que ya existe: su
 * PIN de seis dígitos.
 *
 * ---------------------------------------------------------------------------
 * Por qué NO es lo mismo que entrar con PIN
 * ---------------------------------------------------------------------------
 * Al entrar, el PIN dice "soy yo, déjame pasar". Aquí dice "yo autorizo esto, y mi
 * nombre queda pegado a este retiro". Tres diferencias que importan:
 *
 *  1. **No abre sesión.** No se emite ningún token: el aparato sigue siendo del
 *     mesero cuando el gerente quita el dedo. Si esto devolviera una sesión, el
 *     mesero se quedaría con una sesión de gerente abierta en la mano.
 *  2. **Solo gerencia.** Un PIN de mesero es un PIN válido y aquí no autoriza nada.
 *  3. **Solo de ESTE club.** Un gerente de otro club no autoriza retiros aquí, por
 *     correcto que sea su PIN.
 *
 * ---------------------------------------------------------------------------
 * El riesgo que esto trae, dicho en voz alta
 * ---------------------------------------------------------------------------
 * El gerente teclea su PIN de acceso delante de un empleado, varias veces por noche.
 * Alguien se lo puede aprender mirando. Lo que lo acota es que el acceso de gerencia
 * por PIN está limitado a la red del club (ver `pins.PIN_ROLES` y las rutas de
 * acceso), así que el PIN robado no sirve desde la calle. Si algún día eso deja de
 * ser suficiente, lo que cambia es este archivo: un código de autorización aparte,
 * distinto del de acceso, sin tocar nada de lo que lo llama.
 *
 * El freno del club es el mismo que el del acceso, y a propósito: seis dígitos son
 * un millón de combinaciones, y sin freno esta ruta sería una segunda puerta para
 * adivinarlos con la ventaja de que aquí nadie mira la pantalla de intentos.
 */
'use strict';

const { ApiError } = require('../middleware/errors');
const pins = require('./pins');

/** Quién puede autorizar que salga dinero. */
const AUTHORIZING_ROLES = ['manager', 'admin'];

/**
 * Comprueba el PIN y devuelve a quién autoriza, o truena.
 *
 * `selfId` es quien está pidiendo la autorización: sirve para negar el caso que la
 * base también prohíbe —autorizarse a uno mismo—, pero con un mensaje que se
 * entiende en vez de una violación de restricción.
 *
 * El rechazo **nunca dice por qué**. "Ese PIN no es de nadie", "ese PIN es de un
 * mesero" y "ese PIN es del gerente de otro club" son tres respuestas distintas que,
 * juntas, permiten mapear los PIN del club de a uno por intento. Aquí son una sola.
 */
async function authorize(runner, { nightclubId, pin, selfId = null, ip = null }) {
  if (!/^\d{6}$/.test(String(pin || ''))) {
    throw ApiError.forbidden('Código de autorización inválido');
  }

  // El mismo freno por club que el acceso: se aplica ANTES de buscar y también
  // cuando el PIN resulta correcto, porque si solo frenara a los que fallan, el
  // tiempo de respuesta diría cuándo se le atinó.
  const fallos = await pins.recentFailures(runner, { nightclubId });
  const espera = pins.delayFor(fallos);
  if (espera > 0) await new Promise((r) => { setTimeout(r, espera); });

  const { user } = await pins.findByPin(runner, { nightclubId, pin });
  const vale = Boolean(user)
    && AUTHORIZING_ROLES.includes(user.role)
    && user.id !== selfId;

  // El intento queda escrito con o sin acierto. Sin los aciertos no se distingue un
  // ataque de un teclado pegajoso, y sin los fallos el freno no tiene qué contar.
  await pins.recordAttempt(runner, {
    nightclubId, ip, ok: vale, userId: user ? user.id : null,
  });

  if (!vale) throw ApiError.forbidden('Código de autorización inválido');
  return {
    id: user.id,
    role: user.role,
    name: user.display_name || user.first_name || null,
  };
}

module.exports = { AUTHORIZING_ROLES, authorize };
