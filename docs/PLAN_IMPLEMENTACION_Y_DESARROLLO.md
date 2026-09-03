# PLAN DE IMPLEMENTACIÓN Y DESARROLLO — EV2 CLANDESTINOZ

**Fecha:** 3 de septiembre de 2026
**Objetivo:** llevar el sistema EV2 (backend + web + iOS + Android) desde su estado actual de prototipo a un entorno de servidor con datos reales, integrado con SoftRestaurant11, en un VPS Linux con Docker.
**Alcance elegido:** todos los módulos en paralelo, con integración real de POS.

---

## 1. Diagnóstico honesto del estado actual

La documentación de la carpeta dice "100% production ready", pero al revisar el código real la situación es distinta. Este plan parte de lo que existe de verdad, no de lo que dicen los resúmenes.

### 1.1 Lo que sí existe y sirve de base

| Componente | Archivo(s) | Estado real |
|---|---|---|
| API principal (Express + Postgres + Redis + WS) | `server/nightclub-api.js` | Funcional en concepto: auth JWT, bebidas, inventario, pedidos, mesas, dashboard, webhook SoftRestaurant11 (17 endpoints, no 80). |
| Servidor WebSocket "connect" | `server/server.js` | Funciona, pero con **estado en memoria** (5 mesas fijas). Se pierde todo al reiniciar. |
| API de reservaciones | `server/reservations-api.js` | Router completo (8 rutas) con Stripe, **pero nunca se monta** en la API principal. `stripe` no está en `package.json`. |
| Esquema de base de datos | `server/init-nightclub.sql`, `init-reservations.sql`, `init.sql` | Tres esquemas distintos y parcialmente duplicados (`users`, `inventory`, `drink_orders` aparecen en dos). Solo `init-nightclub.sql` se carga en Docker. |
| Módulos de negocio | `dance-floor-manager.js`, `flirt-system.js`, `employee-account-system.js`, `pos-integration-system.js`, `pricing-system.js`, `taxi-system.js`, `tip-dancer-system.js`, `valet-parking-system.js`, `nightclub-tables.js` | Lógica bien pensada, **pero 100% en memoria** (cero consultas a base de datos) y **ninguno está conectado** a rutas HTTP. Son clases sueltas. |
| Web apps | `index-ev2-branded.html`, `table-selector.html`, `tip-dancers-system.html`, `employee-portal.html`, `safe-departure.html`, `pricing-dance-floor-flirt.html` | Interfaces completas y con marca, **pero ninguna hace `fetch()` a la API**. Todo es datos simulados en JS. Solo `index.html` abre un WebSocket. |
| iOS | 11 archivos `.swift` (SwiftUI, MVVM, WebSocket, reservaciones) | Código fuente suelto, **sin proyecto Xcode** (`.xcodeproj`), sin assets, sin `Info.plist`. |
| Android | `EV2Android.kt`, `ReservationSystem.kt` | Código fuente suelto, **sin proyecto Gradle**, sin manifest. |
| Infraestructura | `docker-compose.yml`, 3 Dockerfiles, `nginx-nightclub.conf`, `.env.example` | Estructura correcta (postgres, redis, api, ws, web, nginx). Detalles rotos: el Dockerfile web sirve `index.html` en lugar de `index-ev2-branded.html`; `Dockerfile.nightclub` copia solo `nightclub-api.js` (los demás módulos no entran a la imagen); `package.json` apunta a `connect-server.js`, que no existe. |

### 1.2 Problemas concretos que hay que corregir antes de cualquier prueba real

1. `redis.createClient({ host, port })` usa la sintaxis de redis v3; con redis v4 (la que está en `package.json`) hay que usar `{ url }` o `{ socket: { host, port } }` y llamar `connect()`. Hoy Redis nunca conecta.
2. `reservations-api.js` y `stripe` no están integrados ni instalados.
3. Tres archivos SQL con tablas duplicadas: hay que unificar en un solo esquema con migraciones.
4. No hay control de versiones (no existe `.git`). Cualquier cambio sin git es riesgo.
5. No hay `package-lock.json`, ni tests, ni linter.
6. `.env` está en la carpeta junto a `.env.example`; hay que asegurarse de que nunca suba a git ni al servidor con valores de desarrollo.
7. Los módulos de negocio guardan dinero (propinas, retiros, pagos de reservación) en memoria: en producción eso es inaceptable.
8. Ningún frontend está conectado al backend: hay que definir un cliente API común (`api.js`) y reemplazar datos simulados.

