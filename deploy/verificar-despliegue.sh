#!/usr/bin/env bash
#
# EV2 — comprobar que lo que se acaba de desplegar de verdad está arriba.
#
# ---------------------------------------------------------------------------
# Por qué existe
# ---------------------------------------------------------------------------
# `docker compose up -d --build` termina bien aunque el despliegue haya quedado a
# medias, y eso ya pasó dos veces en este proyecto: una con todos los contenedores
# `healthy` y nginx contestando 502 a todo durante quince horas, y otra con rutas
# nuevas que pasaban las pruebas en local y contestaban 404 en el VPS porque el
# contexto de la imagen no incluía la carpeta del agente.
#
# "Terminó sin error" y "está funcionando" no son lo mismo. Esto pregunta lo segundo.
#
# ---------------------------------------------------------------------------
# Lo que NO hace, a propósito
# ---------------------------------------------------------------------------
# No cobra, no imprime, no crea ni modifica nada, y no toca la caja. Todo lo de aquí
# es de solo lectura y sin sesión: se puede correr con el club abierto.
#
# Tampoco imprime ningún secreto. De las llaves solo dice si están y cuánto miden.
#
# Uso, en el VPS, después de `git pull` y `up -d --build`:
#     bash deploy/verificar-despliegue.sh
set -uo pipefail

DOMINIO="${EV2_DOMAIN:-ev2.systems}"
# `EV2_BASE` existe para poder PROBAR este script contra un servidor de mentiras.
# Sin eso, la única forma de saber si funciona sería estrenarlo en producción.
BASE="${EV2_BASE:-https://${DOMINIO}}"
fallas=0

verde()  { printf '  \033[32mOK   \033[0m %s\n' "$1"; }
rojo()   { printf '  \033[31mFALLA\033[0m %s\n' "$1"; fallas=$((fallas + 1)); }
aviso()  { printf '  \033[33m·    \033[0m %s\n' "$1"; }
titulo() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# Un GET sin sesión. Devuelve solo el código, y 000 si no se pudo ni conectar.
codigo() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$1" 2>/dev/null; }

printf '\n\033[1mEV2 — verificación del despliegue\033[0m\n%s · %s\n' "$DOMINIO" "$(date '+%d/%m/%Y %H:%M:%S')"

# --------------------------------------------------------------- 1. está vivo
titulo '1. El servidor contesta'
salud=$(codigo "${BASE}/api/health")
if [ "$salud" = "200" ]; then
  verde "/api/health responde 200"
else
  rojo "/api/health responde ${salud} (000 = ni se pudo conectar)"
  aviso "Si es 502: nginx le está hablando a la IP vieja de la API. 'docker restart ev2-web'"
  aviso "destraba; el arreglo de raíz (resolver + upstream por variable) es de D60."
fi

# --------------------------------------------------------------- 2. rutas nuevas
#
# Se mira DENTRO del contenedor, no por HTTP.
#
# La primera versión de esto probaba las rutas sin sesión, contando con que una que
# existe contesta 401 y una que no, 404. **Es falso en este servidor**: `authenticate`
# corre antes que los routers, así que una dirección inventada también contesta 401 y
# la comprobación daba verde para rutas que no existían — justo el error que venía a
# cazar. Se comprobó de verdad antes de escribir esto.
#
# Preguntarle al artefacto desplegado qué trae adentro no se presta a eso.
titulo '2. El código nuevo llegó a la imagen'
en_api() { docker exec ev2-api sh -c "$1" 2>/dev/null; }
hay_en_api() {
  local archivo="$1" marca="$2" nombre="$3"
  if [ "$(en_api "grep -c '${marca}' '${archivo}' 2>/dev/null || echo 0")" != "0" ]; then
    verde "$nombre"
  else
    rojo "$nombre — NO está en el contenedor; la imagen quedó vieja"
  fi
}
if ! docker ps --format '{{.Names}}' | grep -q '^ev2-api$'; then
  rojo "el contenedor ev2-api no está corriendo"
else
  hay_en_api /app/src/routes/printing.js  'printing-health' 'D63 · la revisión de impresión'
  hay_en_api /app/src/routes/orders.js    '/reprint'        'D62 · reimprimir la comanda'
  hay_en_api /app/src/services/printing.js 'setAgentArea'   'D61 · cada PC con su barra'
  hay_en_api /app/agent/print-agent.js    'winspool.drv'    'D61 · el agente sin recurso compartido'
  if en_api 'test -f /app/migrations/035_agent_area.sql'; then
    verde 'D61 · la migración 035 viaja en la imagen'
  else
    rojo 'D61 · falta la migración 035 en la imagen'
  fi
fi

# --------------------------------------------------------------- 3. el agente
titulo '3. El agente que bajan las PCs de barra'
agente=$(curl -s --max-time 20 "${BASE}/api/print-agent/files/print-agent.js" 2>/dev/null)
if [ -z "$agente" ]; then
  rojo "no se pudo bajar print-agent.js"
elif printf '%s' "$agente" | grep -q 'winspool.drv'; then
  verde "trae la impresión por winspool (D61): ya no hace falta compartir la impresora"
  if printf '%s' "$agente" | grep -q 'localhost'; then
    rojo "pero TAMBIÉN trae el camino viejo por recurso compartido"
  fi
else
  rojo "es la versión vieja: imprime por recurso compartido y exige que el nombre coincida"
fi

