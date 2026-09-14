/**
 * EV2 — la página que abre el invitado con el enlace que le llegó por WhatsApp.
 *
 * La abre alguien sin cuenta, desde un mensaje, probablemente en la banqueta. Por
 * eso NO usa `EV2.createClient` —ese cliente arrastra sesión, refresco de token y
 * reintentos que aquí no sirven de nada— sino un `fetch` pelón contra la ruta
 * pública.
 *
 * Lo único que esta pantalla decide es cómo se pinta lo que el servidor ya
 * juzgó. Quién puede entrar y quién no se decide en el servidor: una página que
 * dijera "adelante" por su cuenta sería una página que se puede editar desde el
 * inspector del navegador.
 */
/* global EV2Format, EV2DoorScan */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const meta = (name, fallback) => {
    const el = document.querySelector(`meta[name="${name}"]`);
    return (el && el.content) || fallback;
  };
  const API = meta('ev2:api', '/api');

  const t = (key, vars) => (vars ? EV2Format.tf(key, vars) : EV2Format.t(key));

  let actual = null;   // el pase que se está enseñando, para volver a pintarlo al cambiar idioma

  /** El payload firmado, tal como viene en el enlace. */
  function payloadFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const p = params.get('p');
    if (p) return p.trim();
    // WhatsApp a veces recorta el enlace y la gente lo pega a medias en la barra de
    // direcciones. Si el payload quedó en la ruta, también se acepta.
    const trozo = window.location.pathname.split('/').filter(Boolean).pop() || '';
    return trozo.startsWith('EV2P.') ? trozo : '';
  }

  function mostrarError() {
    $('pass-loading').hidden = true;
    $('pass-card').hidden = true;
    $('pass-error').hidden = false;
  }

  function render(pass) {
    actual = pass;
    $('pass-loading').hidden = true;
    $('pass-error').hidden = true;
    $('pass-card').hidden = false;

    $('pass-club').textContent = pass.club_name || '';
    // El apodo que el titular escribió para esta persona; si no puso ninguno, un
    // encabezado neutro. Nunca el nombre del titular: no es dato de quien lee.
    $('pass-for').textContent = pass.label
      ? t('pass.forYou', { name: pass.label })
      : t('pass.yours');
    $('pass-kind').textContent = t(`scan.kind_${pass.kind}`);

    // El QR llega dibujado del servidor. No se genera aquí a propósito: un QR mal
    // generado no falla, se ve bien y no lee, y eso se descubre en la fila.
    $('pass-qr').innerHTML = pass.qr_svg || '';
    $('pass-code').textContent = pass.code || '—';

    $('pass-table').textContent = pass.table_code
      ? t('scan.atTable', { table: pass.table_code })
        + (pass.section ? ` · ${pass.section}` : '')
      : t('take.noTable');
    $('pass-when').textContent = pass.starts_at ? EV2Format.dateTime(pass.starts_at) : '—';

    // El estado, y solo cuando hay algo que decir. Un pase que sirve no necesita un
    // cartel verde: el invitado ya sabe para qué abrió el enlace.
    const estado = $('pass-state');
    if (pass.usable) {
      estado.hidden = true;
      document.body.classList.remove('dead');
    } else {
      const vista = EV2DoorScan.view({ pass: { result: pass.result } });
      estado.textContent = t(vista.headlineKey);
      estado.style.background = vista.colors.bg;
      estado.style.border = `1px solid ${vista.colors.border}`;
      estado.style.color = vista.colors.text;
      estado.hidden = false;
      // El QR se apaga: si el pase no sirve, enseñarlo brillante hace que alguien se
      // forme veinte minutos para nada.
      document.body.classList.add('dead');
    }
  }

  async function cargar() {
    const p = payloadFromUrl();
    if (!p) { mostrarError(); return; }
    try {
      const res = await fetch(`${API}/guest-passes/${encodeURIComponent(p)}`, {
        headers: { Accept: 'application/json' },
      });
      // 404 es tanto "no existe" como "la firma no cuadra", y a propósito: decirle a
      // quien prueba enlaces cuál de las dos es sería ayudarlo.
      if (!res.ok) { mostrarError(); return; }
      const data = await res.json();
      if (!data.pass) { mostrarError(); return; }
      render(data.pass);
    } catch {
      $('pass-loading').textContent = t('error.network');
    }
  }

  /**
   * Guardar el código como imagen.
   *
   * Se dibuja el SVG en un canvas y se descarga el PNG. Vale la pena aunque suene
   * rebuscado: el invitado que guarda la imagen entra aunque llegue sin señal, y
   * "no me carga la página" en la puerta es el problema que esto evita. Si el
   * navegador no deja (algunos bloquean el canvas con SVG externo), se le dice que
   * tome una captura, que es lo que iba a hacer de todos modos.
   */
  function guardar() {
    const svg = $('pass-qr').querySelector('svg');
    if (!svg) return;
    const boton = $('btn-save');
    try {
      const texto = new XMLSerializer().serializeToString(svg);
      const img = new Image();
      img.onload = () => {
        const lado = 720;
        const canvas = document.createElement('canvas');
        canvas.width = lado;
        canvas.height = lado + 96;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, lado, lado);
        // El código escrito debajo, dentro de la misma imagen: si el invitado solo
        // guarda esto, tiene las dos maneras de entrar.
        ctx.fillStyle = '#000000';
        ctx.font = 'bold 46px Poppins, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(actual && actual.code ? actual.code : '', lado / 2, lado + 60);

        const enlace = document.createElement('a');
        enlace.download = `pase-${(actual && actual.code) || 'ev2'}.png`;
        enlace.href = canvas.toDataURL('image/png');
        enlace.click();
      };
      img.onerror = () => { boton.textContent = t('pass.saveFailed'); };
      img.src = `data:image/svg+xml;base64,${window.btoa(unescape(encodeURIComponent(texto)))}`;
    } catch {
      boton.textContent = t('pass.saveFailed');
    }
  }

  $('btn-save').onclick = guardar;

  $('btn-lang').onclick = () => {
    EV2Format.setLanguage(EV2Format.otherLanguage());
    EV2Format.applyTo(document);
    $('btn-lang').textContent = EV2Format.getLanguage() === 'es' ? 'English' : 'Español';
    if (actual) render(actual);
  };

  (function boot() {
    EV2Format.setLanguage(EV2Format.getLanguage());
    EV2Format.applyTo(document);
    $('btn-lang').textContent = EV2Format.getLanguage() === 'es' ? 'English' : 'Español';
    cargar();
  }());
}());
