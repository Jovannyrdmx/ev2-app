# EV2 Clandestinoz — Instrucciones del proyecto

Autor y dueño: Erick Lopez <erick.x.lopez@gmail.com> · Desarrollador: Jovanny Rodriguez <rdjovanny31@gmail.com>
Los commits llevan como autor a Erick Lopez y a Jovanny Rodriguez como co-autor (ver `AUTHORS.md`).

Fuente de verdad del plan: `MANUAL_IMPLEMENTACION_EV2.pdf` y `PLAN_IMPLEMENTACION_Y_DESARROLLO.md`
(en la raíz; pasan a `docs/` en la Fase 0). Bitácora de avance: `docs/AVANCE.md`.

## Forma de trabajar (obligatoria)

1. Paso a paso, en el orden del manual (0.1, 0.2, … 8.7). No saltar ni combinar pasos sin aprobación.
2. Consultar antes de cada cambio: presentar la lista exacta de archivos y comandos, esperar aprobación.
3. Mostrar cada cosa realizada: archivos cambiados, salida real de la verificación del manual, qué sigue.
   No se avanza si la verificación falla.
4. Calidad profesional, funcional y segura, lista para uso real: sin datos simulados, sin contraseñas
   por defecto, sin atajos "temporales". Validación, manejo de errores, roles, logs, tests, documentación.
5. Nunca probar contra la caja activa del club ni con dinero real antes de la Fase 7.
   Nunca versionar `.env` ni secretos. Nunca exponer Postgres/Redis a Internet.
6. Comunicación en español; código, variables y commits en inglés.
7. Git: rama por paso (`faseN/descripcion`), commit descriptivo, PR hacia `main`.
8. Si un paso toma más del doble del tiempo estimado o hay un bloqueo, detenerse y reportar.
9. Al cerrar cada paso, registrar en `docs/AVANCE.md`; al cerrar cada fase, recordar la hoja de control.

## Estado real del código (no confiar en los resúmenes antiguos de la documentación)

- `server/nightclub-api.js`: API real, 17 endpoints. Base del sistema.
- `server/server.js`: WebSocket con estado en memoria.
- `server/reservations-api.js`: router nunca montado; `stripe` no instalado.
- Módulos de negocio (`*-system.js`, `dance-floor-manager.js`, `nightclub-tables.js`, `pricing-system.js`):
  100% en memoria, sin rutas HTTP.
- Tres SQL duplicados; solo `init-nightclub.sql` se carga.
- HTML: interfaces completas sin llamadas a la API. iOS/Android: código suelto sin proyecto.
- Defectos: cliente Redis v3 con librería v4; Dockerfiles incompletos; sin git, lockfile ni tests.

## Decisiones fijas

Una sola API Express con routers por módulo · PostgreSQL 15 con migraciones numeradas y `transactions`
solo-inserción · WS sin estado + Redis pub/sub + JWT · Web HTML/Tailwind sin build + `web/js/api.js` + PWA ·
Móvil con proyectos reales y cliente desde `server/openapi.yaml` · Pagos Stripe (PaymentIntents) + Mercado Pago;
manuales para Zelle/Cash App/depósito; retiros con aprobación manual · Seguridad: helmet, rate-limit, zod,
JWT 15 min + refresh revocable, pgcrypto, flirt con opt-in/bloqueo/18+ · VPS Ubuntu 24.04 + Docker Compose,
Caddy/nginx con SSL, respaldos probados, Uptime Kuma, CI/CD con producción bajo aprobación manual.
