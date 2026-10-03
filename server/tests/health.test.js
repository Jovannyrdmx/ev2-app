/**
 * El chequeo de salud, en las DOS direcciones en que hace falta.
 *
 * Existe por un defecto real de despliegue: el chequeo vivia solo en `/health`,
 * y el proxy de enfrente (`deploy/nginx-web.conf`) solo reenvia `/api/`. Desde
 * fuera del servidor **no habia manera de preguntarle a la API si estaba viva**,
 * asi que la vigilancia que pide el plan no tenia a donde apuntar, y cada
 * instruccion de diagnostico del tipo `curl https://dominio/api/health`
 * contestaba 404 y mandaba a buscar el problema donde no estaba.
 *
 * Esta prueba es la que impide que se vuelva a caer uno de los dos caminos.
 */
'use strict';

const { api } = require('./helpers/api');

describe('el chequeo de salud', () => {
  it('responde en /health, que es lo que mira Docker desde adentro', async () => {
    const res = await api().get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', service: 'ev2-api' });
  });

  it('y en /api/health, que es lo unico que el proxy reenvia desde fuera', async () => {
    const res = await api().get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', service: 'ev2-api' });
  });

  it('los dos dicen exactamente lo mismo, salvo la hora', async () => {
    const [a, b] = await Promise.all([api().get('/health'), api().get('/api/health')]);
    const sinHora = (body) => { const { timestamp, ...resto } = body; return resto; };
    expect(sinHora(a.body)).toEqual(sinHora(b.body));
  });

  it('no pide sesion: la vigilancia no tiene cuenta', async () => {
    // Si algun dia alguien mete `authenticate` delante, el monitoreo empieza a
    // reportar el servidor caido cuando esta perfectamente bien.
    for (const ruta of ['/health', '/api/health']) {
      const res = await api().get(ruta);
      expect({ ruta, status: res.status }).toEqual({ ruta, status: 200 });
    }
  });

  it('no revela nada del servidor: ni version, ni rutas, ni configuracion', async () => {
    const res = await api().get('/api/health');
    const cuerpo = JSON.stringify(res.body);
    for (const filtrado of ['JWT', 'SECRET', 'password', 'DB_', 'postgres://', 'redis://']) {
      expect(cuerpo).not.toContain(filtrado);
    }
    // Y tampoco la cabecera que anuncia con que esta hecho.
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
