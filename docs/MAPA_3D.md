# EV2: mapa 3D y editor de distribución

Implementación autorizada para clientes y administrador. Publicada el 2 de octubre
de 2026 en el VPS de EV2, versión `b5d53c9d056bb0551c0351e365c1d529b8510da4`.
No se modificó la distribución de producción ni se hicieron cobros.

## Uso

- **Clientes:** Mi visita → Mapa del lugar. El plano abre en 3D, con giro, zoom,
  vista superior y cambio de piso. Permanecen el plano 2D y la lista de mesas.
- **Reservaciones:** “Reservar para otra noche”, elegir evento y número de
  personas, tocar una mesa disponible en el mapa o en la lista. La disponibilidad
  corresponde al evento seleccionado; los precios y la cotización vienen del servidor.
  El gris del mapa 3D indica indisponibilidad para ese grupo y fecha.
- **Administrador:** entrar al panel de administración y abrir “Distribución del
  lugar”. Elegir Mesa, Zona completa o Área del lugar y arrastrar. Una zona agrupa
  las mesas de la misma sección y piso; no mueve mesas de otra planta.
- **Guardado:** “Guardar distribución” publica el lote de posiciones. “Deshacer”
  recupera hasta 50 movimientos; “Cancelar cambios” descarta el borrador. No hay
  guardado automático al arrastrar. Cambiar las coordenadas con teclado es una
  alternativa al arrastre.
- **Permisos:** solo administrador. El gerente no ve el enlace y el servidor
  rechaza tanto la ruta nueva como la ruta anterior de edición para otros roles.

## Estructura y seguridad

La vista usa las coordenadas, códigos, colores y pisos del plano existente.
Three.js y OrbitControls se compilan localmente a `web/vendor/venue-3d.js`; no se
carga código desde un CDN. La biblioteca se ejecuta al abrir el mapa, limita
la densidad de píxeles a 2 y renderiza por cambios, no con una animación continua.
El plano es esquemático, no un levantamiento arquitectónico.

`PUT /api/nightclubs/:nightclubId/floor-plan/layout` recibe `revision`, posiciones
de mesas por UUID y posiciones de áreas por código. La transacción bloquea el
registro del club, comprueba la revisión, valida pertenencia y límites, actualiza
solo X/Y y publica los eventos antes del commit. Un elemento inválido revierte
todo el lote. Una revisión vieja devuelve 409 y mantiene el borrador en pantalla.

La revisión se guarda en `nightclubs.settings.floor_plan.revision`; los datos
geométricos siguen en `tables` y `venue_landmarks`. No hay migraciones nuevas.
La respuesta de lectura usa un snapshot SQL consistente. Capacidad, precios,
identificadores, ocupación y reservaciones no son campos editables de esta ruta.

El evento `floor_plan_updated` contiene solo la revisión y avisa a los clientes.
También se publica `table_updated` para las pantallas existentes del personal.
No se agregaron nombres de clientes ni datos de pago al plano o a estos avisos.
El selector de reservaciones invalida cotizaciones anteriores al cambiar evento,
grupo o mesa y descarta respuestas atrasadas.

## Verificación terminada

- **Automatizadas:** 43 suites y 1,371 pruebas aprobadas, incluyendo plano, mesas,
  reservaciones, todas las suites web y audiencia de eventos.
- **Validación estática:** build web correcto; OpenAPI válido; `git diff --check`
  correcto; lint del servidor sin errores, con seis advertencias preexistentes
  fuera de los archivos modificados.
- **Navegador, datos aislados:** arrastre con ratón de mesa, zona y barra;
  guardado y recuperación después de recargar; edición numérica, deshacer,
  cancelar y conflicto entre dos sesiones.
- **Cliente móvil:** toque en mesa del mapa 3D, cotización real de la API local y
  reservación persistida como pendiente de anticipo. No se llamó a un proveedor de
  pagos ni se cobró dinero. Se verificaron cambio de planta, zoom, centrado y 2D.
- **Táctil:** arrastre de mesa con eventos táctiles en Chromium y cancelación.
- **Permisos:** gerente sin enlace y redirección al intentar abrir la URL;
  backend rechaza gerente, mesero y cliente con 403.
- **Compatibilidad:** sin WebGL funcionan 2D/lista para clientes y edición
  numérica para administrador. Sin desbordamiento horizontal en cliente y editor
  a 320, 390, 768 y 1440 píxeles. Sin errores JavaScript en los recorridos comprobados.

Comando reproducible, únicamente sobre PostgreSQL/Redis de pruebas:

```sh
npm --prefix server run build:web
npm --prefix server test -- --testPathPattern='floorplan|tables|reservation|web-|events-audience' --silent
npm --prefix server run lint
npm --prefix server run lint:api
git diff --check
```

No se debe ejecutar la suite de base de datos contra producción: sus fixtures
limpian tablas del entorno de prueba. Las pruebas de navegador se hicieron en
Chromium con emulación de tamaños y tacto, no certifican todos los dispositivos
físicos, Safari/iOS ni una compilación nativa de Android o iOS.

## Publicación verificada

Rama `fase5/mapa-3d-editor`; PWA `ev2-v36`. Publicación autorizada en
`45.93.100.244`, carpeta `/root/ev2-app`. API y web fueron los únicos contenedores
recreados. No se ejecutaron seeds ni cambios de distribución.

- **Respaldo local al VPS:** `/root/respaldos/mapa3d-20261002-133750/`.
  Base de datos en formato custom de PostgreSQL (612 KB), imágenes previas (99 MB),
  código, configuración privada e inventarios de contenedores. El índice del dump
  se validó con `pg_restore --list`; no se hizo una restauración de la base activa.
- **Salud:** API `1082f3183137` y web `15af6bbb9a08`, saludables.
  `/api/health` respondió HTTP 200. Recursos HTML, JS, CSS, renderer y PWA: HTTP 200.
  El SHA-256 del renderer público coincide con el compilado local.
- **Datos conservados:** checksum del plano idéntico antes y después; 55 mesas y
  8 áreas. Persisten 37 migraciones aplicadas, sin pendientes. Sin cargos Point
  ni reembolsos pendientes al publicar; Mercado Pago sigue en modo de prueba.
- **Infraestructura conservada:** mismos contenedores de PostgreSQL, Redis,
  WebSocket y Caddy. `.env` y configuración privada de Caddy idénticos al respaldo.
- **Acceso:** PUT de edición sin sesión responde 401. Navegador público en
  390 px abre el formulario de acceso sin desbordamiento ni errores JavaScript;
  abrir el editor sin sesión redirige a administración.
- **Reversión disponible:** imágenes `ev2-api:before-venue-b5d53c9` y
  `ev2-web:before-venue-b5d53c9`; código anterior `109f308`.

La aceptación final dentro del sistema publicado corresponde al administrador
con su cuenta habitual. No se crearon cuentas ni reservaciones de prueba en
producción. Las pruebas de edición y reservación completas se hicieron en el
entorno aislado descrito anteriormente.

La terminal física de Mercado Pago continúa siendo un pendiente independiente:
este bloque no activa cobros reales ni cambia su configuración. El audit de npm
mantiene tres avisos en dependencias anteriores (`brace-expansion`, `mercadopago`
y `uuid`); no se aplicaron actualizaciones ajenas al alcance autorizado.
