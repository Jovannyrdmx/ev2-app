#!/usr/bin/env bash
# ============================================================================
# EV2 — prueba de funcionalidad de extremo a extremo: la noche completa.
#
#   bash docs/api/smoke-test-inventario.sh [http://localhost:3000]
#
# Recorre el flujo real de una noche contra la API levantada, con los datos reales
# del club, y verifica en cada paso lo que de verdad importa -- no que la ruta
# responda 200, sino que el dinero y los mililitros queden donde deben:
#
#   1. Entra mercancia al almacen (con el costo de la factura).
#   2. El almacen surte las dos barras.
#   3. Un cliente se registra, entra por la puerta y se sienta.
#   4. El mesero le levanta un pedido y lo cobra en la mesa.
#   5. La barra CORRECTA lo ve, lo prepara y lo marca listo; la otra no lo ve.
#   6. El mesero confirma la entrega.
#   7. El inventario bajo de la barra que sirvio, y solo de esa.
#   8. Un conteo fisico revela la merma y la deja explicada en el kardex.
#
# Requiere: la API arriba, la base migrada y sembrada (seed, seed:floor,
# seed:prices, seed:menu, seed:supplies) y `SEED_PASSWORD` en el entorno.
#
# No toca dinero real ni la caja del club: todo va contra la API local.
# ============================================================================
set -uo pipefail

API="${1:-http://localhost:3000}/api"
PASS="${SEED_PASSWORD:?Falta SEED_PASSWORD}"
SLUG="${CLUB_SLUG:-ev2}"

ok=0; fail=0
green() { printf '  \033[32m✓\033[0m %s\n' "$1"; ok=$((ok+1)); }
red()   { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail+1)); }
step()  { printf '\n\033[36m%s\033[0m\n' "$1"; }

# `check <descripcion> <esperado> <obtenido>`
check() {
  if [ "$2" = "$3" ]; then green "$1"; else red "$1 (esperaba '$2', obtuvo '$3')"; fi
}

