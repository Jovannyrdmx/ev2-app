#!/usr/bin/env bash
# ============================================================================
# EV2 — diagnostico del servidor, eslabon por eslabon.
#
# Existe por una razon concreta: cuando la pantalla dice "Sin conexion. Revisa
# tu senal", la aplicacion esta diciendo la verdad y aun asi no ayuda, porque
# entre el navegador y la base de datos hay SIETE saltos y ese mensaje no dice
# cual se rompio:
#
#   navegador -> DNS -> cortafuegos del proveedor -> ufw -> Caddy (TLS)
#             -> nginx del contenedor `web` -> API -> Postgres
#
# Este script recorre los eslabones de adentro hacia afuera y se detiene a
# explicar el primero que falla. Se corre EN EL SERVIDOR:
#
#     bash docs/api/diagnostico-vps.sh
#
# No cambia nada. Solo lee.
# ============================================================================
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 1

COMPOSE="docker compose --env-file .env -f deploy/docker-compose.prod.yml"
FALLOS=0
PRIMER_FALLO=""

verde()  { printf '  \033[32mOK\033[0m    %s\n' "$1"; }
rojo()   { printf '  \033[31mFALLA\033[0m %s\n' "$1"; FALLOS=$((FALLOS+1));
           [ -z "$PRIMER_FALLO" ] && PRIMER_FALLO="$2"; }
aviso()  { printf '  \033[33mAVISO\033[0m %s\n' "$1"; }
titulo() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# El dominio y el origen configurados, que es contra lo que se comprueba todo.
DOMINIO=$(grep -E '^EV2_DOMAIN=' .env 2>/dev/null | cut -d= -f2- | tr -d '"'"'"' \r')
ORIGENES=$(grep -E '^ALLOWED_ORIGINS=' .env 2>/dev/null | cut -d= -f2- | tr -d '"'"'"' \r')
# El usuario y la base salen del .env, no de una suposicion: si el club cambio
# DB_NAME, preguntarle a "ev2" da un falso negativo y manda a buscar donde no es.
DBUSER=$(grep -E '^DB_USER=' .env 2>/dev/null | cut -d= -f2- | tr -d '"'"'"' \r')
DBNAME=$(grep -E '^DB_NAME=' .env 2>/dev/null | cut -d= -f2- | tr -d '"'"'"' \r')
DBUSER=${DBUSER:-postgres}
DBNAME=${DBNAME:-ev2}

titulo "0. La configuracion"
if [ -z "$DOMINIO" ]; then
  rojo "EV2_DOMAIN esta vacio en .env" "Pon EV2_DOMAIN=tudominio.com (sin https://, sin barra final) y vuelve a levantar."
else
  verde "EV2_DOMAIN = $DOMINIO"
fi
if [ -z "$ORIGENES" ]; then
  rojo "ALLOWED_ORIGINS esta vacio" "Pon ALLOWED_ORIGINS=https://$DOMINIO y reinicia la API."
elif ! printf '%s' "$ORIGENES" | grep -q "https://$DOMINIO"; then
  rojo "ALLOWED_ORIGINS no incluye https://$DOMINIO (dice: $ORIGENES)" \
       "Pon ALLOWED_ORIGINS=https://$DOMINIO y corre: $COMPOSE up -d api"
else
  verde "ALLOWED_ORIGINS incluye https://$DOMINIO"
fi
# Dos saltos delante de la API (Caddy y el nginx del contenedor web). Con 1,
# Express se queda con la IP de Caddy y el limite de intentos de acceso se
# comparte entre TODO el mundo: diez contrasenas equivocadas de cualquiera
# dejan al club entero sin poder entrar un minuto.
SALTOS=$(grep -E 'TRUST_PROXY_HOPS' deploy/docker-compose.prod.yml | grep -oE '[0-9]+$' | head -1)
[ "$SALTOS" = "2" ] && verde "TRUST_PROXY_HOPS = 2 (Caddy + nginx)" \
  || aviso "TRUST_PROXY_HOPS = ${SALTOS:-?}; con Caddy + nginx delante deberia ser 2"

titulo "1. Los contenedores"
ESTADO=$($COMPOSE ps --format '{{.Name}} {{.State}}' 2>/dev/null)
if [ -z "$ESTADO" ]; then
  rojo "no hay contenedores corriendo" "Corre: $COMPOSE up -d --build"
else
  for c in ev2-postgres ev2-redis ev2-api ev2-ws ev2-web ev2-caddy; do
    if printf '%s' "$ESTADO" | grep -q "^$c running"; then verde "$c"
    else rojo "$c no esta corriendo" "Mira por que: $COMPOSE logs ${c#ev2-} | tail -40"; fi
  done
fi

