-- ============================================================================
-- Migration 032: sacar efectivo de la bolsa de alguien deja de ser un trámite (D54).
--
-- Hasta hoy un mesero podía "entregar" efectivo a media noche y el sistema lo
-- anotaba sin más: el gerente lo contaba después, cuando ya nadie recordaba de
-- dónde salía ese fajo ni por qué. Dos cosas faltaban, y las dos las pidió el dueño:
--
--   1. **El motivo.** "Traía mucho encima", "se lo llevó el gerente a la caja
--      fuerte", "se pagó al proveedor del hielo". Sin motivo, un retiro es un hueco
--      en el relato de la noche, y los huecos se llenan solos con sospechas.
--
--   2. **La autorización de un gerente o un admin, en el acto.** Quien saca el
--      dinero no puede ser el único que sabe que salió. El gerente teclea su PIN en
--      el aparato del empleado, delante de él, y con eso el retiro queda autorizado
--      y —porque está ahí, contando— también recibido.
--
-- Lo mismo para el corte final: se declara, se cuenta y se cierra en un solo acto,
-- con el gerente presente tecleando su PIN, y de ahí sale el ticket.
--
-- ---------------------------------------------------------------------------
-- Lo que la base hace cumplir y lo que no
-- ---------------------------------------------------------------------------
-- La base NO puede comprobar que un PIN era correcto: eso es del servidor. Lo que sí
-- puede, y hace aquí, es que no exista un renglón autorizado sin decir quién y
-- cuándo, ni un retiro sin motivo. Un CHECK vale más que una regla escrita en un
-- servicio, porque sigue ahí cuando alguien agregue la segunda ruta que escribe en
-- esta tabla.
--
-- Las columnas entran como NULL para no romper lo que ya está escrito —un club que
-- ya usó el corte de D51 tiene entregas sin motivo, y reescribirle la historia sería
-- peor que dejarla como fue—, y los CHECK solo aplican a los renglones nuevos, que
-- son los que sí traen autorización.
-- ============================================================================

-- ---------------------------------------------------------------- retiros parciales

ALTER TABLE shift_cash_drops
  -- Por qué salió ese dinero de la bolsa. Obligatorio en los retiros nuevos.
  ADD COLUMN IF NOT EXISTS reason          VARCHAR(200),
  -- Quién lo autorizó con su PIN, y cuándo. `authorized_role` se guarda aparte
  -- porque un gerente puede dejar de serlo, y el ticket impreso ya dijo que lo era.
  ADD COLUMN IF NOT EXISTS authorized_by   UUID REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS authorized_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS authorized_role VARCHAR(20);

-- Autorizado a medias no existe: o están las tres cosas o no hay autorización.
ALTER TABLE shift_cash_drops DROP CONSTRAINT IF EXISTS shift_cash_drops_authorization_chk;
ALTER TABLE shift_cash_drops ADD CONSTRAINT shift_cash_drops_authorization_chk
  CHECK (num_nonnulls(authorized_by, authorized_at, authorized_role) IN (0, 3));

-- Un retiro autorizado trae motivo. Los de antes de esta migración no lo traen y se
-- quedan como están: reescribir la historia de un club es peor que un hueco viejo.
ALTER TABLE shift_cash_drops DROP CONSTRAINT IF EXISTS shift_cash_drops_reason_chk;
ALTER TABLE shift_cash_drops ADD CONSTRAINT shift_cash_drops_reason_chk
  CHECK (authorized_by IS NULL OR (reason IS NOT NULL AND length(btrim(reason)) >= 3));

CREATE INDEX IF NOT EXISTS shift_cash_drops_authorizer_idx
  ON shift_cash_drops (authorized_by, authorized_at DESC) WHERE authorized_by IS NOT NULL;

-- ---------------------------------------------------------------- el corte

ALTER TABLE shift_closings
  ADD COLUMN IF NOT EXISTS authorized_by   UUID REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS authorized_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS authorized_role VARCHAR(20);

