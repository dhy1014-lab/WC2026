import { useState, useEffect, useCallback, useRef } from "react";

// ── FIREBASE CONFIG ───────────────────────────────────────────────────────────
const DB_URL = "https://wc2026-306ec-default-rtdb.firebaseio.com";
// Published Google Sheet (CSV) — unified scoresheet covering Phase 1 props, group results,
// Phase 2 props, knockout bracket, and Golden Boot (one tab, distinguished by "Type" column).
const SCORESHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vTfGJNbabivLzUZLCzx1l3UpotLgZ3odcqtL7h5Z6rn9ukHLpZ_82un2CHQg7hd1CJ0azW2wdH4FRtV/pub?output=csv";
// Build marker — bump this string on each deploy. Helps identify stale tabs running old JS
// (check browser console: a tab logging an old BUILD_ID is running outdated code and should be refreshed).
const BUILD_ID = "2026-06-14-overrides-guard";

async function dbLoad() {
  const r = await fetch(`${DB_URL}/pool.json`);
  if (!r.ok) throw new Error(`Firebase error ${r.status}`);
  const data = await r.json();
  if (!data) return { players: [], predictions: {}, paid: {}, settings: { entryFee: 25, commCut: 20, p1Split: 50, payouts1: [60,25,10,5,0], payouts2: [60,25,10,5,0] }, goldenBoot: null, bracketSlots: null, p2PropResults: null, liveResults: null, bracketWinners: null };
  // Read settled results from pool/settled/* — the canonical source of truth.
  // Fall back to pool/liveResults for migration of any previously-saved data.
  const settled = data.settled || {};
  const legacyLR = data.liveResults || null;
  const propResults = (() => {
    if (settled.propResults) {
      // Firebase stores sparse arrays as objects keyed by index string — normalize to array
      const arr = Array(34).fill(null);
      Object.entries(settled.propResults).forEach(([k, v]) => { arr[parseInt(k, 10)] = v; });
      return arr;
    }
    return legacyLR?.propResults || null;
  })();
  const groupRankings = settled.groupRankings || legacyLR?.groupRankings || null;
  const groupFinal = settled.groupFinal || {};
  const liveResults = (propResults || groupRankings)
    ? { propResults: propResults || Array(34).fill(null), groupRankings: groupRankings || {}, groupFinal, totalGoals: settled.totalGoals ?? legacyLR?.totalGoals ?? null }
    : null;
  // bracketWinners — settled knockout match winners (legacy: data.livePhase2)
  const bracketWinners = settled.bracketWinners || data.livePhase2 || null;
  // p2PropResults — settled P2 prop results (legacy: data.liveP2Props)
  const p2PropResults = settled.p2PropResults || data.liveP2Props || null;
  // goldenBoot — options live at pool/settled/goldenBoot/options, answer at pool/settled/goldenBoot/answer
  // Fall back to pool/goldenBoot for migration
  const settledGb = settled.goldenBoot || null;
  const legacyGb = data.goldenBoot || null;
  const goldenBoot = settledGb
    ? { options: settledGb.options || legacyGb?.options || null, answer: settledGb.answer ?? legacyGb?.answer ?? null }
    : legacyGb || null;
  return {
    players: data.players || [],
    predictions: data.predictions || {},
    paid: data.paid || {},
    settings: data.settings || { entryFee: 25, commCut: 20, p1Split: 50, payouts1: [60,25,10,5,0], payouts2: [60,25,10,5,0] },
    goldenBoot,
    bracketSlots: (settled.bracketSlots ? Object.assign({}, settled.bracketSlots) : null) || data.bracketSlots || null,
    p2PropResults,
    liveResults,
    bracketWinners,
  };
}

async function dbSave(players, predictions, paid, settings, goldenBoot) {
  const body = { players, predictions, paid, settings };
  if (goldenBoot !== undefined) body.goldenBoot = goldenBoot;
  const r = await fetch(`${DB_URL}/pool.json`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Firebase save error ${r.status}`);
  try {
    const entry = { ts: new Date().toISOString(), key: "dbSave", summary: JSON.stringify(Object.keys(body)), stack: (new Error().stack||"").split("\n").slice(2,4).join(" | ") };
    await fetch(`${DB_URL}/pool/_breadcrumbs/dbSave_${Date.now()}.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });
  } catch {}
}

