/**
 * Actualización automática de resultados del Mundial 2026.
 *
 * Filosofía (pensado para el plan de Firebase):
 *  - Lee de la API los partidos finalizados y rellena los que falten en la app.
 *  - Nunca cambia un partido ya finalizado (ni los que cargas a mano).
 *  - Solo recalcula la tabla cuando de verdad entró un resultado nuevo.
 *  - AVANCE DE ELIMINATORIA: en CADA corrida re-deriva quién pasó a la
 *    siguiente ronda a partir de TODOS los partidos de eliminatoria ya
 *    finalizados (da igual si el resultado lo cargaste a mano o entró
 *    automático). El ganador lo define la API (incluye penales); si el
 *    partido no está en la API pero tiene marcador decisivo, usa el marcador.
 */

const admin = require("firebase-admin");
const { apiNameToApp, norm } = require("./teams");

// ---------- Credenciales ----------
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  serviceAccount = require("./serviceAccountKey.json");
}

const FOOTBALL_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
if (!FOOTBALL_TOKEN) {
  console.error("Falta FOOTBALL_DATA_TOKEN");
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// Fases de eliminatoria, tal como aparecen en el fixture de la app.
const KNOCKOUT_PHASES = ["Ronda de 32", "Octavos", "Cuartos", "Semifinal", "Tercer Puesto", "Final"];

// =====================================================================
//  LÓGICA DE PUNTOS  (copia EXACTA de tu app index.html)
// =====================================================================
function getResult(a, b) {
  if (Number(a) > Number(b)) return "A";
  if (Number(b) > Number(a)) return "B";
  return "E";
}

function getPhasePoints(phase) {
  const p = String(phase || "").toLowerCase();
  if (p.includes("final")) return { exact: 7, result: 4 };
  if (p.includes("tercer")) return { exact: 5, result: 3 };
  if (p.includes("semi") || p.includes("cuartos")) return { exact: 5, result: 3 };
  if (p.includes("octavos") || p.includes("ronda de 32")) return { exact: 4, result: 2 };
  return { exact: 3, result: 1 };
}

function calcScoreFromData(userId, predictionsSource, specialPredictionsSource, matchesSource, specialResultsSource) {
  let matchPts = 0, exact = 0, result = 0, played = 0, predicted = 0;

  matchesSource.forEach(m => {
    const pred = predictionsSource.find(p => p.matchId === m.id && p.userId === userId);
    if (pred && pred.home !== "" && pred.away !== "" && pred.home !== undefined && pred.away !== undefined) predicted++;
    if (m.realA === null || m.realB === null || m.realA === undefined || m.realB === undefined) return;
    played++;
    if (!pred || pred.home === "" || pred.away === "" || pred.home === undefined || pred.away === undefined) return;

    const pA = Number(pred.home);
    const pB = Number(pred.away);
    const rA = Number(m.realA);
    const rB = Number(m.realB);
    const phasePts = getPhasePoints(m.phase);

    if (pA === rA && pB === rB) {
      matchPts += phasePts.exact;
      exact++;
    } else if (getResult(pA, pB) === getResult(rA, rB)) {
      matchPts += phasePts.result;
      result++;
    }
  });

  const specialPred = specialPredictionsSource.find(p => p.userId === userId) || {};
  const specialResults = specialResultsSource || {};
  let special = 0;

  if (specialResults.championTeam && specialPred.championTeam && specialResults.championTeam === specialPred.championTeam) special += 10;
  if (specialResults.topScorer && specialPred.topScorer && specialResults.topScorer === specialPred.topScorer) special += 10;
  if (specialResults.bestAssister && specialPred.bestAssister && specialResults.bestAssister === specialPred.bestAssister) special += 10;

  const championStatus = specialPred.championTeam ? "Completado" : "Pendiente";
  const topScorerStatus = specialPred.topScorer ? "Completado" : "Pendiente";
  const bestAssisterStatus = specialPred.bestAssister ? "Completado" : "Pendiente";
  const specialPicksCompleted = [specialPred.championTeam, specialPred.topScorer, specialPred.bestAssister].filter(Boolean).length;

  return {
    pts: matchPts + special,
    matchPts, special, exact, result, played, predicted,
    championStatus, topScorerStatus, bestAssisterStatus, specialPicksCompleted
  };
}

// =====================================================================
//  API
// =====================================================================
async function fetchFinishedMatches() {
  const res = await fetch("https://api.football-data.org/v4/competitions/WC/matches?status=FINISHED", {
    headers: { "X-Auth-Token": FOOTBALL_TOKEN }
  });
  if (!res.ok) {
    throw new Error("API football-data respondió " + res.status + " " + (await res.text()).slice(0, 200));
  }
  const data = await res.json();
  return data.matches || [];
}

function sameDay(isoA, naiveB) {
  const dayA = new Date(isoA).toISOString().slice(0, 10);
  const dayB = String(naiveB || "").slice(0, 10);
  return dayA === dayB;
}

// Índice API: pareja de equipos (normalizada, ordenada) -> { winner, loser }
// en nombres de la app. El ganador ya contempla penales (score.winner).
function buildApiWinnerIndex(apiMatches) {
  const idx = {};
  for (const am of apiMatches) {
    const w = am.score?.winner; // "HOME_TEAM" | "AWAY_TEAM" | "DRAW"
    const home = apiNameToApp(am.homeTeam?.name);
    const away = apiNameToApp(am.awayTeam?.name);
    if (!home || !away) continue;
    const key = [norm(home), norm(away)].sort().join("|");
    if (w === "HOME_TEAM") idx[key] = { winner: home, loser: away };
    else if (w === "AWAY_TEAM") idx[key] = { winner: away, loser: home };
    // DRAW en grupos no define ganador; en eliminatoria la API pone HOME/AWAY.
  }
  return idx;
}

// =====================================================================
//  1) Cargar resultados de la API en los partidos pendientes
// =====================================================================
async function updateResults(apiMatches) {
  // LECTURA LIGERA: solo los partidos que aún NO están finalizados.
  const snap = await db.collection("matches").where("status", "==", "scheduled").get();
  const pending = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  console.log("Partidos pendientes en la app:", pending.length);

  let updated = 0, unmatched = 0;

  for (const am of apiMatches) {
    const ftHome = am.score?.fullTime?.home;
    const ftAway = am.score?.fullTime?.away;
    if (ftHome === null || ftHome === undefined || ftAway === null || ftAway === undefined) continue;

    const homeApp = apiNameToApp(am.homeTeam?.name);
    const awayApp = apiNameToApp(am.awayTeam?.name);
    if (!homeApp || !awayApp) {
      console.warn("SIN EQUIVALENCIA:", am.homeTeam?.name, "vs", am.awayTeam?.name, "(agrégalos en teams.js)");
      unmatched++;
      continue;
    }

    const nH = norm(homeApp), nA = norm(awayApp);
    let candidates = pending.filter(m => {
      const a = norm(m.teamA), b = norm(m.teamB);
      return (a === nH && b === nA) || (a === nA && b === nH);
    });
    if (candidates.length === 0) continue; // ya finalizado: no se toca
    if (candidates.length > 1) {
      const byDay = candidates.filter(m => sameDay(am.utcDate, m.date));
      if (byDay.length) candidates = byDay;
    }
    const target = candidates[0];

    let realA, realB;
    if (norm(target.teamA) === nH) { realA = ftHome; realB = ftAway; }
    else { realA = ftAway; realB = ftHome; }

    await db.collection("matches").doc(target.id).update({
      realA, realB,
      status: "finished",
      autoUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log(`Actualizado: ${target.teamA} ${realA}-${realB} ${target.teamB} (${target.phase})`);
    updated++;
  }

  console.log(`Resultados nuevos: ${updated}, sin emparejar: ${unmatched}`);
  return updated;
}

// =====================================================================
//  2) Avance de eliminatoria (robusto, se re-deriva en cada corrida)
// =====================================================================
async function propagateBracket(apiMatches) {
  const apiIdx = buildApiWinnerIndex(apiMatches);

  // Leemos SOLO los partidos de eliminatoria (~32 docs).
  const koSnap = await db.collection("matches").where("phase", "in", KNOCKOUT_PHASES).get();
  const ko = koSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // Ganador/perdedor (en nombres de la app) de cada partido KO ya finalizado.
  const decided = {}; // matchNo -> { winner, loser }
  for (const m of ko) {
    if (m.status !== "finished" || m.matchNo == null) continue;
    if (m.realA == null || m.realB == null) continue;

    const key = [norm(m.teamA), norm(m.teamB)].sort().join("|");
    let res = apiIdx[key];

    if (!res) {
      // No está (o no se pudo emparejar) en la API: usar el marcador si es decisivo.
      if (Number(m.realA) !== Number(m.realB)) {
        res = Number(m.realA) > Number(m.realB)
          ? { winner: m.teamA, loser: m.teamB }
          : { winner: m.teamB, loser: m.teamA };
      } else {
        console.warn(`Partido ${m.matchNo} (${m.teamA} vs ${m.teamB}) empatado y sin ganador en la API; no se propaga aún.`);
        continue;
      }
    }
    decided[m.matchNo] = res;
  }

  // Rellenar los "Ganador/Perdedor Partido X", encadenando rondas.
  let advanced = 0, changed = true, guard = 0;
  while (changed && guard++ < 10) {
    changed = false;
    for (const m of ko) {
      const patch = {};
      for (const field of ["teamA", "teamB"]) {
        const val = String(m[field] || "");
        let mm = /^Ganador Partido (\d+)$/.exec(val);
        if (mm && decided[mm[1]]) { patch[field] = decided[mm[1]].winner; continue; }
        mm = /^Perdedor Partido (\d+)$/.exec(val);
        if (mm && decided[mm[1]]) { patch[field] = decided[mm[1]].loser; }
      }
      if (Object.keys(patch).length) {
        await db.collection("matches").doc(m.id).update(patch);
        Object.assign(m, patch);
        console.log(`Avanza -> Partido ${m.matchNo}: ${m.teamA} vs ${m.teamB}`);
        advanced += Object.keys(patch).length;
        changed = true;
      }
    }
  }

  console.log(`Equipos avanzados: ${advanced}`);
  return advanced;
}

// =====================================================================
//  3) Recalcular la tabla (solo si hubo resultado nuevo)
// =====================================================================
async function recalcScores() {
  const [predSnap, specialSnap, userSnap, scoresSnap, specialResDoc, matchesSnap] = await Promise.all([
    db.collection("predictions").get(),
    db.collection("specialPredictions").get(),
    db.collection("users").get(),
    db.collection("userScores").get(),
    db.collection("config").doc("specialResults").get(),
    db.collection("matches").get()
  ]);

  const allPredictions = predSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const allSpecialPredictions = specialSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const allUsers = userSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(u => u.role !== "admin");
  const existingScores = scoresSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const specialResults = specialResDoc.exists ? specialResDoc.data() : {};
  const allMatches = matchesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const batch = db.batch();
  allUsers.forEach(user => {
    const score = calcScoreFromData(user.id, allPredictions, allSpecialPredictions, allMatches, specialResults);
    const prev = existingScores.find(s => s.userId === user.id || s.id === user.id) || {};
    batch.set(db.collection("userScores").doc(user.id), {
      userId: user.id,
      username: user.username || "",
      name: user.name || "",
      role: user.role || "player",
      ...score,
      manualAdjustment: Number(prev.manualAdjustment || 0),
      manualReason: prev.manualReason || "",
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  });
  await batch.commit();
  console.log("Tabla recalculada para", allUsers.length, "jugadores.");
}

// =====================================================================
(async () => {
  try {
    const apiMatches = await fetchFinishedMatches();
    console.log("Partidos finalizados en la API:", apiMatches.length);

    const updated = await updateResults(apiMatches);

    // El avance se re-deriva SIEMPRE (así también propaga resultados que
    // cargaste a mano en la app, no solo los que entran por la API).
    await propagateBracket(apiMatches);

    if (updated > 0) {
      await recalcScores();
    } else {
      console.log("Sin resultados nuevos; no se recalcula (ahorra cuota).");
    }
    console.log("Listo.");
    process.exit(0);
  } catch (e) {
    console.error("ERROR:", e.message);
    process.exit(1);
  }
})();
