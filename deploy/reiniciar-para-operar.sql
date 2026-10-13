-- EV2 — Dejar la base lista para empezar a operar (2026-10-13).
--
-- Pedido por Jovanny. Sacar SIEMPRE un respaldo antes (ver docs/DESPLIEGUE.md).
--
-- SE BORRA (la actividad de las pruebas):
--   pedidos, cobros y libro de transacciones, cobros con terminal y devoluciones, pagos
--   manuales y comprobantes, reservaciones con sus pases, crédito y extras, puerta
--   (entradas y revisiones de INE), propinas, tragos al personal y consumos del personal,
--   canciones, turnos, cortes de caja y de noche, mesas ocupadas, taxis, salidas, valet,
--   retiros, flirts, reportes, objetos perdidos, comisiones de RP generadas, checadas de
--   asistencia y la cola de impresión.
--   PCs (agentes) desactivadas, impresoras desactivadas o de una PC desactivada, y
--   terminales que no están activas y en modo PDV.
--
-- NO SE TOCA: eventos (calendario, precios y promociones por noche, rol de la noche),
--   personal y usuarios, RPs, inventario completo (insumos, existencias, kardex,
--   entradas, pedidos a bodega, sustituciones), carta y recetas, mesas y precios, covers,
--   cuentas para transferir, PCs/impresoras/terminales que funcionan, configuración.
--
-- Un solo bloque: si algo falla (por ejemplo, una tabla que no está en el repositorio
-- apunta a una que se vacía), no se borra NADA.
\set ON_ERROR_STOP on

BEGIN;

DO $$
BEGIN
  IF (SELECT count(*) FROM nightclubs) <> 1 THEN
    RAISE EXCEPTION 'Hay % clubes en la base; este reinicio es para un solo club. No se borró nada.',
      (SELECT count(*) FROM nightclubs);
  END IF;
END
$$;

-- Lo que se va a borrar de equipos, para que quede en pantalla.
SELECT 'PC a borrar' AS que, name AS nombre FROM print_agents WHERE NOT active
UNION ALL
SELECT 'Impresora a borrar', p.name FROM printers p LEFT JOIN print_agents a ON a.id = p.agent_id
 WHERE NOT p.active OR (a.id IS NOT NULL AND NOT a.active)
UNION ALL
SELECT 'Terminal a borrar', label FROM payment_terminals
 WHERE NOT active OR operating_mode IS DISTINCT FROM 'PDV';

TRUNCATE TABLE
  print_jobs,
  drink_order_items, drink_orders,
  terminal_charge_events, terminal_refunds, terminal_charges,
  manual_payments, transactions,
  reservation_credit_movements, reservation_credits, reservation_addons,
  rp_attributions, rp_settlements,
  guest_pass_events, guest_passes, door_admissions, door_id_checks, reservations,
  tips, staff_drinks, staff_consumptions, song_request_votes, song_requests,
  shift_cash_drops, shift_declarations, shift_closings, staff_shifts, night_closings,
  table_occupants, taxi_requests, guest_departures, valet_tickets, withdrawals,
  flirt_reactions, flirts, user_reports, lost_items, clock_events
RESTART IDENTITY;

-- Equipos que no se usan.
DELETE FROM printers p
 WHERE NOT p.active
    OR p.agent_id IN (SELECT id FROM print_agents WHERE NOT active);
DELETE FROM print_agents WHERE NOT active;
DELETE FROM payment_terminals WHERE NOT active OR operating_mode IS DISTINCT FROM 'PDV';

-- Estado limpio de lo que se conserva.
UPDATE tables SET status = 'available', updated_at = now() WHERE status IN ('occupied', 'reserved');
UPDATE reservation_discounts SET used_count = 0 WHERE used_count <> 0;
UPDATE drivers SET availability = 'off' WHERE availability = 'on_trip';

INSERT INTO audit_log (nightclub_id, action, entity, after)
SELECT id, 'go_live_reset', 'database',
       jsonb_build_object('script', 'deploy/reiniciar-para-operar.sql', 'requested_by', 'Jovanny')
  FROM nightclubs;

-- Lo que quedó.
SELECT (SELECT count(*) FROM events_calendar) AS eventos,
       (SELECT count(*) FROM users WHERE role NOT IN ('guest')) AS personal,
       (SELECT count(*) FROM rp_profiles) AS rps,
       (SELECT count(*) FROM supplies) AS insumos,
       (SELECT count(*) FROM print_agents) AS pcs,
       (SELECT count(*) FROM printers) AS impresoras,
       (SELECT count(*) FROM payment_terminals) AS terminales,
       (SELECT count(*) FROM transactions) AS cobros,
       (SELECT count(*) FROM reservations) AS reservaciones;

COMMIT;
