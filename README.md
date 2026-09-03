# EV2 Clandestinoz — Sistema de gestión de nightclub

Plataforma para operar un nightclub: pedidos de bebidas en tiempo real, mapa de mesas, reservaciones con
pago, propinas al staff, portal de empleados (MXN/USD), salida segura con taxi, valet e integración con el
POS SoftRestaurant11. Backend Node.js + PostgreSQL + Redis, web HTML/Tailwind (PWA), apps iOS y Android.

**Autor y dueño:** Erick Lopez · **Desarrollador:** Jovanny Rodriguez (ver `AUTHORS.md`).

## Estado del proyecto

En desarrollo, siguiendo `docs/MANUAL_IMPLEMENTACION_EV2.pdf` paso a paso. El avance real se registra en
`docs/AVANCE.md`. **Advertencia:** los documentos antiguos en `docs/` (resúmenes, guías "production ready",
material de ventas) describen la visión del producto, no el estado actual del código. La fuente de verdad
sobre qué funciona es el manual y la bitácora.

## Estructura

```
server/        API REST (src/index.js), servidor WebSocket (src/ws.js), rutas, servicios, migraciones, tests
web/           Pantallas de la app web (index.html = cliente) + images/
mobile/ios     Código SwiftUI (proyecto Xcode se crea en la Fase 6)
mobile/android Código Jetpack Compose (proyecto Gradle se crea en la Fase 6)
deploy/        docker-compose, Dockerfiles, configuración de nginx
docs/          Manual, plan, bitácora, decisiones y documentación histórica (docs/legacy = código antiguo)
```

## Cómo arrancar en local

Requisitos: Docker Desktop y Node.js 18+.

```
cp .env.example .env
docker compose -f deploy/docker-compose.yml up -d
curl http://localhost:3000/health     # API
curl http://localhost:4000/health     # WebSocket
```

> Nota: hasta completar los pasos 0.4–0.7 del manual las rutas de Docker y los scripts de `server/package.json`
> están en proceso de corrección tras la reorganización de carpetas.

## Forma de trabajo

Reglas en `CLAUDE.md`. Rama por paso (`faseN/descripcion`), PR hacia `main`, verificación obligatoria de
cada paso antes de avanzar. Nunca versionar `.env`; nunca probar contra la caja activa del club antes de la Fase 7.
