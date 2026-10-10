-- ============================================================================
-- Migration 019: un pase por persona, no uno por mesa.
--
-- Hasta ahora una reservación tenía UN pase (migración 016). Ocho personas
-- entraban con el mismo código: el primero que llegaba lo gastaba y los otros
-- siete entraban porque el de la puerta se acordaba de la cara, o porque el
-- titular salía a la banqueta a enseñar su teléfono otra vez. Eso no es un
-- control de acceso, es una cortesía.
--
-- La regla del club, y lo que esta migración hace posible:
--
--   * cada invitado tiene su propio QR, firmado y de UN SOLO USO. Entra una
--     persona por pase, y el pase se gasta;
--   * el titular reparte los pases de su mesa por WhatsApp, y cada reparto
--     queda registrado;
--   * un pase se puede REVOCAR (el invitado ya no va) y REASIGNAR (va otro en
--     su lugar). Revocar no borra: el pase viejo queda muerto y con motivo, y
--     el nuevo apunta a cuál sustituyó;
--   * en la puerta, seguridad revisa la IDENTIFICACIÓN PRIMERO y escanea
--     DESPUÉS. Eso no es una recomendación en un manual: sin una revisión de
--     identificación aceptada y sin gastar, el escaneo no abre. Así un menor de
--     edad o una identificación inválida no queman el pase, y el titular puede
--     reasignarlo a alguien más esa misma noche;
--   * si el invitado llega sin QR —teléfono muerto, pantalla rota, nunca le
--     llegó el mensaje— la puerta lo busca por folio, nombre o teléfono y le
--     emite un pase de CONTINGENCIA: temporal, de un uso, con motivo y con
--     nombre de quién lo emitió.
--
-- Y lo que el QR NO lleva: ni nombre, ni teléfono, ni fecha de nacimiento, ni
-- el id de la reservación. Lleva un código aleatorio y una firma. Un QR
-- fotografiado de la pantalla de otro no revela nada de esa persona, y un
-- código inventado a mano no pasa la firma.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. El pase
--
-- `code` es lo que se teclea y lo que va dentro del QR. Aleatorio, nunca
-- derivado de la reservación: un código que se pudiera deducir de "mesa 46,
-- sábado" sería la entrada de otra persona.
--
-- Único en toda la tabla y no por club, igual que `reservations.pass_code`: la
-- puerta teclea un código sin decir de qué club es, y dos clubes chocando
-- dejarían entrar a la persona equivocada.
--
-- No hay columna de firma. La firma se calcula con una llave del servidor
-- (`guestPasses.sign`) y por eso no se guarda: si estuviera en la base, quien
-- leyera la base podría fabricar QRs válidos, que es justo lo que la firma
-- existe para impedir.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS guest_passes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id    UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  reservation_id  UUID REFERENCES reservations(id) ON DELETE CASCADE,
  -- Un extra vendido en la puerta trae su propio QR, y esto es lo que lo liga
  -- con el cobro. Sin esto, "pagué dos extras" y "entraron dos extras" serían
  -- dos afirmaciones sin manera de cuadrarlas.
  admission_id    UUID REFERENCES door_admissions(id) ON DELETE SET NULL,

  code            VARCHAR(20) NOT NULL,

  -- holder      : el que reservó. Su código es el mismo `reservations.pass_code`
  --               que ya existía, para que los QRs repartidos antes de esta
  --               migración sigan abriendo.
  -- guest       : uno de los lugares incluidos en la reservación.
  -- extra       : invitado adicional pagado (en la puerta o después).
  -- contingency : el temporal que emite la puerta cuando no hay QR.
  kind            VARCHAR(20) NOT NULL
                  CHECK (kind IN ('holder', 'guest', 'extra', 'contingency')),

  -- active | used | revoked. `expired` no es un estado guardado: se decide con
  -- `expires_at` y el reloj, porque un estado que hay que ir a actualizar con
  -- un cron se queda viejo justo la noche que nadie está viendo.
  status          VARCHAR(20) NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'used', 'revoked')),

  -- Lo único que el titular escribe de la persona: cómo la va a reconocer la
  -- puerta. "Ana", "mi primo", "Luis el del trabajo". A propósito NO hay
  -- teléfono, correo, ni fecha de nacimiento: el sistema no necesita saber
  -- quién es el invitado para dejarlo entrar, necesita que su pase sea válido y
  -- que su identificación diga que es mayor de edad.
  label           VARCHAR(60),

  -- Solo lo llena el pase de contingencia y el `expires_at` de un pase normal
  -- se queda nulo: el que manda es el horario de la reservación.
  expires_at      TIMESTAMPTZ,

  used_at         TIMESTAMPTZ,
  used_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  revoked_at      TIMESTAMPTZ,
  revoked_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  revoke_reason   VARCHAR(200),

  -- La cadena de reasignaciones. Un pase reasignado tres veces se puede seguir
  -- hacia atrás hasta el original, que es lo que hace auditable un cambio de
  -- invitado a media noche.
  replaces_id     UUID REFERENCES guest_passes(id) ON DELETE SET NULL,

  -- Cuántas veces se compartió y cuándo la última. El detalle de cada reparto
  -- está en `guest_pass_events`; esto es para poder ordenar y filtrar sin
  -- recorrer la auditoría.
  share_count     INTEGER NOT NULL DEFAULT 0 CHECK (share_count >= 0),
  last_shared_at  TIMESTAMPTZ,

  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Un pase suelto no existe: o es de una reservación, o es un extra con su
  -- cobro. Sin esto, un pase sin dueño ni cobro sería una entrada gratis que
  -- nadie puede explicar.
  CONSTRAINT guest_passes_belongs_somewhere
    CHECK (reservation_id IS NOT NULL OR admission_id IS NOT NULL),
  -- Gastado quiere decir gastado: con hora y con quién lo escaneó.
  CONSTRAINT guest_passes_used_is_stamped
    CHECK ((status <> 'used') OR (used_at IS NOT NULL)),
  -- Y revocado quiere decir revocado, con motivo. Un pase muerto sin motivo es
  -- una discusión en la puerta que nadie puede resolver.
  CONSTRAINT guest_passes_revoked_has_a_reason
    CHECK ((status <> 'revoked') OR (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS guest_passes_code_uidx ON guest_passes (code);
CREATE INDEX IF NOT EXISTS guest_passes_reservation_idx
  ON guest_passes (reservation_id, kind) WHERE reservation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS guest_passes_night_idx
  ON guest_passes (nightclub_id, created_at DESC);
CREATE INDEX IF NOT EXISTS guest_passes_admission_idx
  ON guest_passes (admission_id) WHERE admission_id IS NOT NULL;

DROP TRIGGER IF EXISTS guest_passes_set_updated_at ON guest_passes;
CREATE TRIGGER guest_passes_set_updated_at
  BEFORE UPDATE ON guest_passes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE guest_passes IS
  'Un pase por persona: firmado, de un solo uso, revocable y reasignable.';
COMMENT ON COLUMN guest_passes.code IS
  'Lo que va dentro del QR y lo que la puerta teclea. Aleatorio, sin dato personal.';
COMMENT ON COLUMN guest_passes.label IS
  'Cómo reconocer al invitado en la puerta. Un nombre de pila, nada más.';

-- ---------------------------------------------------------------------------
-- 2. La revisión de identificación, que va ANTES del escaneo
--
-- Es su propia tabla y no un par de columnas en `guest_passes` por una razón
-- práctica: la revisión ocurre cuando todavía no se sabe de qué pase se trata.
-- Seguridad pide la INE, la mira, y hasta entonces pide el teléfono con el QR.
-- Una revisión vive sola unos minutos, se gasta con un escaneo, y las que se
-- quedan sin gastar son exactamente las que documentan un rechazo.
--
-- Lo que NO se guarda: el número de la identificación, ni la fecha de
-- nacimiento, ni una foto. Se guarda qué documento se enseñó, si era mayor de
-- edad, si se aceptó y quién lo revisó. Eso alcanza para responder "¿quién dejó
-- entrar a esta persona?" sin convertir la puerta en un archivo de datos
-- personales que hay que custodiar.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS door_id_checks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id  UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  document      VARCHAR(20) NOT NULL
                CHECK (document IN ('ine', 'passport', 'license', 'other', 'none')),
  -- La única pregunta sobre la edad que el sistema hace y guarda.
  adult         BOOLEAN NOT NULL,
  decision      VARCHAR(20) NOT NULL CHECK (decision IN ('accepted', 'rejected')),
  -- Por qué se rechazó, en palabras, para el reporte de la noche.
  reason        VARCHAR(200),
  checked_by    UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- Qué pase abrió con esta revisión. Nulo mientras no se gasta, y nulo para
  -- siempre en un rechazo.
  consumed_by   UUID REFERENCES guest_passes(id) ON DELETE SET NULL,
  consumed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Una revisión aceptada de un menor de edad no existe: sería la manera
  -- silenciosa de saltarse la regla.
  CONSTRAINT door_id_checks_minors_are_never_accepted
    CHECK (decision = 'rejected' OR adult),
  CONSTRAINT door_id_checks_rejection_has_a_reason
    CHECK (decision = 'accepted' OR reason IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS door_id_checks_night_idx
  ON door_id_checks (nightclub_id, created_at DESC);
-- Para encontrar rápido la revisión fresca y sin gastar del guardia que está
-- escaneando, que es la única consulta que corre con la fila esperando.
CREATE INDEX IF NOT EXISTS door_id_checks_open_idx
  ON door_id_checks (checked_by, created_at DESC) WHERE consumed_by IS NULL;

COMMENT ON TABLE door_id_checks IS
  'La revisión de identificación en la puerta. Se hace antes del escaneo y se gasta con él.';
COMMENT ON COLUMN door_id_checks.adult IS
  'Lo único que se guarda de la edad. Ni fecha de nacimiento ni número de identificación.';

-- Un pase no se puede gastar dos veces con la misma revisión, y una revisión no
-- puede abrir dos pases. Dos guardias escaneando a la vez con la misma revisión
-- es justo el hueco que esto cierra.
CREATE UNIQUE INDEX IF NOT EXISTS door_id_checks_consumed_once_uidx
  ON door_id_checks (consumed_by) WHERE consumed_by IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. La auditoría
--
-- Insert-only, como el kardex del almacén y por el mismo motivo: lo que se
-- corrige se corrige con un renglón nuevo. Si esta tabla se pudiera editar, la
-- única respuesta a "este pase lo usó alguien más" sería la palabra de quien
-- tiene acceso a la base.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS guest_pass_events (
  id          BIGSERIAL PRIMARY KEY,
  pass_id     UUID NOT NULL REFERENCES guest_passes(id) ON DELETE CASCADE,
  kind        VARCHAR(30) NOT NULL CHECK (kind IN (
                'issued',        -- se emitió
                'shared',        -- el titular lo mandó por WhatsApp
                'viewed',        -- alguien abrió el enlace y vio el QR
                'scanned',       -- se escaneó, todavía sin decidir
                'admitted',      -- entró: aquí se gastó
                'denied',        -- se escaneó y no abrió, con motivo
                'revoked',       -- lo mató el titular o la puerta
                'reassigned'     -- se cambió de invitado
              )),
  -- El motivo en palabras cuando lo hay: "already_used", "minor", "no_id_check",
  -- "el invitado ya no viene". Es lo que se lee en el reporte de la noche.
  reason      VARCHAR(200),
  -- Quién. Nulo cuando fue el invitado con el enlace, que no tiene cuenta.
  actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  id_check_id UUID REFERENCES door_id_checks(id) ON DELETE SET NULL,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS guest_pass_events_pass_idx
  ON guest_pass_events (pass_id, created_at DESC);
CREATE INDEX IF NOT EXISTS guest_pass_events_kind_idx
  ON guest_pass_events (kind, created_at DESC);

CREATE OR REPLACE FUNCTION guest_pass_events_are_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'guest_pass_events is insert-only: an access log you can edit is not a log';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS guest_pass_events_no_update ON guest_pass_events;
CREATE TRIGGER guest_pass_events_no_update
  BEFORE UPDATE OR DELETE ON guest_pass_events
  FOR EACH ROW EXECUTE FUNCTION guest_pass_events_are_immutable();

-- ---------------------------------------------------------------------------
-- 4. Los pases de las reservaciones que ya existen
--
-- Cada reservación viva se queda con su pase de titular —el mismo código, para
-- que un QR ya repartido siga abriendo— y con un pase por cada lugar restante.
-- Una reservación de 8 personas termina con 1 titular y 7 invitados.
--
-- El código de los invitados se arma con el mismo alfabeto sin 0/O ni 1/I/L que
-- usa `door.generatePassCode`, porque se dicta en voz alta en una puerta con
-- música. `random()` alcanza aquí y no en el servidor: esto corre una sola vez,
-- sobre las reservaciones que ya están, y cada código se comprueba contra el
-- índice único; los pases nuevos los firma el servidor con crypto.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r          RECORD;
  i          INTEGER;
  nuevo      TEXT;
  intentos   INTEGER;
BEGIN
  -- Si ya hay pases, esta migración ya corrió: no duplicar.
  IF EXISTS (SELECT 1 FROM guest_passes LIMIT 1) THEN
    RETURN;
  END IF;

  FOR r IN
    SELECT id, nightclub_id, user_id, pass_code, guest_count, status, checked_in_at
      FROM reservations
     WHERE pass_code IS NOT NULL
       AND status IN ('pending_payment', 'confirmed', 'seated')
  LOOP
    -- El titular conserva su código. Si la reservación ya entró, su pase nace
    -- gastado: no se puede volver a usar lo que ya se usó.
    INSERT INTO guest_passes (nightclub_id, reservation_id, code, kind, status,
                              used_at, created_by)
    VALUES (r.nightclub_id, r.id, r.pass_code, 'holder',
            CASE WHEN r.status = 'seated' THEN 'used' ELSE 'active' END,
            CASE WHEN r.status = 'seated' THEN COALESCE(r.checked_in_at, now()) END,
            r.user_id)
    ON CONFLICT (code) DO NOTHING;

    FOR i IN 2..GREATEST(r.guest_count, 1) LOOP
      intentos := 0;
      LOOP
        nuevo := 'EV2-' || (
          SELECT string_agg(substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ',
                                   (floor(random() * 31) + 1)::int, 1), '')
            FROM generate_series(1, 4)
        ) || '-' || (
          SELECT string_agg(substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ',
                                   (floor(random() * 31) + 1)::int, 1), '')
            FROM generate_series(1, 4)
        );
        EXIT WHEN NOT EXISTS (SELECT 1 FROM guest_passes WHERE code = nuevo)
              AND NOT EXISTS (SELECT 1 FROM reservations WHERE pass_code = nuevo);
        intentos := intentos + 1;
        IF intentos > 20 THEN
          RAISE EXCEPTION 'no se pudo generar un código de pase único';
        END IF;
      END LOOP;

      INSERT INTO guest_passes (nightclub_id, reservation_id, code, kind, created_by)
      VALUES (r.nightclub_id, r.id, nuevo, 'guest', r.user_id);
    END LOOP;
  END LOOP;
END $$;

-- Y la auditoría de esos pases dice la verdad: los emitió la migración, no una
-- persona. Inventar un `actor_id` aquí sería la primera mentira del registro.
INSERT INTO guest_pass_events (pass_id, kind, reason, metadata)
SELECT id, 'issued', 'migration_019', jsonb_build_object('kind', kind)
  FROM guest_passes;