### 1.3 Conclusión del diagnóstico

Se tiene un **prototipo visual y arquitectónico muy avanzado** (diseño, flujos, marca, esquema, lógica de negocio), y un backend base real. Lo que falta es el trabajo de **integración y persistencia**: unir las piezas, guardar en base de datos, conectar las pantallas, y desplegar. Eso es exactamente lo que este plan organiza.

---

## 2. Arquitectura objetivo

```
                    Internet
                       │
               ┌───────▼────────┐
               │  Nginx (80/443)│  SSL Let's Encrypt, rate-limit
               └──┬─────┬────┬──┘
                  │     │    │
        /  ───────┘     │    └──────── /ws
   ┌────▼─────┐   ┌─────▼─────┐   ┌────▼──────┐
   │ Web app  │   │ API REST  │   │ WS server │
   │ (static) │   │ :3000     │   │ :4000     │
   └──────────┘   └──┬─────┬──┘   └────┬──────┘
                     │     │           │
              ┌──────▼─┐ ┌─▼──────┐    │  pub/sub
              │Postgres│ │ Redis  │◄───┘
              └────────┘ └────────┘
                     │
              ┌──────▼──────────────┐
              │ SoftRestaurant11    │  sync menú/inventario, órdenes, webhooks
              └─────────────────────┘

   Apps móviles (iOS / Android) ──► API REST + WS (mismo contrato que la web)
```

Decisiones de arquitectura:

- **Una sola API** (`nightclub-api.js`) que monta routers por módulo: `/api/auth`, `/api/nightclubs`, `/api/reservations`, `/api/employees`, `/api/tips`, `/api/taxi`, `/api/valet`, `/api/pricing`, `/api/pos`. Los módulos en memoria se convierten en **servicios con repositorio Postgres**.
- **Un solo esquema SQL** con migraciones numeradas (`migrations/001_init.sql`, `002_reservations.sql`, …) aplicadas con `node-pg-migrate` o un script propio.
- **WS server** deja de guardar estado propio: lee y escribe en Postgres y usa **Redis pub/sub** para que la API pueda emitir eventos (pedido listo, propina recibida, taxi confirmado) a los clientes conectados.
- **Frontend web**: se mantiene HTML + Tailwind sin build, pero con un módulo compartido `web/js/api.js` (token, fetch, WS) que usan todas las pantallas.
- **Móvil**: los archivos existentes se colocan dentro de proyectos reales (Xcode / Android Studio) y consumen el mismo contrato de API documentado en OpenAPI.
- **Pagos**: Stripe para tarjeta/Apple Pay/Google Pay; **Mercado Pago** para México (tarjeta, OXXO, SPEI). Zelle y Cash App no tienen API pública: se manejan como "pago manual verificado por staff".

---

## 3. Fases, entregables y criterios de aceptación

Estimación total: **12 a 14 semanas** con una persona de tiempo completo (o 7 a 8 semanas con dos). Las fases 2 a 5 pueden solaparse parcialmente.

### FASE 0 — Orden y base de trabajo (Semana 1)

Tareas:

1. Inicializar git en `EV2-app`, `.gitignore` (node_modules, `.env`, `ssl/`, `Thumbs.db`), primer commit y repositorio remoto privado (GitHub/GitLab).
2. Reorganizar carpetas sin romper nada:
   ```
   EV2-app/
   ├── server/            # API + WS
   │   ├── src/routes/    # un archivo por módulo
   │   ├── src/services/  # lógica (los módulos actuales, refactorizados)
   │   ├── src/db/        # pool, repositorios
   │   ├── migrations/    # SQL numerado
   │   └── tests/
   ├── web/               # los HTML de la app + js/api.js + images/
   ├── mobile/ios/        # proyecto Xcode
   ├── mobile/android/    # proyecto Gradle
   ├── docs/              # toda la documentación actual (los .md/.txt)
   ├── deploy/            # docker-compose, nginx, scripts
   └── README.md
   ```