titulo "2. La API, desde adentro de su propio contenedor"
# El contenedor es alpine y NO trae curl. wget si.
SALUD=$($COMPOSE exec -T api wget -qO- http://localhost:3000/health 2>/dev/null)
if printf '%s' "$SALUD" | grep -q '"status":"ok"'; then
  verde "responde /health"
else
  rojo "la API no responde en su propio puerto" \
       "Es lo primero que hay que arreglar: $COMPOSE logs api | tail -40"
fi

titulo "3. El nginx del contenedor web reenvia /api"
# Este es el eslabon que nadie mira: si `web` sirve la pagina pero no reenvia
# /api, el login aparece y no hace absolutamente nada.
PROXY=$($COMPOSE exec -T web wget -qO- http://localhost:8080/api/health 2>/dev/null)
if printf '%s' "$PROXY" | grep -q '"status":"ok"'; then
  verde "/api/health pasa por el proxy interno"
else
  rojo "el contenedor web NO reenvia /api a la API" \
       "Revisa que la imagen tenga deploy/nginx-web.conf: $COMPOSE exec web cat /etc/nginx/conf.d/default.conf"
fi

titulo "4. Caddy, con el nombre correcto"
if [ -n "$DOMINIO" ]; then
  # --resolve manda el SNI correcto sin depender del DNS. Sin esto, un
  # `curl https://localhost` falla siempre: Caddy no tiene certificado para
  # "localhost" y el TLS se cae antes de empezar. Ese es el falso negativo que
  # hace perder una tarde.
  CADDY=$(curl -s --max-time 10 --resolve "$DOMINIO:443:127.0.0.1" \
            "https://$DOMINIO/api/health" 2>/dev/null)
  if printf '%s' "$CADDY" | grep -q '"status":"ok"'; then
    verde "https://$DOMINIO/api/health responde desde el propio servidor"
  else
    CODIGO=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
               --resolve "$DOMINIO:443:127.0.0.1" "https://$DOMINIO/" 2>/dev/null)
    rojo "Caddy no entrega /api (codigo $CODIGO)" \
         "Mira si consiguio el certificado: $COMPOSE logs caddy | grep -iE 'certificate|error' | tail -20"
  fi
fi

titulo "5. Quien escucha en los puertos de internet"
ESCUCHA=$(ss -tlnH 2>/dev/null | awk '{print $4}')
for p in 80 443; do
  if printf '%s' "$ESCUCHA" | grep -qE "(:|\*:)$p$"; then verde "el puerto $p esta escuchando"
  else rojo "nadie escucha en el puerto $p" "Caddy no levanto: $COMPOSE logs caddy | tail -30"; fi
done
if command -v ufw >/dev/null 2>&1; then
  ufw status 2>/dev/null | grep -qE '^(80|443)/tcp +ALLOW' \
    && verde "ufw permite 80 y 443" \
    || aviso "revisa 'ufw status': 80 y 443 tienen que estar en ALLOW"
fi

titulo "6. Lo que hace falta para poder entrar"
CUENTAS=$($COMPOSE exec -T postgres psql -U "$DBUSER" -tAc \
  "SELECT count(*) FROM users WHERE role IN ('manager','admin');" \
  "$DBNAME" 2>/dev/null | tr -d ' \r')
if [ "${CUENTAS:-0}" -ge 1 ] 2>/dev/null; then
  verde "hay $CUENTAS cuenta(s) de gerente"
else
  rojo "no hay ninguna cuenta de gerente: ningun login puede funcionar" \
       "Corre npm run bootstrap (seccion 5 de docs/DESPLIEGUE.md)"
fi
INSUMOS=$($COMPOSE exec -T postgres psql -U "$DBUSER" -tAc \
  "SELECT count(*) FROM supplies;" "$DBNAME" 2>/dev/null | tr -d ' \r')
[ "${INSUMOS:-0}" -ge 1 ] 2>/dev/null \
  && verde "el catalogo de insumos esta cargado ($INSUMOS)" \
  || aviso "faltan los insumos: $COMPOSE exec api npm run seed:supplies"

# ---------------------------------------------------------------------------
titulo "Veredicto"
if [ "$FALLOS" -eq 0 ]; then
  cat <<TXT
  Todo lo que vive DENTRO del servidor funciona.

  Si el navegador sigue diciendo "Sin conexion. Revisa tu senal", entonces lo
  que se rompe esta FUERA de esta maquina, y solo quedan dos cosas:

  1. EL CORTAFUEGOS DE TU PROVEEDOR, que no es ufw. Hostinger (y casi todos)
     tienen su propio cortafuegos en el panel, por delante del servidor. Si ahi
     solo estan abiertos SSH y el 80 -- lo normal cuando el sitio corria en
     nginx sin HTTPS -- el 443 se DESCARTA y la conexion se queda esperando sin
     recibir nada. Se ve como "conexion agotada" en el celular y como "sin
     conexion" en la computadora. Compruebalo desde tu casa, NO desde aqui:

         curl -v --connect-timeout 8 https://$DOMINIO/api/health

     Si eso se queda colgado y este script dio todo OK, es el panel: abre el
     443/tcp ahi.

  2. UNA COPIA VIEJA GUARDADA EN TU NAVEGADOR. La app guarda sus paginas para
     abrir sin senal en el club. Si tu computadora ya habia abierto el sitio,
     te esta ENSENANDO ESA COPIA y luego cada llamada real falla -- que es
     exactamente "la pagina del login aparece pero no funciona". Para
     descartarlo, en tu navegador: F12 -> Aplicacion -> Service workers ->
     "Anular registro", y F12 -> Aplicacion -> Almacenamiento -> "Borrar datos
     del sitio". O abrelo en una ventana de incognito, que no usa esa copia.
TXT
else
  printf '  %s eslabon(es) roto(s). Empieza por este:\n\n  >> %s\n\n' "$FALLOS" "$PRIMER_FALLO"
  printf '  Arregla ese y vuelve a correr el script: los de abajo suelen caerse en cadena.\n'
fi
printf '\n'
[ "$FALLOS" -eq 0 ]
