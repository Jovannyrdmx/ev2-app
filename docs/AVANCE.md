# Bitácora de avance — EV2 Clandestinoz

Cada fila se agrega al terminar y verificar un paso del manual. Formato: fecha · paso · qué se hizo · verificación · commit/PR.

| Fecha | Paso | Qué se hizo | Verificación | Commit / PR |
|---|---|---|---|---|
| 2026-09-03 | — | Plan (`PLAN_IMPLEMENTACION_Y_DESARROLLO.md`) y manual (`MANUAL_IMPLEMENTACION_EV2.pdf`) creados. `CLAUDE.md` y esta bitácora creados. | Archivos presentes en la carpeta. | (sin git aún) |
| 2026-09-03 | 0.1 (parcial) | `.gitignore`, `AUTHORS.md`, `git init -b main`, autor Erick Lopez, primer commit `66d5e7f` (129 archivos). `.env` y `Thumbs.db` excluidos. | `git status` limpio · `git ls-files \| grep env` → solo `.env.example` · `git fsck` sin errores. Pendiente: remoto privado y push. | 66d5e7f (local) |
| 2026-09-03 | 0.1 (cierre) | Remoto `origin` = https://github.com/Jovannyrdmx/ev2-app.git; push de `main` realizado desde la computadora del desarrollador. | `git branch -vv` → `main [origin/main]` sincronizada en `bfef436`. **Paso 0.1 completo.** | bfef436 |
| 2026-09-03 | 0.2 | Reorganización a `server/ web/ mobile/ deploy/ docs/` con `git mv` (rama `fase0/reorganizar`, commit `253c35d`). `README.md` nuevo. Sin cambios de contenido en código. | `git status` limpio · 123 renombrados, 5 nuevos (README + 4 .gitkeep), 0 borrados, 0 modificados · `git log --follow` conserva historial · raíz solo con README, CLAUDE, AUTHORS, .gitignore, .env.example y carpetas. | 253c35d (rama fase0/reorganizar) |
| 2026-09-03 | 0.3 | `docs/DECISIONES.md` con 15 decisiones (qué, por qué, alternativas descartadas) y reglas absolutas; enlazado desde `README.md`. | Archivo existe y `grep DECISIONES README.md` lo muestra. | rama fase0/decisiones |

## Próximo paso

**0.4 — Corregir package.json e instalar dependencias** (3 h).
