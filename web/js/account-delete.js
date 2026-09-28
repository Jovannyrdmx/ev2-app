/**
 * EV2 — borrar la cuenta, del lado del cliente (D68).
 *
 * ---------------------------------------------------------------------------
 * Por qué se pregunta ANTES de enseñar el campo
 * ---------------------------------------------------------------------------
 * Al abrir el panel se llama a `/auth/me/deletion`, que contesta qué impide borrarse
 * ahora mismo. Si algo lo impide, el campo de confirmación ni aparece: se lee "tu coche
 * sigue en el valet" y ya. Al revés —campo primero, error después de teclear BORRAR—
 * el mensaje se lee como que el sistema no te quiere dejar ir, cuando en realidad hay
 * un auto suyo en el estacionamiento que nadie va a poder devolverle.
 *
 * ---------------------------------------------------------------------------
 * Por qué no hay un `confirm()` del navegador
 * ---------------------------------------------------------------------------
 * Porque un cuadro del navegador se acepta con un toque y esto no se deshace. Hay que
 * escribir la palabra. Y el botón queda apagado hasta que la palabra está escrita, para
 * que ni el toque ni el autocompletar del teléfono decidan esto por nadie.
 */
/* global EV2Screen */
(function () {
  'use strict';

  if (!window.EV2Screen) return;

  let ctx = null;
  let enganchado = false;
  const $ = (id) => document.getElementById(id);

  const PALABRA = 'BORRAR';
  const state = { abierto: false, puede: false };

  const t = (k, v) => (ctx ? ctx.t(k, v) : k);

  /** El texto de un motivo. El del servidor es el respaldo si algún día llega uno nuevo. */
  const textoMotivo = (b) => {
    const clave = `del.blocker.${b.reason}`;
    const texto = t(clave);
    return texto === clave ? (b.message || clave) : texto;
  };

  function pintarMotivos(blockers) {
    const caja = $('del-blockers');
    caja.innerHTML = '';
    caja.hidden = blockers.length === 0;
    for (const b of blockers) {
      const p = document.createElement('p');
      p.className = 'text-sm text-amber-300 flex items-start gap-2';
      const punto = document.createElement('span');
      punto.textContent = '•';
      punto.className = 'shrink-0';
      const texto = document.createElement('span');
      texto.textContent = textoMotivo(b);
      p.append(punto, texto);
      caja.appendChild(p);
    }
  }

  function refrescarBoton() {
    const campo = $('del-confirm');
    const boton = $('btn-del-go');
    if (!campo || !boton) return;
    const listo = campo.value.trim().toUpperCase() === PALABRA;
    boton.disabled = !listo;
    boton.style.opacity = listo ? '1' : '.45';
  }

  /** Pregunta al servidor y arma el panel con lo que conteste. */
  async function cargar() {
    const error = $('del-error');
    error.hidden = true;
    try {
      const r = await ctx.api.get('/auth/me/deletion');
      const d = r.data || {};
      state.puede = d.ok === true;
      pintarMotivos(d.blockers || []);
      $('del-form').hidden = !state.puede;
      $('del-confirm').value = '';
      refrescarBoton();
    } catch (err) {
      // Si no se pudo preguntar, el campo NO se enseña: ofrecer el borrado sin saber si
      // el coche está adentro es peor que pedir que se intente de nuevo.
      state.puede = false;
      $('del-form').hidden = true;
      ctx.showError(err, error);
    }
  }

  async function borrar() {
    const error = $('del-error');
    const boton = $('btn-del-go');
    error.hidden = true;
    boton.disabled = true;
    const antes = boton.textContent;
    boton.textContent = t('del.deleting');
    try {
      await ctx.api.del('/auth/me', { body: { confirm: $('del-confirm').value.trim() } });
      // La sesión ya no vale del lado del servidor. Se limpia aquí también para que la
      // pantalla no siga enseñando el nombre de una cuenta que acaba de dejar de existir.
      ctx.api.clearSession('account_deleted');
      window.location.replace(`index.html?borrada=1#${Date.now()}`);
    } catch (err) {
      boton.textContent = antes;
      // Un 409 trae los motivos: se repintan, porque entre abrir el panel y apretar el
      // botón pudo pasar una ronda de tragos.
      const detalles = err && err.details;
      if (detalles && Array.isArray(detalles.blockers) && detalles.blockers.length) {
        state.puede = false;
        pintarMotivos(detalles.blockers);
        $('del-form').hidden = true;
      } else {
        ctx.showError(err, error);
      }
      refrescarBoton();
    }
  }

  function enganchar() {
    if (enganchado || !$('btn-del-open')) return;
    enganchado = true;

    $('btn-del-open').onclick = async () => {
      state.abierto = !state.abierto;
      $('del-panel').hidden = !state.abierto;
      $('btn-del-open').textContent = t(state.abierto ? 'del.close' : 'del.open');
      if (state.abierto) await cargar();
    };

    $('del-confirm').addEventListener('input', refrescarBoton);
    $('btn-del-go').onclick = borrar;
    refrescarBoton();
  }

  EV2Screen.on('enter', (screen) => {
    ctx = screen;
    enganchar();
  });

  EV2Screen.on('language', () => {
    if (!ctx || !$('btn-del-open')) return;
    $('btn-del-open').textContent = t(state.abierto ? 'del.close' : 'del.open');
  });
}());
