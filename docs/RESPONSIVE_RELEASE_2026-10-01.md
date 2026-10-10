# EV2: revisión responsive

## Resultado y alcance

Se revisaron 49 pantallas y estados de la web/PWA en 14 tamaños, para un total de 686 comprobaciones de geometría en Chromium. La matriz final no encontró desbordamiento horizontal accidental, botones con contenido horizontal recortado ni campos de captura menores de 70 px en los estados comprobados. Se conservaron los desplazamientos horizontales intencionales de pestañas, filtros y mapas.

La revisión incluyó acceso y registro, cliente, gerencia, administración, piso, barra, almacén, valet, conductor, portal de empleado, pase, verificación y documentos públicos. Incluyó formularios y ventanas de toma de pedido, venta, recepción, cuenta bancaria y captura de auto, sin guardar transacciones de prueba.

## Correcciones

- Formularios: las etiquetas generadas conservan la distribución de columnas del campo original. En celulares pequeños, los formularios densos de gerencia pasan a una columna.
- Navegación del cliente: las cinco opciones y los indicadores de pedidos caben desde 320 px sin cortar las etiquetas. El carrito queda por encima de la navegación.
- Encabezados: controles táctiles con ancho mínimo, nombres que se adaptan y estado de conexión que no desplaza los botones fuera de pantalla.
- Pestañas fijas: su posición depende de la altura medida del encabezado, no de una constante que falla cuando el texto ocupa dos renglones.
- Gerencia: botones de acciones y títulos se acomodan sin partir palabras. La navegación lateral tiene desplazamiento propio cuando no cabe en altura.
- Ventanas de captura: en pantallas horizontales de poca altura, el contenido se desplaza como una página en vez de dejar un menú casi sin altura.
- Campos condicionales: se oculta también su etiqueta cuando el campo no corresponde al método seleccionado.
- Áreas seguras y altura disponible: uso de unidades de viewport dinámico, espacio inferior y márgenes de seguridad.
- Escritorio: barra y almacén aprovechan hasta 1,180 px de ancho; gerencia conserva su distribución de escritorio.
- Caché PWA: nueva versión `ev2-v34`.

## Pruebas realizadas

Anchos CSS de 320, 375, 390, 428, 600, 768, 820, 1024, 1280, 1440, 1920 y 2560 px. Orientaciones horizontales adicionales de 844 × 390 y 667 × 375.

Se comprobaron navegación móvil desplegable, cambio de pestañas, cambio de idioma, carrito sin enviar, formularios sin guardar, cierre de ventanas, aviso sin conexión y cancelación de un diálogo largo. También se probó altura reducida de 390 × 400 para simular el espacio disponible con teclado, reflujo a 640 × 450 equivalente en dimensiones a 200% sobre 1280 × 900, y contexto móvil con interacción táctil y densidad 3.

Firefox: 16 comprobaciones adicionales, en las pantallas de cliente, gerencia, barra y almacén a 320, 768, 1440 y 667 px, sin incidencias en las comprobaciones de geometría.

Pruebas de regresión: 38 suites web, 1,244 pruebas aprobadas. Se añadió una suite para viewport, conservación de columnas, cambio de altura del encabezado y restricciones de altura.

## Límites de la validación

- La revisión utiliza navegadores y tamaños emulados; no certifica todos los dispositivos físicos.
- No se validó Safari/WebKit: el entorno no dispone de las dependencias necesarias para ejecutarlo.
- La altura reducida simula el espacio del teclado; no constituye una prueba del teclado nativo de iOS o Android.
- Las vistas que requieren viajes, cuentas, impresoras o terminales activas se revisaron con los datos de laboratorio disponibles. No se ejecutaron cobros, pedidos nuevos ni cambios de inventario productivo.
- Los avisos de reconexión de las capturas corresponden al laboratorio, que no ejecuta el servicio WebSocket.
- No se generaron nuevas aplicaciones nativas iOS o Android. Los cambios corresponden a la web/PWA.

## Despliegue

Publicado en [EV2 Systems](https://ev2.systems/) el 1 de octubre de 2026 a las 20:40, hora de Arizona. Código de aplicación `12e7c13`, sobre `9c51c47`; nueva caché `ev2-v34`.

Se actualizó exclusivamente el contenedor web. Respaldo de imagen y archivos en `/root/respaldos/responsive-20261002/`, con imagen anterior `ev2-web:before-responsive-20261002`. La imagen candidata se probó antes del cambio y quedó preparada la reversión. Durante la recreación se observó una respuesta transitoria 502; las verificaciones posteriores respondieron correctamente.

El contenedor web terminó saludable. Los identificadores de API, WebSocket, PostgreSQL, Redis y Caddy no cambiaron. Las sumas SHA-256 de CSS, JavaScript compartido y service worker coincidieron entre el código local probado y el VPS.

La pantalla pública se revisó además en producción a 320, 768, 1440 y 844 px, sin incidencias de geometría ni errores de JavaScript observados. No se iniciaron sesiones con cuentas productivas para esta validación. Se retiró la llave temporal y se confirmó que ya no permite conectarse.
