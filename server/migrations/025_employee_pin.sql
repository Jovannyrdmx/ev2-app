-- ============================================================================
-- Migration 025: el personal entra con un PIN de 6 digitos.
--
-- Decision del dueno (D46): el piso deja de entrar con correo y contrasena. Un
-- mesero con las manos ocupadas a las once de la noche teclea seis digitos, y no
-- una contrasena que iba a acabar apuntada en un papel pegado a la barra.
--
-- ---------------------------------------------------------------------------
-- El PIN es UNICO EN EL CLUB, y eso decide todo lo demas
-- ---------------------------------------------------------------------------
-- El dueno escogio que se entre **solo con el PIN**, sin numero de empleado ni
-- lista de nombres. Eso obliga a que dos personas no puedan tener el mismo PIN
-- --si no, el servidor no sabria a quien dejar entrar-- y tiene una consecuencia
-- que hay que mirar de frente:
--
--   6 digitos son 1,000,000 de combinaciones. Con 40 empleados, cada intento a
--   ciegas le atina a ALGUIEN con probabilidad 1 en 25,000. No se ataca una
--   cuenta: se ataca el espacio entero. Por eso `pin_attempts` cuenta los fallos
--   POR CLUB y no por usuario -- bloquear "la cuenta atacada" no sirve cuando no
--   se sabe cual es, y limitar por IP tampoco alcanza si el atacante trae diez.
--
-- ---------------------------------------------------------------------------
-- Por que DOS columnas para un solo PIN
-- ---------------------------------------------------------------------------
-- `pin_hash` (bcrypt) es lo que verifica. Pero bcrypt lleva sal, asi que el mismo
-- PIN da un hash distinto cada vez y NO se puede buscar por el. Sin algo mas, la
-- unica forma de saber de quien es un PIN seria comparar contra los 40 empleados:
-- 40 operaciones de bcrypt por intento (dos segundos) y un amplificador de ataque
-- de regalo.
--
-- `pin_lookup` es un HMAC-SHA256 del PIN con una llave del servidor
-- (`PIN_LOOKUP_KEY`, en el `.env`, NUNCA en la base). Es determinista, asi que se
-- indexa y se busca de un golpe, y es lo que hace cumplir la unicidad. La llave
-- separada es la parte importante: con la base robada pero sin el `.env`, no se
-- pueden recorrer el millon de combinaciones para armar la tabla inversa.
--
-- ---------------------------------------------------------------------------
-- Lo que esta migracion NO hace
-- ---------------------------------------------------------------------------
-- No borra `password_hash` de nadie. La gerencia sigue entrando con correo y
-- contrasena desde fuera del club (decision del dueno), y un empleado al que se le
-- quite el PIN tiene que poder volver a una contrasena sin migrar nada. Lo que
-- cambia es por donde entra el piso, no lo que la base es capaz de guardar.
-- ============================================================================

BEGIN;

ALTER TABLE users
  -- bcrypt del PIN: lo que se compara al entrar.
  ADD COLUMN IF NOT EXISTS pin_hash        TEXT,
  -- HMAC del PIN con la llave del servidor: lo que permite BUSCARLO y lo que hace
  -- cumplir que no se repita dentro del club.
  ADD COLUMN IF NOT EXISTS pin_lookup      TEXT,
  ADD COLUMN IF NOT EXISTS pin_set_at      TIMESTAMPTZ,
  -- El PIN que entrega el administrador al dar de alta es de UN SOLO USO: sirve
  -- para entrar una vez y el sistema obliga a cambiarlo ahi mismo. Mientras esto
  -- sea true, la sesion no puede hacer nada mas que cambiarlo.
  ADD COLUMN IF NOT EXISTS must_change_pin BOOLEAN NOT NULL DEFAULT false,
  -- Quien lo genero y cuando. Un PIN que alguien regenero tres veces en una semana
  -- es una conversacion que hay que tener, y sin esto no queda rastro.
  ADD COLUMN IF NOT EXISTS pin_issued_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pin_issued_at   TIMESTAMPTZ;

-- El PIN no se repite dentro del club. Parcial: los usuarios sin PIN --los
-- clientes, que son la mayoria-- no ocupan lugar en el indice.
CREATE UNIQUE INDEX IF NOT EXISTS users_pin_unique
  ON users (nightclub_id, pin_lookup) WHERE pin_lookup IS NOT NULL;

-- La busqueda de cada intento de acceso. Sin esto, cada PIN tecleado recorreria la
-- tabla de usuarios entera.
CREATE INDEX IF NOT EXISTS users_pin_lookup_idx
  ON users (pin_lookup) WHERE pin_lookup IS NOT NULL;

-- Un PIN a medias no existe: o estan las dos columnas o no esta ninguna.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_pin_is_whole;
ALTER TABLE users ADD CONSTRAINT users_pin_is_whole
  CHECK ((pin_hash IS NULL AND pin_lookup IS NULL)
      OR (pin_hash IS NOT NULL AND pin_lookup IS NOT NULL));

-- ---------------------------------------------------------------------------
-- Los intentos fallidos, contados POR CLUB
-- ---------------------------------------------------------------------------
-- Esta tabla es la unica defensa real del PIN solo, asi que vale la pena decir
-- que hace y que NO hace.
--
-- Cuenta fallos por club en una ventana de tiempo. Pasado cierto numero, cada
-- intento empieza a TARDAR mas -- no se cierra la puerta. Cerrarla seria dejar al
-- personal entero sin entrar a las once de un sabado, que es peor que el riesgo
-- que evita, y ademas le regala al atacante una forma de apagar el club tecleando
-- PINs equivocados a proposito.
--
-- Frenar de 14,400 intentos diarios a menos de 1,000 baja la probabilidad de que
-- alguien entre de ~44% al dia a ~3%, y sigue bajando mientras el ataque siga.
CREATE TABLE IF NOT EXISTS pin_attempts (
  id           BIGSERIAL PRIMARY KEY,
  nightclub_id UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  -- La IP de donde vino. Sirve para el limite por IP y para que el gerente pueda
  -- ver si los fallos vienen todos del mismo lado.
  ip           INET,
  -- Si acerto o no. Los aciertos tambien se guardan: sin ellos no se puede
  -- distinguir "cuarenta fallos porque hay un ataque" de "cuarenta fallos porque
  -- el teclado de la tableta esta pegajoso y todo el mundo se equivoca".
  ok           BOOLEAN NOT NULL,
  -- El usuario, SOLO cuando acerto. En un fallo no se sabe de quien era el intento
  -- --ese es justo el punto del PIN sin nombre-- y guardar un usuario adivinado
  -- seria inventar un dato.
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- La consulta de cada intento: "cuantos fallos lleva este club en los ultimos N
-- minutos". Es lo unico que se pregunta en el camino caliente.
CREATE INDEX IF NOT EXISTS pin_attempts_club_recent_idx
  ON pin_attempts (nightclub_id, created_at DESC) WHERE NOT ok;
CREATE INDEX IF NOT EXISTS pin_attempts_ip_recent_idx
  ON pin_attempts (ip, created_at DESC) WHERE NOT ok;

COMMIT;
