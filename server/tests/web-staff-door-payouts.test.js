/**
 * Las decisiones de lo que faltaba para operar una noche completa: dar de alta al
 * personal, abrir turno, aceptar un trago invitado, recibir en la puerta y pagarle a
 * la gente.
 *
 * Son las cuatro pantallas donde un error no se ve como un error: se ve como un empleado
 * que no cobra, una mesa pagada que se liberó antes de tiempo, o un menor dado de alta
 * como personal de un centro nocturno.
 */
'use strict';

const path = require('path');

const WEB = path.join(__dirname, '..', '..', 'web', 'js');
const Admin = require(path.join(WEB, 'staff-admin.js'));
const Shift = require(path.join(WEB, 'shift.js'));
const Pay = require(path.join(WEB, 'payouts.js'));
const Door = require(path.join(WEB, 'door.js'));

// --------------------------------------------------------------- alta de personal

describe('El personal, visto por el gerente', () => {
  const NOW = '2026-09-06T12:00:00Z';
  const staff = [
    { id: '1', role: 'dancer', display_name: 'Zoe', first_name: 'Zoe', last_name: 'Luna', active: true, on_shift: false },
    { id: '2', role: 'waiter', display_name: 'Beto', first_name: 'Beto', last_name: 'Ríos', active: true, on_shift: true },
    { id: '3', role: 'dancer', display_name: 'Ana', first_name: 'Ana', last_name: 'Paz', active: true, on_shift: true },
    { id: '4', role: 'valet', display_name: 'Viejo', first_name: 'Luis', last_name: 'Mar', active: false, on_shift: false },
  ];

  it('pone primero a quien está trabajando ahora', () => {
    // El gerente abre esto en medio de la noche para ver quién está, no para revisar
    // el archivo.
    expect(Admin.sortStaff(staff).map((p) => p.id)).toEqual(['2', '3', '1', '4']);
  });

  it('las bajas van al final, pero no desaparecen', () => {
    const sorted = Admin.sortStaff(staff);
    expect(sorted[sorted.length - 1].id).toBe('4');
    expect(sorted).toHaveLength(4);
  });

  it('cuenta activos, en turno y bajas por separado', () => {
    expect(Admin.counts(staff)).toEqual({ total: 4, active: 3, onShift: 2, inactive: 1 });
  });

  it('a un empleado dado de baja solo se le puede reactivar', () => {
    // Nunca se borra: conserva historial y saldo, que es dinero que se le debe.
    const baja = Admin.actionsFor({ active: false });
    expect(baja).toMatchObject({ canReactivate: true, canDeactivate: false, canEdit: false });
    const alta = Admin.actionsFor({ active: true });
    expect(alta).toMatchObject({ canReactivate: false, canDeactivate: true, canEdit: true });
  });

  it('el estado dice lo más urgente primero', () => {
    // Una cuenta que nunca se ha usado importa más que si está en turno: significa que
    // esa persona todavía no puede trabajar.
    expect(Admin.statusOf({ active: true, must_change_password: true, last_login_at: null }))
      .toBe('staff.stPendingPassword');
    expect(Admin.statusOf({ active: true, on_shift: true, must_change_password: false }))
      .toBe('staff.stOnShift');
    expect(Admin.statusOf({ active: false })).toBe('staff.stInactive');
  });

  const good = {
    first_name: 'Ana', last_name: 'Paz', email: 'ana@club.com',
    role: 'dancer', birth_date: '1998-05-10', phone: '6621234567',
  };

  it('acepta un alta bien capturada', () => {
    expect(Admin.validateEmployee(good, NOW)).toEqual({});
  });

  it('NO deja dar de alta a un menor de edad', () => {
    // Es lo peor que puede hacer esta pantalla en un centro nocturno.
    const menor = { ...good, birth_date: '2010-05-10' };
    expect(Admin.validateEmployee(menor, NOW)).toMatchObject({ birth_date: 'staff.errUnderage' });
  });

  it('la edad cuenta el mes y el día, no solo el año', () => {
    // Cumple 18 el 7 de septiembre; el 6 todavía es menor.
    expect(Admin.validateEmployee({ ...good, birth_date: '2008-09-07' }, '2026-09-06T12:00:00Z'))
      .toMatchObject({ birth_date: 'staff.errUnderage' });
    expect(Admin.validateEmployee({ ...good, birth_date: '2008-09-07' }, '2026-09-07T12:00:00Z'))
      .toEqual({});
  });

  it('pide cada dato que falta por su nombre', () => {
    const errors = Admin.validateEmployee({ first_name: '  ', email: 'no-es-correo', role: 'presidente' }, NOW);
    expect(errors.first_name).toBe('staff.errRequired');
    expect(errors.last_name).toBe('staff.errRequired');
    expect(errors.email).toBe('staff.errEmail');
    expect(errors.role).toBe('staff.errRole');
    expect(errors.birth_date).toBe('staff.errBirthDate');
  });

  it('un teléfono corto se detiene aquí, no la noche que haya que llamar', () => {
    expect(Admin.validateEmployee({ ...good, phone: '123' }, NOW))
      .toMatchObject({ phone: 'staff.errPhone' });
    // Con guiones y espacios sigue siendo válido: la gente lo escribe así.
    expect(Admin.validateEmployee({ ...good, phone: '(662) 123-4567' }, NOW)).toEqual({});
  });

  it('el teléfono es opcional', () => {
    const { phone, ...sinTelefono } = good;
    expect(Admin.validateEmployee(sinTelefono, NOW)).toEqual({});
  });

  // Un gerente que puede nombrar gerentes puede nombrarse un cómplice, y desde ese
  // momento el permiso de gerente —caja, precios, retiros, nómina— ya no protege nada.
  it('solo el administrador puede ofrecer el alta de un gerente', () => {
    expect(Admin.creatableRoles('manager')).not.toContain('manager');
    expect(Admin.creatableRoles('admin')).toContain('manager');
    // `admin` no se da por ninguna pantalla: solo desde la consola del servidor.
    expect(Admin.creatableRoles('admin')).not.toContain('admin');
    // Sin saber quién mira, la lista es la de piso: equivocarse hacia el lado que da
    // menos permiso es lo correcto.
    expect(Admin.creatableRoles(undefined)).toEqual(Admin.EMPLOYEE_ROLES);
  });

  it('el alta de un gerente se rechaza si quien la captura no es administrador', () => {
    const gerente = { ...good, role: 'manager' };
    expect(Admin.validateEmployee(gerente, NOW, 'manager')).toMatchObject({ role: 'staff.errRole' });
    expect(Admin.validateEmployee(gerente, NOW, 'admin')).toEqual({});
    // Y `admin` no se captura nunca, ni siendo administrador.
    expect(Admin.validateEmployee({ ...good, role: 'admin' }, NOW, 'admin'))
      .toMatchObject({ role: 'staff.errRole' });
  });

  it('la gerencia sale primero en la lista de personal', () => {
    const orden = Admin.sortStaff([
      { id: 1, role: 'waiter', display_name: 'Luis', active: true },
      { id: 2, role: 'manager', display_name: 'Ana', active: true },
    ]).map((p) => p.id);
    expect(orden).toEqual([2, 1]);
  });

  it('el cuerpo del alta NO lleva contraseña: la genera el servidor', () => {
    const body = Admin.employeePayload({ ...good, email: '  ANA@Club.com ' });
    expect(body.email).toBe('ana@club.com');
    expect(body.password).toBeUndefined();
    expect(body.temporary_password).toBeUndefined();
  });

  it('el nombre artístico solo viaja si de verdad es distinto', () => {
    // Mandarlo igual al nombre real crearía un alias que no significa nada.
    expect(Admin.employeePayload({ ...good, stage_name: 'Ana Paz' }).stage_name).toBeUndefined();
    expect(Admin.employeePayload({ ...good, stage_name: 'Luna' }).stage_name).toBe('Luna');
  });

  it('en la lista se ve el nombre con el que el club la conoce', () => {
    // Una ambientadora trabaja con nombre artístico; enseñarle el legal la haría
    // irreconocible. Pero el legal sigue a la vista, porque la nómina lo necesita.
    const d = Admin.displayFor({ first_name: 'Ana', last_name: 'Paz', stage_name: 'Luna' });
    expect(d).toEqual({ primary: 'Luna', secondary: 'Ana Paz' });

    const sinAlias = Admin.displayFor({ first_name: 'Beto', last_name: 'Ríos' });
    expect(sinAlias).toEqual({ primary: 'Beto Ríos', secondary: '' });
  });
});

