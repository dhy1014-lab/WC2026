import { useState, useEffect, useCallback, useRef } from "react";

// ── FIREBASE CONFIG ───────────────────────────────────────────────────────────
const DB_URL = "https://wc2026-306ec-default-rtdb.firebaseio.com";

async function dbLoad() {
  const r = await fetch(`${DB_URL}/pool.json`);
  if (!r.ok) throw new Error(`Firebase error ${r.status}`);
  const data = await r.json();
  if (!data) return { players: [], predictions: {}, paid: {}, settings: { entryFee: 25, commCut: 20, p1Split: 50, payouts1: [60,25,10,5,0], payouts2: [60,25,10,5,0] } };
  return {
    players: data.players || [],
    predictions: data.predictions || {},
    paid: data.paid || {},
    settings: data.settings || { entryFee: 25, commCut: 20, p1Split: 50, payouts1: [60,25,10,5,0], payouts2: [60,25,10,5,0] },
  };
}

async function dbSave(players, predictions, paid, settings) {
  const r = await fetch(`${DB_URL}/pool.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ players, predictions, paid, settings }),
  });
  if (!r.ok) throw new Error(`Firebase save error ${r.status}`);
}

// ── MESSAGE BOARD HELPERS ────────────────────────────────────────────────────
async function loadMessages() {
  const r = await fetch(`${DB_URL}/messages.json`);
  if (!r.ok) return [];
  const data = await r.json();
  if (!data) return [];
  return Object.entries(data)
    .map(([id, msg]) => ({ id, ...msg }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

async function postMessage(author, text, isAdmin, pinned = false) {
  const msg = { author, text, timestamp: Date.now(), isAdmin: isAdmin || false, pinned: pinned || false };
  await fetch(`${DB_URL}/messages.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(msg),
  });
}

async function deleteMessage(id) {
  await fetch(`${DB_URL}/messages/${id}.json`, { method: "DELETE" });
}

// ── REACTIONS ────────────────────────────────────────────────────────────────
async function loadReactions() {
  const r = await fetch(`${DB_URL}/reactions.json`);
  if (!r.ok) return {};
  const data = await r.json();
  return data || {};
}

