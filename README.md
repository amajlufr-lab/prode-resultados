# Actualización automática de resultados — Mundial OSL 2026

Este proceso consulta los partidos finalizados del Mundial 2026, escribe el
resultado en tu Firestore (`realA`, `realB`, `status:'finished'`) y recalcula la
tabla general **igual que el botón "Recalcular tabla general"** de tu app.

Corre solo cada ~10 minutos con GitHub Actions. No toca tu app ni las reglas.

---

## Qué hace cada archivo

- `update.js` — el proceso principal.
- `teams.js` — equivalencia de nombres de selección API ↔ app.
- `.github/workflows/update.yml` — el cron de GitHub Actions (cada 10 min).
- `package.json` — dependencias (firebase-admin).

---

## Instalación (una sola vez)

### 1. Token gratis de la API
1. Entra a https://www.football-data.org/client/register y regístrate (gratis).
2. Te llega un **API token** por correo. Guárdalo.

### 2. Crear el repositorio en GitHub
Sube **el contenido de esta carpeta** (`auto-resultados`) a un repositorio nuevo
en GitHub. Recomendado: repositorio **público** (así GitHub Actions es gratis e
ilimitado; el código no tiene nada sensible, las claves van en "secrets").

> NUNCA subas `serviceAccountKey.json` — el `.gitignore` ya lo evita.

### 3. Agregar los dos secrets
En tu repo: **Settings → Secrets and variables → Actions → New repository secret**.
Crea estos dos:

| Nombre del secret | Valor |
|---|---|
| `FOOTBALL_DATA_TOKEN` | el token de football-data.org |
| `FIREBASE_SERVICE_ACCOUNT` | **todo el contenido** del archivo `serviceAccountKey.json` (el JSON completo) |

### 4. Probar
En tu repo, pestaña **Actions → "Actualizar resultados Mundial" → Run workflow**.
Mira el log: debe decir cuántos partidos actualizó y "Tabla recalculada".

A partir de ahí corre solo cada ~10 minutos.

---

## Probarlo en tu computadora (opcional)

```bash
cd auto-resultados
npm install
# coloca aquí tu serviceAccountKey.json
export FOOTBALL_DATA_TOKEN="tu_token"
node update.js
```

---

## Notas importantes

- **Nombres de equipos:** si en el log aparece `SIN EQUIVALENCIA: <nombre>`,
  agrega ese nombre en `teams.js` (en `ALIASES`) apuntando al nombre exacto que
  usa tu app.
- **Eliminatorias:** los partidos con marcador tipo "1° Grupo A" o
  "Ganador Partido 73" se emparejan solos cuando tú pongas las selecciones reales
  en esos partidos.
- **Penales:** para partidos de eliminación que se definen por penales, la API
  da el marcador del tiempo reglamentario/alargue. Si tu reglamento puntúa de otra
  forma, revisa esos casos a mano.
- **Reglas de puntaje:** `update.js` tiene una copia de la fórmula de tu app. Si
  algún día cambias los puntos en `index.html` (función `getPhasePoints` o
  `calcScoreFromData`), copia el cambio también aquí.
