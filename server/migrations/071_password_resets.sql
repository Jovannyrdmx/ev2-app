-- ============================================================================
-- Migration 071: "Olvidé mi contraseña" por correo (D127).
--
-- Hasta aquí la única forma de recuperar una contraseña era que el gerente generara una
-- temporal desde Empleados (D46), y eso solo sirve para el personal: un cliente que
-- olvidó la suya no tenía a quién pedírsela. Ahora cualquier cuenta con correo —cliente,
-- personal o gerente— pide un enlace desde la pantalla de acceso y lo recibe por correo.
--
-- Lo que se guarda NO es el enlace sino su huella (SHA-256): quien lea la base, un
-- respaldo o un log no puede restablecer contraseñas con lo que ve aquí, igual que con
-- los refresh tokens. El enlace vale 30 minutos y se gasta al usarse; al pedir uno nuevo
-- los anteriores quedan anulados para que solo sirva el último correo que llegó.
-- ============================================================================

CREATE TABLE IF NOT EXISTS password_resets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- SHA-256 hex del token que viaja en el enlace. Único: dos enlaces iguales no existen.
  token_hash    CHAR(64) NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  -- Cuándo se gastó (cambió la contraseña) o se anuló (pidió otro). NULL = vigente.
  used_at       TIMESTAMPTZ,
  -- Desde dónde se pidió, para la bitácora de seguridad.
  requested_ip  INET,
  requested_ua  VARCHAR(300)
);

-- Lo que se consulta: "¿esta persona tiene enlaces vigentes?" (para anularlos y para el
-- freno de un correo por minuto).
CREATE INDEX IF NOT EXISTS password_resets_user_open_idx
  ON password_resets (user_id, created_at DESC) WHERE used_at IS NULL;