3. Mover los 60+ archivos de documentación a `docs/` para que la raíz sea navegable.
4. Corregir `package.json` (scripts reales, agregar `stripe`, `dotenv`, `helmet`, `express-rate-limit`, `pino`, `jest`, `supertest`, `eslint`) y generar `package-lock.json`.
5. Corregir el cliente Redis (v4) y los Dockerfiles (copiar `src/` completo, servir `index-ev2-branded.html`).
6. Arrancar `docker compose up` en local y confirmar `/health` de API y WS.

Criterio de aceptación: `docker compose up` levanta los 6 servicios sanos en una máquina limpia; el repositorio está en remoto; `.env` no está versionado.

### FASE 1 — Base de datos unificada y núcleo de la API (Semanas 2–3)

Tareas:

1. Unificar los tres SQL en un esquema único. Tablas mínimas: `nightclubs`, `users` (roles: guest, bartender, waiter, dancer, dj, light_tech, valet, hostess, manager, admin), `tables` (con posición x/y, radio, sección, capacidad), `table_occupants`, `drinks`, `inventory`, `drink_orders`, `flirts`, `reservations` (+ pagos, addons, reglas, descuentos), `employees` (+ cuentas bancarias MX/US, moneda preferida), `tips`, `song_requests`, `taxi_rides` (+ códigos de conducta), `valet_vehicles`, `parking_spots`, `pricing_rules`, `pos_integrations`, `transactions` (libro contable único), `audit_log`.
2. Migraciones numeradas y script `npm run migrate`. Seeds de desarrollo (1 club, 20 mesas, 30 bebidas, 10 usuarios de prueba).
3. Refactor de `nightclub-api.js` a routers por módulo; middleware común (auth JWT con refresh token, validación con `zod`, manejo de errores, rate-limit, helmet, logs estructurados).
4. Montar `reservations-api.js` como router real.
5. Documentar el contrato en `server/openapi.yaml` (se usa después para web y móvil).
6. Tests de integración con `supertest` contra Postgres de prueba: auth, pedidos, mesas, reservaciones.

Criterio de aceptación: todas las rutas responden contra Postgres real; suite de tests en verde; OpenAPI publicado en `/api/docs`.

### FASE 2 — Persistencia de los módulos de negocio (Semanas 3–5)

Cada clase en memoria se convierte en servicio + repositorio Postgres + rutas. Orden sugerido (por dependencia y riesgo financiero):

| Módulo | Origen | Rutas nuevas | Nota clave |
|---|---|---|---|
| Mesas / pista | `dance-floor-manager.js`, `nightclub-tables.js` | `GET/PUT /nightclubs/:id/tables`, `POST .../seat`, `POST .../release`, `PUT .../layout` | Editor de layout guarda coordenadas; el WS emite `table_updated`. |
| Precios | `pricing-system.js` | `GET/PUT /nightclubs/:id/pricing` | Reglas por día/hora/sección/evento; cálculo en servidor, nunca en cliente. |
| Flirt | `flirt-system.js` | `POST /flirts`, `GET /flirts/received`, `POST /flirts/:id/react` | Requiere consentimiento (opt-in del usuario a recibir) y bloqueo/reporte. |
| Empleados y cuentas | `employee-account-system.js` | `POST /employees`, `GET /employees/me/dashboard`, `POST /employees/me/bank-accounts`, `POST /employees/me/withdrawals` | Guardar CLABE/cuenta cifrada; tipo de cambio en tabla con histórico, no constante. |
| Propinas y canciones | `tip-dancer-system.js` | `POST /tips`, `POST /song-requests`, `GET /staff/:id/earnings` | Cada propina crea fila en `transactions`. Idempotencia por `client_request_id`. |
| Salida segura / taxi | `taxi-system.js` | `POST /taxi/requests`, `POST /taxi/:id/confirm`, `GET /taxi/:id/code` | Código de conducta con expiración; contactos de emergencia por club. |
| Valet | `valet-parking-system.js` | `POST /valet/checkin`, `POST /valet/request`, `POST /valet/checkout`, `GET /valet/dashboard` | Ticket con QR; notificación WS al cliente cuando el auto está listo. |
| POS | `pos-integration-system.js` | `POST /pos/integrations`, `POST /pos/test`, `POST /pos/webhook` | Ver Fase 4. |

Criterio de aceptación: ninguna clase mantiene estado en memoria; reiniciar el contenedor no pierde datos; cada módulo tiene tests.

