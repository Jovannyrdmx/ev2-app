set -u
API=http://localhost:3000/api
j() { JPATH="$2" python3 -c 'import sys,json,os
try:
    d=json.load(sys.stdin); print(eval("d"+os.environ["JPATH"]))
except Exception: print("")' <<< "$1"; }
ok(){ echo "  ✔ $1"; }; bad(){ echo "  ✘ $1"; FAIL=1; }
FAIL=0

echo "== 1. Club público por slug"
R=$(curl -s $API/nightclubs/by-slug/ev2); NC=$(j "$R" "['nightclub']['id']"); [ -n "$NC" ] && ok "id=$NC" || bad "$R"

echo "== 2. Registro (mayor de edad)"
R=$(curl -s -X POST $API/auth/register -H 'Content-Type: application/json' -d "{\"nightclub_slug\":\"ev2\",\"email\":\"nuevo$RANDOM@test.mx\",\"password\":\"Password123\",\"first_name\":\"Nuevo\",\"last_name\":\"Cliente\",\"birth_date\":\"1998-05-10\",\"accept_terms\":true,\"accept_flirts\":true}")
GT=$(j "$R" "['access_token']"); GID=$(j "$R" "['user']['id']"); [ -n "$GT" ] && ok "token emitido" || bad "$R"

echo "== 3. Registro de menor DEBE fallar"
R=$(curl -s -o /dev/null -w "%{http_code}" -X POST $API/auth/register -H 'Content-Type: application/json' -d "{\"nightclub_slug\":\"ev2\",\"email\":\"menor$RANDOM@test.mx\",\"password\":\"Password123\",\"first_name\":\"Menor\",\"birth_date\":\"2012-01-01\",\"accept_terms\":true}")
[ "$R" = "403" ] && ok "403 por edad" || bad "esperaba 403, dio $R"

echo "== 4. Contraseña débil DEBE fallar (400)"
R=$(curl -s -o /dev/null -w "%{http_code}" -X POST $API/auth/register -H 'Content-Type: application/json' -d "{\"nightclub_slug\":\"ev2\",\"email\":\"x$RANDOM@test.mx\",\"password\":\"123\",\"first_name\":\"X\",\"birth_date\":\"1990-01-01\",\"accept_terms\":true}")
[ "$R" = "400" ] && ok "400 validación" || bad "dio $R"

echo "== 5. Login bartender / manager / guest del seed"
for ROLE in bartender manager guest; do
  R=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' -d "{\"nightclub_slug\":\"ev2\",\"email\":\"$ROLE@ev2.local\",\"password\":\"Desarrollo2026!\"}")
  T=$(j "$R" "['access_token']"); eval "${ROLE^^}_T=\$T"; eval "${ROLE^^}_ID=\$(j \"\$R\" \"['user']['id']\")"
  [ -n "$T" ] && ok "$ROLE" || bad "$ROLE: $R"
done

echo "== 6. Credenciales malas DEBE dar 401"
R=$(curl -s -o /dev/null -w "%{http_code}" -X POST $API/auth/login -H 'Content-Type: application/json' -d '{"nightclub_slug":"ev2","email":"manager@ev2.local","password":"incorrecta"}')
[ "$R" = "401" ] && ok "401" || bad "dio $R"

echo "== 7. Sin token DEBE dar 401"
R=$(curl -s -o /dev/null -w "%{http_code}" $API/nightclubs/$NC/drinks); [ "$R" = "401" ] && ok "401" || bad "dio $R"

echo "== 8. Menú (30 bebidas) y categorías"
R=$(curl -s $API/nightclubs/$NC/drinks -H "Authorization: Bearer $GT"); N=$(j "$R" "['drinks'].__len__()")
[ "$N" = "30" ] && ok "30 bebidas" || bad "dio $N"
D1=$(j "$R" "['drinks'][0]['id']")
R=$(curl -s "$API/nightclubs/$NC/drinks?category=beer" -H "Authorization: Bearer $GT"); N=$(j "$R" "['drinks'].__len__()")
[ "$N" = "5" ] && ok "filtro categoría: 5 cervezas" || bad "dio $N"

echo "== 9. Guest pidiendo inventario DEBE dar 403"
R=$(curl -s -o /dev/null -w "%{http_code}" $API/nightclubs/$NC/inventory -H "Authorization: Bearer $GT")
[ "$R" = "403" ] && ok "403" || bad "dio $R"
R=$(curl -s $API/nightclubs/$NC/inventory -H "Authorization: Bearer $BARTENDER_T"); N=$(j "$R" "['inventory'].__len__()")
[ "$N" = "30" ] && ok "bartender sí ve inventario" || bad "dio $N"

echo "== 10. Mesas (20) y sentarse"
R=$(curl -s $API/nightclubs/$NC/tables -H "Authorization: Bearer $GT"); N=$(j "$R" "['tables'].__len__()")
[ "$N" = "20" ] && ok "20 mesas" || bad "dio $N"
T1=$(j "$R" "['tables'][0]['id']"); T1CODE=$(j "$R" "['tables'][0]['code']")
R=$(curl -s -o /dev/null -w "%{http_code}" -X POST $API/nightclubs/$NC/tables/$T1/seat -H "Authorization: Bearer $GT")
[ "$R" = "201" ] && ok "sentado en $T1CODE" || bad "dio $R"
R=$(curl -s $API/nightclubs/$NC/tables -H "Authorization: Bearer $GT"); OCC=$(j "$R" "['tables'][0]['occupants'].__len__()"); ST=$(j "$R" "['tables'][0]['status']")
[ "$OCC" = "1" ] && [ "$ST" = "occupied" ] && ok "mesa ocupada con 1 persona" || bad "occ=$OCC status=$ST"

echo "== 11. Pedido con idempotencia"
REQ=$(python3 -c "import uuid;print(uuid.uuid4())")
BODY="{\"client_request_id\":\"$REQ\",\"table_id\":\"$T1\",\"items\":[{\"drink_id\":\"$D1\",\"quantity\":2}]}"
R=$(curl -s -X POST $API/nightclubs/$NC/orders -H "Authorization: Bearer $GT" -H 'Content-Type: application/json' -d "$BODY")
OID=$(j "$R" "['order']['id']"); SUB=$(j "$R" "['order']['subtotal']"); STAT=$(j "$R" "['order']['status']")
[ -n "$OID" ] && ok "pedido creado subtotal=$SUB status=$STAT" || bad "$R"
R2=$(curl -s -X POST $API/nightclubs/$NC/orders -H "Authorization: Bearer $GT" -H 'Content-Type: application/json' -d "$BODY")
OID2=$(j "$R2" "['order']['id']"); [ "$OID" = "$OID2" ] && ok "reenvío devuelve el mismo pedido (no duplica)" || bad "$OID vs $OID2"

echo "== 12. Stock descontado"
R=$(curl -s $API/nightclubs/$NC/inventory -H "Authorization: Bearer $BARTENDER_T")
Q=$(python3 -c "
import sys,json
d=json.load(sys.stdin)
print([i['quantity'] for i in d['inventory'] if i['drink_id']=='$D1'][0])" <<< "$R")
[ "$Q" = "98.000" ] && ok "stock 100 → $Q" || bad "stock=$Q"

echo "== 13. Cola del bartender y flujo de estados"
R=$(curl -s "$API/nightclubs/$NC/orders?active=true" -H "Authorization: Bearer $BARTENDER_T"); N=$(j "$R" "['orders'].__len__()")
[ "$N" = "1" ] && ok "1 pedido en cola" || bad "dio $N"
for S in confirmed preparing ready delivered; do
  R=$(curl -s -X POST $API/nightclubs/$NC/orders/$OID/status -H "Authorization: Bearer $BARTENDER_T" -H 'Content-Type: application/json' -d "{\"status\":\"$S\"}")
  G=$(j "$R" "['order']['status']"); [ "$G" = "$S" ] && ok "→ $S" || bad "esperaba $S dio: $R"
done

echo "== 14. Transición inválida DEBE dar 409"
R=$(curl -s -o /dev/null -w "%{http_code}" -X POST $API/nightclubs/$NC/orders/$OID/status -H "Authorization: Bearer $BARTENDER_T" -H 'Content-Type: application/json' -d '{"status":"preparing"}')
[ "$R" = "409" ] && ok "409 delivered→preparing" || bad "dio $R"

echo "== 15. Guest no puede cambiar estados ajenos (403)"
REQ2=$(python3 -c "import uuid;print(uuid.uuid4())")
R=$(curl -s -X POST $API/nightclubs/$NC/orders -H "Authorization: Bearer $GT" -H 'Content-Type: application/json' -d "{\"client_request_id\":\"$REQ2\",\"items\":[{\"drink_id\":\"$D1\",\"quantity\":1}]}")
OID3=$(j "$R" "['order']['id']")
R=$(curl -s -o /dev/null -w "%{http_code}" -X POST $API/nightclubs/$NC/orders/$OID3/status -H "Authorization: Bearer $GT" -H 'Content-Type: application/json' -d '{"status":"ready"}')
[ "$R" = "403" ] && ok "403" || bad "dio $R"
echo "== 16. Guest sí puede cancelar el suyo mientras está pending, y el stock vuelve"
R=$(curl -s -X POST $API/nightclubs/$NC/orders/$OID3/status -H "Authorization: Bearer $GT" -H 'Content-Type: application/json' -d '{"status":"cancelled","reason":"me arrepenti"}')
[ "$(j "$R" "['order']['status']")" = "cancelled" ] && ok "cancelado" || bad "$R"
R=$(curl -s $API/nightclubs/$NC/inventory -H "Authorization: Bearer $BARTENDER_T")
Q=$(python3 -c "
import sys,json
d=json.load(sys.stdin)
print([i['quantity'] for i in d['inventory'] if i['drink_id']=='$D1'][0])" <<< "$R")
[ "$Q" = "98.000" ] && ok "stock restaurado a $Q" || bad "stock=$Q"

echo "== 17. Dashboard (solo manager)"
R=$(curl -s -o /dev/null -w "%{http_code}" $API/nightclubs/$NC/dashboard -H "Authorization: Bearer $BARTENDER_T"); [ "$R" = "403" ] && ok "bartender 403" || bad "dio $R"
R=$(curl -s $API/nightclubs/$NC/dashboard -H "Authorization: Bearer $MANAGER_T"); echo "     $(python3 -c "import sys,json;d=json.load(sys.stdin);print(d['tables'],d['orders'])" <<< "$R")"
[ -n "$(j "$R" "['tables']['total']")" ] && ok "dashboard" || bad "$R"

echo "== 18. Eventos registrados"
R=$(curl -s "$API/nightclubs/$NC/events?since_id=0" -H "Authorization: Bearer $BARTENDER_T")
N=$(j "$R" "['events'].__len__()"); ok "$N eventos visibles para bartender"

echo "== 19. Staff y contactos"
R=$(curl -s "$API/nightclubs/$NC/staff" -H "Authorization: Bearer $GT"); N=$(j "$R" "['staff'].__len__()"); [ "$N" = "9" ] && ok "9 miembros de staff" || bad "dio $N"
R=$(curl -s "$API/nightclubs/$NC/emergency-contacts" -H "Authorization: Bearer $GT"); N=$(j "$R" "['contacts'].__len__()"); [ "$N" = "4" ] && ok "4 contactos" || bad "dio $N"

echo "== 20. Refresh rota el token y el viejo ya no sirve"
R=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' -d '{"nightclub_slug":"ev2","email":"guest@ev2.local","password":"Desarrollo2026!"}')
RT=$(j "$R" "['refresh_token']")
R=$(curl -s -X POST $API/auth/refresh -H 'Content-Type: application/json' -d "{\"refresh_token\":\"$RT\"}")
[ -n "$(j "$R" "['access_token']")" ] && ok "refresh emite token nuevo" || bad "$R"
R=$(curl -s -o /dev/null -w "%{http_code}" -X POST $API/auth/refresh -H 'Content-Type: application/json' -d "{\"refresh_token\":\"$RT\"}")
[ "$R" = "401" ] && ok "reutilizar el viejo: 401" || bad "dio $R"

echo "== 21. Otro club DEBE dar 403"
R=$(curl -s -o /dev/null -w "%{http_code}" $API/nightclubs/00000000-0000-4000-8000-000000000999/drinks -H "Authorization: Bearer $GT")
[ "$R" = "403" ] && ok "403 aislamiento entre clubes" || bad "dio $R"

echo "== 22. Ruta inexistente 404 JSON"
R=$(curl -s $API/no-existe -H "Authorization: Bearer $GT"); [ -n "$(j "$R" "['error']['code']")" ] && ok "404 con JSON" || bad "$R"

echo; [ $FAIL = 0 ] && echo "TODAS LAS PRUEBAS PASARON" || echo "HUBO FALLOS"