async function toggleReaction(msgId, emoji, playerName) {
  const emojiKey = encodeURIComponent(emoji);
  const r = await fetch(`${DB_URL}/reactions/${msgId}/${emojiKey}/${playerName}.json`);
  const existing = await r.json();
  if (existing) {
    await fetch(`${DB_URL}/reactions/${msgId}/${emojiKey}/${playerName}.json`, { method: "DELETE" });
  } else {
    await fetch(`${DB_URL}/reactions/${msgId}/${emojiKey}/${playerName}.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(true),
    });
  }
}

// ── HOT TAKES ────────────────────────────────────────────────────────────────
// ── AUTH HELPERS ─────────────────────────────────────────────────────────────
const ADMIN = { name: "admin", password: "admin" };
const SITE_PASSWORD = "powerwc";

function hashPassword(pw) {
  // Simple deterministic hash — not cryptographic but fine for a fun pool
  let h = 0;
  for (let i = 0; i < pw.length; i++) { h = Math.imul(31, h) + pw.charCodeAt(i) | 0; }
  return h.toString(36);
}

// ── GROUPS ────────────────────────────────────────────────────────────────────
const TEAMS_BY_GROUP = {
  A: ["Mexico", "South Africa", "South Korea", "Czechia"],
  B: ["Canada", "Bosnia and Herzegovina", "Qatar", "Switzerland"],
  C: ["Brazil", "Morocco", "Haiti", "Scotland"],
  D: ["USA", "Paraguay", "Australia", "Turkey"],
  E: ["Germany", "Curacao", "Ivory Coast", "Ecuador"],
  F: ["Netherlands", "Japan", "Sweden", "Tunisia"],
  G: ["Belgium", "Egypt", "Iran", "New Zealand"],
  H: ["Spain", "Cape Verde", "Saudi Arabia", "Uruguay"],
  I: ["France", "Senegal", "Iraq", "Norway"],
  J: ["Argentina", "Algeria", "Austria", "Jordan"],
  K: ["Portugal", "DR Congo", "Uzbekistan", "Colombia"],
  L: ["England", "Croatia", "Ghana", "Panama"],
};

// Strip any saved group rankings that contain teams not in our current groups
function sanitizeGroupRankings(groupRankings) {
  if (!groupRankings) return {};
  const clean = {};
  Object.entries(groupRankings).forEach(([g, ranking]) => {
    const validTeams = TEAMS_BY_GROUP[g];
    if (!validTeams || !Array.isArray(ranking)) return;
    if (ranking.every(t => validTeams.includes(t))) {
      clean[g] = ranking;
    }
    // else discard — stale data with wrong teams
  });
  return clean;
}

const FLAG = {
  "Mexico":"🇲🇽","South Africa":"🇿🇦","South Korea":"🇰🇷","Czechia":"🇨🇿","Czech Republic":"🇨🇿",
  "Canada":"🇨🇦","Bosnia and Herzegovina":"🇧🇦","Qatar":"🇶🇦","Switzerland":"🇨🇭",
  "Brazil":"🇧🇷","Morocco":"🇲🇦","Haiti":"🇭🇹","Scotland":"🏴󠁧󠁢󠁳󠁣󠁴󠁿",
  "USA":"🇺🇸","Paraguay":"🇵🇾","Australia":"🇦🇺","Turkey":"🇹🇷",
  "Germany":"🇩🇪","Curacao":"🇨🇼","Ecuador":"🇪🇨","Ivory Coast":"🇨🇮",
  "England":"🏴󠁧󠁢󠁥󠁮󠁧󠁿","Panama":"🇵🇦","Croatia":"🇭🇷","Ghana":"🇬🇭",
  "Belgium":"🇧🇪","New Zealand":"🇳🇿","Egypt":"🇪🇬","Iran":"🇮🇷",
  "Spain":"🇪🇸","Uruguay":"🇺🇾","Saudi Arabia":"🇸🇦","Cape Verde":"🇨🇻",
  "France":"🇫🇷","Senegal":"🇸🇳","Iraq":"🇮🇶","Norway":"🇳🇴",
  "Argentina":"🇦🇷","Algeria":"🇩🇿","Austria":"🇦🇹","Jordan":"🇯🇴",
  "Portugal":"🇵🇹","DR Congo":"🇨🇩","Uzbekistan":"🇺🇿","Colombia":"🇨🇴",
  "Netherlands":"🇳🇱","Sweden":"🇸🇪","Japan":"🇯🇵","Tunisia":"🇹🇳",
};
// Country code map for flagcdn.com (Edge-compatible)
const COUNTRY_CODE = {
  "Mexico":"mx","South Africa":"za","South Korea":"kr","Czechia":"cz","Czech Republic":"cz",
  "Canada":"ca","Bosnia and Herzegovina":"ba","Qatar":"qa","Switzerland":"ch",
  "Brazil":"br","Morocco":"ma","Haiti":"ht","Scotland":"gb-sct",
  "USA":"us","Paraguay":"py","Australia":"au","Turkey":"tr",
  "Germany":"de","Curacao":"cw","Ecuador":"ec","Ivory Coast":"ci",
  "England":"gb-eng","Panama":"pa","Croatia":"hr","Ghana":"gh",
  "Belgium":"be","New Zealand":"nz","Egypt":"eg","Iran":"ir",
  "Spain":"es","Uruguay":"uy","Saudi Arabia":"sa","Cape Verde":"cv",
  "France":"fr","Senegal":"sn","Iraq":"iq","Norway":"no",
  "Argentina":"ar","Algeria":"dz","Austria":"at","Jordan":"jo",
  "Portugal":"pt","DR Congo":"cd","Uzbekistan":"uz","Colombia":"co",
  "Netherlands":"nl","Sweden":"se","Japan":"jp","Tunisia":"tn",
};

const tf = t => {
  const code = COUNTRY_CODE[t];
  if (!code) return <span>🏳️</span>;
  return <img src={`https://flagcdn.com/24x18/${code}.png`} alt={t} style={{ width:24, height:18, objectFit:"cover", borderRadius:2, verticalAlign:"middle" }} />;
};

// ── DAILY PROPS (Jun 11–27, 2 per day = 34 total) ────────────────────────────
// ptsYes = points if you picked YES and YES wins
// ptsNo  = points if you picked NO  and NO  wins
// Every prop sums to 10 pts across the two sides
const DAILY_PROPS = [
  // Jun 11
  { date:"Jun 11", label:"Day 1 – Prop A", q:"Will Mexico keep a clean sheet vs South Africa?",                              ptsYes:6, ptsNo:4, yes:"Clean sheet! Mexico don't concede",      no:"South Africa get on the scoresheet" },
  { date:"Jun 11", label:"Day 1 – Prop B", q:"Will South Korea vs Czechia produce 3+ total goals?",                          ptsYes:5, ptsNo:5, yes:"Goal fest — 3 or more!",                  no:"Low-scoring affair" },
  // Jun 12
  { date:"Jun 12", label:"Day 2 – Prop A", q:"Will the USA score in the first half vs Paraguay?",                            ptsYes:4, ptsNo:6, yes:"USA on the board before half",             no:"USA scoreless at the break" },
  { date:"Jun 12", label:"Day 2 – Prop B", q:"Will Canada win their opening match vs Bosnia & Herzegovina?",                 ptsYes:4, ptsNo:6, yes:"Canada take all 3 points",               no:"Draw or Bosnia win" },
  // Jun 13
  { date:"Jun 13", label:"Day 3 – Prop A", q:"Will Brazil score 3+ goals vs Morocco?",                                       ptsYes:6, ptsNo:4, yes:"Brazil put on a show",                    no:"Morocco keep it tight" },
  { date:"Jun 13", label:"Day 3 – Prop B", q:"Will there be a red card in any Day 3 match?",                                 ptsYes:7, ptsNo:3, yes:"Someone sees red",                        no:"All 11 stay on" },
  // Jun 14
  { date:"Jun 14", label:"Day 4 – Prop A", q:"Will Germany win by 3+ goals vs Curacao?",                                    ptsYes:6, ptsNo:4, yes:"Germany run riot",                         no:"Curacao keep it respectable" },
  { date:"Jun 14", label:"Day 4 – Prop B", q:"Will Netherlands vs Japan end in a draw?",                                    ptsYes:8, ptsNo:2, yes:"Stalemate in the group",                   no:"One side comes out on top" },
  // Jun 15
  { date:"Jun 15", label:"Day 5 – Prop A", q:"Will France score before the 21st minute vs Senegal?",                        ptsYes:6, ptsNo:4, yes:"Les Bleus strike early",                   no:"Senegal keep it scoreless past 20'" },
  { date:"Jun 15", label:"Day 5 – Prop B", q:"Will Saudi Arabia beat Uruguay?",                                             ptsYes:9, ptsNo:1, yes:"Saudi Arabia shock result!",              no:"Uruguay win or draw" },
  // Jun 16
  { date:"Jun 16", label:"Day 6 – Prop A", q:"Will Argentina keep a clean sheet vs Algeria?",                               ptsYes:5, ptsNo:5, yes:"Argentina lock it down",                  no:"Algeria get on the board" },
  { date:"Jun 16", label:"Day 6 – Prop B", q:"Will a penalty be awarded in Argentina/Algeria or Austria/Jordan?",           ptsYes:6, ptsNo:4, yes:"Spot kick awarded in at least one game", no:"No penalties in either match" },
  // Jun 17
  { date:"Jun 17", label:"Day 7 – Prop A", q:"Will Cristiano Ronaldo score vs DR Congo?",                                   ptsYes:4, ptsNo:6, yes:"CR7 on the scoresheet",                   no:"Ronaldo blanks" },
  { date:"Jun 17", label:"Day 7 – Prop B", q:"Will England vs Croatia produce fewer than 2 total goals?",                  ptsYes:7, ptsNo:3, yes:"Tight affair — 0 or 1 total goals",        no:"2 or more goals in the match" },
  // Jun 18
  { date:"Jun 18", label:"Day 8 – Prop A", q:"Will Mexico beat South Korea?",                                               ptsYes:4, ptsNo:6, yes:"Mexico take the win",                     no:"South Korea win or draw" },
  { date:"Jun 18", label:"Day 8 – Prop B", q:"Will Brazil beat Haiti by 4+ goals?",                                        ptsYes:7, ptsNo:3, yes:"Brazil demolish Haiti",                   no:"Haiti keep it under 4" },
  // Jun 19
  { date:"Jun 19", label:"Day 9 – Prop A", q:"Will the USA beat Turkey?",                                                  ptsYes:5, ptsNo:5, yes:"USA take all 3",                           no:"Turkey win or draw" },
  { date:"Jun 19", label:"Day 9 – Prop B", q:"Will Turkey score vs the USA?",                                              ptsYes:4, ptsNo:6, yes:"Turkey get on the board",                 no:"USA keep a clean sheet" },
  // Jun 20
  { date:"Jun 20", label:"Day 10 – Prop A", q:"Will a goal be scored after the 80th minute in any Day 10 match?",          ptsYes:3, ptsNo:7, yes:"Late drama somewhere!",                   no:"All goals before the 80th minute" },
  { date:"Jun 20", label:"Day 10 – Prop B", q:"Will Ecuador get a result (win or draw) vs Germany?",                       ptsYes:7, ptsNo:3, yes:"Ecuador hold their own",                  no:"Germany win" },
  // Jun 21
  { date:"Jun 21", label:"Day 11 – Prop A", q:"Will Spain score 2+ goals vs Saudi Arabia?",                                ptsYes:3, ptsNo:7, yes:"Spain put two or more past Saudi Arabia", no:"Saudi Arabia hold Spain to under 2" },
  { date:"Jun 21", label:"Day 11 – Prop B", q:"Will Belgium beat Egypt?",                                                  ptsYes:3, ptsNo:7, yes:"Belgium take the win",                    no:"Egypt win or draw" },
  // Jun 22
  { date:"Jun 22", label:"Day 12 – Prop A", q:"Will Argentina beat Austria without conceding?",                            ptsYes:6, ptsNo:4, yes:"Argentina clean sheet win",               no:"Austria score or Argentina don't win" },
  { date:"Jun 22", label:"Day 12 – Prop B", q:"Will France vs Iraq produce 4+ total goals?",                               ptsYes:4, ptsNo:6, yes:"4 or more goals — entertaining stuff",  no:"Under 4 goals" },
  // Jun 23
  { date:"Jun 23", label:"Day 13 – Prop A", q:"Will Portugal beat Uzbekistan by 2+ goals?",                               ptsYes:3, ptsNo:7, yes:"Portugal comfortable win",               no:"Uzbekistan keep it within 1" },
  { date:"Jun 23", label:"Day 13 – Prop B", q:"Will England vs Ghana see both teams receive a yellow card?",               ptsYes:3, ptsNo:7, yes:"Both sides in the book",                 no:"At least one side stays card-free" },
  // Jun 24
  { date:"Jun 24", label:"Day 14 – Prop A", q:"Will Neymar register a goal or assist in Brazil's final group match vs Scotland?",   ptsYes:5, ptsNo:5, yes:"Neymar directly involved",     no:"Neymar blanks" },
  { date:"Jun 24", label:"Day 14 – Prop B", q:"Will Alphonso Davies register a goal or assist for Canada vs Bosnia & Herzegovina?", ptsYes:6, ptsNo:4, yes:"Davies makes his mark",         no:"Davies blanks" },
  // Jun 25
  { date:"Jun 25", label:"Day 15 – Prop A", q:"Will Christian Pulisic register a goal or assist for the USA vs Turkey?",           ptsYes:5, ptsNo:5, yes:"Pulisic delivers",               no:"Pulisic blanks" },
  { date:"Jun 25", label:"Day 15 – Prop B", q:"Will Germany vs Ecuador produce 4+ total goals?",                                   ptsYes:6, ptsNo:4, yes:"High-scoring clash",              no:"Under 4 total goals" },
  // Jun 26
  { date:"Jun 26", label:"Day 16 – Prop A", q:"Will Erling Haaland score vs France?",                                     ptsYes:7, ptsNo:3, yes:"Haaland on the scoresheet",              no:"Haaland blanks" },
  { date:"Jun 26", label:"Day 16 – Prop B", q:"Will there be a last-minute goal (85'+) on Day 16?",                       ptsYes:3, ptsNo:7, yes:"Late drama on Day 16!",                  no:"No goals after the 85th minute" },
  // Jun 27
  { date:"Jun 27", label:"Final Day – Prop A", q:"Will Jude Bellingham register a goal or assist for England vs Panama?", ptsYes:4, ptsNo:6, yes:"Bellingham delivers on the final day",  no:"Bellingham blanks" },
  { date:"Jun 27", label:"Final Day – Prop B", q:"Will Lionel Messi score in Argentina's final group match vs Jordan?",   ptsYes:4, ptsNo:6, yes:"Messi on the scoresheet",               no:"Messi blanks" },
];

// ── LOCK TIMES (ET) ──────────────────────────────────────────────────────────
// Group rankings lock at first kickoff Jun 11 noon PT
const GROUP_RANKINGS_LOCK = new Date("2026-06-11T19:00:00Z"); // noon PT = 19:00 UTC

// Each pair of props per day locks at first kickoff of that day (2 entries per day)
const PROP_LOCKS = [
  new Date("2026-06-11T19:00:00Z"), // Jun 11 Prop A — noon PT
  new Date("2026-06-11T19:00:00Z"), // Jun 11 Prop B
  new Date("2026-06-12T19:00:00Z"), // Jun 12 Prop A — noon PT
  new Date("2026-06-12T19:00:00Z"), // Jun 12 Prop B
  new Date("2026-06-13T19:00:00Z"), // Jun 13 Prop A — noon PT
  new Date("2026-06-13T19:00:00Z"), // Jun 13 Prop B
  new Date("2026-06-14T17:00:00Z"), // Jun 14 Prop A — 1pm ET
  new Date("2026-06-14T17:00:00Z"), // Jun 14 Prop B
  new Date("2026-06-15T16:00:00Z"), // Jun 15 Prop A — 9am PT
  new Date("2026-06-15T16:00:00Z"), // Jun 15 Prop B
  new Date("2026-06-16T19:00:00Z"), // Jun 16 Prop A — noon PT
  new Date("2026-06-16T19:00:00Z"), // Jun 16 Prop B
  new Date("2026-06-17T17:00:00Z"), // Jun 17 Prop A — 1pm ET
  new Date("2026-06-17T17:00:00Z"), // Jun 17 Prop B
  new Date("2026-06-18T16:00:00Z"), // Jun 18 Prop A — 9am PT
  new Date("2026-06-18T16:00:00Z"), // Jun 18 Prop B
  new Date("2026-06-19T19:00:00Z"), // Jun 19 Prop A — noon PT
  new Date("2026-06-19T19:00:00Z"), // Jun 19 Prop B
  new Date("2026-06-20T17:00:00Z"), // Jun 20 Prop A — 1pm ET
  new Date("2026-06-20T17:00:00Z"), // Jun 20 Prop B
  new Date("2026-06-21T19:00:00Z"), // Jun 21 Prop A — noon PT
  new Date("2026-06-21T19:00:00Z"), // Jun 21 Prop B
  new Date("2026-06-22T17:00:00Z"), // Jun 22 Prop A — 1pm ET
  new Date("2026-06-22T17:00:00Z"), // Jun 22 Prop B
  new Date("2026-06-23T17:00:00Z"), // Jun 23 Prop A — 1pm ET
  new Date("2026-06-23T17:00:00Z"), // Jun 23 Prop B
  new Date("2026-06-25T01:00:00Z"), // Jun 24 Prop A — 9pm ET
  new Date("2026-06-25T01:00:00Z"), // Jun 24 Prop B
  new Date("2026-06-25T23:00:00Z"), // Jun 25 Prop A — 7pm ET
  new Date("2026-06-25T23:00:00Z"), // Jun 25 Prop B
  new Date("2026-06-26T19:00:00Z"), // Jun 26 Prop A — noon PT
  new Date("2026-06-26T19:00:00Z"), // Jun 26 Prop B
  new Date("2026-06-27T21:00:00Z"), // Jun 27 Prop A — 5pm ET
  new Date("2026-06-27T21:00:00Z"), // Jun 27 Prop B
];

function isGroupRankingsLocked() { return new Date() >= GROUP_RANKINGS_LOCK; }
function isPropLocked(i) { return new Date() >= PROP_LOCKS[i]; }


// ── PHASE 2 KNOCKOUT BRACKET ─────────────────────────────────────────────────
// Phase 2 opens after group stage (Jun 27 evening) and locks Jun 28 at kickoff
const PHASE2_OPEN  = new Date("2026-06-28T00:00:00Z"); // Jun 27 8pm ET
const PHASE2_LOCK  = new Date("2026-06-28T16:00:00Z"); // Jun 28 9am PT

function isPhase2Open()   { return new Date() >= PHASE2_OPEN; }
function isPhase2Locked() { return new Date() >= PHASE2_LOCK; }

// Round point values
const ROUND_PTS = { r32: 2, r16: 4, qf: 8, sf: 16, final: 32 };

// Knockout rounds structure — team slots filled from group results
// Before group stage ends, slots show as "TBD (Group X Winner)" etc.
const KNOCKOUT_ROUNDS = {
  r32: [
    { id:"r32_1",  label:"Match 1",  slotA:"1A", slotB:"2C" },
    { id:"r32_2",  label:"Match 2",  slotA:"1C", slotB:"2A" },
    { id:"r32_3",  label:"Match 3",  slotA:"1B", slotB:"2D" },
    { id:"r32_4",  label:"Match 4",  slotA:"1D", slotB:"2B" },
    { id:"r32_5",  label:"Match 5",  slotA:"1E", slotB:"2G" },
    { id:"r32_6",  label:"Match 6",  slotA:"1G", slotB:"2E" },
    { id:"r32_7",  label:"Match 7",  slotA:"1F", slotB:"2H" },
    { id:"r32_8",  label:"Match 8",  slotA:"1H", slotB:"2F" },
    { id:"r32_9",  label:"Match 9",  slotA:"1I", slotB:"2K" },
    { id:"r32_10", label:"Match 10", slotA:"1K", slotB:"2I" },
    { id:"r32_11", label:"Match 11", slotA:"1J", slotB:"2L" },
    { id:"r32_12", label:"Match 12", slotA:"1L", slotB:"2J" },
    { id:"r32_13", label:"Match 13", slotA:"3ABC", slotB:"3DEF" },
    { id:"r32_14", label:"Match 14", slotA:"3GHI", slotB:"3JKL" },
    { id:"r32_15", label:"Match 15", slotA:"3ABCD", slotB:"3EFGH" },
    { id:"r32_16", label:"Match 16", slotA:"3IJKL", slotB:"3best" },
  ],
  r16:   Array.from({length:8},  (_,i) => ({ id:`r16_${i+1}`,  label:`R16 Match ${i+1}`,  slotA:`W_r32_${i*2+1}`, slotB:`W_r32_${i*2+2}` })),
  qf:    Array.from({length:4},  (_,i) => ({ id:`qf_${i+1}`,   label:`QF Match ${i+1}`,   slotA:`W_r16_${i*2+1}`, slotB:`W_r16_${i*2+2}` })),
  sf:    Array.from({length:2},  (_,i) => ({ id:`sf_${i+1}`,   label:`SF Match ${i+1}`,   slotA:`W_qf_${i*2+1}`,  slotB:`W_qf_${i*2+2}` })),
  final: [{ id:"final_1", label:"Final", slotA:"W_sf_1", slotB:"W_sf_2" }],
};

const ROUND_LABELS = { r32:"Round of 32", r16:"Round of 16", qf:"Quarter-Finals", sf:"Semi-Finals", final:"Final" };

function calcPhase2Points(phase2Picks, livePhase2) {
  if (!phase2Picks || !livePhase2) return 0;
  let pts = 0;
  Object.entries(ROUND_PTS).forEach(([round, roundPts]) => {
    const matches = KNOCKOUT_ROUNDS[round] || [];
    matches.forEach(match => {
      const pick = phase2Picks[match.id];
      const actual = livePhase2?.[match.id];
      if (pick && actual && pick === actual) pts += roundPts;
    });
  });
  return pts;
}

// ── TIEBREAKERS ──────────────────────────────────────────────────────────────
const TIEBREAKER_P1 = {
  question: "How many total goals will be scored in the group stage?",
  hint: "2026 has 72 group stage matches. In 2022 (48 matches) there were 105 goals (~2.2/game). Scaled up: expect roughly 140–180 goals. What's your number?",
  references: [
    { year: 2022, matches: 48, goals: 105, avg: "2.19/game" },
    { year: 2018, matches: 48, goals: 122, avg: "2.54/game" },
    { year: 2014, matches: 48, goals: 136, avg: "2.83/game" },
  ],
  unit: "goals",
};

const TIEBREAKER_P2 = {
  question: "What minute will the first goal be scored in the Final?",
  hint: "Could be early, could be deep into extra time. Finals tend to be tight — don't be surprised by a late first goal.",
  references: [
    { year: 2022, matchup: "Argentina vs France", minute: 23 },
    { year: 2018, matchup: "France vs Croatia", minute: 18 },
    { year: 2014, matchup: "Germany vs Argentina", minute: 113 },
    { year: 2010, matchup: "Spain vs Netherlands", minute: 116 },
  ],
  unit: "minute (1–120, or 90+ for extra time)",
};

// ── SCORING ───────────────────────────────────────────────────────────────────
function calcGroupRankingPoints(userRanking, actualRanking) {
  if (!userRanking || !actualRanking || userRanking.length !== 4 || actualRanking.length !== 4) return 0;
  let pts = 0;
  userRanking.forEach((team, idx) => {
    const actualIdx = actualRanking.indexOf(team);
    if (actualIdx === -1) return;
    if (actualIdx === idx) pts += 6;
    else if (Math.floor(idx / 2) === Math.floor(actualIdx / 2)) pts += 2;
  });
  return pts;
}

function calcPoints(pred, live) {
  if (!pred || !live) return 0;
  let pts = 0;
  Object.entries(pred.groupRankings || {}).forEach(([g, ranking]) => {
    const actual = live.groupRankings?.[g];
    if (actual) pts += calcGroupRankingPoints(ranking, actual);
  });
  (pred.propPicks || []).forEach((pick, i) => {
    const actual = live.propResults?.[i];
    if (actual === null || actual === undefined) return;
    if (pick === actual) pts += actual ? DAILY_PROPS[i].ptsYes : DAILY_PROPS[i].ptsNo;
  });
  return pts;
}

const MAX_RANKING_PTS = 12 * 4 * 6; // 288 (doubled: 6 pts exact)
const MAX_PROP_PTS = DAILY_PROPS.reduce((s, p) => s + Math.max(p.ptsYes, p.ptsNo), 0);
const MAX_PTS = MAX_RANKING_PTS + MAX_PROP_PTS;

// Points progression per settled prop — used for sparkline chart
function calcPointsTimeline(pred, live) {
  if (!pred || !live) return [];
  const propResults = live.propResults || [];
  let running = 0;
  // Group ranking points (settled at end of group stage, represented as baseline)
  Object.entries(pred.groupRankings || {}).forEach(([g, ranking]) => {
    const actual = live.groupRankings?.[g];
    if (actual) running += calcGroupRankingPoints(ranking, actual);
  });
  const points = [];
  propResults.forEach((result, i) => {
    if (result === null || result === undefined) return;
    const pick = pred.propPicks?.[i];
    if (pick === result) running += result ? DAILY_PROPS[i].ptsYes : DAILY_PROPS[i].ptsNo;
    points.push({ label: DAILY_PROPS[i].date, pts: running, propIdx: i });
  });
  return points;
}

// Player color palette for chart lines
const PLAYER_COLORS = ["#f0d060","#60c0ff","#80ff90","#ff8090","#c080ff","#ffb060","#60ffe0","#ff60c0","#a0c060","#60a0ff"];

// ── POT CALCULATIONS ─────────────────────────────────────────────────────────
// New model:
//   total collected = paidCount * entryFee
//   commissioner cut = flat $ amount off the top
//   remainder split by phase1Split% / phase2Split%
//   each phase: last place gets entryFee refund first, then top 5 paid by configurable %
function calcPot(players, paid, settings) {
  const paidCount = players.filter(p => paid[p.id]).length;
  const total = paidCount * (settings.entryFee || 25);
  const commCut = Math.min(settings.commCut || 20, total);
  const remainder = total - commCut;
  const p1Split = (settings.p1Split ?? 50) / 100;
  const pot1 = Math.round(remainder * p1Split);
  const pot2 = remainder - pot1;
  return { pot1, pot2, total, commCut, remainder, paidCount };
}

// payoutPcts: array of 5 numbers (%, e.g. [60,25,10,5,0])
// Returns { playerId: dollarAmount } for winners + last place refund
function calcPrizes(rankedPlayers, paid, potAmount, entryFee, payoutPcts) {
  const paidPlayers = rankedPlayers.filter(p => paid[p.id]);
  if (paidPlayers.length < 2 || potAmount === 0) return {};
  const pcts = payoutPcts || [60, 25, 10, 5, 0];
  const prizes = {};
  // Last place refund
  const last = paidPlayers[paidPlayers.length - 1];
  const refund = Math.min(entryFee, potAmount);
  prizes[last.id] = refund;
  const distributable = potAmount - refund;
  // Top 5 payouts
  paidPlayers.slice(0, 5).forEach((p, i) => {
    if (p.id === last.id) return; // last place already handled
    const pct = (pcts[i] || 0) / 100;
    if (pct > 0) prizes[p.id] = (prizes[p.id] || 0) + Math.round(distributable * pct);
  });
  return prizes;
}

// ── CLAUDE API FOR LIVE RESULTS ───────────────────────────────────────────────
async function fetchLiveResults() {
  const propList = DAILY_PROPS.map((p, i) => `${i}: (${p.date}) "${p.q}" — true=yes, false=no, null=unresolved`).join("\n");
  const prompt = `Search the web for the latest 2026 FIFA World Cup results (group stage June 11–27 2026).

Return ONLY valid JSON, no markdown, no explanation:
{
  "groupRankings": {
    "A": ["1st place team","2nd","3rd","4th"] or null if group not complete,
    "B": null, "C": null, "D": null, "E": null, "F": null,
    "G": null, "H": null, "I": null, "J": null, "K": null, "L": null
  },
  "propResults": [null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null],
  "matchday": "e.g. Group Stage Day 3",
  "lastUpdated": "ISO timestamp"
}

propResults is an array of 34 values (index 0–33), 2 props per day:
${propList}

Team names must exactly match:
${Object.entries(TEAMS_BY_GROUP).map(([g,t])=>`Group ${g}: ${t.join(", ")}`).join("\n")}

Return ONLY the JSON.`;

  const res = await fetch("/api/scores", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1500,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  const raw = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const cleaned = raw.replace(/```json|```/g, "").trim();
  const s = cleaned.indexOf("{"), e = cleaned.lastIndexOf("}");
  // If no JSON yet (tournament hasn't started), return empty results
  if (s === -1) return {
    groupRankings: { A:null,B:null,C:null,D:null,E:null,F:null,G:null,H:null,I:null,J:null,K:null,L:null },
    propResults: Array(34).fill(null),
    matchday: "Tournament starts June 11",
    lastUpdated: new Date().toISOString(),
  };
  return JSON.parse(cleaned.slice(s, e + 1));
}

// ── FETCH LIVE PHASE 2 RESULTS ───────────────────────────────────────────────
async function fetchLivePhase2() {
  const matchList = Object.entries(KNOCKOUT_ROUNDS).flatMap(([round, matches]) =>
    matches.map(m => `${m.id} (${ROUND_LABELS[round]}: ${m.label}): winner team name or null`)
  ).join("\n");

  const matchIds = Object.values(KNOCKOUT_ROUNDS).flat().map(m => `"${m.id}": null`).join(", ");
  const prompt = `Search the web for 2026 FIFA World Cup knockout stage results (starting June 28 2026).

Return ONLY valid JSON, no markdown:
{
  "knockoutWinners": { ${matchIds} },
  "lastUpdated": "ISO timestamp"
}

Set each match id to the winning team name (exact spelling) or null if not yet played.
${matchList}

Return ONLY the JSON.`;

  const res = await fetch("/api/scores", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1500,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  const raw = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const cleaned = raw.replace(/```json|```/g, "").trim();
  const s = cleaned.indexOf("{"), e = cleaned.lastIndexOf("}");
  if (s === -1) return null;
  const parsed = JSON.parse(cleaned.slice(s, e + 1));
  return parsed.knockoutWinners || null;
}

// ── MATCH TICKER (live + upcoming) ───────────────────────────────────────────
async function fetchMatchTicker() {
  const prompt = `Search the web for today's 2026 FIFA World Cup matches (group stage June 11–27 2026).

Return ONLY valid JSON, no markdown:
{
  "live": [
    { "home": "Team A", "away": "Team B", "homeScore": 1, "awayScore": 0, "minute": "67'", "group": "A", "status": "LIVE" }
  ],
  "upcoming": [
    { "home": "Team C", "away": "Team D", "kickoff": "noon PT", "group": "B", "status": "upcoming" }
  ],
  "completed": [
    { "home": "Team E", "away": "Team F", "homeScore": 2, "awayScore": 1, "group": "C", "status": "FT" }
  ],
  "date": "Jun 12"
}

- live: matches currently in progress right now
- upcoming: matches scheduled for later today (not yet kicked off)
- completed: matches finished today
- Use exact team names from the tournament
- If no matches today, return empty arrays and set date to today's date
- Return ONLY the JSON.`;

  const res = await fetch("/api/scores", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 800,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  const raw = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const cleaned = raw.replace(/```json|```/g, "").trim();
  const s = cleaned.indexOf("{"), e = cleaned.lastIndexOf("}");
  if (s === -1) return null;
  return JSON.parse(cleaned.slice(s, e + 1));
}

// ── STYLES ────────────────────────────────────────────────────────────────────
const S = {
  page: { minHeight:"100vh", background:"linear-gradient(135deg,#0a1628 0%,#0d2040 50%,#071a14 100%)", fontFamily:"'Georgia',serif", color:"#f0e6c8" },
  gold: { background:"linear-gradient(90deg,#c8a84b,#f0d060,#c8a84b)", padding:"12px 20px", display:"flex", alignItems:"center", justifyContent:"space-between", boxShadow:"0 2px 20px rgba(200,168,75,0.4)" },
  card: { background:"rgba(255,255,255,0.05)", borderRadius:10, padding:14, border:"1px solid rgba(200,168,75,0.2)", marginBottom:14 },
  tab: (a) => ({ flex:1, padding:"8px 4px", border:"none", borderRadius:6, background:a?"rgba(200,168,75,0.25)":"rgba(255,255,255,0.05)", color:a?"#f0d060":"#9ab8a0", cursor:"pointer", fontSize:12, fontWeight:a?"bold":"normal", borderBottom:a?"2px solid #f0d060":"2px solid transparent" }),
  btn: { background:"linear-gradient(90deg,#c8a84b,#f0d060)", border:"none", borderRadius:6, padding:"8px 16px", color:"#0a1628", fontWeight:"bold", cursor:"pointer", fontSize:13 },
  input: { background:"rgba(255,255,255,0.08)", border:"1px solid rgba(200,168,75,0.3)", borderRadius:6, padding:"8px 12px", color:"#f0e6c8", fontSize:14, outline:"none" },
  navBtn: (a) => ({ background:a?"#0a1628":"rgba(10,22,40,0.3)", color:a?"#f0d060":"#0a1628", border:"none", borderRadius:4, padding:"4px 10px", fontSize:11, cursor:"pointer", fontWeight:"bold" }),
  pill: (a) => ({ padding:"3px 10px", borderRadius:4, border:"none", background:a?"#c8a84b":"rgba(255,255,255,0.08)", color:a?"#0a1628":"#9ab8a0", cursor:"pointer", fontSize:11, fontWeight:"bold" }),
};

// ── DAILY ROTATING QUOTE ─────────────────────────────────────────────────────
const QUOTES = [
  { text: "Taking on a challenge is a lot like riding a horse. If you're comfortable while you're doing it, you're probably doing it wrong.", author: "Ted Lasso" },
  { text: "Believe.", author: "Ted Lasso" },
  { text: "Be curious, not judgmental.", author: "Ted Lasso" },
  { text: "I think that you might be so sure that you're one in a million that sometimes you forget that out there you're just one in eleven.", author: "Ted Lasso" },
  { text: "You know what the happiest animal on Earth is? It's a goldfish. You know why? It's got a ten second memory.", author: "Ted Lasso" },
  { text: "There's no crying in baseball!", author: "A League of Their Own" },
  { text: "Are you trying to tell me Jesus Christ can't hit a curveball?", author: "Bull Durham" },
  { text: "If you build it, he will come.", author: "Field of Dreams" },
  { text: "The first rule of Fight Club is… wait, wrong movie. Just win.", author: "Coach wisdom" },
  { text: "Show me the money!", author: "Jerry Maguire" },
  { text: "It's supposed to be hard. If it wasn't hard, everyone would do it. The hard is what makes it great.", author: "A League of Their Own" },
  { text: "I feel the need… the need for speed.", author: "Top Gun (close enough)" },
  { text: "Remember the Titans? Well, remember to submit your picks.", author: "Pool admin" },
  { text: "Clear eyes, full hearts, can't lose.", author: "Friday Night Lights" },
  { text: "Every game is an opportunity to measure yourself against your own potential.", author: "Herb Brooks, Miracle" },
  { text: "Do you believe in miracles? YES!", author: "Al Michaels, Miracle on Ice" },
  { text: "Pain heals. Chicks dig scars. Glory lasts forever.", author: "The Replacements" },
  { text: "We're gonna need a bigger boat." , author: "Jaws (still applies to bracket picks)" },
  { text: "Why do you think I came here? It wasn't for the weather.", author: "Ted Lasso" },
  { text: "The idea is to get the ball, move the ball.", author: "Ted Lasso" },
  { text: "I always thought I couldn't stand more than 2 hours of cricket. How wrong I was — I cannot stand more than 20 minutes.", author: "Ted Lasso" },
  { text: "You say impossible, but all I hear is I'm possible.", author: "Ted Lasso" },
  { text: "Making a decision is like riding a bike — if you second guess yourself, you fall off.", author: "Keeley Jones, Ted Lasso" },
];

function getDailyQuote() {
  const day = Math.floor(Date.now() / 86400000); // changes every 24h UTC
  return QUOTES[day % QUOTES.length];
}

// Italy's last World Cup match: July 9, 2006 Final vs France
const ITALY_LAST_WC = new Date("2006-07-09T18:00:00Z");
const TOURNAMENT_START = new Date("2026-06-11T19:00:00Z"); // Jun 11 noon PT

function CountdownTimer() {
  const [tick, setTick] = useState(Date.now());
  useEffect(() => {
    const iv = setInterval(() => setTick(Date.now()), 50);
    return () => clearInterval(iv);
  }, []);

  const diff = Math.max(0, TOURNAMENT_START.getTime() - tick);
  const days  = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  const mins  = Math.floor((diff % 3600000) / 60000);
  const secs  = Math.floor((diff % 60000) / 1000);

  const unit = (val, label) => (
    <div style={{ textAlign:"center", minWidth:52 }}>
      <div style={{ fontSize:28, fontWeight:"bold", color:"#f0d060", fontVariantNumeric:"tabular-nums", lineHeight:1 }}>
        {String(val).padStart(2, "0")}
      </div>
      <div style={{ fontSize:9, color:"#9ab8a0", letterSpacing:1, marginTop:3 }}>{label}</div>
    </div>
  );
  const sep = <div style={{ fontSize:22, color:"rgba(200,168,75,0.4)", paddingBottom:14, alignSelf:"flex-end" }}>:</div>;

  return (
    <div style={{ ...S.card, background:"linear-gradient(135deg,rgba(10,22,40,0.9),rgba(13,32,64,0.9))", borderColor:"rgba(200,168,75,0.5)", textAlign:"center" }}>
      <div style={{ fontSize:11, fontWeight:"bold", color:"#f0d060", letterSpacing:2, marginBottom:12 }}>⏳ TOURNAMENT KICKOFF</div>
      <div style={{ fontSize:12, color:"#9ab8a0", marginBottom:14 }}>Mexico 🇲🇽 vs 🇿🇦 South Africa · June 11 · noon PT</div>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:4 }}>
        {unit(days, "DAYS")}
        {sep}
        {unit(hours, "HRS")}
        {sep}
        {unit(mins, "MIN")}
        {sep}
        {unit(secs, "SEC")}
      </div>
    </div>
  );
}

function ItalyCounter() {
  const [tick, setTick] = useState(Date.now());
  useEffect(() => {
    const iv = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);
  const diff = Math.max(0, tick - ITALY_LAST_WC.getTime());
  const days  = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  const mins  = Math.floor((diff % 3600000) / 60000);
  const secs  = Math.floor((diff % 60000) / 1000);
  return (
    <div style={{ background:"rgba(0,56,168,0.08)", border:"1px solid rgba(0,56,168,0.25)", borderRadius:8, padding:"8px 14px", marginBottom:14, display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:6 }}>
      <div style={{ fontSize:10, color:"rgba(200,180,120,0.6)", fontStyle:"italic" }}>🇮🇹 Days since Italy last played in a World Cup</div>
      <div style={{ fontSize:11, color:"rgba(200,180,120,0.55)", fontVariantNumeric:"tabular-nums", letterSpacing:0.5 }}>
        {days.toLocaleString()}d {String(hours).padStart(2,"0")}h {String(mins).padStart(2,"0")}m {String(secs).padStart(2,"0")}s
      </div>
    </div>
  );
}

function MatchCard({ match, isLive }) {
  const homeCode = COUNTRY_CODE[match.home];
  const awayCode = COUNTRY_CODE[match.away];
  const flag = (code) => code
    ? <img src={`https://flagcdn.com/24x18/${code}.png`} alt="" style={{ width:22, height:16, objectFit:"cover", borderRadius:2, verticalAlign:"middle" }} />
    : <span>🏳️</span>;

  const statusColor = isLive ? "#8fffb0" : match.status === "FT" ? "#9ab8a0" : "#f0d060";
  const statusBg    = isLive ? "rgba(0,200,80,0.15)" : match.status === "FT" ? "rgba(255,255,255,0.05)" : "rgba(200,168,75,0.1)";

  return (
    <div style={{ background:statusBg, border:`1px solid ${isLive?"rgba(0,200,80,0.35)":match.status==="FT"?"rgba(255,255,255,0.08)":"rgba(200,168,75,0.25)"}`, borderRadius:8, padding:"10px 14px", marginBottom:6 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
        <span style={{ fontSize:10, color:statusColor, fontWeight:"bold" }}>
          {isLive ? `🔴 LIVE ${match.minute||""}` : match.status === "FT" ? "✅ FT" : `🕐 ${match.kickoff||""}`}
        </span>
        <span style={{ fontSize:10, color:"#9ab8a0" }}>Group {match.group}</span>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr auto 1fr", alignItems:"center", gap:8 }}>
        <div style={{ display:"flex", alignItems:"center", gap:6 }}>
          {flag(homeCode)}
          <span style={{ fontSize:13, color:"#f0e6c8", fontWeight: isLive||match.status==="FT"?"bold":"normal" }}>{match.home}</span>
        </div>
        <div style={{ fontSize:isLive||match.status==="FT"?20:14, fontWeight:"bold", color:"#f0d060", textAlign:"center", minWidth:48 }}>
          {isLive || match.status === "FT"
            ? `${match.homeScore ?? 0}–${match.awayScore ?? 0}`
            : "vs"}
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:6, justifyContent:"flex-end" }}>
          <span style={{ fontSize:13, color:"#f0e6c8", fontWeight: isLive||match.status==="FT"?"bold":"normal" }}>{match.away}</span>
          {flag(awayCode)}
        </div>
      </div>
    </div>
  );
}

function MatchTicker({ ticker, loading, onRefresh }) {
  if (!ticker) return null;
  const { live = [], upcoming = [], completed = [], date } = ticker;
  const hasLive = live.length > 0;
  const hasAny  = live.length + upcoming.length + completed.length > 0;

  return (
    <div style={{ ...S.card, borderColor: hasLive ? "rgba(0,200,80,0.4)" : "rgba(200,168,75,0.3)", background: hasLive ? "rgba(0,60,20,0.2)" : "rgba(255,255,255,0.03)" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
        <div style={{ fontSize:11, fontWeight:"bold", color: hasLive?"#8fffb0":"#f0d060", letterSpacing:1 }}>
          {hasLive ? "🔴 LIVE NOW" : "📅 TODAY'S MATCHES"} · {date}
        </div>
        <button onClick={onRefresh} disabled={loading} style={{ background:"rgba(255,255,255,0.07)", border:"1px solid rgba(255,255,255,0.1)", borderRadius:5, padding:"3px 8px", color:"#9ab8a0", cursor:loading?"default":"pointer", fontSize:10 }}>
          {loading ? "⏳" : "🔄"}
        </button>
      </div>
      {!hasAny && <div style={{ fontSize:12, color:"#9ab8a0", textAlign:"center", padding:"8px 0" }}>No matches today · check back soon</div>}
      {live.map((m, i)      => <MatchCard key={`live-${i}`}      match={m} isLive={true} />)}
      {upcoming.map((m, i)  => <MatchCard key={`upcoming-${i}`}  match={m} isLive={false} />)}
      {completed.map((m, i) => <MatchCard key={`completed-${i}`} match={m} isLive={false} />)}
    </div>
  );
}

// ── CONFETTI ──────────────────────────────────────────────────────────────────
function Confetti({ onDone }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const pieces = Array.from({ length: 80 }, () => ({
      x: Math.random() * canvas.width,
      y: -20 - Math.random() * 100,
      w: 8 + Math.random() * 8,
      h: 5 + Math.random() * 5,
      color: ["#f0d060","#60c0ff","#80ff90","#ff8090","#c080ff","#ffb060"][Math.floor(Math.random()*6)],
      vx: (Math.random() - 0.5) * 4,
      vy: 3 + Math.random() * 3,
      angle: Math.random() * Math.PI * 2,
      va: (Math.random() - 0.5) * 0.2,
    }));
    let frame, isDone = false;
    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      pieces.forEach(p => {
        p.x += p.vx; p.y += p.vy; p.angle += p.va;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.angle);
        ctx.fillStyle = p.color; ctx.fillRect(-p.w/2, -p.h/2, p.w, p.h);
        ctx.restore();
      });
      if (!isDone && pieces.every(p => p.y > canvas.height)) { isDone = true; onDone && onDone(); }
      else frame = requestAnimationFrame(draw);
    }
    draw();
    const timer = setTimeout(() => { isDone = true; onDone && onDone(); }, 3500);
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
  }, []);
  return <canvas ref={canvasRef} style={{ position:"fixed", top:0, left:0, width:"100vw", height:"100vh", pointerEvents:"none", zIndex:9999 }} />;
}

// ── SPARKLINE CHART ───────────────────────────────────────────────────────────
function SparklineChart({ players, predictions, liveResults }) {
  const W = 620, H = 200, PAD = { t:20, r:20, b:50, l:44 };
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;

  const timelines = players.map((p, pi) => ({
    name: p.name,
    color: PLAYER_COLORS[pi % PLAYER_COLORS.length],
    points: calcPointsTimeline(predictions[p.id], liveResults),
  }));

  const settledCount = (liveResults?.propResults || []).filter(v => v !== null && v !== undefined).length;
  if (settledCount === 0) {
    return <div style={{ textAlign:"center", padding:"24px 0", color:"#9ab8a0", fontSize:13 }}>Chart will appear once props start settling (Jun 11+)</div>;
  }

  const allPts = timelines.flatMap(t => t.points.map(p => p.pts));
  const maxY = Math.max(...allPts, 10);
  const xCount = settledCount;

  const px = (i) => PAD.l + (xCount <= 1 ? innerW / 2 : (i / (xCount - 1)) * innerW);
  const py = (v) => PAD.t + innerH - (v / maxY) * innerH;
  const yTicks = [0, Math.round(maxY * 0.5), maxY];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width:"100%", maxWidth:W, display:"block", overflow:"visible" }}>
      {yTicks.map(v => (
        <g key={v}>
          <line x1={PAD.l} x2={W-PAD.r} y1={py(v)} y2={py(v)} stroke="rgba(255,255,255,0.07)" strokeWidth="1" />
          <text x={PAD.l-6} y={py(v)+4} fill="#9ab8a0" fontSize="10" textAnchor="end">{v}</text>
        </g>
      ))}
      {timelines[0]?.points.map((p, i) => (
        (i === 0 || i === timelines[0].points.length - 1 || i % Math.ceil(xCount / 5) === 0) && (
          <text key={i} x={px(i)} y={H-PAD.b+14} fill="#9ab8a0" fontSize="9" textAnchor="middle">{p.label.replace("Jun ","")}</text>
        )
      ))}
      {timelines.map(t => {
        if (t.points.length === 0) return null;
        const pts = [{ label:"Start", pts:0 }, ...t.points];
        const d = pts.map((p, i) => `${i===0?"M":"L"} ${px(i===0?0:i-1)} ${py(p.pts)}`).join(" ");
        return (
          <g key={t.name}>
            <path d={d} fill="none" stroke={t.color} strokeWidth="2" strokeLinejoin="round" opacity="0.85" />
            {t.points.map((p, i) => (
              <circle key={i} cx={px(i)} cy={py(p.pts)} r="3" fill={t.color} opacity="0.9" />
            ))}
          </g>
        );
      })}
      {timelines.map((t, i) => (
        <g key={t.name} transform={`translate(${PAD.l + (i % 4) * 148}, ${H - 10})`}>
          <circle cx="5" cy="-2" r="4" fill={t.color} />
          <text x="12" y="1" fill={t.color} fontSize="10">{t.name}</text>
        </g>
      ))}
    </svg>
  );
}