// Patch a single top-level key in pool without overwriting others (used for bracketSlots, goldenBoot, etc.)
async function dbPatch(key, value) {
  const r = await fetch(`${DB_URL}/pool/${key}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  if (!r.ok) throw new Error(`Firebase patch error ${r.status}`);
}

// ── SETTLED RESULTS — PERMANENT PER-KEY WRITES ───────────────────────────────
// Each result lives at its own Firebase path under pool/settled/.
// PUT writes exactly one value and never touches siblings.
// There is no bulk-write path, no clear path, no override system.
// Once written, a value can only be corrected by writing a new value to the same path.
async function settlePut(path, value) {
  const r = await fetch(`${DB_URL}/pool/settled/${path}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  if (!r.ok) throw new Error(`Firebase settle error ${r.status}`);
  try {
    const entry = { ts: new Date().toISOString(), path, value: JSON.stringify(value), stack: (new Error().stack||"").split("\n").slice(2,4).join(" | ") };
    await fetch(`${DB_URL}/pool/_breadcrumbs/settled_${Date.now()}.json`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(entry),
    });
  } catch {}
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
const ADMIN = { name: "admin", password: "admindyjs" };
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

// Normalize variant team names the API might return to our canonical names
const TEAM_NAME_ALIASES = {
  "Czech Republic": "Czechia",
  "Curaçao": "Curacao",
  "United States": "USA",
  "United States of America": "USA",
  "Côte d'Ivoire": "Ivory Coast",
  "Cote d'Ivoire": "Ivory Coast",
  "Democratic Republic of Congo": "DR Congo",
  "Democratic Republic of the Congo": "DR Congo",
};
function normalizeTeamName(name) {
  return TEAM_NAME_ALIASES[name] || name;
}

// Strip any saved group rankings that contain teams not in our current groups
function sanitizeGroupRankings(groupRankings) {
  if (!groupRankings) return {};
  const clean = {};
  Object.entries(groupRankings).forEach(([g, ranking]) => {
    const validTeams = TEAMS_BY_GROUP[g];
    if (!validTeams || !Array.isArray(ranking)) return;
    const normalized = ranking.map(normalizeTeamName);
    if (normalized.every(t => validTeams.includes(t))) {
      clean[g] = normalized;
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
  { date:"Jun 15", label:"Day 5 – Prop A", q:"Will Spain keep a clean sheet vs Cape Verde?",                                  ptsYes:4, ptsNo:6, yes:"Spain shut out Cape Verde",               no:"Cape Verde get on the scoresheet" },
  { date:"Jun 15", label:"Day 5 – Prop B", q:"Will Saudi Arabia beat Uruguay?",                                             ptsYes:9, ptsNo:1, yes:"Saudi Arabia shock result!",              no:"Uruguay win or draw" },
  // Jun 16
  { date:"Jun 16", label:"Day 6 – Prop A", q:"Will Argentina keep a clean sheet vs Algeria?",                               ptsYes:5, ptsNo:5, yes:"Argentina lock it down",                  no:"Algeria get on the board" },
  { date:"Jun 16", label:"Day 6 – Prop B", q:"Will a penalty kick be given (regardless of outcome) in the Argentina vs Algeria match or the Austria vs Jordan match?", ptsYes:6, ptsNo:4, yes:"Spot kick awarded in at least one game", no:"No penalties in either match" },
  // Jun 17
  { date:"Jun 17", label:"Day 7 – Prop A", q:"Will Cristiano Ronaldo score vs DR Congo?",                                   ptsYes:4, ptsNo:6, yes:"CR7 on the scoresheet",                   no:"Ronaldo blanks" },
  { date:"Jun 17", label:"Day 7 – Prop B", q:"Will England vs Croatia produce fewer than 2 total goals?",                  ptsYes:7, ptsNo:3, yes:"Tight affair — 0 or 1 total goals",        no:"2 or more goals in the match" },
  // Jun 18
  { date:"Jun 18", label:"Day 8 – Prop A", q:"Will Mexico beat South Korea?",                                               ptsYes:4, ptsNo:6, yes:"Mexico take the win",                     no:"South Korea win or draw" },
  { date:"Jun 18", label:"Day 8 – Prop B", q:"Will Canada beat Qatar?",                                                      ptsYes:3, ptsNo:7, yes:"Canada take all 3 points vs Qatar",       no:"Qatar win or draw" },
  // Jun 19
  { date:"Jun 19", label:"Day 9 – Prop A", q:"Will the USA beat Australia?",                                                ptsYes:5, ptsNo:5, yes:"USA take all 3 points",                   no:"Australia win or draw" },
  { date:"Jun 19", label:"Day 9 – Prop B", q:"Will Scotland vs Morocco produce 2+ total goals?",                           ptsYes:5, ptsNo:5, yes:"Goals flow in Foxborough",                no:"Tight, low-scoring affair" },
  // Jun 20
  { date:"Jun 20", label:"Day 10 – Prop A", q:"Will a goal be scored in the 81st minute or later (including injury time) in any Jun 20 match?",          ptsYes:3, ptsNo:7, yes:"Late drama somewhere!",                   no:"All goals before the 81st minute" },
  { date:"Jun 20", label:"Day 10 – Prop B", q:"Will Ecuador beat Curaçao?",                                                ptsYes:3, ptsNo:7, yes:"Ecuador take the win",                    no:"Curaçao hold on for a result" },
  // Jun 21
  { date:"Jun 21", label:"Day 11 – Prop A", q:"Will Spain score 2+ goals vs Saudi Arabia?",                                ptsYes:3, ptsNo:7, yes:"Spain put two or more past Saudi Arabia", no:"Saudi Arabia hold Spain to under 2" },
  { date:"Jun 21", label:"Day 11 – Prop B", q:"Will Belgium beat Iran?",                                                   ptsYes:3, ptsNo:7, yes:"Belgium take the win",                    no:"Iran win or draw" },
  // Jun 22
  { date:"Jun 22", label:"Day 12 – Prop A", q:"Will Argentina beat Austria without conceding?",                            ptsYes:6, ptsNo:4, yes:"Argentina clean sheet win",               no:"Austria score or Argentina don't win" },
  { date:"Jun 22", label:"Day 12 – Prop B", q:"Will France vs Iraq produce 4+ total goals?",                               ptsYes:4, ptsNo:6, yes:"4 or more goals — entertaining stuff",  no:"Under 4 goals" },
  // Jun 23
  { date:"Jun 23", label:"Day 13 – Prop A", q:"Will Portugal beat Uzbekistan by 2+ goals?",                               ptsYes:3, ptsNo:7, yes:"Portugal comfortable win",               no:"Uzbekistan keep it within 1" },
  { date:"Jun 23", label:"Day 13 – Prop B", q:"Will England vs Ghana see both teams receive a yellow card?",               ptsYes:3, ptsNo:7, yes:"Both sides in the book",                 no:"At least one side stays card-free" },
  // Jun 24
  { date:"Jun 24", label:"Day 14 – Prop A", q:"Will Neymar register a goal or assist in Brazil's final group match vs Scotland?",   ptsYes:5, ptsNo:5, yes:"Neymar directly involved",     no:"Neymar blanks" },
  { date:"Jun 24", label:"Day 14 – Prop B", q:"Will Alphonso Davies register a goal or assist for Canada vs Switzerland?",  ptsYes:6, ptsNo:4, yes:"Davies makes his mark",                   no:"Davies blanks" },
  // Jun 25
  { date:"Jun 25", label:"Day 15 – Prop A", q:"Will Christian Pulisic register a goal or assist for the USA vs Turkey?",           ptsYes:5, ptsNo:5, yes:"Pulisic delivers",               no:"Pulisic blanks" },
  { date:"Jun 25", label:"Day 15 – Prop B", q:"Will Germany vs Ecuador produce 4+ total goals?",                                   ptsYes:6, ptsNo:4, yes:"High-scoring clash",              no:"Under 4 total goals" },
  // Jun 26
  { date:"Jun 26", label:"Day 16 – Prop A", q:"Will Erling Haaland score vs France?",                                     ptsYes:7, ptsNo:3, yes:"Haaland on the scoresheet",              no:"Haaland blanks" },
  { date:"Jun 26", label:"Day 16 – Prop B", q:"Will a goal be scored in the 85th minute or later (including injury time) in any Jun 26 match?",       ptsYes:3, ptsNo:7, yes:"Late drama on Day 16!",                  no:"No goals in the 85th minute or later" },
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
const GROUP_STAGE_END = new Date("2026-06-28T04:00:00Z"); // Jun 27 midnight PT
const RESULT_GRACE_MS = 3 * 60 * 60 * 1000;
function isGroupStageComplete() { return new Date() >= GROUP_STAGE_END; }
function isGroupResultsExpected() { return new Date() >= new Date(GROUP_STAGE_END.getTime() + RESULT_GRACE_MS); }
function isPropLocked(i) { return new Date() >= PROP_LOCKS[i]; }
function isPropResultExpected(i) { return PROP_LOCKS[i] && new Date() >= new Date(PROP_LOCKS[i].getTime() + RESULT_GRACE_MS); }


// ── PHASE 2 KNOCKOUT BRACKET ─────────────────────────────────────────────────
// Phase 2 opens after group stage (Jun 27 evening) and locks at first R32 kickoff.
// Bracket, Golden Boot, and the P2 tiebreaker all lock at this same moment —
// first kickoff of the knockout stage (Match 73, 2A v 2B, 3pm ET).
const PHASE2_OPEN  = new Date("2026-06-28T00:00:00Z"); // Jun 27 8pm ET
const PHASE2_LOCK  = new Date("2026-06-28T19:00:00Z"); // Jun 28 3pm ET — M73 kickoff

function isPhase2Open()   { return new Date() >= PHASE2_OPEN; }
function isPhase2Locked() { return new Date() >= PHASE2_LOCK; }

// Round point values
const ROUND_PTS = { r32: 4, r16: 8, qf: 16, sf: 32, final: 64, third: 8 };

// Knockout rounds structure — team slots filled from group results
// Before group stage ends, slots show as "TBD (Group X Winner)" etc.
const KNOCKOUT_ROUNDS = {
  // R32: official FIFA bracket (Match 73–88)
  // Array order below = true visual bracket lane (verified against FIFA's published
  // R16/QF/SF feed, e.g. M93=W83vW84, M98=W93vW94, M101=W97vW98 — all left lane).
  // Left lane (first 8):  M74, M77, M73, M75, M83, M84, M81, M82
  // Right lane (last 8):  M76, M78, M79, M80, M86, M88, M85, M87
  // Order within each lane is paired so adjacent r32 entries feed the same r16 entry,
  // and adjacent r16 entries feed the same qf entry — keeps the visual nesting honest.
  r32: [
    { id:"r32_2",  label:"M74",  slotA:"1E",      slotB:"3ABCDF"  }, // 1E vs 3rd(A/B/C/D/F)
    { id:"r32_5",  label:"M77",  slotA:"1I",      slotB:"3CDFGH"  }, // 1I vs 3rd(C/D/F/G/H)
    { id:"r32_1",  label:"M73",  slotA:"2A",      slotB:"2B"      }, // 2A vs 2B
    { id:"r32_3",  label:"M75",  slotA:"1F",      slotB:"2C"      }, // 1F vs 2C
    { id:"r32_11", label:"M83",  slotA:"2K",      slotB:"2L"      }, // 2K vs 2L
    { id:"r32_12", label:"M84",  slotA:"1H",      slotB:"2J"      }, // 1H vs 2J
    { id:"r32_9",  label:"M81",  slotA:"1D",      slotB:"3BEFIJ"  }, // 1D vs 3rd(B/E/F/I/J)
    { id:"r32_10", label:"M82",  slotA:"1G",      slotB:"3AEHIJ"  }, // 1G vs 3rd(A/E/H/I/J)
    { id:"r32_4",  label:"M76",  slotA:"1C",      slotB:"2F"      }, // 1C vs 2F
    { id:"r32_6",  label:"M78",  slotA:"2E",      slotB:"2I"      }, // 2E vs 2I
    { id:"r32_7",  label:"M79",  slotA:"1A",      slotB:"3CEFHI"  }, // 1A vs 3rd(C/E/F/H/I)
    { id:"r32_8",  label:"M80",  slotA:"1L",      slotB:"3EHIJK"  }, // 1L vs 3rd(E/H/I/J/K)
    { id:"r32_14", label:"M86",  slotA:"1J",      slotB:"2H"      }, // 1J vs 2H
    { id:"r32_16", label:"M88",  slotA:"2D",      slotB:"2G"      }, // 2D vs 2G
    { id:"r32_13", label:"M85",  slotA:"1B",      slotB:"3EFGIJ"  }, // 1B vs 3rd(E/F/G/I/J)
    { id:"r32_15", label:"M87",  slotA:"1K",      slotB:"3DEIJL"  }, // 1K vs 3rd(D/E/I/J/L)
  ],
  // R16: official FIFA bracket (Match 89–96) — non-sequential R32 feed
  // Left lane (first 4): M89, M90, M93, M94 — feed qf_1/qf_2
  // Right lane (last 4): M91, M92, M95, M96 — feed qf_3/qf_4
  r16: [
    { id:"r16_1", label:"M89", slotA:"W_r32_2",  slotB:"W_r32_5"  }, // W74 vs W77
    { id:"r16_2", label:"M90", slotA:"W_r32_1",  slotB:"W_r32_3"  }, // W73 vs W75
    { id:"r16_5", label:"M93", slotA:"W_r32_11", slotB:"W_r32_12" }, // W83 vs W84
    { id:"r16_6", label:"M94", slotA:"W_r32_9",  slotB:"W_r32_10" }, // W81 vs W82
    { id:"r16_3", label:"M91", slotA:"W_r32_4",  slotB:"W_r32_6"  }, // W76 vs W78
    { id:"r16_4", label:"M92", slotA:"W_r32_7",  slotB:"W_r32_8"  }, // W79 vs W80
    { id:"r16_7", label:"M95", slotA:"W_r32_14", slotB:"W_r32_16" }, // W86 vs W88
    { id:"r16_8", label:"M96", slotA:"W_r32_13", slotB:"W_r32_15" }, // W85 vs W87
  ],
  // QF: official FIFA bracket (Match 97–100) — non-sequential R16 feed
  qf: [
    { id:"qf_1", label:"M97",  slotA:"W_r16_1", slotB:"W_r16_2" }, // W89 vs W90
    { id:"qf_2", label:"M98",  slotA:"W_r16_5", slotB:"W_r16_6" }, // W93 vs W94
    { id:"qf_3", label:"M99",  slotA:"W_r16_3", slotB:"W_r16_4" }, // W91 vs W92
    { id:"qf_4", label:"M100", slotA:"W_r16_7", slotB:"W_r16_8" }, // W95 vs W96
  ],
  // SF: W(qf_1 vs qf_2) and W(qf_3 vs qf_4)
  sf:    Array.from({length:2},  (_,i) => ({ id:`sf_${i+1}`,   label:`SF Match ${i+1}`,   slotA:`W_qf_${i*2+1}`,  slotB:`W_qf_${i*2+2}` })),
  third: [{ id:"third_1", label:"3rd Place", slotA:"L_sf_1", slotB:"L_sf_2" }],
  final: [{ id:"final_1", label:"Final", slotA:"W_sf_1", slotB:"W_sf_2" }],
};

const ROUND_LABELS = { r32:"Round of 32", r16:"Round of 16", qf:"Quarter-Finals", sf:"Semi-Finals", third:"3rd Place", final:"Final" };

// Bracket tree — maps each match to which match its winner feeds into
// Used to cascade-clear conflicting picks when a pick changes
const BRACKET_FEED = {
  // R32 → R16 (non-sequential per official bracket)
  r32_1:"r16_2",  r32_2:"r16_1",   // M73→M90, M74→M89
  r32_3:"r16_2",  r32_4:"r16_3",   // M75→M90, M76→M91
  r32_5:"r16_1",  r32_6:"r16_3",   // M77→M89, M78→M91
  r32_7:"r16_4",  r32_8:"r16_4",   // M79→M92, M80→M92
  r32_9:"r16_6",  r32_10:"r16_6",  // M81→M94, M82→M94
  r32_11:"r16_5", r32_12:"r16_5",  // M83→M93, M84→M93
  r32_13:"r16_8", r32_14:"r16_7",  // M85→M96, M86→M95
  r32_15:"r16_8", r32_16:"r16_7",  // M87→M96, M88→M95
  // R16 → QF (non-sequential per official bracket)
  r16_1:"qf_1", r16_2:"qf_1",  // M89,M90 → M97
  r16_3:"qf_3", r16_4:"qf_3",  // M91,M92 → M99
  r16_5:"qf_2", r16_6:"qf_2",  // M93,M94 → M98
  r16_7:"qf_4", r16_8:"qf_4",  // M95,M96 → M100
  // QF → SF
  qf_1:"sf_1", qf_2:"sf_1",
  qf_3:"sf_2", qf_4:"sf_2",
  // SF → Final
  sf_1:"final_1", sf_2:"final_1",
};

// Get all downstream match IDs that depend on a given match's winner
function getDownstreamMatches(matchId) {
  const downstream = [];
  let current = BRACKET_FEED[matchId];
  while (current) {
    downstream.push(current);
    current = BRACKET_FEED[current];
  }
  // SF losers also feed 3rd place
  if (matchId === "sf_1" || matchId === "sf_2") downstream.push("third_1");
  return downstream;
}

// Find a match definition by id across all rounds
function findKnockoutMatch(matchId) {
  for (const round of Object.values(KNOCKOUT_ROUNDS)) {
    const m = round.find(mm => mm.id === matchId);
    if (m) return m;
  }
  return null;
}

// Resolve a stored bracket PICK (always a raw terminal code like "1A"/"3ABCDF", or
// already a real team name once that part of the bracket has actually been decided)
// into a team name for scoring/comparison. Unlike resolveBracketSlot (which is for
// resolving the official slot DEFINITIONS and only ever sees the 4 known patterns),
// this always has a final fallback: a pick that doesn't match a known code pattern
// is already a real team name, so it's returned as-is.
// Deliberately NOT gated on groupFinal — by the time a knockout match has an actual
// result, its feeding group(s) are necessarily over in reality, so scoring should use
// the best-available group data rather than wait on the admin's Final toggle.
function resolvePickToTeam(pick, { groupRankings, bracketSlots }) {
  if (pick == null) return null;
  if (/^[12][A-L]$/.test(pick)) {
    const pos = pick[0] === "1" ? 0 : 1;
    const g = pick[1];
    return groupRankings?.[g]?.[pos] || pick;
  }
  if (/^3[A-Z]+$/.test(pick)) {
    return bracketSlots?.[pick] || pick;
  }
  return pick;
}

// Resolve a bracket slot (1A, 2C, 3ABCDF, W_r32_1, L_sf_1, ...) to a team name (or null if unresolved).
// - 1X/2X resolve directly from groupRankings[X][0]/[1] (1st/2nd place)
// - 3xxx resolve from bracketSlots (best-3rd-place per FIFA draw combination — admin-entered, not derivable client-side)
// - W_matchId resolves from winnersMap[matchId] (falls back to bracketWinners[matchId])
// - L_sf_X resolves to the non-winner of that SF match
function resolveBracketSlot(slot, { groupRankings, bracketSlots, winnersMap, bracketWinners }) {
  if (!slot) return null;
  if (/^[12][A-L]$/.test(slot)) {
    const pos = slot[0] === "1" ? 0 : 1;
    const g = slot[1];
    return groupRankings?.[g]?.[pos] || null;
  }
  if (slot.startsWith("3")) {
    return bracketSlots?.[slot] || null;
  }
  if (slot.startsWith("W_")) {
    const matchId = slot.slice(2);
    return (winnersMap && winnersMap[matchId]) || bracketWinners?.[matchId] || null;
  }
  if (slot.startsWith("L_")) {
    const matchId = slot.slice(2);
    const winner = (winnersMap && winnersMap[matchId]) || bracketWinners?.[matchId] || null;
    if (!winner) return null;
    const m = findKnockoutMatch(matchId);
    if (!m) return null;
    const teamA = resolveBracketSlot(m.slotA, { groupRankings, bracketSlots, winnersMap, bracketWinners });
    const teamB = resolveBracketSlot(m.slotB, { groupRankings, bracketSlots, winnersMap, bracketWinners });
    if (teamA && teamA !== winner) return teamA;
    if (teamB && teamB !== winner) return teamB;
    return null;
  }
  return null;
}

// ── PHASE 2 PROPS ─────────────────────────────────────────────────────────────
// 15 props across 5 rounds (3 per round), each locking at that round's first kickoff
// ptsYes + ptsNo = 10 (weighted by likelihood); Golden Boot prop (#15) sums to 20
const P2_PROPS = [
  // R32 props — lock Jun 28 3pm ET (first R32 kickoff)
  { round:"r32", id:"p2_r32_a", q:"Will at least one R32 match be decided by a single goal in regulation?",         ptsYes:4, ptsNo:6, yes:"Single-goal winner somewhere",       no:"All R32 winners win by 2+" },
  { round:"r32", id:"p2_r32_b", q:"Will at least one top-10 FIFA-ranked team be eliminated in the R32?",           ptsYes:5, ptsNo:5, yes:"Top-10 side knocked out",             no:"All top-10 sides survive" },
  { round:"r32", id:"p2_r32_c", q:"Will there be a hat-trick in any R32 match (regulation or ET)?",               ptsYes:9, ptsNo:1, yes:"Hat-trick hero!",                     no:"No hat-tricks in the R32" },
  // R16 props — lock Jul 4 1pm ET (first R16 kickoff)
  { round:"r16", id:"p2_r16_a", q:"Will a match-deciding goal be scored in 90+ stoppage time in any R16 match (regulation only)?", ptsYes:5, ptsNo:5, yes:"Late drama wins it!", no:"No stoppage-time deciders" },
  { round:"r16", id:"p2_r16_b", q:"Will at least 3 of the 8 R16 matches go to ET or penalties?",                  ptsYes:5, ptsNo:5, yes:"3+ R16 matches go long",             no:"Fewer than 3 go to ET/pens" },
  { round:"r16", id:"p2_r16_c", q:"Will a team from outside Europe or South America win an R16 match in regulation?", ptsYes:5, ptsNo:5, yes:"Non-Euro/SA side wins in 90",   no:"Only Euro/SA sides win in regulation" },
  // QF props — lock Jul 9 4pm ET (first QF kickoff)
  { round:"qf",  id:"p2_qf_a",  q:"Will at least one QF be decided by penalties?",                                ptsYes:5, ptsNo:5, yes:"QF goes to a shootout",              no:"No QF shootouts" },
  { round:"qf",  id:"p2_qf_b",  q:"Will there be a red card in any QF match (regulation or ET)?",                 ptsYes:6, ptsNo:4, yes:"Someone sees red in the QFs",         no:"All QFs stay at 11 v 11" },
  { round:"qf",  id:"p2_qf_c",  q:"Will any QF winner win by 2+ goals in regulation?",                            ptsYes:4, ptsNo:6, yes:"Comfortable QF win by 2+",           no:"All QFs tight — 1 goal or less in regulation" },
  // SF props — lock Jul 14 3pm ET (first SF kickoff)
  { round:"sf",  id:"p2_sf_a",  q:"Will at least one SF produce 3+ total goals in regulation?",                   ptsYes:5, ptsNo:5, yes:"3+ goals in a SF",                   no:"Both SFs stay under 3 goals in regulation" },
  { round:"sf",  id:"p2_sf_b",  q:"Will either SF see a team fall behind and come back to win in regulation or ET?", ptsYes:5, ptsNo:5, yes:"Comeback win in a SF",           no:"No SF comebacks" },
  { round:"sf",  id:"p2_sf_c",  q:"Will there be an own goal in either SF (regulation or ET)?",                   ptsYes:7, ptsNo:3, yes:"Own goal in a SF",                   no:"No SF own goals" },
  // Final props — lock Jul 19 3pm ET (Final kickoff)
  { round:"final", id:"p2_final_a", q:"Will the Final go to ET or penalties?",                                    ptsYes:5, ptsNo:5, yes:"Final goes beyond 90",               no:"Final decided in regulation" },
  { round:"final", id:"p2_final_b", q:"Will there be a red card in the Final (regulation or ET)?",                ptsYes:8, ptsNo:2, yes:"Red card in the Final!",              no:"No red cards in the Final" },
  { round:"final", id:"p2_final_c", q:"Will the Final's first goal come from outside the box?",                   ptsYes:7, ptsNo:3, yes:"Long-range opener!",                  no:"First goal from inside the box" },
];

// Golden Boot prop — multi-choice, locks at first R32 kickoff (same moment as bracket lock)
// options populated by auto-fetch after group stage; weights set dynamically
// stored in Firebase at pool.goldenBoot: { options: [{name, pts}], answer: name|null }
const GOLDEN_BOOT_LOCK = new Date("2026-06-28T19:00:00Z"); // Jun 28 3pm ET — M73 kickoff
function isGoldenBootLocked() { return new Date() >= GOLDEN_BOOT_LOCK; }

// Per-round lock times for P2 props — each round's props lock at the kickoff of
// that round's first match (confirmed FIFA schedule).
const P2_PROP_LOCKS = {
  r32:   new Date("2026-06-28T19:00:00Z"), // Jun 28 3pm ET — M73 (2A v 2B)
  r16:   new Date("2026-07-04T17:00:00Z"), // Jul 4 1pm ET — M89 (Houston)
  qf:    new Date("2026-07-09T20:00:00Z"), // Jul 9 4pm ET — M97 (Foxborough)
  sf:    new Date("2026-07-14T19:00:00Z"), // Jul 14 3pm ET — M101 (Arlington)
  final: new Date("2026-07-19T19:00:00Z"), // Jul 19 3pm ET — M104 (MetLife)
};
function isP2PropRoundLocked(round) { return new Date() >= (P2_PROP_LOCKS[round] || new Date("2099-01-01")); }
function isP2RoundResultExpected(round) { const t = P2_PROP_LOCKS[round]; return t && new Date() >= new Date(t.getTime() + RESULT_GRACE_MS); }

function calcPhase2Points(phase2Picks, bracketWinners, p2PropResults, goldenBoot, p2PropPicks, goldenBootPick, groupRankings, bracketSlots) {
  let pts = 0;
  // Bracket points (includes third place)
  if (phase2Picks && bracketWinners) {
    Object.entries(ROUND_PTS).forEach(([round, roundPts]) => {
      const matches = KNOCKOUT_ROUNDS[round] || [];
      matches.forEach(match => {
        const rawPick = phase2Picks[match.id];
        const actual = bracketWinners?.[match.id];
        if (!rawPick || !actual) return;
        const pick = resolvePickToTeam(rawPick, { groupRankings, bracketSlots });
        if (pick === actual) pts += roundPts;
      });
    });
  }
  // P2 prop points — picks stored in p2PropPicks, not phase2Picks
  if (p2PropPicks && p2PropResults) {
    P2_PROPS.forEach(prop => {
      const pick = p2PropPicks[prop.id];
      const actual = p2PropResults?.[prop.id];
      if (pick === null || pick === undefined || actual === null || actual === undefined) return;
      if (pick === actual) pts += actual ? prop.ptsYes : prop.ptsNo;
    });
  }
  // Golden Boot points — pick stored in goldenBootPick, not phase2Picks
  if (goldenBootPick && goldenBoot?.answer && goldenBoot?.options) {
    const answer = goldenBoot.answer;
    if (goldenBootPick === answer) {
      const opt = goldenBootPick === "Other"
        ? { pts: 20 }
        : goldenBoot.options.find(o => o.name === goldenBootPick);
      if (opt) pts += opt.pts;
    } else if (goldenBootPick === "Other" && !goldenBoot.options.some(o => o.name === answer)) {
      // "Other" wins if the actual winner isn't one of the named options
      pts += 20;
    }
  }
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

function calcPoints(pred, live, finalOnly) {
  if (!pred || !live) return 0;
  let pts = 0;
  Object.entries(pred.groupRankings || {}).forEach(([g, ranking]) => {
    if (finalOnly && !live.groupFinal?.[g]) return;
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

const MAX_RANKING_PTS = 12 * 4 * 6; // 288
const MAX_PROP_PTS = DAILY_PROPS.reduce((s, p) => s + Math.max(p.ptsYes, p.ptsNo), 0);
const MAX_PTS = MAX_RANKING_PTS + MAX_PROP_PTS;
// Phase 2 max: bracket + props + golden boot (max option 20)
const MAX_BRACKET_PTS = Object.entries(ROUND_PTS).reduce((s, [round, pts]) => s + (KNOCKOUT_ROUNDS[round]||[]).length * pts, 0);
const MAX_P2_PROP_PTS = P2_PROPS.reduce((s, p) => s + Math.max(p.ptsYes, p.ptsNo), 0);
const MAX_PHASE2_PTS = MAX_BRACKET_PTS + MAX_P2_PROP_PTS + 20; // +20 for golden boot "Other"

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

// ── PROP RESULTS GOOGLE SHEET IMPORT ──────────────────────────────────────────
// Minimal CSV parser — handles quoted fields with embedded commas/quotes (RFC4180-ish)
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i+1];
    if (inQuotes) {
      if (c === '"' && next === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ""; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && next === '\n') i++;
        row.push(field); field = "";
        if (row.length > 1 || row[0] !== "") rows.push(row);
        row = [];
      } else field += c;
    }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Fetch the unified scoresheet CSV once and group rows by their "Type" column.
// Returns { prop1: [...], group: [...], prop2: [...], bracket: [...], goldenboot: [...] }
// Each row is an object keyed by header name (lowercased): type, id, field1..field6, result, ptsawarded, locked, notes
async function fetchScoresheet() {
  const r = await fetch(SCORESHEET_CSV_URL);
  if (!r.ok) throw new Error(`Sheet fetch error ${r.status}`);
  const text = await r.text();
  const rows = parseCSV(text);
  if (!rows.length) throw new Error("Sheet returned no rows");
  const header = rows[0].map(h => h.trim().toLowerCase());
  const typeCol = header.indexOf("type");
  if (typeCol === -1) throw new Error("Sheet missing 'Type' column");
  const grouped = { prop1: [], group: [], prop2: [], bracket: [], goldenboot: [] };
  for (let i = 1; i < rows.length; i++) {
    const cols = rows[i];
    if (!cols || cols.length <= typeCol) continue;
    const type = (cols[typeCol] || "").trim().toLowerCase();
    if (!grouped[type]) continue; // skip unknown/blank row types
    const obj = {};
    header.forEach((h, idx) => { obj[h] = (cols[idx] !== undefined ? cols[idx] : "").trim(); });
    grouped[type].push(obj);
  }
  return grouped;
}

// Parse a YES/NO/blank string into true/false/null
function parseYesNo(val) {
  const v = (val || "").trim().toUpperCase();
  return v === "YES" ? true : v === "NO" ? false : null;
}

// ── MATCH TICKER (live + upcoming) ───────────────────────────────────────────
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

  if (diff === 0) return (
    <div style={{ ...S.card, background:"linear-gradient(135deg,rgba(10,22,40,0.9),rgba(13,32,64,0.9))", borderColor:"rgba(200,168,75,0.5)", textAlign:"center", padding:"18px 14px" }}>
      <div style={{ fontSize:13, fontWeight:"bold", color:"#f0d060", letterSpacing:2 }}>🏆 TOURNAMENT UNDERWAY</div>
      <div style={{ fontSize:11, color:"#9ab8a0", marginTop:6 }}>2026 FIFA World Cup · Jun 11 – Jul 19</div>
    </div>
  );

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
function H2HModal({ playerA, playerB, predictions, liveResults, bracketWinners, bracketSlots, p2PropResults, goldenBoot, phase, onClose }) {
  const predA = predictions[playerA.id] || {};
  const predB = predictions[playerB.id] || {};

  // ── P1 stats ──
  const propResults = liveResults?.propResults || [];
  let p1Agree = 0, p1Disagree = 0, p1AWins = 0, p1BWins = 0;
  DAILY_PROPS.forEach((_, i) => {
    const pa = predA.propPicks?.[i], pb = predB.propPicks?.[i];
    const actual = propResults[i];
    if (pa == null || pb == null) return;
    if (pa === pb) p1Agree++;
    else { p1Disagree++; if (actual != null) { if (pa === actual) p1AWins++; if (pb === actual) p1BWins++; } }
  });
  const ptsA = calcPoints(predA, liveResults);
  const ptsB = calcPoints(predB, liveResults);

  // ── P2 stats ──
  const allP2Matches = Object.values(KNOCKOUT_ROUNDS).flat();
  let p2Agree = 0, p2Disagree = 0, p2AWins = 0, p2BWins = 0;
  allP2Matches.forEach(m => {
    const rawA = predA.phase2Picks?.[m.id], rawB = predB.phase2Picks?.[m.id];
    const actual = bracketWinners?.[m.id];
    if (!rawA || !rawB) return;
    const pa = resolvePickToTeam(rawA, { groupRankings: liveResults?.groupRankings, bracketSlots });
    const pb = resolvePickToTeam(rawB, { groupRankings: liveResults?.groupRankings, bracketSlots });
    if (pa === pb) p2Agree++;
    else { p2Disagree++; if (actual) { if (pa === actual) p2AWins++; if (pb === actual) p2BWins++; } }
  });
  P2_PROPS.forEach(prop => {
    const pa = predA.p2PropPicks?.[prop.id], pb = predB.p2PropPicks?.[prop.id];
    const actual = p2PropResults?.[prop.id];
    if (pa == null || pb == null) return;
    if (pa === pb) p2Agree++;
    else { p2Disagree++; if (actual != null) { if (pa === actual) p2AWins++; if (pb === actual) p2BWins++; } }
  });
  const pts2A = calcPhase2Points(predA.phase2Picks, bracketWinners, p2PropResults, goldenBoot, predA.p2PropPicks, predA.goldenBootPick, liveResults?.groupRankings, bracketSlots);
  const pts2B = calcPhase2Points(predB.phase2Picks, bracketWinners, p2PropResults, goldenBoot, predB.p2PropPicks, predB.goldenBootPick, liveResults?.groupRankings, bracketSlots);

  const isP1 = phase === "p1";
  const displayPtsA = isP1 ? ptsA : pts2A;
  const displayPtsB = isP1 ? ptsB : pts2B;
  const agree = isP1 ? p1Agree : p2Agree;
  const disagree = isP1 ? p1Disagree : p2Disagree;
  const aWins = isP1 ? p1AWins : p2AWins;
  const bWins = isP1 ? p1BWins : p2BWins;

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.78)", zIndex:500, display:"flex", alignItems:"center", justifyContent:"center", padding:16 }} onClick={onClose}>
      <div style={{ background:"#0d2040", border:"1px solid rgba(200,168,75,0.4)", borderRadius:14, padding:20, maxWidth:520, width:"100%", maxHeight:"82vh", overflowY:"auto" }} onClick={e => e.stopPropagation()}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
          <div style={{ fontSize:16, color:"#f0d060", fontWeight:"bold" }}>⚔️ H2H · {isP1 ? "Phase 1" : "Phase 2"}</div>
          <button onClick={onClose} style={{ background:"none", border:"none", color:"#9ab8a0", cursor:"pointer", fontSize:18 }}>✕</button>
        </div>

        {/* Score header */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr auto 1fr", gap:8, marginBottom:16, alignItems:"center" }}>
          <div style={{ background:"rgba(200,168,75,0.1)", borderRadius:8, padding:"10px 12px", textAlign:"center" }}>
            <div style={{ fontSize:14, color:"#f0d060", fontWeight:"bold" }}>{playerA.realName ? `${playerA.name} (${playerA.realName})` : playerA.name}</div>
            <div style={{ fontSize:28, fontWeight:"bold", color:"#f0d060" }}>{displayPtsA}</div>
            <div style={{ fontSize:10, color:"#9ab8a0" }}>pts</div>
          </div>
          <div style={{ fontSize:12, color:"#9ab8a0", textAlign:"center" }}>VS</div>
          <div style={{ background:"rgba(96,192,255,0.1)", borderRadius:8, padding:"10px 12px", textAlign:"center" }}>
            <div style={{ fontSize:14, color:"#60c0ff", fontWeight:"bold" }}>{playerB.realName ? `${playerB.name} (${playerB.realName})` : playerB.name}</div>
            <div style={{ fontSize:28, fontWeight:"bold", color:"#60c0ff" }}>{displayPtsB}</div>
            <div style={{ fontSize:10, color:"#9ab8a0" }}>pts</div>
          </div>
        </div>

        {/* Agreement stats */}
        <div style={{ ...S.card, display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8, textAlign:"center", marginBottom:12 }}>
          <div><div style={{ fontSize:18, fontWeight:"bold", color:"#8fffb0" }}>{agree}</div><div style={{ fontSize:10, color:"#9ab8a0" }}>agree</div></div>
          <div><div style={{ fontSize:18, fontWeight:"bold", color:"#ff9090" }}>{disagree}</div><div style={{ fontSize:10, color:"#9ab8a0" }}>clash</div></div>
          <div>
            <div style={{ fontSize:10, color:"#9ab8a0" }}>clash wins</div>
            <div style={{ fontSize:12 }}><span style={{ color:"#f0d060" }}>{playerA.name} {aWins}</span>{" – "}<span style={{ color:"#60c0ff" }}>{bWins} {playerB.name}</span></div>
          </div>
        </div>

        {/* ── P1 CONTENT ── */}
        {isP1 && (<>
          <div style={{ fontSize:11, fontWeight:"bold", color:"#f0d060", letterSpacing:1, marginBottom:8 }}>🎲 DAILY PROPS</div>
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
        </>)}

        {/* ── P2 CONTENT ── */}
        {!isP1 && (<>
          <div style={{ fontSize:11, fontWeight:"bold", color:"#f0d060", letterSpacing:1, marginBottom:8 }}>🏆 BRACKET PICKS</div>
          {Object.entries(ROUND_LABELS).map(([round, roundLabel]) => {
            const matches = KNOCKOUT_ROUNDS[round] || [];
            return (
              <div key={round} style={{ marginBottom:10 }}>
                <div style={{ fontSize:10, color:"#9ab8a0", fontWeight:"bold", letterSpacing:1, marginBottom:4 }}>{roundLabel.toUpperCase()}</div>
                {matches.map(m => {
                  const pa = predA.phase2Picks?.[m.id], pb = predB.phase2Picks?.[m.id];
                  const actual = bracketWinners?.[m.id];
                  const same = pa && pb && pa === pb;
                  const diff = pa && pb && pa !== pb;
                  const pts = ROUND_PTS[round];
                  return (
                    <div key={m.id} style={{ display:"flex", alignItems:"center", gap:6, padding:"4px 0", borderBottom:"1px solid rgba(255,255,255,0.04)", fontSize:10 }}>
                      <span style={{ color:"#9ab8a0", minWidth:56, fontSize:9 }}>{m.label}</span>
                      <span style={{ flex:1, color: pa&&actual&&pa===actual?"#8fffb0":pa&&actual&&pa!==actual?"#ff9090":"#f0d060", fontWeight: pa?"bold":"normal" }}>{pa||"—"}</span>
                      <span style={{ color: same?"#8fffb0":diff?"#ff9090":"#555", fontSize:13, minWidth:16, textAlign:"center" }}>{same?"=":diff?"≠":"·"}</span>
                      <span style={{ flex:1, textAlign:"right", color: pb&&actual&&pb===actual?"#8fffb0":pb&&actual&&pb!==actual?"#ff9090":"#60c0ff", fontWeight: pb?"bold":"normal" }}>{pb||"—"}</span>
                      {actual && <span style={{ fontSize:9, color:"#9ab8a0", minWidth:28, textAlign:"right" }}>+{pts}</span>}
                    </div>
                  );
                })}
              </div>
            );
          })}

          <div style={{ fontSize:11, fontWeight:"bold", color:"#f0d060", letterSpacing:1, marginBottom:8, marginTop:14 }}>🎲 P2 PROPS</div>
          {P2_PROPS.map(prop => {
            const pa = predA.p2PropPicks?.[prop.id], pb = predB.p2PropPicks?.[prop.id];
            const actual = p2PropResults?.[prop.id];
            const settled = actual != null;
            const same = pa != null && pb != null && pa === pb;
            const diff = pa != null && pb != null && pa !== pb;
            return (
              <div key={prop.id} style={{ display:"flex", alignItems:"center", gap:6, padding:"5px 0", borderBottom:"1px solid rgba(255,255,255,0.05)", fontSize:11 }}>
                <span style={{ color:"#9ab8a0", minWidth:28, fontSize:9 }}>{ROUND_LABELS[prop.round]?.slice(0,3)}</span>
                <span style={{ flex:1, color:"#c8b8a0", fontSize:10 }}>{prop.q.substring(0,40)}…</span>
                <span style={{ minWidth:24, textAlign:"center", fontWeight:"bold", color: pa==null?"#555": settled&&pa===actual?"#8fffb0": settled&&pa!==actual?"#ff9090":"#f0d060" }}>{pa==null?"—":pa?"Y":"N"}</span>
                <span style={{ color: same?"#8fffb0":diff?"#ff9090":"#555", fontSize:14, minWidth:16, textAlign:"center" }}>{same?"=":diff?"≠":"·"}</span>
                <span style={{ minWidth:24, textAlign:"center", fontWeight:"bold", color: pb==null?"#555": settled&&pb===actual?"#8fffb0": settled&&pb!==actual?"#ff9090":"#60c0ff" }}>{pb==null?"—":pb?"Y":"N"}</span>
              </div>
            );
          })}

          {goldenBoot?.options?.length === 3 && goldenBoot.options.every(o => o.name) && (
            <>
              <div style={{ fontSize:11, fontWeight:"bold", color:"#f0d060", letterSpacing:1, marginBottom:8, marginTop:14 }}>🥇 GOLDEN BOOT</div>
              {(() => {
                const pa = predA.goldenBootPick, pb = predB.goldenBootPick;
                const actual = goldenBoot.answer;
                const same = pa && pb && pa === pb;
                return (
                  <div style={{ display:"flex", alignItems:"center", gap:8, fontSize:12 }}>
                    <span style={{ flex:1, color: pa&&actual&&pa===actual?"#8fffb0":pa&&actual&&pa!==actual?"#ff9090":"#f0d060" }}>{pa||"—"}</span>
                    <span style={{ color: same?"#8fffb0":pa&&pb?"#ff9090":"#555", fontSize:14 }}>{same?"=":pa&&pb?"≠":"·"}</span>
                    <span style={{ flex:1, textAlign:"right", color: pb&&actual&&pb===actual?"#8fffb0":pb&&actual&&pb!==actual?"#ff9090":"#60c0ff" }}>{pb||"—"}</span>
                  </div>
                );
              })()}
            </>
          )}
        </>)}
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

// ── BRACKET IMPORT TREE ───────────────────────────────────────────────────────
// Read-only preview of bracket-import changes, grouped by round (R32 → Final)
// to mirror the actual tournament tree structure. Shows Team A vs Team B and
// the from→to winner change for each affected match.
function BracketImportTree({ diff }) {
  if (!diff.length) return null;
  const roundOrder = ["r32","r16","qf","sf","third","final"];
  const byRound = {};
  diff.forEach(d => { (byRound[d.round] = byRound[d.round] || []).push(d); });
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
      {roundOrder.filter(r => byRound[r]).map(round => (
        <div key={round}>
          <div style={{ fontSize:10, color:"#f0d060", fontWeight:"bold", marginBottom:4, letterSpacing:1 }}>{ROUND_LABELS[round]}</div>
          <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
            {byRound[round].map(d => (
              <div key={d.matchId} style={{ background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.08)", borderRadius:6, padding:"6px 10px", fontSize:11, color:"#c8b8a0" }}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:2 }}>
                  <span style={{ color:"#9ab8a0" }}>{d.label}</span>
                </div>
                <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
                  <span style={{ color: d.to===d.teamA ? "#8fffb0" : "#c8b8a0" }}>{d.teamA ? <>{tf(d.teamA)} {d.teamA}</> : "—"}</span>
                  <span style={{ color:"#666" }}>vs</span>
                  <span style={{ color: d.to===d.teamB ? "#8fffb0" : "#c8b8a0" }}>{d.teamB ? <>{tf(d.teamB)} {d.teamB}</> : "—"}</span>
                  <span style={{ marginLeft:"auto", color:"#666" }}>→</span>
                  <span style={{ color:"#8fffb0", fontWeight:"bold" }}>{d.to}</span>
                  {d.from && <span style={{ color:"#666", fontSize:10 }}>(was {d.from})</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── VISUAL BRACKET ────────────────────────────────────────────────────────────
// Scrollable horizontal bracket: R32 left → Final center → R32 right
// 16 matches per side, converging inward round by round
// Left side: matches 1-8, Right side: matches 9-16
function VisualBracket({ phase2Picks, setPhase2Picks, bracketWinners, bracketSlots, groupRankings, groupFinal, locked, open }) {
  const allTeams = Object.values(TEAMS_BY_GROUP).flat();
  const isKnown = (name) => allTeams.includes(name);

  // Pattern checks for the two kinds of terminal slot codes.
  const isGroupSlot = (slot) => /^[12][A-L]$/.test(slot);
  const is3Slot = (slot) => /^3[A-Z]+$/.test(slot);

  // "Skin" resolution — turns a raw terminal code into a real team name for DISPLAY
  // only. Picks themselves are never stored as resolved names; every player's bracket
  // is saved using the exact same raw codes regardless of when they filled it in, so a
  // group going Final later just changes what's shown, never what's stored. Gated on
  // groupFinal (not just provisional groupRankings) per the earlier decision — avoids
  // showing a team in the picker that could still change before the group is settled.
  const skinResolve = (value) => {
    if (value == null) return null;
    if (isGroupSlot(value)) {
      const g = value[1];
      if (!groupFinal?.[g]) return value;
      const pos = value[0] === "1" ? 0 : 1;
      return groupRankings?.[g]?.[pos] || value;
    }
    if (is3Slot(value)) return bracketSlots?.[value] || value;
    return value; // already a real team name (match actually decided, or unrecognized)
  };

  // Get the team picked/won for a match (for propagation display)
  const getPickedTeam = (matchId) => phase2Picks[matchId] || null;
  const getActualTeam = (matchId) => bracketWinners?.[matchId] || null;
  const getDisplayTeam = (matchId) => getActualTeam(matchId) || getPickedTeam(matchId);

  // Resolve a slot down to its RAW value — what would actually get stored if this
  // option were picked. A terminal code (1A, 3ABCDF) is already its own raw value, no
  // skin applied. A W_/L_ reference walks the chain: the real result if that match has
  // actually been played, otherwise whatever raw value the player already has picked
  // for it (itself a raw code, by induction) — or null if nothing's picked there yet,
  // which is exactly what keeps later rounds locked until earlier ones are filled in.
  const chainValue = (slot) => {
    if (slot.startsWith("W_")) {
      return getDisplayTeam(slot.slice(2));
    }
    if (slot.startsWith("L_")) {
      const matchId = slot.slice(2);
      const winner = getDisplayTeam(matchId);
      if (!winner) return null;
      const sfMatch = KNOCKOUT_ROUNDS.sf.find(m => m.id === matchId);
      if (!sfMatch) return null;
      const teamA = chainValue(sfMatch.slotA);
      const teamB = chainValue(sfMatch.slotB);
      if (teamA && teamA !== winner) return teamA;
      if (teamB && teamB !== winner) return teamB;
      return null;
    }
    return slot; // terminal code — already the raw value
  };

  // Cascade-clear downstream picks when a pick changes (unchanged — still pure string
  // equality on whatever's stored, just comparing raw codes now instead of names)
  function pickTeam(matchId, value) {
    if (locked || !open) return;
    setPhase2Picks(prev => {
      const next = { ...prev };
      const oldPick = prev[matchId];
      next[matchId] = value;
      if (oldPick && oldPick !== value) {
        const downstream = getDownstreamMatches(matchId);
        downstream.forEach(downId => {
          if (next[downId] === oldPick) delete next[downId];
        });
      }
      return next;
    });
  }

  // Column widths and layout constants
  const COL_W = 110; // match card width
  const COL_GAP = 28; // gap between rounds
  const CARD_H = 52; // match card height
  const ROUND_COUNT = 5; // R32, R16, QF, SF, Final (each side)

  // Left side rounds: r32[0-7], r16[0-3], qf[0-1], sf[0], final
  // Right side rounds: r32[8-15], r16[4-7], qf[2-3], sf[1], (same final)
  const leftRounds = [
    { key:"r32", matches: KNOCKOUT_ROUNDS.r32.slice(0,8), pts: ROUND_PTS.r32 },
    { key:"r16", matches: KNOCKOUT_ROUNDS.r16.slice(0,4), pts: ROUND_PTS.r16 },
    { key:"qf",  matches: KNOCKOUT_ROUNDS.qf.slice(0,2),  pts: ROUND_PTS.qf  },
    { key:"sf",  matches: KNOCKOUT_ROUNDS.sf.slice(0,1),  pts: ROUND_PTS.sf  },
  ];
  const rightRounds = [
    { key:"r32", matches: KNOCKOUT_ROUNDS.r32.slice(8,16), pts: ROUND_PTS.r32 },
    { key:"r16", matches: KNOCKOUT_ROUNDS.r16.slice(4,8),  pts: ROUND_PTS.r16 },
    { key:"qf",  matches: KNOCKOUT_ROUNDS.qf.slice(2,4),   pts: ROUND_PTS.qf  },
    { key:"sf",  matches: KNOCKOUT_ROUNDS.sf.slice(1,2),   pts: ROUND_PTS.sf  },
  ];

  const totalW = (COL_W + COL_GAP) * ROUND_COUNT * 2 + COL_W + 40; // ~1490px

  // Render a single match card
  function MatchCard({ match, roundKey, pts, side }) {
    const rawSlotA = match.slotA;
    const rawSlotB = match.slotB;

    // Raw value each option would store if picked (null = nothing to pick yet —
    // this is what keeps later rounds locked until the round before it is filled in)
    const chainA = chainValue(rawSlotA);
    const chainB = chainValue(rawSlotB);
    const slotAExists = chainA != null;
    const slotBExists = chainB != null;

    // Display text — same raw value, skinned to a real name once resolvable
    const displayA = chainA != null ? skinResolve(chainA) : null;
    const displayB = chainB != null ? skinResolve(chainB) : null;

    const pick = phase2Picks[match.id]; // always a raw value once set
    const actual = bracketWinners?.[match.id]; // always a real name once set
    const resolvedPick = pick != null ? skinResolve(pick) : null;
    const won = actual && resolvedPick === actual;
    const lost = actual && pick != null && resolvedPick !== actual;

    const canPick = open && !locked && slotAExists && slotBExists;

    const TeamBtn = ({ chainVal, displayText }) => {
      const isPick = pick === chainVal;
      const isActual = actual != null && chainVal != null && skinResolve(chainVal) === actual;
      const isWon = isActual && isPick;
      const isLost = isActual && pick != null && !isPick;
      const known = isKnown(displayText);
      return (
        <button
          onClick={() => canPick && pickTeam(match.id, chainVal)}
          style={{
            width:"100%", padding:"4px 6px", border:"1px solid",
            borderColor: isWon?"rgba(100,255,150,0.6)":isPick?"#f0d060":isLost?"rgba(255,100,100,0.3)":"rgba(255,255,255,0.1)",
            background: isWon?"rgba(0,180,80,0.2)":isPick?"rgba(200,168,75,0.25)":isLost?"rgba(180,50,50,0.1)":"rgba(255,255,255,0.04)",
            borderRadius:4, cursor: canPick ? "pointer" : "default",
            textAlign:"left", display:"flex", alignItems:"center", gap:4, minHeight:22,
            opacity: !canPick ? 0.5 : 1,
          }}
        >
          {known && <span style={{ fontSize:11, flexShrink:0 }}>{FLAG[displayText]||"🏳️"}</span>}
          <span style={{ fontSize:9, color: isPick?"#f0d060":isLost?"#ff9090":"#c8b8a0", fontWeight: isPick?"bold":"normal", lineHeight:1.2, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", flex:1 }}>
            {displayText || "TBD"}
          </span>
          {isWon && <span style={{ fontSize:8, color:"#8fffb0", flexShrink:0 }}>✓</span>}
          {isLost && <span style={{ fontSize:8, color:"#ff9090", flexShrink:0 }}>✗</span>}
        </button>
      );
    };

    return (
      <div style={{
        width:COL_W, background:"rgba(255,255,255,0.05)", border:`1px solid ${won?"rgba(100,255,150,0.3)":lost?"rgba(255,100,100,0.2)":"rgba(200,168,75,0.15)"}`,
        borderRadius:6, padding:"4px 5px", boxSizing:"border-box",
      }}>
        <div style={{ fontSize:8, color:"#9ab8a0", marginBottom:3, display:"flex", justifyContent:"space-between" }}>
          <span>{match.label}</span>
          <span style={{ color:"#f0d060" }}>+{pts}</span>
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:2 }}>
          <TeamBtn chainVal={chainA} displayText={displayA} />
          <TeamBtn chainVal={chainB} displayText={displayB} />
        </div>
      </div>
    );
  }

  // Render a column of match cards with vertical spacing
  function RoundColumn({ rounds_data, colIndex, align }) {
    const { matches, pts, key } = rounds_data;
    const spacing = Math.pow(2, colIndex); // 1, 2, 4, 8 gaps between cards
    const topOffset = (spacing - 1) * (CARD_H + 8) / 2;

    return (
      <div style={{ display:"flex", flexDirection:"column", gap:(spacing * (CARD_H + 8) - CARD_H), paddingTop: topOffset, flexShrink:0 }}>
        {matches.map(match => (
          <MatchCard key={match.id} match={match} roundKey={key} pts={pts} />
        ))}
      </div>
    );
  }

  // Center column: SF → Final + 3rd place
  const finalMatch = KNOCKOUT_ROUNDS.final[0];
  const thirdMatch = KNOCKOUT_ROUNDS.third[0];
  const finalChainA = chainValue(finalMatch.slotA);
  const finalChainB = chainValue(finalMatch.slotB);
  const thirdChainA = chainValue(thirdMatch.slotA);
  const thirdChainB = chainValue(thirdMatch.slotB);

  return (
    <div style={{ overflowX:"auto", overflowY:"visible", WebkitOverflowScrolling:"touch", marginLeft:-14, marginRight:-14, paddingLeft:14 }}>
      <div style={{ display:"flex", alignItems:"center", gap:COL_GAP, paddingBottom:16, paddingRight:14, minWidth: totalW }}>

        {/* LEFT SIDE — rounds going inward */}
        {leftRounds.map((rd, i) => (
          <RoundColumn key={`left-${i}`} rounds_data={rd} colIndex={i} align="left" />
        ))}

        {/* CENTER — Final + 3rd place */}
        <div style={{ flexShrink:0, display:"flex", flexDirection:"column", gap:12, alignItems:"center" }}>
          {/* Final */}
          <div style={{ width: COL_W + 20 }}>
            <div style={{ fontSize:9, color:"#f0d060", fontWeight:"bold", textAlign:"center", marginBottom:4, letterSpacing:1 }}>🏆 FINAL</div>
            <div style={{
              background:"rgba(200,168,75,0.08)", border:"1px solid rgba(200,168,75,0.4)",
              borderRadius:8, padding:"6px 7px",
            }}>
              <div style={{ fontSize:8, color:"#f0d060", marginBottom:4, display:"flex", justifyContent:"space-between" }}>
                <span>Final</span><span>+{ROUND_PTS.final}</span>
              </div>
              {[finalChainA, finalChainB].map(chainVal => {
                const exists = chainVal != null;
                const displayText = exists ? skinResolve(chainVal) : null;
                const pick = phase2Picks[finalMatch.id];
                const actual = bracketWinners?.[finalMatch.id];
                const isPick = exists && pick === chainVal;
                const isActual = exists && actual != null && skinResolve(chainVal) === actual;
                const canPick = open && !locked && exists;
                return (
                  <button key={chainVal || Math.random()}
                    onClick={() => canPick && pickTeam(finalMatch.id, chainVal)}
                    style={{
                      width:"100%", padding:"5px 7px", border:"1px solid", marginBottom:3,
                      borderColor: isPick?"#f0d060":isActual?"rgba(100,255,150,0.5)":"rgba(255,255,255,0.1)",
                      background: isPick?"rgba(200,168,75,0.3)":isActual?"rgba(0,180,80,0.15)":"rgba(255,255,255,0.04)",
                      borderRadius:4, cursor: canPick ? "pointer" : "default",
                      display:"flex", alignItems:"center", gap:5, minHeight:26,
                      opacity: canPick ? 1 : 0.4,
                    }}
                  >
                    {isKnown(displayText) && <span style={{ fontSize:13 }}>{FLAG[displayText]||"🏳️"}</span>}
                    <span style={{ fontSize:10, color: isPick?"#f0d060":"#c8b8a0", fontWeight: isPick?"bold":"normal", lineHeight:1.2, flex:1, textAlign:"left", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                      {displayText || "TBD"}
                    </span>
                    {isPick && isActual && <span style={{ fontSize:10 }}>🏆</span>}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 3rd Place */}
          <div style={{ width: COL_W + 20 }}>
            <div style={{ fontSize:9, color:"#c8b8a0", fontWeight:"bold", textAlign:"center", marginBottom:4, letterSpacing:1 }}>🥉 3RD PLACE</div>
            <div style={{
              background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.1)",
              borderRadius:8, padding:"6px 7px",
            }}>
              <div style={{ fontSize:8, color:"#9ab8a0", marginBottom:4, display:"flex", justifyContent:"space-between" }}>
                <span>3rd Place</span><span style={{ color:"#f0d060" }}>+{ROUND_PTS.third}</span>
              </div>
              {[thirdChainA, thirdChainB].map(chainVal => {
                const exists = chainVal != null;
                const displayText = exists ? skinResolve(chainVal) : null;
                const pick = phase2Picks[thirdMatch.id];
                const actual = bracketWinners?.[thirdMatch.id];
                const isPick = exists && pick === chainVal;
                const isActual = exists && actual != null && skinResolve(chainVal) === actual;
                const canPick = open && !locked && exists;
                return (
                  <button key={chainVal || Math.random()}
                    onClick={() => canPick && pickTeam(thirdMatch.id, chainVal)}
                    style={{
                      width:"100%", padding:"4px 6px", border:"1px solid", marginBottom:3,
                      borderColor: isPick?"#f0d060":isActual?"rgba(100,255,150,0.5)":"rgba(255,255,255,0.1)",
                      background: isPick?"rgba(200,168,75,0.25)":"rgba(255,255,255,0.04)",
                      borderRadius:4, cursor: canPick ? "pointer" : "default",
                      display:"flex", alignItems:"center", gap:4, minHeight:22,
                      opacity: canPick ? 1 : 0.4,
                    }}
                  >
                    {isKnown(displayText) && <span style={{ fontSize:11 }}>{FLAG[displayText]||"🏳️"}</span>}
                    <span style={{ fontSize:9, color: isPick?"#f0d060":"#c8b8a0", fontWeight: isPick?"bold":"normal", lineHeight:1.2, flex:1, textAlign:"left", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                      {displayText || "TBD"}
                    </span>
                    {isPick && isActual && <span style={{ fontSize:9 }}>🥉</span>}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* RIGHT SIDE — rounds going outward */}
        {[...rightRounds].reverse().map((rd, i) => (
          <RoundColumn key={`right-${i}`} rounds_data={rd} colIndex={rightRounds.length - 1 - i} align="right" />
        ))}
      </div>
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
  const [lbLoading, setLbLoading]         = useState(false);
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

  const [picksPhase, setPicksPhase]       = useState("p1"); // "p1" | "p2"
  const [predTab, setPredTab]             = useState("groups"); // p1 sub-tab
  const [p2Tab, setP2Tab]                 = useState("bracket"); // p2 sub-tab
  const [selGroup, setSelGroup]           = useState("A");
  const [selPropIdx, setSelPropIdx]       = useState(0);
  const [groupRankings, setGroupRankings] = useState({});
  const [propPicks, setPropPicks]         = useState(Array(34).fill(null));
  const [p2PropPicks, setP2PropPicks]     = useState({}); // { [prop.id]: true|false }
  const [goldenBootPick, setGoldenBootPick] = useState(null);
  const [goldenBoot, setGoldenBoot]       = useState(null); // loaded from Firebase
  const [p2PropResults, setLiveP2Props]     = useState(null);
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
  const [bracketWinners, setLivePhase2]       = useState(null);
  const [breadcrumbs, setBreadcrumbs] = useState([]);
  const [sheetImport, setSheetImport] = useState({ loading:false, error:"", diff:null, applying:false, done:"" });
  const [groupSheetImport, setGroupSheetImport] = useState({ loading:false, error:"", diff:null, applying:false, done:"" });
  const [p2PropSheetImport, setP2PropSheetImport] = useState({ loading:false, error:"", diff:null, applying:false, done:"" });
  const [gbSheetImport, setGbSheetImport] = useState({ loading:false, error:"", diff:null, applying:false, done:"" });
  const [gbOptionsSheetImport, setGbOptionsSheetImport] = useState({ loading:false, error:"", diff:null, applying:false, done:"" });
  const [editGbOption, setEditGbOption] = useState(null); // index 0-2
  const [editGbOptionVal, setEditGbOptionVal] = useState({ name:"", pts:"" });
  const [bracketSheetImport, setBracketSheetImport] = useState({ loading:false, error:"", diff:null, applying:false, done:"" });
  const [bracketSlotsSheetImport, setBracketSlotsSheetImport] = useState({ loading:false, error:"", diff:null, applying:false, done:"" });
  const adminSessionToken = useRef(null);
  const [adminTab, setAdminTab]           = useState("settings");
  const [auditPhase, setAuditPhase]       = useState("p1");
  const [expandedBreakdown, setExpandedBreakdown] = useState({});
  const [editingGroup, setEditingGroup]   = useState(null);
  const [editingGroupVal, setEditingGroupVal] = useState("");
  const [editBracketSlot, setEditBracketSlot] = useState(null);
  const [editBracketSlotVal, setEditBracketSlotVal] = useState("");
  const [tbAnswerP1Input, setTbAnswerP1Input] = useState(""); // admin entry: actual total group-stage goals
  const [tbAnswerP2Input, setTbAnswerP2Input] = useState(""); // admin entry: actual minute of first goal in the Final
  const [bracketSlots, setBracketSlots]   = useState(null); // { "1A": "Mexico", "2A": "South Africa", ... }
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
  const [groupFinalOnly, setGroupFinalOnly] = useState(true); // Standings toggle: true = exclude provisional groups
  const [lbPhase, setLbPhase]             = useState("p1"); // "p1" | "p2"
  const [adminPinMsg, setAdminPinMsg]     = useState("");
  const [prevPropResults, setPrevPropResults] = useState(null);
  const [showHowItWorks, setShowHowItWorks]   = useState(false);
  const [rulesTab, setRulesTab]               = useState("pool");
  const [newRealName, setNewRealName]         = useState("");
  const [showRealNamePrompt, setShowRealNamePrompt] = useState(false);
  const [editingRealName, setEditingRealName] = useState("");

  // Build marker — helps spot stale tabs in the console (compare against current BUILD_ID in source)
  useEffect(() => { console.log("WC2026 BUILD_ID:", BUILD_ID); }, []);

  // Load from Firebase on mount
  useEffect(() => {
    dbLoad()
      .then(data => {
        setPlayers(data.players);
        setPredictions(data.predictions);
        setPaid(data.paid || {});
        if (data.goldenBoot) setGoldenBoot(data.goldenBoot);
        if (data.bracketSlots) setBracketSlots(data.bracketSlots);
        if (data.p2PropResults) setLiveP2Props(data.p2PropResults);
        if (data.liveResults) setLiveResults(data.liveResults);
        if (data.bracketWinners) setLivePhase2(data.bracketWinners);
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
              // Claim the single admin session slot — boots any other active admin
              const token = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
              adminSessionToken.current = token;
              fetch(`${DB_URL}/pool/adminSession.json`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token, ts: Date.now() }),
              }).catch(() => {});
            } else {
              const player = data.players.find(p => p.id === saved.id);
              if (player) {
                setCurrentPlayer(player);
                try { localStorage.setItem("wc2026_session", JSON.stringify(player)); } catch {}
                if (!player.realName) { setEditingRealName(""); setShowRealNamePrompt(true); }
                const e = data.predictions[player.id] || {};
                const lr1 = sanitizeGroupRankings(e.groupRankings);
                setGroupRankings(Object.keys(lr1).length > 0 ? lr1 : (Object.keys(e.groupRankings||{}).length > 0 ? e.groupRankings : { A: TEAMS_BY_GROUP.A }));
                setPropPicks(e.propPicks || Array(34).fill(null));
                setPhase2Picks(e.phase2Picks || {});
                setP2PropPicks(e.p2PropPicks || {});
                setGoldenBootPick(e.goldenBootPick || null);
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

  // Poll Firebase every 30s — skip for admin sessions to prevent override conflicts
  useEffect(() => {
    if (isAdmin) return; // admin uses manual Reload button instead
    const iv = setInterval(() => {
      dbLoad().then(data => {
        setPlayers(data.players); setPredictions(data.predictions); setPaid(data.paid || {});
        setSettings(data.settings || { entryFee:25, commCut:20, p1Split:50, payouts1:[60,25,10,5,0], payouts2:[60,25,10,5,0] });
        if (data.goldenBoot) setGoldenBoot(data.goldenBoot);
        if (data.bracketSlots) setBracketSlots(data.bracketSlots);
        if (data.p2PropResults) setLiveP2Props(data.p2PropResults);
        if (data.liveResults) { setLiveResults(data.liveResults); setFetchStatus("done"); }
        else setFetchStatus("done");
        if (data.bracketWinners) setLivePhase2(data.bracketWinners);
      }).catch(() => {});
      loadMessages().then(setMessages).catch(() => {});
      loadReactions().then(setReactions).catch(() => {});
    }, 30000);
    return () => clearInterval(iv);
  }, [isAdmin]);

  // Admin single-session enforcement — check every 20s if another admin has taken over
  useEffect(() => {
    if (!isAdmin) return;
    const iv = setInterval(async () => {
      try {
        const r = await fetch(`${DB_URL}/pool/adminSession.json`);
        const session = await r.json();
        if (session && adminSessionToken.current && session.token !== adminSessionToken.current) {
          // Another admin has logged in — boot this session
          setIsAdmin(false);
          setCurrentPlayer(null);
          setScreen("home");
          try { localStorage.removeItem("wc2026_session"); localStorage.removeItem("wc2026_admin"); } catch {}
          alert("⚠️ You've been logged out — another admin session was started elsewhere.");
        }
      } catch {}
    }, 20000);
    return () => clearInterval(iv);
  }, [isAdmin]);


  async function register() {
    const name = newName.trim();
    const pw = newPassword.trim();
    const rn = newRealName.trim();
    if (!name || !pw || !rn || players.find(p => p.name === name)) return;
    const player = { name, id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, passwordHash: hashPassword(pw), realName: rn };
    const np = [...players, player];
    setPlayers(np);
    await dbSave(np, predictions, paid, settings);
    setCurrentPlayer(player);
    setIsAdmin(false);
    try { localStorage.setItem("wc2026_session", JSON.stringify(player)); localStorage.removeItem("wc2026_admin"); } catch {}
    setNewName(""); setNewPassword(""); setNewRealName("");
    setGroupRankings({}); setPropPicks(Array(34).fill(null)); setPhase2Picks({}); setP2PropPicks({}); setGoldenBootPick(null); setTbP1(""); setTbP2("");
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
      // Claim the single admin session slot — boots any other active admin
      const token = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      adminSessionToken.current = token;
      fetch(`${DB_URL}/pool/adminSession.json`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, ts: Date.now() }),
      }).catch(() => {});
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
    const lr2 = sanitizeGroupRankings(e.groupRankings);
    setGroupRankings(Object.keys(lr2).length > 0 ? lr2 : (Object.keys(e.groupRankings||{}).length > 0 ? e.groupRankings : { A: TEAMS_BY_GROUP.A }));
    setPropPicks(e.propPicks || Array(34).fill(null));
    setPhase2Picks(e.phase2Picks || {});
    setP2PropPicks(e.p2PropPicks || {});
    setGoldenBootPick(e.goldenBootPick || null);
    setTbP1(e.tbP1 !== undefined ? String(e.tbP1) : "");
    setTbP2(e.tbP2 !== undefined ? String(e.tbP2) : "");
    setSaved(false);
    setLoginName(""); setLoginPassword("");
    if (!player.realName) { setEditingRealName(""); setShowRealNamePrompt(true); }
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
    const existing = predictions[currentPlayer.id] || {};
    const merged = {
      groupRankings: Object.keys(groupRankings).length > 0 ? groupRankings : (existing.groupRankings || {}),
      propPicks: propPicks.some(p => p !== null) ? propPicks : (existing.propPicks || Array(34).fill(null)),
      phase2Picks: Object.keys(phase2Picks).length > 0 ? phase2Picks : (existing.phase2Picks || {}),
      p2PropPicks: Object.keys(p2PropPicks).length > 0 ? p2PropPicks : (existing.p2PropPicks || {}),
      goldenBootPick: goldenBootPick || existing.goldenBootPick || null,
      tbP1: tbP1val !== null ? tbP1val : (existing.tbP1 ?? null),
      tbP2: tbP2val !== null ? tbP2val : (existing.tbP2 ?? null),
    };
    const np = { ...predictions, [currentPlayer.id]: merged };
    setPredictions(np);
    await dbSave(players, np, paid, settings, goldenBoot);
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

  // Helper: display name with real name in parens if available
  const displayName = (player) => {
    if (!player) return "";
    if (player.realName) return `${player.name} (${player.realName})`;
    return player.name;
  };

  const groupsDone = Object.keys(groupRankings).length;
  const propsDone  = propPicks.filter(p => p !== null).length;
  // Count unlocked props only for "incomplete" nudge
  const unlockedProps = DAILY_PROPS.filter((_, i) => !isPropLocked(i)).length;
  const unlockedPropsDone = propPicks.filter((p, i) => p !== null && !isPropLocked(i)).length;
  const totalBracketMatches = Object.values(KNOCKOUT_ROUNDS).flat().length;
  const bracketDone = Object.keys(phase2Picks).length;
  const p2PropsDone = Object.keys(p2PropPicks).length;
  // Admin can open P2 picking (bracket/props/tiebreaker) early — before the scheduled
  // PHASE2_OPEN — to give players more lead time during the group stage. This never
  // touches the LOCK side (isPhase2Locked/isP2PropRoundLocked stay exactly as scheduled,
  // tied to each round's actual kickoff) — only how early picking can start.
  const p2EffectivelyOpen = isPhase2Open() || !!settings.p2Unlock;
  const p2Complete = !p2EffectivelyOpen || (bracketDone >= totalBracketMatches && goldenBootPick && tbP2 !== "");
  const p1Complete = groupsDone >= 12 && (unlockedProps === 0 || unlockedPropsDone >= unlockedProps) && tbP1 !== "";
  const hasIncomplete = currentPlayer && !isAdmin && (!p1Complete || (p2EffectivelyOpen && !p2Complete));

  // Count results that are past their lock time but still null — used to badge the audit tab
  const needsOverrideCount = isAdmin ? (() => {
    let count = 0;
    if (isGroupResultsExpected()) Object.keys(TEAMS_BY_GROUP).forEach(g => { if (!liveResults?.groupRankings?.[g]) count++; });
    DAILY_PROPS.forEach((_, i) => { if (isPropResultExpected(i) && (liveResults?.propResults?.[i] === null || liveResults?.propResults?.[i] === undefined)) count++; });
    Object.entries(KNOCKOUT_ROUNDS).forEach(([round, matches]) => { if (isP2RoundResultExpected(round)) matches.forEach(m => { if (!bracketWinners?.[m.id]) count++; }); });
    P2_PROPS.forEach(prop => { if (isP2RoundResultExpected(prop.round) && (p2PropResults?.[prop.id] === null || p2PropResults?.[prop.id] === undefined)) count++; });
    return count;
  })() : 0;

  // buildP1Leaderboard(finalOnly) — finalOnly=true excludes group-ranking points for any
  // group not yet marked Final by the admin (pool/settled/groupFinal/{g}). Used by the
  // Standings tab toggle; every other consumer (chart, H2H, home widget, CSV export) keeps
  // using the default (finalOnly=false, i.e. include provisional) leaderboard below.
  function buildP1Leaderboard(finalOnly) {
    return players
      .map(p => ({
        ...p,
        pts: calcPoints(predictions[p.id], liveResults, finalOnly),
        pts2: calcPhase2Points(predictions[p.id]?.phase2Picks, bracketWinners, p2PropResults, goldenBoot, predictions[p.id]?.p2PropPicks, predictions[p.id]?.goldenBootPick, liveResults?.groupRankings, bracketSlots),
        hasPred: !!predictions[p.id]
      }))
      .sort((a, b) => {
        if (b.pts !== a.pts) return b.pts - a.pts;
        // Tiebreaker: closest to total group stage goals — only once group stage is final and answer is known
        const totalGoals = liveResults?.totalGoals;
        if (isGroupStageComplete() && totalGoals != null) {
          const tbA = predictions[a.id]?.tbP1, tbB = predictions[b.id]?.tbP1;
          if (tbA != null && tbB != null) return Math.abs(tbA - totalGoals) - Math.abs(tbB - totalGoals);
        }
        return 0;
      });
  }
  const leaderboard = buildP1Leaderboard(false);
  const leaderboardFinalOnly = buildP1Leaderboard(true);

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
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Choose a username…" style={{ ...S.input, width:"100%" }} />
            <input value={newRealName} onChange={e => setNewRealName(e.target.value)} placeholder="Your real name (shown to others)…" style={{ ...S.input, width:"100%" }} />
            <input value={newPassword} onChange={e => setNewPassword(e.target.value)}
              onKeyDown={e => e.key==="Enter" && register()}
              type="password" placeholder="Choose a password…" style={{ ...S.input, width:"100%" }} />
            <button onClick={register} style={{ ...S.btn, width:"100%" }}>Join Pool</button>
          </div>
          {players.find(p => p.name===newName.trim()) && <div style={{ color:"#e06060", fontSize:11, marginTop:6 }}>Name already taken</div>}
          {newName.trim() && !newRealName.trim() && <div style={{ color:"#e06060", fontSize:11, marginTop:6 }}>Real name required</div>}
          {newName.trim() && newRealName.trim() && !newPassword.trim() && <div style={{ color:"#e06060", fontSize:11, marginTop:6 }}>Password required</div>}
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

      {/* Real Name Prompt Modal */}
      {showRealNamePrompt && (
        <div style={{ position:"fixed", inset:0, zIndex:9100, background:"rgba(0,0,0,0.85)", display:"flex", alignItems:"center", justifyContent:"center", padding:"20px 14px" }}>
          <div style={{ background:"linear-gradient(135deg,#0a1628,#0d2040)", border:"1px solid rgba(200,168,75,0.4)", borderRadius:14, maxWidth:380, width:"100%", padding:24 }}>
            <div style={{ fontSize:18, color:"#f0d060", fontWeight:"bold", marginBottom:6 }}>{currentPlayer?.realName ? "✏️ Edit real name" : "👋 One more thing"}</div>
            <div style={{ fontSize:12, color:"#9ab8a0", marginBottom:16 }}>{currentPlayer?.realName ? "Update the real name shown next to your username." : "Add your real name so your friends know who you are on the leaderboard."}</div>
            <input
              value={editingRealName}
              onChange={e => setEditingRealName(e.target.value)}
              onKeyDown={async e => {
                if (e.key === "Enter" && editingRealName.trim()) {
                  const updated = players.map(p => p.id === currentPlayer.id ? { ...p, realName: editingRealName.trim() } : p);
                  const updatedPlayer = { ...currentPlayer, realName: editingRealName.trim() };
                  setPlayers(updated); setCurrentPlayer(updatedPlayer);
                  try { localStorage.setItem("wc2026_session", JSON.stringify(updatedPlayer)); } catch {}
                  await dbSave(updated, predictions, paid, settings);
                  setShowRealNamePrompt(false);
                }
              }}
              placeholder="Your real name…"
              autoFocus
              style={{ ...S.input, width:"100%", marginBottom:10 }}
            />
            <button
              onClick={async () => {
                if (!editingRealName.trim()) return;
                const updated = players.map(p => p.id === currentPlayer.id ? { ...p, realName: editingRealName.trim() } : p);
                const updatedPlayer = { ...currentPlayer, realName: editingRealName.trim() };
                setPlayers(updated); setCurrentPlayer(updatedPlayer);
                try { localStorage.setItem("wc2026_session", JSON.stringify(updatedPlayer)); } catch {}
                await dbSave(updated, predictions, paid, settings);
                setShowRealNamePrompt(false);
              }}
              disabled={!editingRealName.trim()}
              style={{ ...S.btn, width:"100%", opacity: editingRealName.trim() ? 1 : 0.4 }}
            >Save &amp; Continue</button>
          </div>
        </div>
      )}

      {/* H2H Modal */}
      {h2hPlayerA && h2hPlayerB && (
        <H2HModal playerA={h2hPlayerA} playerB={h2hPlayerB} predictions={predictions} liveResults={liveResults} bracketWinners={bracketWinners} bracketSlots={bracketSlots} p2PropResults={p2PropResults} goldenBoot={goldenBoot} phase={lbPhase} onClose={() => { setH2hPlayerA(null); setH2hPlayerB(null); }} />
      )}

      {/* How It Works Modal */}
      {showHowItWorks && (() => {
        const { pot1, pot2, total, commCut, paidCount } = calcPot(players, paid, settings);
        const entryFee = settings.entryFee || 25;
        const pcts1 = settings.payouts1 || [60,25,10,5,0];
        const pcts2 = settings.payouts2 || [60,25,10,5,0];
        const dist1 = Math.max(0, pot1 - entryFee);
        const dist2 = Math.max(0, pot2 - entryFee);
        const rt = rulesTab;
        const setRt = setRulesTab;
        const tabStyle = (key) => ({
          flex:1, padding:"8px 4px", borderRadius:6, border:"1px solid", cursor:"pointer", fontSize:11,
          borderColor: rt===key ? "#f0d060" : "rgba(255,255,255,0.12)",
          background: rt===key ? "rgba(240,208,96,0.18)" : "rgba(255,255,255,0.04)",
          color: rt===key ? "#f0d060" : "#9ab8a0", fontWeight: rt===key ? "bold" : "normal",
        });
        return (
          <div style={{ position:"fixed", inset:0, zIndex:9000, background:"rgba(0,0,0,0.82)", display:"flex", alignItems:"flex-start", justifyContent:"center", padding:"20px 14px", overflowY:"auto" }}>
            <div style={{ background:"linear-gradient(135deg,#0a1628,#0d2040)", border:"1px solid rgba(200,168,75,0.4)", borderRadius:14, maxWidth:600, width:"100%", padding:24, position:"relative" }}>
              <button onClick={() => { setRulesTab("pool"); setShowHowItWorks(false); }} style={{ position:"absolute", top:14, right:16, background:"none", border:"none", color:"#9ab8a0", cursor:"pointer", fontSize:22, lineHeight:1 }}>✕</button>

              <div style={{ fontSize:22, color:"#f0d060", fontWeight:"bold", marginBottom:4 }}>⚽ How the Pool Works</div>
              <div style={{ fontSize:12, color:"#9ab8a0", marginBottom:16 }}>Everything you need to know to crush your mates</div>

              {/* Tab bar */}
              <div style={{ display:"flex", gap:4, marginBottom:18 }}>
                {[["pool","💰 Prize Pool"],["p1","🏅 Phase 1"],["p2","🏆 Phase 2"]].map(([key,label]) => (
                  <button key={key} style={tabStyle(key)} onClick={() => setRt(key)}>{label}</button>
                ))}
              </div>

              {/* ── PRIZE POOL TAB ── */}
              {rt==="pool" && (
                <div>
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
                  <div style={{ fontSize:12, color:"#9ab8a0", textAlign:"center", marginBottom:14 }}>
                    Use the tabs above to see how scoring works for each phase.
                  </div>
                </div>
              )}

              {/* ── PHASE 1 TAB ── */}
              {rt==="p1" && (
                <div>
                  {/* Group Rankings */}
                  <div style={{ ...S.card, marginBottom:14 }}>
                    <div style={{ fontSize:11, fontWeight:"bold", color:"#f0d060", letterSpacing:1, marginBottom:8 }}>🏅 GROUP RANKINGS</div>
                    <div style={{ fontSize:12, color:"#f0e6c8", marginBottom:10 }}>Predict the final standings of all 12 groups (A–L). Drag teams into your predicted finishing order.</div>
                    <div style={{ display:"flex", flexDirection:"column", gap:6, marginBottom:10 }}>
                      {[["🥇 Exact position","+6 pts","Right team, right spot"],["✅ Correct half","+2 pts","Right half — top 2 or bottom 2"],["❌ Wrong half","0 pts","Nice try though"]].map(([l,pts,desc]) => (
                        <div key={l} style={{ display:"flex", gap:10, alignItems:"baseline", fontSize:12 }}>
                          <span style={{ minWidth:130, color:"#f0e6c8" }}>{l}</span>
                          <span style={{ color:"#f0d060", fontWeight:"bold", minWidth:50 }}>{pts}</span>
                          <span style={{ color:"#9ab8a0", fontSize:11 }}>{desc}</span>
                        </div>
                      ))}
                    </div>
                    <div style={{ fontSize:11, color:"#9ab8a0" }}>Max {MAX_RANKING_PTS} pts across all 12 groups (288 if you nail every position).</div>
                  </div>

                  {/* Daily Props */}
                  <div style={{ ...S.card, marginBottom:14 }}>
                    <div style={{ fontSize:11, fontWeight:"bold", color:"#f0d060", letterSpacing:1, marginBottom:8 }}>🎲 DAILY PROPS</div>
                    <div style={{ fontSize:12, color:"#f0e6c8", marginBottom:10 }}>34 props total — 2 per day, Jun 11–27. Each is a YES or NO question about that day's matches.</div>
                    <div style={{ background:"rgba(255,255,255,0.04)", borderRadius:8, padding:10, marginBottom:8 }}>
                      <div style={{ fontSize:12, color:"#f0d060", fontWeight:"bold", marginBottom:4 }}>Weighted odds</div>
                      <div style={{ fontSize:12, color:"#f0e6c8", lineHeight:1.6 }}>Points are weighted by probability — the less likely outcome pays more. Every prop sums to 10 pts total. Pick the longshot right and you'll earn more than picking the chalk.</div>
                    </div>
                    <div style={{ fontSize:12, color:"#9ab8a0" }}>Example: <strong style={{ color:"#f0e6c8" }}>YES=4 / NO=6</strong> means NO is the underdog. Call it right and you bank 6 pts.</div>
                  </div>

                  {/* Tiebreaker */}
                  <div style={{ ...S.card, borderColor:"rgba(255,180,50,0.3)", background:"rgba(255,140,0,0.06)", marginBottom:14 }}>
                    <div style={{ fontSize:11, fontWeight:"bold", color:"#f0d060", letterSpacing:1, marginBottom:8 }}>🔢 TIEBREAKER</div>
                    <div style={{ fontSize:12, color:"#f0e6c8" }}>Total goals scored across all 72 group stage matches. If two players tie on points, whoever's guess is closest to the actual total wins the tiebreak.</div>
                  </div>

                  {/* Lock times */}
                  <div style={{ ...S.card, borderColor:"rgba(255,100,100,0.3)", background:"rgba(200,60,60,0.06)", marginBottom:14 }}>
                    <div style={{ fontSize:11, fontWeight:"bold", color:"#ff9090", letterSpacing:1, marginBottom:8 }}>🔒 LOCK TIMES</div>
                    {[
                      ["Group rankings + Day 1 props","Jun 11 at noon PT (tournament kickoff — Mexico vs South Africa)"],
                      ["Each day's props","Lock at the first kickoff of that day — check the label on each card"],
                    ].map(([l,v]) => (
                      <div key={l} style={{ fontSize:12, padding:"6px 0", borderBottom:"1px solid rgba(255,255,255,0.05)" }}>
                        <div style={{ color:"#ff9090", fontWeight:"bold", marginBottom:2 }}>{l}</div>
                        <div style={{ color:"#9ab8a0" }}>{v}</div>
                      </div>
                    ))}
                    <div style={{ fontSize:11, color:"#ff9090", marginTop:8 }}>⚠️ Save your picks before the deadline — anything unsaved doesn't count!</div>
                  </div>
                </div>
              )}

              {/* ── PHASE 2 TAB ── */}
              {rt==="p2" && (
                <div>
                  {/* Bracket */}
                  <div style={{ ...S.card, marginBottom:14 }}>
                    <div style={{ fontSize:11, fontWeight:"bold", color:"#f0d060", letterSpacing:1, marginBottom:8 }}>🏆 BRACKET PICKS</div>
                    <div style={{ fontSize:12, color:"#f0e6c8", marginBottom:10 }}>Pick the winner of every knockout match from the Round of 32 through the Final, plus the 3rd place match. The bracket opens Jun 27 evening once group stage slots are known and locks Jun 28 at 3pm ET (first R32 kickoff).</div>
                    <div style={{ fontSize:11, color:"#9ab8a0", marginBottom:10 }}>Team slots (1A, 2C, etc.) auto-resolve to real teams after the group stage ends.</div>
                    <div style={{ display:"flex", flexDirection:"column", gap:4, marginBottom:4 }}>
                      {[["Round of 32","4 pts"],["Round of 16","8 pts"],["Quarter-Finals","16 pts"],["Semi-Finals","32 pts"],["3rd Place","8 pts"],["Final","64 pts"]].map(([r,p]) => (
                        <div key={r} style={{ display:"flex", justifyContent:"space-between", borderBottom:"1px solid rgba(255,255,255,0.05)", padding:"4px 0", fontSize:12 }}>
                          <span style={{ color:"#c8b8a0" }}>{r}</span>
                          <span style={{ color:"#f0d060", fontWeight:"bold" }}>{p} per correct pick</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* P2 Props */}
                  <div style={{ ...S.card, marginBottom:14 }}>
                    <div style={{ fontSize:11, fontWeight:"bold", color:"#f0d060", letterSpacing:1, marginBottom:8 }}>🎲 KNOCKOUT PROPS</div>
                    <div style={{ fontSize:12, color:"#f0e6c8", marginBottom:10 }}>15 YES/NO props — 3 per round (R32, R16, QF, SF, Final). Same weighted odds system as Phase 1: each prop sums to 10 pts, with the less likely side paying more.</div>
                    <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                      {[["R32 props","Lock Jun 28 at 3pm ET (first R32 kickoff)"],["R16 props","Lock Jul 4 at 1pm ET (first R16 kickoff)"],["QF props","Lock Jul 9 at 4pm ET (first QF kickoff)"],["SF props","Lock Jul 14 at 3pm ET (first SF kickoff)"],["Final props","Lock Jul 19 at 3pm ET (Final kickoff)"]].map(([r,v]) => (
                        <div key={r} style={{ display:"flex", gap:10, fontSize:12, padding:"4px 0", borderBottom:"1px solid rgba(255,255,255,0.05)" }}>
                          <span style={{ color:"#c8b8a0", minWidth:80 }}>{r}</span>
                          <span style={{ color:"#9ab8a0" }}>{v}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Golden Boot */}
                  <div style={{ ...S.card, marginBottom:14 }}>
                    <div style={{ fontSize:11, fontWeight:"bold", color:"#f0d060", letterSpacing:1, marginBottom:8 }}>🥾 GOLDEN BOOT</div>
                    <div style={{ fontSize:12, color:"#f0e6c8", marginBottom:6 }}>Pick who will finish as the tournament's top scorer. Options are the top 3 group-stage goal scorers plus "Other" (anyone else).</div>
                    <div style={{ fontSize:12, color:"#f0e6c8", marginBottom:6 }}>Points are weighted by the scoring gap — a surprise winner pays more. Worth up to 20 pts.</div>
                    <div style={{ fontSize:11, color:"#9ab8a0" }}>Options revealed and locked Jun 28 at 3pm ET.</div>
                  </div>

                  {/* Tiebreaker */}
                  <div style={{ ...S.card, borderColor:"rgba(255,180,50,0.3)", background:"rgba(255,140,0,0.06)", marginBottom:14 }}>
                    <div style={{ fontSize:11, fontWeight:"bold", color:"#f0d060", letterSpacing:1, marginBottom:8 }}>🔢 TIEBREAKER</div>
                    <div style={{ fontSize:12, color:"#f0e6c8" }}>Minute of the first goal in the Final. Closest without going over wins the tiebreak (Price is Right rules). Enter a number from 1–120; use 90+ for extra time.</div>
                  </div>

                  {/* Lock times */}
                  <div style={{ ...S.card, borderColor:"rgba(255,100,100,0.3)", background:"rgba(200,60,60,0.06)", marginBottom:14 }}>
                    <div style={{ fontSize:11, fontWeight:"bold", color:"#ff9090", letterSpacing:1, marginBottom:8 }}>🔒 LOCK TIMES</div>
                    {[
                      ["Bracket picks + Golden Boot","Jun 28 at 3pm ET — locks with the first R32 kickoff"],
                      ["R16 / QF / SF / Final props","Each round's 3 props lock at that round's first kickoff"],
                    ].map(([l,v]) => (
                      <div key={l} style={{ fontSize:12, padding:"6px 0", borderBottom:"1px solid rgba(255,255,255,0.05)" }}>
                        <div style={{ color:"#ff9090", fontWeight:"bold", marginBottom:2 }}>{l}</div>
                        <div style={{ color:"#9ab8a0" }}>{v}</div>
                      </div>
                    ))}
                    <div style={{ fontSize:11, color:"#ff9090", marginTop:8 }}>⚠️ Save your picks before the deadline — anything unsaved doesn't count!</div>
                  </div>
                </div>
              )}

              <button onClick={() => { setRulesTab("pool"); setShowHowItWorks(false); }} style={{ ...S.btn, width:"100%", fontSize:14, padding:"10px" }}>Got it, let's go! ⚽</button>
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
            <button key={s} style={S.navBtn(screen===s)} onClick={() => {
              setScreen(s);
              if (s === "leaderboard") {
                setLbLoading(true);
                dbLoad().then(data => {
                  setPlayers(data.players);
                  setPredictions(data.predictions);
                  setPaid(data.paid || {});
                  if (data.liveResults) setLiveResults(data.liveResults);
                  if (data.bracketWinners) setLivePhase2(data.bracketWinners);
                  if (data.p2PropResults) setLiveP2Props(data.p2PropResults);
                            setFetchStatus("done");
                  setLbLoading(false);
                }).catch(() => { setLbLoading(false); });
              }
            }}>
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
          {currentPlayer && !isAdmin && (
            <button title="Edit your real name" onClick={() => { setEditingRealName(currentPlayer.realName || ""); setShowRealNamePrompt(true); }}
              style={{ background:"rgba(255,255,255,0.06)", border:"1px solid rgba(255,255,255,0.1)", borderRadius:6, padding:"5px 8px", color:"#9ab8a0", cursor:"pointer", fontSize:11 }}>
              ✏️ {currentPlayer.name}
            </button>
          )}
          {currentPlayer ? (
            <button style={{ ...S.navBtn(false), background:"rgba(180,60,60,0.5)", color:"#ffdddd" }}
              onClick={() => {
                if (isAdmin && adminSessionToken.current) {
                  fetch(`${DB_URL}/pool/adminSession.json`, { method: "DELETE" }).catch(() => {});
                  adminSessionToken.current = null;
                }
                setCurrentPlayer(null); setIsAdmin(false); try { localStorage.removeItem("wc2026_session"); localStorage.removeItem("wc2026_admin"); } catch {}
              }}>
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
      <div style={{ background:fetchStatus==="error"?"rgba(200,60,60,0.12)":"rgba(0,120,60,0.12)", padding:"5px 16px", fontSize:11, color:fetchStatus==="error"?"#ff8080":"#8fffb0", display:"flex", justifyContent:"space-between", flexWrap:"wrap", gap:4 }}>
        <span>
          {fetchStatus==="loading" && "⏳ Fetching live results…"}
          {fetchStatus==="error" && `⚠️ ${fetchError}`}
          {fetchStatus==="idle" && "Initialising…"}
          {fetchStatus==="done" && (() => {
            const groupsDone = Object.values(liveResults?.groupRankings||{}).filter(Boolean).length;
            const lockedPropCount = DAILY_PROPS.filter((_,i) => isPropLocked(i)).length;
            const settledPropCount = (liveResults?.propResults||[]).filter((v,i) => isPropLocked(i) && v !== null).length;
            const propLabel = lockedPropCount > 0 ? `${settledPropCount}/${lockedPropCount}` : `0/${DAILY_PROPS.length}`;
            const groupsComplete = isGroupStageComplete();
            const groupsOk = !groupsComplete || groupsDone === 12;
            const propsOk  = lockedPropCount === 0 || settledPropCount >= lockedPropCount;

            const parts = [
              `${groupsOk ? "✅" : "⚠️"} Groups ${groupsDone}/12`,
              `${propsOk  ? "✅" : "⚠️"} Props ${propLabel}`,
            ];

            if (isPhase2Open()) {
              // Bracket: count locked matches and how many have a winner
              let bracketTotal = 0, bracketDoneCount = 0;
              Object.entries(KNOCKOUT_ROUNDS).forEach(([round, matches]) => {
                if (isP2PropRoundLocked(round)) {
                  bracketTotal += matches.length;
                  matches.forEach(m => { if (bracketWinners?.[m.id]) bracketDoneCount++; });
                }
              });
              // P2 props: count locked rounds
              const p2PropTotal = P2_PROPS.filter(p => isP2PropRoundLocked(p.round)).length;
              const p2PropSettled = P2_PROPS.filter(p => isP2PropRoundLocked(p.round) && p2PropResults?.[p.id] !== null && p2PropResults?.[p.id] !== undefined).length;
              parts.push(`${bracketDoneCount >= bracketTotal && bracketTotal > 0 ? "✅" : bracketTotal === 0 ? "✅" : "⚠️"} Bracket ${bracketDoneCount}/${bracketTotal}`);
              parts.push(`${p2PropSettled >= p2PropTotal && p2PropTotal > 0 ? "✅" : p2PropTotal === 0 ? "✅" : "⚠️"} P2 Props ${p2PropSettled}/${p2PropTotal}`);
            }

            return parts.join("  ·  ");
          })()}
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

            {/* Incomplete picks banner */}
            {hasIncomplete && (
              <div style={{ background:"rgba(240,180,0,0.12)", border:"1px solid rgba(240,180,0,0.35)", borderRadius:8, padding:"10px 14px", marginBottom:14, display:"flex", alignItems:"center", justifyContent:"space-between", gap:10 }}>
                <div>
                  <div style={{ fontSize:12, color:"#f0d060", fontWeight:"bold", marginBottom:2 }}>⚠️ You have incomplete picks</div>
                  <div style={{ fontSize:11, color:"#c8b8a0" }}>
                    {!p1Complete && `P1: ${groupsDone}/12 groups · ${unlockedPropsDone}/${unlockedProps} props${tbP1===""?" · tiebreaker missing":""}`}
                    {!p1Complete && p2EffectivelyOpen && !p2Complete && " · "}
                    {p2EffectivelyOpen && !p2Complete && `P2: ${bracketDone}/${totalBracketMatches} bracket${!goldenBootPick?" · golden boot missing":""}${tbP2===""?" · tiebreaker missing":""}`}
                  </div>
                </div>
                <button onClick={() => setScreen("predict")} style={{ ...S.btn, fontSize:11, padding:"6px 12px", whiteSpace:"nowrap" }}>Go to My Picks →</button>
              </div>
            )}

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

            {/* Countdown or matchday status */}
            <CountdownTimer />

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
                ["🏅 P1 — Group Rankings", "Lock at tournament kickoff — Jun 11 at noon PT (Mexico vs South Africa)."],
                ["🎲 P1 — Daily Props", "Each prop locks before the first match of that day. Once the day's games start, your answer is final."],
                ["🏆 P2 — Bracket + Golden Boot", "Lock Jun 28 at 3pm ET, right after the group stage ends."],
                ["🎲 P2 — Knockout Props", "Each round's 3 props lock at that round's first kickoff (R16, QF, SF, Final)."],
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
                      {predictions[p.id] ? "✓ " : ""}{displayName(p)}
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
                <div style={{ fontSize:17, color:"#f0d060" }}>📋 {displayName(currentPlayer)}'s Picks</div>
                <div style={{ fontSize:11, color: hasIncomplete ? "#f0d060" : "#9ab8a0" }}>{hasIncomplete ? "⚠️ " : ""}{groupsDone}/12 groups · {propsDone}/34 props{p2EffectivelyOpen && !p2Complete ? ` · P2 ${bracketDone}/${totalBracketMatches} bracket` : ""}</div>
              </div>
              <div style={{ display:"flex", gap:8 }}>
                <button onClick={() => setScreen("home")} style={{ background:"rgba(255,255,255,0.07)", border:"1px solid rgba(255,255,255,0.1)", borderRadius:6, padding:"6px 10px", color:"#9ab8a0", cursor:"pointer", fontSize:12 }}>← Home</button>
                <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", gap:4 }}>
                  <button onClick={savePreds} disabled={saving} style={{ ...S.btn, background:saved?"#2a6040":saving?"#555":"linear-gradient(90deg,#c8a84b,#f0d060)", color:saved?"#8fffb0":"#0a1628" }}>
                    {saving ? "Saving…" : saved ? "✓ Saved!" : "Save"}
                  </button>
                  {hasIncomplete && !saved && (
                    <div style={{ fontSize:10, color:"#f0d060", textAlign:"right" }}>⚠️ some picks missing</div>
                  )}
                </div>
              </div>
            </div>

            <div style={{ marginBottom:14 }}>
              <div style={{ display:"flex", justifyContent:"space-between", fontSize:10, color:"#9ab8a0", marginBottom:4 }}>
                <span>Phase 1 Progress</span><span>{groupsDone}/12 groups · {propsDone}/34 props</span>
              </div>
              <div style={{ height:5, background:"rgba(255,255,255,0.08)", borderRadius:3, overflow:"hidden" }}>
                <div style={{ height:"100%", width:`${((groupsDone+propsDone)/46)*100}%`, background:"linear-gradient(90deg,#c8a84b,#f0d060)", borderRadius:3, transition:"width 0.3s" }} />
              </div>
            </div>

            {/* Phase tabs */}
            <div style={{ display:"flex", gap:4, marginBottom:12 }}>
              {[["p1","🏅 Phase 1"],["p2","🏆 Phase 2"]].map(([ph, label]) => (
                <button key={ph} style={{ ...S.tab(picksPhase===ph), flex:1, fontSize:13 }} onClick={() => setPicksPhase(ph)}>{label}</button>
              ))}
            </div>

            {/* ── PHASE 1 SUB-TABS ── */}
            {picksPhase==="p1" && (
              <div style={{ display:"flex", gap:4, marginBottom:14, flexWrap:"wrap" }}>
                {[["groups", groupsDone<12 ? `⚠️ Groups (${groupsDone}/12)` : `✓ Groups (12/12)`],["props", unlockedProps>0 && unlockedPropsDone<unlockedProps ? `⚠️ Props (${propsDone}/34)` : `✓ Props (${propsDone}/34)`],["tb1", tbP1==="" ? "⚠️ Tiebreaker" : `✓ Tiebreaker`]].map(([t,l]) => (
                  <button key={t} style={S.tab(predTab===t)} onClick={() => setPredTab(t)}>{l}</button>
                ))}
              </div>
            )}

            {/* ── PHASE 2 SUB-TABS ── */}
            {picksPhase==="p2" && (
              <div style={{ display:"flex", gap:4, marginBottom:14, flexWrap:"wrap" }}>
                {[["bracket", p2EffectivelyOpen && bracketDone<totalBracketMatches ? `⚠️ Bracket (${bracketDone}/${totalBracketMatches})` : `${bracketDone>0?"✓ ":""}Bracket${bracketDone>0?" ("+bracketDone+"/"+totalBracketMatches+")":""}`],["props","🎲 Props"],["tb2", p2EffectivelyOpen && tbP2==="" ? "⚠️ Tiebreaker" : `${tbP2?"✓ ":""}Tiebreaker`]].map(([t,l]) => (
                  <button key={t} style={S.tab(p2Tab===t)} onClick={() => setP2Tab(t)}>{l}</button>
                ))}
              </div>
            )}

            {/* GROUP RANKINGS */}
            {picksPhase==="p1" && predTab==="groups" && (
              <div>
                <div style={{ fontSize:12, color:"#9ab8a0", marginBottom:12 }}>
                  Predict the final standings of each group. Drag or use ▲▼.<br/>
                  <span style={{ color:"#f0d060" }}>+6 pts</span> exact position · <span style={{ color:"#c8a84b" }}>+2 pts</span> correct half (top 2 vs bottom 2)
                </div>
                <div style={{ display:"flex", gap:5, flexWrap:"wrap", marginBottom:14 }}>
                  {Object.keys(TEAMS_BY_GROUP).map(g => (
                    <button key={g} style={S.pill(selGroup===g)} onClick={() => { setSelGroup(g); setGroupRankings(prev => prev[g] ? prev : { ...prev, [g]: TEAMS_BY_GROUP[g] }); }}>
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
            {picksPhase==="p1" && predTab==="props" && (() => {
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
            {picksPhase==="p1" && predTab==="tb1" && (
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

            {/* PHASE 2 — BRACKET */}
            {picksPhase==="p2" && p2Tab==="bracket" && (
              <div>
                {!p2EffectivelyOpen && (
                  <div style={{ ...S.card, borderColor:"rgba(100,100,255,0.3)", background:"rgba(50,50,150,0.1)", marginBottom:12, textAlign:"center" }}>
                    <div style={{ fontSize:13, color:"#aab0ff", marginBottom:4 }}>🔜 Bracket picks open Jun 27 evening</div>
                    <div style={{ fontSize:11, color:"#9ab8a0" }}>Preview the bracket below — picks lock Jun 28 at 3pm ET</div>
                  </div>
                )}
                {isPhase2Locked() && (
                  <div style={{ background:"rgba(200,60,60,0.15)", border:"1px solid rgba(200,60,60,0.3)", borderRadius:8, padding:"8px 12px", marginBottom:12, fontSize:12, color:"#ff9090" }}>
                    🔒 Knockout picks are locked
                  </div>
                )}
                {p2EffectivelyOpen && !isPhase2Locked() && (
                  <div style={{ fontSize:12, color:"#9ab8a0", marginBottom:10 }}>
                    Tap a team to advance them. Locks Jun 28 at 3pm ET. Changing a pick clears conflicting downstream picks.<br/>
                    <span style={{ color:"#f0d060" }}>+4</span> R32 · <span style={{ color:"#f0d060" }}>+8</span> R16 · <span style={{ color:"#f0d060" }}>+16</span> QF · <span style={{ color:"#f0d060" }}>+32</span> SF · <span style={{ color:"#f0d060" }}>+8</span> 3rd · <span style={{ color:"#f0d060" }}>+64</span> Final
                  </div>
                )}
                {!p2EffectivelyOpen && (
                  <div style={{ fontSize:11, color:"#9ab8a0", marginBottom:10 }}>
                    <span style={{ color:"#f0d060" }}>+4</span> R32 · <span style={{ color:"#f0d060" }}>+8</span> R16 · <span style={{ color:"#f0d060" }}>+16</span> QF · <span style={{ color:"#f0d060" }}>+32</span> SF · <span style={{ color:"#f0d060" }}>+8</span> 3rd · <span style={{ color:"#f0d060" }}>+64</span> Final
                  </div>
                )}
                {/* Pick progress */}
                {(() => {
                  const allMatches = Object.values(KNOCKOUT_ROUNDS).flat();
                  const picked = allMatches.filter(m => phase2Picks[m.id]).length;
                  return (
                    <div style={{ marginBottom:12 }}>
                      <div style={{ display:"flex", justifyContent:"space-between", fontSize:10, color:"#9ab8a0", marginBottom:3 }}>
                        <span>Bracket picks</span><span>{picked}/{allMatches.length}</span>
                      </div>
                      <div style={{ height:4, background:"rgba(255,255,255,0.08)", borderRadius:2, overflow:"hidden" }}>
                        <div style={{ height:"100%", width:`${(picked/allMatches.length)*100}%`, background:"linear-gradient(90deg,#c8a84b,#f0d060)", borderRadius:2, transition:"width 0.3s" }} />
                      </div>
                    </div>
                  );
                })()}
                <VisualBracket
                  phase2Picks={phase2Picks}
                  setPhase2Picks={setPhase2Picks}
                  bracketWinners={bracketWinners}
                  bracketSlots={bracketSlots}
                  groupRankings={liveResults?.groupRankings}
                  groupFinal={liveResults?.groupFinal}
                  locked={isPhase2Locked()}
                  open={p2EffectivelyOpen}
                />
              </div>
            )}

            {/* PHASE 2 — PROPS */}
            {picksPhase==="p2" && p2Tab==="props" && (
              <div>
                {!p2EffectivelyOpen && (
                  <div style={{ ...S.card, borderColor:"rgba(100,100,255,0.3)", background:"rgba(50,50,150,0.1)", marginBottom:12, textAlign:"center" }}>
                    <div style={{ fontSize:13, color:"#aab0ff", marginBottom:4 }}>🔜 Phase 2 props open Jun 27 evening</div>
                    <div style={{ fontSize:11, color:"#9ab8a0" }}>Preview the props below — each round locks at its first kickoff</div>
                  </div>
                )}
                <div style={{ fontSize:12, color:"#9ab8a0", marginBottom:14 }}>
                  15 knockout props across 5 rounds. Each round's props lock at that round's first kickoff.<br/>
                  Points are weighted — the less likely outcome pays more.
                </div>
                {Object.entries(ROUND_LABELS).map(([round, roundLabel]) => {
                  const roundProps = P2_PROPS.filter(p => p.round === round);
                  const locked = isP2PropRoundLocked(round);
                  const open = p2EffectivelyOpen;
                  return (
                    <div key={round} style={{ marginBottom:20 }}>
                      <div style={{ fontSize:11, fontWeight:"bold", color:"#f0d060", letterSpacing:1, marginBottom:10, paddingBottom:4, borderBottom:"1px solid rgba(200,168,75,0.2)", display:"flex", justifyContent:"space-between" }}>
                        <span>{roundLabel.toUpperCase()}</span>
                        {locked ? <span style={{ color:"#ff9090" }}>🔒 Locked</span> : !open ? <span style={{ color:"#aab0ff" }}>🔜 Opens Jun 27</span> : <span style={{ color:"#9ab8a0" }}>Open</span>}
                      </div>
                      {roundProps.map(prop => {
                        const pick = p2PropPicks[prop.id];
                        const actual = p2PropResults?.[prop.id];
                        const settled = actual !== null && actual !== undefined;
                        const won = settled && pick === actual;
                        const lost = settled && pick !== null && pick !== undefined && !won;
                        return (
                          <div key={prop.id} style={{ ...S.card, marginBottom:10, borderColor: won?"rgba(100,255,150,0.4)":lost?"rgba(255,100,100,0.3)":"rgba(200,168,75,0.2)" }}>
                            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:6 }}>
                              <span style={{ fontSize:11, color:"#f0d060", fontWeight:"bold", flex:1, marginRight:8 }}>{roundLabel}</span>
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
                                🔒 Locked
                              </div>
                            )}
                            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                              {[[true,"✅",prop.yes,prop.ptsYes],[false,"❌",prop.no,prop.ptsNo]].map(([val,icon,label,pts]) => (
                                <button key={String(val)}
                                  onClick={() => {
                                    if (locked || !open) return;
                                    setP2PropPicks(prev => ({ ...prev, [prop.id]: val }));
                                  }}
                                  style={{
                                    padding:"12px 8px", borderRadius:10, border:"2px solid",
                                    borderColor: pick===val?"#f0d060":"rgba(255,255,255,0.1)",
                                    background: pick===val?"rgba(200,168,75,0.25)":"rgba(255,255,255,0.04)",
                                    color: pick===val?"#f0d060":"#c8b8a0",
                                    cursor: (locked||!open)?"default":"pointer", fontSize:12, textAlign:"center", lineHeight:1.4,
                                    opacity: (locked||!open) && pick!==val ? 0.4 : 1,
                                  }}>
                                  <div style={{ fontSize:18, marginBottom:3 }}>{icon}</div>
                                  <div style={{ fontWeight:pick===val?"bold":"normal", marginBottom:3 }}>{label}</div>
                                  <div style={{ fontSize:10, color:pick===val?"#f0d060":"#9ab8a0" }}>+{pts} pts</div>
                                </button>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}

                {/* Golden Boot */}
                <div style={{ marginBottom:20 }}>
                  <div style={{ fontSize:11, fontWeight:"bold", color:"#f0d060", letterSpacing:1, marginBottom:10, paddingBottom:4, borderBottom:"1px solid rgba(200,168,75,0.2)", display:"flex", justifyContent:"space-between" }}>
                    <span>🥇 GOLDEN BOOT</span>
                    {isGoldenBootLocked() ? <span style={{ color:"#ff9090" }}>🔒 Locked</span> : !isPhase2Open() ? <span style={{ color:"#aab0ff" }}>🔜 Opens Jun 27</span> : <span style={{ color:"#9ab8a0" }}>Locks Jun 28 3pm ET</span>}
                  </div>
                  <div style={{ ...S.card, borderColor:"rgba(200,168,75,0.3)" }}>
                    <div style={{ fontSize:13, color:"#f0e6c8", marginBottom:6 }}>Who will win the Golden Boot (tournament top scorer)?</div>
                    <div style={{ fontSize:11, color:"#9ab8a0", marginBottom:12, lineHeight:1.5 }}>
                      Top 3 group-stage scorers are shown after the group stage ends. Points weighted by likelihood — the favorite pays least, "Other" pays most (max 20pts).
                    </div>
                    {!(goldenBoot?.options?.length === 3 && goldenBoot.options.every(o => o.name)) ? (
                      <div style={{ fontSize:12, color:"#aab0ff", padding:"12px 0", textAlign:"center" }}>
                        🔜 Options revealed after group stage ends (Jun 27)
                      </div>
                    ) : (
                      <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                        {[...goldenBoot.options, { name:"Other", pts: 20 }].map(opt => {
                          const isPick = goldenBootPick === opt.name;
                          const isAnswer = goldenBoot.answer === opt.name;
                          const won = isAnswer && isPick;
                          const lost = goldenBoot.answer && isPick && !won;
                          return (
                            <button key={opt.name} onClick={() => {
                              if (isGoldenBootLocked() || !isPhase2Open()) return;
                              setGoldenBootPick(opt.name);
                            }} style={{
                              padding:"12px 14px", borderRadius:10, border:"2px solid", textAlign:"left", cursor:(isGoldenBootLocked()||!isPhase2Open())?"default":"pointer",
                              borderColor: won?"rgba(100,255,150,0.6)":lost?"rgba(255,100,100,0.5)":isPick?"#f0d060":"rgba(255,255,255,0.1)",
                              background: won?"rgba(0,180,80,0.15)":lost?"rgba(180,50,50,0.1)":isPick?"rgba(200,168,75,0.2)":"rgba(255,255,255,0.04)",
                              opacity: (isGoldenBootLocked()||!isPhase2Open()) && !isPick ? 0.5 : 1,
                            }}>
                              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                                <span style={{ fontSize:14, color: isPick?"#f0d060":"#f0e6c8", fontWeight: isPick?"bold":"normal" }}>
                                  {opt.name === "Other" ? "🌍 Other" : `${FLAG[opt.name]||"🏳️"} ${opt.name}`}
                                </span>
                                <span style={{ fontSize:12, color:"#f0d060", fontWeight:"bold" }}>+{opt.pts} pts</span>
                              </div>
                              {won && <div style={{ fontSize:11, color:"#8fffb0", marginTop:4 }}>🎉 Correct! +{opt.pts} pts</div>}
                              {lost && <div style={{ fontSize:11, color:"#ff9090", marginTop:4 }}>😬 Wrong pick</div>}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* PHASE 2 — TIEBREAKER */}
            {picksPhase==="p2" && p2Tab==="tb2" && (
              <div style={{ ...S.card, borderColor:"rgba(255,180,50,0.4)", background:"rgba(255,140,0,0.06)" }}>
                <div style={{ fontSize:11, fontWeight:"bold", color:"#f0d060", marginBottom:6, letterSpacing:1 }}>🔢 PHASE 2 TIEBREAKER</div>
                <div style={{ fontSize:12, color:"#9ab8a0", marginBottom:12 }}>Used only to break ties in Phase 2 standings. Doesn't affect your score directly.</div>
                <div style={{ fontSize:13, color:"#f0e6c8", marginBottom:8 }}>{TIEBREAKER_P2.question}</div>
                <div style={{ fontSize:11, color:"#9ab8a0", marginBottom:10, lineHeight:1.5 }}>{TIEBREAKER_P2.hint}</div>
                <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:14 }}>
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
                    style={{ ...S.input, width:130, fontSize:20, textAlign:"center", padding:"10px" }}
                    disabled={isPhase2Locked()}
                  />
                  <span style={{ fontSize:13, color:"#9ab8a0" }}>minute</span>
                  {tbP2 && <span style={{ fontSize:13, color:"#f0d060", fontWeight:"bold" }}>✓ {tbP2}'</span>}
                </div>
                {isPhase2Locked()
                  ? <div style={{ fontSize:11, color:"#ff9090", marginTop:10 }}>🔒 Locked</div>
                  : <div style={{ fontSize:11, color:"#9ab8a0", marginTop:10 }}>Locks Jun 28 at 3pm ET with bracket picks</div>
                }
              </div>
            )}

          </div>
        )}

        {/* ── ADMIN ── */}
        {screen==="admin" && isAdmin && (
          <div>
            {/* Header */}
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:14 }}>
              <h2 style={{ margin:0, fontSize:20, color:"#f0d060" }}>⚙️ Admin Panel</h2>
              <button onClick={() => {
                if (adminSessionToken.current) {
                  fetch(`${DB_URL}/pool/adminSession.json`, { method: "DELETE" }).catch(() => {});
                  adminSessionToken.current = null;
                }
                setScreen("home"); setCurrentPlayer(null); setIsAdmin(false); try { localStorage.removeItem("wc2026_session"); localStorage.removeItem("wc2026_admin"); } catch {}
              }} style={{ background:"rgba(255,255,255,0.07)", border:"1px solid rgba(255,255,255,0.1)", borderRadius:6, padding:"6px 10px", color:"#9ab8a0", cursor:"pointer", fontSize:12 }}>← Logout</button>
            </div>

            {/* Tab bar */}
            <div style={{ display:"flex", gap:4, marginBottom:16 }}>
              {[["settings","⚙️ Settings"],["audit", needsOverrideCount > 0 ? `📋 Audit 🔴${needsOverrideCount}` : "📋 Results Audit"],["players","👥 Players"],["debug","🔍 Debug Log"]].map(([key,label]) => (
                <button key={key} onClick={() => setAdminTab(key)} style={{
                  flex:1, padding:"8px 4px", borderRadius:6, border:"1px solid",
                  borderColor: adminTab===key ? "#f0d060" : "rgba(255,255,255,0.12)",
                  background: adminTab===key ? "rgba(240,208,96,0.15)" : "rgba(255,255,255,0.04)",
                  color: adminTab===key ? "#f0d060" : "#9ab8a0", cursor:"pointer", fontSize:11, fontWeight: adminTab===key?"bold":"normal",
                }}>{label}</button>
              ))}
            </div>

            {/* ── SETTINGS TAB ── */}
            {adminTab==="settings" && (
              <div style={S.card}>
                <div style={{ fontSize:11, color:"#9ab8a0", marginBottom:12, letterSpacing:1 }}>💰 POOL SETTINGS</div>
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
                  const fresh = await dbLoad();
                  const s = { ...(fresh.settings||settings), entryFee: parseFloat(editFee)||0, commCut: parseFloat(editComm)||0, p1Split: parseFloat(editP1Split)||50, payouts1: editPayouts1.map(v => parseFloat(v)||0), payouts2: editPayouts2.map(v => parseFloat(v)||0) };
                  setSettings(s);
                  await dbSave(players, predictions, paid, s);
                }} style={{ ...S.btn, fontSize:11, padding:"6px 16px" }}>💾 Save Settings</button>
                {(() => {
                  const { pot1, pot2, total, commCut, paidCount } = calcPot(players, paid, settings);
                  const entryFee = settings.entryFee || 25;
                  return (
                    <div style={{ fontSize:11, color:"#9ab8a0", marginTop:10, lineHeight:1.8 }}>
                      <div>{paidCount} paid · collected <strong style={{ color:"#f0d060" }}>${total}</strong> · commissioner <strong style={{ color:"#ff9090" }}>−${commCut}</strong> · distributable <strong style={{ color:"#8fffb0" }}>${total - commCut}</strong></div>
                      <div>Phase 1 pot <strong style={{ color:"#f0d060" }}>${pot1}</strong> · Phase 2 pot <strong style={{ color:"#f0d060" }}>${pot2}</strong></div>
                      {paidCount >= 2 && <div style={{ color:"#aab0ff" }}>Last place refund <strong>${entryFee}</strong> per phase</div>}
                    </div>
                  );
                })()}
              </div>
            )}

            {/* ── PLAYERS TAB ── */}
            {adminTab==="players" && (
              <div style={S.card}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
                  <div style={{ fontSize:11, color:"#9ab8a0", letterSpacing:1 }}>PLAYERS — track payment & delete</div>
                  <button onClick={exportCSV} style={{ ...S.btn, fontSize:11, padding:"5px 12px" }}>⬇️ Export CSV</button>
                </div>
                {players.length === 0 && <div style={{ color:"#9ab8a0", fontSize:12 }}>No players yet.</div>}
                {players.map(p => (
                  <div key={p.id} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"10px 0", borderBottom:"1px solid rgba(255,255,255,0.05)", gap:8, flexWrap:"wrap" }}>
                    <div style={{ flex:1 }}>
                      <span style={{ fontSize:14, color:"#f0e6c8" }}>{displayName(p)}</span>
                      <span style={{ fontSize:11, color:"#9ab8a0", marginLeft:8 }}>{predictions[p.id] ? "✓ picks" : "no picks"}</span>
                      <div style={{ fontSize:9, color:"rgba(154,184,160,0.45)", marginTop:2, fontFamily:"monospace", userSelect:"all" }}>{p.id}</div>
                    </div>
                    <div style={{ display:"flex", gap:6, alignItems:"center" }}>
                      {["cash","venmo","unpaid"].map(method => {
                        const isPaid = paid[p.id];
                        const active = method === "unpaid" ? !isPaid : paid[p.id+"_method"] === method;
                        return (
                          <button key={method} onClick={async () => {
                            const newPaid = { ...paid };
                            if (method === "unpaid") { newPaid[p.id] = false; delete newPaid[p.id+"_method"]; }
                            else { newPaid[p.id] = true; newPaid[p.id+"_method"] = method; }
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
                ))}
              </div>
            )}

            {/* ── DEBUG LOG TAB ── */}
            {adminTab==="debug" && (
              <div>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
                  <div style={{ fontSize:11, color:"#9ab8a0" }}>
                    Breadcrumbs of every write to pool/settled/* and dbSave. Helps trace unexpected resets.
                  </div>
                  <div style={{ display:"flex", gap:6 }}>
                    <button onClick={async () => {
                      const r = await fetch(`${DB_URL}/pool/_breadcrumbs.json`);
                      const data = await r.json();
                      const entries = Object.values(data || {}).sort((a,b) => new Date(b.ts) - new Date(a.ts));
                      setBreadcrumbs(entries);
                    }} style={{ ...S.btn, fontSize:11, padding:"5px 10px" }}>🔄 Load</button>
                    <button onClick={async () => {
                      if (!window.confirm("Clear all debug breadcrumbs?")) return;
                      await fetch(`${DB_URL}/pool/_breadcrumbs.json`, { method:"DELETE" });
                      setBreadcrumbs([]);
                    }} style={{ background:"rgba(255,160,50,0.15)", border:"1px solid rgba(255,160,50,0.3)", borderRadius:6, padding:"5px 10px", color:"#ffb060", cursor:"pointer", fontSize:11 }}>Clear</button>
                  </div>
                </div>
                {breadcrumbs.length === 0 && <div style={{ ...S.card, fontSize:11, color:"#9ab8a0", textAlign:"center" }}>No breadcrumbs loaded. Click Load.</div>}
                {breadcrumbs.map((b, i) => (
                  <div key={i} style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.06)", borderRadius:6, padding:"8px 10px", marginBottom:5, fontSize:11 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", marginBottom:3 }}>
                      <span style={{ color:"#f0d060", fontWeight:"bold" }}>{b.key}</span>
                      <span style={{ color:"#9ab8a0" }}>{new Date(b.ts).toLocaleString()}</span>
                    </div>
                    <div style={{ color:"#c8b8a0", fontFamily:"monospace", fontSize:10, wordBreak:"break-all" }}>summary: {b.summary}</div>
                    {b.stack && <div style={{ color:"#666", fontFamily:"monospace", fontSize:9, marginTop:2, wordBreak:"break-all" }}>{b.stack}</div>}
                  </div>
                ))}
              </div>
            )}
            {adminTab==="audit" && (() => {
              // Phase sub-tabs
              const auditBtnStyle = (ph) => ({
                padding:"6px 18px", borderRadius:6, border:"1px solid", cursor:"pointer", fontSize:12,
                borderColor: auditPhase===ph ? "#f0d060" : "rgba(255,255,255,0.12)",
                background: auditPhase===ph ? "rgba(240,208,96,0.15)" : "rgba(255,255,255,0.04)",
                color: auditPhase===ph ? "#f0d060" : "#9ab8a0", fontWeight: auditPhase===ph ? "bold" : "normal",
              });

              // Settled result helpers — write individual values to pool/settled/*
              // Never bulk-writes, never clears. Corrections overwrite the same path.
              const settleResult = async (path, value, stateUpdater) => {
                stateUpdater();
                await settlePut(path, value);
              };

              // Compute items that should be settled by now but are still null (API failed to resolve)
              const needsOverride = [];
              // P1 groups: group stage complete but ranking still null
              if (isGroupResultsExpected()) {
                Object.keys(TEAMS_BY_GROUP).forEach(g => {
                  if (!liveResults?.groupRankings?.[g]) needsOverride.push({ phase:"p1", type:"group", label:`Group ${g} ranking`, key:"groupRankings_"+g });
                });
              }
              // P1 props: lock time passed but result still null
              DAILY_PROPS.forEach((prop, i) => {
                if (isPropResultExpected(i) && (liveResults?.propResults?.[i] === null || liveResults?.propResults?.[i] === undefined)) {
                  needsOverride.push({ phase:"p1", type:"prop", label:`${prop.date} — ${prop.q.substring(0,50)}…`, key:"propResults_"+i });
                }
              });
              // P1 tiebreaker: group stage complete but actual total goals still null
              if (isGroupResultsExpected() && (liveResults?.totalGoals === null || liveResults?.totalGoals === undefined)) {
                needsOverride.push({ phase:"p1", type:"tiebreaker", label:"P1 tiebreaker — total group stage goals", key:"totalGoals" });
              }
              // P2 bracket: round lock passed but match winner still null
              Object.entries(KNOCKOUT_ROUNDS).forEach(([round, matches]) => {
                if (isP2RoundResultExpected(round)) {
                  matches.forEach(m => {
                    if (!bracketWinners?.[m.id]) needsOverride.push({ phase:"p2", type:"bracket", label:`${ROUND_LABELS[round]}: ${m.label}`, key:"bracketWinners_"+m.id });
                  });
                }
              });
              // P2 props: round lock passed but result still null
              P2_PROPS.forEach(prop => {
                if (isP2RoundResultExpected(prop.round) && (p2PropResults?.[prop.id] === null || p2PropResults?.[prop.id] === undefined)) {
                  needsOverride.push({ phase:"p2", type:"prop", label:`${prop.round.toUpperCase()} — ${prop.q.substring(0,50)}…`, key:"p2PropResults_"+prop.id });
                }
              });
              // P2 tiebreaker: Final lock passed but actual first-goal minute still null
              if (isP2RoundResultExpected("final") && (bracketWinners?.finalFirstGoalMinute === null || bracketWinners?.finalFirstGoalMinute === undefined)) {
                needsOverride.push({ phase:"p2", type:"tiebreaker", label:"P2 tiebreaker — minute of first goal in the Final", key:"finalFirstGoalMinute" });
              }
              const p1Needs = needsOverride.filter(x => x.phase==="p1");
              const p2Needs = needsOverride.filter(x => x.phase==="p2");

              // P1 score breakdown per player
              const p1Breakdown = players.map(p => {
                const pred = predictions[p.id] || {};
                let groupPts = 0, propPts = 0;
                const groupDetail = Object.keys(TEAMS_BY_GROUP).map(g => {
                  const userR = pred.groupRankings?.[g];
                  const actualR = liveResults?.groupRankings?.[g];
                  const pts = calcGroupRankingPoints(userR, actualR);
                  groupPts += pts;
                  return { g, pts, userR, actualR };
                });
                const propDetail = DAILY_PROPS.map((prop, i) => {
                  const pick = pred.propPicks?.[i];
                  const actual = liveResults?.propResults?.[i];
                  const settled = actual !== null && actual !== undefined;
                  const won = settled && pick === actual;
                  const pts = won ? (actual ? prop.ptsYes : prop.ptsNo) : 0;
                  propPts += pts;
                  return { i, prop, pick, actual, pts, won, settled };
                });
                return { p, groupPts, propPts, total: groupPts + propPts, groupDetail, propDetail };
              }).sort((a,b) => b.total - a.total);

              // P2 score breakdown per player
              const p2Breakdown = players.map(p => {
                const pred = predictions[p.id] || {};
                let bracketPts = 0, propPts = 0, gbPts = 0;
                const bracketDetail = Object.entries(ROUND_PTS).flatMap(([round, roundPts]) =>
                  (KNOCKOUT_ROUNDS[round]||[]).map(match => {
                    const pick = pred.phase2Picks?.[match.id];
                    const actual = bracketWinners?.[match.id];
                    const resolvedPick = resolvePickToTeam(pick, { groupRankings: liveResults?.groupRankings, bracketSlots });
                    const won = pick && actual && resolvedPick === actual;
                    if (won) bracketPts += roundPts;
                    return { match, round, roundPts, pick, actual, won };
                  })
                );
                const propDetail = P2_PROPS.map(prop => {
                  const pick = pred.p2PropPicks?.[prop.id];
                  const actual = p2PropResults?.[prop.id];
                  const settled = actual !== null && actual !== undefined;
                  const won = settled && pick === actual;
                  const pts = won ? (actual ? prop.ptsYes : prop.ptsNo) : 0;
                  propPts += pts;
                  return { prop, pick, actual, pts, won, settled };
                });
                // Golden boot
                const gbPick = pred.goldenBootPick;
                const gbAnswer = goldenBoot?.answer;
                if (gbPick && gbAnswer && gbPick === gbAnswer) {
                  const opt = gbPick === "Other" ? { pts: 20 } : goldenBoot?.options?.find(o => o.name === gbPick);
                  if (opt) gbPts = opt.pts;
                }
                return { p, bracketPts, propPts, gbPts, total: bracketPts + propPts + gbPts, bracketDetail, propDetail };
              }).sort((a,b) => b.total - a.total);

              return (
                <div>
                  {/* Needs-override alert banner */}
                  {needsOverride.length > 0 && (
                    <div style={{ background:"rgba(255,80,80,0.1)", border:"1px solid rgba(255,80,80,0.4)", borderRadius:6, padding:"10px 12px", marginBottom:12 }}>
                      <div style={{ fontSize:11, fontWeight:"bold", color:"#ff8080", marginBottom:6 }}>
                        ⚠️ {needsOverride.length} result{needsOverride.length>1?"s":""} need manual override — API returned null after lock time
                      </div>
                      {p1Needs.length > 0 && (
                        <div style={{ marginBottom:4 }}>
                          <div style={{ fontSize:10, color:"#ffb060", fontWeight:"bold", marginBottom:2 }}>Phase 1 ({p1Needs.length})</div>
                          {p1Needs.map(item => (
                            <div key={item.key} style={{ fontSize:10, color:"#ffb0b0", paddingLeft:8 }}>• {item.label}</div>
                          ))}
                        </div>
                      )}
                      {p2Needs.length > 0 && (
                        <div>
                          <div style={{ fontSize:10, color:"#ffb060", fontWeight:"bold", marginBottom:2 }}>Phase 2 ({p2Needs.length})</div>
                          {p2Needs.map(item => (
                            <div key={item.key} style={{ fontSize:10, color:"#ffb0b0", paddingLeft:8 }}>• {item.label}</div>
                          ))}
                        </div>
                      )}
                      <div style={{ fontSize:10, color:"#ff8080", marginTop:6, opacity:0.8 }}>Use the toggles below to set results manually.</div>
                    </div>
                  )}

                  {/* Override summary banner */}


                  {/* Phase tabs */}
                  <div style={{ display:"flex", gap:8, marginBottom:16 }}>
                    <button style={auditBtnStyle("p1")} onClick={() => setAuditPhase("p1")}>
                      Phase 1 — Group Stage{p1Needs.length > 0 ? ` 🔴${p1Needs.length}` : ""}
                    </button>
                    <button style={auditBtnStyle("p2")} onClick={() => setAuditPhase("p2")}>
                      Phase 2 — Knockouts{p2Needs.length > 0 ? ` 🔴${p2Needs.length}` : ""}
                    </button>
                  </div>

                  {/* ── P1 AUDIT ── */}
                  {auditPhase==="p1" && (
                    <div>
                      {/* Group Results */}
                      <div style={S.card}>
                        <div style={{ fontSize:11, color:"#9ab8a0", marginBottom:8, letterSpacing:1, display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:8 }}>
                          <span>🏅 GROUP RESULTS — click a position to edit</span>
                          <button disabled={groupSheetImport.loading} onClick={async () => {
                            setGroupSheetImport({ loading:true, error:"", diff:null, applying:false, done:"" });
                            try {
                              const sheet = await fetchScoresheet();
                              const fresh = await dbLoad();
                              const freshLR = fresh.liveResults || {};
                              const currentRankings = freshLR.groupRankings || {};
                              const diff = [];
                              sheet.group.forEach(row => {
                                const g = (row.id || "").trim().toUpperCase();
                                if (!TEAMS_BY_GROUP[g]) return;
                                if (freshLR.groupFinal?.[g]) return; // locked — skip
                                const sheetRanking = [row.field1, row.field2, row.field3, row.field4].map(t => (t||"").trim());
                                if (sheetRanking.every(t => !t)) return; // all blank — nothing to import
                                // Validate team names against TEAMS_BY_GROUP[g]
                                const validTeams = new Set(TEAMS_BY_GROUP[g]);
                                const invalid = sheetRanking.filter(t => t && !validTeams.has(t));
                                if (invalid.length) {
                                  diff.push({ g, error: `Unknown team(s) for Group ${g}: ${invalid.join(", ")}` });
                                  return;
                                }
                                const currentRanking = currentRankings[g] || [null,null,null,null];
                                const changed = JSON.stringify(currentRanking) !== JSON.stringify(sheetRanking.map(t => t || null));
                                if (changed) {
                                  diff.push({ g, from: currentRanking, to: sheetRanking.map(t => t || null) });
                                }
                              });
                              setGroupSheetImport({ loading:false, error:"", diff, applying:false, done:"" });
                            } catch (e) {
                              setGroupSheetImport({ loading:false, error:e.message, diff:null, applying:false, done:"" });
                            }
                          }} style={{ ...S.btn, fontSize:11, padding:"4px 10px" }}>{groupSheetImport.loading ? "Loading…" : "📥 Preview Import from Sheet"}</button>
                        </div>
                        {groupSheetImport.error && <div style={{ fontSize:11, color:"#ff9090", marginBottom:8 }}>Error: {groupSheetImport.error}</div>}
                        {groupSheetImport.done && <div style={{ fontSize:11, color:"#8fffb0", marginBottom:8 }}>{groupSheetImport.done}</div>}
                        {groupSheetImport.diff && (
                          <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(240,208,96,0.25)", borderRadius:6, padding:"8px 10px", marginBottom:12 }}>
                            {groupSheetImport.diff.length === 0 ? (
                              <div style={{ fontSize:11, color:"#9ab8a0" }}>No changes — sheet matches current results.</div>
                            ) : (
                              <>
                                <div style={{ fontSize:11, color:"#f0d060", marginBottom:6 }}>Changes found ({groupSheetImport.diff.filter(d=>!d.error).length}), errors ({groupSheetImport.diff.filter(d=>d.error).length}):</div>
                                {groupSheetImport.diff.map((d,idx) => d.error ? (
                                  <div key={idx} style={{ fontSize:11, color:"#ff9090", marginBottom:4 }}>⚠️ {d.error}</div>
                                ) : (
                                  <div key={idx} style={{ fontSize:11, color:"#c8b8a0", marginBottom:4, display:"flex", gap:6, flexWrap:"wrap" }}>
                                    <span style={{ color:"#9ab8a0", minWidth:50 }}>Group {d.g}</span>
                                    <span>{d.from.map(t=>t||"—").join(", ")} → <b style={{ color:"#8fffb0" }}>{d.to.map(t=>t||"—").join(", ")}</b></span>
                                  </div>
                                ))}
                                {groupSheetImport.diff.some(d=>!d.error) && (
                                  <button disabled={groupSheetImport.applying} onClick={async () => {
                                    setGroupSheetImport(s => ({ ...s, applying:true }));
                                    try {
                                      const applied = groupSheetImport.diff.filter(d=>!d.error);
                                      for (const d of applied) { await settlePut("groupRankings/"+d.g, d.to); }
                                      const fresh = await dbLoad();
                                      setLiveResults(fresh.liveResults);
                                      setGroupSheetImport({ loading:false, error:"", diff:null, applying:false, done:`Applied ${applied.length} update(s).` });
                                    } catch (e) {
                                      setGroupSheetImport(s => ({ ...s, applying:false, error:e.message }));
                                    }
                                  }} style={{ ...S.btn, fontSize:11, padding:"4px 12px", marginTop:6 }}>{groupSheetImport.applying ? "Applying…" : `Apply ${groupSheetImport.diff.filter(d=>!d.error).length} change(s)`}</button>
                                )}
                              </>
                            )}
                          </div>
                        )}
                        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                          {Object.keys(TEAMS_BY_GROUP).map(g => {
                            const actual = liveResults?.groupRankings?.[g] || [null,null,null,null];
                            const teams = TEAMS_BY_GROUP[g];
                            const isFinal = !!liveResults?.groupFinal?.[g];
                            return (
                              <div key={g} style={{ background:"rgba(255,255,255,0.04)", borderRadius:6, padding:"8px 10px" }}>
                                <div style={{ fontSize:10, color:"#f0d060", fontWeight:"bold", marginBottom:6, display:"flex", alignItems:"center", justifyContent:"space-between", gap:4 }}>
                                  <span>GROUP {g}</span>
                                  <button onClick={async () => {
                                    const fresh = await dbLoad();
                                    const freshLR = fresh.liveResults || {};
                                    const newVal = !(freshLR.groupFinal?.[g]);
                                    await settlePut("groupFinal/"+g, newVal);
                                    setLiveResults({ ...freshLR, groupFinal: { ...(freshLR.groupFinal||{}), [g]: newVal } });
                                  }} style={{ fontSize:9, fontWeight:"normal", padding:"2px 7px", borderRadius:10, border:"1px solid", cursor:"pointer", borderColor: isFinal ? "rgba(140,255,176,0.5)" : "rgba(255,255,255,0.15)", background: isFinal ? "rgba(140,255,176,0.15)" : "rgba(255,255,255,0.04)", color: isFinal ? "#8fffb0" : "#9ab8a0" }}>
                                    {isFinal ? "✅ Final" : "📊 Provisional"}
                                  </button>
                                </div>
                                {[0,1,2,3].map(idx => {
                                  const isEditing = editingGroup?.g === g && editingGroup?.idx === idx;
                                  const team = actual[idx];
                                  return (
                                    <div key={idx} style={{ display:"flex", alignItems:"center", gap:4, marginBottom:3 }}>
                                      <span style={{ fontSize:10, color:"#9ab8a0", width:14 }}>{idx+1}.</span>
                                      {isEditing ? (
                                        <div style={{ display:"flex", gap:4, flex:1 }}>
                                          <select value={editingGroupVal} onChange={e => setEditingGroupVal(e.target.value)}
                                            style={{ ...S.input, flex:1, fontSize:11, padding:"2px 4px" }}>
                                            <option value="">— clear —</option>
                                            {teams.map(t => <option key={t} value={t}>{t}</option>)}
                                          </select>
                                          <button onClick={async () => {
                                            const fresh = await dbLoad();
                                            const freshLR = fresh.liveResults || {};
                                            if (freshLR.groupFinal?.[g]) { setEditingGroup(null); return; } // guard: re-check at save time
                                            const actualFresh = freshLR.groupRankings?.[g] || [null,null,null,null];
                                            const newRanking = [0,1,2,3].map(i => i===idx ? (editingGroupVal||null) : (actualFresh[i]||null));
                                            setEditingGroup(null);
                                            await settlePut("groupRankings/"+g, newRanking);
                                            setLiveResults({ ...freshLR, groupRankings: { ...(freshLR.groupRankings||{}), [g]: newRanking } });
                                          }} style={{ ...S.btn, fontSize:10, padding:"2px 8px" }}>✓</button>
                                          <button onClick={() => setEditingGroup(null)} style={{ background:"rgba(255,255,255,0.07)", border:"1px solid rgba(255,255,255,0.1)", borderRadius:4, padding:"2px 6px", color:"#9ab8a0", cursor:"pointer", fontSize:10 }}>✕</button>
                                        </div>
                                      ) : (
                                        <div onClick={() => { if (isFinal) return; setEditingGroup({g, idx}); setEditingGroupVal(team||""); }}
                                          style={{ flex:1, fontSize:11, color: team?"#f0e6c8":"#555", cursor: isFinal ? "default" : "pointer", padding:"2px 6px", borderRadius:4, background:"rgba(255,255,255,0.03)", display:"flex", alignItems:"center", gap:4 }}>
                                          {team ? <>{tf(team)} {team}</> : <span style={{ color:"#555" }}>—</span>}
                                          {!isFinal && <span style={{ marginLeft:"auto", fontSize:9, color:"#666" }}>✏️</span>}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            );
                          })}
                        </div>
                      </div>

                      {/* P1 Tiebreaker */}
                      <div style={S.card}>
                        <div style={{ fontSize:11, color:"#9ab8a0", marginBottom:8, letterSpacing:1 }}>🔢 P1 TIEBREAKER — total group stage goals</div>
                        <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                          <input type="number" value={tbAnswerP1Input} onChange={e => setTbAnswerP1Input(e.target.value)}
                            placeholder={liveResults?.totalGoals != null ? String(liveResults.totalGoals) : "e.g. 158"}
                            style={{ ...S.input, width:100, fontSize:12, padding:"4px 8px" }} />
                          <button onClick={async () => {
                            const val = tbAnswerP1Input !== "" ? parseInt(tbAnswerP1Input, 10) : null;
                            if (val === null || Number.isNaN(val)) return;
                            const fresh = await dbLoad();
                            const freshLR = fresh.liveResults || {};
                            await settlePut("totalGoals", val);
                            setLiveResults({ ...freshLR, totalGoals: val });
                            setTbAnswerP1Input("");
                          }} style={{ ...S.btn, fontSize:11, padding:"4px 12px" }}>Save</button>
                          {liveResults?.totalGoals != null && <span style={{ fontSize:12, color:"#8fffb0", fontWeight:"bold" }}>✓ currently set: {liveResults.totalGoals} goals</span>}
                        </div>
                      </div>

                      {/* Prop Results */}
                      <div style={S.card}>
                        <div style={{ fontSize:11, color:"#9ab8a0", marginBottom:8, letterSpacing:1, display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:8 }}>
                          <span>🎲 PROP RESULTS — toggle to override</span>
                          <button disabled={sheetImport.loading} onClick={async () => {
                            setSheetImport({ loading:true, error:"", diff:null, applying:false, done:"" });
                            try {
                              const sheet = await fetchScoresheet();
                              const fresh = await dbLoad();
                              const freshLR = fresh.liveResults || {};
                              const currentProps = freshLR.propResults || Array(34).fill(null);
                              const diff = [];
                              sheet.prop1.forEach(row => {
                                const i = parseInt(row.id, 10);
                                if (Number.isNaN(i) || i < 0 || i >= DAILY_PROPS.length) return;
                                const sheetVal = parseYesNo(row.result);
                                if (sheetVal === null) return; // blank in sheet — nothing to import
                                const currentVal = currentProps[i];
                                const changed = currentVal !== sheetVal;
                                if (changed) {
                                  diff.push({ i, date: DAILY_PROPS[i].date, q: DAILY_PROPS[i].q, from: currentVal, to: sheetVal });
                                }
                              });
                              setSheetImport({ loading:false, error:"", diff, applying:false, done:"" });
                            } catch (e) {
                              setSheetImport({ loading:false, error:e.message, diff:null, applying:false, done:"" });
                            }
                          }} style={{ ...S.btn, fontSize:11, padding:"4px 10px" }}>{sheetImport.loading ? "Loading…" : "📥 Preview Import from Sheet"}</button>
                        </div>
                        {sheetImport.error && <div style={{ fontSize:11, color:"#ff9090", marginBottom:8 }}>Error: {sheetImport.error}</div>}
                        {sheetImport.done && <div style={{ fontSize:11, color:"#8fffb0", marginBottom:8 }}>{sheetImport.done}</div>}
                        {sheetImport.diff && (
                          <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(240,208,96,0.25)", borderRadius:6, padding:"8px 10px", marginBottom:12 }}>
                            {sheetImport.diff.length === 0 ? (
                              <div style={{ fontSize:11, color:"#9ab8a0" }}>No changes — sheet matches current results.</div>
                            ) : (
                              <>
                                <div style={{ fontSize:11, color:"#f0d060", marginBottom:6 }}>Changes found ({sheetImport.diff.length}):</div>
                                {sheetImport.diff.map(d => (
                                  <div key={d.i} style={{ fontSize:11, color:"#c8b8a0", marginBottom:4, display:"flex", gap:6, flexWrap:"wrap" }}>
                                    <span style={{ color:"#9ab8a0", minWidth:36 }}>{d.date}</span>
                                    <span style={{ flex:1, minWidth:120 }}>{d.q.substring(0,50)}…</span>
                                    <span>{d.from===true?"YES":d.from===false?"NO":"—"} → <b style={{ color:d.to?"#8fffb0":"#ff9090" }}>{d.to?"YES":"NO"}</b></span>
                                  </div>
                                ))}
                                <button disabled={sheetImport.applying} onClick={async () => {
                                  setSheetImport(s => ({ ...s, applying:true }));
                                  try {
                                    for (const d of sheetImport.diff) { await settlePut("propResults/"+d.i, d.to); }
                                    const fresh = await dbLoad();
                                    setLiveResults(fresh.liveResults);
                                    setSheetImport({ loading:false, error:"", diff:null, applying:false, done:`Applied ${sheetImport.diff.length} update(s).` });
                                  } catch (e) {
                                    setSheetImport(s => ({ ...s, applying:false, error:e.message }));
                                  }
                                }} style={{ ...S.btn, fontSize:11, padding:"4px 12px", marginTop:6 }}>{sheetImport.applying ? "Applying…" : `Apply ${sheetImport.diff.length} change(s)`}</button>
                              </>
                            )}
                          </div>
                        )}
                        {DAILY_PROPS.map((prop, i) => {
                          const actual = liveResults?.propResults?.[i];
                          const settled = actual !== null && actual !== undefined;
                          return (
                            <div key={i} style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 0", borderBottom:"1px solid rgba(255,255,255,0.04)", flexWrap:"wrap" }}>
                              <span style={{ fontSize:10, color:"#9ab8a0", minWidth:36 }}>{prop.date}</span>
                              <span style={{ fontSize:11, color:"#c8b8a0", flex:1, minWidth:120 }}>{prop.q.substring(0,60)}…</span>
                              <div style={{ display:"flex", gap:4 }}>
                                {[true, false].map(val => {
                                  const label = val===true?"YES":"NO";
                                  const active = settled && actual===val;
                                  return (
                                    <button key={label} onClick={async () => {
                                      const fresh = await dbLoad();
                                      const freshLR = fresh.liveResults || {};
                                      const newPropResults = [...(freshLR.propResults || Array(34).fill(null))];
                                      newPropResults[i] = val;
                                      await settlePut("propResults/"+i, val);
                                      setLiveResults({ ...freshLR, propResults: newPropResults });
                                    }} style={{
                                      padding:"3px 10px", borderRadius:4, border:"1px solid", fontSize:11, cursor:"pointer",
                                      borderColor: active ? (val===true?"#8fffb0":"#ff9090") : "rgba(255,255,255,0.1)",
                                      background: active ? (val===true?"rgba(100,255,150,0.15)":"rgba(255,100,100,0.15)") : "rgba(255,255,255,0.03)",
                                      color: active ? (val===true?"#8fffb0":"#ff9090") : "#555",
                                    }}>{label}</button>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      {/* P1 Score Breakdown */}
                      <div style={S.card}>
                        <div style={{ fontSize:11, color:"#9ab8a0", marginBottom:12, letterSpacing:1 }}>📊 P1 SCORE BREAKDOWN</div>
                        {p1Breakdown.map(({ p, groupPts, propPts, total, groupDetail, propDetail }, rank) => {
                          const expanded = expandedBreakdown["p1_"+p.id];
                          return (
                            <div key={p.id} style={{ borderBottom:"1px solid rgba(255,255,255,0.06)", marginBottom:4 }}>
                              <div onClick={() => setExpandedBreakdown(e => ({ ...e, ["p1_"+p.id]: !e["p1_"+p.id] }))}
                                style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 4px", cursor:"pointer" }}>
                                <span style={{ fontSize:12, color:"#f0d060", width:20 }}>#{rank+1}</span>
                                <span style={{ fontSize:13, color:"#f0e6c8", flex:1 }}>{displayName(p)}</span>
                                <span style={{ fontSize:11, color:"#9ab8a0" }}>{isGroupStageComplete() ? "Grp" : "Grp 📊"} <strong style={{ color:"#f0d060" }}>{groupPts}</strong></span>
                                <span style={{ fontSize:11, color:"#9ab8a0" }}>Props <strong style={{ color:"#f0d060" }}>{propPts}</strong></span>
                                <span style={{ fontSize:14, fontWeight:"bold", color:"#8fffb0", minWidth:50, textAlign:"right" }}>{total} pts</span>
                                <span style={{ fontSize:10, color:"#666" }}>{expanded?"▼":"▶"}</span>
                              </div>
                              {expanded && (
                                <div style={{ paddingLeft:28, paddingBottom:8 }}>
                                  <div style={{ fontSize:10, color:"#f0d060", fontWeight:"bold", marginBottom:4 }}>Groups</div>
                                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:3, marginBottom:8 }}>
                                    {groupDetail.map(({ g, pts, userR, actualR }) => (
                                      <div key={g} style={{ fontSize:10, color: pts>0?"#8fffb0":"#9ab8a0" }}>
                                        Group {g}: <strong>{pts}pts</strong>
                                        {pts===0 && actualR && <span style={{ color:"#555" }}> (0/{4*6})</span>}
                                      </div>
                                    ))}
                                  </div>
                                  <div style={{ fontSize:10, color:"#f0d060", fontWeight:"bold", marginBottom:4 }}>Props</div>
                                  {propDetail.map(({ i, prop, pick, actual, pts, won, settled }) => (
                                    settled ? (
                                      <div key={i} style={{ display:"flex", gap:6, fontSize:10, padding:"2px 0", color: won?"#8fffb0":pick!==null&&pick!==undefined?"#ff9090":"#9ab8a0" }}>
                                        <span style={{ minWidth:36 }}>{prop.date}</span>
                                        <span style={{ flex:1 }}>{prop.q.substring(0,45)}…</span>
                                        <span>{pick===null||pick===undefined?"—":pick?"YES":"NO"} → {actual?"YES":"NO"}</span>
                                        <span style={{ minWidth:28, textAlign:"right" }}>{won?"+"+pts:"0"}</span>
                                      </div>
                                    ) : null
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* ── P2 AUDIT ── */}
                  {auditPhase==="p2" && (
                    <div>
                      {/* Unlock override */}
                      <div style={S.card}>
                        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
                          <div style={{ fontSize:11, color:"#9ab8a0", letterSpacing:1 }}>🔓 OPEN P2 EARLY</div>
                          <div style={{ fontSize:9, color:"#666" }}>Lets players start filling in bracket/props/tiebreaker before Jun 27 · lock times at each round's kickoff are unaffected</div>
                        </div>
                        <button onClick={async () => {
                          const fresh = await dbLoad();
                          const freshSettings = fresh.settings || settings;
                          const newSettings = { ...freshSettings, p2Unlock: !freshSettings.p2Unlock };
                          setSettings(newSettings);
                          await dbSave(players, predictions, paid, newSettings);
                        }} style={{
                          padding:"7px 14px", borderRadius:8, border:"1px solid", cursor:"pointer", fontSize:12, fontWeight: settings.p2Unlock?"bold":"normal",
                          borderColor: settings.p2Unlock ? "rgba(140,255,176,0.5)" : "rgba(255,255,255,0.15)",
                          background: settings.p2Unlock ? "rgba(140,255,176,0.15)" : "rgba(255,255,255,0.04)",
                          color: settings.p2Unlock ? "#8fffb0" : "#9ab8a0",
                        }}>
                          {settings.p2Unlock ? "🔓 P2 open early — click to revert to schedule" : "🔒 P2 follows schedule — click to open early"}
                        </button>
                      </div>

                      {/* Bracket Slots */}
                      <div style={S.card}>
                        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10, flexWrap:"wrap", gap:8 }}>
                          <div style={{ fontSize:11, color:"#9ab8a0", letterSpacing:1 }}>🏟️ BRACKET SLOTS (R32)</div>
                          <button disabled={bracketSlotsSheetImport.loading} onClick={async () => {
                            setBracketSlotsSheetImport({ loading:true, error:"", diff:null, applying:false, done:"" });
                            try {
                              const sheet = await fetchScoresheet();
                              const fresh = await dbLoad();
                              const currentSlots = fresh.bracketSlots || {};
                              const sheetRows = {};
                              sheet.bracket.forEach(row => { if (row.id) sheetRows[row.id.trim()] = row; });
                              const diff = [];
                              KNOCKOUT_ROUNDS.r32.forEach(match => {
                                [["slotA","field3"],["slotB","field4"]].forEach(([slotKey, fieldKey]) => {
                                  const code = match[slotKey];
                                  if (!/^3[A-Z]+$/.test(code)) return; // only the 8 best-3rd-place codes
                                  const row = sheetRows[match.id];
                                  const sheetVal = (row?.[fieldKey] || "").trim();
                                  if (!sheetVal || sheetVal === code) return; // sheet still shows the unresolved placeholder
                                  const current = currentSlots[code] || null;
                                  if (current === sheetVal) return; // already matches — nothing to do
                                  diff.push({ code, label: match.label, from: current, to: sheetVal });
                                });
                              });
                              setBracketSlotsSheetImport({ loading:false, error:"", diff, applying:false, done:"" });
                            } catch (e) {
                              setBracketSlotsSheetImport({ loading:false, error:e.message, diff:null, applying:false, done:"" });
                            }
                          }} style={{ ...S.btn, fontSize:10, padding:"3px 8px" }}>{bracketSlotsSheetImport.loading ? "Loading…" : "📥 Preview Import from Sheet"}</button>
                          <div style={{ fontSize:9, color:"#666", width:"100%" }}>1X/2X auto-fill from group results · 3X entered manually or imported from sheet</div>
                        </div>
                        {bracketSlotsSheetImport.error && <div style={{ fontSize:11, color:"#ff9090", marginBottom:8 }}>Error: {bracketSlotsSheetImport.error}</div>}
                        {bracketSlotsSheetImport.done && <div style={{ fontSize:11, color:"#8fffb0", marginBottom:8 }}>{bracketSlotsSheetImport.done}</div>}
                        {bracketSlotsSheetImport.diff && (
                          <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(240,208,96,0.25)", borderRadius:6, padding:"8px 10px", marginBottom:12 }}>
                            {bracketSlotsSheetImport.diff.length === 0 ? (
                              <div style={{ fontSize:11, color:"#9ab8a0" }}>No changes — sheet matches current bracket slots.</div>
                            ) : (
                              <>
                                <div style={{ fontSize:11, color:"#f0d060", marginBottom:6 }}>Changes found ({bracketSlotsSheetImport.diff.length}):</div>
                                {bracketSlotsSheetImport.diff.map(d => (
                                  <div key={d.code} style={{ fontSize:11, color:"#c8b8a0", marginBottom:4, display:"flex", gap:6, flexWrap:"wrap" }}>
                                    <span style={{ color:"#9ab8a0", minWidth:70 }}>{d.code} ({d.label})</span>
                                    <span>{d.from || "—"} → <b style={{ color:"#8fffb0" }}>{d.to}</b></span>
                                  </div>
                                ))}
                                <button disabled={bracketSlotsSheetImport.applying} onClick={async () => {
                                  setBracketSlotsSheetImport(s => ({ ...s, applying:true }));
                                  try {
                                    for (const d of bracketSlotsSheetImport.diff) { await settlePut("bracketSlots/"+d.code, d.to); }
                                    const fresh = await dbLoad();
                                    setBracketSlots(fresh.bracketSlots);
                                    setBracketSlotsSheetImport({ loading:false, error:"", diff:null, applying:false, done:`Applied ${bracketSlotsSheetImport.diff.length} update(s).` });
                                  } catch (e) {
                                    setBracketSlotsSheetImport(s => ({ ...s, applying:false, error:e.message }));
                                  }
                                }} style={{ ...S.btn, fontSize:11, padding:"4px 12px", marginTop:6 }}>{bracketSlotsSheetImport.applying ? "Applying…" : `Apply ${bracketSlotsSheetImport.diff.length} change(s)`}</button>
                              </>
                            )}
                          </div>
                        )}
                        <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                          {KNOCKOUT_ROUNDS.r32.map(match => {
                            const renderSlot = (slot) => {
                              const is3x = slot.startsWith("3");
                              if (!is3x) {
                                // 1X/2X — read-only, resolved from settled group standings
                                const pos = slot[0] === "1" ? 0 : 1;
                                const g = slot[1];
                                const team = liveResults?.groupRankings?.[g]?.[pos] || null;
                                return (
                                  <div key={slot} style={{ background:"rgba(255,255,255,0.03)", borderRadius:4, padding:"4px 8px", fontSize:11, display:"flex", alignItems:"center", gap:4, flex:1 }}>
                                    <span style={{ color:"#f0d060", fontSize:10 }}>{slot}:</span>
                                    <span style={{ color: team?"#f0e6c8":"#555" }}>{team || "TBD"}</span>
                                    <span style={{ marginLeft:"auto", fontSize:9, color:"#555" }}>🔒</span>
                                  </div>
                                );
                              }
                              // 3X — editable
                              const team = bracketSlots?.[slot] || null;
                              const isEditing = editBracketSlot === slot;
                              return (
                                <div key={slot} style={{ background:"rgba(255,255,255,0.05)", borderRadius:4, padding:"4px 8px", fontSize:11, display:"flex", alignItems:"center", gap:4, flex:1 }}>
                                  <span style={{ color:"#f0d060", fontSize:10 }}>{slot}:</span>
                                  {isEditing ? (
                                    <>
                                      <input value={editBracketSlotVal} onChange={e => setEditBracketSlotVal(e.target.value)}
                                        style={{ ...S.input, width:100, padding:"2px 4px", fontSize:11 }} />
                                      <button onClick={async () => {
                                        const updated = { ...(bracketSlots||{}), [slot]: editBracketSlotVal };
                                        setBracketSlots(updated); await settlePut("bracketSlots/"+slot, editBracketSlotVal);
                                        setEditBracketSlot(null);
                                      }} style={{ ...S.btn, fontSize:10, padding:"2px 6px" }}>✓</button>
                                      <button onClick={() => setEditBracketSlot(null)} style={{ background:"transparent", border:"none", color:"#9ab8a0", cursor:"pointer", fontSize:11 }}>✕</button>
                                    </>
                                  ) : (
                                    <span onClick={() => { setEditBracketSlot(slot); setEditBracketSlotVal(team||""); }}
                                      style={{ color: team?"#f0e6c8":"#555", cursor:"pointer" }}>
                                      {team||"—"} <span style={{ fontSize:9, color:"#555" }}>✏️</span>
                                    </span>
                                  )}
                                </div>
                              );
                            };
                            return (
                              <div key={match.id} style={{ display:"flex", alignItems:"center", gap:8 }}>
                                <span style={{ fontSize:10, color:"#9ab8a0", minWidth:60 }}>{match.label}</span>
                                {renderSlot(match.slotA)}
                                <span style={{ fontSize:10, color:"#666" }}>vs</span>
                                {renderSlot(match.slotB)}
                              </div>
                            );
                          })}
                        </div>
                      </div>

                      {/* Golden Boot */}
                      <div style={S.card}>
                        <div style={{ fontSize:11, color:"#9ab8a0", marginBottom:10, letterSpacing:1, display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:8 }}>
                          <span>🥾 GOLDEN BOOT {goldenBoot?.options?.length === 3 ? <span style={{ color:"#8fffb0" }}>✓ options set</span> : <span style={{ color:"#aab0ff" }}>⏳ pending</span>}{goldenBoot?.answer && <span style={{ color:"#8fffb0" }}> · Winner: <strong>{goldenBoot.answer}</strong></span>}</span>
                          <button disabled={gbSheetImport.loading} onClick={async () => {
                            setGbSheetImport({ loading:true, error:"", diff:null, applying:false, done:"" });
                            try {
                              const sheet = await fetchScoresheet();
                              const fresh = await dbLoad();
                              const freshGb = fresh.goldenBoot || null;
                              if (!freshGb?.options?.length) {
                                setGbSheetImport({ loading:false, error:"Golden Boot options haven't been set yet — enter them manually or import below first.", diff:null, applying:false, done:"" });
                                return;
                              }
                              const validNames = new Set([...freshGb.options.map(o=>o.name), "Other"]);
                              const winners = sheet.goldenboot.filter(row => parseYesNo(row.result) === true);
                              if (winners.length === 0) {
                                setGbSheetImport({ loading:false, error:"", diff:[], applying:false, done:"" });
                                return;
                              }
                              if (winners.length > 1) {
                                setGbSheetImport({ loading:false, error:`Multiple rows marked YES (${winners.map(w=>w.id).join(", ")}) — only one winner allowed.`, diff:null, applying:false, done:"" });
                                return;
                              }
                              const winnerName = (winners[0].id || "").trim();
                              if (!validNames.has(winnerName)) {
                                setGbSheetImport({ loading:false, error:`"${winnerName}" doesn't match current Golden Boot options (${[...validNames].join(", ")}).`, diff:null, applying:false, done:"" });
                                return;
                              }
                              const changed = freshGb.answer !== winnerName;
                              setGbSheetImport({ loading:false, error:"", diff: changed ? [{ from: freshGb.answer, to: winnerName }] : [], applying:false, done:"" });
                            } catch (e) {
                              setGbSheetImport({ loading:false, error:e.message, diff:null, applying:false, done:"" });
                            }
                          }} style={{ ...S.btn, fontSize:11, padding:"4px 10px" }}>{gbSheetImport.loading ? "Loading…" : "📥 Preview Winner from Sheet"}</button>
                        </div>
                        {gbSheetImport.error && <div style={{ fontSize:11, color:"#ff9090", marginBottom:8 }}>Error: {gbSheetImport.error}</div>}
                        {gbSheetImport.done && <div style={{ fontSize:11, color:"#8fffb0", marginBottom:8 }}>{gbSheetImport.done}</div>}
                        {gbSheetImport.diff && (
                          <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(240,208,96,0.25)", borderRadius:6, padding:"8px 10px", marginBottom:12 }}>
                            {gbSheetImport.diff.length === 0 ? (
                              <div style={{ fontSize:11, color:"#9ab8a0" }}>No changes — sheet matches current results.</div>
                            ) : (
                              <>
                                <div style={{ fontSize:11, color:"#c8b8a0", marginBottom:6 }}>Winner: {gbSheetImport.diff[0].from || "—"} → <b style={{ color:"#8fffb0" }}>{gbSheetImport.diff[0].to}</b></div>
                                <button disabled={gbSheetImport.applying} onClick={async () => {
                                  setGbSheetImport(s => ({ ...s, applying:true }));
                                  try {
                                    const fresh = await dbLoad();
                                    const updated = { ...(fresh.goldenBoot||{}), answer: gbSheetImport.diff[0].to };
                                    setGoldenBoot(updated);
                                    await settlePut("goldenBoot/answer", gbSheetImport.diff[0].to);
                                    setGbSheetImport({ loading:false, error:"", diff:null, applying:false, done:`Set Golden Boot winner to ${gbSheetImport.diff[0].to}.` });
                                  } catch (e) {
                                    setGbSheetImport(s => ({ ...s, applying:false, error:e.message }));
                                  }
                                }} style={{ ...S.btn, fontSize:11, padding:"4px 12px" }}>{gbSheetImport.applying ? "Applying…" : "Apply"}</button>
                              </>
                            )}
                          </div>
                        )}

                        {/* Manual options entry — 3 slots, name + pts */}
                        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
                          <div style={{ fontSize:10, color:"#9ab8a0" }}>Options (3 — "Other" at 20pts always appended for players)</div>
                          <button disabled={gbOptionsSheetImport.loading} onClick={async () => {
                            setGbOptionsSheetImport({ loading:true, error:"", diff:null, applying:false, done:"" });
                            try {
                              const sheet = await fetchScoresheet();
                              const rows = sheet.goldenboot.filter(row => {
                                const id = (row.id||"").trim();
                                return id && id !== "Other" && !id.startsWith("(TBD");
                              });
                              if (rows.length === 0) {
                                setGbOptionsSheetImport({ loading:false, error:"No named options found in sheet's goldenboot rows.", diff:null, applying:false, done:"" });
                                return;
                              }
                              const fresh = await dbLoad();
                              const current = fresh.goldenBoot?.options || [];
                              const proposed = rows.slice(0,3).map(row => ({
                                name: (row.id||"").trim(),
                                pts: parseInt(row.field1, 10) || 0,
                              }));
                              const changed = JSON.stringify(current) !== JSON.stringify(proposed);
                              setGbOptionsSheetImport({ loading:false, error:"", diff: changed ? proposed : [], applying:false, done:"" });
                            } catch (e) {
                              setGbOptionsSheetImport({ loading:false, error:e.message, diff:null, applying:false, done:"" });
                            }
                          }} style={{ ...S.btn, fontSize:10, padding:"3px 8px" }}>{gbOptionsSheetImport.loading ? "Loading…" : "📥 Import Options from Sheet"}</button>
                        </div>
                        {gbOptionsSheetImport.error && <div style={{ fontSize:11, color:"#ff9090", marginBottom:8 }}>Error: {gbOptionsSheetImport.error}</div>}
                        {gbOptionsSheetImport.done && <div style={{ fontSize:11, color:"#8fffb0", marginBottom:8 }}>{gbOptionsSheetImport.done}</div>}
                        {gbOptionsSheetImport.diff && (
                          <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(240,208,96,0.25)", borderRadius:6, padding:"8px 10px", marginBottom:12 }}>
                            {gbOptionsSheetImport.diff.length === 0 ? (
                              <div style={{ fontSize:11, color:"#9ab8a0" }}>No changes — sheet matches current options.</div>
                            ) : (
                              <>
                                <div style={{ fontSize:11, color:"#c8b8a0", marginBottom:6 }}>
                                  {gbOptionsSheetImport.diff.map(o => `${o.name} (${o.pts}pts)`).join(", ")}
                                </div>
                                <button disabled={gbOptionsSheetImport.applying} onClick={async () => {
                                  setGbOptionsSheetImport(s => ({ ...s, applying:true }));
                                  try {
                                    const fresh = await dbLoad();
                                    const updated = { ...(fresh.goldenBoot||{}), options: gbOptionsSheetImport.diff, answer: fresh.goldenBoot?.answer ?? null };
                                    setGoldenBoot(updated);
                                    await settlePut("goldenBoot/options", gbOptionsSheetImport.diff);
                                    setGbOptionsSheetImport({ loading:false, error:"", diff:null, applying:false, done:"Options updated from sheet." });
                                  } catch (e) {
                                    setGbOptionsSheetImport(s => ({ ...s, applying:false, error:e.message }));
                                  }
                                }} style={{ ...S.btn, fontSize:11, padding:"4px 12px" }}>{gbOptionsSheetImport.applying ? "Applying…" : "Apply"}</button>
                              </>
                            )}
                          </div>
                        )}
                        <div style={{ display:"flex", flexDirection:"column", gap:4, marginBottom:10 }}>
                          {[0,1,2].map(idx => {
                            const opt = goldenBoot?.options?.[idx] || { name:"", pts:"" };
                            const isEditing = editGbOption === idx;
                            return (
                              <div key={idx} style={{ background:"rgba(255,255,255,0.05)", borderRadius:4, padding:"4px 8px", fontSize:11, display:"flex", alignItems:"center", gap:6 }}>
                                <span style={{ color:"#9ab8a0", fontSize:10, minWidth:14 }}>{idx+1}.</span>
                                {isEditing ? (
                                  <>
                                    <input value={editGbOptionVal.name} onChange={e => setEditGbOptionVal(v => ({ ...v, name:e.target.value }))}
                                      placeholder="Player name" style={{ ...S.input, width:160, padding:"2px 4px", fontSize:11 }} />
                                    <input value={editGbOptionVal.pts} onChange={e => setEditGbOptionVal(v => ({ ...v, pts:e.target.value }))}
                                      placeholder="pts" type="number" style={{ ...S.input, width:60, padding:"2px 4px", fontSize:11 }} />
                                    <button onClick={async () => {
                                      const newOptions = [ { name:"", pts:0 }, { name:"", pts:0 }, { name:"", pts:0 } ];
                                      (goldenBoot?.options || []).forEach((o,i) => { if (i<3) newOptions[i] = o; });
                                      newOptions[idx] = { name: editGbOptionVal.name.trim(), pts: parseInt(editGbOptionVal.pts,10) || 0 };
                                      const updated = { ...(goldenBoot||{}), options: newOptions, answer: goldenBoot?.answer ?? null };
                                      setGoldenBoot(updated); await settlePut("goldenBoot/options", newOptions);
                                      setEditGbOption(null);
                                    }} style={{ ...S.btn, fontSize:10, padding:"2px 6px" }}>✓</button>
                                    <button onClick={() => setEditGbOption(null)} style={{ background:"transparent", border:"none", color:"#9ab8a0", cursor:"pointer", fontSize:11 }}>✕</button>
                                  </>
                                ) : (
                                  <span onClick={() => { setEditGbOption(idx); setEditGbOptionVal({ name: opt.name||"", pts: opt.pts!=null?String(opt.pts):"" }); }}
                                    style={{ color: opt.name?"#f0e6c8":"#555", cursor:"pointer" }}>
                                    {opt.name ? `${opt.name} — ${opt.pts}pts` : "— not set —"} <span style={{ fontSize:9, color:"#555" }}>✏️</span>
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>

                        {goldenBoot?.options?.length === 3 && (
                          <div>
                            <div style={{ display:"flex", flexWrap:"wrap", gap:4, marginBottom:8 }}>
                              {[...goldenBoot.options, { name:"Other", pts:20 }].map(o => (
                                <div key={o.name} style={{ background: goldenBoot.answer===o.name?"rgba(100,255,150,0.15)":"rgba(255,255,255,0.05)", border:"1px solid", borderColor: goldenBoot.answer===o.name?"rgba(100,255,150,0.4)":"transparent", borderRadius:4, padding:"3px 8px", fontSize:11 }}>
                                  <span style={{ color:"#f0e6c8" }}>{o.name}</span> <span style={{ color:"#f0d060" }}>{o.pts}pts</span>
                                  {goldenBoot.answer===o.name && <span style={{ color:"#8fffb0" }}> ✓</span>}
                                </div>
                              ))}
                            </div>
                            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                              <span style={{ fontSize:11, color:"#9ab8a0" }}>Set winner:</span>
                              <select onChange={async e => {
                                if (!e.target.value) return;
                                const updated = { ...goldenBoot, answer: e.target.value };
                                setGoldenBoot(updated); await settlePut("goldenBoot/answer", e.target.value);
                              }} value={goldenBoot.answer||""} style={{ ...S.input, fontSize:11, padding:"4px 8px" }}>
                                <option value="">— not yet —</option>
                                {[...goldenBoot.options, { name:"Other" }].map(o => <option key={o.name} value={o.name}>{o.name}</option>)}
                              </select>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Bracket Match Results */}
                      <div style={S.card}>
                        <div style={{ fontSize:11, color:"#9ab8a0", marginBottom:8, letterSpacing:1, display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:8 }}>
                          <span>🏆 BRACKET MATCH RESULTS</span>
                          <button disabled={bracketSheetImport.loading} onClick={async () => {
                            setBracketSheetImport({ loading:true, error:"", diff:null, applying:false, done:"" });
                            try {
                              const sheet = await fetchScoresheet();
                              const fresh = await dbLoad();
                              const freshLiveResults = fresh.liveResults || {};
                              const freshLivePhase2 = fresh.bracketWinners || {};
                              const freshBracketSlots = fresh.bracketSlots || null;
                              const groupRankings = freshLiveResults.groupRankings || {};

                              // Build a row lookup from sheet by match id
                              const sheetRows = {};
                              sheet.bracket.forEach(row => { if (row.id) sheetRows[row.id.trim()] = row; });

                              const winnersMap = {}; // matchId -> winner team name (sheet values applied so far, for downstream resolution)
                              const diff = [];
                              const allRounds = ["r32","r16","qf","sf","third","final"];
                              allRounds.forEach(round => {
                                (KNOCKOUT_ROUNDS[round] || []).forEach(match => {
                                  const ctx = { groupRankings, bracketSlots: freshBracketSlots, winnersMap, bracketWinners: freshLivePhase2 };
                                  const teamA = resolveBracketSlot(match.slotA, ctx);
                                  const teamB = resolveBracketSlot(match.slotB, ctx);
                                  const row = sheetRows[match.id];
                                  const sheetWinner = (row?.result || "").trim();
                                  const currentWinner = freshLivePhase2[match.id] || null;
                                  if (!sheetWinner) {
                                    // No sheet value — carry forward existing winner (if any) so downstream slots still resolve
                                    if (currentWinner) winnersMap[match.id] = currentWinner;
                                    return;
                                  }
                                  // Validate the sheet's winner matches one of the resolved teams (when both are known)
                                  if (teamA && teamB && sheetWinner !== teamA && sheetWinner !== teamB) {
                                    diff.push({ matchId: match.id, round, label: match.label, error: `"${sheetWinner}" is not ${teamA} or ${teamB} for ${match.label}` });
                                    if (currentWinner) winnersMap[match.id] = currentWinner;
                                    return;
                                  }
                                  winnersMap[match.id] = sheetWinner;
                                  if (sheetWinner !== currentWinner) {
                                    diff.push({ matchId: match.id, round, label: match.label, teamA, teamB, from: currentWinner, to: sheetWinner });
                                  }
                                });
                              });
                              setBracketSheetImport({ loading:false, error:"", diff, applying:false, done:"" });
                            } catch (e) {
                              setBracketSheetImport({ loading:false, error:e.message, diff:null, applying:false, done:"" });
                            }
                          }} style={{ ...S.btn, fontSize:11, padding:"4px 10px" }}>{bracketSheetImport.loading ? "Loading…" : "📥 Preview Import from Sheet"}</button>
                        </div>
                        {bracketSheetImport.error && <div style={{ fontSize:11, color:"#ff9090", marginBottom:8 }}>Error: {bracketSheetImport.error}</div>}
                        {bracketSheetImport.done && <div style={{ fontSize:11, color:"#8fffb0", marginBottom:8 }}>{bracketSheetImport.done}</div>}
                        {bracketSheetImport.diff && (
                          <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(240,208,96,0.25)", borderRadius:6, padding:"8px 10px", marginBottom:12 }}>
                            {bracketSheetImport.diff.length === 0 ? (
                              <div style={{ fontSize:11, color:"#9ab8a0" }}>No changes — sheet matches current results.</div>
                            ) : (
                              <>
                                <div style={{ fontSize:11, color:"#f0d060", marginBottom:8 }}>
                                  Changes found ({bracketSheetImport.diff.filter(d=>!d.error).length}), errors ({bracketSheetImport.diff.filter(d=>d.error).length}):
                                </div>
                                {bracketSheetImport.diff.filter(d=>d.error).map((d,idx) => (
                                  <div key={"err"+idx} style={{ fontSize:11, color:"#ff9090", marginBottom:4 }}>⚠️ {d.error}</div>
                                ))}
                                <BracketImportTree diff={bracketSheetImport.diff.filter(d=>!d.error)} />
                                {bracketSheetImport.diff.some(d=>!d.error) && (
                                  <button disabled={bracketSheetImport.applying} onClick={async () => {
                                    setBracketSheetImport(s => ({ ...s, applying:true }));
                                    try {
                                      const applied = bracketSheetImport.diff.filter(d=>!d.error);
                                      for (const d of applied) { await settlePut("bracketWinners/"+d.matchId, d.to); }
                                      const fresh = await dbLoad();
                                      setLivePhase2(fresh.bracketWinners);
                                      setBracketSheetImport({ loading:false, error:"", diff:null, applying:false, done:`Applied ${applied.length} update(s).` });
                                    } catch (e) {
                                      setBracketSheetImport(s => ({ ...s, applying:false, error:e.message }));
                                    }
                                  }} style={{ ...S.btn, fontSize:11, padding:"4px 12px", marginTop:8 }}>{bracketSheetImport.applying ? "Applying…" : `Apply ${bracketSheetImport.diff.filter(d=>!d.error).length} change(s)`}</button>
                                )}
                              </>
                            )}
                          </div>
                        )}
                        <div style={{ fontSize:11, color:"#9ab8a0", marginBottom:12, letterSpacing:1 }}>All matches</div>
                        {(() => {
                          const winnersMap = {};
                          const rows = [];
                          Object.entries(KNOCKOUT_ROUNDS).forEach(([round, matches]) => {
                            rows.push(
                              <div key={round} style={{ marginBottom:14 }}>
                                <div style={{ fontSize:11, color:"#f0d060", fontWeight:"bold", marginBottom:6 }}>{ROUND_LABELS[round]} <span style={{ color:"#9ab8a0", fontWeight:"normal" }}>({ROUND_PTS[round]}pts)</span></div>
                                {matches.map(match => {
                                  const ctx = { groupRankings: liveResults?.groupRankings, bracketSlots, winnersMap, bracketWinners };
                                  const teamA = resolveBracketSlot(match.slotA, ctx) || match.slotA;
                                  const teamB = resolveBracketSlot(match.slotB, ctx) || match.slotB;
                                  const winner = bracketWinners?.[match.id];
                                  if (winner) winnersMap[match.id] = winner;
                                  const resolved = teamA !== match.slotA && teamB !== match.slotB;
                                  return (
                                    <div key={match.id} style={{ padding:"7px 0", borderBottom:"1px solid rgba(255,255,255,0.04)" }}>
                                      <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                                        <span style={{ fontSize:11, color:"#9ab8a0", minWidth:50 }}>{match.label}</span>
                                        <div style={{ display:"flex", alignItems:"center", gap:6, flex:1, flexWrap:"wrap" }}>
                                          {[teamA, teamB].map((team, ti) => {
                                            const isWinner = winner === team;
                                            const isLoser  = !!winner && !isWinner;
                                            return (
                                              <span key={ti} style={{ display:"contents" }}>
                                                {ti === 1 && <span style={{ fontSize:10, color:"#555" }}>vs</span>}
                                                <button onClick={async () => {
                                                  if (!resolved) return;
                                                  const fresh = await dbLoad();
                                                  if (isWinner) {
                                                    // re-click winner → clear result
                                                    await settlePut("bracketWinners/"+match.id, null);
                                                    const updated = { ...(fresh.bracketWinners||{}) };
                                                    delete updated[match.id];
                                                    setLivePhase2(updated);
                                                  } else {
                                                    await settlePut("bracketWinners/"+match.id, team);
                                                    setLivePhase2({ ...(fresh.bracketWinners||{}), [match.id]: team });
                                                  }
                                                }} style={{
                                                  padding:"3px 10px", borderRadius:4, border:"1px solid", fontSize:11,
                                                  cursor: resolved ? "pointer" : "default",
                                                  borderColor: isWinner ? "#8fffb0" : "rgba(255,255,255,0.1)",
                                                  background: isWinner ? "rgba(100,255,150,0.15)" : "rgba(255,255,255,0.03)",
                                                  color: isWinner ? "#8fffb0" : isLoser ? "#555" : "#c8b8a0",
                                                  textDecoration: isLoser ? "line-through" : "none",
                                                }}>{team}</button>
                                              </span>
                                            );
                                          })}
                                        </div>
                                        {winner
                                          ? <span style={{ fontSize:11, fontWeight:"bold", color:"#8fffb0", whiteSpace:"nowrap" }}>✓ {winner}</span>
                                          : <span style={{ fontSize:10, color:"#555", whiteSpace:"nowrap" }}>{resolved ? "pending" : "—"}</span>
                                        }
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            );
                          });
                          return rows;
                        })()}
                      </div>

                      {/* P2 Tiebreaker */}
                      <div style={S.card}>
                        <div style={{ fontSize:11, color:"#9ab8a0", marginBottom:8, letterSpacing:1 }}>🔢 P2 TIEBREAKER — minute of first goal in the Final</div>
                        <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                          <input type="number" value={tbAnswerP2Input} onChange={e => setTbAnswerP2Input(e.target.value)}
                            placeholder={bracketWinners?.finalFirstGoalMinute != null ? String(bracketWinners.finalFirstGoalMinute) : "e.g. 34"}
                            style={{ ...S.input, width:100, fontSize:12, padding:"4px 8px" }} />
                          <button onClick={async () => {
                            const val = tbAnswerP2Input !== "" ? parseInt(tbAnswerP2Input, 10) : null;
                            if (val === null || Number.isNaN(val)) return;
                            const fresh = await dbLoad();
                            await settlePut("bracketWinners/finalFirstGoalMinute", val);
                            setLivePhase2({ ...(fresh.bracketWinners||{}), finalFirstGoalMinute: val });
                            setTbAnswerP2Input("");
                          }} style={{ ...S.btn, fontSize:11, padding:"4px 12px" }}>Save</button>
                          {bracketWinners?.finalFirstGoalMinute != null && <span style={{ fontSize:12, color:"#8fffb0", fontWeight:"bold" }}>✓ currently set: {bracketWinners.finalFirstGoalMinute}'</span>}
                        </div>
                      </div>

                      {/* P2 Prop Results */}
                      <div style={S.card}>
                        <div style={{ fontSize:11, color:"#9ab8a0", marginBottom:8, letterSpacing:1, display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:8 }}>
                          <span>🎲 P2 PROP RESULTS — toggle to override</span>
                          <button disabled={p2PropSheetImport.loading} onClick={async () => {
                            setP2PropSheetImport({ loading:true, error:"", diff:null, applying:false, done:"" });
                            try {
                              const sheet = await fetchScoresheet();
                              const fresh = await dbLoad();
                              const freshLiveP2Props = fresh.p2PropResults || {};
                              const diff = [];
                              sheet.prop2.forEach(row => {
                                const id = (row.id || "").trim();
                                const prop = P2_PROPS.find(p => p.id === id);
                                if (!prop) return;
                                const sheetVal = parseYesNo(row.result);
                                if (sheetVal === null) return; // blank in sheet — nothing to import
                                const currentVal = freshLiveP2Props[id];
                                const changed = currentVal !== sheetVal;
                                if (changed) {
                                  diff.push({ id, round: prop.round, q: prop.q, from: currentVal, to: sheetVal });
                                }
                              });
                              setP2PropSheetImport({ loading:false, error:"", diff, applying:false, done:"" });
                            } catch (e) {
                              setP2PropSheetImport({ loading:false, error:e.message, diff:null, applying:false, done:"" });
                            }
                          }} style={{ ...S.btn, fontSize:11, padding:"4px 10px" }}>{p2PropSheetImport.loading ? "Loading…" : "📥 Preview Import from Sheet"}</button>
                        </div>
                        {p2PropSheetImport.error && <div style={{ fontSize:11, color:"#ff9090", marginBottom:8 }}>Error: {p2PropSheetImport.error}</div>}
                        {p2PropSheetImport.done && <div style={{ fontSize:11, color:"#8fffb0", marginBottom:8 }}>{p2PropSheetImport.done}</div>}
                        {p2PropSheetImport.diff && (
                          <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(240,208,96,0.25)", borderRadius:6, padding:"8px 10px", marginBottom:12 }}>
                            {p2PropSheetImport.diff.length === 0 ? (
                              <div style={{ fontSize:11, color:"#9ab8a0" }}>No changes — sheet matches current results.</div>
                            ) : (
                              <>
                                <div style={{ fontSize:11, color:"#f0d060", marginBottom:6 }}>Changes found ({p2PropSheetImport.diff.length}):</div>
                                {p2PropSheetImport.diff.map(d => (
                                  <div key={d.id} style={{ fontSize:11, color:"#c8b8a0", marginBottom:4, display:"flex", gap:6, flexWrap:"wrap" }}>
                                    <span style={{ color:"#f0d060", minWidth:36 }}>{d.round.toUpperCase()}</span>
                                    <span style={{ flex:1, minWidth:120 }}>{d.q.substring(0,50)}…</span>
                                    <span>{d.from===true?"YES":d.from===false?"NO":"—"} → <b style={{ color:d.to?"#8fffb0":"#ff9090" }}>{d.to?"YES":"NO"}</b></span>
                                  </div>
                                ))}
                                <button disabled={p2PropSheetImport.applying} onClick={async () => {
                                  setP2PropSheetImport(s => ({ ...s, applying:true }));
                                  try {
                                    for (const d of p2PropSheetImport.diff) { await settlePut("p2PropResults/"+d.id, d.to); }
                                    const fresh = await dbLoad();
                                    setLiveP2Props(fresh.p2PropResults);
                                    setP2PropSheetImport({ loading:false, error:"", diff:null, applying:false, done:`Applied ${p2PropSheetImport.diff.length} update(s).` });
                                  } catch (e) {
                                    setP2PropSheetImport(s => ({ ...s, applying:false, error:e.message }));
                                  }
                                }} style={{ ...S.btn, fontSize:11, padding:"4px 12px", marginTop:6 }}>{p2PropSheetImport.applying ? "Applying…" : `Apply ${p2PropSheetImport.diff.length} change(s)`}</button>
                              </>
                            )}
                          </div>
                        )}
                        {P2_PROPS.map(prop => {
                          const actual = p2PropResults?.[prop.id];
                          const settled = actual !== null && actual !== undefined;
                          return (
                            <div key={prop.id} style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 0", borderBottom:"1px solid rgba(255,255,255,0.04)", flexWrap:"wrap" }}>
                              <span style={{ fontSize:10, color:"#f0d060", minWidth:28 }}>{prop.round.toUpperCase()}</span>
                              <span style={{ fontSize:11, color:"#c8b8a0", flex:1, minWidth:120 }}>{prop.q.substring(0,60)}…</span>
                              <div style={{ display:"flex", gap:4 }}>
                                {[true, false].map(val => {
                                  const label = val===true?"YES":"NO";
                                  const active = settled && actual===val;
                                  return (
                                    <button key={label} onClick={async () => {
                                      const fresh = await dbLoad();
                                      await settlePut("p2PropResults/"+prop.id, val);
                                      setLiveP2Props({ ...(fresh.p2PropResults||{}), [prop.id]: val });
                                    }} style={{
                                      padding:"3px 10px", borderRadius:4, border:"1px solid", fontSize:11, cursor:"pointer",
                                      borderColor: active ? (val===true?"#8fffb0":"#ff9090") : "rgba(255,255,255,0.1)",
                                      background: active ? (val===true?"rgba(100,255,150,0.15)":"rgba(255,100,100,0.15)") : "rgba(255,255,255,0.03)",
                                      color: active ? (val===true?"#8fffb0":"#ff9090") : "#555",
                                    }}>{label}</button>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      {/* P2 Score Breakdown */}
                      <div style={S.card}>
                        <div style={{ fontSize:11, color:"#9ab8a0", marginBottom:12, letterSpacing:1 }}>📊 P2 SCORE BREAKDOWN</div>
                        {p2Breakdown.map(({ p, bracketPts, propPts, gbPts, total, bracketDetail, propDetail }, rank) => {
                          const expanded = expandedBreakdown["p2_"+p.id];
                          return (
                            <div key={p.id} style={{ borderBottom:"1px solid rgba(255,255,255,0.06)", marginBottom:4 }}>
                              <div onClick={() => setExpandedBreakdown(e => ({ ...e, ["p2_"+p.id]: !e["p2_"+p.id] }))}
                                style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 4px", cursor:"pointer" }}>
                                <span style={{ fontSize:12, color:"#f0d060", width:20 }}>#{rank+1}</span>
                                <span style={{ fontSize:13, color:"#f0e6c8", flex:1 }}>{displayName(p)}</span>
                                <span style={{ fontSize:11, color:"#9ab8a0" }}>Brkt <strong style={{ color:"#f0d060" }}>{bracketPts}</strong></span>
                                <span style={{ fontSize:11, color:"#9ab8a0" }}>Props <strong style={{ color:"#f0d060" }}>{propPts}</strong></span>
                                <span style={{ fontSize:11, color:"#9ab8a0" }}>GB <strong style={{ color:"#f0d060" }}>{gbPts}</strong></span>
                                <span style={{ fontSize:14, fontWeight:"bold", color:"#8fffb0", minWidth:50, textAlign:"right" }}>{total} pts</span>
                                <span style={{ fontSize:10, color:"#666" }}>{expanded?"▼":"▶"}</span>
                              </div>
                              {expanded && (
                                <div style={{ paddingLeft:28, paddingBottom:8 }}>
                                  <div style={{ fontSize:10, color:"#f0d060", fontWeight:"bold", marginBottom:4 }}>Bracket</div>
                                  {bracketDetail.filter(d => d.actual).map(({ match, round, roundPts, pick, actual, won }) => (
                                    <div key={match.id} style={{ display:"flex", gap:6, fontSize:10, padding:"2px 0", color: won?"#8fffb0":pick?"#ff9090":"#9ab8a0" }}>
                                      <span style={{ minWidth:60 }}>{ROUND_LABELS[round]}</span>
                                      <span style={{ flex:1 }}>{match.label}</span>
                                      <span>{pick||"—"} → {actual}</span>
                                      <span style={{ minWidth:30, textAlign:"right" }}>{won?"+"+roundPts:"0"}</span>
                                    </div>
                                  ))}
                                  <div style={{ fontSize:10, color:"#f0d060", fontWeight:"bold", marginTop:6, marginBottom:4 }}>P2 Props</div>
                                  {propDetail.filter(d => d.settled).map(({ prop, pick, actual, pts, won }) => (
                                    <div key={prop.id} style={{ display:"flex", gap:6, fontSize:10, padding:"2px 0", color: won?"#8fffb0":pick!==null&&pick!==undefined?"#ff9090":"#9ab8a0" }}>
                                      <span style={{ minWidth:28 }}>{prop.round.toUpperCase()}</span>
                                      <span style={{ flex:1 }}>{prop.q.substring(0,45)}…</span>
                                      <span>{pick===null||pick===undefined?"—":pick?"YES":"NO"} → {actual?"YES":"NO"}</span>
                                      <span style={{ minWidth:28, textAlign:"right" }}>{won?"+"+pts:"0"}</span>
                                    </div>
                                  ))}
                                  {gbPts > 0 && (
                                    <div style={{ fontSize:10, color:"#8fffb0", marginTop:4 }}>🥾 Golden Boot: +{gbPts}pts</div>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}

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
                  }}>{displayName(p)}</button>
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
              <h2 style={{ margin:0, fontSize:20, color:"#f0d060" }}>🏆 Leaderboard {lbLoading && <span style={{ fontSize:12, color:"#9ab8a0" }}>⏳</span>}</h2>
              <button onClick={async () => {
                setLbLoading(true);
                try {
                  const data = await dbLoad();
                  setPlayers(data.players);
                  setPredictions(data.predictions);
                  setPaid(data.paid || {});
                  if (data.liveResults) setLiveResults(data.liveResults);
                  if (data.bracketWinners) setLivePhase2(data.bracketWinners);
                  if (data.p2PropResults) setLiveP2Props(data.p2PropResults);
                            setFetchStatus("done");
                } catch {}
                setLbLoading(false);
              }} style={{ ...S.btn, fontSize:11, padding:"6px 12px" }}>
                {lbLoading ? "⏳" : "🔄 Reload"}
              </button>
            </div>

            {liveResults && (
              <div style={{ ...S.card, fontSize:12, color:"#9ab8a0", marginBottom:12 }}>
                <span style={{ color:"#f0d060" }}>📡</span> {liveResults.matchday||"Group Stage"} · {Object.values(liveResults.groupRankings||{}).filter(Boolean).length}/12 groups final · {(liveResults.propResults||[]).filter(v=>v!==null).length}/34 props settled
              </div>
            )}

            {/* Phase tabs */}
            <div style={{ display:"flex", gap:4, marginBottom:12 }}>
              {[["p1","🏅 Phase 1"],["p2","🏆 Phase 2"]].map(([ph, label]) => (
                <button key={ph} style={{ ...S.tab(lbPhase===ph), flex:1, fontSize:13 }} onClick={() => setLbPhase(ph)}>{label}</button>
              ))}
            </div>

            {/* Sub-tabs */}
            <div style={{ display:"flex", gap:4, marginBottom:14 }}>
              {[["standings","🏅 Standings"],["chart","📈 Chart"],["h2h","⚔️ H2H"],["results","📋 Results"]].map(([t,l]) => (
                <button key={t} style={S.tab(lbTab===t)} onClick={() => setLbTab(t)}>{l}</button>
              ))}
            </div>

            {/* ── P1 STANDINGS ── */}
            {lbPhase==="p1" && lbTab==="standings" && (() => {
              const lbActive = groupFinalOnly ? leaderboardFinalOnly : leaderboard;
              const { pot1, pot2, total, commCut, paidCount } = calcPot(players, paid, settings);
              const entryFee = settings.entryFee || 25;
              const prizes1 = calcPrizes(lbActive, paid, pot1, entryFee, settings.payouts1);
              const refund1 = entryFee;
              const dist1 = Math.max(0, pot1 - refund1);
              const pcts1 = settings.payouts1 || [60,25,10,5,0];
              const totalGroups = Object.keys(TEAMS_BY_GROUP).length;
              const finalGroupCount = Object.values(liveResults?.groupFinal || {}).filter(Boolean).length;
              return (
                <div>
                  <div style={{ ...S.card, borderColor:"rgba(100,200,100,0.3)", background:"rgba(0,100,40,0.1)", marginBottom:14 }}>
                    <div style={{ fontSize:11, fontWeight:"bold", color:"#8fffb0", marginBottom:8, letterSpacing:1 }}>💰 PHASE 1 POT · {paidCount} paid · ${total} collected · 🎩 ${commCut} commissioner</div>
                    <div style={{ background:"rgba(255,255,255,0.04)", borderRadius:8, padding:"8px 10px" }}>
                      <div style={{ fontSize:15, fontWeight:"bold", color:"#f0d060", marginBottom:4 }}>${pot1}</div>
                      {paidCount >= 2 && <div style={{ fontSize:10, color:"#aab0ff", marginBottom:4 }}>↩ last place ${refund1} back · distributable ${dist1}</div>}
                      {paidCount >= 2 && dist1 > 0 && (
                        <div style={{ fontSize:10, color:"#9ab8a0" }}>
                          {["🥇","🥈","🥉","4️⃣","5️⃣"].map((m,i) => pcts1[i]>0 ? `${m} $${Math.round(dist1*pcts1[i]/100)}` : null).filter(Boolean).join(" · ")}
                        </div>
                      )}
                    </div>
                  </div>
                  {finalGroupCount < totalGroups && (
                    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8, marginBottom:10, flexWrap:"wrap" }}>
                      <span style={{ fontSize:11, color:"#9ab8a0" }}>{finalGroupCount}/{totalGroups} groups final</span>
                      <div style={{ display:"flex", gap:4 }}>
                        <button onClick={() => setGroupFinalOnly(true)} style={{ fontSize:10, padding:"4px 10px", borderRadius:6, border:"1px solid", cursor:"pointer", borderColor: groupFinalOnly ? "rgba(140,255,176,0.5)" : "rgba(255,255,255,0.12)", background: groupFinalOnly ? "rgba(140,255,176,0.15)" : "rgba(255,255,255,0.04)", color: groupFinalOnly ? "#8fffb0" : "#9ab8a0", fontWeight: groupFinalOnly ? "bold" : "normal" }}>✅ Final only</button>
                        <button onClick={() => setGroupFinalOnly(false)} style={{ fontSize:10, padding:"4px 10px", borderRadius:6, border:"1px solid", cursor:"pointer", borderColor: !groupFinalOnly ? "rgba(240,208,96,0.5)" : "rgba(255,255,255,0.12)", background: !groupFinalOnly ? "rgba(240,208,96,0.15)" : "rgba(255,255,255,0.04)", color: !groupFinalOnly ? "#f0d060" : "#9ab8a0", fontWeight: !groupFinalOnly ? "bold" : "normal" }}>📊 Incl. provisional</button>
                      </div>
                    </div>
                  )}
                  {finalGroupCount < totalGroups && (
                    <div style={{ background:"rgba(255,200,50,0.1)", border:"1px solid rgba(255,200,50,0.25)", borderRadius:6, padding:"7px 12px", fontSize:11, color:"#f0d060", marginBottom:10 }}>
                      {groupFinalOnly
                        ? `📊 Showing points for ${finalGroupCount} finalized group${finalGroupCount===1?"":"s"} only — ${totalGroups-finalGroupCount} group${totalGroups-finalGroupCount===1?"":"s"} still provisional and excluded`
                        : `📊 Including provisional points for ${totalGroups-finalGroupCount} group${totalGroups-finalGroupCount===1?"":"s"} not yet marked final`}
                    </div>
                  )}
                  {lbLoading && <div style={{ color:"#9ab8a0", textAlign:"center", padding:20 }}>⏳ Loading…</div>}
                  {!lbLoading && lbActive.length===0 && <div style={{ color:"#9ab8a0" }}>No players yet.</div>}
                  {!lbLoading && lbActive.map((p, i) => {
                    const pred = predictions[p.id];
                    const grpDone = pred ? Object.keys(pred.groupRankings||{}).length : 0;
                    const prpDone = pred ? (pred.propPicks||[]).filter(x=>x!==null).length : 0;
                    const isLastPaid = lbActive.filter(x=>paid[x.id]).at(-1)?.id === p.id && paid[p.id];
                    return (
                      <div key={p.id} style={{ display:"flex", alignItems:"center", gap:12, background:i===0?"rgba(200,168,75,0.15)":"rgba(255,255,255,0.04)", borderRadius:8, padding:"12px 14px", marginBottom:8, border:`1px solid ${i===0?"rgba(200,168,75,0.4)":"rgba(255,255,255,0.06)"}` }}>
                        <div style={{ fontSize:20, minWidth:28, textAlign:"center" }}>{i===0?"🥇":i===1?"🥈":i===2?"🥉":i===3?"4️⃣":i===4?"5️⃣":`#${i+1}`}</div>
                        <div style={{ flex:1 }}>
                          <div style={{ fontSize:15, color:i===0?"#f0d060":"#f0e6c8", display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
                            {displayName(p)}
                            {paid[p.id] && <span style={{ fontSize:9, background:"rgba(100,200,100,0.2)", color:"#8fffb0", borderRadius:4, padding:"1px 5px" }}>paid {paid[p.id+"_method"]==="cash"?"💵":"💸"}</span>}
                            {!paid[p.id] && <span style={{ fontSize:9, background:"rgba(200,60,60,0.2)", color:"#ff9090", borderRadius:4, padding:"1px 5px" }}>unpaid</span>}
                            {isLastPaid && <span style={{ fontSize:9, background:"rgba(100,100,200,0.2)", color:"#aab0ff", borderRadius:4, padding:"1px 5px" }}>↩ refund</span>}
                            {prizes1[p.id] && prizes1[p.id] !== refund1 && <span style={{ fontSize:9, background:"rgba(200,168,75,0.3)", color:"#f0d060", borderRadius:4, padding:"1px 5px" }}>💰${prizes1[p.id]}</span>}
                          </div>
                          {(() => {
                            const grpsLocked = isGroupRankingsLocked();
                            const grpFlag = grpDone >= 12 ? "✅" : grpsLocked ? "🔒" : "⚠️";
                            const grpColor = grpDone >= 12 ? "#9ab8a0" : grpsLocked ? "#9ab8a0" : "#f0a020";
                            const unlockedTotal = DAILY_PROPS.filter((_,i) => !isPropLocked(i)).length;
                            const unlockedDone = pred ? (pred.propPicks||[]).filter((x,i) => x !== null && !isPropLocked(i)).length : 0;
                            const totalAnswered = pred ? (pred.propPicks||[]).filter(x => x !== null).length : 0;
                            // After group rankings lock, show total answered vs total props
                            // Before lock, show only unlocked props (actionable)
                            const prpDisplay = grpsLocked
                              ? `${totalAnswered}/34`
                              : `${unlockedDone}/${unlockedTotal || 34}`;
                            const allUnlockedDone = grpsLocked
                              ? totalAnswered >= 34
                              : (unlockedTotal === 0 || unlockedDone >= unlockedTotal);
                            const prpColor = allUnlockedDone ? "#9ab8a0" : "#f0a020";
                            const tbP1ok = pred?.tbP1 !== undefined && pred?.tbP1 !== null && pred?.tbP1 !== "";
                            const tbColor = tbP1ok ? "#9ab8a0" : grpsLocked ? "#9ab8a0" : "#f0a020";
                            const tbFlag = tbP1ok ? "✅" : grpsLocked ? "🔒" : "⚠️";
                            return (
                              <div style={{ display:"flex", gap:8, fontSize:10, marginTop:2, flexWrap:"wrap" }}>
                                <span style={{ color:grpColor }}>{grpFlag} {grpDone}/12 groups</span>
                                <span style={{ color:"#555" }}>·</span>
                                <span style={{ color:prpColor }}>{allUnlockedDone ? "✅" : "⚠️"} {prpDisplay} props</span>
                                <span style={{ color:"#555" }}>·</span>
                                <span style={{ color:tbColor }}>{tbFlag} TB</span>
                              </div>
                            );
                          })()}
                        </div>
                        <div style={{ textAlign:"right", minWidth:130 }}>
                          {(() => {
                            const pred = predictions[p.id] || {};
                            let gPts = 0;
                            Object.entries(pred.groupRankings || {}).forEach(([g, ranking]) => {
                              if (groupFinalOnly && !liveResults?.groupFinal?.[g]) return;
                              const actual = liveResults?.groupRankings?.[g];
                              if (actual) gPts += calcGroupRankingPoints(ranking, actual);
                            });
                            let pPts = 0;
                            (pred.propPicks || []).forEach((pick, idx) => {
                              const actual = liveResults?.propResults?.[idx];
                              if (actual === null || actual === undefined) return;
                              if (pick === actual) pPts += actual ? DAILY_PROPS[idx].ptsYes : DAILY_PROPS[idx].ptsNo;
                            });
                            const grpFlux = !groupFinalOnly && !isGroupStageComplete();
                            return (
                              <table style={{ borderCollapse:"collapse", marginLeft:"auto", fontSize:11 }}>
                                <tbody>
                                  {pPts > 0 && (
                                    <tr>
                                      <td style={{ color:"#9ab8a0", paddingRight:8, textAlign:"right" }}>props</td>
                                      <td style={{ color:"#f0e6c8", fontWeight:"bold", textAlign:"right" }}>{pPts}</td>
                                    </tr>
                                  )}
                                  <tr>
                                    <td style={{ color: grpFlux ? "rgba(154,184,160,0.5)" : "#9ab8a0", paddingRight:8, textAlign:"right", fontStyle: grpFlux ? "italic" : "normal" }}>
                                      {grpFlux ? "~groups" : "groups"}
                                    </td>
                                    <td style={{ color: grpFlux ? "rgba(240,208,96,0.45)" : "#f0e6c8", fontWeight:"bold", textAlign:"right", fontStyle: grpFlux ? "italic" : "normal" }}>{gPts}</td>
                                  </tr>
                                  <tr style={{ borderTop:"1px solid rgba(255,255,255,0.1)" }}>
                                    <td style={{ color:"#9ab8a0", paddingRight:8, textAlign:"right", paddingTop:3 }}>total</td>
                                    <td style={{ color:"#f0d060", fontWeight:"bold", fontSize:18, textAlign:"right", paddingTop:3 }}>{p.pts}</td>
                                  </tr>
                                </tbody>
                              </table>
                            );
                          })()}
                        </div>
                      </div>
                    );
                  })}
                  <div style={{ ...S.card, fontSize:11, color:"#9ab8a0", marginTop:8 }}>
                    Leaderboard syncs every 30s. P1 and P2 are independent pots.
                  </div>
                </div>
              );
            })()}

            {/* ── P2 STANDINGS ── */}
            {lbPhase==="p2" && lbTab==="standings" && (() => {
              const { pot1, pot2, total, commCut, paidCount } = calcPot(players, paid, settings);
              const entryFee = settings.entryFee || 25;
              const lb2 = [...leaderboard].sort((a, b) => {
                if (b.pts2 !== a.pts2) return b.pts2 - a.pts2;
                // Tiebreaker: closest to minute of first goal in the Final — only once Final is played
                const finalFirstGoal = bracketWinners?.finalFirstGoalMinute;
                if (bracketWinners?.final_1 && finalFirstGoal != null) {
                  const tbA = predictions[a.id]?.tbP2, tbB = predictions[b.id]?.tbP2;
                  if (tbA != null && tbB != null) return Math.abs(tbA - finalFirstGoal) - Math.abs(tbB - finalFirstGoal);
                }
                return 0;
              });
              const prizes2 = calcPrizes(lb2, paid, pot2, entryFee, settings.payouts2);
              const refund2 = entryFee;
              const dist2 = Math.max(0, pot2 - refund2);
              const pcts2 = settings.payouts2 || [60,25,10,5,0];
              return (
                <div>
                  {!isPhase2Open() && (
                    <div style={{ ...S.card, borderColor:"rgba(100,100,255,0.3)", background:"rgba(50,50,150,0.1)", marginBottom:12, textAlign:"center" }}>
                      <div style={{ fontSize:13, color:"#aab0ff", marginBottom:4 }}>🔜 Phase 2 begins Jun 28</div>
                      <div style={{ fontSize:11, color:"#9ab8a0" }}>P2 standings will appear once the knockout stage starts</div>
                    </div>
                  )}
                  <div style={{ ...S.card, borderColor:"rgba(100,200,100,0.3)", background:"rgba(0,100,40,0.1)", marginBottom:14 }}>
                    <div style={{ fontSize:11, fontWeight:"bold", color:"#8fffb0", marginBottom:8, letterSpacing:1 }}>💰 PHASE 2 POT · {paidCount} paid</div>
                    <div style={{ background:"rgba(255,255,255,0.04)", borderRadius:8, padding:"8px 10px" }}>
                      <div style={{ fontSize:15, fontWeight:"bold", color:"#f0d060", marginBottom:4 }}>${pot2}</div>
                      {paidCount >= 2 && <div style={{ fontSize:10, color:"#aab0ff", marginBottom:4 }}>↩ last place ${refund2} back · distributable ${dist2}</div>}
                      {paidCount >= 2 && dist2 > 0 && (
                        <div style={{ fontSize:10, color:"#9ab8a0" }}>
                          {["🥇","🥈","🥉","4️⃣","5️⃣"].map((m,i) => pcts2[i]>0 ? `${m} $${Math.round(dist2*pcts2[i]/100)}` : null).filter(Boolean).join(" · ")}
                        </div>
                      )}
                    </div>
                  </div>
                  {lbLoading && <div style={{ color:"#9ab8a0", textAlign:"center", padding:20 }}>⏳ Loading…</div>}
                  {!lbLoading && lb2.length===0 && <div style={{ color:"#9ab8a0" }}>No players yet.</div>}
                  {!lbLoading && lb2.map((p, i) => {
                    const pred = predictions[p.id];
                    const p2BracketDone = pred ? Object.keys(pred.phase2Picks||{}).filter(k => !k.startsWith("p2_") && k !== "goldenBoot").length : 0;
                    const p2PropsDone = pred ? Object.keys(pred.p2PropPicks||{}).filter(k => pred.p2PropPicks[k] !== null).length : 0;
                    const isLastPaid = lb2.filter(x=>paid[x.id]).at(-1)?.id === p.id && paid[p.id];
                    return (
                      <div key={p.id} style={{ display:"flex", alignItems:"center", gap:12, background:i===0?"rgba(200,168,75,0.15)":"rgba(255,255,255,0.04)", borderRadius:8, padding:"12px 14px", marginBottom:8, border:`1px solid ${i===0?"rgba(200,168,75,0.4)":"rgba(255,255,255,0.06)"}` }}>
                        <div style={{ fontSize:20, minWidth:28, textAlign:"center" }}>{i===0?"🥇":i===1?"🥈":i===2?"🥉":i===3?"4️⃣":i===4?"5️⃣":`#${i+1}`}</div>
                        <div style={{ flex:1 }}>
                          <div style={{ fontSize:15, color:i===0?"#f0d060":"#f0e6c8", display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
                            {displayName(p)}
                            {paid[p.id] && <span style={{ fontSize:9, background:"rgba(100,200,100,0.2)", color:"#8fffb0", borderRadius:4, padding:"1px 5px" }}>paid {paid[p.id+"_method"]==="cash"?"💵":"💸"}</span>}
                            {!paid[p.id] && <span style={{ fontSize:9, background:"rgba(200,60,60,0.2)", color:"#ff9090", borderRadius:4, padding:"1px 5px" }}>unpaid</span>}
                            {isLastPaid && <span style={{ fontSize:9, background:"rgba(100,100,200,0.2)", color:"#aab0ff", borderRadius:4, padding:"1px 5px" }}>↩ refund</span>}
                            {prizes2[p.id] && prizes2[p.id] !== refund2 && <span style={{ fontSize:9, background:"rgba(200,168,75,0.3)", color:"#f0d060", borderRadius:4, padding:"1px 5px" }}>💰${prizes2[p.id]}</span>}
                          </div>
                          {(() => {
                            const totalBracket = Object.values(KNOCKOUT_ROUNDS).flat().length;
                            const p2Locked = isP2PropRoundLocked("r32"); // bracket locked at same time as R32 props
                            const brktFlag = p2BracketDone >= totalBracket ? "✅" : !isPhase2Open() ? "" : p2Locked ? "🔒" : "⚠️";
                            const brktColor = p2BracketDone >= totalBracket ? "#9ab8a0" : p2Locked ? "#9ab8a0" : "#f0a020";
                            const totalP2Props = P2_PROPS.length;
                            // Only count unlocked P2 prop rounds
                            const unlockedP2Props = P2_PROPS.filter(pr => !isP2PropRoundLocked(pr.round)).length;
                            const unlockedP2Done = pred ? P2_PROPS.filter(pr => !isP2PropRoundLocked(pr.round) && pred.p2PropPicks?.[pr.id] !== null && pred.p2PropPicks?.[pr.id] !== undefined).length : 0;
                            const allP2PropsOk = unlockedP2Props === 0 || unlockedP2Done >= unlockedP2Props;
                            const gbDone = !!pred?.goldenBootPick;
                            const gbLocked = isP2PropRoundLocked("r32");
                            if (!isPhase2Open()) return <div style={{ fontSize:10, color:"#9ab8a0" }}>Phase 2 opens Jun 28</div>;
                            return (
                              <div style={{ display:"flex", gap:8, fontSize:10, marginTop:2, flexWrap:"wrap" }}>
                                <span style={{ color: brktColor }}>{brktFlag} {p2BracketDone}/{totalBracket} bracket</span>
                                <span style={{ color:"#555" }}>·</span>
                                <span style={{ color: allP2PropsOk ? "#9ab8a0" : "#f0a020" }}>{allP2PropsOk ? "✅" : "⚠️"} {unlockedP2Done}/{unlockedP2Props || totalP2Props} props</span>
                                <span style={{ color:"#555" }}>·</span>
                                <span style={{ color: gbDone ? "#9ab8a0" : gbLocked ? "#9ab8a0" : "#f0a020" }}>{gbDone ? "✅" : gbLocked ? "🔒" : "⚠️"} GB</span>
                              </div>
                            );
                          })()}
                        </div>
                        <div style={{ textAlign:"right" }}>
                          <div style={{ fontSize:26, fontWeight:"bold", color:"#c8a84b" }}>{p.pts2}</div>
                          <div style={{ fontSize:9, color:"#9ab8a0" }}>/ {MAX_PHASE2_PTS} pts</div>
                        </div>
                      </div>
                    );
                  })}
                  <div style={{ ...S.card, fontSize:11, color:"#9ab8a0", marginTop:8 }}>
                    P2 includes bracket picks, knockout props, and Golden Boot. Syncs every 30s.
                  </div>
                </div>
              );
            })()}

            {/* ── P1 CHART ── */}
            {lbPhase==="p1" && lbTab==="chart" && (
              <div style={S.card}>
                <div style={{ fontSize:11, fontWeight:"bold", color:"#f0d060", marginBottom:8, letterSpacing:1 }}>📈 PHASE 1 POINTS OVER TIME</div>
                <div style={{ fontSize:11, color:"#9ab8a0", marginBottom:14 }}>Cumulative Phase 1 points per player as daily props settle throughout the group stage.</div>
                <SparklineChart players={players} predictions={predictions} liveResults={liveResults} />
                <div style={{ marginTop:16, borderTop:"1px solid rgba(255,255,255,0.07)", paddingTop:12 }}>
                  {leaderboard.map((p, i) => (
                    <div key={p.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"5px 0" }}>
                      <div style={{ width:10, height:10, borderRadius:"50%", background: PLAYER_COLORS[players.findIndex(pl=>pl.id===p.id) % PLAYER_COLORS.length], flexShrink:0 }} />
                      <div style={{ flex:1, fontSize:13, color:"#f0e6c8" }}>{i===0?"🥇":i===1?"🥈":i===2?"🥉":`#${i+1}`} {displayName(p)}</div>
                      <div style={{ fontSize:16, fontWeight:"bold", color:"#f0d060" }}>{p.pts} pts</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── P2 CHART ── */}
            {lbPhase==="p2" && lbTab==="chart" && (
              <div style={S.card}>
                <div style={{ fontSize:11, fontWeight:"bold", color:"#f0d060", marginBottom:8, letterSpacing:1 }}>📈 PHASE 2 POINTS OVER TIME</div>
                <div style={{ fontSize:11, color:"#9ab8a0", marginBottom:14 }}>
                  {isPhase2Open() ? "Cumulative Phase 2 points per player as knockout results come in." : "Phase 2 chart will appear once the knockout stage begins (Jun 28)."}
                </div>
                {isPhase2Open() ? (
                  <>
                    <div style={{ textAlign:"center", padding:"16px 0", color:"#9ab8a0", fontSize:13 }}>
                      Chart will populate as knockout results and props settle.
                    </div>
                    <div style={{ marginTop:16, borderTop:"1px solid rgba(255,255,255,0.07)", paddingTop:12 }}>
                      {[...leaderboard].sort((a, b) => {
                        if (b.pts2 !== a.pts2) return b.pts2 - a.pts2;
                        const finalFirstGoal = bracketWinners?.finalFirstGoalMinute;
                        if (bracketWinners?.final_1 && finalFirstGoal != null) {
                          const tbA = predictions[a.id]?.tbP2, tbB = predictions[b.id]?.tbP2;
                          if (tbA != null && tbB != null) return Math.abs(tbA - finalFirstGoal) - Math.abs(tbB - finalFirstGoal);
                        }
                        return 0;
                      }).map((p, i) => (
                        <div key={p.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"5px 0" }}>
                          <div style={{ width:10, height:10, borderRadius:"50%", background: PLAYER_COLORS[players.findIndex(pl=>pl.id===p.id) % PLAYER_COLORS.length], flexShrink:0 }} />
                          <div style={{ flex:1, fontSize:13, color:"#f0e6c8" }}>{i===0?"🥇":i===1?"🥈":i===2?"🥉":`#${i+1}`} {displayName(p)}</div>
                          <div style={{ fontSize:16, fontWeight:"bold", color:"#c8a84b" }}>{p.pts2} pts</div>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <div style={{ textAlign:"center", padding:"24px 0", color:"#aab0ff", fontSize:13 }}>🔜 Opens Jun 28</div>
                )}
              </div>
            )}

            {/* ── H2H (shared for both phases) ── */}
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
                          {displayName(p)}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize:10, color:"#60c0ff", fontWeight:"bold", marginBottom:6 }}>PLAYER B</div>
                    <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                      {players.map(p => (
                        <button key={p.id} onClick={() => setH2hPlayerB(h2hPlayerB?.id===p.id?null:p)} style={{ padding:"7px 10px", borderRadius:6, border:"1px solid", textAlign:"left", cursor:"pointer", borderColor:h2hPlayerB?.id===p.id?"#60c0ff":"rgba(255,255,255,0.1)", background:h2hPlayerB?.id===p.id?"rgba(96,192,255,0.2)":"rgba(255,255,255,0.04)", color:h2hPlayerB?.id===p.id?"#60c0ff":"#c8b8a0", fontSize:12 }}>
                          {displayName(p)}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                {h2hPlayerA && h2hPlayerB ? (
                  <button style={{ ...S.btn, width:"100%" }} onClick={() => {}}>
                    ⚔️ {h2hPlayerA.name} vs {h2hPlayerB.name} · {lbPhase==="p1"?"Phase 1":"Phase 2"}
                  </button>
                ) : (
                  <div style={{ fontSize:12, color:"#9ab8a0", textAlign:"center" }}>
                    {!h2hPlayerA&&!h2hPlayerB?"Select both players above":!h2hPlayerA?"Select Player A":"Select Player B"}
                  </div>
                )}
                <div style={{ fontSize:11, color:"#9ab8a0", marginTop:10, textAlign:"center" }}>The comparison panel opens as a full overlay once both are selected.</div>
              </div>
            )}

            {/* ── RESULTS TAB ── */}
            {lbTab==="results" && (() => {
              const settledProps = DAILY_PROPS.map((prop, i) => ({
                ...prop, i,
                result: liveResults?.propResults?.[i] ?? null,
              }));
              const anySettled = settledProps.some(p => p.result !== null);

              return (
                <div>
                  {/* GROUP RESULTS */}
                  <div style={{ marginBottom:18 }}>
                    <div style={{ fontSize:11, fontWeight:"bold", color:"#f0d060", letterSpacing:1, marginBottom:8 }}>
                      🏆 GROUP STANDINGS
                    </div>
                    {Object.keys(TEAMS_BY_GROUP).map(g => {
                      const ranking = liveResults?.groupRankings?.[g];
                      const isFinal = !!liveResults?.groupFinal?.[g];
                      return (
                        <div key={g} style={{ marginBottom:6, background:"rgba(255,255,255,0.03)", borderRadius:6, padding:"8px 10px", border:"1px solid rgba(255,255,255,0.07)" }}>
                          <div style={{ fontSize:10, fontWeight:"bold", color:"#f0d060", marginBottom:5, letterSpacing:1, display:"flex", alignItems:"center", justifyContent:"space-between", gap:4 }}>
                            <span>GROUP {g}</span>
                            {ranking && (
                              <span style={{ fontSize:8, fontWeight:"normal", letterSpacing:0, color: isFinal ? "#8fffb0" : "rgba(240,208,96,0.6)", fontStyle: isFinal ? "normal" : "italic" }}>
                                {isFinal ? "✅ final" : "📊 provisional"}
                              </span>
                            )}
                          </div>
                          {ranking ? (
                            <div>
                              {ranking.map((team, pos) => (
                                <div key={team} style={{ display:"flex", alignItems:"center", gap:8, padding:"2px 0", borderBottom: pos < 3 ? "1px solid rgba(255,255,255,0.04)" : "none" }}>
                                  <span style={{ fontSize:10, color: pos < 2 ? "#8fffb0" : "rgba(154,184,160,0.5)", minWidth:14, textAlign:"right" }}>{pos+1}</span>
                                  <span style={{ fontSize:11, color: pos < 2 ? "#f0e6c8" : "rgba(240,230,200,0.5)", flex:1 }}>{team}</span>
                                  {pos === 1 && <span style={{ fontSize:8, color:"#8fffb0", opacity:0.7 }}>↑ advance</span>}
                                  {pos === 2 && <span style={{ fontSize:8, color:"rgba(154,184,160,0.4)" }}>3rd</span>}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div style={{ fontSize:10, color:"rgba(154,184,160,0.4)", fontStyle:"italic" }}>No results yet</div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* PROP RESULTS */}
                  <div>
                    <div style={{ fontSize:11, fontWeight:"bold", color:"#f0d060", letterSpacing:1, marginBottom:8 }}>🎲 PROP SETTLEMENTS</div>
                    {!anySettled && (
                      <div style={{ ...S.card, fontSize:11, color:"#9ab8a0", textAlign:"center" }}>No props settled yet — check back after matches complete.</div>
                    )}
                    {[...new Set(settledProps.map(p => p.date))].map(date => {
                      const dayProps = settledProps.filter(p => p.date === date);
                      const anyDaySettled = dayProps.some(p => p.result !== null);
                      if (!anyDaySettled) return null;
                      return (
                        <div key={date} style={{ marginBottom:10 }}>
                          <div style={{ fontSize:10, color:"#9ab8a0", fontWeight:"bold", marginBottom:4, letterSpacing:1 }}>{date}</div>
                          {dayProps.map(prop => {
                            const settled = prop.result !== null;
                            const yesWon = prop.result === true;
                            const noWon = prop.result === false;
                            // Count how many pool players got it right
                            const correct = players.filter(pl => {
                              const pick = predictions[pl.id]?.propPicks?.[prop.i];
                              return pick !== null && pick !== undefined && pick === prop.result;
                            }).length;
                            const total = players.filter(pl => {
                              const pick = predictions[pl.id]?.propPicks?.[prop.i];
                              return pick !== null && pick !== undefined;
                            }).length;
                            return (
                              <div key={prop.i} style={{ background: settled ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.02)", borderRadius:6, padding:"8px 10px", marginBottom:5, border:`1px solid ${settled?"rgba(255,255,255,0.09)":"rgba(255,255,255,0.04)"}` }}>
                                <div style={{ display:"flex", alignItems:"flex-start", gap:8 }}>
                                  <div style={{ fontSize:13, marginTop:1 }}>{settled ? (yesWon ? "✅" : "❌") : "⏳"}</div>
                                  <div style={{ flex:1 }}>
                                    <div style={{ fontSize:11, color: settled ? "#f0e6c8" : "rgba(240,230,200,0.5)" }}>{prop.q}</div>
                                    <div style={{ display:"flex", gap:10, marginTop:4, flexWrap:"wrap" }}>
                                      <span style={{ fontSize:10, color: yesWon ? "#8fffb0" : "rgba(154,184,160,0.5)", fontWeight: yesWon ? "bold" : "normal" }}>
                                        YES {yesWon ? "✓" : ""} · {prop.ptsYes}pts
                                      </span>
                                      <span style={{ fontSize:10, color: noWon ? "#8fffb0" : "rgba(154,184,160,0.5)", fontWeight: noWon ? "bold" : "normal" }}>
                                        NO {noWon ? "✓" : ""} · {prop.ptsNo}pts
                                      </span>
                                      {settled && total > 0 && (
                                        <span style={{ fontSize:10, color:"#9ab8a0", marginLeft:"auto" }}>
                                          {correct}/{total} got it right
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}
          </div>
        )}

      </div>
    </div>
  );
}