// --------------------------------------------------------------- turno y tragos

describe('El turno de un empleado', () => {
  const abierto = [{ id: 's1', started_at: '2026-09-06T22:00:00Z', ended_at: null }];
  const cerrado = [{ id: 's1', started_at: '2026-09-05T22:00:00Z', ended_at: '2026-09-06T04:00:00Z' }];

  it('acepta la fila del propio empleado, no solo la lista de turnos', () => {
    // El portal de un empleado no puede leer /staff/shifts (es del gerente y la
    // anfitriona): usa `on_shift` y `shift_started_at` de su propio panel.
    expect(Shift.isOpen({ on_shift: true, shift_started_at: '2026-09-06T22:00:00Z' })).toBe(true);
    expect(Shift.isOpen({ on_shift: false })).toBe(false);
    expect(Shift.minutesOnShift({ on_shift: true, shift_started_at: '2026-09-06T22:00:00Z' },
      '2026-09-06T23:30:00Z')).toBe(90);
  });

  it('sabe si hay turno abierto', () => {
    expect(Shift.isOpen(abierto)).toBe(true);
    expect(Shift.isOpen(cerrado)).toBe(false);
    expect(Shift.isOpen([])).toBe(false);
    expect(Shift.isOpen(null)).toBe(false);
  });

  it('el botón dice lo que va a pasar, no en qué estado está', () => {
    // "En turno" es una etiqueta y deja al empleado adivinando si el botón abre o cierra.
    expect(Shift.shiftButton(abierto)).toMatchObject({ action: 'end', key: 'shift.end' });
    expect(Shift.shiftButton(cerrado)).toMatchObject({ action: 'start', key: 'shift.start' });
  });

  it('el tiempo trabajado se redondea hacia ABAJO', () => {
    // Es tiempo cumplido, no prometido: decir "4 horas" cuando lleva 3:50 le cobra al
    // club un minuto que no fue.
    expect(Shift.minutesOnShift(abierto, '2026-09-06T23:59:59Z')).toBe(119);
    expect(Shift.minutesOnShift(cerrado, '2026-09-06T23:00:00Z')).toBe(0);
  });

  it('sin turno, explica la consecuencia y no solo el estado', () => {
    // Es la única explicación de por qué puede pasar una noche entera sin una propina.
    const cerrada = Shift.headline(cerrado, '2026-09-06T23:00:00Z');
    expect(cerrada).toMatchObject({ key: 'shift.closedNote', working: false });

    const abierta = Shift.headline(abierto, '2026-09-06T23:30:00Z');
    expect(abierta.working).toBe(true);
    expect(abierta.vars.minutes).toBe(90);
  });
});

