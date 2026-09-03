# SoftRestaurant 11 — Mecanismo real de integración (Paso 0.9)

**Estado:** BORRADOR en investigación (3 de septiembre de 2026). Este documento reemplaza las suposiciones del código
heredado (`/api/tables`, `/api/menu/drinks`, `/api/orders` con header `X-API-Key`), que **no corresponden a ningún
producto documentado de National Soft**.

## 1. Lo que se confirmó en fuentes públicas

| Fuente | Hallazgo |
|---|---|
| `https://api.softrestaurant.com.mx/` ("SoftRestaurant Service", National Soft) | Servicio REST/JSON cuyo propósito declarado es "proporcionar la información del menú del restaurante para su uso a través de las aplicaciones". Autenticación por header **`AuthorizedApp`** con una llave GUID. Las llaves se solicitan por correo a National Soft (contacto publicado: erik.basto@nationalsoft.com.mx). La página de documentación de métodos (`/documentation/index`) devuelve 404 hoy. **Conclusión:** parece ser solo lectura de menú; no hay evidencia pública de que permita enviar comandas ni leer mesas. |
| `https://softrestaurant.com/integraciones` | National Soft tiene un programa formal "Quiero integrar mi sistema" (formulario para desarrolladores: plataforma móvil/web/desktop, descripción del proyecto). Integraciones de terceros existentes que **sí envían órdenes al POS**: Deliverect, Hubster, Ordatic (agregadores de delivery), Uber Eats, Rappi, Didi. Add-ons propios: **e-Delivery** (pedidos desde plataforma propia del restaurante), **Soft Restaurant Móvil** (comandas desde la mesa), e-Menu QR, Kiosko, Delivery Manager, Payments. |
| `https://softrestaurant.com/manuales` → "OPE.ANA.SR11 Guía para el módulo de conexión de ERP y PMS" (PDF, 1.22 MB, 24-ago-2023) | Existe un **módulo de conexión ERP/PMS** en SR11 (usado por Cloudbeds y Zavia para cargos a habitación). Requiere "licencia vigente y enlace ERP/PMS activo". Pendiente leer el PDF para saber si es web service o intercambio por base de datos. |
| Guías de instalación SR8–SR11 | SoftRestaurant 11 corre sobre **Microsoft SQL Server** local. Acceso directo a la base es técnicamente posible con credenciales del servidor, pero no está documentado ni soportado oficialmente para terceros. |

## 2. Escenarios posibles y cómo afectan al proyecto

| Escenario | Qué permite | Qué implica para EV2 |
|---|---|---|
| **A. Programa de integración oficial** (como Deliverect/Hubster) | Enviar órdenes al POS, recibir menú y estados por API de National Soft. | Es el camino correcto y soportado. Hay que solicitarlo por el formulario y obtener documentación + llave. Tiempo de respuesta del proveedor: desconocido (riesgo de calendario). |
| **B. Add-on e-Delivery / SR Móvil** | e-Delivery recibe pedidos "desde tu propia plataforma"; SR Móvil levanta comandas por mesa. | Si e-Delivery expone un endpoint para plataformas propias, EV2 puede usarlo para comandas a domicilio; para mesas no aplica. Requiere licencia del add-on. |
| **C. Módulo ERP/PMS** | Diseñado para cargos a habitación y consumos; probablemente web service SOAP/REST local. | Podría servir para leer cuentas/consumos y quizá crear cargos; no para comandas de barra. Verificar con el PDF. |
| **D. Lectura directa de SQL Server** (solo lectura) | Menú, precios, inventario, mesas abiertas, cuentas. | Viable para **sincronizar catálogo e inventario** y para conciliación. **No** para escribir comandas (romper la integridad del POS invalida soporte y reportes fiscales). |
| **E. Sin integración de escritura** | — | La app opera con su propio flujo y el bartender captura en el POS; conciliación diaria por reporte (D). Plan B del manual (sección 13). |

**Recomendación preliminar:** A para comandas (solicitar ya), D para catálogo/inventario/conciliación mientras llega A.
El `pos-mock` (Paso 4.2) se construirá sobre el contrato que National Soft entregue; hasta entonces el cliente
`SoftRestaurant11Client` del código heredado se considera **no válido**.

## 3. Datos que faltan (los aporta el dueño/desarrollador)

- [ ] Versión exacta instalada de SoftRestaurant (11.x.x) y edición (Standard / Professional / Enterprise).
- [ ] Add-ons y licencias activas (e-Delivery, SR Móvil, Delivery Manager, ERP/PMS, Analytics).
- [ ] ¿Existe ya una llave `AuthorizedApp` o documentación entregada por National Soft? (adjuntar).
- [ ] Credenciales de que se dispone: ¿usuario de SQL Server del servidor del POS? ¿API key? ¿Acceso a "Nube"?
- [ ] Nombre del servidor / instancia SQL y nombre de la base de datos (solo para lectura).
- [ ] ¿Hay una sucursal o base de pruebas separada de la caja activa?
- [ ] Contacto del distribuidor o ejecutivo de National Soft que atiende al club.

## 4. Acciones

1. Enviar hoy el formulario "Quiero integrar mi sistema" en softrestaurant.com/integraciones (plataforma: Móvil + Web;
   proyecto: app de pedidos en mesa/barra para nightclub con sincronización de menú, inventario y comandas).
2. Escribir a National Soft solicitando llave `AuthorizedApp` del SoftRestaurant Service y la documentación de métodos.
3. Leer la guía ERP/PMS (PDF) y anotar aquí el mecanismo.
4. Con el dato de SQL Server, ejecutar una consulta de solo lectura de prueba (listar productos) desde una máquina
   de la red del club y documentar tablas relevantes.
5. Actualizar `docs/DECISIONES.md` D13 con el mecanismo definitivo y cerrar este paso.

## 5. Referencias

- https://api.softrestaurant.com.mx/
- https://softrestaurant.com/integraciones
- https://softrestaurant.com/manuales (OPE.ANA.SR11 Guía ERP/PMS)
- https://softrestaurant.com/addons/movil
