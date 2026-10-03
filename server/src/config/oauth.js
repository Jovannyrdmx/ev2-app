/**
 * Entrar con una cuenta de otro: quién está disponible y quién no.
 *
 * Mismo criterio que `config/payments.js`: las credenciales viven **solo** en el
 * `.env`, nunca en la base —una llave secreta guardada en Postgres es una llave
 * secreta en cada respaldo— y mientras falten, el proveedor se reporta como no
 * configurado **diciendo qué variable falta**. Nada finge funcionar: el cliente
 * solo ve los botones que de verdad sirven.
 *
 * ---------------------------------------------------------------------------
 * Instagram: por qué está aquí y apagado
 * ---------------------------------------------------------------------------
 * "Iniciar sesión con Instagram" ya no existe para cuentas personales. La
 * Instagram Basic Display API se apagó el **4 de diciembre de 2024**, y sus dos
 * sucesores —Instagram API with Instagram Login e Instagram Graph API— solo
 * funcionan con cuentas **Business o Creator**, y ninguno entrega el correo.
 *
 * Un cliente del club, con su Instagram normal, no puede entrar con Instagram, y
 * no hay nada que programar que lo arregle. Queda declarado, apagado y con el
 * motivo escrito por dos razones: para que nadie vuelva a pedirlo sin enterarse
 * de por qué no está, y para que el día que Meta reabra el login de consumidor
 * se encienda poniendo credenciales, sin tocar código.
 *
 * La misma estructura acepta **Google y Apple**, que sí hacen login de
 * consumidor con correo verificado. Apple, además, es obligatorio en la App
 * Store para cualquier app que ofrezca login social, así que si algún día hay
 * app de iOS va a hacer falta.
 */
'use strict';

/**
 * El dominio público con el que se arma la dirección de retorno.
 *
 * Tiene que ser EXACTAMENTE la que esté dada de alta en el panel de Meta: si no
 * coincide carácter por carácter, Facebook rechaza el viaje con un error que
 * habla de la URI y no de esto. Sale del servidor, nunca de la cabecera `Host`
 * de quien pide.
 */
function publicBaseUrl() {
  if (process.env.PUBLIC_WEB_URL) return process.env.PUBLIC_WEB_URL.replace(/\/+$/, '');
  const primero = (process.env.ALLOWED_ORIGINS || '').split(',')[0].trim();
  return primero.replace(/\/+$/, '');
}

const redirectUri = (provider) => `${publicBaseUrl()}/api/auth/oauth/${provider}/callback`;

/**
 * Facebook Login. Es el único que de verdad sirve hoy para un cliente del club.
 *
 * `scope` pide lo mínimo: el perfil público y el correo. No se piden amigos, ni
 * fotos, ni publicaciones — nada de eso hace falta para dejar entrar a alguien, y
 * pedirlo alarga la pantalla de permisos, baja la conversión y obliga a una
 * revisión de Meta que el club no necesita pasar.
 *
 * `api_version` se fija a propósito: Meta retira versiones cada dos años, y una
 * llamada sin versión se mueve sola bajo los pies el día que retiran la actual.
 */
function facebookConfig() {
  const appId = process.env.FACEBOOK_APP_ID || '';
  const appSecret = process.env.FACEBOOK_APP_SECRET || '';
  const missing = [];
  if (!appId) missing.push('FACEBOOK_APP_ID');
  if (!appSecret) missing.push('FACEBOOK_APP_SECRET');
  if (!publicBaseUrl()) missing.push('PUBLIC_WEB_URL (o ALLOWED_ORIGINS)');
  return {
    provider: 'facebook',
    label: 'Facebook',
    configured: missing.length === 0,
    missing,
    available: true,
    app_id: appId,
    app_secret: appSecret,
    api_version: 'v21.0',
    scope: 'public_profile,email',
    authorize_url: 'https://www.facebook.com/v21.0/dialog/oauth',
    token_url: 'https://graph.facebook.com/v21.0/oauth/access_token',
    profile_url: 'https://graph.facebook.com/v21.0/me',
    profile_fields: 'id,name,first_name,last_name,email',
    redirect_uri: redirectUri('facebook'),
  };
}

/**
 * Instagram. Declarado y APAGADO, con el motivo.
 *
 * `available: false` no es "falta configurarlo": es "no se puede". La ruta que
 * arranca el viaje lo distingue, y le contesta al cliente el motivo en vez de
 * mandarlo a una pantalla de Meta que va a rechazarlo.
 */
function instagramConfig() {
  return {
    provider: 'instagram',
    label: 'Instagram',
    configured: false,
    missing: [],
    available: false,
    unavailable_reason: 'instagram_consumer_login_discontinued',
    unavailable_note: 'La Instagram Basic Display API se apagó el 4 de diciembre de 2024. '
      + 'Sus sucesores solo aceptan cuentas Business o Creator y no entregan correo, '
      + 'así que un cliente con su Instagram personal no puede entrar por aquí.',
  };
}

const PROVIDERS = { facebook: facebookConfig, instagram: instagramConfig };

/** La configuración de un proveedor, o null si no existe en el sistema. */
function providerConfig(name) {
  const build = PROVIDERS[String(name || '').toLowerCase()];
  return build ? build() : null;
}

/**
 * Lo que el cliente necesita saber para pintar sus botones.
 *
 * Nunca lleva `app_secret`: esta lista la pide un navegador sin sesión. Y el
 * `app_id` tampoco hace falta —el viaje lo arma el servidor— así que tampoco va.
 */
function publicStatus() {
  const providers = Object.keys(PROVIDERS).map((name) => {
    const c = providerConfig(name);
    return {
      provider: c.provider,
      label: c.label,
      // Solo esto decide si se pinta el botón.
      enabled: c.available && c.configured,
      available: c.available,
      ...(c.available ? {} : {
        unavailable_reason: c.unavailable_reason,
        unavailable_note: c.unavailable_note,
      }),
    };
  });
  return {
    providers,
    any_enabled: providers.some((p) => p.enabled),
    // El correo y la contraseña siempre funcionan, con o sin proveedores. Es lo
    // que el club usa hoy y lo que no depende de la cuenta de nadie más.
    password_available: true,
  };
}

/**
 * Lo que el gerente ve: además de lo de arriba, qué variable falta por poner.
 * Los secretos siguen sin salir — solo sus NOMBRES.
 */
function status() {
  return {
    providers: Object.keys(PROVIDERS).map((name) => {
      const c = providerConfig(name);
      return {
        provider: c.provider,
        label: c.label,
        configured: c.configured,
        available: c.available,
        missing: c.missing,
        ...(c.available ? { redirect_uri: c.redirect_uri } : {
          unavailable_reason: c.unavailable_reason,
          unavailable_note: c.unavailable_note,
        }),
      };
    }),
  };
}

module.exports = {
  PROVIDER_NAMES: Object.keys(PROVIDERS),
  providerConfig,
  facebookConfig,
  instagramConfig,
  publicStatus,
  status,
  publicBaseUrl,
};