describe('Tragos invitados al personal', () => {
  const drinks = [
    { id: 'd1', status: 'pending', amount: '180.00', currency: 'MXN', created_at: '2026-09-06T23:30:00Z' },
    { id: 'd2', status: 'pending', amount: '90.00', currency: 'MXN', created_at: '2026-09-06T23:10:00Z' },
    { id: 'd3', status: 'confirmed', amount: '250.00', currency: 'MXN', created_at: '2026-09-06T22:00:00Z' },
    { id: 'd4', status: 'declined', amount: '999.00', currency: 'MXN', created_at: '2026-09-06T21:00:00Z' },
  ];

  it('los que esperan respuesta van primero, el más viejo arriba', () => {
    // Del otro lado hay alguien esperando en una mesa.
    expect(Shift.pendingDrinks(drinks).map((d) => d.id)).toEqual(['d2', 'd1']);
  });

  it('advierte que rechazar NO cancela el trago', () => {
    // Ya se cobró al cliente y vuelve a su mesa (D20). Quien rechaza debe saberlo.
    expect(Shift.declineWarning()).toBe('drink.declineNote');
  });

  it('suma lo invitado sin contar lo rechazado', () => {
    expect(Shift.drinkTotals(drinks)).toEqual([{ currency: 'MXN', amount: '520.00' }]);
  });

  it('reconoce los eventos por event_type, no por type', () => {
    expect(Shift.affectsShift({ type: 'event', event_type: 'staff_drink_received' })).toBe(true);
    expect(Shift.affectsShift({ type: 'event', event_type: 'order_ready' })).toBe(false);
    expect(Shift.affectsShift(null)).toBe(false);
  });
});

