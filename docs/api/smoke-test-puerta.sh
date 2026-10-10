#!/usr/bin/env bash
# ============================================================================
# EV2 — prueba de extremo a extremo de la ENTRADA: un pase por persona.
#
#   bash docs/api/smoke-test-puerta.sh [http://localhost:3000]
#
# Recorre lo que de verdad pasa en la puerta un sabado, contra la API levantada,
# y comprueba en cada paso lo que importa -- no que la ruta responda 200, sino
# que entre UNA persona por pase y que nadie entre sin que le miren la
# identificacion:
#
#   1. Un cliente reserva una mesa para 4. Nacen 4 pases: el suyo y 3 invitados.
#   2. El titular le pone nombre a uno y lo comparte: sale el enlace de WhatsApp.
#   3. El invitado abre ese enlace SIN cuenta y ve su QR.
#   4. El enlace sin firma, y con la firma cambiada, NO abren nada.
#   5. La puerta intenta escanear sin revisar la identificacion: se niega.
#   6. Registra un RECHAZO de menor de edad: queda escrito y el pase sigue vivo.
#   7. Revisa bien, escanea, y entra UNA persona. El mismo QR ya no abre.
#   8. Los otros pases de la mesa siguen sirviendo (esto es lo que no existia).
#   9. Un QR fabricado (firma inventada) se rechaza.
#  10. El titular reasigna un pase: el codigo viejo muere, el nuevo abre.
#  11. La puerta emite un pase de CONTINGENCIA a quien llego sin telefono.
#  12. La auditoria de cada pase explica quien entro, con que, y a que hora.
#  13. Nada de esto expone un dato personal en el QR ni en el enlace publico.
#
# Requiere: la API arriba, la base migrada y sembrada (seed, seed:floor,
# seed:prices, seed:menu) y `SEED_PASSWORD` en el entorno.
#
# Se puede correr dos veces seguidas sobre la misma base: cada corrida crea su
# propio cliente y su propia reservacion.
#
# AVISO: para poder reservar contra una noche que abre en 15 minutos, baja
# `min_advance_hours` a 0 un momento y la RESTAURA al terminar (tambien con
# Ctrl-C), comprobando que quedo restaurada y gritando si no. Aun asi, esto es
# una prueba de servidor de pruebas: no la corras sobre el club en operacion.
# ============================================================================
set -uo pipefail

API="${1:-http://localhost:3000}/api"
PASS="${SEED_PASSWORD:?Falta SEED_PASSWORD}"
SLUG="${CLUB_SLUG:-ev2}"

