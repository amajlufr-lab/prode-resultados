/**
 * Actualización automática de resultados del Mundial 2026.
 *
 * Filosofía (pensado para el plan de Firebase):
 *  - Lee de la API los partidos finalizados y rellena los que falten en la app.
 *  - Nunca cambia un partido ya finalizado (salvo corregir el marcador de un
 *    partido por PENALES, ver abajo).
 *  - Solo recalcula la tabla cuando de verdad hubo un cambio.
 *  - AVANCE DE ELIMINATORIA: en CADA corrida re-deriva quién pasó a la
 *    siguiente ronda a partir de TODOS los partidos ya finalizados. El
 *    ganador lo define la API (incluye penales).
 *  - PENALES: para ACERTAR cuenta el marcador de 90'+prórroga (SIN penales).
 *    La API devuelve en fullTime el marcador CON penales sumados, así que
 *    usamos regularTime + extraTime (el empate real). El ganador que pasa de
 *    ronda sí sale de score.winner (que incluye la tanda).
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

const KNOCKOUT_PHASES = ["Ronda de 32", "Octavos", "Cuartos", "Semifinal", "Tercer Puesto", "Final"];

const n = v => (v == null ? 0 : Number(v));

// Marcador que cuenta para ACERTAR: 90' + prórroga, SIN penales.
// - REGULAR / EXTRA_TIME: fullTime ya es correcto (no hay penales).
// - PENALTY_SHOOTOUT: fullTime trae los penales sumados -> usamos
//   regularTime + extraTime; si no vinieran, restamos penales del fullTime.
function scoringScore(score) {
  const ft = score.fullTime || {};
  if (score.duration === "PENALTY_SHOOTOUT") {
    const rt = score.regularTime, et = score.extraTime;
    if (rt || et) {
      return {
        home: n(rt && rt.home) + n(et && et.home),
        away: n(rt && rt.away) + n(et && et.away)
      };
    }
    const pen = score.penalties || {};
    return { home: n(ft.home) - n(pen.home), away: n(ft.away) - n(pen.away) };
  }
  return { home: n(ft.home), away: n(ft.away) };
}

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
  // OJO: el orden importa. "Semifinal" contiene "final", así que semi/cuartos/
  // tercer van ANTES que "final" (si no, las semis tomarían los puntos de la final).
  if (p.includes("tercer")) return { exact: 5, result: 3 };
  if (p.includes("semi") || p.includes("cuartos")) return { exact: 5, result: 3 };
  if (p.includes("final")) return { exact: 7, result: 4 };
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

// Índice API por pareja de equipos (normalizada, ordenada) con:
//  - winner/loser (nombres de la app; incluye penales)
//  - marcador de ACIERTO (90'+prórroga, sin penales) orientado por equipo.
function buildApiIndex(apiMatches) {
  const idx = {};
  for (const am of apiMatches) {
    const home = apiNameToApp(am.homeTeam?.name);
    const away = apiNameToApp(am.awayTeam?.name);
    if (!home || !away) continue;

    const cs = scoringScore(am.score || {});
    const w = am.score?.winner; // incluye penales
    const key = [norm(home), norm(away)].sort().join("|");

    idx[key] = {
      nHome: norm(home),
      scoreHome: cs.home,
      scoreAway: cs.away,
      winner: w === "HOME_TEAM" ? home : (w === "AWAY_TEAM" ? away : null),
      loser: w === "HOME_TEAM" ? away : (w === "AWAY_TEAM" ? home : null)
    };
  }
  return idx;
}

// =====================================================================
//  1) Cargar resultados de la API en los partidos pendientes
// =====================================================================
async function updateResults(apiIdx) {
  const snap = await db.collection("matches").where("status", "==", "scheduled").get();
  const pending = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  console.log("Partidos pendientes en la app:", pending.length);

  let updated = 0;

  for (const m of pending) {
    const key = [norm(m.teamA), norm(m.teamB)].sort().join("|");
    const api = apiIdx[key];
    if (!api) continue; // aún no jugado (o nombres con placeholder)

    const realA = norm(m.teamA) === api.nHome ? api.scoreHome : api.scoreAway;
    const realB = norm(m.teamA) === api.nHome ? api.scoreAway : api.scoreHome;

    await db.collection("matches").doc(m.id).update({
      realA, realB,
      status: "finished",
      autoUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    m.status = "finished"; m.realA = realA; m.realB = realB;
    console.log(`Actualizado: ${m.teamA} ${realA}-${realB} ${m.teamB} (${m.phase})`);
    updated++;
  }

  console.log(`Resultados nuevos: ${updated}`);
  return updated;
}

// =====================================================================
//  2) Corregir marcadores de PENALES ya guardados + avanzar eliminatoria
// =====================================================================
async function fixAndPropagate(apiIdx) {
  const koSnap = await db.collection("matches").where("phase", "in", KNOCKOUT_PHASES).get();
  const ko = koSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // 2a) Corregir marcadores mal guardados (penales incluidos) usando el
  //     marcador de acierto (90'+prórroga) de la API.
  let corrected = 0;
  for (const m of ko) {
    if (m.status !== "finished") continue;
    const key = [norm(m.teamA), norm(m.teamB)].sort().join("|");
    const api = apiIdx[key];
    if (!api) continue;

    const okA = norm(m.teamA) === api.nHome ? api.scoreHome : api.scoreAway;
    const okB = norm(m.teamA) === api.nHome ? api.scoreAway : api.scoreHome;

    if (Number(m.realA) !== okA || Number(m.realB) !== okB) {
      await db.collection("matches").doc(m.id).update({ realA: okA, realB: okB, autoUpdatedAt: admin.firestore.FieldValue.serverTimestamp() });
      console.log(`Corregido (penales): Partido ${m.matchNo} ${m.teamA} ${m.realA}-${m.realB} -> ${okA}-${okB} ${m.teamB}`);
      m.realA = okA; m.realB = okB;
      corrected++;
    }
  }

  // 2b) Ganador/perdedor de cada partido KO finalizado (para llenar la ronda
  //     siguiente). El ganador sale de la API (incluye penales); si no está
  //     en la API pero el marcador es decisivo, usa el marcador.
  const decided = {};
  for (const m of ko) {
    if (m.status !== "finished" || m.matchNo == null) continue;
    const key = [norm(m.teamA), norm(m.teamB)].sort().join("|");
    const api = apiIdx[key];

    if (api && api.winner) {
      decided[m.matchNo] = { winner: api.winner, loser: api.loser };
    } else if (m.realA != null && m.realB != null && Number(m.realA) !== Number(m.realB)) {
      decided[m.matchNo] = Number(m.realA) > Number(m.realB)
        ? { winner: m.teamA, loser: m.teamB }
        : { winner: m.teamB, loser: m.teamA };
    } else if (m.realA != null && Number(m.realA) === Number(m.realB)) {
      console.warn(`Partido ${m.matchNo} (${m.teamA} vs ${m.teamB}) empatado y sin ganador en la API; no se propaga aún.`);
    }
  }

  // 2c) Rellenar "Ganador/Perdedor Partido X", encadenando rondas.
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

  console.log(`Marcadores corregidos: ${corrected}, equipos avanzados: ${advanced}`);
  return corrected;
}

// =====================================================================
//  3) Recalcular la tabla
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

    const apiIdx = buildApiIndex(apiMatches);

    const updated = await updateResults(apiIdx);
    const corrected = await fixAndPropagate(apiIdx);

    // Recalcula si hubo cambios, o SIEMPRE cuando se ejecuta a mano
    // ("Run workflow") — así sirve de botón para reprocesar la tabla
    // después de un cambio en la fórmula de puntos.
    const forceRecalc = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
    if (updated > 0 || corrected > 0 || forceRecalc) {
      await recalcScores();
    } else {
      console.log("Sin cambios de marcador; no se recalcula (ahorra cuota).");
    }
    console.log("Listo.");
    process.exit(0);
  } catch (e) {
    console.error("ERROR:", e.message);
    process.exit(1);
  }
})();
