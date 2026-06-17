// Equivalencia de nombres de selección entre la API (football-data.org)
// y los nombres usados en tu app (campos teamA / teamB).
//
// Si algún día ves en los logs "SIN EQUIVALENCIA: <nombre>", agrega ese
// nombre aquí en ALIASES apuntando al nombre EXACTO que usa tu app.

// Las 48 selecciones reales tal como aparecen en tu app.
const APP_TEAMS = [
  "Algeria", "Argentina", "Australia", "Austria", "Belgium",
  "Bosnia & Herzegovina", "Brazil", "Canada", "Cape Verde", "Colombia",
  "Croatia", "Curaçao", "Czechia", "DR Congo", "Ecuador", "Egypt",
  "England", "France", "Germany", "Ghana", "Haiti", "Iran", "Iraq",
  "Ivory Coast", "Japan", "Jordan", "Mexico", "Morocco", "Netherlands",
  "New Zealand", "Norway", "Panama", "Paraguay", "Portugal", "Qatar",
  "Saudi Arabia", "Scotland", "Senegal", "South Africa", "South Korea",
  "Spain", "Sweden", "Switzerland", "Tunisia", "Türkiye", "USA",
  "Uruguay", "Uzbekistan"
];

// Normaliza un nombre: sin acentos, minúsculas, sin símbolos.
// "Bosnia & Herzegovina" -> "bosniaandherzegovina"
function norm(s) {
  return String(s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "");
}

// Variantes de la API que NO coinciden por normalización directa.
// clave: nombre normalizado que da la API  ->  valor: nombre EXACTO en tu app.
const ALIASES = {
  "korearepublic": "South Korea",
  "republicofkorea": "South Korea",
  "unitedstates": "USA",
  "usmnt": "USA",
  "bosniaherzegovina": "Bosnia & Herzegovina",
  "bosniaandherzegovina": "Bosnia & Herzegovina",
  "cotedivoire": "Ivory Coast",
  "ivorycoast": "Ivory Coast",
  "turkey": "Türkiye",
  "turkiye": "Türkiye",
  "caboverde": "Cape Verde",
  "capeverde": "Cape Verde",
  "congodr": "DR Congo",
  "drcongo": "DR Congo",
  "democraticrepublicofthecongo": "DR Congo",
  "democraticrepublicofcongo": "DR Congo",
  "curacao": "Curaçao",
  "iriran": "Iran",
  "iran": "Iran",
  "czechrepublic": "Czechia",
  "czechia": "Czechia"
};

// Índice de nombres de la app por su forma normalizada.
const APP_BY_NORM = {};
APP_TEAMS.forEach(t => { APP_BY_NORM[norm(t)] = t; });

// Dado un nombre que viene de la API, devuelve el nombre canónico de tu app
// (o null si no se reconoce).
function apiNameToApp(apiName) {
  const n = norm(apiName);
  if (ALIASES[n]) return ALIASES[n];
  if (APP_BY_NORM[n]) return APP_BY_NORM[n];
  return null;
}

module.exports = { APP_TEAMS, norm, apiNameToApp };
