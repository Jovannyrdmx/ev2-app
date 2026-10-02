# EV2: actualización de experiencia web y PWA

Esta entrega implementa mejoras de presentación y navegación sobre la base `96facf89b1e9267d66f7db195f93b12cafa26428`, rama `fase7/piezas-por-caja`. El trabajo se conserva en `fase5/ux-integral`; no modifica rutas, servicios, migraciones, permisos ni reglas monetarias del servidor.

## Cambios incluidos

- Cliente: inicio contextual, cinco destinos principales, menú con búsqueda tolerante a acentos, acceso secundario a mapa, reservas, transporte y coqueteo. Lista de mesas como alternativa al canvas.
- Administración y gerencia: navegación agrupada, espacio de trabajo amplio en escritorio y menú desplegable móvil. Cada módulo carga sus propios datos; el inicio no consulta cuentas bancarias de todos los empleados.
- Personal: estilos compartidos, contraste, campos legibles con etiquetas persistentes, foco visible y controles táctiles más grandes. Barra y almacén aprovechan más espacio.
- Diálogos: confirmación y entrada de texto accesibles y asincrónicas; cancelar devuelve false/null. Las acciones esperan la respuesta. Cancelar la referencia de un retiro no continúa el flujo.
- Fiabilidad: estado de carga y avisos de información no actualizada; marca de última consulta solo después de carga satisfactoria. Aviso de falta de conexión sin prometer que un pago se confirmó.
- Recursos: Tailwind, tipografías e iconos locales con sus licencias. El navegador no depende de los CDN anteriores para dibujar la interfaz. El service worker cambia a `ev2-v32`.
- Corte: mantiene la autorización presencial del gerente (D54). Un cierre histórico `declared` no se presenta como `confirmed`.

## Validación efectuada en entorno aislado

- 36 suites web, 1219 pruebas aprobadas en la ejecución registrada; incluye 16 nuevas comprobaciones de diálogos, recursos, navegación y espera de confirmación.
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

## Puerta de despliegue

El propietario autorizó revisar, respaldar, actualizar y verificar el VPS `45.93.100.244`. El usuario SSH `ev2` de la documentación histórica resultó inexistente según la consola del propietario; se debe confirmar el usuario real antes de conectar. No se debe crear una cuenta por suposición.

Antes de desplegar: comprobar versión y cambios locales del servidor, identificar el directorio y el servicio web, respaldar imagen y archivos, y validar compatibilidad con esta base. No ejecutar seed, reset, migraciones, ni reiniciar API/PostgreSQL/Redis para esta entrega.

Desplegar únicamente la web después de esas comprobaciones. Conservar la imagen previa y el respaldo para reversión. Verificar HTTPS, `/api/health`, acceso con roles, carga de los recursos locales y actualización del service worker. Si hay divergencia de código o API no verificada, detener el despliegue y conciliar primero.

## Reproducir

Desde `server/`, ejecutar `npm ci`, `npm run build:web` y `npm test -- --testPathPattern=web- --silent`. Los archivos finales de `web/vendor` están versionados: el VPS no necesita instalar Node ni compilar CSS para servir la web.

No ejecutar las pruebas de integración contra producción: sus fixtures limpian tablas. La prueba funcional local utiliza únicamente cuentas y datos desechables, excluidos del código entregado.
