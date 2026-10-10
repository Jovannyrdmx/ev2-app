-- ============================================================================
-- Migration 034: dar de alta una PC sin copiar un token (D56).
--
-- Hasta hoy, poner a imprimir una PC de barra era: crearla en el panel, copiar un
-- token de 48 caracteres hexadecimales, llevarlo a la otra máquina —por WhatsApp, por
-- un papel, por donde sea— y pegarlo en un archivo de configuración a mano. Cuatro
-- oportunidades de equivocarse y una llave larga paseando por el chat del club.
--
-- Ahora es un **código de emparejamiento**, como el de una tele: el panel muestra
-- `K7M4-2QX9`, alguien lo teclea en la PC, y la PC se configura sola.
--
-- ---------------------------------------------------------------------------
-- Un código corto se puede adivinar. Por eso esta tabla existe
-- ---------------------------------------------------------------------------
-- Ocho caracteres de un alfabeto de 32 son 40 bits: muchísimo para un humano,
-- adivinable para una máquina que pueda probar sin límite. Lo que lo hace seguro NO
-- es el largo, son las tres columnas de abajo:
--
--   * `expires_at` — vive diez minutos. Un código de ayer no sirve.
--   * `used_at`    — de un solo uso. El segundo que llegue con el mismo código, no.
--   * `attempts`   — a los pocos fallos se quema solo. Adivinar deja de ser posible
--                    antes de que valga la pena empezar.
--
-- El código se guarda hasheado, como el token que reemplaza: con la base robada,
-- nadie puede emparejar una PC suya con un club ajeno.
-- ============================================================================

CREATE TABLE IF NOT EXISTS print_agent_invites (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id   UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  -- SHA-256 del código en mayúsculas y sin guiones. La búsqueda es por aquí.
  code_hash      TEXT NOT NULL,
  -- Los últimos caracteres, para que el gerente distinga dos códigos vivos a la vez
  -- sin que el completo vuelva a aparecer nunca.
  code_hint      VARCHAR(8) NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  -- Cuántas veces se intentó con un código equivocado desde que este se emitió. No es
  -- por código: es por club, y se cuenta aquí para poder quemar los vivos de golpe.
  attempts       INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  used_at        TIMESTAMPTZ,
  used_agent_id  UUID REFERENCES print_agents(id) ON DELETE SET NULL,
  -- De dónde se canjeó. Si mañana aparece una PC que nadie dio de alta, esto dice
  -- desde qué dirección se emparejó.
  used_ip        VARCHAR(60),
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Usado sin agente, o agente sin hora, sería un canje a medias que nadie sabría leer.
  CHECK (num_nonnulls(used_at, used_agent_id) IN (0, 2))
);

CREATE UNIQUE INDEX IF NOT EXISTS print_agent_invites_code_idx
  ON print_agent_invites (code_hash);
-- Los que siguen vivos de este club: es la única consulta que se hace en caliente.
CREATE INDEX IF NOT EXISTS print_agent_invites_open_idx
  ON print_agent_invites (nightclub_id, expires_at) WHERE used_at IS NULL;

/*
 * Un código canjeado no se reescribe.
 *
 * Es la constancia de cómo entró esa PC al club. Si se pudiera editar, "quién
 * autorizó esta computadora" dejaría de tener respuesta justo cuando alguien la
 * pregunte en serio.
 */
CREATE OR REPLACE FUNCTION print_agent_invites_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'print_agent_invites: un código canjeado no se borra (id=%)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.used_at IS NOT NULL THEN
    RAISE EXCEPTION 'print_agent_invites: ese código ya se usó (id=%)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.code_hash <> OLD.code_hash OR NEW.nightclub_id <> OLD.nightclub_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'print_agent_invites: el código no se edita (id=%)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS print_agent_invites_immutable ON print_agent_invites;
CREATE TRIGGER print_agent_invites_immutable BEFORE UPDATE OR DELETE ON print_agent_invites
  FOR EACH ROW EXECUTE FUNCTION print_agent_invites_guard();

-- De qué PC vino el agente, tal como él mismo se presentó. Sirve para reconocerla
-- —"ah, es la de la barra de abajo"— sin que nadie teclee un nombre.
ALTER TABLE print_agents
  ADD COLUMN IF NOT EXISTS hostname     VARCHAR(80),
  ADD COLUMN IF NOT EXISTS paired_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paired_by    UUID REFERENCES users(id) ON DELETE SET NULL;
