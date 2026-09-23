/**
 * EV2 — pantalla del mesero y la hostess (paso 5.7, segunda mitad).
 *
 * Conecta el DOM con `EV2` (API y socket), `EV2Staff` (charolas, ocupación, propinas)
 * y `EV2Roles`. Las decisiones viven en `staff-floor.js` y están probadas ahí.
 */
/* global EV2TerminalCharge, EV2ShiftCut, EV2, EV2Format, EV2Staff, EV2Roles, EV2PasswordGate, EV2Door, EV2DoorScan,
          EV2Client, EV2DrinkArt, EV2OrderTaking */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const meta = (name, fallback) => {
    const el = document.querySelector(`meta[name="${name}"]`);
    return (el && el.content) || fallback;
  };

  const api = EV2.createClient({
    baseUrl: meta('ev2:api', '/api'),
    wsUrl: meta('ev2:ws', '') || null,
  });
  const CLUB_SLUG = meta('ev2:club', 'ev2');
  const FLOOR_ROLES = ['waiter', 'hostess', 'manager', 'admin'];
  const PASSWORD_GATE_HIDES = ['screen-auth', 'screen-wrong-role', 'screen-floor'];

  const state = {
    tab: 'trays', orders: [], tables: [], stats: null, tips: [],
    employee: null, currency: 'MXN', realtime: null, busy: new Set(), arrived: new Set(),
    reservations: [], doorSearch: '', terminals: [],
    doorSummary: null,
    // El catálogo de covers del club. Antes eran tres números escritos en este archivo:
    // el cadenero cobraba $300 y tecleaba 150, y el corte cuadraba contra un total que
    // él mismo había puesto. Ahora los pone el gerente y el servidor los verifica.
    covers: [],
    // El cover escogido y la clave del intento. La clave se conserva entre toques y solo
    // se renueva cuando una venta termina: así el segundo toque del mismo cobro
    // devuelve la MISMA entrada en vez de vender otra.
    sell: { coverId: null, requestId: null },
    drinks: [],
    // Lo que el mesero está levantando ahora mismo. `order` se llena cuando el pedido
    // ya existe en el servidor y solo falta cobrarlo: mientras esté ahí, cerrar la hoja
    // no borra el cobro pendiente, queda en la lista de "por cobrar".
    take: { open: false, table: null, guestId: null, cart: null, order: null, search: '', sending: false, pointId: null },
    // Los puntos de entrega de la pista y la terraza. Se cargan una vez: no cambian a
    // media noche, y pedirlos en cada pedido seria un viaje de mas con el cliente
    // enfrente.
    points: [],
  };

  const t = (key, vars) => (vars ? EV2Format.tf(key, vars) : EV2Format.t(key));
  const lang = () => EV2Format.getLanguage();
  const money = (a, c) => EV2Format.money(a, c || state.currency);
  const escape = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let toastTimer = null;
  function toast(message, kind = 'info') {
    const el = $('toast');
    el.textContent = message;
    el.className = 'fixed top-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-xl text-sm z-50 '
      + (kind === 'error' ? 'bg-red-500/90' : kind === 'ok' ? 'bg-emerald-500/90' : 'bg-slate-700/95');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
  }

  function banner(message) {
    const el = $('banner');
    if (!message) { el.hidden = true; return; }
    el.textContent = message;
    el.hidden = false;
  }

  function showError(err, where, opts) {
    const message = EV2Format.errorMessage(err, opts);
    if (where) { where.textContent = message; where.hidden = false; } else toast(message, 'error');
  }

  // ---------------------------------------------------------------- entrar

  $('form-login').onsubmit = async (ev) => {
    ev.preventDefault();
    $('auth-error').hidden = true;
    try {
      await api.login({
        nightclubSlug: CLUB_SLUG,
        email: $('login-email').value.trim(),
        password: $('login-password').value,
      });
      await afterSignIn();
    } catch (err) { showError(err, $('auth-error'), { context: 'login' }); }
  };

  async function signOut() {
    if (state.realtime) state.realtime.close();
    await api.logout();
    location.reload();
  }
  $('btn-logout').onclick = signOut;
  $('btn-wrong-logout').onclick = signOut;
  $('btn-pw-logout').onclick = signOut;

  $('btn-lang').onclick = () => {
    EV2Format.setLanguage(EV2Format.otherLanguage());
    EV2Format.applyTo(document);
    $('btn-lang').textContent = EV2Format.otherLanguage().toUpperCase();
    renderAll();
    if (!$('screen-wrong-role').hidden) renderWrongRole();
    setConnection(lastConnection.on, lastConnection.key, lastConnection.vars);
  };

  function showPasswordGate() {
    for (const id of PASSWORD_GATE_HIDES) $(id).hidden = true;
    $('screen-password').hidden = false;
    $('pw-error').hidden = true;
  }

  $('form-password').onsubmit = async (ev) => {
    ev.preventDefault();
    $('pw-error').hidden = true;
    const current = $('pw-current').value;
    const next = $('pw-new').value;
    const problem = EV2PasswordGate.validate(current, next, $('pw-repeat').value);
    if (problem) { $('pw-error').textContent = t(problem); $('pw-error').hidden = false; return; }
    const email = (api.session.user && api.session.user.email) || '';
    try {
      await api.post('/auth/password', { current_password: current, new_password: next });
      // El servidor cierra todas las sesiones al cambiarla: hay que entrar de nuevo.
      await api.login({ nightclubSlug: CLUB_SLUG, email, password: next });
      $('form-password').reset();
      $('screen-password').hidden = true;
      toast(t('gate.done'), 'ok');
      await afterSignIn();
    } catch (err) { showError(err, $('pw-error')); }
  };

  async function afterSignIn() {
    // El PIN se cambia donde está el teclado, no aquí (D46): mientras no lo cambie, el
    // servidor le bloquea todas las rutas y esta pantalla solo sabría dar errores.
    if (EV2PasswordGate.mustChangePin(api.session.user)) {
      location.href = EV2PasswordGate.PIN_PAGE;
      return;
    }
    if (EV2PasswordGate.isRequired(api.session.user)) { showPasswordGate(); return; }
    const role = api.session.user && api.session.user.role;
    if (!FLOOR_ROLES.includes(role)) {
      const home = EV2Roles.describe(role, lang());
      if (home.ready && home.home && home.home !== 'staff.html') { location.href = home.home; return; }
      renderWrongRole();
      $('screen-auth').hidden = true;
      $('screen-floor').hidden = true;
      $('screen-wrong-role').hidden = false;
      return;
    }
    $('screen-auth').hidden = true;
    $('screen-wrong-role').hidden = true;
    $('screen-floor').hidden = false;
    const user = api.session.user || {};
    $('me-name').textContent = user.display_name || '';
    $('me-role').textContent = EV2Roles.describe(user.role, lang()).label;
    await loadAll();
    connectRealtime();
    // El reloj de espera avanza solo: si no, "hace 2 min" se queda en 2 min toda la noche.
    setInterval(renderAll, 30000);
  }

  function renderWrongRole() {
    const role = api.session.user && api.session.user.role;
    const info = EV2Roles.describe(role, lang());
    $('wrong-role').textContent = info.label;
    $('wrong-role-note').textContent = info.step
      ? t('staff.pending', { step: info.step }) : t('staff.noScreen');
  }

  // ---------------------------------------------------------------- carga

  const clubId = () => api.session.user && api.session.user.nightclub_id;

  async function loadAll() {
    const club = clubId();
    const get = async (path, apply) => {
      try { apply(await api.get(path)); } catch (err) { showError(err); }
    };
    await Promise.all([
      get(`/nightclubs/${club}/orders?active=true&limit=100`, (d) => { state.orders = d.orders || []; }),
      get(`/nightclubs/${club}/tables`, (d) => { state.tables = d.tables || []; }),
      get(`/nightclubs/${club}/tables/stats`, (d) => { state.stats = d; }),
      get(`/nightclubs/${club}/staff/me/tips?limit=50`, (d) => { state.tips = d.tips || []; }),
      // `on_shift` viene aquí y no en /auth/me: es lo que decide el botón del turno.
      get('/employees/me', (d) => { state.employee = d.employee; }),
      // La puerta es de la anfitriona y del gerente; a un mesero el servidor le
      // contesta 403 y un error rojo en su pantalla no significa nada para él.
      isDoorRole()
        ? get(`/nightclubs/${club}/reservations?limit=200`,
          (d) => { state.reservations = d.reservations || []; })
        : Promise.resolve(),
      isDoorRole() ? loadDoorSummary() : Promise.resolve(),
      // Los covers del club. Sin catálogo la puerta sigue vendiendo con el importe
      // tecleado (y el servidor lo marca como tecleado); con catálogo, el precio deja
      // de escribirse a mano.
      isDoorRole()
        ? get(`/nightclubs/${club}/cover-prices`,
          (d) => { state.covers = (d.cover_prices || []).filter((c) => c.active); })
        : Promise.resolve(),
      // Las terminales del club. Si no hay ninguna, el método de tarjeta se ofrece
      // igual pero dice por qué no se puede, en vez de fallar desde el servidor con el
      // cliente enfrente.
      get(`/nightclubs/${club}/payment-terminals`, (d) => { state.terminals = d.terminals || []; }),
    ]);
    // El botón de la cámara solo aparece si este teléfono de verdad puede leer un
    // QR. Enseñarlo y que falle al tocarlo es peor que no enseñarlo: en la puerta
    // eso son diez segundos perdidos con alguien esperando.
    const camara = $('btn-scan-toggle');
    if (camara) camara.hidden = !camaraDisponible();
    renderAll();
  }

  async function loadOrders() {
    try {
      const d = await api.get(`/nightclubs/${clubId()}/orders?active=true&limit=100`);
      state.orders = d.orders || [];
    } catch (err) { showError(err); }
    renderAll();
  }

  async function loadTables() {
    const club = clubId();
    try {
      const [tables, stats] = await Promise.all([
        api.get(`/nightclubs/${club}/tables`),
        api.get(`/nightclubs/${club}/tables/stats`),
      ]);
      state.tables = tables.tables || [];
      state.stats = stats;
    } catch (err) { showError(err); }
    renderAll();
  }

  // ---------------------------------------------------------------- pintar

  const TABS = ['trays', 'tables', 'door', 'me'];

  const DOOR_ROLES = ['hostess', 'manager', 'admin'];
  const isDoorRole = () => DOOR_ROLES.includes(api.session.user && api.session.user.role);


  // ---------------------------------------------------------------- la puerta: leer un pase

  /**
   * El escáner y la venta de la entrada.
   *
   * La cámara es un lujo, no un requisito: `BarcodeDetector` no existe en Safari, y
   * en la puerta no hay tiempo para descubrirlo. Por eso el botón de la cámara solo
   * aparece cuando de verdad se puede usar, y el campo del código está siempre
   * disponible.
   */
  const scan = { stream: null, timer: null, last: null };

  /**
   * La revisión de identificación que está viva ahora mismo.
   *
   * Dura cinco minutos y sirve para UNA persona. Se guarda aquí y no en el
   * servidor-por-sesión porque es del guardia que la hizo: si otro escanea con
   * ella, el servidor la rechaza, y con razón — él no vio esa identificación.
   */
  const idc = { document: 'ine', check: null, timer: null, rejecting: false };

  const MOTIVOS_RECHAZO = [
    { key: 'idc.rejectMinor', reason: 'menor de edad' },
    { key: 'idc.rejectInvalid', reason: 'identificación no válida' },
    { key: 'idc.rejectOther', reason: 'otro motivo' },
  ];

  const camaraDisponible = () => (
    typeof window.BarcodeDetector === 'function'
    && navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function'
  );

  function pintarResultado(respuesta) {
    const v = EV2DoorScan.view(respuesta);
    scan.last = v;

    const caja = $('scan-result');
    caja.hidden = false;
    caja.style.background = v.colors.bg;
    caja.style.border = `1px solid ${v.colors.border}`;

    const titulo = $('scan-headline');
    titulo.textContent = t(v.headlineKey);
    titulo.style.color = v.colors.text;

    // Quién es, en el orden en que la puerta lo necesita: primero el apodo que el
    // titular escribió para ESTA persona —es lo que el guardia va a decir en voz
    // alta— y después de quién es la mesa.
    $('scan-who').textContent = [
      v.label ? t('scan.forGuest', { name: v.label }) : null,
      v.guest,
      v.table ? t('scan.atTable', { table: v.table }) : null,
    ].filter(Boolean).join(' · ');

    const detalle = [];
    if (v.kind) detalle.push(t(`scan.kind_${v.kind}`));
    // Cuántos de esa mesa van adentro. Es lo que evita el "déjame preguntar" por
    // radio cuando llega el sexto de ocho.
    if (v.inside !== null && v.guestCount) {
      detalle.push(t('scan.inside', { inside: v.inside, total: v.guestCount }));
    } else if (v.guestCount) {
      detalle.push(t('scan.people', { count: v.guestCount }));
    }
    if (v.extras) detalle.push(t('scan.extras', { count: v.extras }));
    if (v.idCheckReason) detalle.push(v.idCheckReason);
    if ((v.result === 'already_in' || v.result === 'used') && v.checkedInAt) {
      detalle.push(t('scan.since', { time: EV2Format.time(v.checkedInAt) }));
    }
    if (v.result === 'not_tonight' && v.startsAt) {
      detalle.push(EV2Format.dateTime(v.startsAt));
    }
    // Lo que el cliente pidió al reservar se lee AQUÍ, que es cuando sirve: un
    // cumpleaños o una silla de ruedas se resuelven en la puerta, no después.
    if (v.notes) detalle.push(v.notes);
    $('scan-detail').textContent = detalle.join(' · ');

    // Los extras se cobran contra un pase concreto, así que el botón solo se
    // enciende cuando hay uno leído.
    $('btn-sell-extra').disabled = !EV2DoorScan.canSellExtra(v);
    renderVenta();

    if (v.ok) {
      toast(t('scan.letIn', { name: v.guest || '' }), 'ok');
      try { if (navigator.vibrate) navigator.vibrate(120); } catch { /* algunos lo bloquean */ }
      loadDoorSummary().catch(() => {});
      loadAll().catch(() => {});
    }
  }

  async function leerPase(code) {
    const limpio = String(code || '').trim();
    const bloqueo = EV2DoorScan.scanBlocker({
      code: limpio, idCheckId: idc.check && idc.check.id,
    });
    if (bloqueo) {
      // No se manda nada: el servidor lo rechazaría y la persona de la puerta
      // solo vería un error sin saber qué le falta.
      toast(t(bloqueo), 'error');
      return;
    }
    $('btn-scan-code').disabled = true;
    try {
      const data = await api.post(`/nightclubs/${clubId()}/door/check-in`, {
        code: limpio, id_check_id: idc.check.id,
      });
      pintarResultado(data);
      $('scan-code').value = '';
      // La revisión se gastó con el escaneo, abriera o no: si el pase estaba mal,
      // esa identificación ya se miró y la siguiente persona necesita la suya.
      // Solo se conserva cuando lo que falló fue la propia revisión, para que el
      // guardia pueda leer el motivo antes de volver a pedirla.
      if (!(data.id_check && data.id_check.ok === false)) limpiarIdCheck();
    } catch (err) {
      showError(err);
    } finally {
      $('btn-scan-code').disabled = false;
    }
  }

  // ------------------------------------------------- la identificación, paso 1

  /** El campo del código solo se abre con una revisión viva. */
  function renderIdCheck() {
    const viva = Boolean(idc.check);
    $('scan-code').disabled = !viva;
    $('btn-scan-code').disabled = !viva;
    $('scan-blocked').hidden = viva;

    const estado = $('idc-state');
    if (!viva) {
      estado.hidden = true;
    } else {
      const quedan = EV2DoorScan.idCheckRemaining(idc.check);
      estado.textContent = `${t('idc.ready')} · ${t('idc.expiresIn', { seconds: quedan })}`;
      estado.style.background = 'rgba(0,255,0,.08)';
      estado.style.color = '#7CFF7C';
      estado.hidden = false;
      if (quedan <= 0) limpiarIdCheck(t('idc.expired'));
    }

    $('idc-docs').innerHTML = EV2DoorScan.ID_DOCUMENTS.map((d) => `
      <button type="button" data-doc="${d}"
        class="px-3 py-1.5 rounded-full text-xs ${d === idc.document ? 'ev2-button' : 'card'}">
        ${t(EV2DoorScan.documentKey(d))}
      </button>`).join('');
    for (const b of $('idc-docs').querySelectorAll('[data-doc]')) {
      b.onclick = () => { idc.document = b.dataset.doc; renderIdCheck(); };
    }

    $('idc-reject-why').hidden = !idc.rejecting;
    $('idc-reasons').innerHTML = MOTIVOS_RECHAZO.map((m, i) => `
      <button type="button" data-motivo="${i}" class="px-3 py-1.5 rounded-full text-xs card">
        ${t(m.key)}
      </button>`).join('');
    for (const b of $('idc-reasons').querySelectorAll('[data-motivo]')) {
      b.onclick = () => rechazarIdentificacion(MOTIVOS_RECHAZO[Number(b.dataset.motivo)].reason);
    }
  }

  function limpiarIdCheck(mensaje) {
    idc.check = null;
    idc.rejecting = false;
    clearInterval(idc.timer);
    idc.timer = null;
    renderIdCheck();
    if (mensaje) {
      const estado = $('idc-state');
      estado.textContent = mensaje;
      estado.style.background = 'rgba(255,193,7,.08)';
      estado.style.color = '#FFD666';
      estado.hidden = false;
    }
  }

  async function aceptarIdentificacion() {
    $('btn-idc-accept').disabled = true;
    try {
      const body = EV2DoorScan.idCheckPayload({ document: idc.document, adult: true });
      const data = await api.post(`/nightclubs/${clubId()}/door/id-checks`, body);
      idc.check = data.id_check;
      idc.rejecting = false;
      renderIdCheck();
      // La cuenta atrás en pantalla: una revisión que se vence mientras el guardia
      // teclea es un escaneo que falla sin explicación aparente.
      clearInterval(idc.timer);
      idc.timer = setInterval(renderIdCheck, 1000);
      $('scan-code').focus();
    } catch (err) {
      showError(err);
    } finally {
      $('btn-idc-accept').disabled = false;
    }
  }

  async function rechazarIdentificacion(motivo) {
    try {
      const body = EV2DoorScan.idRejectionPayload({ document: idc.document, reason: motivo });
      await api.post(`/nightclubs/${clubId()}/door/id-checks`, body);
      // Queda registrado y NO abre nada. El pase de esa persona sigue vivo, así que
      // el titular puede reasignarlo esa misma noche: por eso se dice aquí.
      limpiarIdCheck(t('idc.rejected'));
      toast(t('idc.rejected'), 'ok');
    } catch (err) {
      showError(err);
    }
  }

  // ------------------------------------------------- llegó sin su código

  const look = { rows: [], chosen: null };

  function renderLookup() {
    const lista = $('look-list');
    if (!look.rows.length) {
      lista.innerHTML = '';
      $('cont-box').hidden = true;
      return;
    }
    lista.innerHTML = look.rows.map((r) => {
      const resumen = EV2DoorScan.lookupSummary(r);
      const elegido = look.chosen && look.chosen.id === r.id;
      return `
        <button type="button" data-res="${r.id}"
          class="w-full text-left rounded-xl p-3 ${elegido ? 'ev2-button' : 'card'}">
          <p class="font-display text-sm">${escape(r.holder_name || '')}</p>
          <p class="text-xs ${elegido ? 'text-black/70' : 'text-white/60'}">
            ${escape(t('scan.atTable', { table: r.table_code || '?' }))}
            · ${escape(t('look.passes', { used: resumen.used, total: resumen.total }))}
          </p>
          ${r.phone_last4 ? `<p class="text-[11px] ${elegido ? 'text-black/60' : 'text-white/40'}">${escape(t('look.phoneAsk', { last4: r.phone_last4 }))}</p>` : ''}
        </button>`;
    }).join('');
    for (const b of lista.querySelectorAll('[data-res]')) {
      b.onclick = () => {
        look.chosen = look.rows.find((r) => r.id === b.dataset.res) || null;
        renderLookup();
      };
    }

    $('cont-box').hidden = !look.chosen;
    if (look.chosen) {
      $('cont-note').textContent = t('cont.note', { minutes: 45 });
      $('cont-for').textContent = `${look.chosen.holder_name} · ${t('scan.atTable', { table: look.chosen.table_code || '?' })}`;
    }
  }

  async function buscarSinCodigo(q) {
    const bloqueo = EV2DoorScan.lookupBlocker(q);
    $('look-error').hidden = !bloqueo;
    $('look-error').textContent = bloqueo ? t(bloqueo) : '';
    if (bloqueo) return;
    $('btn-look').disabled = true;
    try {
      const data = await api.get(
        `/nightclubs/${clubId()}/door/lookup?q=${encodeURIComponent(String(q).trim())}`);
      look.rows = data.reservations || [];
      look.chosen = look.rows.length === 1 ? look.rows[0] : null;
      if (!look.rows.length) {
        $('look-error').textContent = t('look.none');
        $('look-error').hidden = false;
      }
      $('cont-result').hidden = true;
      renderLookup();
    } catch (err) {
      showError(err);
    } finally {
      $('btn-look').disabled = false;
    }
  }

  async function emitirContingencia() {
    const datos = {
      reservationId: look.chosen && look.chosen.id,
      label: $('cont-label').value,
      reason: $('cont-reason').value,
    };
    const bloqueo = EV2DoorScan.contingencyBlocker(datos);
    $('cont-error').hidden = !bloqueo;
    $('cont-error').textContent = bloqueo ? t(bloqueo) : '';
    if (bloqueo) return;

    $('btn-cont').disabled = true;
    try {
      const data = await api.post(`/nightclubs/${clubId()}/door/passes/contingency`,
        EV2DoorScan.contingencyPayload(datos));
      $('cont-code').textContent = data.pass.code;
      $('cont-result').hidden = false;
      $('cont-reason').value = '';
      toast(t('cont.done'), 'ok');
    } catch (err) {
      showError(err);
    } finally {
      $('btn-cont').disabled = false;
    }
  }

  async function pararCamara() {
    clearInterval(scan.timer);
    scan.timer = null;
    if (scan.stream) {
      for (const track of scan.stream.getTracks()) track.stop();
      scan.stream = null;
    }
    $('scan-camera').hidden = true;
    $('btn-scan-toggle').textContent = t('scan.start');
  }

  async function arrancarCamara() {
    try {
      scan.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }, audio: false,
      });
      const video = $('scan-video');
      video.srcObject = scan.stream;
      await video.play();
      $('scan-camera').hidden = false;
      $('btn-scan-toggle').textContent = t('scan.stop');

      const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      let ocupado = false;
      scan.timer = setInterval(async () => {
        if (ocupado) return;
        ocupado = true;
        try {
          const codes = await detector.detect(video);
          if (codes && codes.length) {
            const valor = codes[0].rawValue;
            await pararCamara();
            await leerPase(valor);
          }
        } catch { /* un cuadro ilegible no es un error: viene otro en 300ms */ } finally {
          ocupado = false;
        }
      }, 300);
    } catch {
      // Permiso negado, sin cámara, o el navegador no deja. Se dice y se sigue
      // tecleando, que es lo que de verdad no falla.
      await pararCamara();
      toast(t('scan.noCamera'), 'error');
      $('scan-code').focus();
    }
  }

  // ---------------------------------------------------------------- vender la entrada

  function renderVenta() {
    const cantidad = $('sell-qty').value;
    const precio = $('sell-price').value;
    $('sell-total').textContent = precio === '' ? '—'
      : money(EV2DoorScan.total(cantidad, precio), 'MXN');
  }

  function renderMetodos() {
    const select = $('sell-method');
    if (select.dataset.filled === '1') return;
    for (const m of EV2DoorScan.METHODS) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = t(EV2DoorScan.methodKey(m));
      select.appendChild(opt);
    }
    select.dataset.filled = '1';
  }

  /**
   * Los covers del club, de un toque.
   *
   * Se pintan del catálogo que da el servidor, no de una lista escrita aquí. Escoger uno
   * manda su id y ningún importe: el precio lo pone el catálogo y la puerta no lo teclea.
   * Mientras el club no cargue ninguno, el campo del importe sigue sirviendo.
   */
  function renderCoversRapidos() {
    const box = $('sell-quick');
    if (!box) return;
    box.innerHTML = '';
    const precio = $('sell-price');
    const hayCatalogo = state.covers.length > 0;
    if (precio) {
      precio.readOnly = hayCatalogo;
      precio.classList.toggle('opacity-60', hayCatalogo);
      precio.placeholder = hayCatalogo ? t('sell.pickCover') : '';
    }
    for (const cover of state.covers) {
      const b = document.createElement('button');
      b.type = 'button';
      const elegido = state.sell.coverId === cover.id;
      b.className = `px-2 py-1 rounded-lg text-[11px] card${elegido ? ' active' : ''}`;
      b.setAttribute('aria-pressed', elegido ? 'true' : 'false');
      b.textContent = `${cover.name} · ${EV2Format.money(cover.amount, cover.currency)}`;
      b.onclick = () => {
        state.sell.coverId = elegido ? null : cover.id;
        $('sell-price').value = elegido ? '' : String(cover.amount);
        renderCoversRapidos();
        renderVenta();
      };
      box.appendChild(b);
    }
  }

  async function vender(kind) {
    const error = $('sell-error');
    error.hidden = true;
    const reservationId = scan.last ? scan.last.reservationId : null;
    const problema = EV2DoorScan.sellBlocker(kind, {
      unitPrice: $('sell-price').value,
      reservationId,
      coverPriceId: state.sell.coverId,
      covers: state.covers,
    });
    if (problema) { error.textContent = t(problema); error.hidden = false; return; }

    // La clave del intento se crea una vez y se conserva: si el primer toque se queda
    // pensando y el cadenero toca otra vez, el servidor devuelve la MISMA entrada.
    if (!state.sell.requestId) state.sell.requestId = EV2.uuid();
    const body = EV2DoorScan.admissionPayload(kind, {
      quantity: $('sell-qty').value,
      unitPrice: $('sell-price').value,
      coverPriceId: state.sell.coverId,
      clientRequestId: state.sell.requestId,
      method: $('sell-method').value,
      reservationId,
    });
    const boton = kind === 'general' ? $('btn-sell-general') : $('btn-sell-extra');
    boton.disabled = true;
    try {
      const data = await api.post(`/nightclubs/${clubId()}/door/admissions`, body);
      toast(t('sell.done', { total: money(data.admission.total, data.admission.currency) }), 'ok');
      $('sell-qty').value = '1';
      // La venta terminó: la siguiente persona es otra entrada y necesita otra clave.
      state.sell.requestId = null;
      renderVenta();
      await loadDoorSummary();
    } catch (err) {
      error.textContent = EV2Format.errorMessage(err);
      error.hidden = false;
    } finally {
      boton.disabled = kind === 'vip_extra' && !EV2DoorScan.canSellExtra(scan.last);
    }
  }

  // ---------------------------------------------------------------- el aforo

  async function loadDoorSummary() {
    try {
      const data = await api.get(`/nightclubs/${clubId()}/door/summary`);
      state.doorSummary = data;
      renderDoorSummary();
    } catch { /* el aforo es informativo: si falla, la puerta sigue funcionando */ }
  }

  function renderDoorSummary() {
    const s = state.doorSummary;
    if (!s) return;
    $('d-inside').textContent = String(s.inside);
    $('d-general').textContent = String(s.door.generales);
    $('d-extras').textContent = String(s.door.extras_vip);
    $('d-taken').textContent = money(s.door.cobrado, s.door.currency);
  }

  function renderAll() {
    // La pestaña de la puerta solo existe para quien recibe en la entrada. Escondida
    // es mejor que deshabilitada: un mesero no tiene por qué preguntarse qué hay ahí.
    const doorTab = document.querySelector('[data-tab="door"]');
    if (doorTab) doorTab.hidden = !isDoorRole();
    if (state.tab === 'door' && !isDoorRole()) state.tab = 'trays';

    for (const tab of TABS) $(`tab-${tab}`).hidden = tab !== state.tab;
    document.querySelectorAll('[data-tab]').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === state.tab);
    });
    renderTrays();
    renderTables();
    if (isDoorRole()) {
      renderDoor();
      renderMetodos();
      renderCoversRapidos();
      renderVenta();
      renderDoorSummary();
    }
    // La cámara se apaga al salir de la puerta: dejarla prendida en otra pestaña
    // gasta batería toda la noche y enciende una luz que nadie está mirando.
    if (state.tab !== 'door' && scan.stream) pararCamara();
    renderMe();
  }

  // ---------------------------------------------------------------- la puerta

  function renderDoor() {
    const now = new Date();
    const summary = EV2Door.summary(state.reservations, now);
    $('d-expected').textContent = String(summary.expected);
    $('d-seated').textContent = String(summary.seated);
    $('d-late').textContent = String(summary.late);
    $('d-guests').textContent = String(summary.guestsInside);

    const visible = EV2Door.sortForDoor(
      EV2Door.search(state.reservations, state.doorSearch), now);
    $('door-empty').hidden = visible.length > 0;
    // Liberar mesas vencidas solo se ofrece si de verdad hay alguna: un botón que no
    // hace nada enseña a ignorarlo.
    $('btn-release').hidden = summary.late === 0;

    const box = $('door-list');
    box.innerHTML = '';

    for (const r of visible) {
      const urgency = EV2Door.urgency(r, now);
      const card = document.createElement('div');
      card.className = 'card rounded-xl p-3 space-y-2';
      if (urgency === 'late') {
        card.style.borderColor = 'var(--ev2-red)';
        card.style.background = 'rgba(255,68,68,.08)';
      } else if (urgency === 'soon') {
        card.style.borderColor = 'var(--ev2-gold)';
      }

      const head = document.createElement('div');
      head.className = 'flex justify-between items-start gap-3';
      const left = document.createElement('div');
      left.className = 'min-w-0';
      const who = document.createElement('p');
      who.className = 'font-display text-lg truncate';
      who.textContent = r.user_name || '—';
      const detail = document.createElement('p');
      detail.className = 'text-xs text-white/50';
      detail.textContent = [
        r.table_code || r.table_number,
        r.section,
        t('door.party', { count: Number(r.guest_count) || 0 }),
      ].filter(Boolean).join(' · ');
      left.append(who, detail);

      const status = document.createElement('span');
      status.className = 'text-xs shrink-0';
      status.textContent = t(EV2Door.statusLabel(r.status));
      head.append(left, status);
      card.appendChild(head);

      // El tiempo que le queda va grande y con color: es lo que decide si la
      // anfitriona espera o libera la mesa.
      const countdown = EV2Door.countdown(r, now);
      if (countdown && r.status !== 'seated') {
        const note = document.createElement('p');
        note.className = 'text-sm';
        note.style.color = urgency === 'late' ? 'var(--ev2-red)'
          : urgency === 'soon' ? 'var(--ev2-gold)' : 'rgba(255,255,255,.6)';
        note.textContent = countdown.expired
          ? t('door.overdue')
          : t('door.minutesLeft', { minutes: countdown.minutes });
        card.appendChild(note);
      }

      if (r.special_requests) {
        const req = document.createElement('p');
        req.className = 'text-sm text-white/80 italic';
        req.textContent = `“${r.special_requests}”`;
        card.appendChild(req);
      }

      const actions = EV2Door.actionsFor(r);
      if (actions.length) {
        const row = document.createElement('div');
        row.className = 'flex gap-2';
        for (const action of actions) {
          const b = document.createElement('button');
          b.className = action.primary
            ? 'ev2-button rounded-lg px-4 py-3 font-display flex-1'
            : 'card rounded-lg px-3 py-3 text-sm text-red-300';
          b.textContent = t(action.key);
          b.onclick = () => {
            // Marcar que no llegó libera una mesa que alguien pagó: se confirma.
            if (action.confirm && !window.confirm(t('door.confirmNoShow'))) return;
            setReservation(r, action.status, b);
          };
          row.appendChild(b);
        }
        card.appendChild(row);
      }
      box.appendChild(card);
    }
  }

  async function setReservation(reservation, status, button) {
    button.disabled = true;
    try {
      await api.post(`/nightclubs/${clubId()}/reservations/${reservation.id}/status`, { status });
      if (status === 'seated') toast(t('door.seated1'), 'ok');
      if (status === 'no_show') toast(t('door.noShow1'), 'ok');
      await loadAll();
    } catch (err) {
      showError(err);
      button.disabled = false;
    }
  }

  $('door-search').oninput = (ev) => {
    state.doorSearch = ev.target.value;
    if (isDoorRole()) renderDoor();
  };

  $('btn-release').onclick = async () => {
    // Por id, no por `ev.currentTarget`: el navegador lo pone en null en cuanto el
    // manejador regresa, y con un `await` de por medio el `finally` revienta.
    $('btn-release').disabled = true;
    try {
      const data = await api.post(`/nightclubs/${clubId()}/reservations/release-no-shows`, {});
      toast(t('door.released', { count: (data.released || []).length || data.count || 0 }), 'ok');
      await loadAll();
    } catch (err) {
      showError(err);
    } finally {
      $('btn-release').disabled = false;
    }
  };

  document.querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => { state.tab = b.dataset.tab; renderAll(); };
  });

  // ------------------------------------------------- levantar pedido: enganches

  $('btn-take-close').onclick = closeTake;
  $('btn-take-floor').onclick = openTakeOnFloor;
  $('take-point').onchange = (ev) => { state.take.pointId = ev.target.value || null; renderTake(); };
  $('btn-take-send').onclick = sendTake;
  $('btn-take-charge').onclick = chargeTake;
  $('take-method').onchange = onMethodChange;
  $('take-search').oninput = (ev) => { state.take.search = ev.target.value; renderTake(); };
  $('take-guest-select').onchange = (ev) => {
    state.take.guestId = ev.target.value || null;
    renderTake();
  };

  // ---------------------------------------------------------------- puerta: enganches

  $('scan-form').onsubmit = (ev) => {
    ev.preventDefault();
    leerPase($('scan-code').value);
  };
  // Lo que se teclea se normaliza mientras se escribe: lo que se ve es lo que se manda.
  $('scan-code').oninput = (ev) => {
    const input = ev.currentTarget;
    const limpio = input.value.toUpperCase();
    if (limpio !== input.value) input.value = limpio;
  };
  $('btn-scan-toggle').onclick = () => (scan.stream ? pararCamara() : arrancarCamara());
  $('btn-idc-accept').onclick = aceptarIdentificacion;
  $('btn-idc-reject').onclick = () => { idc.rejecting = !idc.rejecting; renderIdCheck(); };
  $('look-form').onsubmit = (ev) => { ev.preventDefault(); buscarSinCodigo($('look-q').value); };
  $('btn-cont').onclick = emitirContingencia;
  $('btn-cont-use').onclick = () => {
    $('scan-code').value = $('cont-code').textContent.trim();
    $('scan-code').focus();
  };
  renderIdCheck();
  $('btn-sell-general').onclick = () => vender('general');
  $('btn-sell-extra').onclick = () => vender('vip_extra');
  $('sell-qty').oninput = renderVenta;
  $('sell-price').oninput = renderVenta;

  function renderTrays() {
    const now = Date.now();
    const s = EV2Staff.summary(state.orders, now);
    $('s-trays').textContent = s.trays;
    $('s-items').textContent = s.items;
    $('s-coming').textContent = s.coming;
    $('s-oldest').textContent = s.oldest === null ? '—' : t('bar.minutes', { n: s.oldest });
    $('count-trays').textContent = s.trays;

    const list = EV2Staff.trays(state.orders, now);
    $('trays-empty').hidden = list.length > 0;
    $('trays-list').innerHTML = list.map((group) => {
      const wait = group.waitMinutes === null ? ''
        : (group.waitMinutes < 1 ? t('bar.justNow') : t('bar.minutes', { n: group.waitMinutes }));
      const flash = group.orders.some((o) => state.arrived.has(o.id)) ? ' just-arrived' : '';
      const busy = group.orders.some((o) => state.busy.has(o.id));
      const detail = group.orders.map((o) => `
        <p class="text-sm text-white/70">${escape((o.items || []).map((i) => `${i.quantity}× ${i.name || ''}`).join(', '))}
          <span class="text-white/40">· ${escape(o.recipient_name ? `${t('bar.gift')}: ${o.recipient_name}` : (o.sender_name || ''))}</span></p>`).join('');
      return `
      <article class="card wait-${group.urgency}${flash} rounded-xl p-4" data-tray="${escape(group.table_id || '')}">
        <div class="flex justify-between items-start gap-3">
          <div class="min-w-0">
            <p class="font-display text-xl">${group.table_code
    ? `${escape(t('floor.tableShort'))} ${escape(group.table_code)}`
    : escape(t('floor.noTable'))}</p>
            ${detail}
          </div>
          <p class="text-xs flex-none ${group.urgency === 'late' ? 'text-red-300' : group.urgency === 'warn' ? 'text-amber-300' : 'text-white/50'}">${escape(wait)}</p>
        </div>
        <button class="ev2-button w-full rounded-lg py-3 mt-3 font-display" data-deliver="${escape(group.table_id || '')}" ${busy ? 'disabled' : ''}>
          ${escape(t('floor.deliver'))} · ${group.items}
        </button>
      </article>`;
    }).join('');

    $('trays-list').querySelectorAll('[data-deliver]').forEach((b) => {
      b.onclick = () => deliverTray(b.dataset.deliver);
    });
  }

  /**
   * Un toque entrega TODA la charola de esa mesa: el mesero hace un viaje, no uno por
   * pedido. Cada pedido es su propia llamada, y si una falla se dice cuál.
   */
  async function deliverTray(tableId) {
    const group = EV2Staff.trays(state.orders).find((g) => (g.table_id || '') === tableId);
    if (!group) return;
    for (const order of group.orders) state.busy.add(order.id);
    renderTrays();
    let failed = 0;
    for (const order of group.orders) {
      try {
        await api.post(`/nightclubs/${clubId()}/orders/${order.id}/status`, { status: 'delivered' });
      } catch (err) {
        failed += 1;
        showError(err);
      }
    }
    for (const order of group.orders) state.busy.delete(order.id);
    await loadOrders();
    if (!failed) toast(t('floor.delivered'), 'ok');
  }

  function renderTables() {
    const o = EV2Staff.occupancy(state.stats);
    $('o-occupied').textContent = o.occupied;
    $('o-free').textContent = o.free;
    $('o-guests').textContent = o.guests;

    renderUnpaid();

    // TODAS las mesas que se pueden atender, no solo las que tienen gente registrada:
    // el cliente de general no está en la app y aun así hay que poder pedirle.
    const mesas = EV2OrderTaking.servableTables(state.tables);
    $('tables-list').innerHTML = mesas.map((table) => `
      <div class="card rounded-xl p-3" data-table="${escape(table.id)}">
        <div class="flex justify-between items-center gap-2">
          <div class="min-w-0">
            <p class="font-display">${escape(t('floor.tableShort'))} ${escape(table.code)}
              <span class="text-xs text-white/40">${escape(table.section)}</span></p>
            <p class="text-xs text-white/60">${table.guests.length
    ? escape(table.guests.map((g) => g.name || '—').join(', '))
    : escape(t('take.noGuests'))}</p>
          </div>
          <span class="pill ${table.guests.length ? 'pill-wait' : ''} flex-none">${table.guests.length}/${table.capacity}</span>
        </div>
        <div class="flex flex-wrap gap-2 mt-2">
          <button class="ev2-button rounded-lg px-3 py-2 text-xs font-display" data-take="1">
            ${escape(t('take.open'))}
          </button>
          <button class="card rounded-lg px-3 py-2 text-xs" data-bill="1">
            ${escape(t('bill.print'))}
          </button>
          ${table.guests.map((g) => `
            <button class="card rounded-lg px-3 py-2 text-xs text-red-300" data-release="${escape(g.id)}">
              ${escape(t('floor.release'))}: ${escape(g.name || '—')}
            </button>`).join('')}
        </div>
      </div>`).join('');

    $('tables-list').querySelectorAll('[data-table]').forEach((el) => {
      const mesa = mesas.find((m) => m.id === el.dataset.table);
      el.querySelectorAll('[data-release]').forEach((b) => {
        b.onclick = () => releaseGuest(el.dataset.table, b.dataset.release);
      });
      const abrir = el.querySelector('[data-take]');
      if (abrir) abrir.onclick = () => openTake(mesa);
      const cuenta = el.querySelector('[data-bill]');
      if (cuenta) cuenta.onclick = () => printBill(el.dataset.table, cuenta);
    });
  }

  /**
   * La cuenta de la mesa, en papel (D53).
   *
   * Primero se pregunta cuánto es y se enseña antes de imprimir. Son dos viajes al
   * servidor en vez de uno, y valen la pena: imprimir la mesa equivocada significa
   * llevarle a alguien la cuenta de otro, que es de los errores que no se arreglan
   * con una disculpa.
   */
  async function printBill(tableId, button) {
    const antes = button.textContent;
    button.disabled = true;
    button.textContent = t('bill.asking');
    try {
      const { bill } = await api.get(`/nightclubs/${clubId()}/tables/${tableId}/bill`);
      if (!bill.lines.length) { toast(t('bill.empty'), 'info'); return; }
      const resumen = Number(bill.due) > 0
        ? t('bill.confirmDue', {
          code: bill.table.code,
          total: money(bill.total, bill.currency),
          due: money(bill.due, bill.currency),
        })
        : t('bill.confirm', {
          code: bill.table.code, total: money(bill.total, bill.currency),
        });
      if (!window.confirm(resumen)) return;

      button.textContent = t('bill.sending');
      await api.post(`/nightclubs/${clubId()}/tables/${tableId}/bill/print`, {});
      toast(t('bill.sent'), 'ok');
    } catch (err) {
      // Aquí no se puede callar: el cliente está enfrente esperando su papel.
      showError(err);
    } finally {
      button.disabled = false;
      button.textContent = antes;
    }
  }

  /**
   * Lo que alguien pidió desde su teléfono y sigue sin pagar. La barra no lo va a
   * preparar, así que si nadie lo cobra, el cliente espera un trago que nunca se hizo.
   */
  function renderUnpaid() {
    const pendientes = EV2OrderTaking.awaitingPayment(state.orders);
    $('unpaid-block').hidden = pendientes.length === 0;
    // También en la pestaña: si no se ve desde "Por llevar", nadie va a cobrarlo.
    $('count-unpaid').textContent = String(pendientes.length);
    $('count-unpaid').hidden = pendientes.length === 0;
    $('unpaid-list').innerHTML = pendientes.map((order) => `
      <div class="flex items-center justify-between gap-2" data-unpaid="${escape(order.id)}">
        <div class="min-w-0">
          <p class="text-sm truncate">${escape(order.sender_name || '—')}
            <span class="text-white/40">${order.table_code ? escape(`· ${t('floor.tableShort')} ${order.table_code}`) : ''}</span></p>
          <p class="text-xs text-white/50 truncate">${escape((order.items || []).map((i) => `${i.quantity}× ${i.name}`).join(', '))}</p>
        </div>
        <button class="ev2-button rounded-lg px-3 py-2 text-xs font-display flex-none">
          ${escape(money(order.subtotal, order.currency))}
        </button>
      </div>`).join('');

    $('unpaid-list').querySelectorAll('[data-unpaid]').forEach((el) => {
      const order = pendientes.find((o) => o.id === el.dataset.unpaid);
      el.querySelector('button').onclick = () => openCharge(order);
    });

    renderReady();
  }

  /**
   * Lo que la barra ya tiene listo, en el orden en que se enfria.
   *
   * Ordenado por la hora en que quedo LISTO y no por la hora en que se pidio: el trago
   * que lleva mas tiempo en la barra es el que hay que levantar primero, aunque se haya
   * pedido despues.
   */
  function renderReady() {
    const listos = EV2OrderTaking.readyToDeliver(state.orders,
      { waiterId: api.session.user && api.session.user.id });
    $('ready-block').hidden = listos.length === 0;
    const now = Date.now();
    $('ready-list').innerHTML = listos.map((order) => {
      const minutos = EV2OrderTaking.waitingSince(order, now);
      const donde = order.delivery_point_name && order.delivery_point_kind !== 'table'
        ? order.delivery_point_name
        : (order.table_code ? `${t('floor.tableShort')} ${order.table_code}` : t('take.noTable'));
      return `
      <div class="flex items-center justify-between gap-2" data-ready="${escape(order.id)}">
        <div class="min-w-0">
          <p class="text-sm truncate">${escape(donde)}
            <span class="text-white/40">${order.bar_name ? escape(`· ${order.bar_name}`) : ''}</span></p>
          <p class="text-xs text-white/50 truncate">${escape((order.items || []).map((i) => `${i.quantity}× ${i.name}`).join(', '))}</p>
          <p class="text-[11px] ${minutos >= 5 ? 'text-amber-300' : 'text-white/40'}">
            ${escape(minutos === null ? '' : t('take.readyFor', { n: minutos }))}
          </p>
        </div>
        <button class="ev2-button rounded-lg px-3 py-2 text-xs font-display flex-none">
          ${escape(t('take.delivered'))}
        </button>
      </div>`;
    }).join('');

    $('ready-list').querySelectorAll('[data-ready]').forEach((el) => {
      el.querySelector('button').onclick = () => deliver(el.dataset.ready);
    });
  }

  /** Confirmar la entrega. Es el ultimo paso del pedido y lo da quien lo llevo. */
  async function deliver(orderId) {
    try {
      await api.post(`/nightclubs/${clubId()}/orders/${orderId}/status`, { status: 'delivered' });
      const index = state.orders.findIndex((o) => o.id === orderId);
      if (index !== -1) state.orders.splice(index, 1);
      toast(t('take.deliveredOk'), 'ok');
      renderUnpaid();
    } catch (err) {
      showError(err);
      await loadOrders();
    }
  }


  // ---------------------------------------------------------------------------
  // Levantar el pedido en la mesa y cobrarlo ahí mismo.
  //
  // Son dos pasos y en ese orden a propósito: primero existe el pedido (con su cobro
  // pendiente), después se cobra. Si se hiciera al revés —cobrar y luego crear— un
  // fallo de red dejaría dinero recibido sin nada que lo respalde.
  // ---------------------------------------------------------------------------

  async function loadDrinks() {
    if (state.drinks.length > 0) return;
    try {
      const d = await api.get(`/nightclubs/${clubId()}/drinks`);
      state.drinks = d.drinks || [];
    } catch (err) { showError(err); }
  }

  async function loadPoints() {
    if (state.points.length > 0) return;
    try {
      const d = await api.get(`/nightclubs/${clubId()}/delivery-points`);
      state.points = d.delivery_points || [];
    } catch (err) { showError(err); }
  }

  /**
   * Levantar un pedido sin mesa: el cliente esta en la pista.
   *
   * Es la mitad de la clientela de general, y hasta ahora no habia forma de pedirle
   * nada: la hoja solo se abria desde una mesa.
   */
  async function openTakeOnFloor() {
    state.take = {
      open: true, table: null, guestId: null, cart: EV2Client.createCart(),
      order: null, search: '', sending: false, pointId: null,
    };
    $('take-sheet').hidden = false;
    $('take-search').value = '';
    $('take-reference').value = '';
    renderTakeMethods();
    renderTake();
    await Promise.all([loadDrinks(), loadPoints()]);
    renderTake();
  }

  async function openTake(table) {
    if (!table) return;
    state.take = {
      open: true, table, guestId: table.guests.length === 1 ? table.guests[0].id : null,
      cart: EV2Client.createCart(), order: null, search: '', sending: false,
    };
    $('take-sheet').hidden = false;
    $('take-search').value = '';
    $('take-reference').value = '';
    renderTakeMethods();
    renderTake();
    await loadDrinks();
    renderTake();
  }

  /** Abre la hoja directamente en el cobro, para un pedido que ya existe. */
  function openCharge(order) {
    if (!order) return;
    const table = EV2OrderTaking.servableTables(state.tables)
      .find((m) => m.id === order.table_id) || null;
    state.take = {
      open: true, table, guestId: order.sender_id || null,
      cart: EV2Client.createCart(), order, search: '', sending: false,
    };
    $('take-sheet').hidden = false;
    $('take-reference').value = '';
    renderTakeMethods();
    renderTake();
  }

  function closeTake() {
    state.take.open = false;
    $('take-sheet').hidden = true;
    $('take-error').hidden = true;
  }

  function renderTakeMethods() {
    const sel = $('take-method');
    sel.innerHTML = EV2OrderTaking.methodKeys()
      .map((k) => `<option value="${escape(k)}">${escape(t(`take.method.${k}`))}</option>`).join('');
    onMethodChange();
  }

  function onMethodChange() {
    const method = EV2OrderTaking.methodFor($('take-method').value);
    $('take-reference').hidden = !(method && method.requiresReference);
  }

  function takeMenu() {
    const q = clave(state.take.search);
    return state.drinks
      .filter((d) => d.available !== false)
      .filter((d) => !q || clave(d.name).includes(q) || clave(d.category || '').includes(q))
      .slice(0, 60);
  }

  /** Sin acentos y en mayúsculas: en la carta real hay "Piña" y nadie teclea la tilde. */
  function clave(texto) {
    return String(texto == null ? '' : texto)
      .normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
  }

  function takeThumb(drink) {
    const art = EV2DrinkArt.artFor(drink);
    const caja = 'w-10 h-10 rounded-lg shrink-0 flex items-center justify-center overflow-hidden';
    if (art.type === 'photo') {
      return `<img src="${escape(art.url)}" alt="" loading="lazy" class="${caja} object-cover">`;
    }
    return `<div class="${caja}" style="background:rgba(255,255,255,.05)">${EV2DrinkArt.svgFor(drink, 28)}</div>`;
  }

  function renderTake() {
    const take = state.take;
    if (!take.open) return;
    const mesa = take.table;
    $('take-title').textContent = mesa
      ? `${t('floor.tableShort')} ${mesa.code}` : t('take.noTable');

    // Sin mesa hace falta un punto de entrega: "Pista A", "Terraza". Con mesa no se
    // pregunta, porque la mesa YA es el punto y dos direcciones para una charola es
    // como se entrega en el lugar equivocado.
    const puntos = EV2OrderTaking.deliveryPoints(state.points, { forStaff: true });
    $('take-point-wrap').hidden = Boolean(mesa) || Boolean(take.order) || puntos.length === 0;
    if (!$('take-point-wrap').hidden) {
      $('take-point').innerHTML = [`<option value="">${escape(t('take.pickPoint'))}</option>`]
        .concat(puntos.map((p) => `<option value="${escape(p.id)}"${p.id === take.pointId ? ' selected' : ''}>${escape(p.name)}</option>`))
        .join('');
    }

    // A nombre de quién. Con nadie registrado en la mesa el cobro queda a nombre del
    // mesero, y la pantalla lo dice en lugar de dejarlo en blanco.
    const guests = (mesa && mesa.guests) || [];
    $('take-who').hidden = guests.length === 0;
    if (guests.length > 0) {
      const sel = $('take-guest-select');
      sel.innerHTML = [`<option value="">${escape(t('take.onMyName'))}</option>`]
        .concat(guests.map((g) => `<option value="${escape(g.id)}"${g.id === take.guestId ? ' selected' : ''}>${escape(g.name || '—')}</option>`))
        .join('');
    }
    $('take-guest').textContent = take.guestId
      ? (guests.find((g) => g.id === take.guestId) || {}).name || ''
      : t('take.onMyNameNote');

    // Con el pedido ya creado, la carta deja de importar: lo que falta es cobrar.
    const cobrando = Boolean(take.order);
    $('take-menu').hidden = cobrando;
    $('take-search').parentElement.hidden = cobrando;
    $('btn-take-send').hidden = cobrando;
    $('take-charge').hidden = !cobrando;

    if (!cobrando) {
      $('take-menu').innerHTML = takeMenu().map((drink) => `
        <div class="card rounded-xl p-2 flex items-center gap-3" data-drink="${escape(drink.id)}">
          ${takeThumb(drink)}
          <div class="min-w-0 flex-1">
            <p class="text-sm truncate">${escape(drink.name)}</p>
            <p class="text-xs text-white/50">${escape(money(drink.price, drink.currency))}</p>
          </div>
          <div class="flex items-center gap-2 flex-none">
            <button class="card rounded-lg w-9 h-9 text-lg" data-minus="1" aria-label="-">−</button>
            <span class="w-5 text-center text-sm">${take.cart.quantityOf(drink.id)}</span>
            <button class="ev2-button rounded-lg w-9 h-9 text-lg font-display" data-plus="1" aria-label="+">+</button>
          </div>
        </div>`).join('');

      $('take-menu').querySelectorAll('[data-drink]').forEach((el) => {
        const drink = state.drinks.find((d) => d.id === el.dataset.drink);
        el.querySelector('[data-plus]').onclick = () => { take.cart.add(drink); renderTake(); };
        el.querySelector('[data-minus]').onclick = () => { take.cart.remove(drink.id); renderTake(); };
      });
    }

    const lines = cobrando ? (take.order.items || []).map((i) => ({
      name: i.name, quantity: i.quantity, subtotal: null,
    })) : take.cart.lines.map((l) => ({
      name: l.drink.name, quantity: l.quantity, subtotal: l.subtotal,
    }));
    $('take-cart').innerHTML = lines.map((l) => `
      <div class="flex justify-between text-xs">
        <span class="truncate">${l.quantity}× ${escape(l.name)}</span>
        ${l.subtotal === null ? '' : `<span class="text-white/60">${escape(money(l.subtotal))}</span>`}
      </div>`).join('');

    $('take-total').textContent = cobrando
      ? money(take.order.subtotal, take.order.currency)
      : money(take.cart.total, take.cart.currency);

    $('btn-take-send').disabled = take.sending
      || EV2OrderTaking.orderBlocker({
        tableId: mesa && mesa.id, deliveryPointId: take.pointId, cart: take.cart.lines,
      }) !== null;
  }

  function takeError(key) {
    const el = $('take-error');
    if (!key) { el.hidden = true; return; }
    el.textContent = t(key);
    el.hidden = false;
  }

  async function sendTake() {
    const take = state.take;
    const mesa = take.table;
    const blocker = EV2OrderTaking.orderBlocker({
      tableId: mesa && mesa.id, deliveryPointId: take.pointId, cart: take.cart.lines,
    });
    if (blocker) { takeError(`take.blocked.${blocker}`); return; }

    take.sending = true;
    renderTake();
    try {
      const body = EV2OrderTaking.orderPayload({
        tableId: mesa && mesa.id,
        deliveryPointId: take.pointId,
        guestId: take.guestId,
        cart: take.cart.lines,
        // La misma clave si hay que reintentar: el servidor devuelve el mismo pedido
        // en vez de crear otro. Regenerarla en el catch es como se cobra dos veces.
        requestId: take.cart.requestKey(EV2.uuid),
      });
      const res = await api.post(`/nightclubs/${clubId()}/orders`, body);
      take.order = res.order;
      takeError(null);
      await loadOrders();
    } catch (err) {
      showError(err);
    } finally {
      take.sending = false;
      renderTake();
    }
  }

  /**
   * El cuadro de la terminal. Se arma una sola vez, la primera que hace falta: la
   * mayoría de los turnos cobran en efectivo y no tienen por qué pagar el costo de un
   * trozo de pantalla que nunca se abre.
   */
  let terminalSheet = null;
  function sheet() {
    if (!terminalSheet) {
      terminalSheet = EV2TerminalCharge.createSheet({
        api,
        clubId,
        t,
        money: (a, c) => EV2Format.money(a, c || state.currency),
        errorMessage: (err) => EV2Format.errorMessage(err),
        onPaid: async () => {
          toast(t('take.charged'), 'ok');
          await Promise.all([loadOrders(), loadTables()]);
        },
        onClose: () => { closeTake(); },
      });
    }
    return terminalSheet;
  }

  async function chargeTake() {
    const take = state.take;
    const method = $('take-method').value;
    const reference = $('take-reference').value;
    const blocker = EV2OrderTaking.chargeBlocker({
      order: take.order, method, reference, terminals: state.terminals,
    });
    if (blocker) { takeError(`take.blocked.${blocker}`); return; }

    take.sending = true;
    try {
      if (EV2OrderTaking.isTerminalMethod(method)) {
        // Otra ruta y otra espera: aquí no se registra un pago, se le pide a la terminal
        // que cobre. La pantalla se queda mirando hasta que Mercado Pago conteste.
        const terminal = EV2TerminalCharge.pickTerminal(
          state.terminals, EV2TerminalCharge.recordada());
        const res = await api.post(`/nightclubs/${clubId()}/terminal-charges`, {
          transaction_id: take.order.transaction_id,
          terminal_id: terminal.id,
        });
        EV2TerminalCharge.recordar(terminal.id);
        sheet().watch(res.charge);
        return;
      }
      await api.post(`/nightclubs/${clubId()}/manual-payments/register`,
        EV2OrderTaking.chargePayload({ order: take.order, method, reference }));
      toast(t('take.charged'), 'ok');
      closeTake();
      await Promise.all([loadOrders(), loadTables()]);
    } catch (err) {
      showError(err);
    } finally {
      take.sending = false;
    }
  }

  async function releaseGuest(tableId, userId) {
    if (!window.confirm(t('floor.confirmRelease'))) return;
    try {
      await api.post(`/nightclubs/${clubId()}/tables/${tableId}/release`, { user_id: userId });
      await loadTables();
    } catch (err) { showError(err); }
  }

  function renderMe() {
    const employee = state.employee || {};
    const onShift = Boolean(employee.on_shift);
    const minutes = EV2Staff.shiftMinutes(employee.current_shift || employee.shift, Date.now());
    $('shift-state').textContent = onShift
      ? (minutes === null ? t('floor.onShift', { n: 0 }) : t('floor.onShift', { n: minutes }))
      : t('floor.offShift');
    $('btn-shift').textContent = t(onShift ? 'floor.shiftEnd' : 'floor.shiftStart');

    const totals = EV2Staff.tipTotals(state.tips, state.currency);
    $('tips-paid').textContent = money(totals.paid, totals.currency);
    $('tips-pending').textContent = money(totals.pending, totals.currency);
    $('tips-empty').hidden = state.tips.length > 0;
    $('tips-list').innerHTML = state.tips.slice(0, 20).map((tip) => `
      <div class="card rounded-lg p-3 flex justify-between items-center">
        <div class="min-w-0">
          <p class="text-sm">${escape(tip.from_name || t('bar.gift'))}</p>
          <p class="text-xs text-white/40">${escape(EV2Format.dateTime(tip.created_at))}</p>
        </div>
        <div class="text-right flex-none">
          <p class="text-sm">${escape(money(tip.amount, tip.currency))}</p>
          <span class="pill ${tip.status === 'paid' ? 'pill-ok' : tip.status === 'pending' ? 'pill-wait' : 'pill-off'}">
            ${escape(t(tip.status === 'paid' ? 'floor.tipsPaid' : 'floor.tipsPending'))}
          </span>
        </div>
      </div>`).join('');
  }


  // ---------------------------------------------------------------- el corte del turno (D51)

  let cutSheet = null;
  function corte() {
    if (!cutSheet) {
      cutSheet = EV2ShiftCut.createSheet({
        api,
        clubId,
        t,
        money: (a) => EV2Format.money(a, state.currency),
        errorMessage: (err) => EV2Format.errorMessage(err),
        toast,
      });
    }
    return cutSheet;
  }

  $('btn-cut').onclick = () => corte().open();

  $('btn-shift').onclick = async () => {
    const onShift = Boolean(state.employee && state.employee.on_shift);
    if (onShift && !window.confirm(t('floor.confirmEndShift'))) return;
    try {
      await api.post(`/nightclubs/${clubId()}/staff/shifts/${onShift ? 'end' : 'start'}`, {});
      const d = await api.get('/employees/me');
      state.employee = d.employee;
      renderMe();
      toast(t(onShift ? 'floor.shiftEnd' : 'floor.shiftStart'), 'ok');
    } catch (err) {
      // El servidor no deja cerrar el turno con dinero del club sin corte. En vez de
      // enseñar el error y dejar a la persona buscando dónde, se le abre el corte.
      showError(err);
      if (err && err.status === 422) corte().open();
    }
  };

  // ---------------------------------------------------------------- tiempo real

  const lastConnection = { on: false, key: 'realtime.reconnecting', vars: null };

  function setConnection(on, key, vars) {
    lastConnection.on = on;
    lastConnection.key = key;
    lastConnection.vars = vars || null;
    $('rt-dot').className = `dot ${on === true ? 'dot-on' : on === null ? 'dot-wait' : 'dot-off'}`;
    $('rt-text').textContent = vars && vars.text ? vars.text : t(key);
  }

  function connectRealtime() {
    const rt = api.createRealtime();
    state.realtime = rt;
    rt.on('open', () => { setConnection(true, 'top.live'); banner(null); });
    rt.on('reconnecting', (i) => setConnection(null, 'realtime.reconnecting',
      { text: `${t('realtime.reconnecting')} ${Math.round(i.in_ms / 1000)}s` }));
    rt.on('close', () => setConnection(false, 'top.offline'));
    rt.on('replaced', () => { setConnection(false, 'top.otherSession'); banner(t('banner.replaced')); });
    rt.on('resync_required', async () => { banner(t('banner.updating')); await loadAll(); banner(null); });

    rt.on('event', async (message) => {
      // El cobro con terminal se entera por aquí antes que por la consulta: son los
      // segundos en que alguien está mirando la pantalla con el cliente enfrente.
      if (terminalSheet) terminalSheet.onEvent(message);
      // La puerta escucha el mismo socket: una reservación nueva o un cambio de
      // estado tiene que aparecer sin que la anfitriona jale la pantalla.
      if (EV2Door.affectsDoor(message)) {
        if (isDoorRole()) await loadAll();
        return;
      }
      const change = EV2Staff.applyEvent(message);
      if (!change.changed) return;
      if (change.reloadTables) { await loadTables(); return; }
      if (change.announce && change.orderId) {
        state.arrived.add(change.orderId);
        setTimeout(() => { state.arrived.delete(change.orderId); }, 4000);
        // En un antro no se oye nada: el aviso es vibración más el destello de la tarjeta.
        try { if (navigator.vibrate) navigator.vibrate([150, 60, 150]); } catch { /* bloqueado */ }
        toast(t('floor.newReady'), 'ok');
      }
      await loadOrders();
    });

    api.on('auth:expired', () => {
      banner(t('banner.expired'));
      setTimeout(() => location.reload(), 2500);
    });
    rt.connect();
  }

  // ---------------------------------------------------------------- arranque

  (async function boot() {
    EV2Format.setLanguage(EV2Format.getLanguage());
    EV2Format.applyTo(document);
    $('btn-lang').textContent = EV2Format.otherLanguage().toUpperCase();
    const user = await api.resume();
    if (user) await afterSignIn();
  }());
}());