// ── HEAD-TO-HEAD MODAL ────────────────────────────────────────────────────────
function H2HModal({ playerA, playerB, predictions, liveResults, onClose }) {
  const predA = predictions[playerA.id] || {};
  const predB = predictions[playerB.id] || {};
  const propResults = liveResults?.propResults || [];
  let agree = 0, disagree = 0, aWins = 0, bWins = 0;
  DAILY_PROPS.forEach((_, i) => {
    const pa = predA.propPicks?.[i], pb = predB.propPicks?.[i];
    const actual = propResults[i];
    if (pa == null || pb == null) return;
    if (pa === pb) { agree++; }
    else {
      disagree++;
      if (actual != null) { if (pa === actual) aWins++; if (pb === actual) bWins++; }
    }
  });
  const ptsA = calcPoints(predA, liveResults);
  const ptsB = calcPoints(predB, liveResults);
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.78)", zIndex:500, display:"flex", alignItems:"center", justifyContent:"center", padding:16 }} onClick={onClose}>
      <div style={{ background:"#0d2040", border:"1px solid rgba(200,168,75,0.4)", borderRadius:14, padding:20, maxWidth:520, width:"100%", maxHeight:"82vh", overflowY:"auto" }} onClick={e => e.stopPropagation()}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
          <div style={{ fontSize:16, color:"#f0d060", fontWeight:"bold" }}>⚔️ Head-to-Head</div>
          <button onClick={onClose} style={{ background:"none", border:"none", color:"#9ab8a0", cursor:"pointer", fontSize:18 }}>✕</button>
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr auto 1fr", gap:8, marginBottom:16, alignItems:"center" }}>
          <div style={{ background:"rgba(200,168,75,0.1)", borderRadius:8, padding:"10px 12px", textAlign:"center" }}>
            <div style={{ fontSize:14, color:"#f0d060", fontWeight:"bold" }}>{playerA.name}</div>
            <div style={{ fontSize:28, fontWeight:"bold", color:"#f0d060" }}>{ptsA}</div>
            <div style={{ fontSize:10, color:"#9ab8a0" }}>pts</div>
          </div>
          <div style={{ fontSize:12, color:"#9ab8a0", textAlign:"center" }}>VS</div>
          <div style={{ background:"rgba(96,192,255,0.1)", borderRadius:8, padding:"10px 12px", textAlign:"center" }}>
            <div style={{ fontSize:14, color:"#60c0ff", fontWeight:"bold" }}>{playerB.name}</div>
            <div style={{ fontSize:28, fontWeight:"bold", color:"#60c0ff" }}>{ptsB}</div>
            <div style={{ fontSize:10, color:"#9ab8a0" }}>pts</div>
          </div>
        </div>
        <div style={{ ...S.card, display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8, textAlign:"center", marginBottom:12 }}>
          <div><div style={{ fontSize:18, fontWeight:"bold", color:"#8fffb0" }}>{agree}</div><div style={{ fontSize:10, color:"#9ab8a0" }}>agree</div></div>
          <div><div style={{ fontSize:18, fontWeight:"bold", color:"#ff9090" }}>{disagree}</div><div style={{ fontSize:10, color:"#9ab8a0" }}>clash</div></div>
          <div>
            <div style={{ fontSize:10, color:"#9ab8a0" }}>clash wins</div>
            <div style={{ fontSize:12 }}><span style={{ color:"#f0d060" }}>{playerA.name.split(" ")[0]} {aWins}</span>{" – "}<span style={{ color:"#60c0ff" }}>{bWins} {playerB.name.split(" ")[0]}</span></div>
          </div>
        </div>
        <div style={{ fontSize:11, fontWeight:"bold", color:"#f0d060", letterSpacing:1, marginBottom:8 }}>🎲 PROP PICKS</div>
        {DAILY_PROPS.map((prop, i) => {
          const pa = predA.propPicks?.[i], pb = predB.propPicks?.[i];
          const actual = propResults[i];
          const settled = actual != null;
          const same = pa != null && pb != null && pa === pb;
          const diff = pa != null && pb != null && pa !== pb;
          return (
            <div key={i} style={{ display:"flex", alignItems:"center", gap:6, padding:"5px 0", borderBottom:"1px solid rgba(255,255,255,0.05)", fontSize:11 }}>
              <span style={{ color:"#9ab8a0", minWidth:36 }}>{prop.date}</span>
              <span style={{ flex:1, color:"#c8b8a0", fontSize:10 }}>{prop.q.substring(0,42)}…</span>
              <span style={{ minWidth:24, textAlign:"center", fontWeight:"bold", color: pa==null?"#555": settled&&pa===actual?"#8fffb0": settled&&pa!==actual?"#ff9090":"#f0d060" }}>{pa==null?"—":pa?"Y":"N"}</span>
              <span style={{ color: same?"#8fffb0":diff?"#ff9090":"#555", fontSize:14, minWidth:16, textAlign:"center" }}>{same?"=":diff?"≠":"·"}</span>
              <span style={{ minWidth:24, textAlign:"center", fontWeight:"bold", color: pb==null?"#555": settled&&pb===actual?"#8fffb0": settled&&pb!==actual?"#ff9090":"#60c0ff" }}>{pb==null?"—":pb?"Y":"N"}</span>
            </div>
          );
        })}
        <div style={{ fontSize:11, fontWeight:"bold", color:"#f0d060", letterSpacing:1, marginBottom:8, marginTop:14 }}>🏅 GROUP RANKINGS</div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:6 }}>
          {Object.keys(TEAMS_BY_GROUP).map(g => {
            const ra = predA.groupRankings?.[g], rb = predB.groupRankings?.[g];
            const actual = liveResults?.groupRankings?.[g];
            const ptA = actual && ra ? calcGroupRankingPoints(ra, actual) : null;
            const ptB = actual && rb ? calcGroupRankingPoints(rb, actual) : null;
            return (
              <div key={g} style={{ background:"rgba(255,255,255,0.04)", borderRadius:6, padding:"6px 8px" }}>
                <div style={{ fontSize:10, color:"#f0d060", fontWeight:"bold", marginBottom:4, display:"flex", justifyContent:"space-between" }}>
                  <span>GROUP {g}</span>
                  {ptA !== null && <span><span style={{ color:"#f0d060" }}>{ptA}</span><span style={{ color:"#9ab8a0" }}>–</span><span style={{ color:"#60c0ff" }}>{ptB}</span></span>}
                </div>
                {["🥇","🥈","🥉","4️⃣"].map((medal, i) => {
                  const ta = ra?.[i], tb = rb?.[i], match = ta && tb && ta === tb;
                  return (
                    <div key={i} style={{ display:"flex", gap:4, fontSize:10, marginBottom:1 }}>
                      <span>{medal}</span>
                      <span style={{ color:match?"#8fffb0":"#f0d060", flex:1 }}>{ta||"—"}</span>
                      <span style={{ color:"#555" }}>|</span>
                      <span style={{ color:match?"#8fffb0":"#60c0ff", flex:1, textAlign:"right" }}>{tb||"—"}</span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── DRAG-TO-RANK ──────────────────────────────────────────────────────────────
function RankPicker({ teams, ranking, onChange, locked=false }) {
  const [dragging, setDragging] = useState(null);
  const [dragOver, setDragOver] = useState(null);
  const list = ranking?.length === 4 ? ranking : [...teams];
  const medals = ["🥇","🥈","🥉","4️⃣"];
  const posLabels = ["1st — Advances","2nd — Advances","3rd — May advance","4th — Eliminated"];

  function onDragEnd() {
    if (dragging !== null && dragOver !== null && dragging !== dragOver) {
      const next = [...list];
      const [item] = next.splice(dragging, 1);
      next.splice(dragOver, 0, item);
      onChange(next);
    }
    setDragging(null); setDragOver(null);
  }
  function move(i, dir) {
    if (locked) return;
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    const next = [...list]; [next[i], next[j]] = [next[j], next[i]]; onChange(next);
  }

  return (
    <div>
      {locked && (
        <div style={{ background:"rgba(200,60,60,0.15)", border:"1px solid rgba(200,60,60,0.3)", borderRadius:8, padding:"8px 12px", marginBottom:10, fontSize:12, color:"#ff9090" }}>
          🔒 Group rankings are locked — picks closed at tournament kickoff
        </div>
      )}
      {list.map((team, i) => (
        <div key={team} draggable={!locked}
          onDragStart={() => !locked && setDragging(i)}
          onDragEnter={() => !locked && setDragOver(i)}
          onDragEnd={!locked ? onDragEnd : undefined}
          onDragOver={e => e.preventDefault()}
          style={{
            display:"flex", alignItems:"center", gap:10,
            background: dragging===i ? "rgba(200,168,75,0.3)" : dragOver===i ? "rgba(200,168,75,0.12)" : "rgba(255,255,255,0.05)",
            border:`1px solid ${i<2?"rgba(100,200,100,0.3)":"rgba(255,255,255,0.08)"}`,
            borderRadius:8, padding:"10px 12px", marginBottom:6, cursor:locked?"default":"grab", transition:"background 0.15s",
            opacity: locked ? 0.7 : 1,
          }}>
          <span style={{ fontSize:18 }}>{medals[i]}</span>
          <span style={{ fontSize:20 }}>{tf(team)}</span>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:13, color:"#f0e6c8" }}>{team}</div>
            <div style={{ fontSize:10, color:i<2?"#8fffb0":"#9ab8a0" }}>{posLabels[i]}</div>
          </div>
          {!locked && (
            <div style={{ display:"flex", flexDirection:"column", gap:2 }}>
              <button onClick={() => move(i,-1)} disabled={i===0} style={{ background:"rgba(255,255,255,0.08)", border:"none", borderRadius:3, color:"#9ab8a0", cursor:i===0?"default":"pointer", padding:"2px 6px", fontSize:10 }}>▲</button>
              <button onClick={() => move(i,1)} disabled={i===list.length-1} style={{ background:"rgba(255,255,255,0.08)", border:"none", borderRadius:3, color:"#9ab8a0", cursor:i===list.length-1?"default":"pointer", padding:"2px 6px", fontSize:10 }}>▼</button>
            </div>
          )}
        </div>
      ))}
      {!locked && <div style={{ fontSize:10, color:"#9ab8a0", marginTop:4 }}>Drag to reorder or use ▲▼ buttons</div>}
    </div>
  );
}

// ── APP ───────────────────────────────────────────────────────────────────────
export default function WorldCupPool() {
  const [siteUnlocked, setSiteUnlocked]   = useState(() => {
    try { return localStorage.getItem("wc2026_site") === "yes"; } catch { return false; }
  });
  const [sitePassword, setSitePassword]   = useState("");
  const [siteError, setSiteError]         = useState("");
  const [screen, setScreen]               = useState("home");
  const [players, setPlayers]             = useState([]);
  const [predictions, setPredictions]     = useState({});
  const [dbLoading, setDbLoading]         = useState(true);
  const [dbError, setDbError]             = useState("");
  const [currentPlayer, setCurrentPlayer] = useState(() => {
    try { const s = localStorage.getItem("wc2026_session"); return s ? JSON.parse(s) : null; } catch { return null; }
  });
  const [isAdmin, setIsAdmin]             = useState(() => {
    try { return localStorage.getItem("wc2026_admin") === "true"; } catch { return false; }
  });
  const [newName, setNewName]             = useState("");
  const [newPassword, setNewPassword]     = useState("");
  const [loginName, setLoginName]         = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError]       = useState("");

  const [predTab, setPredTab]             = useState("groups");
  const [selGroup, setSelGroup]           = useState("A");
  const [selPropIdx, setSelPropIdx]       = useState(0);
  const [groupRankings, setGroupRankings] = useState({});
  const [propPicks, setPropPicks]         = useState(Array(34).fill(null));
  const [saved, setSaved]                 = useState(false);
  const [saving, setSaving]               = useState(false);
  const [viewingPlayer, setViewingPlayer] = useState(null);
  const [messages, setMessages]           = useState([]);
  const [newMessage, setNewMessage]       = useState("");
  const [postingMsg, setPostingMsg]       = useState(false);
  const [paid, setPaid]                   = useState({});
  const [settings, setSettings]           = useState({ entryFee: 25, commCut: 20, p1Split: 50, payouts1: [60,25,10,5,0], payouts2: [60,25,10,5,0] });
  const [editFee, setEditFee]             = useState("25");
  const [editComm, setEditComm]           = useState("20");
  const [editP1Split, setEditP1Split]     = useState("50");
  const [editPayouts1, setEditPayouts1]   = useState(["60","25","10","5","0"]);
  const [editPayouts2, setEditPayouts2]   = useState(["60","25","10","5","0"]);

  const [liveResults, setLiveResults]     = useState(null);
  const [livePhase2, setLivePhase2]       = useState(null);
  const [fetchStatus, setFetchStatus]     = useState("idle");
  const [fetchError, setFetchError]       = useState("");
  const [lastFetched, setLastFetched]     = useState(null);
  const [phase2Picks, setPhase2Picks]     = useState({});
  const [phase2Tab, setPhase2Tab]         = useState("r32");
  const [tbP1, setTbP1]                   = useState("");
  const [tbP2, setTbP2]                   = useState("");

  // ── NEW FEATURE STATE ─────────────────────────────────────────────────────
  const [reactions, setReactions]         = useState({});
  const [showConfetti, setShowConfetti]   = useState(false);
  const [confettiProp, setConfettiProp]   = useState(null);
  const [h2hPlayerA, setH2hPlayerA]       = useState(null);
  const [h2hPlayerB, setH2hPlayerB]       = useState(null);
  const [lbTab, setLbTab]                 = useState("standings");
  const [adminPinMsg, setAdminPinMsg]     = useState("");
  const [prevPropResults, setPrevPropResults] = useState(null);
  const [ticker, setTicker]                   = useState(null);
  const [tickerLoading, setTickerLoading]     = useState(false);
  const [showHowItWorks, setShowHowItWorks]   = useState(false);

  // Load from Firebase on mount
  useEffect(() => {
    dbLoad()
      .then(data => {
        setPlayers(data.players);
        setPredictions(data.predictions);
        setPaid(data.paid || {});
        const def = { entryFee: 25, commCut: 20, p1Split: 50, payouts1: [60,25,10,5,0], payouts2: [60,25,10,5,0] };
        const s = data.settings || def;
        setSettings(s);
        setEditFee(String(s.entryFee ?? 25));
        setEditComm(String(s.commCut ?? 20));
        setEditP1Split(String(s.p1Split ?? 50));
        setEditPayouts1((s.payouts1 || [60,25,10,5,0]).map(String));
        setEditPayouts2((s.payouts2 || [60,25,10,5,0]).map(String));
        setDbLoading(false);
        // Restore session state
        try {
          const s = localStorage.getItem("wc2026_session");
          const admin = localStorage.getItem("wc2026_admin") === "true";
          if (s) {
            const saved = JSON.parse(s);
            if (admin) {
              setScreen("admin");
            } else {
              const player = data.players.find(p => p.id === saved.id);
              if (player) {
                const e = data.predictions[player.id] || {};
                setGroupRankings(sanitizeGroupRankings(e.groupRankings));
                setPropPicks(e.propPicks || Array(34).fill(null));
                setPhase2Picks(e.phase2Picks || {});
                setTbP1(e.tbP1 !== undefined ? String(e.tbP1) : "");
                setTbP2(e.tbP2 !== undefined ? String(e.tbP2) : "");
                setScreen("predict");
              } else {
                localStorage.removeItem("wc2026_session");
              }
            }
          }
        } catch {}
      })
      .catch(e => { setDbError(e.message); setDbLoading(false); });
  }, []);

  // Load messages on mount
  useEffect(() => {
    loadMessages().then(setMessages).catch(() => {});
    loadReactions().then(setReactions).catch(() => {});
  }, []);

  // Poll Firebase every 30s
  useEffect(() => {
    const iv = setInterval(() => {
      dbLoad().then(data => { setPlayers(data.players); setPredictions(data.predictions); setPaid(data.paid || {}); setSettings(data.settings || { entryFee:25, commCut:20, p1Split:50, payouts1:[60,25,10,5,0], payouts2:[60,25,10,5,0] }); }).catch(() => {});
      loadMessages().then(setMessages).catch(() => {});
      loadReactions().then(setReactions).catch(() => {});
    }, 30000);
    return () => clearInterval(iv);
  }, []);

  const refreshScores = useCallback(async () => {
    setFetchStatus("loading"); setFetchError("");
    try {
      const r = await fetchLiveResults();
      // Detect newly settled props → trigger confetti if current player won
      if (prevPropResults && currentPlayer && !isAdmin) {
        const pred = predictions[currentPlayer.id] || {};
        (r.propResults || []).forEach((result, i) => {
          if (result !== null && result !== undefined && (prevPropResults[i] === null || prevPropResults[i] === undefined)) {
            if (pred.propPicks?.[i] === result) {
              setConfettiProp(i);
              setShowConfetti(true);
            }
          }
        });
      }
      setPrevPropResults(r.propResults || []);
      setLiveResults(r); setLastFetched(new Date()); setFetchStatus("done");
      if (isPhase2Open()) {
        const p2 = await fetchLivePhase2();
        if (p2) setLivePhase2(p2);
      }
    } catch (e) { setFetchError(e.message); setFetchStatus("error"); }
  }, [prevPropResults, currentPlayer, predictions, isAdmin]);

  useEffect(() => { refreshScores(); }, []);

  const refreshTicker = useCallback(async () => {
    if (new Date() < TOURNAMENT_START) return;
    setTickerLoading(true);
    try {
      const t = await fetchMatchTicker();
      setTicker(t);
    } catch {}
    setTickerLoading(false);
  }, []);

  // Load ticker on mount + poll every 2 minutes during tournament
  useEffect(() => {
    if (new Date() < TOURNAMENT_START) return;
    refreshTicker();
    const iv = setInterval(refreshTicker, 120000);
    return () => clearInterval(iv);
  }, []);

  async function register() {
    const name = newName.trim();
    const pw = newPassword.trim();
    if (!name || !pw || players.find(p => p.name === name)) return;
    const player = { name, id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, passwordHash: hashPassword(pw) };
    const np = [...players, player];
    setPlayers(np);
    await dbSave(np, predictions, paid, settings);
    setCurrentPlayer(player);
    setIsAdmin(false);
    try { localStorage.setItem("wc2026_session", JSON.stringify(player)); localStorage.removeItem("wc2026_admin"); } catch {}
    setNewName(""); setNewPassword("");
    setGroupRankings({}); setPropPicks(Array(34).fill(null)); setPhase2Picks({}); setTbP1(""); setTbP2("");
    setScreen("predict");
  }

  function loginPlayer() {
    const name = loginName.trim();
    const pw = loginPassword.trim();
    setLoginError("");
    // Admin login
    if (name === ADMIN.name && pw === ADMIN.password) {
      setCurrentPlayer({ name, id: "admin" });
      setIsAdmin(true);
      try { localStorage.setItem("wc2026_session", JSON.stringify({ name, id: "admin" })); localStorage.setItem("wc2026_admin", "true"); } catch {}
      setLoginName(""); setLoginPassword("");
      setScreen("admin");
      return;
    }
    // Player login
    const player = players.find(p => p.name === name);
    if (!player) { setLoginError("Player not found"); return; }
    if (player.passwordHash !== hashPassword(pw)) { setLoginError("Wrong password"); return; }
    setCurrentPlayer(player);
    setIsAdmin(false);
    try { localStorage.setItem("wc2026_session", JSON.stringify(player)); localStorage.removeItem("wc2026_admin"); } catch {}
    const e = predictions[player.id] || {};
    setGroupRankings(sanitizeGroupRankings(e.groupRankings));
    setPropPicks(e.propPicks || Array(34).fill(null));
    setPhase2Picks(e.phase2Picks || {});
    setTbP1(e.tbP1 !== undefined ? String(e.tbP1) : "");
    setTbP2(e.tbP2 !== undefined ? String(e.tbP2) : "");
    setSaved(false);
    setLoginName(""); setLoginPassword("");
    setScreen("predict");
  }

  async function deletePlayer(playerId) {
    const np = players.filter(p => p.id !== playerId);
    const np2 = { ...predictions };
    delete np2[playerId];
    setPlayers(np);
    setPredictions(np2);
    const newPaid = { ...paid };
    delete newPaid[playerId + "_1"];
    delete newPaid[playerId + "_2"];
    setPaid(newPaid);
    await dbSave(np, np2, newPaid, settings);
  }

  async function savePreds() {
    setSaving(true);
    const tbP1val = tbP1 !== "" ? parseInt(tbP1) : null;
    const tbP2val = tbP2 !== "" ? parseInt(tbP2) : null;
    const np = { ...predictions, [currentPlayer.id]: { groupRankings, propPicks, phase2Picks, tbP1: tbP1val, tbP2: tbP2val } };
    setPredictions(np);
    await dbSave(players, np, paid, settings);
    setSaving(false); setSaved(true); setTimeout(() => setSaved(false), 2000);
  }

  async function pinAnnouncement() {
    const text = adminPinMsg.trim();
    if (!text) return;
    await postMessage("admin", text, true, true);
    setAdminPinMsg("");
    const msgs = await loadMessages();
    setMessages(msgs);
  }

  const groupsDone = Object.keys(groupRankings).length;
  const propsDone  = propPicks.filter(p => p !== null).length;

  const leaderboard = players
    .map(p => ({ ...p, pts: calcPoints(predictions[p.id], liveResults, livePhase2), hasPred: !!predictions[p.id] }))
    .sort((a, b) => b.pts - a.pts);

  // selPropIdx retained for potential future use

  const pinnedMessages = messages.filter(m => m.pinned);
  const chatMessages   = messages.filter(m => !m.pinned);

  async function sendMessage() {
    const text = newMessage.trim();
    if (!text || !currentPlayer) return;
    setPostingMsg(true);
    await postMessage(currentPlayer.name, text, isAdmin, false);
    setNewMessage("");
    const msgs = await loadMessages();
    setMessages(msgs);
    setPostingMsg(false);
  }

  async function removeMessage(id) {
    await deleteMessage(id);
    setMessages(prev => prev.filter(m => m.id !== id));
  }

  function exportCSV() {
    const groupKeys = Object.keys(TEAMS_BY_GROUP);
    // Build header row
    const groupHeaders = groupKeys.map(g => `Group ${g} (1st,2nd,3rd,4th)`);
    const propHeaders = DAILY_PROPS.map(p => `Prop: ${p.date} - ${p.q.substring(0,40)}...`);
    const headers = ["Player", "Points", "Payment", ...groupHeaders, ...propHeaders];

    // Build rows
    const rows = players.map(p => {
      const pred = predictions[p.id] || {};
      const pts = calcPoints(pred, liveResults);
      const groupCols = groupKeys.map(g => {
        const r = pred.groupRankings?.[g];
        return r ? r.join(" > ") : "";
      });
      const propCols = DAILY_PROPS.map((_, i) => {
        const pick = pred.propPicks?.[i];
        if (pick === null || pick === undefined) return "";
        return pick ? "YES" : "NO";
      });
      return [p.name, pts, paid[p.id] ? (paid[p.id+"_method"]||"paid") : "unpaid", ...groupCols, ...propCols];
    });

    // Convert to CSV string
    const escape = val => {
      const str = String(val);
      return str.includes(",") || str.includes('"') || str.includes("\n")
        ? `"${str.replace(/"/g, '""')}"`
        : str;
    };
    const csv = [headers, ...rows].map(row => row.map(escape).join(",")).join("\n");

    // Download
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `wc2026-pool-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (dbLoading) return (
    <div style={{ ...S.page, display:"flex", alignItems:"center", justifyContent:"center" }}>
      <div style={{ textAlign:"center" }}>
        <div style={{ fontSize:40, marginBottom:12 }}>⚽</div>
        <div style={{ color:"#f0d060", fontSize:16 }}>Loading pool…</div>
      </div>
    </div>
  );

  if (dbError) return (
    <div style={{ ...S.page, display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
      <div style={{ textAlign:"center", color:"#ff8080" }}>
        <div style={{ fontSize:32, marginBottom:12 }}>⚠️</div>
        <div>Could not connect to database.</div>
        <div style={{ fontSize:12, marginTop:8, color:"#9ab8a0" }}>{dbError}</div>
      </div>
    </div>
  );

  function unlockSite() {
    if (sitePassword === SITE_PASSWORD) {
      try { localStorage.setItem("wc2026_site", "yes"); } catch {}
      setSiteUnlocked(true);
    } else {
      setSiteError("Wrong password");
    }
  }

  if (!siteUnlocked) return (
    <div style={{ ...S.page, display:"flex", alignItems:"center", justifyContent:"center", minHeight:"100vh" }}>
      <div style={{ textAlign:"center", maxWidth:320, padding:24 }}>
        <div style={{ fontSize:48, marginBottom:12 }}>⚽</div>
        <div style={{ fontSize:20, color:"#f0d060", fontWeight:"bold", marginBottom:4 }}>World Cup 2026 Pool</div>
        <div style={{ fontSize:12, color:"#9ab8a0", marginBottom:24 }}>Enter the pool password to continue</div>
        <input type="password" value={sitePassword}
          onChange={e => { setSitePassword(e.target.value); setSiteError(""); }}
          onKeyDown={e => e.key==="Enter" && unlockSite()}
          placeholder="Pool password…"
          style={{ ...S.input, width:"100%", marginBottom:10, textAlign:"center", fontSize:16 }}
          autoFocus
        />
        {siteError && <div style={{ color:"#ff8080", fontSize:12, marginBottom:10 }}>{siteError}</div>}
        <button onClick={unlockSite} style={{ ...S.btn, width:"100%", fontSize:15, padding:"10px" }}>Enter Pool</button>
      </div>
    </div>
  );

  // After site unlock, if not logged in, show auth screen
  if (!currentPlayer) return (
    <div style={{ ...S.page, display:"flex", alignItems:"center", justifyContent:"center", minHeight:"100vh" }}>
      <div style={{ maxWidth:360, width:"100%", padding:24 }}>
        <div style={{ textAlign:"center", marginBottom:24 }}>
          <div style={{ fontSize:44, marginBottom:8 }}>⚽</div>
          <div style={{ fontSize:20, color:"#f0d060", fontWeight:"bold" }}>World Cup 2026 Pool</div>
          <div style={{ fontSize:12, color:"#9ab8a0", marginTop:4 }}>June 11–July 19 · {players.length} player{players.length!==1?"s":""} joined</div>
        </div>

        {/* Login */}
        <div style={S.card}>
          <div style={{ fontSize:11, color:"#9ab8a0", marginBottom:8, letterSpacing:1 }}>LOG IN</div>
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            <input value={loginName} onChange={e => setLoginName(e.target.value)} placeholder="Your name…" style={{ ...S.input, width:"100%" }} />
            <input value={loginPassword} onChange={e => setLoginPassword(e.target.value)}
              onKeyDown={e => e.key==="Enter" && loginPlayer()}
              type="password" placeholder="Password…" style={{ ...S.input, width:"100%" }} />
            <button onClick={loginPlayer} style={{ ...S.btn, width:"100%" }}>Log In</button>
          </div>
          {loginError && <div style={{ color:"#e06060", fontSize:11, marginTop:6 }}>{loginError}</div>}
        </div>

        {/* Register */}
        <div style={S.card}>
          <div style={{ fontSize:11, color:"#9ab8a0", marginBottom:8, letterSpacing:1 }}>NEW? JOIN THE POOL</div>
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Choose a name…" style={{ ...S.input, width:"100%" }} />
            <input value={newPassword} onChange={e => setNewPassword(e.target.value)}
              onKeyDown={e => e.key==="Enter" && register()}
              type="password" placeholder="Choose a password…" style={{ ...S.input, width:"100%" }} />
            <button onClick={register} style={{ ...S.btn, width:"100%" }}>Join Pool</button>
          </div>
          {players.find(p => p.name===newName.trim()) && <div style={{ color:"#e06060", fontSize:11, marginTop:6 }}>Name already taken</div>}
          {newName.trim() && !newPassword.trim() && <div style={{ color:"#e06060", fontSize:11, marginTop:6 }}>Password required</div>}
        </div>
      </div>
    </div>
  );

  return (
    <div style={S.page}>
      {/* Confetti */}
      {showConfetti && (
        <div>
          <Confetti onDone={() => setShowConfetti(false)} />
          <div style={{ position:"fixed", top:"38%", left:"50%", transform:"translate(-50%,-50%)", zIndex:10000, textAlign:"center", pointerEvents:"none" }}>
            <div style={{ fontSize:48, marginBottom:8 }}>🎉</div>
            <div style={{ background:"rgba(200,168,75,0.96)", borderRadius:12, padding:"12px 24px", color:"#0a1628", fontWeight:"bold", fontSize:16, boxShadow:"0 4px 30px rgba(200,168,75,0.5)" }}>
              {confettiProp !== null ? `+${liveResults?.propResults?.[confettiProp] ? DAILY_PROPS[confettiProp].ptsYes : DAILY_PROPS[confettiProp].ptsNo} pts — ${DAILY_PROPS[confettiProp].label}!` : "You got it!"}
            </div>
          </div>
        </div>
      )}

      {/* H2H Modal */}
      {h2hPlayerA && h2hPlayerB && (
        <H2HModal playerA={h2hPlayerA} playerB={h2hPlayerB} predictions={predictions} liveResults={liveResults} onClose={() => { setH2hPlayerA(null); setH2hPlayerB(null); }} />
      )}

      {/* How It Works Modal */}
      {showHowItWorks && (() => {
        const { pot1, pot2, total, commCut, paidCount } = calcPot(players, paid, settings);
        const entryFee = settings.entryFee || 25;
        const pcts1 = settings.payouts1 || [60,25,10,5,0];
        const pcts2 = settings.payouts2 || [60,25,10,5,0];
        const dist1 = Math.max(0, pot1 - entryFee);
        const dist2 = Math.max(0, pot2 - entryFee);
        return (
          <div style={{ position:"fixed", inset:0, zIndex:9000, background:"rgba(0,0,0,0.82)", display:"flex", alignItems:"flex-start", justifyContent:"center", padding:"20px 14px", overflowY:"auto" }}>
            <div style={{ background:"linear-gradient(135deg,#0a1628,#0d2040)", border:"1px solid rgba(200,168,75,0.4)", borderRadius:14, maxWidth:600, width:"100%", padding:24, position:"relative" }}>
              <button onClick={() => setShowHowItWorks(false)} style={{ position:"absolute", top:14, right:16, background:"none", border:"none", color:"#9ab8a0", cursor:"pointer", fontSize:22, lineHeight:1 }}>✕</button>

              <div style={{ fontSize:22, color:"#f0d060", fontWeight:"bold", marginBottom:4 }}>⚽ How the Pool Works</div>
              <div style={{ fontSize:12, color:"#9ab8a0", marginBottom:20 }}>Everything you need to know to crush your mates</div>

              {/* Pot */}
              <div style={{ ...S.card, borderColor:"rgba(100,200,100,0.3)", background:"rgba(0,60,20,0.15)", marginBottom:14 }}>
                <div style={{ fontSize:11, fontWeight:"bold", color:"#8fffb0", letterSpacing:1, marginBottom:10 }}>💰 THE PRIZE POOL</div>
                <div style={{ fontSize:12, color:"#f0e6c8", marginBottom:8 }}>
                  Everyone chips in <strong style={{ color:"#f0d060" }}>${entryFee}</strong>. After the commissioner's cut, the pot splits into <strong>two independent competitions</strong>: Phase 1 (group stage) and Phase 2 (knockouts). Win one, both, or neither.
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                  {[[pot1,"Phase 1",dist1,pcts1],[pot2,"Phase 2",dist2,pcts2]].map(([pot,label,dist,pcts]) => (
                    <div key={label} style={{ background:"rgba(255,255,255,0.04)", borderRadius:8, padding:"8px 10px" }}>
                      <div style={{ fontSize:10, color:"#f0d060", fontWeight:"bold", marginBottom:4 }}>🏅 {label} · ${pot}</div>
                      <div style={{ fontSize:10, color:"#aab0ff", marginBottom:4 }}>Last place gets ${entryFee} back</div>
                      {["🥇","🥈","🥉","4th","5th"].map((m,i) => pcts[i]>0 ? (
                        <div key={i} style={{ fontSize:10, color:"#c8b8a0", display:"flex", justifyContent:"space-between" }}>
                          <span>{m}</span><span style={{ color:"#f0d060" }}>${Math.round(dist*pcts[i]/100)}</span>
                        </div>
                      ) : null)}
                    </div>
                  ))}
                </div>
              </div>

              {/* Group stage scoring */}
              <div style={{ ...S.card, marginBottom:14 }}>
                <div style={{ fontSize:11, fontWeight:"bold", color:"#f0d060", letterSpacing:1, marginBottom:8 }}>🏅 PHASE 1 — GROUP STAGE SCORING</div>
                <div style={{ fontSize:12, color:"#f0e6c8", marginBottom:8 }}>Predict the final standings of all 12 groups (A–L). Drag teams into your predicted order.</div>
                <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                  {[["🥇 Exact position","+6 pts","Nailed it — right team, right spot"],["✅ Correct half","+2 pts","Got them in the right half — top 2 or bottom 2"],["❌ Wrong half","0 pts","Nice try though"]].map(([l,pts,desc]) => (
                    <div key={l} style={{ display:"flex", gap:10, alignItems:"baseline", fontSize:12 }}>
                      <span style={{ minWidth:120, color:"#f0e6c8" }}>{l}</span>
                      <span style={{ color:"#f0d060", fontWeight:"bold", minWidth:50 }}>{pts}</span>
                      <span style={{ color:"#9ab8a0", fontSize:11 }}>{desc}</span>
                    </div>
                  ))}
                </div>
                <div style={{ fontSize:11, color:"#9ab8a0", marginTop:8 }}>Max {MAX_RANKING_PTS} pts across all 12 groups.</div>
              </div>

              {/* Props scoring */}
              <div style={{ ...S.card, marginBottom:14 }}>
                <div style={{ fontSize:11, fontWeight:"bold", color:"#f0d060", letterSpacing:1, marginBottom:8 }}>🎲 PHASE 1 — DAILY PROPS SCORING</div>
                <div style={{ fontSize:12, color:"#f0e6c8", marginBottom:8 }}>34 props total, 2 per day from Jun 11–27. Each prop is a YES or NO question.</div>
                <div style={{ background:"rgba(255,255,255,0.04)", borderRadius:8, padding:10, marginBottom:8 }}>
                  <div style={{ fontSize:12, color:"#f0d060", fontWeight:"bold", marginBottom:4 }}>Weighted odds</div>
                  <div style={{ fontSize:12, color:"#f0e6c8", lineHeight:1.6 }}>Points are weighted by probability — the less likely outcome pays more. Every prop sums to 10 pts across the two sides. Pick the longshot right and you'll earn more than picking the chalk.</div>
                </div>
                <div style={{ fontSize:12, color:"#9ab8a0" }}>Example: YES=4pts / NO=6pts means the NO side is the underdog. If it happens and you called it, you bank 6.</div>
              </div>

              {/* Phase 2 */}
              <div style={{ ...S.card, marginBottom:14 }}>
                <div style={{ fontSize:11, fontWeight:"bold", color:"#f0d060", letterSpacing:1, marginBottom:8 }}>🏆 PHASE 2 — KNOCKOUT BRACKET</div>
                <div style={{ fontSize:12, color:"#f0e6c8", marginBottom:8 }}>Pick the winner of every knockout match (R32 → Final). Points scale up with each round — getting the Final right is worth a lot.</div>
                <div style={{ display:"flex", flexDirection:"column", gap:5, fontSize:12 }}>
                  {[["Round of 32","2 pts"],["Round of 16","4 pts"],["Quarter-Finals","8 pts"],["Semi-Finals","16 pts"],["Final","32 pts"]].map(([r,p]) => (
                    <div key={r} style={{ display:"flex", justifyContent:"space-between", borderBottom:"1px solid rgba(255,255,255,0.05)", padding:"3px 0" }}>
                      <span style={{ color:"#c8b8a0" }}>{r}</span>
                      <span style={{ color:"#f0d060", fontWeight:"bold" }}>{p} per correct pick</span>
                    </div>
                  ))}
                </div>
                <div style={{ fontSize:11, color:"#aab0ff", marginTop:8 }}>🔜 Phase 2 props coming soon — extra picks for the knockout stage.</div>
              </div>

              {/* Tiebreakers */}
              <div style={{ ...S.card, borderColor:"rgba(255,180,50,0.3)", background:"rgba(255,140,0,0.06)", marginBottom:14 }}>
                <div style={{ fontSize:11, fontWeight:"bold", color:"#f0d060", letterSpacing:1, marginBottom:8 }}>🔢 TIEBREAKERS</div>
                <div style={{ fontSize:12, color:"#f0e6c8", marginBottom:6 }}><strong style={{ color:"#f0d060" }}>Phase 1:</strong> Total goals scored in the group stage. Closest to the actual number wins the tiebreak.</div>
                <div style={{ fontSize:12, color:"#f0e6c8" }}><strong style={{ color:"#f0d060" }}>Phase 2:</strong> Minute of the first goal in the Final. Closest without going over (Price is Right rules).</div>
              </div>

              {/* Lock times */}
              <div style={{ ...S.card, borderColor:"rgba(255,100,100,0.3)", background:"rgba(200,60,60,0.06)", marginBottom:14 }}>
                <div style={{ fontSize:11, fontWeight:"bold", color:"#ff9090", letterSpacing:1, marginBottom:8 }}>🔒 LOCK TIMES</div>
                {[["🏅 Group rankings + all Day 1 props","Jun 11 at noon PT — tournament kickoff (Mexico vs South Africa)"],["🎲 Each day's props","Locks at first kickoff of that day — check the label on each card"],["🏆 Bracket picks","Jun 28 at 9am PT — right after the group stage ends"]].map(([l,v]) => (
                  <div key={l} style={{ fontSize:12, padding:"5px 0", borderBottom:"1px solid rgba(255,255,255,0.05)" }}>
                    <div style={{ color:"#ff9090", fontWeight:"bold", marginBottom:2 }}>{l}</div>
                    <div style={{ color:"#9ab8a0" }}>{v}</div>
                  </div>
                ))}
                <div style={{ fontSize:11, color:"#ff9090", marginTop:8 }}>⚠️ Save your picks early — anything unsaved before the deadline doesn't count!</div>
              </div>

              <button onClick={() => setShowHowItWorks(false)} style={{ ...S.btn, width:"100%", fontSize:14, padding:"10px" }}>Got it, let's go! ⚽</button>
            </div>
          </div>
        );
      })()}

      {/* Header */}
      <div style={S.gold}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <span style={{ fontSize:28 }}>⚽</span>
          <div>
            <div style={{ fontSize:13, fontWeight:"bold", color:"#0a1628", letterSpacing:2, textTransform:"uppercase" }}>FIFA World Cup 2026</div>
            <div style={{ fontSize:10, color:"#3a2a00" }}>Phase 1: Group Stage · {players.length} player{players.length!==1?"s":""}</div>
          </div>
        </div>
        <div style={{ display:"flex", gap:6, alignItems:"center" }}>
          {["home","leaderboard"].map(s => (
            <button key={s} style={S.navBtn(screen===s)} onClick={() => setScreen(s)}>
              {s==="home" ? "🏠 Home" : "🏆 Board"}
            </button>
          ))}
          <button style={{ ...S.navBtn(false), background:"rgba(200,168,75,0.2)", color:"#0a1628" }} onClick={() => setShowHowItWorks(true)}>
            ❓ Rules
          </button>
          {currentPlayer && !isAdmin && (
            <button style={S.navBtn(screen==="predict")} onClick={() => setScreen("predict")}>📋 My Picks</button>
          )}

          {isGroupRankingsLocked() && (
            <button style={S.navBtn(screen==="picks")} onClick={() => setScreen("picks")}>👀 Picks</button>
          )}
          {isAdmin && (
            <button style={S.navBtn(screen==="admin")} onClick={() => setScreen("admin")}>⚙️ Admin</button>
          )}
          {currentPlayer ? (
            <button style={{ ...S.navBtn(false), background:"rgba(180,60,60,0.5)", color:"#ffdddd" }}
              onClick={() => { setCurrentPlayer(null); setIsAdmin(false); try { localStorage.removeItem("wc2026_session"); localStorage.removeItem("wc2026_admin"); } catch {} }}>
              Logout
            </button>
          ) : (
            <button style={{ ...S.navBtn(false), background:"rgba(200,168,75,0.3)", color:"#0a1628" }}
              onClick={() => { /* already on auth screen if no player */ }}>
              Log In
            </button>
          )}
        </div>
      </div>

      {/* Status bar */}
      <div style={{ background:fetchStatus==="error"?"rgba(200,60,60,0.12)":"rgba(0,120,60,0.12)", padding:"5px 16px", fontSize:11, color:fetchStatus==="error"?"#ff8080":"#8fffb0", display:"flex", justifyContent:"space-between" }}>
        <span>
          {fetchStatus==="loading" && "⏳ Fetching live results…"}
          {fetchStatus==="done" && `✅ ${liveResults?.matchday||"Group Stage"} · ${Object.values(liveResults?.groupRankings||{}).filter(Boolean).length}/12 groups final · ${(liveResults?.propResults||[]).filter(v=>v!==null).length}/34 props settled`}
          {fetchStatus==="error" && `⚠️ ${fetchError}`}
          {fetchStatus==="idle" && "Initialising…"}
        </span>
        {lastFetched && <span style={{ color:"#9ab8a0" }}>Updated {lastFetched.toLocaleTimeString()}</span>}
      </div>

      <div style={{ maxWidth:680, margin:"0 auto", padding:"18px 14px" }}>

        {/* ── HOME ── */}
        {screen==="home" && (
          <div>
            <div style={{ textAlign:"center", marginBottom:16 }}>
              <div style={{ fontSize:44, marginBottom:6 }}>🏆</div>
              <h1 style={{ margin:0, fontSize:24, color:"#f0d060" }}>World Cup Pool</h1>
              <p style={{ color:"#9ab8a0", fontSize:12, margin:"4px 0 0" }}>Phase 1: Group Stage · June 11–27 · Backed by Firebase ☁️</p>
            </div>

            {/* Daily quote */}
            {(() => {
              const q = getDailyQuote();
              return (
                <div style={{ textAlign:"center", padding:"2px 8px 16px", marginBottom:0 }}>
                  <div style={{ fontSize:13, color:"#c8b8a0", fontStyle:"italic", lineHeight:1.6 }}>"{q.text}"</div>
                  <div style={{ fontSize:10, color:"#9ab8a0", marginTop:4 }}>— {q.author}</div>
                </div>
              );
            })()}

            {/* Countdown or live ticker */}
            {new Date() < TOURNAMENT_START
              ? <CountdownTimer />
              : <MatchTicker ticker={ticker} loading={tickerLoading} onRefresh={refreshTicker} />
            }

            {/* 💵 Payout structure */}
            {(() => {
              const { pot1, pot2, total, commCut, paidCount } = calcPot(players, paid, settings);
              const entryFee = settings.entryFee || 25;
              const pcts1 = settings.payouts1 || [60,25,10,5,0];
              const pcts2 = settings.payouts2 || [60,25,10,5,0];
              const refund = entryFee;
              const dist1 = Math.max(0, pot1 - refund);
              const dist2 = Math.max(0, pot2 - refund);
              const medals = ["🥇","🥈","🥉","4th","5th"];
              return (
                <div style={{ ...S.card, borderColor:"rgba(100,200,100,0.3)", background:"rgba(0,60,20,0.15)" }}>
                  <div style={{ fontSize:11, fontWeight:"bold", color:"#8fffb0", marginBottom:10, letterSpacing:1 }}>💵 PRIZE POOL</div>

                  {/* Money flow */}
                  <div style={{ display:"flex", gap:6, flexWrap:"wrap", alignItems:"center", marginBottom:12, fontSize:12 }}>
                    <span style={{ color:"#f0e6c8" }}>${entryFee} entry</span>
                    <span style={{ color:"#555" }}>×</span>
                    <span style={{ color:"#f0e6c8" }}>{paidCount} paid</span>
                    <span style={{ color:"#555" }}>=</span>
                    <span style={{ color:"#f0d060", fontWeight:"bold" }}>${total}</span>
                    <span style={{ color:"#555" }}>−</span>
                    <span style={{ color:"#ff9090" }}>${commCut} commissioner</span>
                    <span style={{ color:"#555" }}>=</span>
                    <span style={{ color:"#8fffb0", fontWeight:"bold" }}>${total - commCut} to players</span>
                  </div>

                  {/* Phase split */}
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:10 }}>
                    {[[pot1,"🏅 Phase 1",dist1,pcts1],[pot2,"🏆 Phase 2",dist2,pcts2]].map(([pot,label,dist,pcts]) => (
                      <div key={label} style={{ background:"rgba(255,255,255,0.04)", borderRadius:8, padding:"8px 10px" }}>
                        <div style={{ fontSize:10, color:"#f0d060", fontWeight:"bold", marginBottom:6 }}>{label} · <span style={{ color:"#f0d060" }}>${pot}</span></div>
                        <div style={{ fontSize:10, color:"#aab0ff", marginBottom:6 }}>↩ last place gets ${refund} back</div>
                        {medals.map((m, i) => pcts[i] > 0 ? (
                          <div key={i} style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"#c8b8a0", padding:"2px 0" }}>
                            <span>{m}</span>
                            <span style={{ color:"#f0d060", fontWeight:"bold" }}>${Math.round(dist * pcts[i] / 100)} <span style={{ color:"#9ab8a0", fontWeight:"normal" }}>({pcts[i]}%)</span></span>
                          </div>
                        ) : null)}
                      </div>
                    ))}
                  </div>

                  {paidCount === 0 && <div style={{ fontSize:11, color:"#9ab8a0" }}>Amounts above reflect {players.length} player{players.length!==1?"s":""} — numbers update as players pay.</div>}
                </div>
              );
            })()}

            <div style={{ ...S.card, borderColor:"rgba(255,180,50,0.3)", background:"rgba(255,140,0,0.08)" }}>
              <div style={{ fontSize:11, fontWeight:"bold", color:"#f0d060", marginBottom:8, letterSpacing:1 }}>🔒 WHEN PICKS LOCK</div>
              {[
                ["🏅 Group Rankings", "Lock at tournament kickoff — Jun 11 at noon PT (Mexico vs South Africa). You cannot change your group standings after this."],
                ["🎲 Daily Props", "Each prop locks before the first match of that day. Once the day's games start, your answer is final."],
                ["⚠️ Submit early!", "Don't wait until the last minute — picks that aren't saved before the deadline won't count."],
              ].map(([l,v]) => (
                <div key={l} style={{ padding:"5px 0", borderBottom:"1px solid rgba(255,255,255,0.05)", fontSize:12 }}>
                  <span style={{ color:"#f0d060", fontWeight:"bold" }}>{l} </span>
                  <span style={{ color:"#9ab8a0" }}>{v}</span>
                </div>
              ))}
            </div>

            {/* Login */}

            {/* Join */}

            {/* Player list - names only, no login from here */}
            {players.length > 0 && (
              <div style={{ ...S.card }}>
                <div style={{ fontSize:11, color:"#9ab8a0", marginBottom:8 }}>PLAYERS ({players.length})</div>
                <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
                  {players.map(p => (
                    <div key={p.id} style={{ background:"rgba(200,168,75,0.1)", border:"1px solid rgba(200,168,75,0.3)", borderRadius:20, padding:"4px 12px", color:"#f0d060", fontSize:12 }}>
                      {predictions[p.id] ? "✓ " : ""}{p.name}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {/* ── MESSAGE BOARD ── */}
            <div style={S.card}>
              <div style={{ fontSize:11, fontWeight:"bold", color:"#f0d060", marginBottom:10, letterSpacing:1 }}>💬 BANTER BOARD</div>

              {/* Pinned announcements */}
              {pinnedMessages.length > 0 && (
                <div style={{ marginBottom:12 }}>
                  {pinnedMessages.map(msg => (
                    <div key={msg.id} style={{ background:"rgba(200,168,75,0.1)", border:"1px solid rgba(200,168,75,0.45)", borderRadius:8, padding:"8px 12px", marginBottom:6, display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                      <div>
                        <div style={{ fontSize:10, color:"#c8a84b", marginBottom:3, fontWeight:"bold" }}>📣 ANNOUNCEMENT</div>
                        <div style={{ fontSize:12, color:"#f0e6c8" }}>{msg.text}</div>
                      </div>
                      {isAdmin && <button onClick={() => removeMessage(msg.id)} style={{ background:"none", border:"none", color:"rgba(255,100,100,0.4)", cursor:"pointer", fontSize:13, flexShrink:0 }}>🗑</button>}
                    </div>
                  ))}
                </div>
              )}

              {/* Admin pin input */}
              {isAdmin && (
                <div style={{ marginBottom:12, padding:"10px 12px", background:"rgba(200,168,75,0.05)", borderRadius:8, border:"1px solid rgba(200,168,75,0.2)" }}>
                  <div style={{ fontSize:10, color:"#c8a84b", marginBottom:6, fontWeight:"bold" }}>📣 PIN ANNOUNCEMENT</div>
                  <div style={{ display:"flex", gap:8 }}>
                    <input value={adminPinMsg} onChange={e => setAdminPinMsg(e.target.value)} onKeyDown={e => e.key==="Enter" && pinAnnouncement()} placeholder="Type pinned message…" style={{ ...S.input, flex:1, fontSize:12, padding:"6px 10px" }} />
                    <button onClick={pinAnnouncement} disabled={!adminPinMsg.trim()} style={{ ...S.btn, fontSize:11, padding:"5px 12px" }}>📌 Pin</button>
                  </div>
                </div>
              )}

              {/* Messages */}
              <div style={{ maxHeight:320, overflowY:"auto", marginBottom:10 }}>
                {chatMessages.length === 0 && (
                  <div style={{ color:"#9ab8a0", fontSize:12, textAlign:"center", padding:"16px 0" }}>No messages yet — be the first! 👋</div>
                )}
                {chatMessages.map(msg => {
                  const isOwn = currentPlayer && msg.author === currentPlayer.name;
                  const isAdminMsg = msg.isAdmin;
                  const date = new Date(msg.timestamp);
                  const timeStr = date.toLocaleDateString("en-US", { month:"short", day:"numeric" }) + " " + date.toLocaleTimeString("en-US", { hour:"numeric", minute:"2-digit" });
                  return (
                    <div key={msg.id} style={{ marginBottom:12 }}>
                      <div style={{ display:"flex", flexDirection: isOwn ? "row-reverse" : "row", gap:8, alignItems:"flex-start" }}>
                        <div style={{ width:28, height:28, borderRadius:"50%", flexShrink:0, background: isAdminMsg ? "linear-gradient(135deg,#c8a84b,#f0d060)" : "rgba(255,255,255,0.1)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:"bold", color: isAdminMsg ? "#0a1628" : "#f0e6c8" }}>
                          {msg.author[0].toUpperCase()}
                        </div>
                        <div style={{ maxWidth:"78%", flex:1 }}>
                          <div style={{ fontSize:10, color:"#9ab8a0", marginBottom:2, textAlign: isOwn ? "right" : "left" }}>
                            {isAdminMsg ? "⚙️ " : ""}{msg.author} · {timeStr}
                          </div>
                          <div style={{ background: isAdminMsg ? "rgba(200,168,75,0.15)" : isOwn ? "rgba(100,150,255,0.12)" : "rgba(255,255,255,0.06)", border: `1px solid ${isAdminMsg ? "rgba(200,168,75,0.35)" : isOwn ? "rgba(100,150,255,0.25)" : "rgba(255,255,255,0.07)"}`, borderRadius: isOwn ? "10px 10px 2px 10px" : "10px 10px 10px 2px", padding:"7px 10px", fontSize:12, color:"#f0e6c8", lineHeight:1.5, wordBreak:"break-word" }}>
                            {msg.text}
                          </div>
                        </div>
                        {isAdmin && <button onClick={() => removeMessage(msg.id)} style={{ background:"none", border:"none", color:"rgba(255,100,100,0.35)", cursor:"pointer", fontSize:13, padding:"2px", alignSelf:"center", flexShrink:0 }}>🗑</button>}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Compose */}
              {currentPlayer ? (
                <div>
                  <div style={{ display:"flex", gap:8 }}>
                    <input value={newMessage} onChange={e => setNewMessage(e.target.value)} onKeyDown={e => e.key==="Enter" && !e.shiftKey && sendMessage()} placeholder={isAdmin ? "Post a message…" : "Say something…"} style={{ ...S.input, flex:1, fontSize:12, padding:"6px 10px" }} maxLength={500} />
                    <button onClick={sendMessage} disabled={postingMsg || !newMessage.trim()} style={{ ...S.btn, background: postingMsg||!newMessage.trim() ? "#444" : "linear-gradient(90deg,#c8a84b,#f0d060)", color: postingMsg||!newMessage.trim() ? "#888" : "#0a1628", fontSize:12, padding:"6px 12px" }}>
                      {postingMsg ? "…" : "Send"}
                    </button>
                  </div>
                  <div style={{ fontSize:10, color:"#9ab8a0", marginTop:3 }}>{newMessage.length}/500 · Enter to send</div>
                </div>
              ) : (
                <div style={{ fontSize:12, color:"#9ab8a0", textAlign:"center" }}>Log in to join the conversation</div>
              )}
            </div>

            {/* Italy counter — easter egg */}
            <ItalyCounter />

          </div>
        )}
        {screen==="predict" && currentPlayer && (
          <div>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:14 }}>
              <div>
                <div style={{ fontSize:17, color:"#f0d060" }}>📋 {currentPlayer.name}'s Picks</div>
                <div style={{ fontSize:11, color:"#9ab8a0" }}>{groupsDone}/12 groups · {propsDone}/34 props</div>
              </div>
              <div style={{ display:"flex", gap:8 }}>
                <button onClick={() => setScreen("home")} style={{ background:"rgba(255,255,255,0.07)", border:"1px solid rgba(255,255,255,0.1)", borderRadius:6, padding:"6px 10px", color:"#9ab8a0", cursor:"pointer", fontSize:12 }}>← Home</button>
                <button onClick={savePreds} disabled={saving} style={{ ...S.btn, background:saved?"#2a6040":saving?"#555":"linear-gradient(90deg,#c8a84b,#f0d060)", color:saved?"#8fffb0":"#0a1628" }}>
                  {saving ? "Saving…" : saved ? "✓ Saved!" : "Save"}
                </button>
              </div>
            </div>

            {/* Progress */}
            <div style={{ marginBottom:14 }}>
              <div style={{ display:"flex", justifyContent:"space-between", fontSize:10, color:"#9ab8a0", marginBottom:4 }}>
                <span>Progress</span><span>{groupsDone + propsDone} / 46 picks</span>
              </div>
              <div style={{ height:5, background:"rgba(255,255,255,0.08)", borderRadius:3, overflow:"hidden" }}>
                <div style={{ height:"100%", width:`${((groupsDone+propsDone)/46)*100}%`, background:"linear-gradient(90deg,#c8a84b,#f0d060)", borderRadius:3, transition:"width 0.3s" }} />
              </div>
            </div>

            <div style={{ display:"flex", gap:4, marginBottom:14, flexWrap:"wrap" }}>
              {[["groups",`🏅 Groups (${groupsDone}/12)`],["props",`🎲 Props (${propsDone}/34)`],["tb1",`🔢 Tiebreaker${tbP1?"  ✓":""}`], ...(isPhase2Open() ? [["phase2","🏆 Knockouts"]] : [])].map(([t,l]) => (
                <button key={t} style={S.tab(predTab===t)} onClick={() => setPredTab(t)}>{l}</button>
              ))}
            </div>

            {/* GROUP RANKINGS */}
            {predTab==="groups" && (
              <div>
                <div style={{ fontSize:12, color:"#9ab8a0", marginBottom:12 }}>
                  Predict the final standings of each group. Drag or use ▲▼.<br/>
                  <span style={{ color:"#f0d060" }}>+6 pts</span> exact position · <span style={{ color:"#c8a84b" }}>+2 pts</span> correct half (top 2 vs bottom 2)
                </div>
                <div style={{ display:"flex", gap:5, flexWrap:"wrap", marginBottom:14 }}>
                  {Object.keys(TEAMS_BY_GROUP).map(g => (
                    <button key={g} style={S.pill(selGroup===g)} onClick={() => setSelGroup(g)}>
                      Grp {g} {groupRankings[g] ? "✓" : ""}
                    </button>
                  ))}
                </div>
                <div style={{ fontSize:12, color:"#9ab8a0", marginBottom:10 }}>
                  Group {selGroup}
                  {liveResults?.groupRankings?.[selGroup] && (
                    <span style={{ color:"#f0d060", marginLeft:8 }}>
                      · Final: {liveResults.groupRankings[selGroup].map(t => `${tf(t)} ${t}`).join(" → ")}
                    </span>
                  )}
                </div>
                <RankPicker
                  teams={TEAMS_BY_GROUP[selGroup]}
                  ranking={groupRankings[selGroup]}
                  onChange={r => setGroupRankings(prev => ({ ...prev, [selGroup]:r }))}
                  locked={isGroupRankingsLocked()}
                />
                <div style={{ display:"flex", justifyContent:"space-between", marginTop:12 }}>
                  <button style={S.pill(false)} onClick={() => { const ks=Object.keys(TEAMS_BY_GROUP); const i=ks.indexOf(selGroup); if(i>0) setSelGroup(ks[i-1]); }} disabled={selGroup==="A"}>← Prev</button>
                  <span style={{ fontSize:11, color:"#9ab8a0" }}>Group {selGroup} · {Object.keys(TEAMS_BY_GROUP).indexOf(selGroup)+1}/12</span>
                  <button style={S.pill(false)} onClick={() => { const ks=Object.keys(TEAMS_BY_GROUP); const i=ks.indexOf(selGroup); if(i<ks.length-1) setSelGroup(ks[i+1]); }} disabled={selGroup==="L"}>Next →</button>
                </div>
              </div>
            )}

            {/* DAILY PROPS */}
            {predTab==="props" && (() => {
              // Group props by date for display
              const propsByDate = [];
              let currentDate = null;
              DAILY_PROPS.forEach((p, i) => {
                if (p.date !== currentDate) {
                  currentDate = p.date;
                  propsByDate.push({ date: p.date, props: [] });
                }
                propsByDate[propsByDate.length - 1].props.push({ prop: p, idx: i });
              });

              return (
              <div>
                <div style={{ fontSize:12, color:"#9ab8a0", marginBottom:12 }}>Two props per match day — YES or NO. Points are weighted: the less likely outcome pays more. Both sides always sum to 10 pts.</div>

                {propsByDate.map(({ date, props: dayProps }) => (
                  <div key={date} style={{ marginBottom:18 }}>
                    <div style={{ fontSize:11, fontWeight:"bold", color:"#f0d060", letterSpacing:1, marginBottom:8, paddingBottom:4, borderBottom:"1px solid rgba(200,168,75,0.2)" }}>{date.toUpperCase()}</div>
                    {dayProps.map(({ prop, idx }) => {
                      const actual = liveResults?.propResults?.[idx];
                      const settled = actual !== null && actual !== undefined;
                      const pick = propPicks[idx];
                      const won = settled && pick === actual;
                      const lost = settled && pick !== null && pick !== undefined && !won;
                      const locked = isPropLocked(idx);
                      return (
                        <div key={idx} style={{ ...S.card, marginBottom:10, borderColor: won?"rgba(100,255,150,0.4)":lost?"rgba(255,100,100,0.3)":"rgba(200,168,75,0.2)" }}>
                          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:6 }}>
                            <span style={{ fontSize:11, color:"#f0d060", fontWeight:"bold", flex:1, marginRight:8 }}>{prop.label}</span>
                            <div style={{ display:"flex", gap:5, flexShrink:0 }}>
                              <span style={{ fontSize:10, background:"rgba(0,180,80,0.15)", color:"#8fffb0", borderRadius:4, padding:"2px 6px" }}>YES {prop.ptsYes}pts</span>
                              <span style={{ fontSize:10, background:"rgba(180,50,50,0.15)", color:"#ff9090", borderRadius:4, padding:"2px 6px" }}>NO {prop.ptsNo}pts</span>
                              {locked && <span style={{ fontSize:10, color:"#ff9090" }}>🔒</span>}
                            </div>
                          </div>
                          <div style={{ fontSize:13, color:"#f0e6c8", marginBottom:10, lineHeight:1.5 }}>{prop.q}</div>

                          {settled && (
                            <div style={{ fontSize:12, marginBottom:10, padding:"6px 10px", borderRadius:6, background:actual?"rgba(0,180,80,0.15)":"rgba(180,50,50,0.15)", color:actual?"#8fffb0":"#ff9090" }}>
                              Result: {actual ? `✅ YES — ${prop.yes}` : `❌ NO — ${prop.no}`}
                              {won ? " 🎉 You got it!" : lost ? " 😬 Unlucky" : ""}
                            </div>
                          )}

                          {locked && !settled && (
                            <div style={{ background:"rgba(200,60,60,0.15)", border:"1px solid rgba(200,60,60,0.3)", borderRadius:8, padding:"6px 10px", marginBottom:8, fontSize:11, color:"#ff9090" }}>
                              🔒 Locked — picks closed before first match of the day
                            </div>
                          )}

                          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                            {[[true,"✅",prop.yes,prop.ptsYes],[false,"❌",prop.no,prop.ptsNo]].map(([val,icon,label,pts]) => (
                              <button key={String(val)}
                                onClick={() => {
                                  if (isPropLocked(idx)) return;
                                  const n=[...propPicks]; n[idx]=val; setPropPicks(n);
                                }}
                                style={{
                                  padding:"12px 8px", borderRadius:10, border:"2px solid",
                                  borderColor:propPicks[idx]===val?"#f0d060":"rgba(255,255,255,0.1)",
                                  background:propPicks[idx]===val?"rgba(200,168,75,0.25)":"rgba(255,255,255,0.04)",
                                  color:propPicks[idx]===val?"#f0d060":"#c8b8a0",
                                  cursor:isPropLocked(idx)?"default":"pointer", fontSize:12, textAlign:"center", lineHeight:1.4,
                                  opacity:isPropLocked(idx)&&propPicks[idx]!==val?0.4:1,
                                }}>
                                <div style={{ fontSize:18, marginBottom:3 }}>{icon}</div>
                                <div style={{ fontWeight:propPicks[idx]===val?"bold":"normal", marginBottom:3 }}>{label}</div>
                                <div style={{ fontSize:10, color:propPicks[idx]===val?"#f0d060":"#9ab8a0" }}>+{pts} pts</div>
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
              );
            })()}

            {/* PHASE 1 TIEBREAKER TAB */}
            {predTab==="tb1" && (
              <div style={{ ...S.card, borderColor:"rgba(255,180,50,0.4)", background:"rgba(255,140,0,0.06)" }}>
                <div style={{ fontSize:11, fontWeight:"bold", color:"#f0d060", marginBottom:6, letterSpacing:1 }}>🔢 PHASE 1 TIEBREAKER</div>
                <div style={{ fontSize:12, color:"#9ab8a0", marginBottom:12 }}>Used only to break ties in Phase 1 standings. Doesn't affect your score directly.</div>
                <div style={{ fontSize:14, color:"#f0e6c8", marginBottom:8 }}>{TIEBREAKER_P1.question}</div>
                <div style={{ fontSize:11, color:"#9ab8a0", marginBottom:12, lineHeight:1.6 }}>{TIEBREAKER_P1.hint}</div>
                <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:14 }}>
                  {TIEBREAKER_P1.references.map(r => (
                    <div key={r.year} style={{ background:"rgba(255,255,255,0.05)", borderRadius:6, padding:"6px 10px", fontSize:11 }}>
                      <span style={{ color:"#f0d060" }}>{r.year}:</span> <span style={{ color:"#f0e6c8" }}>{r.goals} goals</span> <span style={{ color:"#9ab8a0" }}>({r.avg})</span>
                    </div>
                  ))}
                </div>
                <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                  <input type="number" min="50" max="300" value={tbP1}
                    onChange={e => setTbP1(e.target.value)}
                    placeholder="Your guess…"
                    style={{ ...S.input, width:130, fontSize:20, textAlign:"center", padding:"10px" }}
                    disabled={isGroupRankingsLocked()}
                  />
                  <span style={{ fontSize:13, color:"#9ab8a0" }}>goals</span>
                  {tbP1 && <span style={{ fontSize:13, color:"#f0d060", fontWeight:"bold" }}>✓ {tbP1} goals</span>}
                </div>
                {isGroupRankingsLocked()
                  ? <div style={{ fontSize:11, color:"#ff9090", marginTop:10 }}>🔒 Locked at tournament kickoff</div>
                  : <div style={{ fontSize:11, color:"#9ab8a0", marginTop:10 }}>Locks Jun 11 at noon PT with group rankings</div>
                }
              </div>
            )}

            {/* PHASE 2 KNOCKOUTS */}
            {predTab==="phase2" && (
              <div>
                {isPhase2Locked() ? (
                  <div style={{ background:"rgba(200,60,60,0.15)", border:"1px solid rgba(200,60,60,0.3)", borderRadius:8, padding:"8px 12px", marginBottom:12, fontSize:12, color:"#ff9090" }}>
                    🔒 Knockout picks are locked
                  </div>
                ) : (
                  <div style={{ fontSize:12, color:"#9ab8a0", marginBottom:12 }}>
                    Pick the winner of every knockout match. Locks Jun 28 at 9am PT.<br/>
                    <span style={{ color:"#f0d060" }}>+2</span> R32 · <span style={{ color:"#f0d060" }}>+4</span> R16 · <span style={{ color:"#f0d060" }}>+8</span> QF · <span style={{ color:"#f0d060" }}>+16</span> SF · <span style={{ color:"#f0d060" }}>+32</span> Final
                  </div>
                )}

                {/* Round tabs */}
                <div style={{ display:"flex", gap:4, flexWrap:"wrap", marginBottom:14 }}>
                  {Object.entries(ROUND_LABELS).map(([round, label]) => {
                    const done = (KNOCKOUT_ROUNDS[round]||[]).filter(m => phase2Picks[m.id]).length;
                    const total = (KNOCKOUT_ROUNDS[round]||[]).length;
                    return (
                      <button key={round} style={S.pill(phase2Tab===round)} onClick={() => setPhase2Tab(round)}>
                        {label} {done}/{total}
                      </button>
                    );
                  })}
                </div>

                {/* Matches for selected round */}
                {(KNOCKOUT_ROUNDS[phase2Tab]||[]).map(match => {
                  const pick = phase2Picks[match.id];
                  const actual = livePhase2?.[match.id];
                  const won = actual && pick === actual;
                  const lost = actual && pick && pick !== actual;
                  const pts = ROUND_PTS[phase2Tab];

                  // For R32 we show slot labels since teams aren't known yet
                  // For later rounds we show previous round winners
                  const teamA = match.slotA;
                  const teamB = match.slotB;
                  const isKnownTeam = (slot) => Object.values(TEAMS_BY_GROUP).flat().includes(slot);

                  return (
                    <div key={match.id} style={{ ...S.card, marginBottom:8, borderColor: won?"rgba(100,255,150,0.3)":lost?"rgba(255,100,100,0.2)":"rgba(200,168,75,0.2)" }}>
                      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8, fontSize:11 }}>
                        <span style={{ color:"#9ab8a0" }}>{match.label}</span>
                        <span style={{ color: pts===32?"#ff9f50":pts>=16?"#f0d060":"#9ab8a0", fontWeight:"bold" }}>+{pts} pts</span>
                      </div>
                      {actual && (
                        <div style={{ fontSize:11, marginBottom:8, padding:"4px 8px", borderRadius:4, background: won?"rgba(0,180,80,0.15)":"rgba(180,50,50,0.12)", color: won?"#8fffb0":"#ff9090" }}>
                          Winner: {isKnownTeam(actual) ? `${tf(actual)} ` : ""}{actual} {won?"🎉 +"+pts+" pts":lost?"😬":""}
                        </div>
                      )}
                      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                        {[teamA, teamB].map(team => (
                          <button key={team} onClick={() => {
                            if (isPhase2Locked()) return;
                            setPhase2Picks(prev => ({ ...prev, [match.id]: team }));
                          }} style={{
                            padding:"10px 6px", borderRadius:8, border:"2px solid",
                            borderColor: pick===team?"#f0d060":"rgba(255,255,255,0.1)",
                            background: pick===team?"rgba(200,168,75,0.25)":"rgba(255,255,255,0.04)",
                            color: pick===team?"#f0d060":"#c8b8a0",
                            cursor: isPhase2Locked()?"default":"pointer", fontSize:11, textAlign:"center",
                            opacity: isPhase2Locked() && pick!==team ? 0.5 : 1,
                          }}>
                            {isKnownTeam(team) && <div style={{ marginBottom:4 }}>{tf(team)}</div>}
                            <div style={{ fontWeight: pick===team?"bold":"normal" }}>{team}</div>
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              {/* Phase 2 Tiebreaker — shown when on Final round */}
              {phase2Tab === "final" && (
                <div style={{ ...S.card, marginTop:8, borderColor:"rgba(255,180,50,0.4)", background:"rgba(255,140,0,0.06)" }}>
                  <div style={{ fontSize:11, fontWeight:"bold", color:"#f0d060", marginBottom:6, letterSpacing:1 }}>🔢 PHASE 2 TIEBREAKER</div>
                  <div style={{ fontSize:13, color:"#f0e6c8", marginBottom:8 }}>{TIEBREAKER_P2.question}</div>
                  <div style={{ fontSize:11, color:"#9ab8a0", marginBottom:10, lineHeight:1.5 }}>{TIEBREAKER_P2.hint}</div>
                  <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:10 }}>
                    {TIEBREAKER_P2.references.map(r => (
                      <div key={r.year} style={{ background:"rgba(255,255,255,0.05)", borderRadius:6, padding:"5px 10px", fontSize:11 }}>
                        <span style={{ color:"#f0d060" }}>{r.year}:</span> <span style={{ color:"#f0e6c8" }}>{r.matchup}</span> <span style={{ color:"#9ab8a0" }}>· {r.minute}'</span>
                      </div>
                    ))}
                  </div>
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    <input type="number" min="1" max="120" value={tbP2}
                      onChange={e => setTbP2(e.target.value)}
                      placeholder="Your guess…"
                      style={{ ...S.input, width:120, fontSize:16, textAlign:"center" }}
                      disabled={isPhase2Locked()}
                    />
                    <span style={{ fontSize:12, color:"#9ab8a0" }}>minute</span>
                    {tbP2 && <span style={{ fontSize:12, color:"#f0d060" }}>✓ {tbP2}'</span>}
                  </div>
                  {isPhase2Locked() && <div style={{ fontSize:11, color:"#ff9090", marginTop:6 }}>🔒 Locked</div>}
                </div>
              )}
              </div>
            )}

          </div>
        )}

        {/* ── ADMIN ── */}
        {screen==="admin" && isAdmin && (
          <div>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:14 }}>
              <h2 style={{ margin:0, fontSize:20, color:"#f0d060" }}>⚙️ Admin Panel</h2>
              <div style={{ display:"flex", gap:8 }}>
                <button onClick={exportCSV} style={{ ...S.btn, fontSize:11, padding:"6px 12px" }}>⬇️ Export CSV</button>
                <button onClick={() => { setScreen("home"); setCurrentPlayer(null); setIsAdmin(false); try { localStorage.removeItem("wc2026_session"); localStorage.removeItem("wc2026_admin"); } catch {} }} style={{ background:"rgba(255,255,255,0.07)", border:"1px solid rgba(255,255,255,0.1)", borderRadius:6, padding:"6px 10px", color:"#9ab8a0", cursor:"pointer", fontSize:12 }}>← Logout</button>
              </div>
            </div>
            {/* Pool settings */}
            <div style={S.card}>
              <div style={{ fontSize:11, color:"#9ab8a0", marginBottom:12, letterSpacing:1 }}>💰 POOL SETTINGS</div>

              {/* Entry fee + commissioner cut */}
              <div style={{ display:"flex", gap:12, flexWrap:"wrap", marginBottom:14 }}>
                <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                  <label style={{ fontSize:12, color:"#f0e6c8" }}>Entry fee $</label>
                  <input type="number" min="0" value={editFee} onChange={e => setEditFee(e.target.value)} style={{ ...S.input, width:64, padding:"4px 8px", fontSize:13 }} />
                </div>
                <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                  <label style={{ fontSize:12, color:"#f0e6c8" }}>Commissioner cut $</label>
                  <input type="number" min="0" value={editComm} onChange={e => setEditComm(e.target.value)} style={{ ...S.input, width:64, padding:"4px 8px", fontSize:13 }} />
                </div>
                <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                  <label style={{ fontSize:12, color:"#f0e6c8" }}>Phase 1 split %</label>
                  <input type="number" min="0" max="100" value={editP1Split} onChange={e => setEditP1Split(e.target.value)} style={{ ...S.input, width:56, padding:"4px 8px", fontSize:13 }} />
                  <span style={{ fontSize:11, color:"#9ab8a0" }}>/ P2: {100 - (parseInt(editP1Split)||0)}%</span>
                </div>
              </div>

              {/* Payout % editors */}
              {[["Phase 1 Payouts", editPayouts1, setEditPayouts1], ["Phase 2 Payouts", editPayouts2, setEditPayouts2]].map(([label, pcts, setPcts]) => {
                const total = pcts.reduce((s, v) => s + (parseFloat(v)||0), 0);
                const over = total > 100;
                return (
                  <div key={label} style={{ marginBottom:12 }}>
                    <div style={{ fontSize:11, color:"#f0d060", fontWeight:"bold", marginBottom:6 }}>{label} <span style={{ color: over?"#ff9090":"#9ab8a0", fontWeight:"normal" }}>({total}% of distributable{over?" — over 100%!":""})</span></div>
                    <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                      {["🥇","🥈","🥉","4th","5th"].map((medal, i) => (
                        <div key={i} style={{ display:"flex", alignItems:"center", gap:4 }}>
                          <span style={{ fontSize:12 }}>{medal}</span>
                          <input type="number" min="0" max="100" value={pcts[i]} onChange={e => { const n=[...pcts]; n[i]=e.target.value; setPcts(n); }} style={{ ...S.input, width:52, padding:"3px 6px", fontSize:12, textAlign:"center" }} />
                          <span style={{ fontSize:11, color:"#9ab8a0" }}>%</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}

              <button onClick={async () => {
                const s = {
                  entryFee: parseFloat(editFee)||0,
                  commCut: parseFloat(editComm)||0,
                  p1Split: parseFloat(editP1Split)||50,
                  payouts1: editPayouts1.map(v => parseFloat(v)||0),
                  payouts2: editPayouts2.map(v => parseFloat(v)||0),
                };
                setSettings(s);
                await dbSave(players, predictions, paid, s);
              }} style={{ ...S.btn, fontSize:11, padding:"6px 16px" }}>💾 Save Settings</button>

              {/* Live summary */}
              {(() => {
                const { pot1, pot2, total, commCut, paidCount } = calcPot(players, paid, settings);
                const entryFee = settings.entryFee || 25;
                const refund = Math.min(entryFee, pot1);
                return (
                  <div style={{ fontSize:11, color:"#9ab8a0", marginTop:10, lineHeight:1.8 }}>
                    <div>{paidCount} paid · collected <strong style={{ color:"#f0d060" }}>${total}</strong> · commissioner <strong style={{ color:"#ff9090" }}>−${commCut}</strong> · distributable <strong style={{ color:"#8fffb0" }}>${total - commCut}</strong></div>
                    <div>Phase 1 pot <strong style={{ color:"#f0d060" }}>${pot1}</strong> · Phase 2 pot <strong style={{ color:"#f0d060" }}>${pot2}</strong></div>
                    {paidCount >= 2 && <div style={{ color:"#aab0ff" }}>Last place refund <strong>${entryFee}</strong> per phase</div>}
                  </div>
                );
              })()}
            </div>

            {/* Players + payment tracking */}
            <div style={S.card}>
              <div style={{ fontSize:11, color:"#9ab8a0", marginBottom:10, letterSpacing:1 }}>PLAYERS — track payment & delete</div>
              {players.length === 0 && <div style={{ color:"#9ab8a0", fontSize:12 }}>No players yet.</div>}
              {players.map(p => {

                return (
                  <div key={p.id} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"10px 0", borderBottom:"1px solid rgba(255,255,255,0.05)", gap:8, flexWrap:"wrap" }}>
                    <div style={{ flex:1 }}>
                      <span style={{ fontSize:14, color:"#f0e6c8" }}>{p.name}</span>
                      <span style={{ fontSize:11, color:"#9ab8a0", marginLeft:8 }}>{predictions[p.id] ? "✓ picks" : "no picks"}</span>
                    </div>
                    <div style={{ display:"flex", gap:6, alignItems:"center" }}>
                      {["cash","venmo","unpaid"].map(method => {
                        const isPaid = paid[p.id];
                        const active = method === "unpaid" ? !isPaid : paid[p.id+"_method"] === method;
                        return (
                          <button key={method} onClick={async () => {
                            const newPaid = { ...paid };
                            if (method === "unpaid") {
                              newPaid[p.id] = false;
                              delete newPaid[p.id+"_method"];
                            } else {
                              newPaid[p.id] = true;
                              newPaid[p.id+"_method"] = method;
                            }
                            setPaid(newPaid);
                            await dbSave(players, predictions, newPaid, settings);
                          }} style={{
                            padding:"4px 10px", borderRadius:4, border:"1px solid", fontSize:11, cursor:"pointer",
                            borderColor: active ? "rgba(100,200,100,0.6)" : "rgba(255,255,255,0.15)",
                            background: active ? "rgba(100,200,100,0.2)" : "rgba(255,255,255,0.04)",
                            color: active ? "#8fffb0" : "#9ab8a0",
                          }}>
                            {method === "unpaid" ? "✗ unpaid" : method === "cash" ? "💵 cash" : "💸 venmo"}
                          </button>
                        );
                      })}
                      <button onClick={() => { if(window.confirm(`Delete ${p.name}?`)) deletePlayer(p.id); }} style={{ background:"rgba(200,60,60,0.2)", border:"1px solid rgba(200,60,60,0.4)", borderRadius:6, padding:"4px 10px", color:"#ff8080", cursor:"pointer", fontSize:12 }}>🗑</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── ALL PICKS ── */}
        {screen==="picks" && (
          <div>
            <div style={{ marginBottom:14 }}>
              <h2 style={{ margin:"0 0 4px", fontSize:20, color:"#f0d060" }}>👀 Everyone's Picks</h2>
              <p style={{ fontSize:12, color:"#9ab8a0", margin:0 }}>Picks are visible now that the group stage has locked.</p>
            </div>

            {/* Player selector */}
            <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:16 }}>
              {players.map(p => (
                <button key={p.id}
                  onClick={() => setViewingPlayer(viewingPlayer?.id===p.id ? null : p)}
                  style={{
                    padding:"6px 14px", borderRadius:20, border:"1px solid",
                    borderColor:viewingPlayer?.id===p.id?"#f0d060":"rgba(200,168,75,0.3)",
                    background:viewingPlayer?.id===p.id?"rgba(200,168,75,0.25)":"rgba(200,168,75,0.08)",
                    color:"#f0d060", cursor:"pointer", fontSize:13,
                  }}>{p.name}</button>
              ))}
            </div>

            {viewingPlayer && (() => {
              const pred = predictions[viewingPlayer.id] || {};
              const pts = calcPoints(pred, liveResults);
              return (
                <div>
                  <div style={{ ...S.card, borderColor:"rgba(200,168,75,0.4)" }}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
                      <div style={{ fontSize:16, color:"#f0d060", fontWeight:"bold" }}>{viewingPlayer.name}</div>
                      <div style={{ fontSize:22, fontWeight:"bold", color:"#f0d060" }}>{pts} pts</div>
                    </div>

                    {/* Group rankings */}
                    <div style={{ fontSize:11, color:"#f0d060", fontWeight:"bold", letterSpacing:1, marginBottom:8 }}>🏅 GROUP RANKINGS</div>
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:6, marginBottom:14 }}>
                      {Object.keys(TEAMS_BY_GROUP).map(g => {
                        const ranking = pred.groupRankings?.[g];
                        const actual = liveResults?.groupRankings?.[g];
                        return (
                          <div key={g} style={{ background:"rgba(255,255,255,0.04)", borderRadius:6, padding:"8px 10px" }}>
                            <div style={{ fontSize:10, color:"#f0d060", fontWeight:"bold", marginBottom:4 }}>GROUP {g}</div>
                            {ranking ? ranking.map((team, i) => {
                              const actualPos = actual?.indexOf(team);
                              const correct = actualPos === i;
                              const halfRight = actual && actualPos !== -1 && Math.floor(actualPos/2) === Math.floor(i/2) && !correct;
                              return (
                                <div key={team} style={{ fontSize:11, color: correct?"#8fffb0":halfRight?"#f0d060":"#c8b8a0", display:"flex", alignItems:"center", gap:4, marginBottom:2 }}>
                                  <span>{["🥇","🥈","🥉","4️⃣"][i]}</span>
                                  <span>{tf(team)} {team}</span>
                                  {correct && <span style={{ marginLeft:"auto" }}>+3</span>}
                                  {halfRight && <span style={{ marginLeft:"auto" }}>+1</span>}
                                </div>
                              );
                            }) : <div style={{ fontSize:11, color:"#9ab8a0" }}>No pick</div>}
                          </div>
                        );
                      })}
                    </div>

                    {/* Props */}
                    <div style={{ fontSize:11, color:"#f0d060", fontWeight:"bold", letterSpacing:1, marginBottom:8 }}>🎲 DAILY PROPS</div>
                    {pred.tbP1 !== null && pred.tbP1 !== undefined && (
                      <div style={{ fontSize:12, color:"#9ab8a0", padding:"5px 0", borderBottom:"1px solid rgba(255,255,255,0.05)" }}>
                        🔢 P1 Tiebreaker: <span style={{ color:"#f0d060" }}>{pred.tbP1} goals</span>
                      </div>
                    )}
                    {DAILY_PROPS.map((prop, i) => {
                      const pick = pred.propPicks?.[i];
                      const actual = liveResults?.propResults?.[i];
                      const settled = actual !== null && actual !== undefined;
                      const won = settled && pick === actual;
                      const lost = settled && pick !== null && pick !== undefined && !won;
                      return (
                        <div key={i} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"5px 0", borderBottom:"1px solid rgba(255,255,255,0.05)", fontSize:11, gap:8 }}>
                          <span style={{ color:"#9ab8a0", minWidth:40 }}>{prop.date}</span>
                          <span style={{ flex:1, color:"#c8b8a0" }}>{prop.q.substring(0,50)}…</span>
                          <span style={{ fontWeight:"bold", color: won?"#8fffb0":lost?"#ff9090":pick===true?"#f0d060":pick===false?"#c8b8a0":"#555", minWidth:30, textAlign:"right" }}>
                            {pick===null||pick===undefined ? "—" : pick ? "YES" : "NO"}
                            {won ? " ✓" : lost ? " ✗" : ""}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {!viewingPlayer && (
              <div style={{ color:"#9ab8a0", fontSize:13, textAlign:"center", marginTop:20 }}>
                Select a player above to see their picks
              </div>
            )}
          </div>
        )}

        {/* ── LEADERBOARD ── */}
        {screen==="leaderboard" && (
          <div>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:14 }}>
              <h2 style={{ margin:0, fontSize:20, color:"#f0d060" }}>🏆 Leaderboard</h2>
              <button onClick={refreshScores} disabled={fetchStatus==="loading"} style={{ ...S.btn, fontSize:11, padding:"6px 12px", background:fetchStatus==="loading"?"#444":"linear-gradient(90deg,#c8a84b,#f0d060)" }}>
                {fetchStatus==="loading" ? "⏳ Updating…" : "🔄 Refresh"}
              </button>
            </div>

            {/* Sub-tabs */}
            <div style={{ display:"flex", gap:4, marginBottom:14 }}>
              {[["standings","🏅 Standings"],["chart","📈 Chart"],["h2h","⚔️ H2H"]].map(([t,l]) => (
                <button key={t} style={S.tab(lbTab===t)} onClick={() => setLbTab(t)}>{l}</button>
              ))}
            </div>

            {liveResults && (
              <div style={{ ...S.card, fontSize:12, color:"#9ab8a0", marginBottom:12 }}>
                <span style={{ color:"#f0d060" }}>📡</span> {liveResults.matchday||"Group Stage"} · {Object.values(liveResults.groupRankings||{}).filter(Boolean).length}/12 groups final · {(liveResults.propResults||[]).filter(v=>v!==null).length}/34 props settled
              </div>
            )}

            {lbTab==="standings" && (() => {
              const { pot1, pot2, total, commCut, paidCount } = calcPot(players, paid, settings);
              const entryFee = settings.entryFee || 25;
              const prizes1 = calcPrizes(leaderboard, paid, pot1, entryFee, settings.payouts1);
              const prizes2 = calcPrizes(leaderboard, paid, pot2, entryFee, settings.payouts2);
              const refund1 = entryFee;
              const refund2 = entryFee;
              const dist1 = Math.max(0, pot1 - refund1);
              const dist2 = Math.max(0, pot2 - refund2);
              const pcts1 = settings.payouts1 || [60,25,10,5,0];
              const pcts2 = settings.payouts2 || [60,25,10,5,0];
              return (
                <div>
                  {/* Pot card */}
                  <div style={{ ...S.card, borderColor:"rgba(100,200,100,0.3)", background:"rgba(0,100,40,0.1)", marginBottom:14 }}>
                    <div style={{ fontSize:11, fontWeight:"bold", color:"#8fffb0", marginBottom:8, letterSpacing:1 }}>💰 THE POTS · {paidCount} paid · ${total} collected · 🎩 commissioner ${commCut}</div>
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                      {[[pot1,"PHASE 1 — GROUP STAGE",dist1,pcts1,refund1],[pot2,"PHASE 2 — KNOCKOUTS",dist2,pcts2,refund2]].map(([pot,label,dist,pcts,refund]) => (
                        <div key={label} style={{ background:"rgba(255,255,255,0.04)", borderRadius:8, padding:"8px 10px" }}>
                          <div style={{ fontSize:10, color:"#f0d060", fontWeight:"bold", marginBottom:4 }}>{label}</div>
                          <div style={{ fontSize:16, fontWeight:"bold", color:"#f0d060", marginBottom:4 }}>${pot}</div>
                          {paidCount >= 2 && <div style={{ fontSize:10, color:"#aab0ff", marginBottom:4 }}>↩ last ${refund} · distributable ${dist}</div>}
                          {paidCount >= 2 && dist > 0 && (
                            <div style={{ fontSize:10, color:"#9ab8a0" }}>
                              {["🥇","🥈","🥉","4️⃣","5️⃣"].map((m,i) => pcts[i]>0 ? `${m} $${Math.round(dist*pcts[i]/100)}` : null).filter(Boolean).join(" · ")}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  {leaderboard.length===0 && <div style={{ color:"#9ab8a0" }}>No players yet — go to Home to join!</div>}
                  {leaderboard.map((p, i) => {
                    const pred = predictions[p.id];
                    const grpDone = pred ? Object.keys(pred.groupRankings||{}).length : 0;
                    const prpDone = pred ? (pred.propPicks||[]).filter(x=>x!==null).length : 0;
                    const isLastPaid = leaderboard.filter(x=>paid[x.id]).at(-1)?.id === p.id && paid[p.id];
                    return (
                      <div key={p.id} style={{ display:"flex", alignItems:"center", gap:12, background:i===0?"rgba(200,168,75,0.15)":"rgba(255,255,255,0.04)", borderRadius:8, padding:"12px 14px", marginBottom:8, border:`1px solid ${i===0?"rgba(200,168,75,0.4)":"rgba(255,255,255,0.06)"}` }}>
                        <div style={{ fontSize:20, minWidth:28, textAlign:"center" }}>{i===0?"🥇":i===1?"🥈":i===2?"🥉":i===3?"4️⃣":i===4?"5️⃣":`#${i+1}`}</div>
                        <div style={{ flex:1 }}>
                          <div style={{ fontSize:15, color:i===0?"#f0d060":"#f0e6c8", display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
                            {p.name}
                            {paid[p.id] && <span style={{ fontSize:9, background:"rgba(100,200,100,0.2)", color:"#8fffb0", borderRadius:4, padding:"1px 5px" }}>paid {paid[p.id+"_method"]==="cash"?"💵":"💸"}</span>}
                            {!paid[p.id] && <span style={{ fontSize:9, background:"rgba(200,60,60,0.2)", color:"#ff9090", borderRadius:4, padding:"1px 5px" }}>unpaid</span>}
                            {isLastPaid && <span style={{ fontSize:9, background:"rgba(100,100,200,0.2)", color:"#aab0ff", borderRadius:4, padding:"1px 5px" }}>↩ refund</span>}
                            {prizes1[p.id] && prizes1[p.id] !== refund1 && <span style={{ fontSize:9, background:"rgba(200,168,75,0.3)", color:"#f0d060", borderRadius:4, padding:"1px 5px" }}>P1 💰${prizes1[p.id]}</span>}
                            {prizes2[p.id] && prizes2[p.id] !== refund2 && <span style={{ fontSize:9, background:"rgba(200,168,75,0.3)", color:"#f0d060", borderRadius:4, padding:"1px 5px" }}>P2 💰${prizes2[p.id]}</span>}
                          </div>
                          <div style={{ fontSize:10, color:"#9ab8a0" }}>
                            {pred ? `${grpDone}/12 groups · ${prpDone}/34 props${isPhase2Open() ? ` · ${Object.keys(pred.phase2Picks||{}).length}/${Object.values(KNOCKOUT_ROUNDS).flat().length} bracket` : ""}` : "No predictions yet"}
                          </div>
                        </div>
                        <div>
                          <div style={{ fontSize:26, fontWeight:"bold", color:"#f0d060", textAlign:"right" }}>{p.pts}</div>
                          <div style={{ fontSize:10, color:"#9ab8a0", textAlign:"right" }}>/ {MAX_PTS} pts</div>
                        </div>
                      </div>
                    );
                  })}
                  <div style={{ ...S.card, fontSize:11, color:"#9ab8a0", marginTop:8 }}>
                    Leaderboard syncs every 30s. Phase 2 (knockouts) unlocks after June 27. 🔜
                  </div>
                </div>
              );
            })()}

            {/* POINTS CHART */}
            {lbTab==="chart" && (
              <div style={S.card}>
                <div style={{ fontSize:11, fontWeight:"bold", color:"#f0d060", marginBottom:8, letterSpacing:1 }}>📈 POINTS OVER TIME</div>
                <div style={{ fontSize:11, color:"#9ab8a0", marginBottom:14 }}>Cumulative points per player as daily props settle throughout the tournament.</div>
                <SparklineChart players={players} predictions={predictions} liveResults={liveResults} />
                <div style={{ marginTop:16, borderTop:"1px solid rgba(255,255,255,0.07)", paddingTop:12 }}>
                  {leaderboard.map((p, i) => (
                    <div key={p.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"5px 0" }}>
                      <div style={{ width:10, height:10, borderRadius:"50%", background: PLAYER_COLORS[players.findIndex(pl=>pl.id===p.id) % PLAYER_COLORS.length], flexShrink:0 }} />
                      <div style={{ flex:1, fontSize:13, color:"#f0e6c8" }}>{i===0?"🥇":i===1?"🥈":i===2?"🥉":`#${i+1}`} {p.name}</div>
                      <div style={{ fontSize:16, fontWeight:"bold", color:"#f0d060" }}>{p.pts} pts</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* HEAD-TO-HEAD */}
            {lbTab==="h2h" && (
              <div style={S.card}>
                <div style={{ fontSize:11, fontWeight:"bold", color:"#f0d060", marginBottom:8, letterSpacing:1 }}>⚔️ HEAD-TO-HEAD</div>
                <div style={{ fontSize:12, color:"#9ab8a0", marginBottom:14 }}>Pick two players to compare their picks prop-by-prop and group-by-group.</div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:14 }}>
                  <div>
                    <div style={{ fontSize:10, color:"#f0d060", fontWeight:"bold", marginBottom:6 }}>PLAYER A</div>
                    <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                      {players.map(p => (
                        <button key={p.id} onClick={() => setH2hPlayerA(h2hPlayerA?.id===p.id?null:p)} style={{ padding:"7px 10px", borderRadius:6, border:"1px solid", textAlign:"left", cursor:"pointer", borderColor:h2hPlayerA?.id===p.id?"#f0d060":"rgba(255,255,255,0.1)", background:h2hPlayerA?.id===p.id?"rgba(200,168,75,0.2)":"rgba(255,255,255,0.04)", color:h2hPlayerA?.id===p.id?"#f0d060":"#c8b8a0", fontSize:12 }}>
                          {p.name}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize:10, color:"#60c0ff", fontWeight:"bold", marginBottom:6 }}>PLAYER B</div>
                    <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                      {players.map(p => (
                        <button key={p.id} onClick={() => setH2hPlayerB(h2hPlayerB?.id===p.id?null:p)} style={{ padding:"7px 10px", borderRadius:6, border:"1px solid", textAlign:"left", cursor:"pointer", borderColor:h2hPlayerB?.id===p.id?"#60c0ff":"rgba(255,255,255,0.1)", background:h2hPlayerB?.id===p.id?"rgba(96,192,255,0.2)":"rgba(255,255,255,0.04)", color:h2hPlayerB?.id===p.id?"#60c0ff":"#c8b8a0", fontSize:12 }}>
                          {p.name}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                {h2hPlayerA && h2hPlayerB ? (
                  <button style={{ ...S.btn, width:"100%" }} onClick={() => {}}>
                    ⚔️ {h2hPlayerA.name} vs {h2hPlayerB.name} — tap to compare
                  </button>
                ) : (
                  <div style={{ fontSize:12, color:"#9ab8a0", textAlign:"center" }}>
                    {!h2hPlayerA&&!h2hPlayerB?"Select both players above":!h2hPlayerA?"Select Player A":"Select Player B"}
                  </div>
                )}
                <div style={{ fontSize:11, color:"#9ab8a0", marginTop:10, textAlign:"center" }}>The comparison panel opens as a full overlay once both are selected.</div>
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
