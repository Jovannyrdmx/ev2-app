#!/usr/bin/env bash
#
# EV2 Clandestinoz — instalación completa en un VPS, de principio a fin.
#
# Se corre UNA vez, desde la raíz del repositorio ya clonado:
#
#     bash deploy/instalar-vps.sh
#
# Hace preguntas, y después: instala Docker si falta, cierra el cortafuegos, genera los
# secretos, levanta todo con HTTPS, crea el club y tu cuenta de gerente, y carga las
# mesas y los precios. Al final imprime lo único que tienes que anotar.
#
# Es seguro volverlo a correr: si algo ya existe, lo respeta y lo dice.
set -euo pipefail

# ------------------------------------------------------------------ presentación

rojo()  { printf '\033[31m%s\033[0m\n' "$*"; }
verde() { printf '\033[32m%s\033[0m\n' "$*"; }
gris()  { printf '\033[90m%s\033[0m\n' "$*"; }
titulo() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

morir() { rojo ""; rojo "DETENIDO: $*"; rojo ""; exit 1; }

COMPOSE="docker compose --env-file .env -f deploy/docker-compose.prod.yml"

# ------------------------------------------------------------------ comprobaciones

[[ -f deploy/docker-compose.prod.yml ]] || morir \
  "Córrelo desde la raíz del repositorio (ahí donde está la carpeta 'deploy'), así:
    bash deploy/instalar-vps.sh"

[[ $EUID -eq 0 ]] || sudo -n true 2>/dev/null || gris \
  "Aviso: no eres root. Si algo falla por permisos, vuelve a correrlo con sudo."

titulo "EV2 Clandestinoz — instalación en el servidor"
cat <<'FIN'
Te voy a hacer seis preguntas y después hago todo lo demás solo.
Tarda unos minutos, casi todo construyendo las imágenes.
FIN

# ------------------------------------------------------------------ preguntas

preguntar() {                      # preguntar <variable> <texto> [valor por omisión]
  local __var=$1 __texto=$2 __def=${3:-} __resp=""
  while [[ -z "$__resp" ]]; do
    if [[ -n "$__def" ]]; then
      read -r -p "$__texto [$__def]: " __resp || true
      __resp=${__resp:-$__def}
    else
      read -r -p "$__texto: " __resp || true
    fi
    [[ -z "$__resp" ]] && rojo "  Ese dato hace falta."
  done
  printf -v "$__var" '%s' "$__resp"
}

titulo "1 de 2 — el servidor"
preguntar DOMINIO "Tu dominio, sin https:// (ej. clandestinoz.com)"
preguntar CORREO  "Tu correo (Let's Encrypt avisa ahí si el certificado falla)"

titulo "2 de 2 — tu cuenta de gerente"
preguntar GER_NOMBRE "Tu nombre y apellido"
preguntar GER_CORREO "Tu correo para entrar al sistema" "$CORREO"
preguntar GER_NACIM  "Tu fecha de nacimiento (AAAA-MM-DD)"
preguntar CLUB       "Nombre del club" "EV2 Clandestinoz"

