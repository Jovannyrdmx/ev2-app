#!/usr/bin/env bash
# ============================================================================
# EV2 — comprobar la integracion con Mercado Pago contra la API REAL.
#
# Por que existe
# --------------
# El entorno donde se escribio este codigo NO tiene salida a api.mercadopago.com,
# asi que la integracion se construyo contra la documentacion. La documentacion
# de una pasarela y su API real no siempre dicen lo mismo, y la diferencia solo
# se ve llamandola. Este script la llama y ENSENA lo que contesta, para corregir
# con datos en vez de con suposiciones.
#
# Se corre en el VPS, que es el unico sitio de este proyecto con internet
# abierto:
#
#     bash docs/api/probar-mercadopago.sh
#
# Que hace, en orden:
#   1. Comprueba que las credenciales sirven y de quien son.
#   2. Lista las terminales de la cuenta y su modo de operacion.
#   3. Crea un cobro de $1.00 en el DISPOSITIVO VIRTUAL (no existe fisicamente).
#   4. Simula que la tarjeta paso.
#   5. Vuelve a leer la orden y ensena la respuesta completa.
#
# Que NO hace: no toca la base de datos del club, no crea nada en el sistema, y
# se NIEGA a correr con credenciales de produccion.
# ============================================================================
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 1

# ---------------------------------------------------------------- credenciales

if [ -f .env ]; then
  # Solo las de Mercado Pago, y sin volcarlas a la pantalla.
  # shellcheck disable=SC2046
  export $(grep -E '^MERCADOPAGO_(ACCESS_TOKEN|ENV)=' .env | xargs -d '\n' 2>/dev/null) || true
fi

TOKEN="${MERCADOPAGO_ACCESS_TOKEN:-}"
MODO="${MERCADOPAGO_ENV:-}"
API="https://api.mercadopago.com"

azul()  { printf '\n\033[36m== %s\033[0m\n' "$1"; }
verde() { printf '  \033[32mOK\033[0m    %s\n' "$1"; }
rojo()  { printf '  \033[31mFALLA\033[0m %s\n' "$1"; }
nota()  { printf '        %s\n' "$1"; }

if [ -z "$TOKEN" ]; then
  rojo "No hay MERCADOPAGO_ACCESS_TOKEN en el .env de la raiz."
  nota "Ponlo primero. Sin el no hay nada que comprobar."
  exit 1
fi

if [ "$MODO" != "test" ]; then
  rojo "MERCADOPAGO_ENV no dice 'test' (dice '${MODO:-nada}')."
  nota "Este script CREA un cobro. Con credenciales de produccion eso seria"
  nota "un cargo de verdad, asi que no se corre. Si de verdad quieres probar"
  nota "en produccion, se hace a mano y con la terminal enfrente."
  exit 1
fi

# `jq` hace legible la salida, pero no es obligatorio: sin el se ensena crudo.
if command -v jq >/dev/null 2>&1; then
  bonito() { jq .; }
else
  bonito() { cat; }
  nota "(sin 'jq' instalado: las respuestas salen crudas. 'apt install jq' las ordena)"
fi

pedir() { # metodo ruta [cuerpo]
  local m="$1" ruta="$2" cuerpo="${3:-}"
  if [ -n "$cuerpo" ]; then
    curl -sS -X "$m" "$API$ruta" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -H "X-Idempotency-Key: $(cat /proc/sys/kernel/random/uuid)" \
      -d "$cuerpo"
  else
    curl -sS -X "$m" "$API$ruta" -H "Authorization: Bearer $TOKEN"
  fi
}

# ---------------------------------------------------------------- 1. la cuenta

azul "1. Las credenciales"
CUENTA=$(pedir GET /users/me)
if echo "$CUENTA" | grep -q '"id"'; then
  verde "El token sirve."
  echo "$CUENTA" | bonito | grep -E '"(id|nickname|site_id|email)"' || true
else
  rojo "El token NO sirve. Esto contesto Mercado Pago:"
  echo "$CUENTA" | bonito
  exit 1
fi

# ---------------------------------------------------------------- 2. terminales

azul "2. Las terminales de la cuenta"
TERMINALES=$(pedir GET "/terminals/v1/list?limit=50&offset=0")
echo "$TERMINALES" | bonito
nota "Anota el 'id' y el 'operating_mode' de cada una."
nota "Una terminal en STANDALONE ignora las ordenes de la API sin decir nada:"
nota "hay que pasarla a PDV y reiniciarla. Eso lo hace el panel del gerente."

# ---------------------------------------------------------------- 3. un cobro

azul "3. Un cobro de \$1.00 en el dispositivo virtual"
VIRTUAL="NEWLAND_N950__SBX0000001"
ORDEN=$(pedir POST /v1/orders "$(cat <<JSON
{
  "type": "point",
  "external_reference": "ev2-prueba-$(date +%s)",
  "expiration_time": "PT5M",
  "transactions": { "payments": [{ "amount": "1.00" }] },
  "config": { "point": { "terminal_id": "$VIRTUAL", "print_on_terminal": "no_ticket" } },
  "description": "EV2 prueba de integracion"
}
JSON
)")
echo "$ORDEN" | bonito

ORDER_ID=$(echo "$ORDEN" | grep -o '"id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -z "$ORDER_ID" ]; then
  rojo "No se pudo crear la orden. Lo de arriba es lo que contesto."
  nota "Si dice algo de la terminal, revisa el paso 2: puede que el dispositivo"
  nota "virtual tenga otro identificador en tu cuenta."
  exit 1
fi
verde "Orden creada: $ORDER_ID"

# ---------------------------------------------------------------- 4. simular

azul "4. Simular que la tarjeta paso"
SIM=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  "$API/v1/orders/$ORDER_ID/events" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Idempotency-Key: $(cat /proc/sys/kernel/random/uuid)" \
  -d '{"status":"processed","payment_method_type":"credit_card","installments":1,"payment_method_id":"visa","status_detail":"accredited"}')
if [ "$SIM" = "200" ] || [ "$SIM" = "201" ] || [ "$SIM" = "204" ]; then
  verde "Simulacion aceptada (HTTP $SIM)."
else
  rojo "La simulacion contesto HTTP $SIM."
  nota "No es fatal: el paso 5 ensena en que estado quedo la orden de verdad."
fi

sleep 2

# ---------------------------------------------------------------- 5. la verdad

azul "5. Como quedo la orden (esta es la respuesta que el sistema cree)"
pedir GET "/v1/orders/$ORDER_ID" | bonito

cat <<'FIN'

----------------------------------------------------------------------
Que hacer con esto
----------------------------------------------------------------------
Pega la salida completa en el chat. Lo que hace falta confirmar es:

  * el identificador exacto del dispositivo virtual en TU cuenta (paso 2);
  * el nombre del campo del monto cobrado en el paso 5
    (el codigo lee `total_paid_amount`);
  * donde viene la marca de la tarjeta y el tipo
    (el codigo los lee de `transactions.payments[0].payment_method`);
  * si `live_mode` viene en `false`, que es lo que el servidor comprueba
    contra MERCADOPAGO_ENV antes de dejar cobrar.

Si algo de eso no coincide, se corrige en `server/src/services/mercadopago.js`
y en ningun otro sitio: toda la conversacion con Mercado Pago pasa por ahi.
FIN
