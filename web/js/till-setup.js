/**
 * EV2 — Cajas (D126): la pestaña del gerente para dar de alta cajas.
 *
 * Una caja vive en una barra (o en Cover), se cobra con PC o con teléfono, y lleva su
 * impresora de recibos con cajón y su terminal Point. Esta pestaña lo hace en un solo
 * recorrido ("Nueva caja"): barra → nombre y equipo → impresora y cajón → terminal →
 * prueba. Lo mismo sirve para arreglar una caja que ya existe.
 *
 *   - PC: el código de estación de siempre (D99), ya atado a la caja.
 *   - Teléfono: una impresora térmica de red con cajón; la imprime una PC del club.
 */
/* global module */
(function (root, factory) {
  'use strict';
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  root.EV2TillSetup = lib;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Qué le falta a una caja, en palabras (las claves están en format.js). */
  function issueKey(issue) {
    return `tset.issue.${issue.code}`;
  }

  /** Los pasos del alta según el equipo. */
  function steps(device) {
    return ['place', 'name', device === 'phone' ? 'network' : 'station', 'terminal', 'test'];
  }

  /** Una IP de impresora: cuatro números de 0 a 255. */
  function isIp(text) {
    const partes = String(text || '').trim().split('.');
    return partes.length === 4 && partes.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
  }

  function mount(ctx) {
    const {
      api, t, toast, showError, clubId, escape, ask,
    } = ctx;
    const $ = (id) => document.getElementById(id);
    const st = {
      data: { tills: [], places: [], terminals: [] },
      wiz: null, // { step, till, placeId, name, device, invite, until }
      net: { candidates: [], agents: [] },
      polling: false,
    };

    async function load() {
      try {
        st.data = await api.get(`/nightclubs/${clubId()}/till-setup`);
      } catch (err) { showError(err); }
      render();
      if (!reg.polling) renderRegister();
    }

    // ------------------------------------------------------------ la lista

    function line(ok, text) {
      const color = ok === true ? 'var(--ev2-lime)' : ok === false ? '#fca5a5' : '#fcd34d';
      const mark = ok === true ? '✓' : ok === false ? '✗' : '…';
      return `<p class="text-xs" style="color:${color}">${mark} ${escape(text)}</p>`;
    }

    function render() {
      const box = $('till-list');
      if (!box) return;
      const lista = st.data.tills || [];
      $('till-empty').hidden = lista.length > 0;
      box.innerHTML = lista.map((c) => {
        const p = c.printer;
        const lugar = c.location_kind === 'door' ? t('tset.cover') : c.location_name;
        const zonas = (c.sections || []).length ? ` · ${c.sections.join(', ')}` : '';
        const equipo = c.device === 'phone' ? t('tset.phone') : t('tset.pc');
        const lineas = [
          p ? line(true, t('tset.printerOk', {
            name: p.connection === 'network' ? `${p.name} (${p.host})` : (p.windows_name || p.name),
          })) : line(false, t('tset.issue.no_printer')),
          p ? (p.drawer_pin ? line(true, t('tset.drawerOk', { pin: p.drawer_pin })) : line(null, t('tset.issue.no_drawer'))) : '',
          c.terminal ? line(true, t('tset.terminalOk', { name: c.terminal.name })) : line(null, t('tset.noTerminal')),
          ...(c.issues || []).filter((i) => !['no_printer', 'no_drawer'].includes(i.code))
            .map((i) => line(false, t(issueKey(i), { agent: i.agent || '' }))),
          c.open_shift ? line(true, t('tset.openBy', { name: c.open_shift.user_name })) : '',
        ].join('');
        return `
        <div class="card rounded-xl p-3 space-y-2 ${c.active ? '' : 'opacity-50'}">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="font-display truncate">${escape(c.name)}</p>
              <p class="text-[11px] text-white/40 truncate">${escape(lugar)}${escape(zonas)} · ${escape(equipo)}</p>
            </div>
            <span class="pill ${(c.issues || []).length ? 'pill-wait' : 'pill-ok'} shrink-0">
              ${escape(t((c.issues || []).length ? 'tset.needsWork' : 'tset.ready'))}</span>
          </div>
          ${lineas}
          <div class="flex flex-wrap gap-2 pt-1">
            ${c.active ? `<button class="ev2-button rounded-lg px-3 py-2 text-xs" data-till-setup="${escape(c.id)}">${escape(t('tset.configure'))}</button>` : ''}
            ${p && c.active ? `<button class="card rounded-lg px-3 py-2 text-xs" data-till-test="${escape(p.id)}">${escape(t('stn.testSheet'))}</button>` : ''}
            ${p && p.drawer_pin && c.active ? `<button class="card rounded-lg px-3 py-2 text-xs" data-till-drawer="${escape(p.id)}">${escape(t('stn.testDrawer'))}</button>` : ''}
            ${c.location_kind !== 'door' ? `<button class="card rounded-lg px-3 py-2 text-xs" data-till-toggle="${escape(c.id)}" data-active="${c.active}">${escape(t(c.active ? 'tset.turnOff' : 'tset.turnOn'))}</button>` : ''}
          </div>
        </div>`;
      }).join('');

      for (const b of box.querySelectorAll('[data-till-setup]')) {
        b.onclick = () => openWizard(lista.find((c) => c.id === b.dataset.tillSetup));
      }
      for (const b of box.querySelectorAll('[data-till-test]')) {
        b.onclick = () => post(b, `/printers/${b.dataset.tillTest}/test`, 'stn.testSent');
      }
      for (const b of box.querySelectorAll('[data-till-drawer]')) {
        b.onclick = () => post(b, `/printers/${b.dataset.tillDrawer}/test-drawer`, 'stn.drawerSent');
      }
      for (const b of box.querySelectorAll('[data-till-toggle]')) {
        b.onclick = () => toggle(b);
      }
      renderWizard();
      renderDevices();
    }

    /**
     * Cada PC registrada con su impresora (D129): para ver de un vistazo que cada una
     * tiene la suya, y cambiarla ahí mismo.
     */
    function renderDevices() {
      const box = $('pc-devices');
      if (!box) return;
      const pcs = agents.filter((a) => a.active && a.station);
      $('pc-devices-card').hidden = pcs.length === 0;
      box.innerHTML = pcs.map((a) => `
        <div class="rounded-lg p-3 space-y-1" style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12)" data-pc="${escape(a.id)}">
          <p class="text-sm font-semibold truncate">${escape(a.station.name || a.name)}</p>
          <p class="text-[11px] text-white/40 truncate">${escape(t('tset.pcName', { name: a.hostname || a.name }))}</p>
          ${pcStatus(a)}
        </div>`).join('');
      for (const el of box.querySelectorAll('[data-pc]')) {
        bindPcStatus(el, agents.find((a) => a.id === el.dataset.pc), async () => { await load(); });
      }
    }

    async function post(boton, ruta, okKey, body = {}) {
      boton.disabled = true;
      try {
        await api.post(`/nightclubs/${clubId()}${ruta}`, body);
        toast(t(okKey), 'ok');
      } catch (err) { showError(err); } finally { boton.disabled = false; }
    }

    async function toggle(boton) {
      const prender = boton.dataset.active !== 'true';
      if (!prender && !(await ask(t('tset.turnOffAsk')))) return;
      boton.disabled = true;
      try {
        await api.patch(`/nightclubs/${clubId()}/till-setup/${boton.dataset.tillToggle}`, { active: prender });
        await load();
      } catch (err) { showError(err); boton.disabled = false; }
    }

    // ------------------------------------------------------------ el alta

    function openWizard(caja = null) {
      st.wiz = caja
        ? { step: caja.device === 'phone' ? 'network' : 'station', till: caja, device: caja.device }
        : { step: 'place', till: null, device: 'pc', placeId: null, name: '' };
      $('till-wizard').hidden = false;
      renderWizard();
      if (st.wiz.step === 'network') loadNetwork();
      $('till-wizard').scrollIntoView({ block: 'start', behavior: 'smooth' });
    }

    function closeWizard() {
      st.wiz = null;
      st.polling = false;
      $('till-wizard').hidden = true;
      load();
    }

    function go(step) {
      st.wiz.step = step;
      renderWizard();
      if (step === 'network') loadNetwork();
    }

    function renderWizard() {
      const w = st.wiz;
      const caja = $('till-wizard');
      if (!caja || !w) return;
      const pasos = steps(w.device);
      const i = pasos.indexOf(w.step);
      $('till-wiz-title').textContent = w.till ? w.till.name : t('tset.new');
      $('till-wiz-step').textContent = t('tset.stepOf', { n: i + 1, total: pasos.length });
      const body = $('till-wiz-body');
      body.innerHTML = STEPS[w.step]();
      BIND[w.step](body);
    }

    const STEPS = {
      place() {
        const barras = (st.data.places || []).filter((p) => p.kind === 'bar');
        return `
          <p class="text-sm">${escape(t('tset.pickPlace'))}</p>
          <div class="space-y-2">${barras.map((p) => `
            <button class="card rounded-xl p-3 w-full text-left tap" data-place="${escape(p.id)}">
              <p class="text-sm font-semibold">${escape(p.name)}</p>
              <p class="text-[11px] text-white/40">${escape((p.sections || []).length
    ? t('tset.serves', { zones: p.sections.join(', ') }) : t('tset.noZones'))}
                · ${escape(t('tset.hasTills', { n: (st.data.tills || []).filter((c) => c.location_id === p.id && c.active).length }))}</p>
            </button>`).join('')}</div>
          <p class="text-[11px] text-white/40">${escape(t('tset.coverNote'))}</p>`;
      },
      name() {
        const w = st.wiz;
        return `
          <div>
            <label class="label" for="till-wiz-name">${escape(t('stn.name'))}</label>
            <input id="till-wiz-name" class="field" maxlength="60" value="${escape(w.name || '')}"
                   placeholder="${escape(t('tset.namePh'))}">
          </div>
          <p class="label">${escape(t('tset.device'))}</p>
          <div class="grid grid-cols-2 gap-2">
            ${['pc', 'phone'].map((d) => `
              <button type="button" class="card rounded-xl p-3 text-left tap ${w.device === d ? 'ring-2 ring-lime-300' : ''}" data-device="${d}">
                <p class="text-sm font-semibold"><i class="fa-solid ${d === 'pc' ? 'fa-desktop' : 'fa-mobile-screen'} mr-1"></i>${escape(t(d === 'pc' ? 'tset.pc' : 'tset.phone'))}</p>
                <p class="text-[11px] text-white/40">${escape(t(d === 'pc' ? 'tset.pcWhy' : 'tset.phoneWhy'))}</p>
              </button>`).join('')}
          </div>
          <p id="till-wiz-error" class="text-sm text-red-300" hidden></p>
          <button id="till-wiz-create" class="ev2-button w-full rounded-lg py-2">${escape(t('tset.createIt'))}</button>`;
      },
      station() {
        const w = st.wiz;
        const agente = stationAgent();
        return `
          <p class="text-sm">${escape(t('tset.stationHow'))}</p>
          <label class="flex items-center gap-3 text-sm tap">
            <input id="till-wiz-drawer" type="checkbox" class="w-5 h-5 accent-emerald-400" checked>
            <span>${escape(t('stn.drawer'))}</span>
          </label>
          <button id="till-wiz-code" class="ev2-button w-full rounded-lg py-2"><i class="fa-solid fa-desktop mr-1"></i>${escape(t('tset.download'))}</button>
          ${w.downloaded ? `<p class="text-xs" style="color:var(--ev2-lime)">${escape(t('tset.downloaded', { minutes: w.ttl || 15 }))}</p>` : ''}
          ${pcStatus(agente)}
          <button id="till-wiz-next" class="card rounded-lg px-3 py-2 text-xs w-full">${escape(t('tset.next'))}</button>`;
      },
      network() {
        const pcs = st.net.agents || [];
        return `
          <p class="text-sm">${escape(t('tset.networkHow'))}</p>
          <div class="flex items-center justify-between gap-2">
            <p class="label">${escape(t('prn.found'))}</p>
            <button id="till-wiz-scan" class="card rounded-lg px-3 py-2 text-xs">${escape(t('prn.scan'))}</button>
          </div>
          <div class="space-y-2">${(st.net.candidates || []).map((c) => `
            <button class="card rounded-xl p-3 w-full text-left tap" data-host="${escape(c.host)}" data-port="${escape(c.tcp_port)}">
              <p class="text-sm font-semibold">${escape(c.name)} · ${escape(c.host)}</p>
              <p class="text-[11px] text-white/40">${escape(t('tset.seenBy', { pcs: (c.seen_by || []).map((a) => a.name).join(', ') }))}</p>
            </button>`).join('') || `<p class="text-[11px] text-white/40">${escape(t('tset.noneFound'))}</p>`}</div>
          <div class="grid grid-cols-3 gap-2">
            <div class="col-span-2">
              <label class="label" for="till-wiz-host">${escape(t('prn.host'))}</label>
              <input id="till-wiz-host" class="field" inputmode="decimal" maxlength="120" placeholder="192.168.1.50">
            </div>
            <div>
              <label class="label" for="till-wiz-port">${escape(t('prn.port'))}</label>
              <input id="till-wiz-port" class="field" type="number" min="1" max="65535" value="9100">
            </div>
          </div>
          <div class="grid grid-cols-2 gap-2">
            <label class="flex items-center gap-2 text-sm tap">
              <input id="till-wiz-drawer" type="checkbox" class="w-5 h-5 accent-emerald-400" checked>
              <span>${escape(t('tset.hasDrawer'))}</span>
            </label>
            <select id="till-wiz-pin" class="field">
              <option value="2">${escape(t('tset.pin', { pin: 2 }))}</option>
              <option value="5">${escape(t('tset.pin', { pin: 5 }))}</option>
            </select>
          </div>
          <div>
            <label class="label" for="till-wiz-agent">${escape(t('tset.whoPrints'))}</label>
            <select id="till-wiz-agent" class="field">
              <option value="">${escape(t('tset.anyPc'))}</option>
              ${pcs.map((a) => `<option value="${escape(a.id)}">${escape(a.name)}${a.online ? '' : ` · ${escape(t('tset.offline'))}`}</option>`).join('')}
            </select>
            <p class="text-[11px] text-white/40 mt-1">${escape(t('tset.whoPrintsWhy'))}</p>
          </div>
          <p id="till-wiz-error" class="text-sm text-red-300" hidden></p>
          <button id="till-wiz-save-net" class="ev2-button w-full rounded-lg py-2">${escape(t('tset.saveNet'))}</button>
          <button id="till-wiz-next" class="card rounded-lg px-3 py-2 text-xs w-full">${escape(t('tset.skip'))}</button>`;
      },
      terminal() {
        const w = st.wiz;
        const actual = (st.data.terminals || []).find((x) => x.till_id === w.till.id);
        return `
          <p class="text-sm">${escape(t('tset.terminalHow'))}</p>
          <select id="till-wiz-term" class="field">
            <option value="">${escape(t('tset.noTerminalOpt'))}</option>
            ${(st.data.terminals || []).map((x) => {
    const otra = x.till_id && x.till_id !== w.till.id
      ? ((st.data.tills || []).find((c) => c.id === x.till_id) || {}).name : null;
    return `<option value="${escape(x.id)}" ${actual && actual.id === x.id ? 'selected' : ''}>${escape(x.name)}${otra ? ` · ${escape(t('tset.nowIn', { name: otra }))}` : ''}</option>`;
  }).join('')}
          </select>
          <p id="till-wiz-error" class="text-sm text-red-300" hidden></p>
          <button id="till-wiz-save-term" class="ev2-button w-full rounded-lg py-2">${escape(t('tset.next'))}</button>`;
      },
      test() {
        const caja = (st.data.tills || []).find((c) => c.id === st.wiz.till.id) || st.wiz.till;
        const p = caja.printer;
        return `
          ${p ? line(true, t('tset.printerOk', { name: p.connection === 'network' ? `${p.name} (${p.host})` : (p.windows_name || p.name) })) : line(false, t('tset.issue.no_printer'))}
          ${p && p.drawer_pin ? line(true, t('tset.drawerOk', { pin: p.drawer_pin })) : ''}
          ${caja.terminal ? line(true, t('tset.terminalOk', { name: caja.terminal.name })) : line(null, t('tset.noTerminal'))}
          ${(caja.issues || []).filter((i) => !['no_printer', 'no_drawer'].includes(i.code))
    .map((i) => line(false, t(issueKey(i), { agent: i.agent || '' }))).join('')}
          <div class="flex flex-wrap gap-2">
            ${p ? `<button class="card rounded-lg px-3 py-2 text-xs" id="till-wiz-test">${escape(t('stn.testSheet'))}</button>` : ''}
            ${p && p.drawer_pin ? `<button class="ev2-button rounded-lg px-3 py-2 text-xs" id="till-wiz-drawer-test">${escape(t('stn.testDrawer'))}</button>` : ''}
            ${p && p.drawer_pin ? `<button class="card rounded-lg px-3 py-2 text-xs" id="till-wiz-otherpin">${escape(t('stn.otherPin', { pin: p.drawer_pin === 2 ? 5 : 2 }))}</button>` : ''}
          </div>
          <p class="text-[11px] text-white/40">${escape(t('tset.rosterNote'))}</p>
          <button id="till-wiz-done" class="ev2-button w-full rounded-lg py-2">${escape(t('tset.done'))}</button>`;
      },
    };

    const error = (msg) => { const e = $('till-wiz-error'); if (e) { e.textContent = msg; e.hidden = false; } };
    const errText = (err) => (window.EV2Format ? window.EV2Format.errorMessage(err) : String(err.message || err));

    async function refreshTill() {
      await load();
      const fresca = (st.data.tills || []).find((c) => c.id === st.wiz.till.id);
      if (fresca) st.wiz.till = fresca;
    }

    const BIND = {
      place(body) {
        for (const b of body.querySelectorAll('[data-place]')) {
          b.onclick = () => {
            st.wiz.placeId = b.dataset.place;
            const lugar = st.data.places.find((p) => p.id === b.dataset.place);
            const n = (st.data.tills || []).filter((c) => c.location_id === lugar.id).length + 1;
            st.wiz.name = st.wiz.name || `${lugar.name} · ${t('tset.word')} ${n}`;
            go('name');
          };
        }
      },
      name(body) {
        for (const b of body.querySelectorAll('[data-device]')) {
          b.onclick = () => {
            st.wiz.name = $('till-wiz-name').value;
            st.wiz.device = b.dataset.device;
            renderWizard();
          };
        }
        $('till-wiz-create').onclick = async () => {
          const nombre = $('till-wiz-name').value.trim();
          if (!nombre) { error(t('stn.needName')); return; }
          const boton = $('till-wiz-create');
          boton.disabled = true;
          try {
            const { till } = await api.post(`/nightclubs/${clubId()}/till-setup`, {
              location_id: st.wiz.placeId, name: nombre, device: st.wiz.device,
            });
            st.wiz.till = till;
            toast(t('tset.created', { name: till.name }), 'ok');
            await refreshTill();
            go(st.wiz.device === 'phone' ? 'network' : 'station');
          } catch (err) { error(errText(err)); boton.disabled = false; }
        };
      },
      station(body) {
        $('till-wiz-code').onclick = async (e) => {
          const boton = e.currentTarget;
          boton.disabled = true;
          try {
            const r = await downloadInstaller(`till:${st.wiz.till.id}`, $('till-wiz-drawer').checked);
            st.wiz.downloaded = true;
            st.wiz.since = Date.now();
            st.wiz.ttl = Math.round((new Date(r.invite.expires_at).getTime() - Date.now()) / 60000);
            renderWizard();
            pollStation();
          } catch (err) { showError(err); boton.disabled = false; }
        };
        bindPcStatus(body, stationAgent(), async () => { await refreshTill(); renderWizard(); });
        $('till-wiz-next').onclick = async () => { st.polling = false; await refreshTill(); go('terminal'); };
      },
      network(body) {
        for (const b of body.querySelectorAll('[data-host]')) {
          b.onclick = () => {
            $('till-wiz-host').value = b.dataset.host;
            $('till-wiz-port').value = b.dataset.port || 9100;
          };
        }
        $('till-wiz-scan').onclick = async () => {
          const boton = $('till-wiz-scan');
          boton.disabled = true;
          try {
            await api.post(`/nightclubs/${clubId()}/print-agents/scan`, {});
            toast(t('tset.scanning'), 'info');
            // Las PCs contestan en segundos; se pregunta unas veces y se repinta.
            for (let n = 0; n < 6; n += 1) {
              // eslint-disable-next-line no-await-in-loop
              await new Promise((r) => { setTimeout(r, 4000); });
              // eslint-disable-next-line no-await-in-loop
              await loadNetwork(false);
            }
            renderWizard();
          } catch (err) { showError(err); boton.disabled = false; }
        };
        $('till-wiz-save-net').onclick = async () => {
          const host = $('till-wiz-host').value.trim();
          if (!isIp(host)) { error(t('tset.badIp')); return; }
          const boton = $('till-wiz-save-net');
          boton.disabled = true;
          try {
            await api.post(`/nightclubs/${clubId()}/till-setup/${st.wiz.till.id}/printer`, {
              host,
              port: Number($('till-wiz-port').value) || 9100,
              has_drawer: $('till-wiz-drawer').checked,
              drawer_pin: Number($('till-wiz-pin').value) === 5 ? 5 : 2,
              agent_id: $('till-wiz-agent').value || null,
            });
            toast(t('tset.netSaved'), 'ok');
            await refreshTill();
            go('terminal');
          } catch (err) { error(errText(err)); boton.disabled = false; }
        };
        $('till-wiz-next').onclick = async () => { await refreshTill(); go('terminal'); };
      },
      terminal() {
        $('till-wiz-save-term').onclick = async () => {
          const elegida = $('till-wiz-term').value || null;
          const actual = (st.data.terminals || []).find((x) => x.till_id === st.wiz.till.id);
          const boton = $('till-wiz-save-term');
          boton.disabled = true;
          try {
            if ((actual ? actual.id : null) !== elegida) {
              await api.put(`/nightclubs/${clubId()}/till-setup/${st.wiz.till.id}/terminal`, { terminal_id: elegida });
            }
            await refreshTill();
            go('test');
          } catch (err) { error(errText(err)); boton.disabled = false; }
        };
      },
      test() {
        const p = st.wiz.till.printer;
        if ($('till-wiz-test')) $('till-wiz-test').onclick = (e) => post(e.currentTarget, `/printers/${p.id}/test`, 'stn.testSent');
        if ($('till-wiz-drawer-test')) $('till-wiz-drawer-test').onclick = (e) => post(e.currentTarget, `/printers/${p.id}/test-drawer`, 'stn.drawerSent');
        if ($('till-wiz-otherpin')) {
          $('till-wiz-otherpin').onclick = async (e) => {
            const b = e.currentTarget;
            b.disabled = true;
            try {
              await api.patch(`/nightclubs/${clubId()}/printers/${p.id}`, { drawer_pin: p.drawer_pin === 2 ? 5 : 2 });
              await api.post(`/nightclubs/${clubId()}/printers/${p.id}/test-drawer`, {});
              toast(t('stn.drawerSent'), 'ok');
              await refreshTill();
              renderWizard();
            } catch (err) { showError(err); b.disabled = false; }
          };
        }
        $('till-wiz-done').onclick = closeWizard;
      },
    };

    // ------------------------------------------------------------ registrar esta PC (D127)

    /**
     * Baja `Instalar-EV2.cmd` para ESTA PC. El archivo lleva una llave de un solo uso
     * que vence en 15 minutos: se guarda como archivo y no se enseña en la pantalla.
     */
    async function downloadInstaller(target, hasDrawer) {
      const r = await api.post(`/nightclubs/${clubId()}/till-setup/installer`, {
        target, has_drawer: hasDrawer,
      });
      const blob = new Blob([r.script], { type: 'application/octet-stream' });
      const enlace = document.createElement('a');
      enlace.href = URL.createObjectURL(blob);
      enlace.download = r.filename || 'Instalar-EV2.cmd';
      document.body.appendChild(enlace);
      enlace.click();
      setTimeout(() => { URL.revokeObjectURL(enlace.href); enlace.remove(); }, 1000);
      return r;
    }

    /** PC ✓ · Impresora ✓ · Cajón ✓, o lo que falta, para la PC de una caja. */
    function pcStatus(agente) {
      if (!agente) return '';
      const s = agente.station || {};
      const impresora = s.printer_id ? (agentsPrinters.get(s.printer_id) || null) : null;
      let out = line(true, t('tset.pcOk', { name: agente.name }));
      if (s.status === 'done') {
        out += line(true, s.printer_name ? t('tset.printerIs', { name: s.printer_name }) : t('tset.printerUsbOk'));
        out += s.drawer_pin ? line(true, t('tset.drawerOk', { pin: (impresora && impresora.drawer_pin) || s.drawer_pin })) : '';
        out += `<div class="flex flex-wrap gap-2">
          ${s.drawer_pin ? `<button class="card rounded-lg px-3 py-2 text-xs" data-pc-retest="${escape(s.printer_id)}">${escape(t('stn.testDrawer'))}</button>
            <button class="card rounded-lg px-3 py-2 text-xs" data-pc-otherpin="${escape(s.printer_id)}">${escape(t('tset.notOpened'))}</button>` : ''}
          <button class="card rounded-lg px-3 py-2 text-xs" data-pc-rechoose="${escape(agente.id)}">${escape(t('tset.changePrinter'))}</button>
        </div>`;
      } else if (s.status === 'choose') {
        out += line(null, t('tset.pickPrinter'));
        // Todas las que ESTA PC ve (D129), con cómo está conectada cada una.
        out += `<div class="space-y-2">${(s.candidates || []).map((c, n) => `
          <button class="card rounded-xl p-3 w-full text-left tap ${c.via === 'shared' ? 'opacity-70' : ''}" data-cand="${n}">
            <p class="text-sm font-semibold break-all">${escape(c.name)}</p>
            <p class="text-[11px] ${c.via === 'usb' ? 'text-lime-300' : c.via === 'shared' ? 'text-amber-300' : 'text-white/50'}">${escape(viaText(c))}</p>
          </button>`).join('')}</div>`;
      } else if (s.status === 'none' || s.status === 'blocked') {
        out += line(false, s.message || t('tset.noUsb'));
        out += `<button class="card rounded-lg px-3 py-2 text-xs" data-pc-rescan="1">${escape(t('prn.scan'))}</button>`;
      } else {
        out += line(null, t('stn.printerWait'));
      }
      return out;
    }

    /** "USB en esta PC · USB001", "De otra PC (CAJA-01)"… */
    function viaText(c) {
      const puerto = c.port ? ` · ${c.port}` : '';
      if (c.via === 'usb') return `${t('tset.viaUsb')}${puerto}`;
      if (c.via === 'shared') return t('tset.viaShared', { pc: c.remote || '?' });
      if (c.via === 'network') return `${t('tset.viaNetwork')}${puerto}`;
      return `${t('tset.viaOther')}${puerto}`;
    }

    function bindPcStatus(body, agente, after) {
      if (!agente) return;
      for (const b of body.querySelectorAll('[data-pc-rechoose]')) {
        b.onclick = async () => {
          b.disabled = true;
          try {
            await api.post(`/nightclubs/${clubId()}/print-agents/${b.dataset.pcRechoose}/station/rechoose`, {});
            await refreshAgents();
            await after();
          } catch (err) { showError(err); b.disabled = false; }
        };
      }
      for (const b of body.querySelectorAll('[data-cand]')) {
        b.onclick = async () => {
          const c = agente.station.candidates[Number(b.dataset.cand)];
          b.disabled = true;
          try {
            await api.post(`/nightclubs/${clubId()}/print-agents/${agente.id}/station/finish`, { windows_name: c.name });
            await refreshAgents();
            await after();
          } catch (err) { showError(err); b.disabled = false; }
        };
      }
      for (const b of body.querySelectorAll('[data-pc-retest]')) {
        b.onclick = () => post(b, `/printers/${b.dataset.pcRetest}/test-drawer`, 'stn.drawerSent');
      }
      for (const b of body.querySelectorAll('[data-pc-otherpin]')) {
        b.onclick = async () => {
          b.disabled = true;
          try {
            const id = b.dataset.pcOtherpin;
            const { printers } = await api.get(`/nightclubs/${clubId()}/printers`);
            const p = (printers || []).find((x) => x.id === id);
            const nuevo = p && p.drawer_pin === 2 ? 5 : 2;
            await api.patch(`/nightclubs/${clubId()}/printers/${id}`, { drawer_pin: nuevo });
            agentsPrinters.set(id, { drawer_pin: nuevo });
            await api.post(`/nightclubs/${clubId()}/printers/${id}/test-drawer`, {});
            toast(t('tset.triedOtherPin', { pin: nuevo }), 'ok');
            await after();
          } catch (err) { showError(err); } finally { b.disabled = false; }
        };
      }
      for (const b of body.querySelectorAll('[data-pc-rescan]')) {
        b.onclick = () => post(b, '/print-agents/scan', 'tset.scanning');
      }
    }

    const agentsPrinters = new Map();
    const reg = { target: null, tillId: null, since: 0, polling: false };

    async function renderRegister() {
      const sel = $('pc-target');
      if (!sel) return;
      try {
        const { targets } = await api.get(`/nightclubs/${clubId()}/till-setup/pc-targets`);
        const antes = sel.value;
        sel.innerHTML = targets.map((x) => `<option value="${escape(x.key)}" data-till="${escape(x.till_id || '')}">${escape(x.label)}</option>`).join('');
        if (antes) sel.value = antes;
      } catch (err) { showError(err); }
      paintRegister();
    }

    function registerAgent() {
      if (!reg.tillId) return null;
      return agents.filter((a) => a.active && a.station && a.station.till_id === reg.tillId)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] || null;
    }

    function paintRegister() {
      const box = $('pc-status');
      if (!box) return;
      const agente = registerAgent();
      box.innerHTML = reg.target ? (agente ? pcStatus(agente) : line(null, t('tset.waitPc'))) : '';
      bindPcStatus(box, agente, async () => { paintRegister(); await load(); });
    }

    async function pollRegister() {
      if (reg.polling) return;
      reg.polling = true;
      while (reg.polling && Date.now() - reg.since < 16 * 60000) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => { setTimeout(r, 3000); });
        // eslint-disable-next-line no-await-in-loop
        await refreshAgents();
        paintRegister();
        const a = registerAgent();
        if (a && a.station && ['done', 'none', 'blocked'].includes(a.station.status)) {
          reg.polling = false;
          // eslint-disable-next-line no-await-in-loop
          await load();
        }
      }
      reg.polling = false;
    }

    if ($('btn-pc-download')) {
      $('btn-pc-download').onclick = async (e) => {
        const boton = e.currentTarget;
        const target = $('pc-target').value;
        if (!target) return;
        boton.disabled = true;
        try {
          const r = await downloadInstaller(target, $('pc-drawer').checked);
          reg.target = target;
          reg.tillId = r.invite && r.invite.station ? r.invite.station.till_id : null;
          reg.since = Date.now();
          $('pc-help').hidden = false;
          paintRegister();
          pollRegister();
        } catch (err) { showError(err); } finally { boton.disabled = false; }
      };
    }

    if ($('btn-pc-wipe')) {
      $('btn-pc-wipe').onclick = async (e) => {
        if (!(await ask(t('tset.wipeAsk')))) return;
        const escrito = window.EV2UI && window.EV2UI.prompt
          ? await window.EV2UI.prompt(t('tset.wipeType'), { value: '' })
          : window.prompt(t('tset.wipeType'), '');
        if (String(escrito || '').trim().toUpperCase() !== 'BORRAR') return;
        const boton = e.currentTarget;
        boton.disabled = true;
        try {
          const { wiped } = await api.post(`/nightclubs/${clubId()}/till-setup/wipe-devices`, { confirm: 'BORRAR' });
          toast(t('tset.wiped', { pcs: wiped.agents_off, printers: wiped.printers_off }), 'ok');
          await refreshAgents();
          await load();
        } catch (err) { showError(err); } finally { boton.disabled = false; }
      };
    }

    // ------------------------------------------------------------ la PC y la red

    let agents = [];
    async function refreshAgents() {
      try {
        const d = await api.get(`/nightclubs/${clubId()}/print-agents`);
        agents = d.agents || [];
        renderDevices();
      } catch { /* se reintenta en la siguiente vuelta */ }
    }

    /** La PC que se dio de alta para esta caja (la más reciente con su caja en la estación). */
    function stationAgent() {
      if (!st.wiz || !st.wiz.till) return null;
      return agents.filter((a) => a.active && a.station && a.station.till_id === st.wiz.till.id)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] || null;
    }

    async function pollStation() {
      if (st.polling) return;
      st.polling = true;
      while (st.polling && st.wiz && st.wiz.step === 'station') {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => { setTimeout(r, 3000); });
        // eslint-disable-next-line no-await-in-loop
        await refreshAgents();
        const a = stationAgent();
        if (a && a.station && a.station.status === 'done') {
          // eslint-disable-next-line no-await-in-loop
          await refreshTill();
          st.polling = false;
        }
        if (st.wiz && st.wiz.step === 'station') renderWizard();
        if (st.wiz && st.wiz.downloaded && !a && Date.now() - (st.wiz.since || Date.now()) > 15 * 60000) st.polling = false;
      }
    }

    async function loadNetwork(repaint = true) {
      try {
        st.net = await api.get(`/nightclubs/${clubId()}/till-setup/network-printers`);
      } catch (err) { showError(err); }
      if (repaint && st.wiz && st.wiz.step === 'network') renderWizard();
    }

    if ($('btn-till-new')) $('btn-till-new').onclick = () => openWizard(null);
    if ($('till-wiz-close')) $('till-wiz-close').onclick = closeWizard;
    refreshAgents();

    return { load, render };
  }

  return { mount, steps, isIp, issueKey };
}));
