# Agente de impresión EV2

Este programa es el puente entre el servidor de EV2 y las impresoras térmicas del
club. Corre en una PC de barra y no necesita que nadie abra un puerto del club a
internet: se conecta **hacia afuera**, pregunta si hay papel pendiente y lo imprime.

## Por qué hace falta

El servidor está en un VPS, fuera del club. Las impresoras están en la red local de
la barra. El servidor no puede alcanzarlas, y publicar el puerto 9100 de una
impresora en internet dejaría que cualquiera imprima lo que quiera en la barra. El
agente resuelve eso sin exponer nada.

## Cuántos hacen falta

**Dos**, uno por barra. No uno por impresora: como las impresoras están en la red
con su IP, cualquier agente las alcanza todas. Con dos, si apagan una PC la otra
sigue sacando todo el papel del club.

Los dos toman de la misma cola sin pisarse: el servidor entrega cada trabajo a uno
solo, así que **nunca sale el mismo ticket dos veces**.

## Instalación: «Registrar esta PC» (D127)

Se hace sentado en la PC que se va a registrar, con su impresora conectada **por USB**:

1. Abre el panel del gerente → **Cajas → Registrar esta PC**.
2. Escoge qué es esa PC (*Caja: Barra planta baja*, *Bartender: Barra planta baja*…) y
   pulsa **Bajar instalador**.
3. Abre `Instalar-EV2.cmd` (doble clic). Si Windows avisa «protegió su PC», pulsa
   *Más información → Ejecutar de todas formas*.

El instalador hace lo demás: instala Node.js si falta, deja el agente en `C:\EV2\agent`
arrancando solo con Windows, se da de alta con la llave que trae adentro (sirve una vez
y vence en 15 minutos) y el agente registra la impresora USB con su cajón, imprime la
hoja de prueba y abre el cajón. En el panel la PC sale en verde.

La PC del bartender registra la misma impresora para sus comandas y para su caja (D128).

**Borrar y empezar de cero:** Cajas → *Borrar PCs e impresoras actuales* (pide escribir
BORRAR). Mientras no vuelvas a registrar las PCs no sale papel.

## La caja del teléfono (D126)

Una barra puede tener una caja en la PC y otra en un teléfono. El teléfono no se conecta a
la impresora: su caja imprime en una **impresora térmica de red** (WiFi o cable, con IP
fija) con su cajón, y el papel lo saca **el agente de una PC del club**, igual que todo lo
demás. Por eso:

- Al menos una PC con el agente tiene que estar prendida y atender esa barra (o todo el
  club). En **Cajas → Configurar** se ve si esa PC se está reportando, y se puede escoger
  qué PC imprime la caja del teléfono.
- La impresora del teléfono se escoge de las que vieron las PCs al **Buscar impresoras**, o
  se teclea su IP. Sale la hoja de prueba y abre el cajón para confirmar que es la buena.
- La caja con PC usa la estación de siempre: el código ya va atado a su caja.

## Impresoras por USB (Windows)

**No hace falta compartirla en Windows.** El agente le imprime por su nombre.

1. Conecta la impresora e instala su driver en la PC.
2. En el panel: **Impresoras → Buscar impresoras**. La impresora aparece bajo el
   nombre de esa PC.
3. Pícale **Registrar**. Queda ligada a esa PC (D80): solo ese agente toma sus
   tickets. Sale una hoja de prueba y el panel pregunta si los acentos se ven bien.

## Qué hace cuando algo falla

| Qué pasó | Qué hace |
|---|---|
| La impresora está sin papel | Lo detecta antes de mandar el ticket y lo reporta con ese motivo |
| La impresora está apagada o desconectada | Reporta el fallo; el servidor lo reintenta |
| Falla varias veces seguidas | El servidor lo desvía a la otra impresora de esa barra |
| Se cae el internet del club | Sigue intentando; cuando vuelve, imprime lo que se acumuló |
| Apagan la PC a medio trabajo | El servidor devuelve ese trabajo a la cola a los dos minutos |
| El token es inválido | Se detiene y lo dice, en vez de insistir toda la noche |

### «El servidor rechazó el token»

```
[ERROR] El servidor rechazó el token. Revisa "token" en config.json,
        o crea otro agente desde el panel del gerente.
```

El agente termina ahí a propósito: un token que el servidor no reconoce no se arregla
insistiendo, y seguir sondeando toda la noche solo llena la bitácora del servidor de
intentos fallidos. Pasa cuando esa PC se apagó desde el panel, cuando se dio de alta
contra otro servidor, o cuando el servidor se repuso desde un respaldo anterior al
alta.

Se resuelve dando de alta la PC otra vez, que son dos minutos:

```
del C:\EV2\agent\config.json
node print-agent.js
```

Pide un código nuevo en el panel y tecléalo. La PC vieja queda en la lista como
apagada; se puede quitar desde ahí.

> Si además de ese mensaje ves un `Assertion failed ... UV_HANDLE_CLOSING`, tienes una
> versión del agente anterior a esta. El mensaje de arriba sigue siendo el bueno: ese
> segundo renglón era un defecto nuestro al terminar, ya corregido, y no dice nada de
> tu instalación.

Nada de eso se pierde en silencio: lo que no salió se ve en rojo en el panel del
gerente, y desde ahí se reimprime.

## Configuración completa

| Campo | Por omisión | Qué es |
|---|---|---|
| `apiUrl` | — | El dominio de tu servidor, sin barra final |
| `token` | — | El token del agente, del panel del gerente |
| `pollSeconds` | `3` | Cada cuánto pregunta si hay papel pendiente |
| `batch` | `5` | Cuántos trabajos se trae de una vez |
| `printTimeoutMs` | `15000` | Cuánto espera a una impresora antes de darla por muerta |
| `checkPaper` | `true` | Preguntarle a la impresora si tiene papel antes de imprimir |
| `paperCheckMs` | `500` | Cuánto espera esa respuesta antes de seguir de todos modos |
| `scanTimeoutMs` | `400` | Cuánto espera a cada dirección al buscar impresoras |
| `scanConcurrency` | `32` | Cuántas direcciones prueba a la vez |
| `scanSubnets` | `[]` | Subredes /24 extra, como `["192.168.20"]`, cuando las impresoras están en otra VLAN que la PC |

`EV2_API_URL` y `EV2_AGENT_TOKEN` como variables de entorno ganan sobre el archivo.

## Buscar impresoras

Desde el panel del gerente, **Impresoras → Buscar impresoras**, el agente barre su
propia subred probando el puerto 9100 y le pregunta el modelo a cada una que conteste
—con `GS I`, que es una consulta y **no imprime nada**—. También lista las impresoras
instaladas en ese Windows, que es lo que resuelve las de USB.

Tarda unos segundos: son 254 direcciones, de 32 en 32.

**Solo barre rangos privados** (10.x, 172.16-31.x, 192.168.x, 169.254.x) y solo redes
/24. `scanSubnets` sirve para agregar otra VLAN privada; lo que no sea privado se
ignora aunque se escriba ahí. Un agente que aceptara barrer cualquier rango sería un
escáner de puertos con permiso de fábrica dentro del club, y eso no lo arregla
confiar en el servidor.

## Una limitación honesta

Con `checkPaper` en `false`, "impreso" significa **"la impresora aceptó los bytes"**,
no "el papel salió". El puerto 9100 acepta datos aunque el rollo esté vacío. Por eso
viene encendido: la consulta de papel es lo que hace que ese "impreso" sea verdad.
Las impresoras que no implementan la consulta no contestan, y entonces se dan por
buenas y se sigue — no saber no es lo mismo que estar sin papel.
