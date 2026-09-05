/**
 * EV2 — idioma y formato (paso 5.1).
 *
 * Dos cosas que se hacen mal muy fácil:
 *
 * 1. **El dinero llega como cadena decimal** (`"1500.00"`) porque un peso no cabe sin
 *    pérdida en un `number` de JavaScript en cuanto se hacen cuentas. Aquí se formatea
 *    sin convertir a float, y sumar importes se hace en centavos enteros.
 * 2. **Los ids de evento son enteros de 64 bits** y viajan como cadena. No los pases por
 *    `Number()`.
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else root.EV2Format = lib;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LOCALES = { es: 'es-MX', en: 'en-US' };

  const STRINGS = {
    es: {
      'error.network': 'Sin conexión. Revisa tu señal e intenta de nuevo.',
      'error.unauthorized': 'Tu sesión terminó. Vuelve a entrar.',
      // Un 401 al ENTRAR no es una sesión vencida: no había sesión. Decirle a alguien
      // que su sesión terminó cuando lo que pasó es que se equivocó de contraseña lo
      // manda a buscar el problema donde no está.
      'error.badLogin': 'Correo o contraseña incorrectos.',
      'error.forbidden': 'No tienes permiso para hacer esto.',
      'error.not_found': 'No encontramos eso.',
      'error.conflict': 'Alguien se adelantó. Vuelve a intentar.',
      'error.unprocessable': 'No se puede completar con esos datos.',
      'error.too_many_requests': 'Demasiados intentos. Espera un momento.',
      'error.not_implemented': 'Todavía no está disponible.',
      'error.unknown': 'Algo salió mal. Intenta de nuevo.',
      'realtime.reconnecting': 'Reconectando…',
      'realtime.resync': 'Actualizando la pantalla…',
      'realtime.replaced': 'Abriste la app en otro lado.',

      // --- acceso ---
      'auth.city': 'Nogales, Sonora',
      'auth.signin': 'Entrar',
      'auth.signup': 'Crear cuenta',
      'auth.email': 'Correo',
      'auth.password': 'Contraseña',
      'auth.enter': 'Entrar al club',
      'auth.firstName': 'Nombre',
      'auth.lastName': 'Apellido',
      'auth.newPassword': 'Contraseña (mínimo 8)',
      'auth.birthDate': 'Fecha de nacimiento',
      'auth.terms': 'Tengo 18 años o más y acepto los términos y el código de conducta.',
      'auth.flirts': 'Quiero recibir invitaciones de otras personas.',
      'auth.flirtsNote': 'Puedes cambiarlo cuando quieras.',
      'auth.create': 'Crear cuenta',
      'auth.adults': 'Solo +18 · EV2 Clandestinoz',

      // --- barra superior y navegación ---
      'nav.map': 'Mapa',
      'nav.menu': 'Menú',
      'nav.orders': 'Pedidos',
      'nav.profile': 'Perfil',
      'top.noTable': 'sin mesa',
      'top.table': 'mesa',
      'top.live': 'En vivo',
      'top.offline': 'Sin conexión',
      'top.otherSession': 'Otra sesión',
      'top.signOut': 'Salir',

      // --- plano ---
      'map.tables': 'Mesas',
      'map.free': 'Libres',
      'map.vip': 'VIP',
      'map.busy': 'Ocupadas',
      'map.hint': 'Toca tu mesa en el plano',
      'map.selected': 'Mesa seleccionada',
      'map.table': 'Mesa',
      'map.zone': 'Zona',
      'map.capacity': 'Capacidad',
      'map.type': 'Tipo',
      'map.sit': 'Sentarme aquí',
      'map.move': 'Cambiarme a esta mesa',
      'map.alreadyHere': 'Ya estás en esta mesa',
      'map.youAreHere': 'Aquí estás sentado.',
      'map.unavailable': 'No disponible',
      'map.full': 'Esta mesa ya está llena.',
      'map.leave': 'Dejar mi mesa',
      'map.seated': 'Listo, esa es tu mesa',
      'map.occupied': 'Ocupada',
      'map.mine': 'Tu mesa',
      'map.floorBaja': 'PLANTA BAJA',
      'map.floorAlta': 'PLANTA ALTA',
      'map.floorAmbas': 'TODO EL CLUB',

      // --- menú y pedidos ---
      'menu.all': 'Todo',
      'menu.soldOut': 'agotado',
      'menu.empty': 'No hay bebidas en esta categoría.',
      'menu.noStock': 'No hay más existencias de eso',
      'cart.order': 'Pedir',
      'orders.empty': 'Todavía no has pedido nada.',
      'orders.needTable': 'Primero elige tu mesa: el mesero necesita saber a dónde llevarlo',
      'orders.sent': 'Pedido enviado a la barra',
      'orders.ready': '¡Tu pedido está listo en la barra!',

      // --- perfil ---
      'profile.table': 'Mesa',
      'profile.club': 'Club',
      'profile.account': 'Cuenta',
      'profile.signOut': 'Cerrar sesión',

      // --- empleado sin pantalla ---
      'staff.signedInAs': 'Entraste como',
      'staff.pending': 'Esta pantalla todavía no está conectada al servidor. Se construye en el paso {step} del plan de implementación.',
      'staff.noScreen': 'Esta cuenta no tiene una pantalla asignada. Avisa al administrador del club.',

      // --- avisos ---
      'banner.replaced': 'Abriste la app en otro lado. Recarga si quieres seguir aquí.',
      'banner.expired': 'Tu sesión terminó. Vuelve a entrar.',
      'banner.updating': 'Actualizando…',

      // --- barra (paso 5.7) ---
      'bar.title': 'Barra',
      'bar.laneNew': 'Nuevos',
      'bar.lanePrep': 'En preparación',
      'bar.laneReady': 'Listos',
      'bar.accept': 'Aceptar',
      'bar.retry': 'Reintentar',
      'bar.start': 'Empezar',
      'bar.markReady': 'Listo',
      'bar.markDelivered': 'Entregado',
      'bar.cancel': 'Cancelar',
      'bar.confirmCancel': '¿Cancelar este pedido? Se devuelve la existencia.',
      'bar.emptyNew': 'Sin pedidos nuevos.',
      'bar.emptyPrep': 'Nada en preparación.',
      'bar.emptyReady': 'Nada listo para recoger.',
      'bar.table': 'Mesa',
      'bar.noTable': 'Sin mesa',
      'bar.for': 'Para',
      'bar.gift': 'Invitación',
      'bar.note': 'Nota',
      'bar.justNow': 'recién',
      'bar.minutes': '{n} min',
      'bar.oldest': 'El más viejo',
      'bar.open': 'Abiertos',
      'bar.posError': 'La caja rechazó este pedido.',
      'bar.alertOn': 'Aviso activado',
      'bar.alertOff': 'Aviso apagado',
      'bar.newOrder': 'Pedido nuevo',
      'bar.reload': 'Actualizar',

      // --- salida segura / taxi (paso 5.6) ---
      'taxi.title': 'Salida segura',
      'taxi.nav': 'Salida',
      'taxi.disabled': 'El servicio de salida segura no está disponible ahora.',
      'taxi.someoneWaiting': 'Hay un conductor esperando en la salida.',
      'taxi.driversAvailable': '{n} conductor(es) disponible(s).',
      'taxi.noDriversNow': 'Ahora mismo no hay conductores. Puedes solicitar y te avisamos.',
      'taxi.searching': 'Buscando conductor…',
      'taxi.onTheWay': 'Un conductor va en camino.',
      'taxi.arrivesIn': 'Llega en {n} min. Espera arriba.',
      'taxi.goDownNow': 'Llega en {n} min. Baja a la salida.',
      'taxi.arrivingNow': 'Ya está llegando. Baja a la salida.',
      'taxi.atExit': 'Tu conductor está en la salida.',
      'taxi.riding': 'Viaje en curso. Buen camino.',
      'taxi.done': 'Viaje terminado.',
      'taxi.cancelled': 'El viaje se canceló.',
      'taxi.noDriver': 'Nadie tomó la solicitud. Puedes volver a pedir.',
      'taxi.request': 'Solicitar taxi',
      'taxi.requesting': 'Solicitando…',
      'taxi.cancel': 'Cancelar solicitud',
      'taxi.confirmCancel': '¿Cancelar la solicitud de taxi?',
      'taxi.destination': 'A dónde vas',
      'taxi.destinationHint': 'Colonia o referencia',
      'taxi.zone': 'Zona',
      'taxi.zoneAny': 'Otra zona (se acuerda con el conductor)',
      'taxi.passengers': 'Cuántos van',
      'taxi.notes': 'Algo que el conductor deba saber',
      'taxi.pickup': 'Punto de encuentro',
      'taxi.driver': 'Conductor',
      'taxi.vehicle': 'Vehículo',
      'taxi.fare': 'Costo',
      'taxi.fareOpen': 'Se acuerda con el conductor',
      'taxi.call': 'Llamar',
      'taxi.certificate': 'Comprobante de salida',
      'taxi.certificateFolio': 'Folio',
      'taxi.certificateNote': 'Cualquiera puede verificar este folio en la página del club. Vence solo.',
      'taxi.certificateExpired': 'Este comprobante ya venció.',
      'taxi.history': 'Tus viajes',
      'taxi.noHistory': 'Todavía no has pedido ningún taxi.',
      // --- pantalla del conductor ---
      'taxi.driverTitle': 'Conductor',
      'taxi.driverOffers': 'Solicitudes',
      'taxi.driverNoOffers': 'No hay solicitudes ahora.',
      'taxi.driverAvailable': 'Disponible',
      'taxi.driverOff': 'No disponible',
      'taxi.driverAtVenue': 'Estoy en la salida del club',
      'taxi.driverAccept': 'Aceptar',
      'taxi.driverEta': '¿En cuántos minutos llegas?',
      'taxi.driverDecline': 'Paso',
      'taxi.driverArrived': 'Ya llegué',
      'taxi.driverStart': 'Empezar viaje',
      'taxi.driverFinish': 'Terminar viaje',
      'taxi.driverAmount': 'Cuánto se cobró',
      'taxi.driverPayment': 'Cómo pagó',
      'taxi.payCash': 'Efectivo',
      'taxi.payCard': 'Tarjeta',
      'taxi.payCourtesy': 'Cortesía',
      'taxi.driverPassengers': 'Pasajeros',
      'taxi.driverTonight': 'Esta noche',
      'taxi.driverRides': 'viajes',
      'taxi.driverGuest': 'Pasajero',
      'taxi.driverNotVerified': 'Tu registro debe estar activo y verificado por el gerente.',

      // --- gerente (paso 5.5) ---
      'manager.title': 'Gerente',
      'manager.tabSummary': 'Turno',
      'manager.tabDrivers': 'Conductores',
      'manager.tabTaxi': 'Taxi',
      'manager.tabParking': 'Cajones',
      'manager.occupancy': 'Mesas ocupadas',
      'manager.ordersOpen': 'Pedidos abiertos',
      'manager.ordersReady': 'Listos',
      'manager.ordersDelivered': 'Entregados hoy',
      'manager.posErrors': 'Rechazados por la caja',
      'manager.onShift': 'En turno',
      'manager.clubRevenue': 'Caja del club',
      'manager.toStaff': 'Propinas al personal',
      'manager.toDrivers': 'Viajes a conductores',
      'manager.revenueNote': 'Las propinas y los viajes pasan por el sistema pero no son ingreso del club.',
      'manager.transactions': 'movimientos',
      'manager.refresh': 'Actualizar',
      // conductores
      'manager.newDriver': 'Dar de alta un conductor',
      'manager.noDrivers': 'Todavía no hay conductores registrados.',
      'manager.driverActive': 'Activo',
      'manager.driverInactive': 'Dado de baja',
      'manager.driverUnverified': 'Sin verificar',
      'manager.driverOff': 'No disponible',
      'manager.driverAvailable': 'Disponible',
      'manager.driverAtVenue': 'En la salida',
      'manager.driverOnTrip': 'En viaje',
      'manager.verify': 'Verificar',
      'manager.unverify': 'Quitar verificación',
      'manager.deactivate': 'Dar de baja',
      'manager.activate': 'Reactivar',
      'manager.resetPassword': 'Reiniciar contraseña',
      'manager.firstName': 'Nombre',
      'manager.lastName': 'Apellido',
      'manager.email': 'Correo',
      'manager.phone': 'Teléfono',
      'manager.birthDate': 'Fecha de nacimiento',
      'manager.company': 'Empresa (opcional)',
      'manager.plate': 'Placa',
      'manager.vehicleColor': 'Color',
      'manager.vehicleMake': 'Marca',
      'manager.vehicleModel': 'Modelo',
      'manager.trustedNow': 'Verificado desde ahora',
      'manager.save': 'Guardar',
      'manager.cancel': 'Cancelar',
      'manager.tempPassword': 'Contraseña temporal',
      'manager.tempPasswordNote': 'Anótala ahora: solo se muestra una vez. El conductor la cambia al entrar.',
      'manager.gotIt': 'Ya la anoté',
      'manager.errRequired': 'Falta este dato.',
      'manager.errEmail': 'Ese correo no se ve bien.',
      'manager.errPhone': 'El teléfono debe tener entre 7 y 30 caracteres.',
      'manager.errPlate': 'La placa debe tener entre 3 y 20 caracteres.',
      'manager.errDate': 'Usa el formato AAAA-MM-DD.',
      'manager.errUnderage': 'Un conductor debe ser mayor de edad.',
      // taxi
      'manager.taxiEnabled': 'Servicio de salida segura activo',
      'manager.pickupPoint': 'Punto de encuentro',
      'manager.zones': 'Zonas y tarifas',
      'manager.noZones': 'No hay zonas configuradas. Sin ellas el precio se acuerda con el conductor.',
      'manager.newZone': 'Agregar zona',
      'manager.zoneName': 'Zona',
      'manager.zoneAmount': 'Precio',
      'manager.remove': 'Quitar',
      // cajones
      'manager.parkingTotal': 'Cajones',
      'manager.parkingFree': 'Libres',
      'manager.parkingOccupied': 'Ocupados',
      'manager.spotsHint': 'Escribe los cajones separados por coma o salto de línea. Los rangos funcionan: A1-A20.',
      'manager.spotsZone': 'Zona (opcional)',
      'manager.addSpots': 'Dar de alta',
      'manager.spotsAdded': 'Se dieron de alta {n} cajones.',
      'manager.spotsSkipped': '{n} ya existían.',
      'manager.spotsInvalid': 'No se entendieron: {list}',
      'manager.noSpots': 'Todavía no hay cajones dados de alta.',
      'manager.valetEnabled': 'Servicio de valet activo',
      'manager.valetFee': 'Costo del valet (0 = gratis, solo propina)',
      'manager.saved': 'Guardado',

      // --- cambio de contraseña obligatorio ---
      'gate.title': 'Cambia tu contraseña',
      'gate.note': 'Entraste con una contraseña temporal. Elige una tuya para poder trabajar.',
      'gate.current': 'Contraseña temporal',
      'gate.new': 'Contraseña nueva (mínimo 8)',
      'gate.repeat': 'Repite la nueva',
      'gate.save': 'Cambiar y entrar',
      'gate.errCurrent': 'Escribe la contraseña temporal que te dieron.',
      'gate.errShort': 'La nueva debe tener al menos 8 caracteres.',
      'gate.errSame': 'La nueva tiene que ser distinta de la temporal.',
      'gate.errMismatch': 'Las dos contraseñas nuevas no coinciden.',
      'gate.done': 'Listo, contraseña cambiada.',

      // --- mesero y hostess (paso 5.7) ---
      'floor.title': 'Piso',
      'floor.trays': 'Charolas',
      'floor.items': 'Tragos',
      'floor.coming': 'En la barra',
      'floor.oldest': 'La más vieja',
      'floor.tabTrays': 'Por llevar',
      'floor.tabTables': 'Mesas',
      'floor.tabMe': 'Lo mío',
      'floor.noTrays': 'No hay nada listo para llevar.',
      'floor.deliver': 'Entregado',
      'floor.tableShort': 'Mesa',
      'floor.noTable': 'Sin mesa',
      'floor.delivered': 'Entregado',
      'floor.newReady': 'Hay algo listo en la barra',
      'floor.shiftStart': 'Iniciar turno',
      'floor.shiftEnd': 'Terminar turno',
      'floor.onShift': 'En turno desde hace {n} min',
      'floor.offShift': 'No estás en turno',
      'floor.confirmEndShift': '¿Terminar tu turno?',
      'floor.myTips': 'Mis propinas de hoy',
      'floor.tipsPaid': 'Confirmadas',
      'floor.tipsPending': 'Por confirmar',
      'floor.tipsPendingNote': 'Las que están por confirmar todavía no son saldo tuyo: el gerente las confirma al recibirlas.',
      'floor.noTips': 'Todavía no tienes propinas hoy.',
      'floor.occupied': 'Ocupadas',
      'floor.free': 'Libres',
      'floor.guests': 'Personas',
      'floor.release': 'Levantar',
      'floor.confirmRelease': '¿Levantar a esta persona de la mesa?',
      'floor.seatNote': 'El cliente se sienta desde su propia app tocando la mesa en el plano. Desde aquí solo se puede levantar a alguien.',
      // --- valet ---
      'valet.title': 'Valet',
      'valet.laneRequested': 'Lo pidieron',
      'valet.laneReady': 'En la puerta',
      'valet.laneParked': 'Guardados',
      'valet.markReady': 'Traer el coche',
      'valet.bringIt': 'Traer el coche',
      'valet.deliver': 'Entregar',
      'valet.cancel': 'Cancelar boleto',
      'valet.confirmCancel': '¿Cancelar este boleto?',
      'valet.cancelReason': 'Motivo',
      'valet.newTicket': 'Recibir un auto',
      'valet.plate': 'Placa',
      'valet.vehicleDesc': 'Cómo es el coche',
      'valet.spot': 'Cajón',
      'valet.spotAuto': 'Que el sistema lo asigne',
      'valet.phone': 'Teléfono del cliente (opcional)',
      'valet.notes': 'Notas',
      'valet.save': 'Recibir',
      'valet.searchPlate': 'Buscar por placa',
      'valet.emptyRequested': 'Nadie ha pedido su coche.',
      'valet.emptyReady': 'Ningún coche en la puerta.',
      'valet.emptyParked': 'No hay autos guardados.',
      'valet.handover': 'Punto de entrega',
      'valet.qrTitle': 'Pide el QR al cliente',
      'valet.qrNote': 'Es lo único que impide entregar un coche a quien no es. Si el cliente lo perdió, el gerente puede entregarlo con identificación.',
      'valet.qrToken': 'Código del cliente',
      'valet.payment': 'Cómo paga',
      'valet.errPlate': 'La placa debe tener entre 3 y 20 caracteres.',
      'valet.errToken': 'Ese código no tiene la forma correcta.',
      'valet.ticketCreated': 'Auto recibido. Boleto {code}.',
      'valet.qrForGuest': 'Código para el cliente',
      'valet.qrForGuestNote': 'Se muestra una sola vez. Dáselo al cliente: sin él no puede recoger su auto.',
      'valet.carRequested': 'Un cliente pidió su coche',
      'valet.spots': 'Cajones',
      // --- portal del empleado (paso 5.4) ---
      'earn.title': 'Mis ganancias',
      'earn.tabMoney': 'Saldo',
      'earn.tabWithdraw': 'Retiros',
      'earn.tabAccount': 'Cuenta',
      'earn.available': 'Disponible',
      'earn.earned': 'Ganado',
      'earn.reserved': 'En retiro',
      'earn.withdrawn': 'Retirado',
      'earn.reservedNote': 'Lo que está en retiro ya está comprometido: no se puede pedir dos veces.',
      'earn.sources': 'De dónde viene',
      'earn.recent': 'Últimos movimientos',
      'earn.noMovements': 'Todavía no hay movimientos.',
      'earn.mTip': 'Propinas',
      'earn.mSong': 'Canciones',
      'earn.mRide': 'Viajes',
      'earn.mValet': 'Valet',
      'earn.mWithdrawal': 'Retiros',
      'earn.mAdjustment': 'Ajustes',
      'earn.mOther': 'Otros',
      'earn.withdraw': 'Pedir un retiro',
      'earn.amount': 'Cuánto',
      'earn.all': 'Todo lo disponible',
      'earn.account': 'A qué cuenta',
      'earn.request': 'Solicitar',
      'earn.noWithdrawals': 'Todavía no has pedido ningún retiro.',
      'earn.wPending': 'Esperando aprobación',
      'earn.wApproved': 'Aprobado, por pagar',
      'earn.wPaid': 'Pagado',
      'earn.wRejected': 'Rechazado',
      'earn.errOpen': 'Ya tienes un retiro en proceso. Espera a que se resuelva.',
      'earn.errNoAccount': 'Registra una cuenta bancaria antes de pedir un retiro.',
      'earn.errUnverified': 'Tu cuenta todavía no está verificada por el gerente.',
      'earn.errNoMoney': 'No tienes saldo disponible.',
      'earn.errAmount': 'Escribe una cantidad mayor que cero.',
      'earn.errTooMuch': 'No puedes pedir más de lo disponible.',
      'earn.errRequired': 'Falta este dato.',
      'earn.errClabe': 'La CLABE son 18 dígitos.',
      'earn.errClabeCheck': 'Esa CLABE no es válida. Revísala: falta o sobra un dígito.',
      'earn.errAccount': 'El número de cuenta no se ve bien.',
      'earn.errRouting': 'El routing son 9 dígitos.',
      'earn.errRoutingCheck': 'Ese routing no es válido. Revísalo con tu banco.',
      'earn.accounts': 'Mis cuentas',
      'earn.newAccount': 'Registrar una cuenta',
      'earn.accountType': 'Tipo',
      'earn.typeClabe': 'CLABE (México)',
      'earn.typeChecking': 'Checking (EE. UU.)',
      'earn.typeSavings': 'Savings (EE. UU.)',
      'earn.bankName': 'Banco',
      'earn.holderName': 'A nombre de',
      'earn.accountNumber': 'Número de cuenta',
      'earn.routingNumber': 'Routing',
      'earn.verified': 'Verificada',
      'earn.unverified': 'Sin verificar',
      'earn.deleteAccount': 'Quitar',
      'earn.confirmDeleteAccount': '¿Quitar esta cuenta?',
      'earn.noAccounts': 'No tienes ninguna cuenta registrada.',
      'earn.verifyNote': 'El gerente tiene que verificar la cuenta antes del primer pago.',
    },
    en: {
      'error.network': 'No connection. Check your signal and try again.',
      'error.unauthorized': 'Your session ended. Please sign in again.',
      'error.badLogin': 'Wrong email or password.',
      'error.forbidden': "You don't have permission to do this.",
      'error.not_found': "We couldn't find that.",
      'error.conflict': 'Someone got there first. Try again.',
      'error.unprocessable': "That can't be completed with those details.",
      'error.too_many_requests': 'Too many attempts. Wait a moment.',
      'error.not_implemented': 'Not available yet.',
      'error.unknown': 'Something went wrong. Try again.',
      'realtime.reconnecting': 'Reconnecting…',
      'realtime.resync': 'Refreshing…',
      'realtime.replaced': 'You opened the app somewhere else.',

      // --- sign in ---
      'auth.city': 'Nogales, Sonora',
      'auth.signin': 'Sign in',
      'auth.signup': 'Sign up',
      'auth.email': 'Email',
      'auth.password': 'Password',
      'auth.enter': 'Enter the club',
      'auth.firstName': 'First name',
      'auth.lastName': 'Last name',
      'auth.newPassword': 'Password (at least 8)',
      'auth.birthDate': 'Date of birth',
      'auth.terms': "I'm 18 or older and I accept the terms and the code of conduct.",
      'auth.flirts': 'I want to receive invitations from other people.',
      'auth.flirtsNote': 'You can change this anytime.',
      'auth.create': 'Create account',
      'auth.adults': '18+ only · EV2 Clandestinoz',

      // --- top bar and navigation ---
      'nav.map': 'Map',
      'nav.menu': 'Menu',
      'nav.orders': 'Orders',
      'nav.profile': 'Profile',
      'top.noTable': 'no table',
      'top.table': 'table',
      'top.live': 'Live',
      'top.offline': 'Offline',
      'top.otherSession': 'Other session',
      'top.signOut': 'Sign out',

      // --- floor plan ---
      'map.tables': 'Tables',
      'map.free': 'Free',
      'map.vip': 'VIP',
      'map.busy': 'Taken',
      'map.hint': 'Tap your table on the map',
      'map.selected': 'Selected table',
      'map.table': 'Table',
      'map.zone': 'Zone',
      'map.capacity': 'Capacity',
      'map.type': 'Type',
      'map.sit': 'Sit here',
      'map.move': 'Move to this table',
      'map.alreadyHere': "You're already at this table",
      'map.youAreHere': "You're sitting here.",
      'map.unavailable': 'Not available',
      'map.full': 'This table is full.',
      'map.leave': 'Leave my table',
      'map.seated': "Done, that's your table",
      'map.occupied': 'Taken',
      'map.mine': 'Your table',
      'map.floorBaja': 'GROUND FLOOR',
      'map.floorAlta': 'UPPER FLOOR',
      'map.floorAmbas': 'WHOLE CLUB',

      // --- menu and orders ---
      'menu.all': 'All',
      'menu.soldOut': 'sold out',
      'menu.empty': 'No drinks in this category.',
      'menu.noStock': "There's no more of that in stock",
      'cart.order': 'Order',
      'orders.empty': "You haven't ordered anything yet.",
      'orders.needTable': 'Pick your table first: the waiter needs to know where to take it',
      'orders.sent': 'Order sent to the bar',
      'orders.ready': 'Your order is ready at the bar!',

      // --- profile ---
      'profile.table': 'Table',
      'profile.club': 'Club',
      'profile.account': 'Account',
      'profile.signOut': 'Sign out',

      // --- staff without a screen yet ---
      'staff.signedInAs': 'You signed in as',
      'staff.pending': 'This screen is not connected to the server yet. It is built in step {step} of the implementation plan.',
      'staff.noScreen': 'This account has no screen assigned. Tell the club administrator.',

      // --- notices ---
      'banner.replaced': 'You opened the app somewhere else. Reload if you want to continue here.',
      'banner.expired': 'Your session ended. Please sign in again.',
      'banner.updating': 'Refreshing…',

      // --- bar (step 5.7) ---
      'bar.title': 'Bar',
      'bar.laneNew': 'New',
      'bar.lanePrep': 'In progress',
      'bar.laneReady': 'Ready',
      'bar.accept': 'Accept',
      'bar.retry': 'Retry',
      'bar.start': 'Start',
      'bar.markReady': 'Ready',
      'bar.markDelivered': 'Delivered',
      'bar.cancel': 'Cancel',
      'bar.confirmCancel': 'Cancel this order? The stock goes back.',
      'bar.emptyNew': 'No new orders.',
      'bar.emptyPrep': 'Nothing in progress.',
      'bar.emptyReady': 'Nothing waiting for pickup.',
      'bar.table': 'Table',
      'bar.noTable': 'No table',
      'bar.for': 'For',
      'bar.gift': 'Gift',
      'bar.note': 'Note',
      'bar.justNow': 'just now',
      'bar.minutes': '{n} min',
      'bar.oldest': 'Longest wait',
      'bar.open': 'Open',
      'bar.posError': 'The register rejected this order.',
      'bar.alertOn': 'Alert on',
      'bar.alertOff': 'Alert off',
      'bar.newOrder': 'New order',
      'bar.reload': 'Refresh',

      // --- safe departure / taxi (step 5.6) ---
      'taxi.title': 'Safe departure',
      'taxi.nav': 'Ride',
      'taxi.disabled': 'Safe departure is not available right now.',
      'taxi.someoneWaiting': 'A driver is waiting at the exit.',
      'taxi.driversAvailable': '{n} driver(s) available.',
      'taxi.noDriversNow': 'No drivers right now. You can still request and we will tell you.',
      'taxi.searching': 'Looking for a driver…',
      'taxi.onTheWay': 'A driver is on the way.',
      'taxi.arrivesIn': 'Arrives in {n} min. Wait upstairs.',
      'taxi.goDownNow': 'Arrives in {n} min. Head to the exit.',
      'taxi.arrivingNow': 'Arriving now. Head to the exit.',
      'taxi.atExit': 'Your driver is at the exit.',
      'taxi.riding': 'Ride in progress. Safe trip.',
      'taxi.done': 'Ride finished.',
      'taxi.cancelled': 'The ride was cancelled.',
      'taxi.noDriver': 'Nobody took the request. You can ask again.',
      'taxi.request': 'Request a ride',
      'taxi.requesting': 'Requesting…',
      'taxi.cancel': 'Cancel request',
      'taxi.confirmCancel': 'Cancel the ride request?',
      'taxi.destination': 'Where to',
      'taxi.destinationHint': 'Neighbourhood or landmark',
      'taxi.zone': 'Zone',
      'taxi.zoneAny': 'Another zone (agreed with the driver)',
      'taxi.passengers': 'How many of you',
      'taxi.notes': 'Anything the driver should know',
      'taxi.pickup': 'Pickup point',
      'taxi.driver': 'Driver',
      'taxi.vehicle': 'Vehicle',
      'taxi.fare': 'Fare',
      'taxi.fareOpen': 'Agreed with the driver',
      'taxi.call': 'Call',
      'taxi.certificate': 'Departure receipt',
      'taxi.certificateFolio': 'Reference',
      'taxi.certificateNote': 'Anyone can verify this reference on the club page. It expires on its own.',
      'taxi.certificateExpired': 'This receipt has expired.',
      'taxi.history': 'Your rides',
      'taxi.noHistory': "You haven't requested a ride yet.",
      // --- driver screen ---
      'taxi.driverTitle': 'Driver',
      'taxi.driverOffers': 'Requests',
      'taxi.driverNoOffers': 'No requests right now.',
      'taxi.driverAvailable': 'Available',
      'taxi.driverOff': 'Not available',
      'taxi.driverAtVenue': "I'm at the club exit",
      'taxi.driverAccept': 'Accept',
      'taxi.driverEta': 'How many minutes away are you?',
      'taxi.driverDecline': 'Pass',
      'taxi.driverArrived': "I've arrived",
      'taxi.driverStart': 'Start ride',
      'taxi.driverFinish': 'Finish ride',
      'taxi.driverAmount': 'Amount charged',
      'taxi.driverPayment': 'How they paid',
      'taxi.payCash': 'Cash',
      'taxi.payCard': 'Card',
      'taxi.payCourtesy': 'Courtesy',
      'taxi.driverPassengers': 'Passengers',
      'taxi.driverTonight': 'Tonight',
      'taxi.driverRides': 'rides',
      'taxi.driverGuest': 'Passenger',
      'taxi.driverNotVerified': 'Your registration must be active and verified by the manager.',

      // --- manager (step 5.5) ---
      'manager.title': 'Manager',
      'manager.tabSummary': 'Shift',
      'manager.tabDrivers': 'Drivers',
      'manager.tabTaxi': 'Taxi',
      'manager.tabParking': 'Spots',
      'manager.occupancy': 'Tables taken',
      'manager.ordersOpen': 'Open orders',
      'manager.ordersReady': 'Ready',
      'manager.ordersDelivered': 'Delivered today',
      'manager.posErrors': 'Rejected by the register',
      'manager.onShift': 'On shift',
      'manager.clubRevenue': "Club's takings",
      'manager.toStaff': 'Tips to staff',
      'manager.toDrivers': 'Fares to drivers',
      'manager.revenueNote': "Tips and fares pass through the system but are not the club's income.",
      'manager.transactions': 'transactions',
      'manager.refresh': 'Refresh',
      // drivers
      'manager.newDriver': 'Register a driver',
      'manager.noDrivers': 'No drivers registered yet.',
      'manager.driverActive': 'Active',
      'manager.driverInactive': 'Deactivated',
      'manager.driverUnverified': 'Not verified',
      'manager.driverOff': 'Not available',
      'manager.driverAvailable': 'Available',
      'manager.driverAtVenue': 'At the exit',
      'manager.driverOnTrip': 'On a ride',
      'manager.verify': 'Verify',
      'manager.unverify': 'Remove verification',
      'manager.deactivate': 'Deactivate',
      'manager.activate': 'Reactivate',
      'manager.resetPassword': 'Reset password',
      'manager.firstName': 'First name',
      'manager.lastName': 'Last name',
      'manager.email': 'Email',
      'manager.phone': 'Phone',
      'manager.birthDate': 'Date of birth',
      'manager.company': 'Company (optional)',
      'manager.plate': 'Plate',
      'manager.vehicleColor': 'Colour',
      'manager.vehicleMake': 'Make',
      'manager.vehicleModel': 'Model',
      'manager.trustedNow': 'Verified from now',
      'manager.save': 'Save',
      'manager.cancel': 'Cancel',
      'manager.tempPassword': 'Temporary password',
      'manager.tempPasswordNote': 'Write it down now: it is shown only once. The driver changes it on first sign-in.',
      'manager.gotIt': "I've written it down",
      'manager.errRequired': 'This is missing.',
      'manager.errEmail': "That email doesn't look right.",
      'manager.errPhone': 'The phone must be 7 to 30 characters.',
      'manager.errPlate': 'The plate must be 3 to 20 characters.',
      'manager.errDate': 'Use the format YYYY-MM-DD.',
      'manager.errUnderage': 'A driver must be of legal age.',
      // taxi
      'manager.taxiEnabled': 'Safe departure service on',
      'manager.pickupPoint': 'Pickup point',
      'manager.zones': 'Zones and fares',
      'manager.noZones': 'No zones set. Without them the fare is agreed with the driver.',
      'manager.newZone': 'Add zone',
      'manager.zoneName': 'Zone',
      'manager.zoneAmount': 'Fare',
      'manager.remove': 'Remove',
      // parking
      'manager.parkingTotal': 'Spots',
      'manager.parkingFree': 'Free',
      'manager.parkingOccupied': 'Taken',
      'manager.spotsHint': 'Type the spots separated by commas or line breaks. Ranges work: A1-A20.',
      'manager.spotsZone': 'Zone (optional)',
      'manager.addSpots': 'Register',
      'manager.spotsAdded': '{n} spots registered.',
      'manager.spotsSkipped': '{n} already existed.',
      'manager.spotsInvalid': 'Not understood: {list}',
      'manager.noSpots': 'No spots registered yet.',
      'manager.valetEnabled': 'Valet service on',
      'manager.valetFee': 'Valet fee (0 = free, tip only)',
      'manager.saved': 'Saved',

      // --- forced password change ---
      'gate.title': 'Change your password',
      'gate.note': 'You signed in with a temporary password. Pick your own to start working.',
      'gate.current': 'Temporary password',
      'gate.new': 'New password (at least 8)',
      'gate.repeat': 'Repeat the new one',
      'gate.save': 'Change and continue',
      'gate.errCurrent': 'Type the temporary password you were given.',
      'gate.errShort': 'The new one must be at least 8 characters.',
      'gate.errSame': 'The new one must be different from the temporary one.',
      'gate.errMismatch': 'The two new passwords do not match.',
      'gate.done': 'Done, password changed.',

      // --- waiter and hostess (step 5.7) ---
      'floor.title': 'Floor',
      'floor.trays': 'Trays',
      'floor.items': 'Drinks',
      'floor.coming': 'At the bar',
      'floor.oldest': 'Longest wait',
      'floor.tabTrays': 'To deliver',
      'floor.tabTables': 'Tables',
      'floor.tabMe': 'Mine',
      'floor.noTrays': 'Nothing ready to take out.',
      'floor.deliver': 'Delivered',
      'floor.tableShort': 'Table',
      'floor.noTable': 'No table',
      'floor.delivered': 'Delivered',
      'floor.newReady': "There's something ready at the bar",
      'floor.shiftStart': 'Start shift',
      'floor.shiftEnd': 'End shift',
      'floor.onShift': 'On shift for {n} min',
      'floor.offShift': 'Not on shift',
      'floor.confirmEndShift': 'End your shift?',
      'floor.myTips': "Today's tips",
      'floor.tipsPaid': 'Confirmed',
      'floor.tipsPending': 'Awaiting confirmation',
      'floor.tipsPendingNote': 'Tips awaiting confirmation are not your balance yet: the manager confirms them on receipt.',
      'floor.noTips': 'No tips today yet.',
      'floor.occupied': 'Taken',
      'floor.free': 'Free',
      'floor.guests': 'People',
      'floor.release': 'Clear',
      'floor.confirmRelease': 'Clear this person from the table?',
      'floor.seatNote': 'Guests seat themselves from their own app by tapping the table on the map. From here you can only clear someone.',
      // --- valet ---
      'valet.title': 'Valet',
      'valet.laneRequested': 'Asked for',
      'valet.laneReady': 'At the door',
      'valet.laneParked': 'Parked',
      'valet.markReady': 'Bring the car',
      'valet.bringIt': 'Bring the car',
      'valet.deliver': 'Hand over',
      'valet.cancel': 'Cancel ticket',
      'valet.confirmCancel': 'Cancel this ticket?',
      'valet.cancelReason': 'Reason',
      'valet.newTicket': 'Take a car in',
      'valet.plate': 'Plate',
      'valet.vehicleDesc': 'What the car looks like',
      'valet.spot': 'Spot',
      'valet.spotAuto': 'Let the system assign it',
      'valet.phone': "Guest's phone (optional)",
      'valet.notes': 'Notes',
      'valet.save': 'Take in',
      'valet.searchPlate': 'Search by plate',
      'valet.emptyRequested': 'Nobody has asked for their car.',
      'valet.emptyReady': 'No cars at the door.',
      'valet.emptyParked': 'No cars parked.',
      'valet.handover': 'Handover point',
      'valet.qrTitle': "Ask the guest for their code",
      'valet.qrNote': "It's the only thing stopping a car being handed to the wrong person. If the guest lost it, a manager can hand it over with ID.",
      'valet.qrToken': "Guest's code",
      'valet.payment': 'How they pay',
      'valet.errPlate': 'The plate must be 3 to 20 characters.',
      'valet.errToken': "That code doesn't have the right shape.",
      'valet.ticketCreated': 'Car taken in. Ticket {code}.',
      'valet.qrForGuest': 'Code for the guest',
      'valet.qrForGuestNote': 'Shown only once. Give it to the guest: without it they cannot collect their car.',
      'valet.carRequested': 'A guest asked for their car',
      'valet.spots': 'Spots',
      // --- employee portal (step 5.4) ---
      'earn.title': 'My earnings',
      'earn.tabMoney': 'Balance',
      'earn.tabWithdraw': 'Withdrawals',
      'earn.tabAccount': 'Account',
      'earn.available': 'Available',
      'earn.earned': 'Earned',
      'earn.reserved': 'In withdrawal',
      'earn.withdrawn': 'Withdrawn',
      'earn.reservedNote': 'What is in a withdrawal is already committed: it cannot be requested twice.',
      'earn.sources': 'Where it comes from',
      'earn.recent': 'Recent movements',
      'earn.noMovements': 'No movements yet.',
      'earn.mTip': 'Tips',
      'earn.mSong': 'Songs',
      'earn.mRide': 'Rides',
      'earn.mValet': 'Valet',
      'earn.mWithdrawal': 'Withdrawals',
      'earn.mAdjustment': 'Adjustments',
      'earn.mOther': 'Other',
      'earn.withdraw': 'Request a withdrawal',
      'earn.amount': 'How much',
      'earn.all': 'All available',
      'earn.account': 'To which account',
      'earn.request': 'Request',
      'earn.noWithdrawals': "You haven't requested a withdrawal yet.",
      'earn.wPending': 'Awaiting approval',
      'earn.wApproved': 'Approved, to be paid',
      'earn.wPaid': 'Paid',
      'earn.wRejected': 'Rejected',
      'earn.errOpen': 'You already have a withdrawal in progress. Wait for it to be resolved.',
      'earn.errNoAccount': 'Register a bank account before requesting a withdrawal.',
      'earn.errUnverified': 'Your account has not been verified by the manager yet.',
      'earn.errNoMoney': 'You have no available balance.',
      'earn.errAmount': 'Type an amount greater than zero.',
      'earn.errTooMuch': 'You cannot request more than what is available.',
      'earn.errRequired': 'This is missing.',
      'earn.errClabe': 'A CLABE is 18 digits.',
      'earn.errClabeCheck': "That CLABE isn't valid. Check it: a digit is missing or extra.",
      'earn.errAccount': "The account number doesn't look right.",
      'earn.errRouting': 'A routing number is 9 digits.',
      'earn.errRoutingCheck': "That routing number isn't valid. Check it with your bank.",
      'earn.accounts': 'My accounts',
      'earn.newAccount': 'Register an account',
      'earn.accountType': 'Type',
      'earn.typeClabe': 'CLABE (Mexico)',
      'earn.typeChecking': 'Checking (US)',
      'earn.typeSavings': 'Savings (US)',
      'earn.bankName': 'Bank',
      'earn.holderName': 'Account holder',
      'earn.accountNumber': 'Account number',
      'earn.routingNumber': 'Routing',
      'earn.verified': 'Verified',
      'earn.unverified': 'Not verified',
      'earn.deleteAccount': 'Remove',
      'earn.confirmDeleteAccount': 'Remove this account?',
      'earn.noAccounts': 'You have no account registered.',
      'earn.verifyNote': 'The manager must verify the account before the first payment.',
    },
  };

  /**
   * Mensajes que el servidor todavía manda en inglés. Mostrarlos tal cual a un usuario
   * en español es peor que el texto genérico; se traducen por catálogo mientras la API
   * no los localice.
   */
  const ENGLISH_SERVER_MESSAGES = new Set([
    'Invalid credentials', 'Order not found', 'Table not found', 'Not your order',
    'Only staff can change this order',
  ]);

  const STORAGE_KEY = 'ev2.lang';
  const SUPPORTED = Object.keys(STRINGS);

  /**
   * El idioma se elige una vez y se recuerda. Antes vivía en una variable en memoria:
   * el botón cambiaba de etiqueta, y al recargar volvía a español sin avisar.
   */
  function readStored(storage) {
    try {
      const saved = storage && storage.getItem(STORAGE_KEY);
      if (saved && SUPPORTED.includes(saved)) return saved;
    } catch { /* modo privado, cuota llena: no es motivo para no abrir la app */ }
    return null;
  }

  function detect(nav) {
    const tags = (nav && (nav.languages || (nav.language ? [nav.language] : []))) || [];
    for (const tag of tags) {
      const base = String(tag).slice(0, 2).toLowerCase();
      if (SUPPORTED.includes(base)) return base;
    }
    return 'es';
  }

  const g = typeof globalThis !== 'undefined' ? globalThis : {};
  let store = null;
  try { store = g.localStorage || null; } catch { store = null; }

  let lang = readStored(store) || detect(g.navigator) || 'es';

  function setLanguage(next) {
    lang = STRINGS[next] ? next : 'es';
    try { if (store) store.setItem(STORAGE_KEY, lang); } catch { /* ver readStored */ }
    if (g.document && g.document.documentElement) g.document.documentElement.lang = lang;
    return lang;
  }
  const getLanguage = () => lang;
  const locale = () => LOCALES[lang];
  /** El otro idioma: es lo que tiene que decir el botón, no el actual. */
  const otherLanguage = () => (lang === 'es' ? 'en' : 'es');

  function t(key, fallback) {
    const table = STRINGS[lang] || STRINGS.es;
    // Si a un idioma le falta una clave se cae al español antes que al nombre de la
    // clave: un botón que diga "map.sit" es peor que uno que diga "Sentarme aquí".
    const value = table[key] !== undefined ? table[key] : STRINGS.es[key];
    return value !== undefined ? value : (fallback !== undefined ? fallback : key);
  }

  /** `t` con huecos: t('staff.pending', { step: '5.7' }). */
  function tf(key, vars) {
    return String(t(key)).replace(/\{(\w+)\}/g, (whole, name) => (
      vars && vars[name] !== undefined ? vars[name] : whole));
  }

  /**
   * Traduce el HTML ya escrito. Cada texto visible lleva `data-i18n="clave"`, y los
   * textos que van dentro de un atributo llevan `data-i18n-placeholder` o
   * `data-i18n-title`. Así el idioma se aplica sin volver a pintar la pantalla.
   */
  function applyTo(root) {
    if (!root || !root.querySelectorAll) return 0;
    let count = 0;
    for (const el of root.querySelectorAll('[data-i18n]')) {
      el.textContent = t(el.getAttribute('data-i18n'));
      count += 1;
    }
    for (const attr of ['placeholder', 'title', 'aria-label']) {
      for (const el of root.querySelectorAll(`[data-i18n-${attr}]`)) {
        el.setAttribute(attr, t(el.getAttribute(`data-i18n-${attr}`)));
        count += 1;
      }
    }
    return count;
  }

  /** Las claves que le faltan a un idioma. Se usa en las pruebas. */
  function missingKeys(language) {
    const table = STRINGS[language] || {};
    return Object.keys(STRINGS.es).filter((k) => table[k] === undefined);
  }

  /**
   * El mensaje del servidor ya viene en español y suele ser más útil que uno genérico
   * (dice *por qué* no se pudo). Se usa ese, y el texto propio solo cuando no hay.
   */
  function errorMessage(err, opts) {
    if (!err) return t('error.unknown');
    if (err.name === 'NetworkError') return t('error.network');

    // En la pantalla de acceso, un 401 significa credenciales malas. El servidor
    // responde 'unauthorized' para los dos casos, así que la pantalla es la única que
    // sabe cuál es; sin esto el texto es literalmente falso.
    if (opts && opts.context === 'login' && err.status === 401) return t('error.badLogin');

    // El mensaje del servidor viene en español y suele decir *por qué* mejor que uno
    // genérico. En inglés no sirve: está en español, así que se usa el catálogo.
    if (err.message && err.code && err.code !== 'unknown' && lang === 'es'
        && !ENGLISH_SERVER_MESSAGES.has(err.message)) {
      return err.message;
    }
    return t(`error.${err.code || 'unknown'}`, err.message);
  }

  /** "1500.00" -> "$1,500.00". Nunca convierte a float para mostrar. */
  function money(amount, currency, opts = {}) {
    if (amount === null || amount === undefined || amount === '') return '—';
    const value = typeof amount === 'string' ? Number(amount) : amount;
    if (!Number.isFinite(value)) return String(amount);
    return new Intl.NumberFormat(opts.locale || locale(), {
      style: 'currency',
      currency: currency || 'MXN',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  }

  /** Suma importes decimales en centavos enteros: 0.1 + 0.2 no es 0.3 en float. */
  function addMoney(...amounts) {
    const cents = amounts.reduce((sum, a) => {
      if (a === null || a === undefined || a === '') return sum;
      return sum + Math.round(Number(a) * 100);
    }, 0);
    return (cents / 100).toFixed(2);
  }

  function dateTime(iso, opts = {}) {
    if (!iso) return '—';
    return new Intl.DateTimeFormat(opts.locale || locale(), Object.assign({
      dateStyle: 'medium', timeStyle: 'short',
    }, opts.format || {})).format(new Date(iso));
  }

  function time(iso) {
    if (!iso) return '—';
    return new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit' })
      .format(new Date(iso));
  }

  /** "llega en 8 min", "ya pasó". Para la espera del taxi y del auto en el valet. */
  function minutesUntil(iso) {
    if (!iso) return null;
    return Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  }

  return {
    setLanguage, getLanguage, otherLanguage, locale, t, tf, applyTo, missingKeys,
    errorMessage, money, addMoney, dateTime, time, minutesUntil,
    detect, STRINGS, SUPPORTED, STORAGE_KEY,
  };
}));
