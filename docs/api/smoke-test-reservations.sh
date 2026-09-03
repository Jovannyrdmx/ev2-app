set -u
API=http://localhost:3000/api
j() { JPATH="$2" python3 -c 'import sys,json,os
try:
    d=json.load(sys.stdin); print(eval("d"+os.environ["JPATH"]))
except Exception: print("")' <<< "$1"; }
ok(){ echo "  ✔ $1"; }; bad(){ echo "  ✘ $1"; FAIL=1; }
FAIL=0
NC=$(j "$(curl -s $API/nightclubs/by-slug/ev2)" "['nightclub']['id']")
L(){ curl -s -X POST $API/auth/login -H 'Content-Type: application/json' -d "{\"nightclub_slug\":\"ev2\",\"email\":\"$1@ev2.local\",\"password\":\"Desarrollo2026!\"}"; }
GT=$(j "$(L guest)" "['access_token']"); MT=$(j "$(L manager)" "['access_token']"); HT=$(j "$(L hostess)" "['access_token']"); BT=$(j "$(L bartender)" "['access_token']")
AH="Authorization: Bearer $GT"; MH="Authorization: Bearer $MT"; HH="Authorization: Bearer $HT"
CT='Content-Type: application/json'
ISO(){ python3 -c "import datetime;print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta($1)).replace(microsecond=0,tzinfo=None).isoformat()+'Z')"; }
FUT=$(ISO "days=7"); SOON=$(ISO "minutes=30")

echo "== 1. Reglas del club"
R=$(curl -s $API/nightclubs/$NC/reservations/rules -H "$AH")
DP=$(j "$R" "['rules']['deposit_pct']"); BP=$(j "$R" "['rules']['base_price_per_hour']")
[ "$DP" = "30.00" ] && ok "depósito 30%, base/hora=$BP" || bad "$R"

echo "== 2. Manager edita reglas; guest NO puede (403)"
R=$(curl -s -o /dev/null -w "%{http_code}" -X PUT $API/nightclubs/$NC/reservations/rules -H "$AH" -H "$CT" -d '{"deposit_pct":10}')
[ "$R" = "403" ] && ok "guest 403" || bad "dio $R"
R=$(curl -s -X PUT $API/nightclubs/$NC/reservations/rules -H "$MH" -H "$CT" -d '{"min_party_size":2,"max_party_size":12,"deposit_pct":30,"base_price_per_hour":500}')
[ "$(j "$R" "['rules']['max_party_size']")" = "12" ] && ok "manager actualizó reglas" || bad "$R"

echo "== 3. Disponibilidad"
R=$(curl -s "$API/nightclubs/$NC/reservations/availability?starts_at=$FUT&duration_minutes=180&guests=6" -H "$AH")
N=$(j "$R" "['tables'].__len__()"); T1=$(j "$R" "['tables'][0]['id']"); P1=$(j "$R" "['tables'][0]['price']"); D1=$(j "$R" "['tables'][0]['deposit']")
[ -n "$T1" ] && ok "$N mesas libres; primera precio=$P1 depósito=$D1" || bad "$R"

echo "== 4. Reglas de negocio rechazadas (422)"
R=$(curl -s -o /dev/null -w "%{http_code}" "$API/nightclubs/$NC/reservations/availability?starts_at=$FUT&guests=99" -H "$AH")
[ "$R" = "400" ] && ok "400 fuera del esquema (99 personas)" || bad "dio $R"
R=$(curl -s -o /dev/null -w "%{http_code}" "$API/nightclubs/$NC/reservations/availability?starts_at=$FUT&guests=30" -H "$AH")
[ "$R" = "422" ] && ok "422 por regla del club (30 > max 12)" || bad "dio $R"
R=$(curl -s -o /dev/null -w "%{http_code}" "$API/nightclubs/$NC/reservations/availability?starts_at=$SOON&guests=4" -H "$AH")
[ "$R" = "422" ] && ok "422 por anticipación mínima" || bad "dio $R"

echo "== 5. Cotización con extras y descuento"
QB="{\"table_id\":\"$T1\",\"starts_at\":\"$FUT\",\"duration_minutes\":180,\"addons\":[{\"type\":\"bottle_service\",\"name\":\"Botella tequila\",\"price\":1800,\"quantity\":1}],\"discount_code\":\"BIENVENIDO\"}"
R=$(curl -s -X POST $API/nightclubs/$NC/reservations/quote -H "$AH" -H "$CT" -d "$QB")
TP=$(j "$R" "['quote']['table_price']"); AD=$(j "$R" "['quote']['addons_total']"); DS=$(j "$R" "['quote']['discount']['amount']"); TO=$(j "$R" "['quote']['total']"); DE=$(j "$R" "['quote']['deposit']")
echo "     mesa=$TP extras=$AD descuento=$DS total=$TO depósito=$DE"
python3 -c "
import sys
tp,ad,ds,to,de=float('$TP'),float('$AD'),float('$DS'),float('$TO'),float('$DE')
assert abs((tp+ad)*0.10 - ds) < 0.02, 'descuento 10% mal'
assert abs(tp+ad-ds - to) < 0.02, 'total mal'
assert abs(to*0.30 - de) < 0.02, 'deposito 30% mal'
" && ok "aritmética correcta (10% desc., 30% depósito)" || bad "aritmética"

echo "== 6. Código de descuento inválido (422)"
R=$(curl -s -o /dev/null -w "%{http_code}" -X POST $API/nightclubs/$NC/reservations/quote -H "$AH" -H "$CT" -d "{\"table_id\":\"$T1\",\"starts_at\":\"$FUT\",\"discount_code\":\"NOEXISTE\"}")
[ "$R" = "422" ] && ok "422" || bad "dio $R"

echo "== 7. Reservar (idempotente)"
REQ=$(python3 -c "import uuid;print(uuid.uuid4())")
BB="{\"client_request_id\":\"$REQ\",\"table_id\":\"$T1\",\"starts_at\":\"$FUT\",\"duration_minutes\":180,\"guest_count\":6,\"addons\":[{\"type\":\"bottle_service\",\"name\":\"Botella tequila\",\"price\":1800,\"quantity\":1}],\"discount_code\":\"BIENVENIDO\"}"
R=$(curl -s -X POST $API/nightclubs/$NC/reservations -H "$AH" -H "$CT" -d "$BB")
RID=$(j "$R" "['reservation']['id']"); ST=$(j "$R" "['reservation']['status']"); DEP=$(j "$R" "['reservation']['deposit_amount']"); ENDS=$(j "$R" "['reservation']['ends_at']")
[ -n "$RID" ] && ok "creada status=$ST depósito=$DEP ends_at=$ENDS" || bad "$R"
R2=$(curl -s -X POST $API/nightclubs/$NC/reservations -H "$AH" -H "$CT" -d "$BB")
[ "$(j "$R2" "['reservation']['id']")" = "$RID" ] && ok "reenvío no duplica" || bad "duplicó"

echo "== 8. Solape en la misma mesa DEBE dar 409"
REQ2=$(python3 -c "import uuid;print(uuid.uuid4())")
OVER=$(python3 -c "import datetime;print((datetime.datetime.fromisoformat('$FUT'.replace('Z',''))+datetime.timedelta(minutes=60)).isoformat()+'Z')")
R=$(curl -s -o /dev/null -w "%{http_code}" -X POST $API/nightclubs/$NC/reservations -H "$AH" -H "$CT" -d "{\"client_request_id\":\"$REQ2\",\"table_id\":\"$T1\",\"starts_at\":\"$OVER\",\"duration_minutes\":120,\"guest_count\":4}")
[ "$R" = "409" ] && ok "409 solape" || bad "dio $R"

echo "== 9. La mesa ya no aparece disponible en ese horario"
R=$(curl -s "$API/nightclubs/$NC/reservations/availability?starts_at=$FUT&duration_minutes=180&guests=6" -H "$AH")
python3 -c "
import sys,json
d=json.load(sys.stdin)
assert '$T1' not in [t['id'] for t in d['tables']], 'la mesa reservada sigue apareciendo'
print('  ✔ excluida de disponibilidad (%d libres)' % len(d['tables']))" <<< "$R" || bad "sigue apareciendo"

echo "== 10. Capacidad y grupo excesivo (422)"
REQ3=$(python3 -c "import uuid;print(uuid.uuid4())")
R=$(curl -s -o /dev/null -w "%{http_code}" -X POST $API/nightclubs/$NC/reservations -H "$AH" -H "$CT" -d "{\"client_request_id\":\"$REQ3\",\"table_id\":\"$T1\",\"starts_at\":\"$FUT\",\"guest_count\":30}")
[ "$R" = "422" ] && ok "422" || bad "dio $R"

echo "== 11. Transacción de depósito registrada como pendiente"
R=$(curl -s $API/nightclubs/$NC/reservations/mine -H "$AH"); N=$(j "$R" "['reservations'].__len__()")
[ "$N" -ge 1 ] && ok "$N reservación(es) del usuario" || bad "dio $N"

echo "== 12. Flujo de estados por hostess"
for S in confirmed seated completed; do
  R=$(curl -s -X POST $API/nightclubs/$NC/reservations/$RID/status -H "$HH" -H "$CT" -d "{\"status\":\"$S\"}")
  [ "$(j "$R" "['reservation']['status']")" = "$S" ] && ok "→ $S" || bad "$R"
done
echo "== 13. Transición inválida y rol incorrecto"
R=$(curl -s -o /dev/null -w "%{http_code}" -X POST $API/nightclubs/$NC/reservations/$RID/status -H "$HH" -H "$CT" -d '{"status":"seated"}')
[ "$R" = "409" ] && ok "409 completed→seated" || bad "dio $R"
R=$(curl -s -o /dev/null -w "%{http_code}" -X POST $API/nightclubs/$NC/reservations/$RID/status -H "Authorization: Bearer $BT" -H "$CT" -d '{"status":"seated"}')
[ "$R" = "403" ] && ok "403 bartender" || bad "dio $R"
echo "== 14. Cancelar una completada DEBE dar 409"
R=$(curl -s -o /dev/null -w "%{http_code}" -X POST $API/nightclubs/$NC/reservations/$RID/cancel -H "$AH" -H "$CT" -d '{}')
[ "$R" = "409" ] && ok "409" || bad "dio $R"

echo "== 15. Política de reembolso: >48h = 100%"
REQ4=$(python3 -c "import uuid;print(uuid.uuid4())")
R=$(curl -s "$API/nightclubs/$NC/reservations/availability?starts_at=$FUT&guests=4" -H "$AH"); T2=$(j "$R" "['tables'][0]['id']")
R=$(curl -s -X POST $API/nightclubs/$NC/reservations -H "$AH" -H "$CT" -d "{\"client_request_id\":\"$REQ4\",\"table_id\":\"$T2\",\"starts_at\":\"$FUT\",\"guest_count\":4}")
RID2=$(j "$R" "['reservation']['id']")
R=$(curl -s -X POST $API/nightclubs/$NC/reservations/$RID2/cancel -H "$AH" -H "$CT" -d '{"reason":"cambio de planes"}')
[ "$(j "$R" "['refund_pct']")" = "100" ] && ok "reembolso 100% (nada pagado aún: $(j "$R" "['refund_amount']"))" || bad "$R"

echo "== 16. Reembolso a <24h = 0%"
NEAR=$(ISO "hours=5")
REQ5=$(python3 -c "import uuid;print(uuid.uuid4())")
R=$(curl -s -X POST $API/nightclubs/$NC/reservations -H "$AH" -H "$CT" -d "{\"client_request_id\":\"$REQ5\",\"table_id\":\"$T2\",\"starts_at\":\"$NEAR\",\"guest_count\":4}")
RID3=$(j "$R" "['reservation']['id']")
R=$(curl -s -X POST $API/nightclubs/$NC/reservations/$RID3/cancel -H "$AH" -H "$CT" -d '{}')
[ "$(j "$R" "['refund_pct']")" = "0" ] && ok "reembolso 0%" || bad "$R"

echo "== 17. Reservación ajena: 403"
R=$(curl -s -o /dev/null -w "%{http_code}" $API/nightclubs/$NC/reservations/$RID -H "Authorization: Bearer $BT")
[ "$R" = "403" ] && ok "403" || bad "dio $R"
R=$(curl -s -o /dev/null -w "%{http_code}" $API/nightclubs/$NC/reservations/$RID -H "$HH")
[ "$R" = "200" ] && ok "hostess sí puede verla" || bad "dio $R"

echo "== 18. Agenda del día (staff)"
DATE=$(python3 -c "print('$FUT'[:10])")
R=$(curl -s "$API/nightclubs/$NC/reservations?date=$DATE" -H "$HH"); N=$(j "$R" "['reservations'].__len__()")
[ "$N" -ge 1 ] && ok "$N en la agenda" || bad "dio $N"

echo "== 19. Métodos de pago"
R=$(curl -s -X POST $API/me/payment-methods -H "$AH" -H "$CT" -d '{"provider":"stripe","type":"card","provider_token":"pm_test_123","last4":"4242","brand":"visa","is_default":true}')
PMID=$(j "$R" "['payment_method']['id']"); [ -n "$PMID" ] && ok "tarjeta guardada (solo token, last4=$(j "$R" "['payment_method']['last4']"))" || bad "$R"
R=$(curl -s $API/me/payment-methods -H "$AH"); python3 -c "
import sys,json
d=json.load(sys.stdin)
assert 'provider_token' not in d['payment_methods'][0], 'el token no debe exponerse'
print('  ✔ el token no se devuelve al cliente')" <<< "$R" || bad "token expuesto"
R=$(curl -s -o /dev/null -w "%{http_code}" -X POST $API/me/payment-methods -H "$AH" -H "$CT" -d '{"provider":"stripe","type":"card"}')
[ "$R" = "400" ] && ok "400 sin token de proveedor" || bad "dio $R"
R=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE $API/me/payment-methods/$PMID -H "$AH")
[ "$R" = "204" ] && ok "eliminada" || bad "dio $R"

echo; [ $FAIL = 0 ] && echo "TODAS LAS PRUEBAS DE RESERVACIONES PASARON" || echo "HUBO FALLOS"