// --------------------------------------------------------------- retiros

describe('Retiros y cuentas, vistos por el gerente', () => {
  const NOW = '2026-09-06T12:00:00Z';
  const withdrawals = [
    { id: 'w1', status: 'paid', amount: '500.00', currency: 'MXN', created_at: '2026-09-01T10:00:00Z' },
    { id: 'w2', status: 'pending', amount: '300.00', currency: 'MXN', created_at: '2026-09-05T10:00:00Z' },
    { id: 'w3', status: 'approved', amount: '800.00', currency: 'MXN', created_at: '2026-09-02T10:00:00Z' },
    { id: 'w4', status: 'pending', amount: '150.00', currency: 'MXN', created_at: '2026-09-03T10:00:00Z' },
  ];

  it('lo que espera decisión va arriba, y lo más viejo primero', () => {
    expect(Pay.sortWithdrawals(withdrawals).map((w) => w.id)).toEqual(['w4', 'w2', 'w3', 'w1']);
  });

  it('la bandeja dice cuánto se debe y desde hace cuánto', () => {
    // Un retiro aprobado hace tres días sin pagar es alguien que ya contó con ese dinero.
    const box = Pay.inbox(withdrawals, NOW);
    expect(box).toMatchObject({ pending: 2, approved: 1, oldestDays: 4 });
    expect(box.owed).toEqual([{ currency: 'MXN', amount: '1250.00' }]);
  });

  it('aprobar y pagar son dos pasos, nunca uno', () => {
    // Juntarlos haría que un descuido marcara como pagado dinero que sigue en el banco.
    expect(Pay.actionsFor({ status: 'pending' })).toMatchObject({ canApprove: true, canPay: false });
    expect(Pay.actionsFor({ status: 'approved' })).toMatchObject({ canApprove: false, canPay: true });
    expect(Pay.actionsFor({ status: 'paid' })).toMatchObject({ canPay: false, isClosed: true });
    expect(Pay.actionsFor({ status: 'rejected' })).toMatchObject({ canApprove: false, isClosed: true });
  });

  it('avisa si se marca pagado sin referencia de la transferencia', () => {
    // Tres semanas después, cuando el empleado dice que nunca le llegó, la referencia
    // es lo único que permite conciliar.
    expect(Pay.payWarning({}, '')).toBe('pay.warnNoReference');
    expect(Pay.payWarning({}, '  ')).toBe('pay.warnNoReference');
    expect(Pay.payWarning({}, 'SPEI-99213')).toBe(null);
  });

  it('un rechazo sin motivo no se manda', () => {
    // Un "no" sin explicación no se puede corregir.
    expect(Pay.validateRejection('')).toBe('pay.errReason');
    expect(Pay.validateRejection('no')).toBe('pay.errReason');
    expect(Pay.validateRejection('La cuenta no coincide con tu identificación')).toBe(null);
  });

  const accounts = [
    { id: 'a1', bank_name: 'BBVA', account_last4: '4568', type: 'clabe', is_default: false, verified_at: null, created_at: '2026-09-01' },
    { id: 'a2', bank_name: 'Banorte', account_last4: '1122', type: 'clabe', is_default: true, verified_at: '2026-09-02', created_at: '2026-09-02' },
  ];

  it('la cuenta que cobra va primero, y luego lo que falta verificar', () => {
    expect(Pay.sortAccounts(accounts).map((a) => a.id)).toEqual(['a2', 'a1']);
  });

  it('cuenta las que esperan que alguien las mire', () => {
    expect(Pay.unverifiedCount(accounts)).toBe(1);
    expect(Pay.unverifiedCount([])).toBe(0);
  });

  it('lee el campo que el servidor manda de VERDAD, no el de la tabla', () => {
    // `services/banking.js` (maskAccount) devuelve `account_masked: "****1234"`. La
    // columna `account_last4` existe en la base pero NO viaja en la respuesta: leerla
    // dejaba un guion justo donde el gerente tiene que comparar dígitos, y verificar
    // se volvía puro teatro. Se cruza contra el servidor para que no se separen.
    // eslint-disable-next-line global-require
    const banking = require('../src/services/banking');
    const delServidor = banking.maskAccount({
      id: 'a9', country: 'MX', type: 'clabe', bank_name: 'BBVA', holder_name: 'Ana Paz',
      account_last4: '4568', routing_last4: null, is_default: true,
      verified_at: null, created_at: '2026-09-01',
    });
    expect(delServidor.account_last4).toBeUndefined();
    expect(Pay.accountLabel(delServidor).masked).toBe('••••4568');
    expect(Pay.verified(delServidor)).toBe(false);

    const yaVerificada = banking.maskAccount({
      id: 'a9', account_last4: '4568', verified_at: '2026-09-02', bank_name: 'BBVA',
    });
    expect(Pay.verified(yaVerificada)).toBe(true);
    expect(Pay.unverifiedCount([delServidor, yaVerificada])).toBe(1);
  });

  it('NUNCA enseña el número completo de la cuenta', () => {
    // La API solo manda los últimos cuatro. La pantalla no debe sugerir que hay más.
    const label = Pay.accountLabel(accounts[0]);
    expect(label.masked).toBe('••••4568');
    expect(JSON.stringify(label)).not.toMatch(/\d{10,}/);
  });

  it('una cuenta incompleta no rompe la tarjeta', () => {
    expect(Pay.accountLabel({}).masked).toBe('—');
    expect(Pay.accountLabel(null).bank).toBe('—');
  });
});

