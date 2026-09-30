-- EV2 — Reiniciar los datos de prueba (D70).
--
-- Lo corre deploy/reiniciar-datos-prueba.sh, que antes saca un respaldo completo y pide
-- confirmación. No correr este archivo a mano sin ese respaldo.
--
-- Qué SE BORRA (toda la actividad de las pruebas):
--   inventario y bodega: kardex, entradas, fotos de tickets, pedidos de barra
--   noches:              calendario de eventos (y sus precios por evento), cortes
--                        guardados y rol de la noche
--   impresión:           PCs de barra, impresoras, cola de impresión y códigos de alta
--   actividad:           pedidos, cobros, libro de transacciones, terminal y devoluciones,
--                        pagos manuales, reservaciones, pases, puerta, propinas, tragos al
--                        personal, canciones, turnos y cortes de caja, mesas ocupadas,
--                        viajes, valet, retiros, flirts, reportes y objetos perdidos
--
-- Qué SE PONE EN CERO (la fila se queda, la configuración también):
--   existencias (el mínimo por estante se conserva), costo promedio de los insumos,
--   estado de las mesas, usos de los códigos de descuento, conductores en viaje
--
-- Qué NO SE TOCA: usuarios y sus PIN/contraseñas, personal y cuentas bancarias, carta,
--   recetas, insumos, proveedores, barras y su ruteo, plano de mesas, precios, covers,
--   paquetes, reglas, conductores, cajones, terminales, configuración de impresión,
--   tipo de cambio, bitácora de auditoría.
--
-- Por qué TRUNCATE y sin CASCADE: TRUNCATE no dispara los candados de "solo inserción"
-- (kardex, libro, cortes), que protegen contra un borrado de fila suelta, no contra un
-- reinicio deliberado. Y SIN CASCADE, si una tabla que se conserva apuntara a una que se
-- vacía, Postgres se niega y no se borra NADA: el script falla cerrado.
\set ON_ERROR_STOP on

BEGIN;

-- Un solo club. Si algún día hay dos, este script no sabe a cuál reiniciar: se detiene.
DO $$
BEGIN
  IF (SELECT count(*) FROM nightclubs) <> 1 THEN
    RAISE EXCEPTION 'Hay % clubes en la base; este reinicio es para un solo club. No se borró nada.',
      (SELECT count(*) FROM nightclubs);
  END IF;
END
$$;

-- Toda tabla tiene que estar clasificada. Una migración nueva agrega una tabla que este
-- script no conoce: mejor detenerse que adivinar si se borra.
DO $$
DECLARE
  conocidas text[] := ARRAY[
    -- se vacían (40)
    'supply_movements','receipt_photos','bar_requests','bar_request_lines',
    'events_calendar','event_zone_pricing','night_closings','shift_assignments',
    'print_jobs','printers','print_agents','print_agent_invites',
    'drink_orders','drink_order_items','transactions','terminal_charges',
    'terminal_charge_events','terminal_refunds','manual_payments','reservations',
    'reservation_addons','guest_passes','guest_pass_events','door_admissions',
    'door_id_checks','tips','staff_drinks','song_requests','song_request_votes',
    'shift_closings','shift_cash_drops','staff_shifts','table_occupants',
    'taxi_requests','valet_tickets','withdrawals','flirts','flirt_reactions',
    'user_reports','lost_items',
    -- se conservan, algunas con valores en cero (48)
    'account_deletions','audit_log','cover_prices','delivery_points','drink_supplies',
    'drinks','drivers','emergency_contacts','employee_bank_accounts','employee_profiles',
    'events','exchange_rates','manual_payment_options','nightclub_print_settings',
    'nightclubs','oauth_handoffs','oauth_states','parking_spots','payment_methods',
    'payment_terminals','pin_attempts','pos_integrations','pos_sync_log','pricing_rules',
    'realtime_relay_state','refresh_tokens','reservation_discounts','reservation_products',
    'reservation_rules','schema_migrations','suppliers','supplies','supply_locations',
    'supply_stock','supply_suppliers','tables','taxi_fares','taxi_settings','tip_presets',
    'user_blocks','user_devices','user_identities','user_preferences','users',
    'valet_settings','venue_landmarks','zone_bars','zone_pricing'];
  nuevas text;
BEGIN
  SELECT string_agg(tablename, ', ') INTO nuevas
    FROM pg_tables
   WHERE schemaname = 'public' AND tablename <> ALL (conocidas);
  IF nuevas IS NOT NULL THEN
    RAISE EXCEPTION 'Tablas sin clasificar en este script: %. No se borró nada.', nuevas;
  END IF;
END
$$;

TRUNCATE TABLE
  -- inventario y bodega
  supply_movements, receipt_photos, bar_request_lines, bar_requests,
  -- noches
  night_closings, shift_assignments, event_zone_pricing, events_calendar,
  -- impresión
  print_jobs, print_agent_invites, printers, print_agents,
  -- actividad
  drink_order_items, drink_orders, transactions, terminal_charge_events,
  terminal_charges, terminal_refunds, manual_payments, reservation_addons,
  reservations, guest_pass_events, guest_passes, door_admissions, door_id_checks,
  tips, staff_drinks, song_request_votes, song_requests, shift_cash_drops,
  shift_closings, staff_shifts, table_occupants, taxi_requests, valet_tickets,
  withdrawals, flirt_reactions, flirts, user_reports, lost_items
RESTART IDENTITY;

-- Existencias en cero; el mínimo por estante es configuración y se queda.
UPDATE supply_stock SET stock = 0, updated_at = now() WHERE stock <> 0;
-- Sin entradas no hay costo promedio: el primero lo pone la próxima recepción.
UPDATE supplies SET avg_cost = 0 WHERE avg_cost <> 0;
-- Mesas libres (bloqueadas o en limpieza se respetan: eso lo decide el gerente).
UPDATE tables SET status = 'available', updated_at = now()
 WHERE status IN ('occupied', 'reserved');
-- Los códigos de descuento vuelven a tener todos sus usos.
UPDATE reservation_discounts SET used_count = 0 WHERE used_count <> 0;
-- Un conductor "en viaje" sin viaje se queda atorado: vuelve a desconectado.
UPDATE drivers SET availability = 'off' WHERE availability = 'on_trip';

-- Constancia en la bitácora: quién preguntó "¿por qué está todo vacío?" lo encuentra aquí.
INSERT INTO audit_log (nightclub_id, action, entity, after)
SELECT id, 'test_data_reset', 'database',
       jsonb_build_object('script', 'deploy/reiniciar-datos-prueba.sh', 'decision', 'D70')
  FROM nightclubs;

COMMIT;