[[ "$GER_NACIM" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || morir \
  "La fecha va como AAAA-MM-DD. Ejemplo: 1985-04-23"

titulo "¿Abierto o cerrado mientras pruebas?"
cat <<'FIN'
Si vas a probar antes del estreno, conviene que solo TÚ puedas llegar. Se cierra
con el cortafuegos: el puerto 443 queda abierto únicamente para tu IP.

  - Es la forma que SÍ funciona con esta app. Una contraseña de puerta en el
    servidor web (basic auth) NO sirve aquí: usa la misma cabecera Authorization
    que la app usa para su token de sesión, y rompe todas las llamadas con sesión.
  - El puerto 80 se queda abierto: Let's Encrypt lo necesita para el certificado.
  - Desde el celular funciona si está en el mismo WiFi que tu computadora
    (misma IP pública). Con datos móviles no: esa es otra IP.
FIN
CERRAR=""
read -r -p "¿Cerrar el sitio a tu IP mientras pruebas? (S/n): " CERRAR || true
MI_IP_PUBLICA=""
if [[ ! "${CERRAR:-s}" =~ ^[nN]$ ]]; then
  gris "  Dime desde qué IP vas a probar. Si no la sabes, abre ifconfig.me en tu"
  gris "  navegador (en tu computadora, NO en el servidor) y copia lo que salga."
  preguntar MI_IP_PUBLICA "Tu IP pública"
fi

# ------------------------------------------------------------------ el DNS manda

titulo "Comprobando el dominio"
# Sin esto no hay certificado, y cada intento fallido cuenta contra el límite de
# Let's Encrypt. Es la razón número uno por la que un despliegue se atora.
command -v dig >/dev/null || {
  gris "Instalando dnsutils…"
  (apt-get update -qq && apt-get install -y -qq dnsutils) >/dev/null 2>&1 || true
}

MI_IP=$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
DNS_IP=$(dig +short "$DOMINIO" A 2>/dev/null | tail -1)

gris "  IP de este servidor: ${MI_IP:-desconocida}"
gris "  A dónde apunta $DOMINIO: ${DNS_IP:-(a ningún lado todavía)}"

if [[ -z "$DNS_IP" ]]; then
  morir "$DOMINIO no apunta a ningún lado.
En Hostinger: tu dominio -> Zona DNS -> registro A, nombre @, valor $MI_IP.
Espera unos minutos y vuelve a correr este script."
elif [[ "$DNS_IP" != "$MI_IP" ]]; then
  rojo "  El dominio apunta a $DNS_IP, no a este servidor ($MI_IP)."
  read -r -p "  ¿Sigo de todos modos? Puede fallar el certificado (s/N): " SEGUIR || true
  [[ "${SEGUIR:-n}" =~ ^[sSyY]$ ]] || morir "Arregla el DNS y vuelve a correrlo."
else
  verde "  El dominio ya apunta aquí."
fi

# ------------------------------------------------------------------ Docker

titulo "Docker"
if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  verde "  Ya estaba instalado."
else
  gris "  Instalando…"
  curl -fsSL https://get.docker.com | sh >/dev/null
  verde "  Listo."
fi

# ------------------------------------------------------------------ cortafuegos

titulo "Cortafuegos"
if command -v ufw >/dev/null || apt-get install -y -qq ufw >/dev/null 2>&1; then
  ufw allow OpenSSH >/dev/null 2>&1 || true
  ufw allow 80/tcp  >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  yes | ufw enable >/dev/null 2>&1 || true
  verde "  Abiertos SSH, 80 y 443. La base de datos y Redis NO se exponen."
else
  gris "  No se pudo configurar ufw; sigo. Revísalo después."
fi

# ------------------------------------------------------------------ el .env

titulo "Secretos"
# Un .env vacio o a medias es peor que ninguno: compose falla con nueve lineas de
# "required variable is missing" y no dice que el archivo esta incompleto. Por eso
# aqui no basta con que exista; tiene que traer TODO lo que hace falta.
FALTANTES=""
if [[ -s .env ]]; then
  # shellcheck disable=SC1091
  set -a; . ./.env; set +a
  for V in DB_PASSWORD JWT_SECRET BANK_ENCRYPTION_KEY EV2_DOMAIN ACME_EMAIL ALLOWED_ORIGINS; do
    [[ -n "${!V:-}" ]] || FALTANTES="$FALTANTES $V"
  done
fi

if [[ -s .env && -z "$FALTANTES" ]]; then
  gris "  Ya existe un .env completo; no lo toco."
  BANK_KEY="${BANK_ENCRYPTION_KEY:-}"
elif [[ -e .env ]]; then
  if [[ -s .env ]]; then
    rojo "  El .env que hay esta incompleto. Le falta:$FALTANTES"
  else
    rojo "  El .env que hay esta VACIO."
  fi
  read -r -p "  ¿Lo reemplazo por uno nuevo? El viejo se guarda como .env.viejo (S/n): " REHACER || true
  [[ "${REHACER:-s}" =~ ^[nN]$ ]] && morir \
    "Completa esas variables a mano en .env y vuelve a correr el script."
  mv .env ".env.viejo.$(date +%s)"
  ESCRIBIR_ENV=true
else
  ESCRIBIR_ENV=true
fi

if [[ "${ESCRIBIR_ENV:-false}" == true ]]; then
  BANK_KEY=$(openssl rand -base64 48 | tr -d '/+=')
  cat > .env <<FIN
ENVIRONMENT=production
DB_USER=postgres
DB_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=')
DB_NAME=ev2
JWT_SECRET=$(openssl rand -base64 48 | tr -d '/+=')
BANK_ENCRYPTION_KEY=$BANK_KEY
EV2_DOMAIN=$DOMINIO
ACME_EMAIL=$CORREO
ALLOWED_ORIGINS=https://$DOMINIO
LOG_LEVEL=info
FIN
  chmod 600 .env
  verde "  Generados. Nadie los tecleó, así que nadie los puede equivocar."
fi

# Ultima red: si por lo que sea algo quedo vacio, se dice AQUI y no en nueve lineas
# de error de compose diez segundos despues.
set -a; . ./.env; set +a
for V in DB_PASSWORD JWT_SECRET BANK_ENCRYPTION_KEY EV2_DOMAIN ACME_EMAIL ALLOWED_ORIGINS; do
  [[ -n "${!V:-}" ]] || morir "El .env quedo sin $V. Borralo (rm .env) y vuelve a correr el script."
done

# ------------------------------------------------------------------ candado

if [[ -n "$MI_IP_PUBLICA" ]]; then
  titulo "Cerrando el sitio a tu IP"
  # Se cierra con el cortafuegos y NO con una contraseña en el servidor web: basic
  # auth usa la cabecera Authorization, la misma que la app usa para su token, y
  # dejaria la aplicacion inservible aunque el candado "funcionara".
  ufw delete allow 443/tcp >/dev/null 2>&1 || true
  ufw allow from "$MI_IP_PUBLICA" to any port 443 proto tcp >/dev/null 2>&1 || true
  verde "  Solo $MI_IP_PUBLICA puede abrir https://$DOMINIO"
  gris  "  Para abrirlo a todos: ufw allow 443/tcp && ufw delete allow from $MI_IP_PUBLICA to any port 443 proto tcp"
fi

# ------------------------------------------------------------------ levantar

titulo "Levantando (esto tarda unos minutos)"
$COMPOSE up -d --build

gris "  Esperando a que la API responda…"
LISTA=false
for _ in $(seq 1 60); do
  if $COMPOSE exec -T api wget -q -O- http://127.0.0.1:3000/health >/dev/null 2>&1; then
    LISTA=true; break
  fi
  sleep 5
done
$LISTA || morir "La API no levantó. Mira qué dice:
    $COMPOSE logs --tail=40 api"
verde "  Todo arriba."

# ------------------------------------------------------------------ club y gerente

titulo "Tu cuenta de gerente"
SALIDA=$($COMPOSE exec -T \
  -e CLUB_NAME="$CLUB" \
  -e CLUB_SLUG=ev2 \
  -e MANAGER_EMAIL="$GER_CORREO" \
  -e MANAGER_NAME="$GER_NOMBRE" \
  -e MANAGER_BIRTH_DATE="$GER_NACIM" \
  api npm run bootstrap 2>&1 || true)

# La contraseña temporal viaja UNA vez, en esa salida. Si se pierde aquí, hay que
# reiniciarla desde la base: se rescata ahora o no se rescata.
TEMPORAL=$(printf '%s' "$SALIDA" | tr -d '\r' | grep -oE '^[[:space:]]+[a-z]+-[a-z]+-[a-z]+-[0-9]{4}$' | tr -d ' ' | head -1)

if printf '%s' "$SALIDA" | grep -q "ya tiene"; then
  gris "  Ya había un gerente; no se creó otro. Entra con el que ya tienes."
elif [[ -z "$TEMPORAL" ]]; then
  rojo "  No se pudo crear el gerente. Esto dijo:"
  printf '%s\n' "$SALIDA" | tail -12
  morir "Arregla eso y vuelve a correr el script."
else
  verde "  Creada."
fi

titulo "Mesas, precios y carta del club"
if $COMPOSE exec -T api npm run seed:floor >/dev/null 2>&1; then
  verde "  Mesas cargadas."
else
  gris "  Las mesas no se cargaron. Después: $COMPOSE exec api npm run seed:floor"
fi
if $COMPOSE exec -T api npm run seed:prices >/dev/null 2>&1; then
  verde "  Precios cargados."
else
  gris "  Los precios NO se cargaron, y sin ellos la reservación sale vacía."
  gris "  Después: $COMPOSE exec api npm run seed:prices"
fi
if $COMPOSE exec -T api npm run seed:menu >/dev/null 2>&1; then
  verde "  Carta cargada (los productos y precios de tu caja)."
else
  gris "  La carta NO se cargó, y sin ella el cliente abre el menú vacío."
  gris "  Después: $COMPOSE exec api npm run seed:menu"
fi

# ------------------------------------------------------------------ resumen

cat <<FIN

$(printf '\033[1;32m')================== LISTO ==================$(printf '\033[0m')

  Entra a:   https://$DOMINIO

  Entras con:
       correo:     $GER_CORREO
       contraseña: ${TEMPORAL:-(la que ya tenías)}
     Te va a pedir cambiarla. Hazlo.
${MI_IP_PUBLICA:+
  El sitio está CERRADO: solo abre desde $MI_IP_PUBLICA.
  Desde el celular funciona si está en el mismo WiFi.}

$(printf '\033[1;33m')ANOTA ESTO EN TU GESTOR DE CONTRASEÑAS, AHORA:$(printf '\033[0m')

  BANK_ENCRYPTION_KEY=$BANK_KEY

  Es la llave que cifra las cuentas bancarias de tu personal. Si se cambia
  después de que alguien registre la suya, esas cuentas quedan ilegibles
  para siempre. Guárdala fuera del servidor.

  ---------------------------------------------------------------------

  Ya adentro:
    · Pestaña "Personal" — da de alta a tu gente. Cada contraseña temporal
      se muestra UNA vez: anótala.
    · Pestaña "Noches"   — abre la primera noche y PUBLÍCALA. En borrador
      nadie puede reservar; publicar es un segundo toque a propósito.

  El día del estreno, para abrirlo a todo el mundo:
      ufw allow 443/tcp${MI_IP_PUBLICA:+ && ufw delete allow from $MI_IP_PUBLICA to any port 443 proto tcp}

  Si algo se ve raro:
      $COMPOSE logs --tail=40

FIN
