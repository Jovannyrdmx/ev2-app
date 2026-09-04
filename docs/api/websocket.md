# Canal de tiempo real (WebSocket)

OpenAPI no describe WebSocket, así que el contrato del canal vive aquí. Es la referencia
para la web (Fase 5) y para iOS/Android (Fase 6). Decisión: **D25**.

Servicio: `server/src/ws.js` · puerto `WS_PORT` (4000 por omisión) · salud en `GET /health`.

## Qué es y qué no es

El socket **solo entrega eventos**. No cambia nada: todo lo que modifica estado pasa por
la API REST, que es donde viven la validación, los roles y el libro contable. El servidor
**no guarda estado de dominio**; reiniciarlo no pierde más que los sockets abiertos.

## Conectarse

El token es el mismo `access_token` de la API. Dos formas, en este orden:

```js
// Preferida: subprotocolo. El navegador la soporta y el token no queda en la URL.
new WebSocket('wss://api.ev2.mx/', ['bearer', accessToken]);

// Alternativa (clientes que no puedan usar subprotocolos):
new WebSocket('wss://api.ev2.mx/?access_token=' + encodeURIComponent(accessToken));
```

> Usa el subprotocolo siempre que puedas: un token en la URL termina en bitácoras de
> acceso y en el historial de los proxies.

## Mensajes del servidor

| `type` | Cuándo | Contenido |
|---|---|---|
| `welcome` | Al conectar | `user`, `last_event_id`, `heartbeat_ms`, `token_expires_at`, `server_time` |
| `event` | Un evento dirigido a ti | `id` (cadena), `event_type`, `payload`, `created_at` |
| `pong` | Respuesta a `ping` | `server_time` |
| `error` | Mensaje rechazado | `code`, `message`. No cierra la conexión |
| `closing` | Justo antes de cerrar | `code`, `message` |

`id` viaja como **cadena**: son enteros de 64 bits y no caben en un `number` de
JavaScript. Guárdalo tal cual para la reconexión (paso 3.3).

## Mensajes del cliente

Solo `{"type":"ping"}`. Cualquier otro responde `error` con código `unsupported`.
Límite de 120 mensajes por minuto y 4 KB por trama.

## Códigos de cierre

| Código | Significado | Qué debe hacer el cliente |
|---|---|---|
| `4401` | Falta el token o no es válido | Iniciar sesión otra vez |
| `4001` | El token expiró | Renovar con `POST /api/auth/refresh` y reconectar |
| `4002` | Sesión reemplazada por otra más reciente de la misma cuenta | No reconectar en bucle |
| `4403` | Cuenta bloqueada o con contraseña temporal pendiente | Mostrar el motivo |
| `4004` | El cliente se pasó de mensajes o de tamaño | Corregir el cliente |
| `1001` | El servidor se está reiniciando | Reconectar con espera creciente |

## Audiencia

Cada evento nombra a quién va: sin audiencia llega a todo el club; con `roles` solo a esos
roles; con `userIds` solo a esas personas. **Nunca cruza de un club a otro.**

## Vigencia del token

El socket no sobrevive a su token: al expirar avisa con `closing` y cierra con `4001`. El
cliente renueva y vuelve a conectar. Un socket que siguiera abierto sin autenticación
detrás sería una sesión que nadie puede revocar.

## Latido

El servidor envía `ping` de protocolo cada `heartbeat_ms`; la librería del cliente
responde sola. Un socket que deja de contestar se corta. El `{"type":"ping"}` de
aplicación es aparte y sirve para medir latencia.

## De dónde salen los eventos (D26)

La tabla `events` es el buzón de salida. Un evento se escribe dentro de la misma
transacción que cambia el dato, y un disparador con `pg_notify` —que es **transaccional**:
solo se entrega si la transacción confirma— despierta al relevo, que lo publica en el canal
`ev2:events` de Redis. Este servidor está suscrito y lo entrega a quien corresponde.

Consecuencia práctica para el cliente: **si ves un evento, ya ocurrió de verdad.** Nunca
llega el aviso de un pedido que después se deshizo.

Los eventos de más de 5 minutos no se entregan en vivo: si estuviste desconectado, se
recuperan al reconectar (paso 3.3), no como una ráfaga de avisos sobre cosas ya pasadas.

`GET /health` responde **503 con `status: "degraded"`** si la suscripción a Redis no está
viva. Un servidor de sockets con las conexiones sanas y la suscripción muerta se ve
perfecto y no entrega nada, así que el monitoreo tiene que poder distinguirlo.

## Lo que falta

- **3.3** — reconexión: el cliente devolverá `last_event_id` y recibirá lo que se perdió.