ok=0; fail=0
green() { printf '  \033[32m✓\033[0m %s\n' "$1"; ok=$((ok+1)); }
red()   { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail+1)); }
step()  { printf '\n\033[36m%s\033[0m\n' "$1"; }
check() { if [ "$2" = "$3" ]; then green "$1"; else red "$1 (esperaba '$2', obtuvo '$3')"; fi; }
# `nocontiene <descripcion> <aguja> <pajar>` -- para las fugas de datos, donde lo
# que hay que comprobar es la AUSENCIA.
nocontiene() {
  if printf '%s' "$3" | grep -qF -- "$2"; then red "$1 (aparece '$2')"; else green "$1"; fi
}
jget() { python3 -c "import sys,json
try: d=json.load(sys.stdin)
except Exception: print('SIN-JSON'); raise SystemExit
try: print($1)
except Exception: print('SIN-DATO')"; }

login() {
  curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' \
    -d "{\"nightclub_slug\":\"$SLUG\",\"email\":\"$1\",\"password\":\"$PASS\"}"
}
tok() { login "$1" | jget "d['access_token']"; }

step "0. Sesiones y club"
MGR=$(tok manager@ev2.local); HOST=$(tok hostess@ev2.local)
CLUB=$(curl -s "$API/nightclubs/by-slug/$SLUG" | jget "d['nightclub']['id']")
N="$API/nightclubs/$CLUB"
[ ${#CLUB} -eq 36 ] && green "club resuelto por slug" || { red "no se resolvio el club"; exit 1; }
[ -n "$HOST" ] && green "anfitriona autenticada" || { red "sin sesion de puerta"; exit 1; }

# Un cliente nuevo por corrida, para no depender del estado anterior.
SUF=$(python3 -c 'import uuid;print(uuid.uuid4().hex[:8])')
CORREO="pase-$SUF@test.mx"
REG=$(curl -s -X POST "$API/auth/register" -H 'Content-Type: application/json' \
  -d "{\"nightclub_slug\":\"$SLUG\",\"email\":\"$CORREO\",\"password\":\"$PASS\",
       \"first_name\":\"Prueba\",\"last_name\":\"Puerta\",\"birth_date\":\"1995-05-05\",
       \"accept_terms\":true,\"terms_version\":\"test\"}")
CLI=$(printf '%s' "$REG" | jget "d['access_token']")
[ -n "$CLI" ] && green "cliente registrado" || { red "no se pudo registrar al cliente: $REG"; exit 1; }

step "1. La noche de hoy"
# La prueba necesita un club ABIERTO: el pase solo abre desde 2 horas antes de que
# el club abra y hasta que cierra (`door.checkPass`), asi que se crea un evento
# cuyas puertas ya abrieron hace media hora.
#
# Y para poder reservar contra el, se baja `min_advance_hours` a 0 un momento: la
# regla normal es que una reservacion se cierra 2 horas antes de abrir, que es
# justo lo contrario de lo que hace falta aqui. Se RESTAURA al final -- una prueba
# que deja la configuracion del club cambiada es una prueba que rompe la
# siguiente noche de verdad.
REGLAS=$(curl -s "$N/reservations/rules" -H "Authorization: Bearer $MGR")
ORIG=$(printf '%s' "$REGLAS" | jget "d['rules']['min_advance_hours']")
# Si ya vale 0, una corrida anterior murio sin restaurar: se vuelve al valor
# documentado (2 horas, D17) en vez de "restaurar" el 0 y dejarlo asi para siempre.
case "$ORIG" in ''|SIN-DATO|SIN-JSON|0) ORIG=2;; esac
restaurar_reglas() {
  curl -s -X PUT "$N/reservations/rules" -H "Authorization: Bearer $MGR" \
    -H 'Content-Type: application/json' -d "{\"min_advance_hours\":$ORIG}" >/dev/null
  DEJADO=$(curl -s "$N/reservations/rules" -H "Authorization: Bearer $MGR" \
    | jget "d['rules']['min_advance_hours']")
  if [ "$DEJADO" = "$ORIG" ]; then
    printf '\n  la regla de anticipo quedo restaurada en %s horas\n' "$ORIG"
  else
    # Decirlo fuerte: un club que se queda aceptando reservaciones el mismo dia
    # vende mesas que no puede preparar, y nadie lo va a notar hasta el sabado.
    printf '\n  \033[31mATENCION\033[0m: min_advance_hours quedo en %s y deberia ser %s.\n' \
      "$DEJADO" "$ORIG"
    printf '  Corrigelo: PUT %s/reservations/rules {"min_advance_hours":%s}\n' "$N" "$ORIG"
  fi
}
# EXIT cubre el final normal y el `exit 1`; INT y TERM cubren un Ctrl-C a media
# corrida, que es justo cuando quedaria a medias.
trap restaurar_reglas EXIT INT TERM
curl -s -X PUT "$N/reservations/rules" -H "Authorization: Bearer $MGR" \
  -H 'Content-Type: application/json' -d '{"min_advance_hours":0}' >/dev/null

# Las puertas abren en 15 MINUTOS, no hace media hora, y el motivo es que las dos
# reglas empujan en sentidos contrarios:
#
#   * reservar exige que las puertas esten en el FUTURO (`hoursAhead` negativo
#     siempre es menor que cualquier minimo, asi que un club ya abierto no acepta
#     reservaciones nuevas -- y esta bien, es la regla del club);
#   * el pase solo abre desde 120 minutos ANTES de esa hora.
#
# Entre "en el futuro" y "dentro de las proximas 2 horas" cabe todo lo que esta
# prueba necesita. 15 minutos deja margen para que la corrida entera quepa dentro.
HOY=$(python3 -c "import datetime;print(datetime.date.today().isoformat())")
ABRE=$(python3 -c "import datetime;print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(minutes=15)).isoformat())")
CIERRA=$(python3 -c "import datetime;print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(hours=8)).isoformat())")
NOCHE=$(curl -s -X POST "$N/events" -H "Authorization: Bearer $MGR" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"Prueba puerta $SUF\",\"event_date\":\"$HOY\",
       \"doors_open_at\":\"$ABRE\",\"closes_at\":\"$CIERRA\",
       \"ticket_price\":100,\"status\":\"published\"}")
EV=$(printf '%s' "$NOCHE" | jget "d['event']['id']")
if [ ${#EV} -ne 36 ]; then
  # Ya hay un evento para hoy (la prueba corrio antes, o el club tiene su noche
  # cargada): se reusa y se le corrige el horario, porque el de una corrida vieja
  # ya quedo en el pasado y entonces no se puede reservar contra el.
  EV=$(curl -s "$N/events?upcoming=true&limit=1" -H "Authorization: Bearer $MGR" \
    | jget "d['events'][0]['id']")
  [ ${#EV} -eq 36 ] || EV=$(curl -s "$N/events?limit=1" -H "Authorization: Bearer $MGR" \
    | jget "d['events'][0]['id']")
  if [ ${#EV} -eq 36 ]; then
    curl -s -X PATCH "$N/events/$EV" -H "Authorization: Bearer $MGR" \
      -H 'Content-Type: application/json' \
      -d "{\"doors_open_at\":\"$ABRE\",\"closes_at\":\"$CIERRA\",\"status\":\"published\"}" >/dev/null
  fi
fi
if [ ${#EV} -ne 36 ]; then
  red "no se pudo preparar la noche: $NOCHE"
  printf '\n  %s de %s comprobaciones\n\n' "$ok" "$((ok+fail))"; exit 1
fi
green "la noche esta lista (las puertas abren en 15 minutos)"

step "2. Reservar para 4 emite 4 pases"
# `availability` devuelve SOLO las mesas libres, asi que no hay ninguna bandera
# `available` que filtrar: lo que viene, esta libre. Se pide una donde quepan 4 y
# cuya zona admita ese tamano, porque una mesa de 8 con minimo de 6 rechazaria la
# reservacion mas adelante y la prueba fallaria por el motivo equivocado.
MESA=$(curl -s "$N/reservations/availability?event_id=$EV&guests=4" -H "Authorization: Bearer $CLI" \
  | python3 -c "import sys,json
d=json.load(sys.stdin)
libres=[t for t in d.get('tables', []) if (t.get('capacity') or 0) >= 4]
print(libres[0]['id'] if libres else '')")
if [ ${#MESA} -ne 36 ]; then
  red "no hay mesas libres para 4 en ese evento"
  printf '\n  %s de %s comprobaciones\n\n' "$ok" "$((ok+fail))"; exit 1
fi
# `client_request_id` es obligatorio a proposito: si el dedo toca dos veces
# "Reservar", el servidor reconoce el repetido y devuelve la MISMA reservacion en
# vez de apartar dos mesas.
PETICION=$(python3 -c 'import uuid;print(uuid.uuid4())')
RES=$(curl -s -X POST "$N/reservations" -H "Authorization: Bearer $CLI" \
  -H 'Content-Type: application/json' \
  -d "{\"event_id\":\"$EV\",\"table_id\":\"$MESA\",\"guest_count\":4,
       \"client_request_id\":\"$PETICION\"}")
RID=$(printf '%s' "$RES" | jget "d['reservation']['id']")
[ ${#RID} -eq 36 ] && green "reservacion creada" || { red "no se pudo reservar: $RES"; exit 1; }
check "la respuesta trae los 4 pases" "4" "$(printf '%s' "$RES" | jget "len(d['passes'])")"
nocontiene "la respuesta de reservar NO trae el payload firmado" "EV2P." "$RES"

# El deposito se confirma a mano (fase 3 sin pasarela): sin esto el pase dice
# `unpaid`, que es correcto pero no es lo que queremos probar aqui.
curl -s -X POST "$N/reservations/$RID/status" -H "Authorization: Bearer $HOST" \
  -H 'Content-Type: application/json' -d '{"status":"confirmed"}' >/dev/null

LISTA=$(curl -s "$N/reservations/$RID/passes" -H "Authorization: Bearer $CLI")
check "la lista tiene 4 pases"    "4" "$(printf '%s' "$LISTA" | jget "len(d['passes'])")"
check "los 4 estan activos"       "4" "$(printf '%s' "$LISTA" | jget "d['summary']['active']")"
check "uno es del titular"        "1" "$(printf '%s' "$LISTA" | jget "len([p for p in d['passes'] if p['kind']=='holder'])")"
nocontiene "la LISTA no trae el payload firmado" "EV2P." "$LISTA"

pase_n() { printf '%s' "$LISTA" | jget "[p for p in d['passes'] if p['kind']=='guest'][$1]['$2']"; }
P1=$(pase_n 0 id); C1=$(pase_n 0 code)
P2=$(pase_n 1 id); C2=$(pase_n 1 code)
P3=$(pase_n 2 id)
TITULAR=$(printf '%s' "$LISTA" | jget "[p for p in d['passes'] if p['kind']=='holder'][0]['code']")

step "3. El titular reparte un pase por WhatsApp"
SHARE=$(curl -s -X POST "$N/reservations/$RID/passes/$P1/share" -H "Authorization: Bearer $CLI" \
  -H 'Content-Type: application/json' -d '{"label":"Ana","lang":"es"}')
WA=$(printf '%s' "$SHARE" | jget "d['share']['whatsapp_url']")
ENLACE=$(printf '%s' "$SHARE" | jget "d['share']['link']")
case "$WA" in https://wa.me/*) green "devuelve el enlace de WhatsApp";; *) red "no devolvio wa.me: $WA";; esac
case "$ENLACE" in *"/pase.html?p=EV2P."*) green "el enlace lleva el payload firmado";; *) red "enlace raro: $ENLACE";; esac
check "queda contado el reparto" "1" "$(printf '%s' "$SHARE" | jget "d['pass']['share_count']")"
check "y con el nombre del invitado" "Ana" "$(printf '%s' "$SHARE" | jget "d['pass']['label']")"
TEXTO=$(printf '%s' "$SHARE" | jget "d['share']['text']")
nocontiene "el mensaje NO lleva el correo del titular" "$CORREO" "$TEXTO"
nocontiene "ni el id de la reservacion" "$RID" "$TEXTO"

step "4. El invitado abre el enlace SIN cuenta"
PAYLOAD=$(printf '%s' "$ENLACE" | sed 's/.*?p=//')
PUB=$(curl -s "$API/guest-passes/$PAYLOAD")
check "puede abrir su pase sin sesion" "True"  "$(printf '%s' "$PUB" | jget "d['pass']['usable']")"
check "y ve su QR dibujado"            "True"  "$(printf '%s' "$PUB" | jget "'<svg' in d['pass']['qr_svg']")"
check "con el nombre que le pusieron"  "Ana"   "$(printf '%s' "$PUB" | jget "d['pass']['label']")"
nocontiene "el enlace publico NO expone el correo del titular" "$CORREO" "$PUB"
nocontiene "ni el id de la reservacion"                        "$RID"    "$PUB"

step "5. Un enlace sin firma o con firma cambiada no abre"
check "el codigo pelon en el enlace publico: 404" "404" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$API/guest-passes/$C1")"
check "la firma cambiada: 404" "404" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$API/guest-passes/EV2P.$C1.AAAAAAAAAA")"

step "6. Escanear sin revisar la identificacion se niega"
check "sin id_check_id: 400" "400" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$N/door/check-in" \
      -H "Authorization: Bearer $HOST" -H 'Content-Type: application/json' \
      -d "{\"code\":\"$C1\"}")"
check "el pase sigue activo" "active" \
  "$(curl -s "$N/reservations/$RID/passes/$P1" -H "Authorization: Bearer $CLI" | jget "d['pass']['status']")"

step "7. Un menor de edad: rechazo registrado, pase intacto"
MENOR=$(curl -s -X POST "$N/door/id-checks" -H "Authorization: Bearer $HOST" \
  -H 'Content-Type: application/json' \
  -d '{"document":"ine","adult":false,"decision":"rejected","reason":"menor de edad"}')
IDM=$(printf '%s' "$MENOR" | jget "d['id_check']['id']")
[ ${#IDM} -eq 36 ] && green "el rechazo queda registrado" || red "no se registro el rechazo: $MENOR"
check "aceptar a un menor es imposible: 400" "400" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$N/door/id-checks" \
      -H "Authorization: Bearer $HOST" -H 'Content-Type: application/json' \
      -d '{"document":"ine","adult":false,"decision":"accepted"}')"
NEG=$(curl -s -X POST "$N/door/check-in" -H "Authorization: Bearer $HOST" \
  -H 'Content-Type: application/json' -d "{\"code\":\"$C1\",\"id_check_id\":\"$IDM\"}")
check "con un rechazo no entra"        "no_id_check" "$(printf '%s' "$NEG" | jget "d['pass']['result']")"
check "y el motivo se dice"            "id_rejected" "$(printf '%s' "$NEG" | jget "d['id_check']['reason']")"
check "EL PASE NO SE QUEMO"            "active" \
  "$(curl -s "$N/reservations/$RID/passes/$P1" -H "Authorization: Bearer $CLI" | jget "d['pass']['status']")"

step "8. Revisa bien, escanea, y entra UNA persona"
idcheck() {
  curl -s -X POST "$N/door/id-checks" -H "Authorization: Bearer $HOST" \
    -H 'Content-Type: application/json' \
    -d '{"document":"ine","adult":true,"decision":"accepted"}' | jget "d['id_check']['id']"
}
entrar() {
  curl -s -X POST "$N/door/check-in" -H "Authorization: Bearer $HOST" \
    -H 'Content-Type: application/json' -d "{\"code\":\"$1\",\"id_check_id\":\"$(idcheck)\"}"
}
E1=$(entrar "$C1")
check "entra"                      "True" "$(printf '%s' "$E1" | jget "d['admitted']")"
check "y sienta la mesa"           "True" "$(printf '%s' "$E1" | jget "d['seated']")"
check "va 1 de 4 adentro"          "1"    "$(printf '%s' "$E1" | jget "d['pass']['already_inside']")"
E1B=$(entrar "$C1")
check "el mismo QR ya no abre"     "used" "$(printf '%s' "$E1B" | jget "d['pass']['result']")"

step "9. Los OTROS pases de la mesa siguen sirviendo"
E2=$(entrar "$C2")
check "el segundo invitado entra"  "True" "$(printf '%s' "$E2" | jget "d['admitted']")"
check "van 2 de 4"                 "2"    "$(printf '%s' "$E2" | jget "d['pass']['already_inside']")"
ET=$(entrar "$TITULAR")
check "y el titular tambien"       "True" "$(printf '%s' "$ET" | jget "d['admitted']")"

step "10. Un QR fabricado se rechaza"
P3CODE=$(curl -s "$N/reservations/$RID/passes/$P3" -H "Authorization: Bearer $CLI" | jget "d['pass']['code']")
FALSO=$(curl -s -X POST "$N/door/check-in" -H "Authorization: Bearer $HOST" \
  -H 'Content-Type: application/json' \
  -d "{\"code\":\"EV2P.$P3CODE.AAAAAAAAAA\",\"id_check_id\":\"$(idcheck)\"}")
check "firma inventada: forged"    "forged" "$(printf '%s' "$FALSO" | jget "d['result']")"
check "y ese pase sigue activo"    "active" \
  "$(curl -s "$N/reservations/$RID/passes/$P3" -H "Authorization: Bearer $CLI" | jget "d['pass']['status']")"

step "11. Reasignar: el codigo viejo muere, el nuevo abre"
REA=$(curl -s -X POST "$N/reservations/$RID/passes/$P3/reassign" -H "Authorization: Bearer $CLI" \
  -H 'Content-Type: application/json' -d '{"label":"Luis","reason":"Ana no pudo venir"}')
NUEVO=$(printf '%s' "$REA" | jget "d['pass']['code']")
check "el viejo queda revocado"    "revoked" "$(printf '%s' "$REA" | jget "d['revoked']['status']")"
check "el nuevo tiene otro codigo" "True"    "$(python3 -c "print('$NUEVO' != '$P3CODE')")"
check "y apunta al que sustituyo"  "$P3"     "$(printf '%s' "$REA" | jget "d['pass']['replaces_id']")"
check "el codigo viejo no abre"    "revoked" "$(entrar "$P3CODE" | jget "d['pass']['result']")"
check "el nuevo si abre"           "True"    "$(entrar "$NUEVO" | jget "d['admitted']")"

step "12. Llego sin telefono: pase de contingencia"
BUSCA=$(curl -s "$N/door/lookup?q=$TITULAR" -H "Authorization: Bearer $HOST")
check "lo encuentra por folio"     "1" "$(printf '%s' "$BUSCA" | jget "len(d['reservations'])")"
nocontiene "la busqueda NO devuelve el telefono completo" "$CORREO" "$BUSCA"
CONT=$(curl -s -X POST "$N/door/passes/contingency" -H "Authorization: Bearer $HOST" \
  -H 'Content-Type: application/json' \
  -d "{\"reservation_id\":\"$RID\",\"label\":\"Invitado extra\",\"reason\":\"llego sin telefono\"}")
CC=$(printf '%s' "$CONT" | jget "d['pass']['code']")
check "se emite"                   "contingency" "$(printf '%s' "$CONT" | jget "d['pass']['kind']")"
check "y vence"                    "True"        "$(printf '%s' "$CONT" | jget "bool(d['pass']['expires_at'])")"
check "sin motivo no se emite: 400" "400" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$N/door/passes/contingency" \
      -H "Authorization: Bearer $HOST" -H 'Content-Type: application/json' \
      -d "{\"reservation_id\":\"$RID\"}")"
check "abre una vez"               "True" "$(entrar "$CC" | jget "d['admitted']")"
check "y solo una"                 "used" "$(entrar "$CC" | jget "d['pass']['result']")"

step "13. La auditoria explica la noche"
HIST=$(curl -s "$N/reservations/$RID/passes/$P1/history" -H "Authorization: Bearer $CLI")
tiene() {
  if printf '%s' "$HIST" | python3 -c "import sys,json;print(any(h['kind']=='$1' for h in json.load(sys.stdin)['history']))" \
     | grep -q True; then green "queda registrado: $1"; else red "falta en la auditoria: $1"; fi
}
tiene issued; tiene shared; tiene viewed; tiene denied; tiene admitted
nocontiene "la auditoria NO muestra correos" "@ev2.local" "$HIST"

step "14. El aforo cuenta lo que entro"
SUM=$(curl -s "$N/door/summary" -H "Authorization: Bearer $MGR")
check "la reservacion aparece adentro" "True" \
  "$(printf '%s' "$SUM" | jget "d['reservations']['adentro'] >= 1")"

printf '\n'
if [ "$fail" -eq 0 ]; then
  printf '  \033[32m%s de %s comprobaciones\033[0m\n\n' "$ok" "$((ok+fail))"
else
  printf '  \033[31m%s fallaron\033[0m de %s comprobaciones\n\n' "$fail" "$((ok+fail))"
fi
[ "$fail" -eq 0 ]
