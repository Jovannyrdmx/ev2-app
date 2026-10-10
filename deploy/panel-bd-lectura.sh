#!/usr/bin/env bash
#
# EV2 — crear (o renovar) el usuario de SOLO LECTURA para el panel de la base (D69).
#
# ---------------------------------------------------------------------------
# Por qué existe
# ---------------------------------------------------------------------------
# El panel (Adminer) deja editar y borrar filas con dos clics. Con el usuario
# `postgres` eso incluye la caja, las propinas y el inventario de una noche abierta.
# Para MIRAR las tablas se entra con `ev2_lectura`, que la base misma no deja
# escribir: aunque alguien le dé "Guardar" a una fila, Postgres contesta que la
# transacción es de solo lectura. No depende de que nadie se acuerde de tener cuidado.
#
# Qué puede `ev2_lectura`:
#   - Leer todas las tablas del esquema `public`, incluidas las que agreguen
#     migraciones futuras (privilegios por omisión del dueño de las tablas).
# Qué NO puede:
#   - Insertar, cambiar ni borrar nada; crear tablas; crear usuarios.
#   - Dejar corriendo una consulta pesada con el club abierto: se corta a los 30 s.
#
# Correrlo otra vez es seguro: si el usuario ya existe, solo le pone contraseña nueva
# (sirve para renovarla si alguien la vio).
#
# Uso, en el VPS, desde la carpeta del proyecto:
#     bash deploy/panel-bd-lectura.sh
#
# La contraseña se genera aquí y se muestra UNA vez. No se guarda en ningún archivo.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "No encuentro .env en $(pwd). Corre esto desde la carpeta del proyecto en el servidor." >&2
  exit 1
fi

leer_env() { grep -E "^$1=" .env | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'"; }
DB_USER="$(leer_env DB_USER)"; DB_USER="${DB_USER:-postgres}"
DB_NAME="$(leer_env DB_NAME)"; DB_NAME="${DB_NAME:-ev2}"
ROL="ev2_lectura"

# 24 caracteres sin símbolos raros: se teclea bien en el panel y no rompe la comilla SQL.
CLAVE="$(openssl rand -base64 36 | tr -dc 'A-Za-z0-9' | head -c 24)"
if [ "${#CLAVE}" -lt 24 ]; then
  echo "No se pudo generar la contraseña (¿falta openssl?)." >&2
  exit 1
fi

COMPOSE=(docker compose --env-file .env -f deploy/docker-compose.prod.yml)

# La contraseña viaja por la entrada estándar, no como argumento: así no aparece en
# la lista de procesos del servidor mientras corre.
"${COMPOSE[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -q -U "$DB_USER" -d "$DB_NAME" <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROL}') THEN
    CREATE ROLE ${ROL} LOGIN;
  END IF;
END
\$\$;
ALTER ROLE ${ROL} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD '${CLAVE}';
ALTER ROLE ${ROL} SET default_transaction_read_only = on;
ALTER ROLE ${ROL} SET statement_timeout = '30s';
REVOKE ALL ON DATABASE "${DB_NAME}" FROM ${ROL};
GRANT CONNECT ON DATABASE "${DB_NAME}" TO ${ROL};
GRANT USAGE ON SCHEMA public TO ${ROL};
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${ROL};
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROL};
ALTER DEFAULT PRIVILEGES FOR ROLE "${DB_USER}" IN SCHEMA public GRANT SELECT ON TABLES TO ${ROL};
ALTER DEFAULT PRIVILEGES FOR ROLE "${DB_USER}" IN SCHEMA public GRANT SELECT ON SEQUENCES TO ${ROL};
SQL

cat <<TXT

  Usuario de solo lectura listo.

    Sistema:     PostgreSQL
    Servidor:    postgres
    Usuario:     ${ROL}
    Contraseña:  ${CLAVE}
    Base:        ${DB_NAME}

  Anótala ahora: solo se muestra esta vez. Si la pierdes, vuelve a correr este script
  y genera otra (la anterior deja de servir).

TXT
