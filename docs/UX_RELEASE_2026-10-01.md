# EV2: actualización de experiencia web y PWA

Esta entrega implementa mejoras de presentación y navegación sobre la base `96facf89b1e9267d66f7db195f93b12cafa26428`, rama `fase7/piezas-por-caja`. El trabajo se conserva en `fase5/ux-integral`; no modifica rutas, servicios, migraciones, permisos ni reglas monetarias del servidor.

La versión de aplicación `4a6236be22d8200b0c429666594accc3f21a52d1` quedó desplegada en [EV2 Systems](https://ev2.systems/) el 1 de octubre de 2026 a las 19:56, hora de Phoenix. Esta es una entrega web/PWA, no una declaración de que todas las propuestas futuras o las aplicaciones nativas estén terminadas.

## Cambios incluidos

- Cliente: inicio contextual, cinco destinos principales, menú con búsqueda tolerante a acentos, acceso secundario a mapa, reservas, transporte y coqueteo. Lista de mesas como alternativa al canvas.
- Administración y gerencia: navegación agrupada, espacio de trabajo amplio en escritorio y menú desplegable móvil. Cada módulo carga sus propios datos; el inicio no consulta cuentas bancarias de todos los empleados.
- Personal: estilos compartidos, contraste, campos legibles con etiquetas persistentes, foco visible y controles táctiles más grandes. Barra y almacén aprovechan más espacio.
- Diálogos: confirmación y entrada de texto accesibles y asincrónicas; cancelar devuelve false/null. Las acciones esperan la respuesta. Cancelar la referencia de un retiro no continúa el flujo.
- Fiabilidad: estado de carga y avisos de información no actualizada; marca de última consulta solo después de carga satisfactoria. Aviso de falta de conexión sin prometer que un pago se confirmó.
- Recursos: Tailwind, tipografías e iconos locales con sus licencias. El navegador no depende de los CDN anteriores para dibujar la interfaz. El service worker cambia a `ev2-v32`.
- Corte: mantiene la autorización presencial del gerente (D54). Un cierre histórico `declared` no se presenta como `confirmed`.

## Validación efectuada en entorno aislado

- 36 suites web, 1220 pruebas aprobadas en la ejecución final; incluye 17 nuevas comprobaciones de diálogos, recursos, navegación, espera de confirmación y datos de ubicación ausentes.
- Build local de estilos, fuentes e iconos completado. ESLint del servidor sin errores, con siete advertencias previas; contrato OpenAPI válido.
- Recorrido real en Chromium con API y PostgreSQL locales: entrada del cliente, mesa asignada, búsqueda con acentos, carrito y creación de pedido. La pantalla conserva el aviso de pago pendiente.
- Gerencia: primera carga observada con login y una consulta de dashboard, sin consultas bancarias. Diez pestañas recorridas sin excepciones JavaScript. Un fallo HTTP 500 muestra el aviso de datos anteriores y elimina la marca de actualización.
- Cliente móvil: navegación, lista de cuatro mesas, selección, búsqueda sin resultados, cambio ES/EN y aviso offline con retorno a conexión.
- Pantallas de piso, barra, almacén, ganancias, valet y conductor abiertas en escritorio y a 375 px; no se detectó desbordamiento horizontal del documento. Esto no equivale a probar cada operación de cada módulo.
- La ejecución completa de integración fue interrumpida por duración después de 12 suites aprobadas. NO se afirma que toda la suite de backend haya finalizado. No se cambiaron archivos `server/src` ni migraciones.
- PostgreSQL 18 y Redis 8 locales no son una réplica exacta de PostgreSQL 15 y Redis 7 de la configuración de producción.

## Límites y pendientes

No se publicaron builds nativas firmadas iOS/Android ni se rediseñó su código suelto. No se probaron terminales físicas, impresoras, escáneres, dinero real ni la conexión WebSocket de producción en el laboratorio. Las métricas de rapidez percibida requieren prueba en los dispositivos y red del club; no se promete una mejora porcentual no medida.

El documento de revisión contiene además propuestas de producto de mayor alcance. Esta entrega no agrega un motor nuevo de saldos prepagados, una cola unificada de excepciones, permisos nuevos, telemetría analítica ni un rediseño completo de cada formulario. La estructura y las reglas de negocio existentes se conservan.

## Despliegue efectuado

El propietario autorizó revisar, respaldar, actualizar y verificar el VPS `45.93.100.244`. Confirmó el usuario real de la consola y agregó una llave temporal. No se crearon usuarios, no se cambiaron contraseñas ni se modificó la configuración de acceso SSH.

La instalación anterior estaba en `703d641`. Se comprobó que API, migraciones y configuración de los contenedores no tienen diferencias funcionales con la base de esta entrega. Se preservó el archivo privado no versionado `deploy/Caddyfile.privado`. Se respaldaron imagen y archivos web en `/root/respaldos/ux-20261002-0252/`, y la imagen anterior conserva la etiqueta `ev2-web:before-ux-20261002`.

Se probó una candidata en un puerto accesible solo desde el VPS antes de sustituir `ev2-web`. Solo ese contenedor se recreó. La API, WebSocket, Caddy, PostgreSQL y Redis conservaron sus identificadores; no se ejecutaron seed, reset, migraciones ni operaciones sobre datos del club.

Se verificaron HTTPS, `/api/health`, estado `healthy`, 12 páginas/recursos con respuesta 200, fuentes locales, service worker activo, pantalla móvil a 375 px sin desbordamiento y ausencia de errores de carga en el navegador. Los hashes de `index-screen.js` y `ux.css` del contenedor coinciden con el código probado. Un 502 transitorio durante la sustitución fue superado por la comprobación con reintento; el resultado final fue 200 y API sana.

No se inició sesión con cuentas reales ni se hicieron pedidos, pagos o cambios financieros en producción. La aceptación por roles con cuentas del club y la prueba de impresoras, terminales y demás dispositivos quedan pendientes del propietario. El aviso de ciudad `null` detectado en el dominio público fue corregido sin inventar ni alterar el dato de ciudad.

## Reproducir

Desde `server/`, ejecutar `npm ci`, `npm run build:web` y `npm test -- --testPathPattern=web- --silent`. Los archivos finales de `web/vendor` están versionados: el VPS no necesita instalar Node ni compilar CSS para servir la web.

No ejecutar las pruebas de integración contra producción: sus fixtures limpian tablas. La prueba funcional local utiliza únicamente cuentas y datos desechables, excluidos del código entregado.