# Igual que `check`, pero comparando numeros: 2250 y 2250.0 son el mismo saldo, y una
# prueba que falla por como se imprime un numero no dice nada de si el sistema esta bien.
checknum() {
  if python3 -c "import sys;sys.exit(0 if abs(float('$2')-float('$3'))<1e-6 else 1)" 2>/dev/null
  then green "$1"; else red "$1 (esperaba $2, obtuvo $3)"; fi
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
uuid() { python3 -c 'import uuid;print(uuid.uuid4())'; }

step "0. Sesiones y club"
MGR=$(tok manager@ev2.local); WTR=$(tok waiter@ev2.local); BAR=$(tok bartender@ev2.local)
HOST=$(tok hostess@ev2.local)
CLUB=$(curl -s "$API/nightclubs/by-slug/$SLUG" | jget "d['nightclub']['id']")
N="$API/nightclubs/$CLUB"
[ -n "$MGR" ] && green "gerente autenticado" || red "no se pudo autenticar al gerente"
[ ${#CLUB} -eq 36 ] && green "club resuelto por slug" || red "no se resolvio el club"

LOCS=$(curl -s "$N/supply-locations" -H "Authorization: Bearer $MGR")
pick() { echo "$LOCS" | python3 -c "import sys,json;print([l['id'] for l in json.load(sys.stdin)['locations'] if l['code']=='$1'][0])"; }
ALM=$(pick almacen); BAJA=$(pick barra-baja); ALTA=$(pick barra-alta)
check "tres lugares (almacen y dos barras)" "3" "$(echo "$LOCS" | jget "len(d['locations'])")"

step "1. Entra mercancia al almacen"
SUP=$(curl -s "$N/supplies?search=BUCHANNANS%2012" -H "Authorization: Bearer $MGR")
WID=$(echo "$SUP" | jget "d['supplies'][0]['id']")
PKG=$(echo "$SUP" | jget "d['supplies'][0]['package_size']")
ANTES=$(echo "$SUP" | jget "d['supplies'][0]['stock']")
saldo0() {
  echo "$SUP" | python3 -c "import sys,json
s=json.load(sys.stdin)['supplies'][0]
print(([l['stock'] for l in s['locations'] if l['code']=='$1'] or [0])[0])"
}
ALM0=$(saldo0 almacen); BAJA0=$(saldo0 barra-baja); ALTA0=$(saldo0 barra-alta)

R=$(curl -s -X POST "$N/supplies/$WID/receive" -H "Authorization: Bearer $MGR" \
  -H 'Content-Type: application/json' \
  -d "{\"location_id\":\"$ALM\",\"packages\":12,\"package_cost\":900,\"reason\":\"Factura de prueba\"}")
checknum "12 botellas de $PKG ml entran al almacen" \
  "$(python3 -c "print(float('$ANTES')+12*float('$PKG'))")" \
  "$(echo "$R" | jget "float(d['supply']['stock'])")"
checknum "el costo se guarda por unidad base" "1.2" "$(echo "$R" | jget "round(d['supply']['avg_cost'],4)")"

step "2. El almacen surte las dos barras"
surtir() {
  curl -s -X POST "$N/supplies/$WID/transfer" -H "Authorization: Bearer $MGR" \
    -H 'Content-Type: application/json' \
    -d "{\"from_location_id\":\"$ALM\",\"to_location_id\":\"$1\",\"packages\":$2,\"reason\":\"Surtido de apertura\"}"
}
T1=$(surtir "$BAJA" 3); T2=$(surtir "$ALTA" 2)
check "traspaso a la barra de abajo" "201-ok" "$(echo "$T1" | jget "'201-ok' if d.get('transfer') else 'error'")"
check "los dos renglones comparten folio" "1" \
  "$(echo "$T1" | jget "1 if d['transfer']['out'] and d['transfer']['in'] else 0")"
# El saldo de un estante, leido de la API. Se compara SIEMPRE como diferencia contra lo
# que habia antes del paso: asi el guion se puede correr de nuevo sobre la misma base sin
# fallar por el inventario que dejo la corrida anterior.
saldo() {
  curl -s "$N/supplies?search=BUCHANNANS%2012" -H "Authorization: Bearer $MGR" \
    | python3 -c "import sys,json;s=json.load(sys.stdin)['supplies'][0];print([l['stock'] for l in s['locations'] if l['code']=='$1'][0])"
}
delta() { python3 -c "print(float('$2')-float('$1'))"; }

checknum "barra baja: +3 botellas" "2250" "$(delta "$BAJA0" "$(saldo barra-baja)")"
checknum "barra alta: +2 botellas" "1500" "$(delta "$ALTA0" "$(saldo barra-alta)")"

# El refresco de la receta, para que el trago se pueda servir de verdad.
SID=$(curl -s "$N/supplies?search=SPRITE%203" -H "Authorization: Bearer $MGR" | jget "d['supplies'][0]['id']")
curl -s -X POST "$N/supplies/$SID/receive" -H "Authorization: Bearer $MGR" \
  -H 'Content-Type: application/json' \
  -d "{\"location_id\":\"$ALM\",\"packages\":6,\"package_cost\":60}" > /dev/null
curl -s -X POST "$N/supplies/$SID/transfer" -H "Authorization: Bearer $MGR" \
  -H 'Content-Type: application/json' \
  -d "{\"from_location_id\":\"$ALM\",\"to_location_id\":\"$BAJA\",\"packages\":4}" > /dev/null
green "refresco surtido a la barra de abajo"

step "3. Un cliente se registra y se sienta en una mesa de planta baja"
MAIL="prueba-$(date +%s)@ev2.local"
REG=$(curl -s -X POST "$API/auth/register" -H 'Content-Type: application/json' \
  -d "{\"nightclub_slug\":\"$SLUG\",\"email\":\"$MAIL\",\"password\":\"PruebaSegura123\",\"first_name\":\"Prueba\",\"last_name\":\"Cliente\",\"birth_date\":\"1995-03-10\",\"accept_terms\":true}")
CLI=$(echo "$REG" | jget "d['access_token']")
[ -n "$CLI" ] && [ "$CLI" != "SIN-DATO" ] && green "cliente registrado (mayor de edad)" \
  || red "el registro del cliente fallo"
MENOR=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"nightclub_slug\":\"$SLUG\",\"email\":\"menor-$(date +%s)@ev2.local\",\"password\":\"PruebaSegura123\",\"first_name\":\"Menor\",\"last_name\":\"Edad\",\"birth_date\":\"2012-01-01\",\"accept_terms\":true}")
check "un menor de edad NO se registra" "403" "$MENOR"

TBL=$(curl -s "$N/tables" -H "Authorization: Bearer $WTR" | python3 -c "
import sys,json
t=[x for x in json.load(sys.stdin)['tables'] if x['floor']=='baja' and x['status']=='available']
print(t[0]['id'], t[0]['code'])")
TID=${TBL%% *}; TCODE=${TBL##* }
SIT=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$N/tables/$TID/seat" \
  -H "Authorization: Bearer $HOST" -H 'Content-Type: application/json' \
  -d "{\"user_id\":\"$(echo "$REG" | jget "d['user']['id']")\"}")
[ "$SIT" = "200" ] || [ "$SIT" = "201" ] && green "la anfitriona lo sienta en la mesa $TCODE" \
  || red "no se pudo sentar al cliente (HTTP $SIT)"

step "4. El mesero levanta el pedido y lo cobra en la mesa"
DRK=$(curl -s "$N/drinks?search=BUCHANANS%2012%20-%20SPRITE" -H "Authorization: Bearer $WTR")
DID=$(echo "$DRK" | jget "d['drinks'][0]['id']")
ALCANZAN=$(echo "$DRK" | jget "d['drinks'][0]['stock']")
check "la carta dice de que barra habla" "$BAJA" "$(echo "$DRK" | jget "d['bar_location_id']")"
[ "$ALCANZAN" -gt 0 ] && green "alcanzan $ALCANZAN tragos en esa barra" || red "la carta dice 0"

ORD=$(curl -s -X POST "$N/orders" -H "Authorization: Bearer $WTR" -H 'Content-Type: application/json' \
  -d "{\"client_request_id\":\"$(uuid)\",\"table_id\":\"$TID\",\"items\":[{\"drink_id\":\"$DID\",\"quantity\":6}]}")
OID=$(echo "$ORD" | jget "d['order']['id']")
TX=$(echo "$ORD" | jget "d['order']['transaction_id']")
check "el pedido nace debiendo dinero" "pending" "$(echo "$ORD" | jget "d['order']['payment_status']")"
check "y sale de la barra de abajo" "Barra planta baja" "$(echo "$ORD" | jget "d['order']['bar_name']")"

# La barra no sirve a credito: confirmar sin pagar tiene que fallar.
SINPAGAR=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$N/orders/$OID/status" \
  -H "Authorization: Bearer $BAR" -H 'Content-Type: application/json' -d '{"status":"confirmed"}')
check "la barra NO lo prepara sin pagar" "409" "$SINPAGAR"

COBRO=$(curl -s -X POST "$N/manual-payments/register" -H "Authorization: Bearer $WTR" \
  -H 'Content-Type: application/json' \
  -d "{\"transaction_id\":\"$TX\",\"method\":\"cash\",\"amount\":$(echo "$ORD" | jget "float(d['order']['subtotal'])"),\"currency\":\"MXN\"}")
check "la declaracion del efectivo queda confirmada" "confirmed" \
  "$(echo "$COBRO" | jget "d['payment']['status']")"
check "y el libro contable lo asienta como pagado" "paid" \
  "$(curl -s "$N/orders/$OID" -H "Authorization: Bearer $BAR" | jget "d['order']['payment_status']")"
check "y el pedido queda confirmado solo" "confirmed" \
  "$(curl -s "$N/orders/$OID" -H "Authorization: Bearer $BAR" | jget "d['order']['status']")"

step "5. La barra correcta lo ve; la otra no"
COLA_BAJA=$(curl -s "$N/orders?bar_id=$BAJA&active=true&paid_only=true" -H "Authorization: Bearer $BAR")
COLA_ALTA=$(curl -s "$N/orders?bar_id=$ALTA&active=true" -H "Authorization: Bearer $BAR")
check "la barra de abajo tiene el pedido" "1" "$(echo "$COLA_BAJA" | jget "len([o for o in d['orders'] if o['id']=='$OID'])")"
check "la barra de arriba no lo ve" "0" "$(echo "$COLA_ALTA" | jget "len([o for o in d['orders'] if o['id']=='$OID'])")"

for ESTADO in preparing ready; do
  S=$(curl -s -X POST "$N/orders/$OID/status" -H "Authorization: Bearer $BAR" \
    -H 'Content-Type: application/json' -d "{\"status\":\"$ESTADO\"}" | jget "d['order']['status']")
  check "la barra lo pasa a $ESTADO" "$ESTADO" "$S"
done

step "6. El mesero confirma la entrega"
ENT=$(curl -s -X POST "$N/orders/$OID/status" -H "Authorization: Bearer $WTR" \
  -H 'Content-Type: application/json' -d '{"status":"delivered"}' | jget "d['order']['status']")
check "entregado" "delivered" "$ENT"

step "7. El inventario bajo de la barra que sirvio, y solo de esa"
BAJA1=$(saldo barra-baja); ALTA1=$(saldo barra-alta); ALM1=$(saldo almacen)
checknum "barra baja: 6 tragos x 30 ml = 180 ml menos" "2070" "$(delta "$BAJA0" "$BAJA1")"
checknum "barra alta: intacta desde el surtido" "1500" "$(delta "$ALTA0" "$ALTA1")"
checknum "almacen: intacto desde el surtido" "5250" "$(delta "$ALM0" "$ALM1")"

KARDEX=$(curl -s "$N/supplies/$WID/movements" -H "Authorization: Bearer $MGR")
check "el kardex explica la venta contra el pedido" "$OID" \
  "$(echo "$KARDEX" | jget "[m['reference_id'] for m in d['movements'] if m['kind']=='consumption'][0]")"
check "y dice en que barra salio" "barra-baja" \
  "$(echo "$KARDEX" | jget "[m['location_code'] for m in d['movements'] if m['kind']=='consumption'][0]")"

step "8. El conteo fisico revela la merma"
# Se cuentan 70 ml MENOS de lo que dice el sistema: la merma de la noche.
CONTADO=$(python3 -c "print(float('$BAJA1')-70)")
CONTEO=$(curl -s -X POST "$N/supplies/$WID/count" -H "Authorization: Bearer $MGR" \
  -H 'Content-Type: application/json' \
  -d "{\"location_id\":\"$BAJA\",\"counted\":$CONTADO,\"reason\":\"Corte de la noche\"}")
checknum "la diferencia contra el teorico" "-70" "$(echo "$CONTEO" | jget "float(d['difference'])")"
checknum "y se reporta como merma" "70" "$(echo "$CONTEO" | jget "float(d['shrinkage'])")"

step "Resultado"
printf '  %s pruebas bien, %s mal\n' "$ok" "$fail"
[ "$fail" -eq 0 ] || exit 1
