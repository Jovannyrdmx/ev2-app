/**
 * Ningún contenedor de producción se publica a internet salvo Caddy (D69).
 *
 * Docker se salta `ufw`: un `ports: - "8081:8080"` en el compose deja el puerto abierto
 * a todo internet aunque el cortafuegos diga que está cerrado (deploy/firewall.sh). Con
 * el panel de la base (Adminer) eso sería publicar la pantalla de acceso a la base.
 *
 * La regla, comprobada aquí y no solo escrita en un comentario:
 *   - Caddy publica 80 y 443, y nada más.
 *   - Cualquier otro servicio que publique un puerto lo hace SOLO en 127.0.0.1.
 *   - Postgres y Redis no publican nada.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const compose = yaml.load(fs.readFileSync(
  path.join(__dirname, '..', '..', 'deploy', 'docker-compose.prod.yml'), 'utf8'));
const servicios = compose.services;

describe('puertos del compose de producción', () => {
  it('Caddy publica solo 80 y 443', () => {
    expect((servicios.caddy.ports || []).map(String).sort()).toEqual(['443:443', '80:80']);
  });

  it('todo lo demás que publique un puerto lo hace solo en 127.0.0.1', () => {
    for (const [nombre, def] of Object.entries(servicios)) {
      if (nombre === 'caddy') continue;
      for (const p of def.ports || []) {
        const texto = typeof p === 'string' ? p : `${p.host_ip || ''}:${p.published}:${p.target}`;
        expect({ servicio: nombre, puerto: texto })
          .toEqual({ servicio: nombre, puerto: expect.stringMatching(/^127\.0\.0\.1:\d+:\d+$/) });
      }
    }
  });

  it('Postgres y Redis no publican ningún puerto', () => {
    expect(servicios.postgres.ports).toBeUndefined();
    expect(servicios.redis.ports).toBeUndefined();
  });

  it('el panel de la base existe, con versión fija y solo en el loopback', () => {
    const adminer = servicios.adminer;
    expect(adminer).toBeDefined();
    expect(adminer.image).toMatch(/^adminer:\d+\.\d+\.\d+$/);
    expect(adminer.ports).toEqual(['127.0.0.1:8081:8080']);
    expect(adminer.environment.ADMINER_DEFAULT_SERVER).toBe('postgres');
  });
});