// --------------------------------------------------------------- la puerta

describe('La puerta: la anfitriona recibiendo', () => {
  const NOW = '2026-09-07T03:00:00Z';
  const reservations = [
    { id: 'r1', status: 'seated', guest_count: 6, user_name: 'José Ramírez', table_code: 'A1', arrival_deadline: '2026-09-07T05:00:00Z' },
    { id: 'r2', status: 'confirmed', guest_count: 4, user_name: 'Ana Paz', table_code: 'B2', arrival_deadline: '2026-09-07T02:00:00Z' },
    { id: 'r3', status: 'confirmed', guest_count: 2, user_name: 'Luis Mar', table_code: 'C3', arrival_deadline: '2026-09-07T04:00:00Z' },
    { id: 'r4', status: 'pending_payment', guest_count: 8, user_name: 'Zoe Luna', table_code: 'D4', arrival_deadline: '2026-09-07T06:00:00Z' },
    { id: 'r5', status: 'cancelled', guest_count: 2, user_name: 'Cancelada', table_code: 'E5' },
  ];

  it('quien ya está sentado se va al final: ya no es trabajo', () => {
    const order = Door.sortForDoor(reservations, NOW).map((r) => r.id);
    expect(order[order.length - 1]).toBe('r1');
  });

  it('arriba, quien está por perder su mesa', () => {
    // r2 ya se pasó de su hora; r3 le quedan 60 min.
    const order = Door.sortForDoor(reservations, NOW).map((r) => r.id);
    expect(order.indexOf('r2')).toBeLessThan(order.indexOf('r3'));
  });

  it('no enseña lo cancelado', () => {
    expect(Door.sortForDoor(reservations, NOW).map((r) => r.id)).not.toContain('r5');
  });

  it('la cuenta regresiva redondea hacia ARRIBA', () => {
    // Hacia abajo sería liberar antes de tiempo una mesa que ya está pagada.
    const c = Door.countdown({ arrival_deadline: '2026-09-07T04:00:30Z' }, NOW);
    expect(c.minutes).toBe(61);
    expect(c.expired).toBe(false);
  });

  it('el semáforo distingue tarde, por vencer y con tiempo', () => {
    expect(Door.urgency(reservations[1], NOW)).toBe('late');
    expect(Door.urgency({ status: 'confirmed', arrival_deadline: '2026-09-07T03:10:00Z' }, NOW)).toBe('soon');
    expect(Door.urgency(reservations[2], NOW)).toBe('ok');
    expect(Door.urgency(reservations[0], NOW)).toBe('done');
  });

  it('los botones son los que el servidor acepta, nunca uno que dé 409', () => {
    const confirmada = Door.actionsFor({ status: 'confirmed' }).map((a) => a.status);
    expect(confirmada).toEqual(['seated', 'no_show']);

    const sinPago = Door.actionsFor({ status: 'pending_payment' }).map((a) => a.status);
    expect(sinPago).toEqual(['confirmed']);

    expect(Door.actionsFor({ status: 'seated' }).map((a) => a.status)).toEqual(['completed']);
    expect(Door.actionsFor({ status: 'cancelled' })).toEqual([]);
  });

  it('"llegó" es el botón principal; "no llegó" pide confirmación', () => {
    // Marcar que no llegó libera una mesa que alguien pagó.
    const acciones = Door.actionsFor({ status: 'confirmed' });
    expect(acciones.find((a) => a.status === 'seated').primary).toBe(true);
    expect(acciones.find((a) => a.status === 'no_show')).toMatchObject({ primary: false, confirm: true });
  });

  it('respeta el mismo flujo de estados que el servidor', () => {
    expect(Door.canGo('confirmed', 'seated')).toBe(true);
    expect(Door.canGo('seated', 'no_show')).toBe(false);
    expect(Door.canGo('cancelled', 'seated')).toBe(false);
  });

  it('el resumen contesta "¿cómo vamos?"', () => {
    expect(Door.summary(reservations, NOW)).toEqual({
      expected: 3, seated: 1, late: 1, guestsInside: 6, noShow: 0,
    });
  });

  it('la búsqueda funciona sin acentos y sin mayúsculas', () => {
    // Se teclea de pie, con gente enfrente y ruido.
    expect(Door.search(reservations, 'jose ram').map((r) => r.id)).toEqual(['r1']);
    expect(Door.search(reservations, 'B2').map((r) => r.id)).toEqual(['r2']);
    expect(Door.search(reservations, '')).toHaveLength(reservations.length);
  });

  it('los eventos son los que el servidor publica de verdad', () => {
    // `reservation_updated` NO existe: el servidor arma `reservation_${estado}`.
    expect(Door.affectsDoor({ type: 'event', event_type: 'reservation_seated' })).toBe(true);
    expect(Door.affectsDoor({ type: 'event', event_type: 'reservation_no_show' })).toBe(true);
    expect(Door.affectsDoor({ type: 'event', event_type: 'reservation_created' })).toBe(true);
    expect(Door.affectsDoor({ type: 'event', event_type: 'reservation_updated' })).toBe(false);
    expect(Door.affectsDoor(null)).toBe(false);
  });
});
