# EV2 Clandestinoz — Sistema de gestión de nightclub

[![CI](https://github.com/Jovannyrdmx/ev2-app/actions/workflows/ci.yml/badge.svg)](https://github.com/Jovannyrdmx/ev2-app/actions/workflows/ci.yml)

Plataforma para operar un nightclub: pedidos de bebidas en tiempo real, mapa de mesas, reservaciones con
pago, propinas al staff, portal de empleados (MXN/USD), salida segura con taxi, valet e integración con el
POS SoftRestaurant11. Backend Node.js + PostgreSQL + Redis, web HTML/Tailwind (PWA), apps iOS y Android.

**Autor y dueño:** Erick Lopez · **Desarrollador:** Jovanny Rodriguez (ver `AUTHORS.md`).

## Estado del proyecto

En desarrollo, siguiendo `docs/MANUAL_IMPLEMENTACION_EV2.pdf` paso a paso. **Fases 0, 1 y 2 completas.**
El avance real se registra en `docs/AVANCE.md` y la hoja de control por fases e hitos (seccion 15 del
manual) en `docs/CONTROL_AVANCE.md`. Para conectar Stripe y Mercado Pago cuando existan las cuentas:
`docs/PAGOS_SETUP.md`. **Advertencia:** los documentos antiguos en `docs/` (resúmenes, guías "production ready",
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
cp .env.example .env      # then set DB_PASSWORD and JWT_SECRET (required)
docker compose --env-file .env -f deploy/docker-compose.yml up -d
curl http://localhost:3000/health     # API
curl http://localhost:4000/health     # WebSocket
```

Documentación interactiva de la API: <http://localhost:3000/api/docs>
(contrato en `server/openapi.yaml`; se valida en CI con `npm run lint:api`).

```
```

> Nota: hasta completar los pasos 0.4–0.7 del manual las rutas de Docker y los scripts de `server/package.json`
> están en proceso de corrección tras la reorganización de carpetas.

## Forma de trabajo

Reglas en `CLAUDE.md`; decisiones de arquitectura en `docs/DECISIONES.md`. Rama por paso (`faseN/descripcion`), PR hacia `main`, verificación obligatoria de
cada paso antes de avanzar. Nunca versionar `.env`; nunca probar contra la caja activa del club antes de la Fase 7.

## Probar la app en tu maquina

```bash
cp .env.example .env          # y llena DB_PASSWORD, JWT_SECRET, BANK_ENCRYPTION_KEY, SEED_PASSWORD
docker compose --env-file .env -f deploy/docker-compose.yml up --build -d
docker compose --env-file .env -f deploy/docker-compose.yml exec api npm run seed
docker compose --env-file .env -f deploy/docker-compose.yml exec api npm run seed:floor
docker compose --env-file .env -f deploy/docker-compose.yml exec api npm run seed:prices
docker compose --env-file .env -f deploy/docker-compose.yml exec api npm run seed:menu
docker compose --env-file .env -f deploy/docker-compose.yml exec api npm run seed:supplies
```

> `seed:prices` no es opcional: carga el precio de cada zona. Sin el, la pantalla de
> reservacion no encuentra ninguna mesa con precio y no se puede reservar nada.
>
> `seed:menu` carga la carta real del club (129 productos) y `seed:supplies` el almacen:
> los 3 lugares (almacen y las dos barras), los 88 insumos, las 129 recetas y un punto de
> entrega con QR por cada mesa, mas la pista y la terraza. **No carga ninguna
> existencia**: el saldo entra por una recepcion de mercancia o por un conteo fisico
> desde `almacen.html`, nunca de una semilla. Un inventario que arranca con numeros
> inventados miente desde el primer dia.

### Volver a exportar el catalogo desde la caja

Cuando el club cambie precios o recetas en SoftRestaurant11, se exportan las tablas
`productos` y `recetas` a `.xls` y se regeneran los tres archivos de semilla:

```bash
pip install xlrd
python3 server/scripts/import-sr11-catalog.py productos.xls recetas.xls
npm --prefix server run seed:menu && npm --prefix server run seed:supplies
```

El script imprime que precios se unificaron entre barras (se toma **el mayor**) y que
presentaciones quedaron **por confirmar**. Las reglas de conversion -entre ellas que
**una onza son 30 ml**, que es como sirve la barra- estan explicadas en la cabecera del
propio script.

Abre **http://localhost:8080**. El contenedor `web` sirve la pagina y reenvia `/api` a la
API y `/ws` al servidor de tiempo real, asi que todo va por un solo origen.

Entra con `guest@ev2.local` y la contrasena que pusiste en `SEED_PASSWORD`. Para ver el
pedido avanzar solo, abre otra ventana con `bartender@ev2.local` (paso 5.7).

### Pantallas por rol

| Rol | Pantalla | Que hace ahi |
|---|---|---|
| Cliente | `index.html` | Mapa, carta, pedidos, reservacion, propinas, pase de entrada. |
| Mesero | `staff.html` | Levanta el pedido en la mesa o en la pista, cobra en efectivo o terminal, recibe los listos y confirma la entrega. |
| Barra | `bartender.html` | La cola **de su barra**, ordenada por hora de pago; puede reacomodarla por eficiencia sin tocar la auditoria. |
| Almacen | `almacen.html` | Entradas, surtido a las barras, mermas, cortesias, salidas y conteo fisico, con kardex. |
| Gerente | `manager.html` | Precios, plano, empleados, caja del turno, reportes y moderacion. |
| Puerta | `staff.html` | Escanea el pase, vende acceso general y lleva el aforo. |

### Probar el flujo completo del inventario

Con la app arriba y el almacen cargado:

1. Entra como **almacen** o gerente en `almacen.html`, elige un insumo y registra una
   **entrada** en cajas con el costo de la factura.
2. **Surte** la barra que corresponda (pestana *Surtir*: lista lo que esta bajo minimo y
   si alcanza con lo que hay en el almacen).
3. Entra como **mesero** en `staff.html`, levanta un pedido en una mesa y cobralo.
4. Entra como **barra** en `bartender.html`: el pedido aparece en la cola **de esa barra**
   y no en la otra.
5. Vuelve a `almacen.html`: el kardex muestra el consumo, con el saldo que quedo en ese
   estante y contra que pedido salio.

> `ALLOWED_ORIGINS` **tiene que incluir el origen desde el que abres la pagina**, aunque
> la API vaya detras del mismo proxy: el navegador manda la cabecera `Origin` tambien en
> peticiones al mismo origen cuando no son GET. Si falta, la API responde 403 diciendo
> exactamente que agregar.
