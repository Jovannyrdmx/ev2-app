#!/usr/bin/env bash
# ============================================================================
# EV2 — la foto del ticket, de punta a punta contra la API levantada.
#
#   bash docs/api/smoke-test-foto-ticket.sh [http://localhost:3000]
#
# Lo que comprueba no es "que la ruta responda 200". Es el orden y las tres
# protecciones que hacen que esto sea seguro (D45):
#
#   1. La foto se GUARDA primero, y lo leido es una PROPUESTA: subir una foto no
#      mueve una sola existencia.
#   2. Cada renglon comprueba cantidad x precio = importe. Un digito leido mal sale
#      MARCADO, no entra en silencio.
#   3. Una foto se usa UNA vez: el segundo intento choca y la entrada NO entra. Es
#      la proteccion contra el doble toque en un telefono lento.
#   4. La foto nunca se borra: se marca `discarded` y se queda como comprobante.
#
# Requiere: la API arriba con la base migrada y sembrada (`seed`, `seed:supplies`),
# `SEED_PASSWORD` en el entorno, y **tesseract con el paquete de espanol** en el
# contenedor de la API (va en `deploy/Dockerfile.api`). Sin tesseract la prueba sigue
# corriendo y comprueba lo que de verdad importa: que la foto se guarde igual y diga
# por que no se pudo leer.
#
# Necesita `python3` con Pillow (`python3-pil`) y `curl`. La factura la dibuja aqui
# mismo, con los nombres REALES del catalogo del club escritos como los escribe un
# proveedor (abreviados, con la medida pegada): es lo unico que de verdad prueba si el
# parecido de nombre sirve. Sin Pillow la prueba avisa y se detiene.
#
# No toca dinero real ni la caja del club: todo va contra la API que se le indique.
# ============================================================================
set -uo pipefail

