#!/usr/bin/env bash
#
# EV2 — el cortafuegos del VPS.
#
# ---------------------------------------------------------------------------
# Por qué existe
# ---------------------------------------------------------------------------
# La revisión del 28 de septiembre encontró el servidor **sin ningún cortafuegos**:
# `ufw` inactivo e `iptables` con la política en ACCEPT y la cadena vacía. Hoy eso no
# se nota, porque lo único que escucha es el proxy en 80 y 443 — Postgres y Redis no
# están publicados, y eso está bien hecho. Pero significa que el día que alguien
# levante cualquier cosa en el servidor "un momentito, para probar", queda expuesta a
# internet entera sin que nadie decida nada.
#
# ---------------------------------------------------------------------------
# Esto puede dejarte fuera de tu propio servidor. Por eso NO aplica nada por omisión
# ---------------------------------------------------------------------------
# Un cortafuegos mal puesto cierra el puerto por el que estás conectado, y entonces la
# única forma de entrar es la consola del proveedor. Así que este script, sin
# argumentos, solo **enseña lo que haría**. Para que lo haga de verdad:
#
#     bash deploy/firewall.sh --aplicar
#
# Y aun así abre SSH **antes** de encender nada, que es el orden que importa.
#
# ---------------------------------------------------------------------------
# Lo que este cortafuegos NO protege, y hay que saberlo
# ---------------------------------------------------------------------------
# Docker escribe sus propias reglas en `iptables` y **se salta `ufw`**: un contenedor
# con `ports: - "5432:5432"` queda abierto a internet aunque `ufw` diga que ese puerto
# está cerrado. La defensa real de Postgres y Redis no es este script: es que en
# `docker-compose.prod.yml` no estén publicados, o que lo estén como
# `127.0.0.1:5432:5432`. Este script lo comprueba y avisa.
set -uo pipefail

APLICAR=false
[ "${1:-}" = "--aplicar" ] && APLICAR=true

verde()  { printf '  \033[32m%s\033[0m\n' "$1"; }
rojo()   { printf '  \033[31m%s\033[0m\n' "$1"; }
aviso()  { printf '  \033[33m%s\033[0m\n' "$1"; }
titulo() { printf '\n\033[1m%s\033[0m\n' "$1"; }

printf '\n\033[1mEV2 — cortafuegos del servidor\033[0m\n'
if [ "$APLICAR" = false ]; then
  aviso 'MODO PRUEBA: no se va a cambiar nada. Para aplicarlo: bash deploy/firewall.sh --aplicar'
fi

# --------------------------------------------------------------- 0. requisitos
if [ "$(id -u)" != "0" ]; then
  rojo 'Hay que correrlo como root (sudo).'
  exit 1
fi
if ! command -v ufw >/dev/null 2>&1; then
  titulo 'Falta ufw'
  aviso 'Se instala con: apt-get update && apt-get install -y ufw'
  # if/else y no `&& ... || exit`: con esa forma, una instalación FALLIDA caía en el
  # `||` y salía con 0, o sea diciendo que todo bien sin cortafuegos puesto.
  if [ "$APLICAR" = true ]; then
    apt-get update -qq && apt-get install -y -qq ufw || { rojo 'No se pudo instalar ufw.'; exit 1; }
  else
    exit 0
  fi
fi

# --------------------------------------------------------------- 1. el puerto de SSH
#
# Se LEE del sshd, no se supone que es el 22: un servidor con SSH en otro puerto y este
# script suponiendo el 22 es exactamente cómo alguien se queda fuera.
PUERTO_SSH=$(grep -oP '^\s*Port\s+\K[0-9]+' /etc/ssh/sshd_config 2>/dev/null | head -1)
PUERTO_SSH=${PUERTO_SSH:-22}
titulo '1. Por dónde entras tú'
verde "SSH escucha en el puerto ${PUERTO_SSH} (leído de sshd_config, no supuesto)"

# Y si estás conectado por SSH ahora mismo, se comprueba que el puerto coincida.
if [ -n "${SSH_CONNECTION:-}" ]; then
  PUERTO_ACTUAL=$(echo "$SSH_CONNECTION" | awk '{print $4}')
  if [ "$PUERTO_ACTUAL" != "$PUERTO_SSH" ]; then
    rojo "Estás conectado por el puerto ${PUERTO_ACTUAL} y sshd_config dice ${PUERTO_SSH}."
    rojo 'Abrir solo el de sshd_config te dejaría fuera. Revisa antes de aplicar.'
    [ "$APLICAR" = true ] && exit 1
  else
    verde "Estás conectado por ese mismo puerto: abrirlo te mantiene dentro"
  fi
fi

# --------------------------------------------------------------- 2. las reglas
titulo '2. Las reglas'
echo "   entrada  : negar todo salvo lo de abajo"
echo "   salida   : permitir (el servidor necesita salir: Let's Encrypt, Mercado Pago, apt)"
echo "   ${PUERTO_SSH}/tcp  : SSH, con límite de intentos"
echo "   80/tcp   : HTTP (lo redirige Caddy a HTTPS, y hace falta para renovar el certificado)"
echo "   443/tcp  : HTTPS"

if [ "$APLICAR" = true ]; then
  # El ORDEN importa: primero se abre SSH, después se encienden las políticas. Al revés,
  # `ufw default deny incoming` con ufw ya activo corta la sesión en curso.
  ufw --force reset >/dev/null
  ufw limit "${PUERTO_SSH}/tcp" comment 'SSH (con freno a la fuerza bruta)' >/dev/null
  ufw allow 80/tcp  comment 'HTTP (redirige a HTTPS y renueva el certificado)' >/dev/null
  ufw allow 443/tcp comment 'HTTPS' >/dev/null
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw --force enable >/dev/null
  verde 'Aplicado.'
else
  aviso '(no aplicado: falta --aplicar)'
fi

# --------------------------------------------------------------- 3. el hueco de Docker
titulo '3. Lo que ufw NO puede proteger'
echo '   Docker escribe sus propias reglas y se salta ufw: un puerto publicado en el'
echo '   compose queda abierto a internet aunque ufw lo dé por cerrado. Lo que de'
echo '   verdad protege a Postgres y a Redis es NO publicarlos.'
echo ''
EXPUESTOS=$(docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null \
  | grep -E '0\.0\.0\.0:|:::' | grep -vE ':(80|443)->' || true)
if [ -z "$EXPUESTOS" ]; then
  verde 'Ningún contenedor publica nada a internet salvo 80 y 443. Correcto.'
else
  rojo 'Hay contenedores publicando puertos a internet:'
  echo "$EXPUESTOS" | sed 's/^/     /'
  aviso 'Si alguno es la base o Redis, cámbialo a 127.0.0.1:PUERTO:PUERTO en el compose.'
fi

# --------------------------------------------------------------- 4. cómo quedó
titulo '4. Cómo quedó'
if ufw status >/dev/null 2>&1; then
  ufw status verbose | sed 's/^/   /'
fi

printf '\n'
if [ "$APLICAR" = true ]; then
  aviso 'ANTES DE CERRAR ESTA SESIÓN: abre OTRA terminal y comprueba que puedes entrar.'
  aviso 'Si no puedes, desde ésta: ufw disable'
else
  printf '  Para aplicarlo: \033[1mbash deploy/firewall.sh --aplicar\033[0m\n'
fi
printf '\n'
