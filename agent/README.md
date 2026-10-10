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

## Instalación

Dos pasos, y ninguno es copiar una carpeta por USB. No hay ningún token que copiar.

### 1. Node.js

Instala Node.js 18 o más nuevo desde <https://nodejs.org> (la opción "LTS"). El
agente no usa ninguna librería externa: con Node basta. Si se te olvida, el
instalador del paso 2 te lo dice y te manda ahí; no falla con un error raro.

### 2. Pegar una línea

En el panel del gerente: **Impresoras → Nueva PC**. Sale un código de ocho
caracteres, tipo `K7M4-2QX9`, que vive diez minutos, y debajo un desplegable que dice
**"Esa PC todavía no tiene el agente"** con la línea ya escrita y un botón para
copiarla.

En la PC de la barra: clic derecho en Inicio → **Windows PowerShell**, y pega:

```
irm https://tu-dominio.com/api/print-agent/install.ps1 | iex
```

Eso baja el agente a `C:\EV2\agent`, deja hecho el `.bat` de arranque y lo corre. Solo
te pregunta el código. El programa **se escribe su propio `config.json`**, se pone el
nombre de la máquina, y empieza a buscar impresoras solo. Cuando el gerente vuelva a
mirar el panel, ya están ahí.

> Esa línea baja código y lo ejecuta, así que el servidor **solo la genera sobre
> https**: si el club se ve por http, la ruta contesta un error en vez de un script.
> Sobre http, cualquiera dentro de la red del club podría contestar por el servidor y
> mandarle a la barra lo que quisiera. Si prefieres verla antes de correrla, ábrela en
> el navegador: es texto plano y son cuarenta renglones.

Junto a la línea hay también un **enlace para bajar el archivo**, por si en esa PC es
más cómodo guardarlo y hacerle clic derecho → "Ejecutar con PowerShell".

### A mano, si prefieres

Sigue funcionando copiar la carpeta `agent/` a la PC y correr:

```
cd C:\EV2\agent
node print-agent.js
```

Pregunta dos cosas —la dirección del servidor y el código— y con eso queda.

> El código es de un solo uso y muere a los diez minutos. Si se venció, pide otro:
> son dos clics.

Para una instalación desatendida, el código puede ir por variable de entorno:

```
set EV2_API_URL=https://tu-dominio.com
set EV2_PAIR_CODE=K7M4-2QX9
node print-agent.js
```

### 3. Dejarlo arrancando solo

La forma más simple, sin instalar nada más: un acceso directo en la carpeta de
inicio.

1. `iniciar-agente.bat` ya está en `C:\EV2\agent` si usaste el instalador. Si copiaste
   la carpeta a mano, créalo:

   ```bat
   @echo off
   cd /d C:\EV2\agent
   node print-agent.js >> agente.log 2>&1
   ```

2. `Win + R` → `shell:startup` → pega ahí un acceso directo al `.bat`.

Así arranca cuando alguien entra a Windows. Si prefieres que arranque **sin que
nadie inicie sesión**, usa el Programador de tareas: tarea nueva → "Ejecutar tanto si
el usuario inició sesión como si no" → desencadenador "Al iniciar el equipo" →
acción: `node.exe` con argumento `C:\EV2\agent\print-agent.js` y "Iniciar en"
`C:\EV2\agent`.

El `config.json` tiene la llave de esa PC: no lo subas a git ni lo mandes por chat.

## La forma rápida: una estación en un solo paso (D99)

Para una PC de caja con su impresora USB y su cajón (el cajón va con su cable a la
impresora, nunca a la PC):

1. Conecta la impresora por USB, enciéndela e instala su driver en Windows.
2. En el panel: **Impresoras → Nueva estación de caja**. Pon el nombre, escoge dónde
   está (barra, Cover o Puerta), para qué es, y marca si tiene cajón. Pica **Sacar el
   código de la estación**.
3. En la PC: pega la línea de instalación y teclea el código.

Eso es todo. La PC busca sus impresoras, descarta las virtuales de Windows (PDF, XPS,
OneNote, Fax), registra sola la térmica USB con el nombre, el lugar y el cajón que
pediste, saca la hoja de prueba y abre el cajón. El panel muestra la tarjeta de la
estación con ✓ PC · ✓ impresora · ✓ cajón.

- Si el cajón no abre, pica **No abrió, probar pin 5** (o 2): cambia el pin y vuelve a
  probar en un clic.
- Si la PC ve **varias** impresoras, la tarjeta te deja escoger cuál es la de tickets.
- Si **no** ve ninguna, te dice qué revisar (USB, encendida, driver) y pica **Buscar
  impresoras** para reintentar.

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