### FASE 3 — Tiempo real y pagos (Semanas 5–7)

Tiempo real:

1. WS server (`server.js`) pasa a autenticar por JWT en la conexión y a suscribirse a Redis pub/sub.
2. La API publica eventos: `order_created`, `order_ready`, `order_delivered`, `table_updated`, `flirt_received`, `tip_received`, `song_requested`, `taxi_confirmed`, `vehicle_ready`, `reservation_paid`.
3. Canales por rol: bartender ve pedidos de su barra; mesero ve sus mesas; bailarina/DJ ve sus propinas; valet ve solicitudes.

Pagos:

1. **Stripe**: PaymentIntents (no `charges.create`, que está obsoleto), Apple Pay / Google Pay vía Payment Request; webhooks firmados para confirmar.
2. **Mercado Pago** (México): Checkout Pro + webhooks; OXXO y SPEI como métodos.
3. Zelle / Cash App / depósito: estado `pending_manual` y pantalla para que manager confirme.
4. Reservación: depósito 30% con PaymentIntent; cancelación con política de reembolso ejecutada por webhook.
5. Retiros de empleados: en la primera versión, **solo registro y aprobación manual** por manager (payout real a CLABE/ACH queda para una fase posterior, requiere cuenta Stripe Connect o proveedor local).

Criterio de aceptación: pago de prueba real en modo sandbox de Stripe y Mercado Pago de extremo a extremo; el bartender ve un pedido en menos de 1 segundo tras crearlo desde otra pestaña.

### FASE 4 — Integración real con SoftRestaurant11 (Semanas 6–8)

Como sí hay credenciales, esta fase se hace contra el POS real, pero **primero en una sucursal/base de prueba** del POS, nunca contra la caja activa del club.

1. Confirmar con la documentación oficial de SoftRestaurant11 (Nacional Software) qué expone realmente: API REST, conector SQL Server, o exportación por archivos. El código actual asume `/api/tables`, `/api/menu/drinks`, `/api/orders`; es probable que las rutas y la autenticación reales sean distintas. Ajustar `SoftRestaurant11Client`.
2. Sincronización de catálogo: menú y precios del POS → tabla `drinks` (job cada N minutos + endpoint manual).
3. Sincronización de inventario: existencias del POS → `inventory`; bloquear pedido si no hay stock.
4. Envío de comandas: pedido en la app → orden en el POS con mesa correcta; guardar `pos_order_id`.
5. Webhooks o polling de estado (preparado, entregado, cobrado) → actualiza `drink_orders` y emite WS.
6. Conciliación diaria: reporte que compara ventas de la app vs. POS.
7. Simulador `pos-mock` (Express pequeño) para que los tests y el entorno local no dependan del POS real.

Criterio de aceptación: un pedido hecho desde la web aparece en la pantalla de SoftRestaurant11 de prueba con la mesa correcta y el estado regresa a la app.

### FASE 5 — Conectar las apps web a la API (Semanas 7–9)

1. Crear `web/js/api.js`: login, almacenamiento seguro de token, `apiFetch()`, reconexión de WS, manejo de errores, cambio de idioma ES/EN y moneda MXN/USD.
2. Reemplazar los datos simulados pantalla por pantalla:
   - `index-ev2-branded.html` → mesas, bebidas, pedidos, flirt (núcleo cliente).
   - `table-selector.html` → layout real y reservación con pago.
   - `tip-dancers-system.html` → staff real, propinas, canciones.
   - `employee-portal.html` → registro, dashboard de ganancias, cuentas bancarias, retiros.
   - `safe-departure.html` → solicitud de taxi, código de conducta.
   - `pricing-dance-floor-flirt.html` → panel de manager (precios, layout).
   - Nueva: `bartender.html` / `staff.html` (cola de pedidos en tiempo real) y `valet.html`.
3. Roles y rutas protegidas (redirigir según rol al iniciar sesión).
4. PWA básica: `manifest.json` + service worker para que en el club funcione como app instalada en el teléfono mientras las apps nativas llegan a las tiendas.
5. Pruebas de usabilidad en teléfono real con poca luz y una mano (contexto de club).

Criterio de aceptación: un flujo completo de cliente (entrar, sentarse, pedir, pagar, enviar bebida, pedir taxi) y uno de staff (recibir pedido, entregar, ver propinas) funcionan solo con datos del servidor.

