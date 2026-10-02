# EV2: revisión de español mexicano

## Alcance

Revisión editorial de la web y PWA, con 277 entradas del catálogo principal ajustadas inicialmente y correcciones adicionales de contadores, estados de pedidos y mensajes de error. Se conserva el funcionamiento de pedidos, pagos, inventario, permisos y autenticación. No incluye compilaciones nativas de iOS o Android ni traducción de los nombres personalizados guardados en la base de datos.

## Cambios

- Lenguaje: correo electrónico, menú, reservaciones, auto, PIN y mensajes con instrucciones concretas para clientes y personal.
- Acciones delicadas: “Liberar lugar”, “Registrar transferencia realizada” y “Reimprimir comanda”. Enviar una impresión no se presenta como haberla impreso.
- Pedidos: el registro del pedido se distingue de la confirmación del pago. No se promete que el personal ya esté revisando un error.
- Categorías: los códigos conocidos, como `beer` y `cocktails`, se muestran como “Cervezas” y “Cocteles”, sin cambiar los valores almacenados ni enviados al servidor.
- Errores: traducción de mensajes conocidos del servidor; los detalles técnicos de errores 500 se sustituyen por mensajes de usuario.
- Cortes: se separaron cuatro claves duplicadas que mezclaban el corte de la noche con el corte del turno, en ambos idiomas.
- Accesibilidad: documentos en `es-MX` y cambio a `en-US`; nombres accesibles de botones y aviso sin conexión actualizados al cambiar de idioma.
- Almacén móvil: los campos de cantidad, unidad, piezas por caja y costo se acomodan sin quedar cortados. El contador muestra “Renglones: 1”.
- PWA: versión de caché `ev2-v33`.

## Validación

Se ejecutan 37 suites web y 1,231 pruebas automáticas, incluida la suite nueva de español mexicano. Se verifican variables de traducción, cobertura español/inglés, claves duplicadas, errores, categorías y mensajes relacionados con pagos.

La revisión de navegador se realizó con datos aislados a 375 y 1440 píxeles: acceso, menú, gerencia, inventario y almacén. Se comprobó español → inglés → español, aviso sin conexión, error de credenciales y captura de entrada sin guardarla. El cálculo local de dos cajas de 24 piezas a $480 por caja conserva 48 piezas, $20 por pieza y $960 de total.

Los nombres, categorías y avisos de reconexión de las capturas pertenecen a datos de laboratorio. No se realizaron pagos, pedidos nuevos ni cambios de inventario en producción. Los dispositivos físicos y las aplicaciones nativas no forman parte de esta validación.

## Despliegue

Preparado para actualización exclusiva del contenedor web sobre la versión `4a6236b`, con respaldo de imagen y archivos, prueba previa de la imagen candidata y reversión ante fallas. La verificación final de producción se registra por separado tras completar el despliegue.
