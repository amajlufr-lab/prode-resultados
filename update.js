/**
 * Actualización automática de resultados del Mundial 2026.
 *
 * Filosofía (pensado para el plan GRATIS de Firebase):
 *  - En cada corrida lee SOLO los partidos que aún NO están finalizados.
 *  - Nunca toca un partido ya finalizado (ni los que cargas a mano).
 *  - Solo recalcula la tabla cuando de verdad entró un resultado nuevo.
 *
 * El admin puede seguir cargando/corrigiendo resultados a mano en la app;
 * este proceso solo rellena los que faltan.
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

// =====================================================================
//  LÓGICA DE PUNTOS  (copia EXACTA de tu app index.html)
//  Si cambias las reglas de puntaje en la app, cópialas también aquí.
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

  if (specialResults.championTeam && specialPred.championTeam && specialResults.championTeam === specialPred.championTeam) {
    special += 10; // campeón = 10 pts fijos
  }
  if (specialResults.topScorer && specialPred.topScorer && specialResults.topScorer === specialPred.topScorer) {
    special += 10;
  }
  if (specialResults.bestAssister && specialPred.bestAssister && specialResults.bestAssister === specialPred.bestAssister) {
    special += 10;
  }

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
//  1) Traer resultados de la API y actualizar SOLO partidos pendientes
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
  const a = new Date(isoA);
  const dayA = a.toISOString().slice(0, 10);
  const dayB = String(naiveB || "").slice(0, 10);
  return dayA === dayB;
}

async function updateResults() {
  const apiMatches = await fetchFinishedMatches();
  console.log("Partidos finalizados en la API:", apiMatches.length);

  // LECTURA LIGERA: solo los partidos que aún NO están finalizados.
  // Nunca leemos ni tocamos los que ya tienen resultado (manuales o automáticos).
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
      console.warn("SIN EQUIVALENCIA:", am.homeTeam?.name, "vs", am.awayTeam?.name, "(agrégalos en teams.js si hace falta)");
      unmatched++;
      continue;
    }

    const nH = norm(homeApp), nA = norm(awayApp);
    let candidates = pending.filter(m => {
      const a = norm(m.teamA), b = norm(m.teamB);
      return (a === nH && b === nA) || (a === nA && b === nH);
    });
    // Si no está entre los pendientes, ya estaba finalizado: NO se toca.
    if (candidates.length === 0) continue;
    if (candidates.length > 1) {
      const byDay = candidates.filter(m => sameDay(am.utcDate, m.date));
      if (byDay.length) candidates = byDay;
    }
    const target = candidates[0];

    let realA, realB;
    if (norm(target.teamA) === nH) { realA = ftHome; realB = ftAway; }
    else { realA = ftAway; realB = ftHome; }

    await db.collection("matches").doc(target.id).update({
      realA: realA,
      realB: realB,
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
//  2) Recalcular la tabla  (SOLO cuando entró un resultado nuevo)
//     Igual que el botón "Recalcular tabla general" de tu app.
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
    const updated = await updateResults();
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