### FASE 6 — Apps nativas iOS y Android (Semanas 8–12)

Se ejecuta después de que la API sea estable (fin de Fase 3), para no reescribir dos veces.

iOS:

1. Crear proyecto Xcode (`mobile/ios/EV2`), SwiftUI, iOS 16+, incorporar los 11 archivos existentes y corregir compilación.
2. Generar cliente desde `openapi.yaml`; sustituir URLs fijas por configuración por entorno.
3. Apple Pay (merchant ID, certificado), notificaciones push (APNs), Keychain para token.
4. TestFlight interno.

Android:

1. Proyecto Android Studio (`mobile/android`), Compose, minSdk 26, incorporar los 2 archivos y completar lo que falta (navegación, Retrofit, OkHttp WS, DataStore).
2. Google Pay, FCM, EncryptedSharedPreferences.
3. Pruebas internas en Play Console.

Criterio de aceptación: ambas apps compilan en CI, pasan el flujo de cliente completo contra el servidor de staging, y están en TestFlight / prueba interna.

### FASE 7 — Servidor, staging y datos reales (Semanas 9–11, en paralelo con Fase 6)

Infraestructura (VPS Linux con Docker):

1. VPS Ubuntu 24.04, 4 vCPU / 8 GB RAM / 80 GB SSD (Hetzner CPX31 o DigitalOcean equivalente, ~20–30 USD/mes). Dominio y subdominios: `app.`, `api.`, `staging.`.
2. Hardening: usuario no root, SSH por llave, `ufw` (22, 80, 443), `fail2ban`, actualizaciones automáticas.
3. Docker + Docker Compose; `docker-compose.prod.yml` con: sin puertos expuestos de Postgres/Redis, límites de memoria, `restart: always`, logs rotados.
4. SSL con Let's Encrypt (certbot o Caddy en lugar de nginx si se quiere menos mantenimiento).
5. Respaldos: `pg_dump` diario a almacenamiento externo (S3/Backblaze), retención 30 días, prueba de restauración mensual.
6. Monitoreo: Uptime Kuma o Better Uptime para `/health`; alertas por WhatsApp/Telegram/email; logs con Loki o simplemente `docker logs` + rotación al inicio.
7. CI/CD con GitHub Actions: lint + tests en cada PR; en `main` construye imágenes, las sube a GHCR y despliega a staging por SSH; despliegue a producción con aprobación manual.

Datos reales (proceso de "local → servidor"):

1. **Staging** primero con copia anonimizada del catálogo real del POS y usuarios de prueba.
2. Cargar datos reales del club: layout real de mesas (con el editor), menú y precios reales desde SoftRestaurant11, lista real de staff con roles, reglas de reservación y precios reales.
3. Piloto controlado: una noche, una sección del club, 3–5 meseros y 1 bartender, pagos en sandbox o solo efectivo/POS. Medir errores y latencia.
4. Segundo piloto con pagos reales en montos pequeños.
5. Corte a producción: cambio de claves sandbox → live, `JWT_SECRET` nuevo, `ALLOWED_ORIGINS` real, respaldos verificados.

Criterio de aceptación: staging accesible por HTTPS con datos reales del club; piloto de una noche completado con incidencias documentadas; runbook de despliegue y rollback escrito.

### FASE 8 — Seguridad, cumplimiento y cierre (Semanas 11–13)

1. Revisión de seguridad: OWASP top 10 sobre la API, dependencias (`npm audit`), secretos fuera del código, CORS estricto, cookies `HttpOnly` o tokens de corta vida con refresh.
2. Datos personales: aviso de privacidad (LFPDPPP en México), consentimiento explícito para flirt y ubicación, borrado de cuenta, retención de datos de taxi/código de conducta.
3. Datos financieros: nunca guardar PAN de tarjetas (Stripe/Mercado Pago tokenizan); cifrar CLABE/cuentas bancarias en reposo (`pgcrypto`); libro `transactions` inmutable con `audit_log`.
4. Términos de uso y código de conducta visibles y aceptados en registro.
5. Manuales operativos cortos (una hoja por rol: mesero, bartender, bailarina/DJ, valet, manager) en `docs/operacion/`.
6. Capacitación al staff y plan de soporte para las primeras 4 semanas.

