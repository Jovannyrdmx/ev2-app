-- ============================================================================
-- Migration 021: entrar con una cuenta de otro (Facebook, y lo que venga).
--
-- Hasta ahora la unica manera de entrar era correo y contrasena. Esto agrega la
-- estructura para las cuentas sociales, y esta escrita para CUALQUIER proveedor
-- -- no solo para Facebook -- porque la lista va a cambiar y no queremos una
-- migracion por cada uno.
--
-- ---------------------------------------------------------------------------
-- Lo que hay que saber de Instagram antes de leer el resto
-- ---------------------------------------------------------------------------
-- "Iniciar sesion con Instagram" YA NO EXISTE para cuentas personales. La
-- Instagram Basic Display API se apago el 4 de diciembre de 2024, y sus dos
-- sucesores (Instagram API with Instagram Login, e Instagram Graph API) solo
-- funcionan con cuentas Business o Creator, y ninguno entrega el correo.
--
-- O sea: un cliente del club con su Instagram normal NO puede entrar con
-- Instagram, y no hay nada que programar que lo arregle. El proveedor queda
-- declarado en `src/config/oauth.js` con ese motivo escrito, apagado, para que
-- nadie vuelva a pedirlo sin enterarse de por que no esta -- y para que el dia
-- que Meta lo reabra, se encienda con credenciales y sin tocar codigo.
--
-- La misma estructura acepta Google y Apple, que si hacen login de consumidor
-- con correo verificado, con solo agregar sus credenciales.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Una cuenta puede no tener contrasena
--
-- Quien se registra con Facebook nunca elige una. Antes esta columna era NOT
-- NULL, asi que la alternativa habria sido inventarle una contrasena aleatoria
-- que nadie conoce -- un hash que parece una credencial y no lo es, y que
-- cualquiera que lea la tabla despues va a interpretar mal.
--
-- NULL dice la verdad: esta cuenta no entra por contrasena. `routes/auth.js` lo
-- trata como "no tiene", no como "cualquier contrasena sirve", y se lo explica a
-- la persona en vez de decirle que su contrasena es incorrecta.
-- ---------------------------------------------------------------------------
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

COMMENT ON COLUMN users.password_hash IS
  'NULL = esta cuenta no entra por contrasena, solo por una cuenta social (migracion 021).';

-- ---------------------------------------------------------------------------
-- 2. Las cuentas sociales ligadas
--
-- Una fila por (persona, proveedor). NO se guarda el token de acceso del
-- proveedor: se usa una vez para leer el perfil y se descarta. Guardarlo seria
-- guardar una llave del Facebook del cliente para siempre, cuando el sistema no
-- necesita volver a entrar ahi nunca -- y una fuga de esta base pasaria de ser
-- un problema del club a ser un problema en la cuenta personal de cada cliente.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_identities (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         VARCHAR(20) NOT NULL
                   CHECK (provider IN ('facebook', 'instagram', 'google', 'apple')),
  -- El id que el proveedor le da a esa persona. Es lo unico estable: el correo
  -- y el nombre cambian, este no.
  provider_user_id VARCHAR(255) NOT NULL,
  -- El correo que dijo el proveedor, para poder explicarle a la persona con que
  -- cuenta entro. Puede ser NULL: Instagram nunca lo da, y en Facebook el
  -- cliente puede negar ese permiso.
  email            VARCHAR(255),
  display_name     VARCHAR(150),
  linked_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at    TIMESTAMPTZ,

  -- Una cuenta de Facebook entra a UNA persona. Sin esto, dos cuentas del club
  -- podrian quedar ligadas al mismo Facebook y la segunda se robaria la sesion
  -- de la primera.
  CONSTRAINT user_identities_provider_account_unique UNIQUE (provider, provider_user_id),
  -- Y una persona liga UNA cuenta por proveedor. Dos Facebooks en la misma
  -- cuenta del club no aportan nada y vuelven ambigua la desvinculacion.
  CONSTRAINT user_identities_one_per_provider UNIQUE (user_id, provider)
);

CREATE INDEX IF NOT EXISTS user_identities_user_idx ON user_identities (user_id);

COMMENT ON TABLE user_identities IS
  'Cuentas sociales ligadas. No guarda el token del proveedor: se usa una vez y se descarta.';

-- ---------------------------------------------------------------------------
-- 3. El `state` del viaje de ida
--
-- Es la proteccion contra CSRF del flujo de OAuth: se genera al empezar, viaja
-- a Facebook y vuelve, y solo se acepta si es uno que nosotros emitimos.
--
-- Esta en una TABLA y no firmado en una cookie por una razon concreta: tiene que
-- ser de UN SOLO USO. Un state firmado se puede reproducir tantas veces como
-- quepa en su vigencia, y cada reproduccion es otro intento de canjear el mismo
-- codigo. Aqui se borra al usarlo, asi que el segundo intento no encuentra nada.
--
-- Lleva el club porque el enlace de Facebook vuelve a UNA sola direccion de
-- retorno para todo el sistema, y sin esto el servidor no sabria a que club
-- pertenece la persona que acaba de entrar.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oauth_states (
  state        VARCHAR(64) PRIMARY KEY,
  nightclub_id UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  provider     VARCHAR(20) NOT NULL,
  -- A donde mandar a la persona cuando ya entro. Se valida contra una lista
  -- blanca en el servidor: un destino libre convierte esto en un salto abierto.
  redirect_to  VARCHAR(200),
  -- Para ligar una cuenta social a una sesion que YA existe, en vez de entrar.
  link_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oauth_states_created_idx ON oauth_states (created_at);

COMMENT ON TABLE oauth_states IS
  'El state de OAuth, de un solo uso: se borra al canjearlo. Los viejos se barren al emitir uno nuevo.';

-- ---------------------------------------------------------------------------
-- 4. El pase de mano para la sesion
--
-- Cuando el viaje termina bien, el servidor tiene que entregarle la sesion a una
-- PAGINA, no a un programa: la persona viene rebotada de Facebook con un 302.
--
-- La manera comoda seria mandar los tokens en el fragmento de la direccion
-- (`#access_token=...`). No se hace: el fragmento no viaja al servidor, pero SI
-- se queda en el historial del navegador, y en un telefono prestado o compartido
-- eso es la sesion del cliente al alcance del siguiente que lo use.
--
-- En su lugar viaja este pase: 32 bytes al azar, de UN SOLO USO -- se borra al
-- canjearlo -- y valido dos minutos. Lo que queda en el historial es un pase ya
-- gastado que no abre nada.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oauth_handoffs (
  token      VARCHAR(64) PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oauth_handoffs_created_idx ON oauth_handoffs (created_at);

COMMENT ON TABLE oauth_handoffs IS
  'Pase de un solo uso para entregarle la sesion a la pagina tras volver del proveedor. Vive 2 minutos.';