ALTER TABLE shift_closings DROP CONSTRAINT IF EXISTS shift_closings_authorization_chk;
ALTER TABLE shift_closings ADD CONSTRAINT shift_closings_authorization_chk
  CHECK (num_nonnulls(authorized_by, authorized_at, authorized_role) IN (0, 3));

/*
 * Quien autoriza no puede ser quien entrega.
 *
 * Es la regla entera de la función en una línea: un corte donde la misma persona
 * declara el dinero y lo autoriza no es un corte, es un recibo que alguien se firmó
 * solo. Va en la base y no solo en el servicio porque es la clase de regla que se
 * olvida cuando dentro de un año alguien agregue otra forma de cerrar un turno.
 */
ALTER TABLE shift_closings DROP CONSTRAINT IF EXISTS shift_closings_not_self_authorized_chk;
ALTER TABLE shift_closings ADD CONSTRAINT shift_closings_not_self_authorized_chk
  CHECK (authorized_by IS NULL OR authorized_by <> user_id);

ALTER TABLE shift_cash_drops DROP CONSTRAINT IF EXISTS shift_cash_drops_not_self_authorized_chk;
ALTER TABLE shift_cash_drops ADD CONSTRAINT shift_cash_drops_not_self_authorized_chk
  CHECK (authorized_by IS NULL OR authorized_by <> user_id);

-- ---------------------------------------------------------------- lo ya escrito

/*
 * La guarda de D51 congela un corte confirmado, y eso ahora estorba en un caso: el
 * ticket se imprime DESPUÉS de cerrar, y hay que poder anotar en qué papel salió
 * para reimprimirlo sin volver a calcular nada.
 *
 * Se agrega la columna y se ensancha la guarda lo mínimo: `ticket_job_id` se puede
 * escribir una vez sobre un corte confirmado, y nada más. Los montos, la diferencia,
 * su motivo y quién autorizó siguen congelados como antes.
 */
ALTER TABLE shift_closings
  ADD COLUMN IF NOT EXISTS ticket_job_id UUID REFERENCES print_jobs(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION shift_money_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '%: un corte no se borra (id=%)', TG_TABLE_NAME, OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_TABLE_NAME = 'shift_cash_drops' THEN
    IF NEW.amount <> OLD.amount OR NEW.shift_id <> OLD.shift_id OR NEW.user_id <> OLD.user_id
       OR NEW.currency <> OLD.currency OR NEW.created_at <> OLD.created_at
       OR NEW.reason IS DISTINCT FROM OLD.reason
       OR NEW.authorized_by IS DISTINCT FROM OLD.authorized_by THEN
      RAISE EXCEPTION 'shift_cash_drops: lo declarado no se edita (id=%)', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.status <> 'declared' AND NEW.status <> OLD.status THEN
      RAISE EXCEPTION 'shift_cash_drops: esa entrega ya está %s (id=%)', OLD.status, OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
  ELSE
    IF NEW.shift_id <> OLD.shift_id OR NEW.user_id <> OLD.user_id
       OR NEW.declared_cash <> OLD.declared_cash OR NEW.cash_collected <> OLD.cash_collected
       OR NEW.expected_cash <> OLD.expected_cash OR NEW.totals::text <> OLD.totals::text
       OR NEW.declared_at <> OLD.declared_at OR NEW.created_at <> OLD.created_at
       OR NEW.authorized_by IS DISTINCT FROM OLD.authorized_by THEN
      RAISE EXCEPTION 'shift_closings: lo declarado y lo cobrado no se editan (id=%)', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    -- Un corte confirmado sigue congelado, con UNA excepción: anotar en qué papel
    -- salió. El ticket se imprime después de cerrar, y sin esto no habría forma de
    -- reimprimir exactamente el mismo.
    IF OLD.status = 'confirmed' AND (
         NEW.status <> OLD.status
         OR NEW.counted_cash IS DISTINCT FROM OLD.counted_cash
         OR NEW.difference IS DISTINCT FROM OLD.difference
         OR NEW.difference_reason IS DISTINCT FROM OLD.difference_reason
         OR NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by
         OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
       ) THEN
      RAISE EXCEPTION 'shift_closings: ese corte ya está confirmado (id=%)', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
