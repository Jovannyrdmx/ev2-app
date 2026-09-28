-- ============================================================================
-- Migration 037: borrar la cuenta de un cliente (D68).
--
-- ---------------------------------------------------------------------------
-- Por qué la fila NO se borra
-- ---------------------------------------------------------------------------
-- Hay 98 llaves foráneas apuntando a `users`, y varias son `ON DELETE RESTRICT`:
-- `drink_orders.sender_id`, `reservations.user_id`, `transactions` tiene además el
-- borrado prohibido por trigger. Un `DELETE FROM users` o falla, o se lleva por
-- delante el libro contable de noches que ya se cerraron y se declararon.
--
-- Lo que la persona pide cuando pide "borra mi cuenta" no es que desaparezcan los
-- montos de una noche de hace ocho meses: es dejar de estar identificada. Eso sí se
-- puede, y es lo que hace esta migración: la fila se queda para que las cuentas
-- cuadren, pero vacía de todo lo que dice quién era.
--
-- ---------------------------------------------------------------------------
-- Qué se borra de verdad
-- ---------------------------------------------------------------------------
-- Nombre, correo, teléfono y fecha de nacimiento se sobrescriben. Sesiones, cuentas
-- sociales ligadas, métodos de pago, preferencias, mensajes de flirt, bloqueos,
-- dispositivos: filas borradas. El teléfono del valet y el destino del taxi —que es
-- la casa de alguien— se vacían. El correo pasa a `<id>@borrada.invalid`: `.invalid`
-- está reservado por el RFC 2606 precisamente para que nunca exista, así que ese
-- correo no puede llegarle a nadie, y el UNIQUE (nightclub_id, email) sigue
-- cumpliéndose sin ocupar el correo real, que queda libre para registrarse otra vez.
--
-- ---------------------------------------------------------------------------
-- Qué NO se borra, y por qué
-- ---------------------------------------------------------------------------
-- Los reportes que OTRAS personas levantaron (`user_reports` recibidos) se quedan.
-- Si borrarse limpiara los reportes en contra, borrarse sería la forma de estrenar
-- expediente: el acoso se convertiría en algo que se resuelve creando otra cuenta.
-- Quedan atados a una fila que ya no dice quién es.
--
-- El `audit_log` tampoco se toca: tiene el borrado prohibido desde 001 y es el
-- registro de lo que hizo la GERENCIA, no el cliente.
--
-- ---------------------------------------------------------------------------
-- Una sola vez
-- ---------------------------------------------------------------------------
-- `account_deletions` deja constancia de que la cuenta se borró, cuándo y a petición
-- de quién, SIN un solo dato personal —ni el correo que tenía—. Sirve para dos cosas:
-- responder "sí, se borró el 14 de marzo" sin conservar a la persona para poder
-- responderlo, y para que el trigger de abajo impida que una cuenta ya borrada se
-- vuelva a tocar.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS account_deletions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,

  -- La fila anonimizada. Se conserva el vínculo porque el id ya no identifica a
  -- nadie: es lo único que queda, y es lo que permite decir "esta cuenta se borró".
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- `self` es la persona desde su teléfono; `manager` es la gerencia atendiendo una
  -- petición por escrito, que es el camino que la página de privacidad ofrece a quien
  -- ya no puede entrar a su cuenta.
  requested_by VARCHAR(10) NOT NULL CHECK (requested_by IN ('self', 'manager')),

  -- Quién ejecutó el borrado. NULL cuando fue la propia persona: su id ya está en
  -- `user_id` y repetirlo no agrega nada.
  actor_id     UUID REFERENCES users(id) ON DELETE SET NULL,

  -- Cuántas filas se limpiaron, por tabla. Es un conteo, no un contenido: sirve para
  -- demostrar que el borrado corrió completo sin guardar nada de lo que borró.
  cleared      JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Una cuenta se borra una vez. Sin esto, un segundo intento volvería a escribir
  -- constancias sobre una fila que ya no tiene nada que borrar.
  UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS account_deletions_club_idx
  ON account_deletions (nightclub_id, created_at DESC);

-- Una constancia de borrado no se edita ni se borra: si se pudiera, no sería una
-- constancia. Misma regla que `audit_log` y `transactions` desde 001.
CREATE OR REPLACE FUNCTION account_deletions_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'account_deletions: una constancia de borrado no se modifica (id=%)',
    OLD.id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS account_deletions_no_update ON account_deletions;
CREATE TRIGGER account_deletions_no_update BEFORE UPDATE ON account_deletions
  FOR EACH ROW EXECUTE FUNCTION account_deletions_guard();

DROP TRIGGER IF EXISTS account_deletions_no_delete ON account_deletions;
CREATE TRIGGER account_deletions_no_delete BEFORE DELETE ON account_deletions
  FOR EACH ROW EXECUTE FUNCTION account_deletions_guard();

-- ---------------------------------------------------------------------------
-- Una cuenta borrada no revive
-- ---------------------------------------------------------------------------
-- `status = 'deleted'` existía desde 001 y ningún código lo escribía nunca. A partir
-- de aquí sí lo escribe, y este trigger lo vuelve definitivo: nadie puede reactivar
-- una cuenta borrada ni volver a ponerle un correo, ni con un UPDATE a mano en la
-- base. Sin él, "borrada" sería una etiqueta que cualquiera despega.
--
-- Lo único que se deja pasar es el propio borrado (active/blocked -> deleted).
CREATE OR REPLACE FUNCTION users_deleted_is_final() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'deleted' THEN
    RAISE EXCEPTION 'users: una cuenta borrada no se modifica (id=%)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_deleted_guard ON users;
CREATE TRIGGER users_deleted_guard BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION users_deleted_is_final();

COMMIT;
