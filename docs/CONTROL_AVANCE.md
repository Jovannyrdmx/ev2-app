# Hoja de control de avance — EV2 Clandestinoz

Sección 15 del `MANUAL_IMPLEMENTACION_EV2.pdf`. Se llena al terminar cada fase y se
entrega copia al responsable del proyecto.

> **Horas reales:** deliberadamente vacías. El trabajo se hizo en sesiones asistidas sin
> reloj; poner una cifra inventada arruinaría justo lo que esta hoja sirve para medir.
> Las llena Erick con lo que efectivamente dedicó. Las **fechas sí son reales**, tomadas
> de `docs/AVANCE.md`.

## Fases

| Fase | Horas est. | Horas reales | Fecha inicio | Fecha fin | Firma desarrollador | Firma responsable |
|---|---|---|---|---|---|---|
| 0 — Orden y base | 40 | | 2026-09-03 | 2026-09-03 | | |
| 1 — BD y núcleo API | 80 | | 2026-09-03 | 2026-09-03 | | |
| 2 — Persistencia de módulos | 100 | | 2026-09-03 | 2026-09-04 | | |
| 3 — Tiempo real y pagos | 90 | | | | | |
| 4 — SoftRestaurant 11 real | 70 | | | | | |
| 5 — Web conectada | 90 | | | | | |
| 6 — Apps nativas | 150 | | | | | |
| 7 — Servidor y datos reales | 80 | | | | | |
| 8 — Seguridad y cierre | 60 | | | | | |
| **Total** | **760** | | | | | |

## Hitos

| Hito | Descripción | Fecha prevista | Fecha real | Firma |
|---|---|---|---|---|
| H1 | API unificada sobre Postgres, tests en verde | Fin semana 3 | **2026-09-03** ✅ | |
| H2 | Pago sandbox extremo a extremo + tiempo real | Fin semana 7 | | |
| H3 | Pedido de la app aparece en SoftRestaurant 11 de prueba | Fin semana 8 | | |
| H4 | Web completa conectada; staging en HTTPS | Fin semana 9 | | |
| H5 | Piloto 1 en el club | Semana 10 | | |
| H6 | Apps en TestFlight / prueba interna; piloto 2 | Fin semana 12 | | |
| H7 | Producción y apertura completa | Semana 13 | | |

## Estado al cierre de la Fase 2 (2026-09-04)

| Indicador | Valor |
|---|---|
| Migraciones aplicadas | 12 (`001`–`012`), 50 tablas |
| Rutas de la API | 179, **179/179 documentadas** en `openapi.yaml` (comprobado contra el router) |
| Pruebas automatizadas | **453 verdes**, 13 suites, contra PostgreSQL real |
| Cobertura `src/routes` | 93% sentencias (objetivo del manual: 60%) |
| Lint | `eslint src` 0 errores · `redocly lint` válido |
| Módulos en Postgres | Mesas y plano · precios por evento · flirt · empleados y retiros · propinas y canciones · taxi · valet · registro POS |
| Clases heredadas en memoria eliminadas | `dance-floor-manager`, `nightclub-tables`, `flirt-system`, `employee-account-system`, `tip-dancer-system`, `taxi-system`, `valet-parking-system`, `pos-integration-system` |

## Notas e incidencias

Solo defectos reales encontrados y corregidos, con la fecha en que se cerraron.

| Fecha | Paso | Descripción | Resuelto |
|---|---|---|---|
| 2026-09-03 | 0.7 | `docker compose -f deploy/...` buscaba `.env` en `deploy/`, no en la raíz: el arranque fallaba con `DB_PASSWORD is required`. Se documentó `--env-file .env`. | 2026-09-03 |
| 2026-09-03 | 0.7 | El contenedor `web` aparecía `unhealthy` respondiendo 200: el healthcheck usaba `localhost` (IPv6) contra un nginx solo IPv4. | 2026-09-03 |
| 2026-09-03 | 0.9 | El cliente POS heredado asumía una API REST que **no existe** para terceros. Obligó a rediseñar la integración como agente local (D16). | 2026-09-03 |
| 2026-09-03 | 1.3 | `FOR UPDATE` sobre el lado nulo de un `LEFT JOIN` (Postgres `0A000`) al crear pedidos. | 2026-09-03 |
| 2026-09-03 | 1.6 | `transactions.direction` era `CHAR(3)`: Postgres rellenaba `'in'` como `'in '` y rompía la comparación en cualquier cliente. Migración `002`. | 2026-09-03 |
| 2026-09-03 | 1.6 | Al mudarse de mesa, la anterior seguía marcada como ocupada: el mapa mostraba mesas fantasma toda la noche. | 2026-09-03 |
| 2026-09-03 | 2.1 | `nightclub-tables.js` no era código muerto sino el plano real del club, con números de mesa repetidos entre zonas (riesgo de entregar bebidas en la mesa equivocada). Se distinguieron con prefijo de zona. | 2026-09-03 |
| 2026-09-03 | 2.2 | El plano cargado en 2.1 estaba desactualizado (52 mesas contra 55 reales, zonas inexistentes). Se reconstruyó contra el mapa oficial del dueño. | 2026-09-04 |
| 2026-09-04 | 2.6 | Postgres deducía dos tipos distintos para el mismo parámetro (`42P08`) en la consulta de disponibilidad de conductores: la ruta devolvía 500. | 2026-09-04 |
| 2026-09-04 | 2.7 | `GET /dashboard` sumaba **todas** las transacciones pagadas, presentando como venta del club las propinas (del empleado) y las tarifas de taxi (del conductor). Defecto previo que el módulo de taxi habría agravado. Corregido en D23. | 2026-09-04 |
| 2026-09-04 | 2.8 | Mismo `42P08` en el latido del agente POS. Se documentó el patrón en ambos sitios para no repetirlo. | 2026-09-04 |

## Pendientes que no dependen del desarrollo

| Bloquea | Qué hace falta | Responsable |
|---|---|---|
| Fase 3 (3.4 y 3.5) | Cuentas de **Stripe** y **Mercado Pago**: alta del negocio, datos fiscales y llaves de prueba. Tienen tiempos de verificación externos. | Dueño |
| Fase 4 | Formulario a National Soft, guía ERP/PMS, add-ons licenciados, nombre de instancia y base en `192.168.2.108`, y quién administra ese servidor. | Dueño |
| Fase 4 | Ambiente de pruebas del POS: respaldo `.bak` restaurado en una instancia aparte. Nunca contra producción. | Dueño / distribuidor |
| Fase 5 | Cargar tarifas de taxi por zona y cajones del estacionamiento desde la app. | Gerente |
| Fase 7 | Contratar VPS y apuntar un dominio. | Dueño |
| Fase 7 | Elegir con quién y en qué noche se hace el piloto 1. | Dueño |