# --------------------------------------------------------------- 4. la pantalla
titulo '4. Lo que ven los navegadores'
# Se compara contra el sw.js del repositorio que acaba de bajar, no solo se enseña.
# "OK, versión ev2-v23" es un verde mentiroso cuando el repositorio ya va en la v27: el
# contenedor web no se reconstruyó y todo el mundo sigue viendo la pantalla anterior.
sw=$(curl -s --max-time 15 "${BASE}/sw.js" 2>/dev/null | grep -o "ev2-v[0-9]*" | head -1)
esperada=$(grep -o "ev2-v[0-9]*" "$(dirname "$0")/../web/sw.js" 2>/dev/null | head -1)
if [ -z "$sw" ]; then
  rojo "no se pudo leer la versión del service worker"
elif [ -z "$esperada" ]; then
  verde "service worker ${sw}"
  aviso "No se pudo leer web/sw.js del repositorio para comparar."
elif [ "$sw" = "$esperada" ]; then
  verde "service worker ${sw}, igual que el repositorio"
  aviso "Si aun así la pantalla sale vieja, es caché del navegador: recargar con Ctrl+F5."
else
  rojo "el servidor sirve ${sw} y el repositorio va en ${esperada}"
  aviso "El contenedor web no se reconstruyó: 'up -d --build' otra vez."
fi

# --------------------------------------------------------------- 5. la base
titulo '5. La base de datos'
psql_ev2() {
  docker exec -i ev2-postgres sh -c \
    'psql -tAq -U "$POSTGRES_USER" -d "$POSTGRES_DB"' 2>/dev/null
}
if ! docker ps --format '{{.Names}}' | grep -q '^ev2-postgres$'; then
  rojo "el contenedor ev2-postgres no está corriendo"
else
  ultima=$(echo 'SELECT max(name) FROM schema_migrations;' | psql_ev2 | tr -d '[:space:]')
  if [ -n "$ultima" ]; then
    verde "última migración aplicada: ${ultima}"
    case "$ultima" in
      035*|03[6-9]*|0[4-9]*) : ;;
      *) rojo "falta la 035 (el área de cada PC). Corre 'docker compose ... up -d' otra vez." ;;
    esac
  else
    rojo "no se pudo leer schema_migrations"
  fi

  # El PIN de la gerencia depende de dos variables que vienen VACÍAS de fábrica, y sin
  # ellas no falla al desplegar: falla la noche que alguien intente usarlo.
  titulo '6. El acceso por PIN (D64)'
  largo_llave=$(docker exec ev2-api sh -c 'printf %s "${PIN_LOOKUP_KEY:-}" | wc -c' 2>/dev/null | tr -d '[:space:]')
  if [ "${largo_llave:-0}" -ge 32 ] 2>/dev/null; then
    verde "PIN_LOOKUP_KEY llegó al contenedor (${largo_llave} caracteres)"
  else
    rojo "PIN_LOOKUP_KEY falta o es corta (${largo_llave:-0} caracteres; necesita 32+)"
    aviso "Sin ella NO se le puede generar el PIN a nadie."
    aviso "openssl rand -hex 32  →  al .env  →  'up -d' (un restart NO relee el .env)"
  fi
  redes=$(docker exec ev2-api sh -c 'printf %s "${CLUB_NETWORKS:-}"' 2>/dev/null)
  if [ -n "$redes" ]; then
    verde "CLUB_NETWORKS configurada: ${redes}"
  else
    rojo "CLUB_NETWORKS vacía: la gerencia no puede entrar con PIN en ningún lado"
    aviso "Lleva la IP PÚBLICA del club. Para saber cuál ve el servidor, intenta una vez"
    aviso "el acceso con PIN desde el club y mira: select ip, ok, at from pin_attempts;"
  fi

  # --------------------------------------------------------------- 7. impresión
  titulo '7. La impresión, según la configuración real del club'
  # Con sustitución y no con una tubería: en bash el lado derecho de un `|` corre en
  # una subshell, así que un `rojo` de ahí adentro sumaría a un contador que se
  # descarta al terminar — y el resumen final diría "todo en orden" con fallas dentro.
  activas=$(echo "SELECT count(*) FROM printers WHERE active;" | psql_ev2 | tr -d '[:space:]')
  if [ "${activas:-0}" = "0" ]; then
    aviso "no hay impresoras activas: el club cobra sin papel (es válido)"
  else
    verde "${activas} impresora(s) activa(s)"
  fi
  pendientes=$(echo "SELECT count(*) FROM print_jobs WHERE status='pending' AND created_at < now() - interval '5 minutes';" \
    | psql_ev2 | tr -d '[:space:]')
  if [ "${pendientes:-0}" = "0" ]; then
    verde "no hay papel atorado esperando"
  else
    rojo "${pendientes} papel(es) esperando hace más de 5 minutos"
    aviso "Alguna PC está apagada o asignada a otra barra. El panel lo dice en Impresoras."
  fi
fi

# --------------------------------------------------------------- resumen
printf '\n'
if [ "$fallas" -eq 0 ]; then
  printf '\033[32m  Todo en orden.\033[0m Falta lo único que no se puede comprobar desde aquí:\n'
  printf '  cobrar un pedido de prueba y ver salir el papel en la barra.\n\n'
else
  printf '\033[31m  %s cosa(s) que revisar, arriba.\033[0m\n\n' "$fallas"
fi
exit 0
