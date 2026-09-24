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

Tres pasos. No hay ningún token que copiar.

### 1. Node.js

Instala Node.js 18 o más nuevo desde <https://nodejs.org> (la opción "LTS"). El
agente no usa ninguna librería externa: con Node basta.

### 2. Copiar la carpeta

Copia esta carpeta `agent/` a la PC, por ejemplo en `C:\EV2\agent`.

### 3. Emparejarla

En el panel del gerente: **Impresoras → Nueva PC**. Sale un código de ocho
caracteres, tipo `K7M4-2QX9`, que vive diez minutos.

En la PC de la barra:

```
cd C:\EV2\agent
node print-agent.js
```

Pregunta dos cosas —la dirección del servidor y el código— y con eso queda. El
programa **se escribe su propio `config.json`**, se pone el nombre de la máquina, y
empieza a buscar impresoras solo. Cuando el gerente vuelva a mirar el panel, ya están
ahí.

> El código es de un solo uso y muere a los diez minutos. Si se venció, pide otro:
> son dos clics.

Para una instalación desatendida, el código puede ir por variable de entorno:

```
set EV2_API_URL=https://tu-dominio.com
set EV2_PAIR_CODE=K7M4-2QX9
node print-agent.js
```

### 4. Dejarlo arrancando solo

La forma más simple, sin instalar nada más: un acceso directo en la carpeta de
inicio.

1. Crea `iniciar-agente.bat` en `C:\EV2\agent`:

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

## Impresoras por USB (Windows)

Una impresora de red no necesita nada más que su IP. Una conectada por **USB** sí:
Windows no deja mandarle bytes crudos sin pasar por el spooler, y el spooler quiere
un recurso compartido.

1. Panel de control → Dispositivos e impresoras → clic derecho → Propiedades de
   impresora → pestaña **Compartir** → "Compartir esta impresora".
2. Ponle un **nombre corto y sin espacios**, por ejemplo `XP80`.
3. En el panel de EV2, da de alta la impresora con conexión **USB / Windows** y ese
   mismo nombre.

El agente que imprime en esa impresora tiene que ser el que corre **en esa misma
PC**.

## Qué hace cuando algo falla

| Qué pasó | Qué hace |
|---|---|
| La impresora está sin papel | Lo detecta antes de mandar el ticket y lo reporta con ese motivo |
| La impresora está apagada o desconectada | Reporta el fallo; el servidor lo reintenta |
| Falla varias veces seguidas | El servidor lo desvía a la otra impresora de esa barra |
| Se cae el internet del club | Sigue intentando; cuando vuelve, imprime lo que se acumuló |
| Apagan la PC a medio trabajo | El servidor devuelve ese trabajo a la cola a los dos minutos |
| El token es inválido | Se detiene y lo dice, en vez de insistir toda la noche |

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