Criterio de aceptación: checklist de seguridad firmado; documentación operativa entregada; plan de soporte activo.

---

## 4. Cronograma resumido

```
Semana:  1   2   3   4   5   6   7   8   9  10  11  12  13  14
F0 Base  ██
F1 BD+API    ██████
F2 Módulos       ██████████
F3 RT+Pagos              ██████████
F4 POS                       ██████████
F5 Web                           ██████████
F6 Móvil                             ██████████████████
F7 Servidor                              ██████████
F8 Seguridad                                     ██████████
Piloto 1                                     ▲
Piloto 2                                             ▲
Producción                                                   ▲
```

Hitos:

- **H1 (fin S3):** API unificada sobre Postgres, tests en verde.
- **H2 (fin S7):** pago sandbox extremo a extremo + tiempo real.
- **H3 (fin S8):** pedido de la app aparece en SoftRestaurant11 de prueba.
- **H4 (fin S9):** web completa conectada; staging en HTTPS.
- **H5 (S10):** piloto 1 en el club.
- **H6 (fin S12):** apps en TestFlight / prueba interna; piloto 2 con pagos reales.
- **H7 (S13–14):** producción.

---

## 5. Orden de trabajo inmediato (próximos 5 días)

| Día | Tarea | Resultado |
|---|---|---|
| 1 | Git init, `.gitignore`, mover docs a `docs/`, remoto privado | Repositorio limpio |
| 1 | Corregir `package.json`, Redis v4, Dockerfiles | `docker compose up` sano |
| 2 | Esquema SQL unificado + migraciones + seeds | `npm run migrate` funciona |
| 3 | Refactor de `nightclub-api.js` a routers; montar reservaciones | `/api/docs` disponible |
| 4 | Tests base (auth, pedidos, mesas, reservaciones) | CI en verde |
| 5 | `web/js/api.js` + conectar login y mapa de mesas de `index-ev2-branded.html` | Primera pantalla con datos reales |

---

## 6. Riesgos y mitigación

| Riesgo | Impacto | Mitigación |
|---|---|---|
| La API de SoftRestaurant11 no es como asume el código | Alto (retrasa Fase 4) | Confirmar documentación oficial en la semana 1; construir `pos-mock` para no bloquear el resto. |
| Pagos en México (Stripe limitado, OXXO/SPEI) | Alto | Mercado Pago como proveedor principal en MX; Stripe para USD y wallets. |
| Retiros a cuentas bancarias de empleados | Alto (dinero real) | Fase 1 solo registro + aprobación manual; payouts automáticos en fase posterior. |
| Apps nativas retrasan el lanzamiento | Medio | PWA en Fase 5 permite operar sin tiendas; nativas llegan después. |
| Wi-Fi/datos débiles dentro del club | Medio | Reconexión automática de WS, colas locales, botones idempotentes; Wi-Fi dedicado para staff. |
| Documentación actual promete más de lo que hay | Medio (expectativas) | Este plan reemplaza los resúmenes como fuente de verdad; actualizar `README.md` en Fase 0. |
| Sin respaldos / sin git | Alto | Fase 0 lo resuelve antes de tocar código. |
| Flirt y datos sensibles (acoso, menores) | Alto (legal/reputación) | Opt-in, bloqueo, reporte, verificación de edad 18+, aviso de privacidad. |

---

## 7. Definición de "listo para producción"

El sistema se considera listo cuando se cumplen todos estos puntos, no antes:

1. Todos los módulos guardan en Postgres y sobreviven a un reinicio.
2. Tests automatizados en CI cubren auth, pedidos, reservaciones, propinas y pagos.
3. Pagos reales probados en montos pequeños con Stripe y Mercado Pago.
4. Integración con SoftRestaurant11 validada en piloto real.
5. HTTPS, respaldos diarios probados, monitoreo con alertas.
6. Dos pilotos en el club completados con incidencias resueltas.
7. Staff capacitado y manuales entregados.
8. Aviso de privacidad, términos y código de conducta publicados.

---

## 8. Siguiente paso

Si apruebas este plan, el siguiente movimiento es ejecutar la **Fase 0** (día 1 de la tabla de la sección 5): inicializar git, reorganizar carpetas y dejar `docker compose up` funcionando. Antes de mover o modificar cualquier archivo te confirmo la lista exacta de cambios.
