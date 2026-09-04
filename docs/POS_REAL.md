# SoftRestaurant 11 — Mecanismo real de integración (Paso 0.9)

**Estado:** CERRADO para la Fase 0 (3 de septiembre de 2026); se completa en la Fase 4 con el mecanismo oficial de escritura. Este documento reemplaza las suposiciones del código
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

## 3. Instalación real del club (confirmado el 3-sep-2026)

| Dato | Valor |
|---|---|
| Producto / versión | SoftRestaurant **11.0.98** |
| Motor de base de datos | **Microsoft SQL Server** (instancia con nombre; el cliente resuelve el puerto dinámico 49767 vía SQL Server Browser). No es MySQL. |
| Servidor de base de datos | **`192.168.2.108`** en la red local del club (servidor dedicado). En esa red también está la máquina del dueño. |
| Acceso remoto actual | La PC del desarrollador llega a la red del club por **Radmin VPN** y tiene SoftRestaurant 11 instalado como **cliente** conectado a la base real. En la PC del desarrollador solo existe LocalDB (`MSSQLLocalDB`) con bases de sistema; no hay copia local de datos. |
| Cadena de conexión | Cifrada en `conexionDB.dbl` dentro de la instalación. **No se abre, no se descifra, no se versiona.** |
| Servicios observados | `SrvReportesSR` (servicio de reportes de SR) es el proceso que mantiene la conexión al servidor. |
| Licenciamiento | `license.settings` apunta a `licensingapi.nationalsoft.com.mx`; es solo activación de licencia, **no** es una API de integración. No se documenta su contenido. |
| Ambiente de pruebas | **No existe.** Todo lo visible desde la PC del desarrollador es producción. |

### Reglas derivadas

1. Ninguna consulta desde la PC del desarrollador contra `192.168.2.108` que no sea estrictamente de lectura, y ninguna prueba de la app contra esa conexión antes de la Fase 7.
2. Para la Fase 4 se crea un **ambiente de pruebas**: respaldo (`.bak`) de la base del club restaurado en una instancia SQL Server Express aparte (en la PC del desarrollador o en una VM), con datos anonimizados de clientes si los hubiera.
3. El acceso por Radmin VPN a la red del POS se audita en la Fase 8 (quién tiene acceso, contraseñas, bitácora).

## 4. Mecanismo elegido: agente local (decisión D16)

Un servicio de Windows ligero (`agent/`, Node.js, en este repositorio) instalado en el servidor `192.168.2.108`:

- Se conecta a SQL Server **localmente** con un usuario de **solo lectura** creado para él (nunca el usuario de SoftRestaurant).
- Lee catálogo, precios, inventario, mesas y cuentas abiertas/cerradas; los envía a la API de EV2 por HTTPS con una llave propia del agente (rotable), con reintentos y cola local.
- No abre puertos de entrada en el club; no modifica nada del POS.
- Las **comandas hacia el POS** solo se implementan cuando National Soft entregue el mecanismo oficial (programa de integración / SoftRestaurant Service). Hasta entonces, el bartender captura en el POS y la conciliación diaria detecta diferencias (plan B del manual).

## 5. Pendientes (no bloquean la Fase 1)

- [ ] Enviar formulario "Quiero integrar mi sistema" (softrestaurant.com/integraciones) y correo para llave `AuthorizedApp` — texto preparado en la bitácora del 3-sep.
- [ ] Descargar y leer la guía ERP/PMS de SR11 (PDF 1.22 MB) — pendiente de autorización.
- [ ] Add-ons licenciados en el club (e-Delivery, SR Móvil, Delivery Manager, e-Menu QR, ERP/PMS, Analytics, Payments).
- [ ] Nombre de la instancia y de la base en `192.168.2.108` (se obtiene en el servidor con `Get-Service` / SSMS; solo nombres).
- [ ] Quién administra el servidor del POS (distribuidor National Soft o interno) para pedir el usuario de solo lectura y el respaldo.

## 6. Datos que faltaban al inicio (histórico)

- [ ] Versión exacta instalada de SoftRestaurant (11.x.x) y edición (Standard / Professional / Enterprise).
- [ ] Add-ons y licencias activas (e-Delivery, SR Móvil, Delivery Manager, ERP/PMS, Analytics).
- [ ] ¿Existe ya una llave `AuthorizedApp` o documentación entregada por National Soft? (adjuntar).
- [ ] Credenciales de que se dispone: ¿usuario de SQL Server del servidor del POS? ¿API key? ¿Acceso a "Nube"?
- [ ] Nombre del servidor / instancia SQL y nombre de la base de datos (solo para lectura).
- [ ] ¿Hay una sucursal o base de pruebas separada de la caja activa?
- [ ] Contacto del distribuidor o ejecutivo de National Soft que atiende al club.

## 7. Acciones originales (histórico)

1. Enviar hoy el formulario "Quiero integrar mi sistema" en softrestaurant.com/integraciones (plataforma: Móvil + Web;
   proyecto: app de pedidos en mesa/barra para nightclub con sincronización de menú, inventario y comandas).
2. Escribir a National Soft solicitando llave `AuthorizedApp` del SoftRestaurant Service y la documentación de métodos.
3. Leer la guía ERP/PMS (PDF) y anotar aquí el mecanismo.
4. Con el dato de SQL Server, ejecutar una consulta de solo lectura de prueba (listar productos) desde una máquina
   de la red del club y documentar tablas relevantes.
5. Actualizar `docs/DECISIONES.md` D13 con el mecanismo definitivo y cerrar este paso.

## 8. Referencias

- https://api.softrestaurant.com.mx/
- https://softrestaurant.com/integraciones
- https://softrestaurant.com/manuales (OPE.ANA.SR11 Guía ERP/PMS)
- https://softrestaurant.com/addons/movil

## 9. Lo que la app ya expone para el agente (paso 2.8)

El registro de integraciones existe desde el paso 2.8 (decision D24). El agente que se
escriba en la Fase 4 tiene que hablar este protocolo:

| Que | Como |
|---|---|
| Autenticacion | Cabecera `X-Agent-Key` con la llave que entrega el gerente al declarar la integracion. No es una sesion de usuario. La llave se muestra una sola vez; si se pierde, el gerente la rota. |
| Latido | `POST /api/pos/agent/heartbeat` con `{version, hostname, status, error?}`. Responde `{enabled, mode, config, heartbeat_interval_seconds, capabilities, server_time}`. El agente **obedece `enabled` y `capabilities`**: asi el club lo apaga desde la app sin tocar el servidor del local. |
| Reporte de sincronizacion | `POST /api/pos/agent/sync` con `{kind, ok, items_synced, started_at?, error?, details?, client_request_id?}`. Manda siempre `client_request_id` para que un reintento tras un timeout no duplique la corrida. |
| Configuracion | Llega en `config` y solo lleva **nombres** (servidor, instancia, base, que sincronizar). Las credenciales de SQL Server viven en el servidor del club, nunca en la API. |
| Escritura de comandas | `capabilities.push_orders` es **false** y lo seguira siendo hasta que National Soft entregue el mecanismo oficial. Hasta entonces, plan B: el bartender captura en el POS y la conciliacion diaria detecta diferencias. |

Nada de esto lee todavia la base del POS: eso empieza en 4.1, y contra el ambiente de
pruebas de la regla 2 de la seccion 3, nunca contra `192.168.2.108` en produccion.
