#!/usr/bin/env bash
#
# EV2 — Reiniciar los datos de prueba, con respaldo antes (D70).
#
# Borra toda la ACTIVIDAD (inventario y bodega, noches y eventos, PCs e impresoras,
# pedidos, cobros, reservaciones, propinas, cortes...) y conserva la CONFIGURACIÓN
# (usuarios, carta, recetas, insumos, plano, precios). El detalle, tabla por tabla,
# está en deploy/reiniciar-datos-prueba.sql.
#
# Orden, y ninguno se salta:
#   1. Muestra cuántos registros se van a borrar.
#   2. Saca un respaldo COMPLETO de la base y comprueba que se puede leer.
#   3. Pide escribir BORRAR.
#   4. Borra en una sola transacción: o se borra todo o no se borra nada.
#   5. Borra los archivos de las fotos de tickets (sus registros ya no existen).
#
# Para volver atrás, el comando exacto se imprime al final.
#
# Uso, en el VPS, desde la carpeta del proyecto:
#     bash deploy/reiniciar-datos-prueba.sh
set -euo pipefail

cd "$(dirname "$0")/.."
[ -f .env ] || { echo "No encuentro .env en $(pwd). Corre esto desde la carpeta del proyecto." >&2; exit 1; }

leer_env() { grep -E "^$1=" .env | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'"; }
DB_USER="$(leer_env DB_USER)"; DB_USER="${DB_USER:-postgres}"
DB_NAME="$(leer_env DB_NAME)"; DB_NAME="${DB_NAME:-ev2}"
COMPOSE=(docker compose --env-file .env -f deploy/docker-compose.prod.yml)
psql_() { "${COMPOSE[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }

echo
echo "== 1. Lo que se va a borrar"
psql_ -tA <<'SQL'
SELECT '  Club:                    ' || string_agg(name, ', ') FROM nightclubs;
SELECT '  Movimientos de inventario: ' || (SELECT count(*) FROM supply_movements)
    || '  (existencias en cero: ' || (SELECT count(*) FROM supply_stock WHERE stock <> 0) || ')';
SELECT '  Eventos / noches:          ' || (SELECT count(*) FROM events_calendar)
    || '  (cortes: ' || (SELECT count(*) FROM night_closings)
    || ', rol: ' || (SELECT count(*) FROM shift_assignments) || ')';
SELECT '  PCs / impresoras:          ' || (SELECT count(*) FROM print_agents) || ' / ' || (SELECT count(*) FROM printers)
    || '  (tickets en cola: ' || (SELECT count(*) FROM print_jobs) || ')';
SELECT '  Pedidos:                   ' || (SELECT count(*) FROM drink_orders);
SELECT '  Transacciones (cobros):    ' || (SELECT count(*) FROM transactions);
SELECT '  Reservaciones / pases:     ' || (SELECT count(*) FROM reservations) || ' / ' || (SELECT count(*) FROM guest_passes);
SELECT '  Propinas:                  ' || (SELECT count(*) FROM tips);
SELECT '  Turnos / cortes de caja:   ' || (SELECT count(*) FROM staff_shifts) || ' / ' || (SELECT count(*) FROM shift_closings);
SELECT '  Viajes / valet / retiros:  ' || (SELECT count(*) FROM taxi_requests) || ' / '
    || (SELECT count(*) FROM valet_tickets) || ' / ' || (SELECT count(*) FROM withdrawals);
SELECT '  Se conservan:              ' || (SELECT count(*) FROM users) || ' usuarios, '
    || (SELECT count(*) FROM drinks) || ' productos, ' || (SELECT count(*) FROM supplies) || ' insumos, '
    || (SELECT count(*) FROM tables) || ' mesas';
SQL

echo
echo "== 2. Respaldo completo"
mkdir -p "$HOME/respaldos"
RESPALDO="$HOME/respaldos/ev2-antes-de-reinicio-$(date +%Y%m%d-%H%M%S).dump"
"${COMPOSE[@]}" exec -T postgres pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc > "$RESPALDO"
# Un respaldo que no se puede leer no es un respaldo: se comprueba antes de borrar.
if [ ! -s "$RESPALDO" ] || ! "${COMPOSE[@]}" exec -T postgres pg_restore --list < "$RESPALDO" > /dev/null; then
  echo "  El respaldo salió vacío o ilegible: $RESPALDO. NO se borró nada." >&2
  exit 1
fi
echo "  Guardado y verificado: $RESPALDO ($(du -h "$RESPALDO" | cut -f1))"

echo
echo "== 3. Confirmación"
echo "  Esto NO se puede deshacer más que restaurando el respaldo."
read -r -p "  Escribe BORRAR (en mayúsculas) para continuar: " RESPUESTA
if [ "$RESPUESTA" != "BORRAR" ]; then
  echo "  Cancelado. No se borró nada. El respaldo se queda en $RESPALDO."
  exit 0
fi

echo
echo "== 4. Borrando (una sola transacción)"
psql_ -q < deploy/reiniciar-datos-prueba.sql
echo "  Listo."

echo
echo "== 5. Fotos de tickets"
if "${COMPOSE[@]}" exec -T api sh -c 'find /app/var/receipts -mindepth 1 -delete' 2>/dev/null; then
  echo "  Archivos borrados."
else
  echo "  No se pudieron borrar los archivos (la base ya quedó limpia; las fotos solo ocupan espacio)."
fi

echo
echo "== Resultado"
psql_ -tA <<'SQL'
SELECT '  Pedidos: ' || (SELECT count(*) FROM drink_orders)
    || ' · Transacciones: ' || (SELECT count(*) FROM transactions)
    || ' · Movimientos: ' || (SELECT count(*) FROM supply_movements)
    || ' · Eventos: ' || (SELECT count(*) FROM events_calendar)
    || ' · Impresoras: ' || (SELECT count(*) FROM printers);
SELECT '  Conservado: ' || (SELECT count(*) FROM users) || ' usuarios, '
    || (SELECT count(*) FROM drinks) || ' productos, ' || (SELECT count(*) FROM supplies) || ' insumos, '
    || (SELECT count(*) FROM drink_supplies) || ' renglones de receta, ' || (SELECT count(*) FROM tables) || ' mesas';
SQL
cat <<TXT

  Siguiente: dar de alta de nuevo cada PC de barra (Gerente > Impresoras > código),
  crear el evento de la noche de prueba y hacer el primer conteo físico en Almacén.

  Para DESHACER todo y volver a como estaba antes de este reinicio:
    ${COMPOSE[*]} exec -T postgres pg_restore -U $DB_USER -d $DB_NAME --clean --if-exists < $RESPALDO

TXT