API="${1:-http://localhost:3000}/api"
PASS="${SEED_PASSWORD:?Falta SEED_PASSWORD}"
SLUG="${CLUB_SLUG:-ev2}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ok=0; fail=0
green() { printf '  \033[32m✓\033[0m %s\n' "$1"; ok=$((ok+1)); }
red()   { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail+1)); }
step()  { printf '\n\033[36m%s\033[0m\n' "$1"; }
check() { if [ "$2" = "$3" ]; then green "$1"; else red "$1 (esperaba '$2', obtuvo '$3')"; fi; }
jget() { python3 -c "import sys,json
try: d=json.load(sys.stdin)
except Exception: print('SIN-JSON'); raise SystemExit
try: print($1)
except Exception: print('SIN-DATO')"; }

login() {
  curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' \
    -d "{\"nightclub_slug\":\"$SLUG\",\"email\":\"$1\",\"password\":\"$PASS\"}"
}

step "0. Sesion y club"
MGR=$(login manager@ev2.local | jget "d['access_token']")
BAR=$(login bartender@ev2.local | jget "d['access_token']")
CLUB=$(curl -s "$API/nightclubs/by-slug/$SLUG" | jget "d['nightclub']['id']")
N="$API/nightclubs/$CLUB"
[ -n "$MGR" ] && [ "$MGR" != "SIN-DATO" ] && green "gerente autenticado" || red "no se pudo autenticar al gerente"

LOCS=$(curl -s "$N/supply-locations" -H "Authorization: Bearer $MGR")
ALM=$(echo "$LOCS" | python3 -c "import sys,json;print([l['id'] for l in json.load(sys.stdin)['locations'] if l['code']=='almacen'][0])")

# Cuantos movimientos hay ANTES de subir nada. Es la unica forma de comprobar que
# subir una foto no mueve inventario: contarlos despues de subirla no prueba nada.
MOVS0=$(curl -s "$N/supply-movements?limit=500" -H "Authorization: Bearer $MGR" | jget "len(d['movements'])")

step "1. Una factura del proveedor, en una imagen"
FACTURA="$TMP/factura.png"
FOLIO=$(date +%H%M%S)
python3 - "$FACTURA" "$FOLIO" <<'PY'
import sys
lineas = [
 "DISTRIBUIDORA DE BEBIDAS DEL NORTE",
 "RFC: DBN180422H41",
 "",
 "FACTURA  B-%s        FECHA DE HOY" % sys.argv[2],
 "",
 "CANT  DESCRIPCION                 P.UNIT     IMPORTE",
 "----------------------------------------------------",
 "6     TEQ DON JULIO 70 690ML      1,150.00   6,900.00",
 "24    RON BACARDI BLANCO 750ML      285.00   6,840.00",
 "12    VODKA ABSOLUT 750ML           395.00   4,740.00",
 "6     LICOR JAGERMEISTER 700ML      520.00   3,120.00",
 "----------------------------------------------------",
 "                        SUBTOTAL           21,600.00",
 "                        IVA 16%             3,456.00",
 "                        TOTAL              25,056.00",
]
# Sin Pillow no hay imagen que subir, y el guion lo dice arriba en vez de fallar con
# un rastro de python que no le sirve a nadie.
try:
    from PIL import Image, ImageDraw, ImageFont
    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", 20)
    W, H = 720, 30 + 28 * len(lineas)
    img = Image.new("L", (W, H), 245)
    d = ImageDraw.Draw(img)
    for i, l in enumerate(lineas):
        d.text((18, 15 + 28 * i), l, fill=35, font=font)
    img.save(sys.argv[1])
    print("PIL")
except ImportError:
    print("SIN-PIL")
PY
if [ ! -s "$FACTURA" ]; then
  red "no se pudo generar la imagen de la factura (falta python3-pil); se omite la prueba"
  printf '\n\033[1m%s bien, %s mal\033[0m\n\n' "$ok" "$fail"
  exit 1
fi
green "factura de 4 renglones generada ($(wc -c < "$FACTURA") bytes)"

step "2. Subir la foto"
SUBIDA=$(curl -s -X POST "$N/receipt-photos" -H "Authorization: Bearer $MGR" -F "photo=@$FACTURA")
PHOTO=$(echo "$SUBIDA" | jget "d['photo']['id']")
ESTADO=$(echo "$SUBIDA" | jget "d['photo']['status']")
[ ${#PHOTO} -eq 36 ] && green "la foto quedo guardada (id $PHOTO)" || red "no se guardo la foto: $SUBIDA"
check "la ruta del disco NO se expone" "False" "$(echo "$SUBIDA" | jget "'file_path' in d['photo']")"

# La misma imagen otra vez: devuelve la de antes, no una copia. Sin esto queda una
# entrega duplicada esperando a que alguien la capture dos veces.
OTRA=$(curl -s -X POST "$N/receipt-photos" -H "Authorization: Bearer $MGR" -F "photo=@$FACTURA")
check "la misma foto subida dos veces devuelve la de antes" "True" "$(echo "$OTRA" | jget "d.get('already_uploaded') is True")"
check "y no duplica el renglon" "$PHOTO" "$(echo "$OTRA" | jget "d['photo']['id']")"

# Un cantinero no entra al almacen. Si el seed de este servidor no trae la cuenta del
# cantinero con esta contrasena, se dice y se sigue: es la unica comprobacion que
# depende de una cuenta ajena al almacen.
if [ -n "$BAR" ] && [ "$BAR" != "SIN-DATO" ]; then
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$N/receipt-photos" \
    -H "Authorization: Bearer $BAR" -F "photo=@$FACTURA")
  check "un cantinero no puede subir facturas" "403" "$CODE"
else
  printf '  \033[33m~\033[0m sin cuenta de cantinero en este servidor: se omite la prueba de rol\n'
fi

step "3. Lo leido es una propuesta: NO mueve inventario"
MOVS1=$(curl -s "$N/supply-movements?limit=500" -H "Authorization: Bearer $MGR" | jget "len(d['movements'])")
check "subir la foto no genero ningun movimiento" "$MOVS0" "$MOVS1"

if [ "$ESTADO" = "parsed" ]; then
  LEIDO=$(curl -s "$N/receipt-photos/$PHOTO" -H "Authorization: Bearer $MGR")
  RENGLONES=$(echo "$LEIDO" | jget "len(d['photo']['parsed']['lines'])")
  CUADRA=$(echo "$LEIDO" | jget "d['photo']['parsed']['total_matches']")
  CONINSUMO=$(echo "$LEIDO" | jget "len([l for l in d['photo']['parsed']['lines'] if l['supply_id']])")
  OKS=$(echo "$LEIDO" | jget "len([l for l in d['photo']['parsed']['lines'] if l['math']=='ok'])")
  green "se leyeron $RENGLONES renglones; $OKS con la cuenta comprobada; $CONINSUMO con insumo propuesto"
  check "la suma de los renglones cuadra con el subtotal impreso" "True" "$CUADRA"
  # Se compara contra el SUBTOTAL, no contra el total: los renglones no traen IVA, y
  # compararlos con el total daria una alarma falsa en cada factura.
  check "se compara contra el subtotal (21,600) y no contra el total" "21600.0" \
    "$(echo "$LEIDO" | jget "float(d['photo']['parsed']['compared_against'])")"
  # Ninguna cifra leida puede salir como insumo elegido sin un ganador claro.
  check "ningun renglon quedo con insumo y confianza baja a la vez" "0" \
    "$(echo "$LEIDO" | jget "len([l for l in d['photo']['parsed']['lines'] if l['supply_id'] and l['confidence']=='low'])")"
else
  green "la lectura no estaba disponible ($ESTADO), y la foto SI se guardo igual"
  check "el renglon dice por que no se pudo leer" "True" \
    "$(echo "$SUBIDA" | jget "bool(d['photo']['error'])")"
fi

step "4. La captura amarra la foto al lote"
SUP=$(curl -s "$N/supplies?search=JAGERMEISTER" -H "Authorization: Bearer $MGR")
SID=$(echo "$SUP" | jget "d['supplies'][0]['id']")
PKG=$(echo "$SUP" | jget "d['supplies'][0]['package_size']")
ST0=$(echo "$SUP" | jget "float(d['supplies'][0]['stock'])")

CAP=$(curl -s -X POST "$N/supply-receipts" -H "Authorization: Bearer $MGR" \
  -H 'Content-Type: application/json' \
  -d "{\"location_id\":\"$ALM\",\"photo_id\":\"$PHOTO\",\"lines\":[{\"supply_id\":\"$SID\",\"packages\":6,\"package_cost\":520}]}")
GRUPO=$(echo "$CAP" | jget "d['receipt']['receipt_group']")
[ ${#GRUPO} -eq 36 ] && green "la entrada se guardo (folio $GRUPO)" || red "no se guardo la entrada: $CAP"

FOTO=$(curl -s "$N/receipt-photos/$PHOTO" -H "Authorization: Bearer $MGR")
check "la foto quedo marcada como capturada" "used" "$(echo "$FOTO" | jget "d['photo']['status']")"
check "y amarrada al folio del lote" "$GRUPO" "$(echo "$FOTO" | jget "d['photo']['receipt_group']")"

ST1=$(curl -s "$N/supplies?search=JAGERMEISTER" -H "Authorization: Bearer $MGR" | jget "float(d['supplies'][0]['stock'])")
check "el inventario subio las 6 presentaciones" \
  "$(python3 -c "print(float('$ST0')+6*float('$PKG'))")" "$ST1"

step "5. Una foto se usa UNA vez"
CODE=$(curl -s -o "$TMP/dup.json" -w '%{http_code}' -X POST "$N/supply-receipts" \
  -H "Authorization: Bearer $MGR" -H 'Content-Type: application/json' \
  -d "{\"location_id\":\"$ALM\",\"photo_id\":\"$PHOTO\",\"lines\":[{\"supply_id\":\"$SID\",\"packages\":6,\"package_cost\":520}]}")
check "la segunda captura con la misma foto choca" "409" "$CODE"
# Lo importante no es el 409: es que el inventario NO se movio dos veces.
ST2=$(curl -s "$N/supplies?search=JAGERMEISTER" -H "Authorization: Bearer $MGR" | jget "float(d['supplies'][0]['stock'])")
check "y el inventario NO se movio dos veces" "$ST1" "$ST2"

CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$N/receipt-photos/$PHOTO/reparse" \
  -H "Authorization: Bearer $MGR")
check "una foto ya capturada no se vuelve a leer" "409" "$CODE"

step "6. La foto es el comprobante: se descarta, no se borra"
# Misma imagen = mismo checksum, asi que para descartar se usa la que ya existe: lo
# que se prueba es que descartar no borre, no que se pueda subir dos veces.
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$N/receipt-photos/$PHOTO/discard" \
  -H "Authorization: Bearer $MGR" -H 'Content-Type: application/json' \
  -d '{"reason":"prueba de humo"}')
check "una foto ya capturada NO se puede descartar" "404" "$CODE"

# La misma imagen devuelve la de antes, asi que para probar el descarte hace falta una
# imagen distinta: un ticket que salio borroso, que es el caso real.
python3 - "$TMP/otra.png" "$FOLIO" <<'PY'
import sys
try:
    from PIL import Image, ImageDraw, ImageFont
    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", 20)
    img = Image.new("L", (600, 120), 245)
    ImageDraw.Draw(img).text((18, 40), "TICKET BORROSO %s" % sys.argv[2], fill=35, font=font)
    img.save(sys.argv[1])
except ImportError:
    pass
PY
if [ -s "$TMP/otra.png" ]; then
  BORROSA=$(curl -s -X POST "$N/receipt-photos" -H "Authorization: Bearer $MGR" -F "photo=@$TMP/otra.png" \
    | jget "d['photo']['id']")
  TIRADA=$(curl -s -X POST "$N/receipt-photos/$BORROSA/discard" -H "Authorization: Bearer $MGR" \
    -H 'Content-Type: application/json' -d '{"reason":"salio borrosa"}')
  check "descartada con su motivo escrito" "discarded" "$(echo "$TIRADA" | jget "d['photo']['status']")"
  check "el motivo queda guardado" "salio borrosa" "$(echo "$TIRADA" | jget "d['photo']['error']")"
  check "y sigue existiendo: la foto es el comprobante" "$BORROSA" \
    "$(curl -s "$N/receipt-photos/$BORROSA" -H "Authorization: Bearer $MGR" | jget "d['photo']['id']")"
  check "no aparece en la cola de lo que falta capturar" "False" \
    "$(curl -s "$N/receipt-photos?limit=100" -H "Authorization: Bearer $MGR" \
      | jget "'$BORROSA' in [p['id'] for p in d['photos']]")"
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$N/supply-receipts" \
    -H "Authorization: Bearer $MGR" -H 'Content-Type: application/json' \
    -d "{\"location_id\":\"$ALM\",\"photo_id\":\"$BORROSA\",\"lines\":[{\"supply_id\":\"$SID\",\"packages\":1,\"package_cost\":520}]}")
  check "una foto descartada ya no sirve para capturar" "409" "$CODE"
fi

step "7. La imagen solo con el token"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$N/receipt-photos/$PHOTO/image")
check "sin token, la imagen no se sirve" "401" "$CODE"
TIPO=$(curl -s -o /dev/null -w '%{content_type}' "$N/receipt-photos/$PHOTO/image" -H "Authorization: Bearer $MGR")
case "$TIPO" in image/*) green "con token, la imagen se sirve ($TIPO)" ;; *) red "la imagen no se sirvio ($TIPO)" ;; esac
CACHE=$(curl -s -o /dev/null -D - "$N/receipt-photos/$PHOTO/image" -H "Authorization: Bearer $MGR" \
  | tr -d '\r' | grep -i '^cache-control:' | cut -d' ' -f2-)
case "$CACHE" in *private*) green "y marcada como privada ($CACHE)" ;; *) red "la imagen no va marcada como privada ($CACHE)" ;; esac

printf '\n\033[1m%s bien, %s mal\033[0m\n\n' "$ok" "$fail"
[ "$fail" -eq 0 ] || exit 1
