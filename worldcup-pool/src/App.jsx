import { useState, useEffect, useCallback } from "react";

// ── FIREBASE CONFIG ───────────────────────────────────────────────────────────
const DB_URL = "https://wc2026-306ec-default-rtdb.firebaseio.com";

async function dbLoad() {
  const r = await fetch(`${DB_URL}/pool.json`);
  if (!r.ok) throw new Error(`Firebase error ${r.status}`);
  const data = await r.json();
  if (!data) return { players: [], predictions: {}, paid: {}, settings: { fee1: 10, fee2: 10 } };
  return {
    players: data.players || [],
    predictions: data.predictions || {},
    paid: data.paid || {},
    settings: data.settings || { fee1: 10, fee2: 10 },
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

async function postMessage(author, text, isAdmin) {
  const msg = { author, text, timestamp: Date.now(), isAdmin: isAdmin || false };
  await fetch(`${DB_URL}/messages.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(msg),
  });
}

async function deleteMessage(id) {
  await fetch(`${DB_URL}/messages/${id}.json`, { method: "DELETE" });
}

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

// ── DAILY PROPS (Jun 11–27) ───────────────────────────────────────────────────
const DAILY_PROPS = [
  { date:"Jun 11", label:"Opening Day",  q:"Will Mexico score in the tournament opener vs South Africa?",                    pts:3, yes:"Sí! Mexico score",         no:"Goalless opener" },
  { date:"Jun 12", label:"Day 2",        q:"Will the USA win their first match vs Paraguay?",                                pts:5, yes:"USA win",                   no:"Draw or Paraguay win" },
  { date:"Jun 13", label:"Day 3",        q:"Will Brazil beat Morocco on Day 3?",                                            pts:3, yes:"Brazil win",                no:"Draw or upset" },
  { date:"Jun 14", label:"Day 4",        q:"Will Netherlands beat Japan on Day 4?",                                         pts:3, yes:"Netherlands win",           no:"Draw or Japan upset" },
  { date:"Jun 15", label:"Day 5",        q:"Will Spain win their Group H opener?",                                         pts:3, yes:"Spain win",                 no:"Draw or loss" },
  { date:"Jun 16", label:"Day 6",        q:"Will Argentina win their opener vs Algeria?",                                   pts:3, yes:"Argentina win",            no:"Draw or upset" },
  { date:"Jun 17", label:"Day 7",        q:"Will Portugal score 3+ goals vs DR Congo?",                                    pts:5, yes:"Portugal put on a show",   no:"Under 3 goals" },
  { date:"Jun 18", label:"Day 8",        q:"Will there be a red card on Day 8?",                                           pts:5, yes:"Someone sees red",         no:"All 11 stay on" },
  { date:"Jun 19", label:"Day 9",        q:"Will the USA beat Australia in their second group game?",                       pts:5, yes:"USA win again",            no:"Draw or Australia win" },
  { date:"Jun 20", label:"Day 10",       q:"Will there be a penalty scored on Day 10?",                                    pts:3, yes:"Spot kick converted",      no:"No penalties" },
  { date:"Jun 21", label:"Day 11",       q:"Will an African team win on Day 11?",                                          pts:5, yes:"African glory",            no:"No African wins" },
  { date:"Jun 22", label:"Day 12",       q:"Will Argentina top Group J after Matchday 2?",                                 pts:5, yes:"Messi's men lead",         no:"Someone else tops" },
  { date:"Jun 23", label:"Day 13",       q:"Will any team be mathematically eliminated on Day 13?",                       pts:5, yes:"Someone goes home early",  no:"Still all to play for" },
  { date:"Jun 24", label:"Day 14",       q:"Will England win their final group game vs Panama?",                           pts:3, yes:"Three Lions win",          no:"Draw or loss" },
  { date:"Jun 25", label:"Day 15",       q:"Will there be a last-minute winner (85'+ goal) on Day 15?",                   pts:8, yes:"Late drama!",              no:"No late deciders" },
  { date:"Jun 26", label:"Day 16",       q:"Will France top Group I with a perfect record going into the final day?",     pts:8, yes:"Perfect France",          no:"France have dropped points" },
  { date:"Jun 27", label:"Final Day",    q:"Will a higher-ranked team lose on the final group stage day?",                pts:8, yes:"Shock result!",            no:"Favourites all win" },
];

// ── LOCK TIMES (ET) ──────────────────────────────────────────────────────────
// Group rankings lock at first kickoff Jun 11 3pm ET
const GROUP_RANKINGS_LOCK = new Date("2026-06-11T19:00:00Z"); // 3pm ET = 19:00 UTC

// Each prop locks at first kickoff of that day (ET → UTC)
const PROP_LOCKS = [
  new Date("2026-06-11T19:00:00Z"), // Jun 11 3pm ET
  new Date("2026-06-12T19:00:00Z"), // Jun 12 3pm ET
  new Date("2026-06-13T19:00:00Z"), // Jun 13 3pm ET
  new Date("2026-06-14T17:00:00Z"), // Jun 14 1pm ET
  new Date("2026-06-15T16:00:00Z"), // Jun 15 noon ET
  new Date("2026-06-16T19:00:00Z"), // Jun 16 3pm ET
  new Date("2026-06-17T17:00:00Z"), // Jun 17 1pm ET
  new Date("2026-06-18T16:00:00Z"), // Jun 18 noon ET
  new Date("2026-06-19T19:00:00Z"), // Jun 19 3pm ET
  new Date("2026-06-20T17:00:00Z"), // Jun 20 1pm ET
  new Date("2026-06-21T19:00:00Z"), // Jun 21 3pm ET
  new Date("2026-06-22T17:00:00Z"), // Jun 22 1pm ET
  new Date("2026-06-23T17:00:00Z"), // Jun 23 1pm ET
  new Date("2026-06-25T01:00:00Z"), // Jun 24 9pm ET
  new Date("2026-06-25T23:00:00Z"), // Jun 25 7pm ET
  new Date("2026-06-26T19:00:00Z"), // Jun 26 3pm ET
  new Date("2026-06-27T21:00:00Z"), // Jun 27 5pm ET
];

function isGroupRankingsLocked() { return new Date() >= GROUP_RANKINGS_LOCK; }
function isPropLocked(i) { return new Date() >= PROP_LOCKS[i]; }


// ── PHASE 2 KNOCKOUT BRACKET ─────────────────────────────────────────────────
// Phase 2 opens after group stage (Jun 27 evening) and locks Jun 28 at kickoff
const PHASE2_OPEN  = new Date("2026-06-28T00:00:00Z"); // Jun 27 8pm ET
const PHASE2_LOCK  = new Date("2026-06-28T16:00:00Z"); // Jun 28 noon ET

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
    if (actualIdx === idx) pts += 3;
    else if (Math.floor(idx / 2) === Math.floor(actualIdx / 2)) pts += 1;
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
    if (pick === actual) pts += DAILY_PROPS[i].pts;
  });
  return pts;
}

const MAX_RANKING_PTS = 12 * 4 * 3; // 144
const MAX_PROP_PTS = DAILY_PROPS.reduce((s, p) => s + p.pts, 0);
const MAX_PTS = MAX_RANKING_PTS + MAX_PROP_PTS;

// ── POT CALCULATIONS ─────────────────────────────────────────────────────────
function calcPot(players, paid, settings) {
  const paidCount = players.filter(p => paid[p.id]).length;
  const pot1 = paidCount * (settings.fee1 || 0);
  const pot2 = paidCount * (settings.fee2 || 0);
  return { pot1, pot2, total: pot1 + pot2, paidCount };
}

function calcPrizes(rankedPlayers, paid, potAmount) {
  const paidPlayers = rankedPlayers.filter(p => paid[p.id]);
  if (paidPlayers.length < 3 || potAmount === 0) return {};
  const prizes = {};
  prizes[paidPlayers[paidPlayers.length - 1].id] = "refund";
  prizes[paidPlayers[0].id] = Math.round(potAmount * 0.60);
  prizes[paidPlayers[1].id] = Math.round(potAmount * 0.30);
  prizes[paidPlayers[2].id] = Math.round(potAmount * 0.10);
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
  "propResults": [null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null],
  "matchday": "e.g. Group Stage Day 3",
  "lastUpdated": "ISO timestamp"
}

propResults is an array of 17 values (index 0–16):
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
    propResults: Array(17).fill(null),
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

  const prompt = `Search the web for 2026 FIFA World Cup knockout stage results (starting June 28 2026).

Return ONLY valid JSON, no markdown:
{
  "knockoutWinners": {
    ${Object.entries(KNOCKOUT_ROUNDS).flatMap(([,matches]) => matches.map(m => `"${m.id}": null`)).join(',
    ')}
  },
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
  const [propPicks, setPropPicks]         = useState(Array(17).fill(null));
  const [saved, setSaved]                 = useState(false);
  const [saving, setSaving]               = useState(false);
  const [viewingPlayer, setViewingPlayer] = useState(null);
  const [messages, setMessages]           = useState([]);
  const [newMessage, setNewMessage]       = useState("");
  const [postingMsg, setPostingMsg]       = useState(false);
  const [paid, setPaid]                   = useState({});
  const [settings, setSettings]           = useState({ fee1: 10, fee2: 10 });
  const [editFee1, setEditFee1]           = useState("10");
  const [editFee2, setEditFee2]           = useState("10");

  const [liveResults, setLiveResults]     = useState(null);
  const [livePhase2, setLivePhase2]       = useState(null);
  const [fetchStatus, setFetchStatus]     = useState("idle");
  const [fetchError, setFetchError]       = useState("");
  const [lastFetched, setLastFetched]     = useState(null);
  const [phase2Picks, setPhase2Picks]     = useState({});
  const [phase2Tab, setPhase2Tab]         = useState("r32");
  const [tbP1, setTbP1]                   = useState("");
  const [tbP2, setTbP2]                   = useState("");

  // Load from Firebase on mount
  useEffect(() => {
    dbLoad()
      .then(data => {
        setPlayers(data.players);
        setPredictions(data.predictions);
        setPaid(data.paid || {});
        setSettings(data.settings || { fee1: 10, fee2: 10 });
        setEditFee1(String(data.settings?.fee1 || 10));
        setEditFee2(String(data.settings?.fee2 || 10));
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
                setPropPicks(e.propPicks || Array(17).fill(null));
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
  }, []);

  // Poll Firebase every 30s
  useEffect(() => {
    const iv = setInterval(() => {
      dbLoad().then(data => { setPlayers(data.players); setPredictions(data.predictions); setPaid(data.paid || {}); setSettings(data.settings || { fee1:10, fee2:10 }); }).catch(() => {});
      loadMessages().then(setMessages).catch(() => {});
    }, 30000);
    return () => clearInterval(iv);
  }, []);

  const refreshScores = useCallback(async () => {
    setFetchStatus("loading"); setFetchError("");
    try {
      const r = await fetchLiveResults();
      setLiveResults(r); setLastFetched(new Date()); setFetchStatus("done");
      if (isPhase2Open()) {
        const p2 = await fetchLivePhase2();
        if (p2) setLivePhase2(p2);
      }
    } catch (e) { setFetchError(e.message); setFetchStatus("error"); }
  }, []);

  useEffect(() => { refreshScores(); }, []);

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
    setGroupRankings({}); setPropPicks(Array(17).fill(null)); setPhase2Picks({}); setTbP1(""); setTbP2("");
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
    setPropPicks(e.propPicks || Array(17).fill(null));
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

  const groupsDone = Object.keys(groupRankings).length;
  const propsDone  = propPicks.filter(p => p !== null).length;

  const leaderboard = players
    .map(p => ({ ...p, pts: calcPoints(predictions[p.id], liveResults, livePhase2), hasPred: !!predictions[p.id] }))
    .sort((a, b) => b.pts - a.pts);

  const prop       = DAILY_PROPS[selPropIdx];
  const propActual = liveResults?.propResults?.[selPropIdx];
  const propSettled = propActual !== null && propActual !== undefined;
  const propWon    = propSettled && propPicks[selPropIdx] === propActual;
  const propLost   = propSettled && propPicks[selPropIdx] !== null && !propWon;

  async function sendMessage() {
    const text = newMessage.trim();
    if (!text || !currentPlayer) return;
    setPostingMsg(true);
    await postMessage(currentPlayer.name, text, isAdmin);
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

  if (!siteUnlocked) return (
    <div style={{ ...S.page, display:"flex", alignItems:"center", justifyContent:"center", minHeight:"100vh" }}>
      <div style={{ textAlign:"center", maxWidth:320, padding:24 }}>
        <div style={{ fontSize:48, marginBottom:12 }}>⚽</div>
        <div style={{ fontSize:20, color:"#f0d060", fontWeight:"bold", marginBottom:4 }}>World Cup 2026 Pool</div>
        <div style={{ fontSize:12, color:"#9ab8a0", marginBottom:24 }}>Enter the pool password to continue</div>
        <input
          type="password"
          value={sitePassword}
          onChange={e => { setSitePassword(e.target.value); setSiteError(""); }}
          onKeyDown={e => {
            if (e.key === "Enter") {
              if (sitePassword === SITE_PASSWORD) {
                try { localStorage.setItem("wc2026_site", "yes"); } catch {}
                setSiteUnlocked(true);
              } else {
                setSiteError("Wrong password");
              }
            }
          }}
          placeholder="Pool password…"
          style={{ ...S.input, width:"100%", marginBottom:10, textAlign:"center", fontSize:16 }}
          autoFocus
        />
        {siteError && <div style={{ color:"#ff8080", fontSize:12, marginBottom:10 }}>{siteError}</div>}
        <button onClick={() => {
          if (sitePassword === SITE_PASSWORD) {
            try { localStorage.setItem("wc2026_site", "yes"); } catch {}
            setSiteUnlocked(true);
          } else {
            setSiteError("Wrong password");
          }
        }} style={{ ...S.btn, width:"100%", fontSize:15, padding:"10px" }}>Enter Pool</button>
      </div>
    </div>
  );

  return (
    <div style={S.page}>
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
          {currentPlayer && !isAdmin && (
            <button style={S.navBtn(screen==="predict")} onClick={() => setScreen("predict")}>📋 My Picks</button>
          )}

          {isGroupRankingsLocked() && (
            <button style={S.navBtn(screen==="picks")} onClick={() => setScreen("picks")}>👀 Picks</button>
          )}
          {isAdmin && (
            <button style={S.navBtn(screen==="admin")} onClick={() => setScreen("admin")}>⚙️ Admin</button>
          )}
          <button style={{ ...S.navBtn(false), background:"rgba(0,100,40,0.4)", color:"#8fffb0" }}
            onClick={refreshScores} disabled={fetchStatus==="loading"}>
            {fetchStatus==="loading" ? "⏳" : "🔄"} Live
          </button>
        </div>
      </div>

      {/* Status bar */}
      <div style={{ background:fetchStatus==="error"?"rgba(200,60,60,0.12)":"rgba(0,120,60,0.12)", padding:"5px 16px", fontSize:11, color:fetchStatus==="error"?"#ff8080":"#8fffb0", display:"flex", justifyContent:"space-between" }}>
        <span>
          {fetchStatus==="loading" && "⏳ Fetching live results…"}
          {fetchStatus==="done" && `✅ ${liveResults?.matchday||"Group Stage"} · ${Object.values(liveResults?.groupRankings||{}).filter(Boolean).length}/12 groups final · ${(liveResults?.propResults||[]).filter(v=>v!==null).length}/17 props settled`}
          {fetchStatus==="error" && `⚠️ ${fetchError}`}
          {fetchStatus==="idle" && "Initialising…"}
        </span>
        {lastFetched && <span style={{ color:"#9ab8a0" }}>Updated {lastFetched.toLocaleTimeString()}</span>}
      </div>

      <div style={{ maxWidth:680, margin:"0 auto", padding:"18px 14px" }}>

        {/* ── HOME ── */}
        {screen==="home" && (
          <div>
            <div style={{ textAlign:"center", marginBottom:22 }}>
              <div style={{ fontSize:44, marginBottom:6 }}>🏆</div>
              <h1 style={{ margin:0, fontSize:24, color:"#f0d060" }}>World Cup Pool</h1>
              <p style={{ color:"#9ab8a0", fontSize:12, margin:"4px 0 0" }}>Phase 1: Group Stage · June 11–27 · Backed by Firebase ☁️</p>
            </div>

            <div style={S.card}>
              <div style={{ fontSize:11, fontWeight:"bold", color:"#f0d060", marginBottom:8, letterSpacing:1 }}>📊 PHASE 1 SCORING · Max {MAX_PTS} pts</div>
              {[
                ["🏅 Group Rankings", `3 pts exact position · 1 pt correct half · max ${MAX_RANKING_PTS} pts`],
                ["🎲 Daily Props (17)", `3–8 pts each · max ${MAX_PROP_PTS} pts`],
                ["🏆 Phase 2", isPhase2Open() ? `Knockout bracket · max ${MAX_PHASE2_PTS} pts` : "Knockout bracket — unlocks Jun 28 after group stage"],
              ].map(([l,v]) => (
                <div key={l} style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", padding:"5px 0", borderBottom:"1px solid rgba(255,255,255,0.05)", fontSize:12, gap:8 }}>
                  <span style={{ minWidth:140 }}>{l}</span>
                  <span style={{ color:"#9ab8a0", textAlign:"right" }}>{v}</span>
                </div>
              ))}
            </div>

            <div style={{ ...S.card, borderColor:"rgba(255,180,50,0.3)", background:"rgba(255,140,0,0.08)" }}>
              <div style={{ fontSize:11, fontWeight:"bold", color:"#f0d060", marginBottom:8, letterSpacing:1 }}>🔒 WHEN PICKS LOCK</div>
              {[
                ["🏅 Group Rankings", "Lock at tournament kickoff — Jun 11 at 3pm ET (Mexico vs South Africa). You cannot change your group standings after this."],
                ["🎲 Daily Props", "Each prop locks before the first match of that day. Once the day's games start, your answer is final."],
                ["⚠️ Submit early!", "Don't wait until the last minute — picks that aren't saved before the deadline won't count."],
              ].map(([l,v]) => (
                <div key={l} style={{ padding:"5px 0", borderBottom:"1px solid rgba(255,255,255,0.05)", fontSize:12 }}>
                  <span style={{ color:"#f0d060", fontWeight:"bold" }}>{l} </span>
                  <span style={{ color:"#9ab8a0" }}>{v}</span>
                </div>
              ))}
            </div>

            <div style={{ ...S.card, borderColor:"rgba(100,200,255,0.3)", background:"rgba(0,80,160,0.15)" }}>
              <div style={{ fontSize:12, color:"#80d0ff" }}>☁️ <strong>Persistent pool</strong> — data saved to Firebase. Share this link with anyone; their picks save permanently and the leaderboard updates for everyone in real time.</div>
            </div>

            {/* Login */}
            <div style={S.card}>
              <div style={{ fontSize:11, color:"#9ab8a0", marginBottom:8 }}>LOG IN</div>
              <div style={{ display:"flex", gap:8, marginBottom:8 }}>
                <input value={loginName} onChange={e => setLoginName(e.target.value)} placeholder="Your name…" style={{ ...S.input, flex:1 }} />
                <input value={loginPassword} onChange={e => setLoginPassword(e.target.value)} onKeyDown={e => e.key==="Enter" && loginPlayer()} type="password" placeholder="Password…" style={{ ...S.input, flex:1 }} />
                <button onClick={loginPlayer} style={S.btn}>Login</button>
              </div>
              {loginError && <div style={{ color:"#e06060", fontSize:11 }}>{loginError}</div>}
            </div>

            {/* Join */}
            <div style={S.card}>
              <div style={{ fontSize:11, color:"#9ab8a0", marginBottom:8 }}>NEW? JOIN THE POOL</div>
              <div style={{ display:"flex", gap:8, marginBottom:8 }}>
                <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Choose a name…" style={{ ...S.input, flex:1 }} />
                <input value={newPassword} onChange={e => setNewPassword(e.target.value)} onKeyDown={e => e.key==="Enter" && register()} type="password" placeholder="Choose a password…" style={{ ...S.input, flex:1 }} />
                <button onClick={register} style={S.btn}>Join</button>
              </div>
              {players.find(p => p.name===newName.trim()) && <div style={{ color:"#e06060", fontSize:11 }}>Name already taken</div>}
              {newName.trim() && !newPassword.trim() && <div style={{ color:"#e06060", fontSize:11 }}>Password required</div>}
            </div>

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

              {/* Messages */}
              <div style={{ maxHeight:320, overflowY:"auto", marginBottom:10 }}>
                {messages.length === 0 && (
                  <div style={{ color:"#9ab8a0", fontSize:12, textAlign:"center", padding:"16px 0" }}>No messages yet — be the first! 👋</div>
                )}
                {messages.map(msg => {
                  const isOwn = currentPlayer && msg.author === currentPlayer.name;
                  const isAdminMsg = msg.isAdmin;
                  const date = new Date(msg.timestamp);
                  const timeStr = date.toLocaleDateString("en-US", { month:"short", day:"numeric" }) + " " + date.toLocaleTimeString("en-US", { hour:"numeric", minute:"2-digit" });
                  return (
                    <div key={msg.id} style={{
                      display:"flex", flexDirection: isOwn ? "row-reverse" : "row",
                      gap:8, marginBottom:10, alignItems:"flex-start",
                    }}>
                      <div style={{
                        width:28, height:28, borderRadius:"50%", flexShrink:0,
                        background: isAdminMsg ? "linear-gradient(135deg,#c8a84b,#f0d060)" : "rgba(255,255,255,0.1)",
                        display:"flex", alignItems:"center", justifyContent:"center",
                        fontSize:12, fontWeight:"bold", color: isAdminMsg ? "#0a1628" : "#f0e6c8",
                      }}>
                        {msg.author[0].toUpperCase()}
                      </div>
                      <div style={{ maxWidth:"78%", flex:1 }}>
                        <div style={{ fontSize:10, color:"#9ab8a0", marginBottom:2, textAlign: isOwn ? "right" : "left" }}>
                          {isAdminMsg ? "⚙️ " : ""}{msg.author} · {timeStr}
                        </div>
                        <div style={{
                          background: isAdminMsg ? "rgba(200,168,75,0.15)" : isOwn ? "rgba(100,150,255,0.12)" : "rgba(255,255,255,0.06)",
                          border: `1px solid ${isAdminMsg ? "rgba(200,168,75,0.35)" : isOwn ? "rgba(100,150,255,0.25)" : "rgba(255,255,255,0.07)"}`,
                          borderRadius: isOwn ? "10px 10px 2px 10px" : "10px 10px 10px 2px",
                          padding:"7px 10px", fontSize:12, color:"#f0e6c8", lineHeight:1.5,
                          wordBreak:"break-word",
                        }}>
                          {msg.text}
                        </div>
                      </div>
                      {isAdmin && (
                        <button onClick={() => removeMessage(msg.id)} style={{
                          background:"none", border:"none", color:"rgba(255,100,100,0.35)",
                          cursor:"pointer", fontSize:13, padding:"2px", alignSelf:"center", flexShrink:0,
                        }}>🗑</button>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Compose — only if logged in */}
              {currentPlayer ? (
                <div>
                  <div style={{ display:"flex", gap:8 }}>
                    <input
                      value={newMessage}
                      onChange={e => setNewMessage(e.target.value)}
                      onKeyDown={e => e.key==="Enter" && !e.shiftKey && sendMessage()}
                      placeholder={isAdmin ? "Post an announcement…" : "Say something…"}
                      style={{ ...S.input, flex:1, fontSize:12, padding:"6px 10px" }}
                      maxLength={500}
                    />
                    <button onClick={sendMessage} disabled={postingMsg || !newMessage.trim()} style={{
                      ...S.btn,
                      background: postingMsg || !newMessage.trim() ? "#444" : "linear-gradient(90deg,#c8a84b,#f0d060)",
                      color: postingMsg || !newMessage.trim() ? "#888" : "#0a1628",
                      fontSize:12, padding:"6px 12px",
                    }}>
                      {postingMsg ? "…" : "Send"}
                    </button>
                  </div>
                  <div style={{ fontSize:10, color:"#9ab8a0", marginTop:3 }}>{newMessage.length}/500 · Enter to send</div>
                </div>
              ) : (
                <div style={{ fontSize:12, color:"#9ab8a0", textAlign:"center" }}>Log in to join the conversation</div>
              )}
            </div>

          </div>
        )}

        {/* ── PREDICT ── */}
        {screen==="predict" && currentPlayer && (
          <div>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:14 }}>
              <div>
                <div style={{ fontSize:17, color:"#f0d060" }}>📋 {currentPlayer.name}'s Picks</div>
                <div style={{ fontSize:11, color:"#9ab8a0" }}>{groupsDone}/12 groups · {propsDone}/17 props</div>
              </div>
              <div style={{ display:"flex", gap:8 }}>
                <button onClick={() => setScreen("home")} style={{ background:"rgba(255,255,255,0.07)", border:"1px solid rgba(255,255,255,0.1)", borderRadius:6, padding:"6px 10px", color:"#9ab8a0", cursor:"pointer", fontSize:12 }}>← Home</button>
                <button onClick={() => { setCurrentPlayer(null); setIsAdmin(false); setScreen("home"); try { localStorage.removeItem("wc2026_session"); localStorage.removeItem("wc2026_admin"); } catch {} }} style={{ background:"rgba(255,255,255,0.07)", border:"1px solid rgba(255,255,255,0.1)", borderRadius:6, padding:"6px 10px", color:"#9ab8a0", cursor:"pointer", fontSize:12 }}>Logout</button>
                <button onClick={savePreds} disabled={saving} style={{ ...S.btn, background:saved?"#2a6040":saving?"#555":"linear-gradient(90deg,#c8a84b,#f0d060)", color:saved?"#8fffb0":"#0a1628" }}>
                  {saving ? "Saving…" : saved ? "✓ Saved!" : "Save"}
                </button>
              </div>
            </div>

            {/* Progress */}
            <div style={{ marginBottom:14 }}>
              <div style={{ display:"flex", justifyContent:"space-between", fontSize:10, color:"#9ab8a0", marginBottom:4 }}>
                <span>Progress</span><span>{groupsDone + propsDone} / 29 picks</span>
              </div>
              <div style={{ height:5, background:"rgba(255,255,255,0.08)", borderRadius:3, overflow:"hidden" }}>
                <div style={{ height:"100%", width:`${((groupsDone+propsDone)/29)*100}%`, background:"linear-gradient(90deg,#c8a84b,#f0d060)", borderRadius:3, transition:"width 0.3s" }} />
              </div>
            </div>

            <div style={{ display:"flex", gap:4, marginBottom:14 }}>
              {[["groups",`🏅 Groups (${groupsDone}/12)`],["props",`🎲 Props (${propsDone}/17)`], ...(isPhase2Open() ? [["phase2","🏆 Knockouts"]] : [])].map(([t,l]) => (
                <button key={t} style={S.tab(predTab===t)} onClick={() => setPredTab(t)}>{l}</button>
              ))}
            </div>

            {/* GROUP RANKINGS */}
            {predTab==="groups" && (
              <div>
                <div style={{ fontSize:12, color:"#9ab8a0", marginBottom:12 }}>
                  Predict the final standings of each group. Drag or use ▲▼.<br/>
                  <span style={{ color:"#f0d060" }}>+3 pts</span> exact position · <span style={{ color:"#c8a84b" }}>+1 pt</span> correct half (top 2 vs bottom 2)
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

                {/* Phase 1 Tiebreaker */}
                {selGroup === "L" && (
                  <div style={{ ...S.card, marginTop:16, borderColor:"rgba(255,180,50,0.4)", background:"rgba(255,140,0,0.06)" }}>
                    <div style={{ fontSize:11, fontWeight:"bold", color:"#f0d060", marginBottom:6, letterSpacing:1 }}>🔢 PHASE 1 TIEBREAKER</div>
                    <div style={{ fontSize:13, color:"#f0e6c8", marginBottom:8 }}>{TIEBREAKER_P1.question}</div>
                    <div style={{ fontSize:11, color:"#9ab8a0", marginBottom:10, lineHeight:1.5 }}>{TIEBREAKER_P1.hint}</div>
                    <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:10 }}>
                      {TIEBREAKER_P1.references.map(r => (
                        <div key={r.year} style={{ background:"rgba(255,255,255,0.05)", borderRadius:6, padding:"5px 10px", fontSize:11 }}>
                          <span style={{ color:"#f0d060" }}>{r.year}:</span> <span style={{ color:"#f0e6c8" }}>{r.goals} goals</span> <span style={{ color:"#9ab8a0" }}>({r.avg})</span>
                        </div>
                      ))}
                    </div>
                    <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                      <input type="number" min="50" max="300" value={tbP1}
                        onChange={e => setTbP1(e.target.value)}
                        placeholder="Your guess…"
                        style={{ ...S.input, width:120, fontSize:16, textAlign:"center" }}
                        disabled={isGroupRankingsLocked()}
                      />
                      <span style={{ fontSize:12, color:"#9ab8a0" }}>goals</span>
                      {tbP1 && <span style={{ fontSize:12, color:"#f0d060" }}>✓ {tbP1} goals</span>}
                    </div>
                    {isGroupRankingsLocked() && <div style={{ fontSize:11, color:"#ff9090", marginTop:6 }}>🔒 Locked</div>}
                  </div>
                )}
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

            {/* DAILY PROPS */}
            {predTab==="props" && (
              <div>
                <div style={{ fontSize:12, color:"#9ab8a0", marginBottom:12 }}>One prop per match day — Yes or No. Auto-scored from live results.</div>
                <div style={{ display:"flex", gap:4, flexWrap:"wrap", marginBottom:14 }}>
                  {DAILY_PROPS.map((p, i) => {
                    const settled = liveResults?.propResults?.[i] !== null && liveResults?.propResults?.[i] !== undefined;
                    const picked  = propPicks[i] !== null;
                    const locked  = isPropLocked(i);
                    return (
                      <button key={i} style={{
                        padding:"3px 7px", borderRadius:4, border:"none", fontSize:10, fontWeight:"bold", cursor:"pointer",
                        background: selPropIdx===i ? "#c8a84b" : settled ? "rgba(100,200,100,0.2)" : locked ? "rgba(200,60,60,0.15)" : picked ? "rgba(200,168,75,0.2)" : "rgba(255,255,255,0.08)",
                        color: selPropIdx===i ? "#0a1628" : settled ? "#8fffb0" : locked && !picked ? "#ff9090" : picked ? "#f0d060" : "#9ab8a0",
                      }} onClick={() => setSelPropIdx(i)}>
                        {p.date.replace("Jun ","")} {locked?"🔒":picked?"✓":""}
                      </button>
                    );
                  })}
                </div>

                <div style={{ ...S.card, borderColor:propWon?"rgba(100,255,150,0.4)":propLost?"rgba(255,100,100,0.3)":"rgba(200,168,75,0.2)" }}>
                  <div style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
                    <span style={{ fontSize:11, color:"#f0d060", fontWeight:"bold" }}>{prop.date} — {prop.label}</span>
                    <span style={{ fontSize:12, fontWeight:"bold", color:prop.pts===8?"#ff9f50":prop.pts===5?"#f0d060":"#9ab8a0" }}>
                      +{prop.pts} pts {prop.pts===8?"🔥":prop.pts===5?"⚡":""}
                    </span>
                  </div>
                  <div style={{ fontSize:14, color:"#f0e6c8", marginBottom:14, lineHeight:1.5 }}>{prop.q}</div>

                  {propSettled && (
                    <div style={{ fontSize:12, marginBottom:12, padding:"6px 10px", borderRadius:6, background:propActual?"rgba(0,180,80,0.15)":"rgba(180,50,50,0.15)", color:propActual?"#8fffb0":"#ff9090" }}>
                      Result: {propActual ? `✅ YES — ${prop.yes}` : `❌ NO — ${prop.no}`}
                      {propWon?" 🎉 You got it!":propLost?" 😬 Unlucky":""}
                    </div>
                  )}

                  {isPropLocked(selPropIdx) && !propSettled && (
                    <div style={{ background:"rgba(200,60,60,0.15)", border:"1px solid rgba(200,60,60,0.3)", borderRadius:8, padding:"8px 12px", marginBottom:10, fontSize:12, color:"#ff9090" }}>
                      🔒 Locked — picks closed before first match of the day
                    </div>
                  )}
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                    {[[true,"✅",prop.yes],[false,"❌",prop.no]].map(([val,icon,label]) => (
                      <button key={String(val)}
                        onClick={() => {
                          if (isPropLocked(selPropIdx)) return;
                          const n=[...propPicks]; n[selPropIdx]=val; setPropPicks(n);
                        }}
                        style={{
                          padding:"14px 8px", borderRadius:10, border:"2px solid",
                          borderColor:propPicks[selPropIdx]===val?"#f0d060":"rgba(255,255,255,0.1)",
                          background:propPicks[selPropIdx]===val?"rgba(200,168,75,0.25)":"rgba(255,255,255,0.04)",
                          color:propPicks[selPropIdx]===val?"#f0d060":"#c8b8a0",
                          cursor:isPropLocked(selPropIdx)?"default":"pointer", fontSize:12, textAlign:"center", lineHeight:1.4,
                          opacity:isPropLocked(selPropIdx)&&propPicks[selPropIdx]!==val?0.4:1,
                        }}>
                        <div style={{ fontSize:20, marginBottom:4 }}>{icon}</div>
                        <div style={{ fontWeight:propPicks[selPropIdx]===val?"bold":"normal" }}>{label}</div>
                      </button>
                    ))}
                  </div>
                </div>

                <div style={{ display:"flex", justifyContent:"space-between", marginTop:4 }}>
                  <button style={S.pill(false)} onClick={() => setSelPropIdx(i => Math.max(0,i-1))} disabled={selPropIdx===0}>← Prev</button>
                  <span style={{ fontSize:11, color:"#9ab8a0" }}>{selPropIdx+1} / 17</span>
                  <button style={S.pill(false)} onClick={() => setSelPropIdx(i => Math.min(16,i+1))} disabled={selPropIdx===16}>Next →</button>
                </div>
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

            {/* PHASE 2 KNOCKOUTS */}
            {predTab==="phase2" && (
              <div>
                {isPhase2Locked() ? (
                  <div style={{ background:"rgba(200,60,60,0.15)", border:"1px solid rgba(200,60,60,0.3)", borderRadius:8, padding:"8px 12px", marginBottom:12, fontSize:12, color:"#ff9090" }}>
                    🔒 Knockout picks are locked
                  </div>
                ) : (
                  <div style={{ fontSize:12, color:"#9ab8a0", marginBottom:12 }}>
                    Pick the winner of every knockout match. Locks Jun 28 at noon ET.<br/>
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
            {/* Entry fee settings */}
            <div style={S.card}>
              <div style={{ fontSize:11, color:"#9ab8a0", marginBottom:10, letterSpacing:1 }}>💰 ENTRY FEES</div>
              <div style={{ display:"flex", gap:12, alignItems:"center", flexWrap:"wrap" }}>
                <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                  <label style={{ fontSize:12, color:"#f0e6c8" }}>Phase 1: $</label>
                  <input type="number" value={editFee1} onChange={e => setEditFee1(e.target.value)}
                    style={{ ...S.input, width:60, padding:"4px 8px", fontSize:13 }} />
                </div>
                <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                  <label style={{ fontSize:12, color:"#f0e6c8" }}>Phase 2: $</label>
                  <input type="number" value={editFee2} onChange={e => setEditFee2(e.target.value)}
                    style={{ ...S.input, width:60, padding:"4px 8px", fontSize:13 }} />
                </div>
                <button onClick={async () => {
                  const s = { fee1: parseFloat(editFee1)||0, fee2: parseFloat(editFee2)||0 };
                  setSettings(s);
                  await dbSave(players, predictions, paid, s);
                }} style={{ ...S.btn, fontSize:11, padding:"5px 12px" }}>Save Fees</button>
              </div>
              {(() => {
                const { pot1, pot2, paidCount } = calcPot(players, paid, settings);
                return <div style={{ fontSize:11, color:"#9ab8a0", marginTop:8 }}>
                  {paidCount} paid · Phase 1 pot: <strong style={{ color:"#f0d060" }}>${pot1}</strong> · Phase 2 pot: <strong style={{ color:"#f0d060" }}>${pot2}</strong>
                </div>;
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

            {liveResults && (
              <div style={{ ...S.card, fontSize:12, color:"#9ab8a0" }}>
                <span style={{ color:"#f0d060" }}>📡</span> {liveResults.matchday||"Group Stage"} · {Object.values(liveResults.groupRankings||{}).filter(Boolean).length}/12 groups final · {(liveResults.propResults||[]).filter(v=>v!==null).length}/17 props settled
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

            {/* Pot summary */}
            {(() => {
              const { pot1, pot2, paidCount } = calcPot(players, paid, settings);
              const prizes1 = calcPrizes(leaderboard, paid, pot1);
              const prizes2 = calcPrizes(leaderboard, paid, pot2);
              return (
                <div style={{ ...S.card, borderColor:"rgba(100,200,100,0.3)", background:"rgba(0,100,40,0.1)", marginBottom:14 }}>
                  <div style={{ fontSize:11, fontWeight:"bold", color:"#8fffb0", marginBottom:8, letterSpacing:1 }}>💰 THE POTS · {paidCount} paid</div>
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                    <div style={{ background:"rgba(255,255,255,0.04)", borderRadius:8, padding:"8px 10px" }}>
                      <div style={{ fontSize:10, color:"#f0d060", fontWeight:"bold", marginBottom:4 }}>PHASE 1 — GROUP STAGE</div>
                      <div style={{ fontSize:16, fontWeight:"bold", color:"#f0d060", marginBottom:4 }}>${pot1}</div>
                      {paidCount >= 3 && <div style={{ fontSize:10, color:"#9ab8a0" }}>🥇 ${Math.round(pot1*0.6)} · 🥈 ${Math.round(pot1*0.3)} · 🥉 ${Math.round(pot1*0.1)}</div>}
                      {paidCount >= 3 && <div style={{ fontSize:10, color:"#aab0ff", marginTop:2 }}>↩ last place refunded</div>}
                    </div>
                    <div style={{ background:"rgba(255,255,255,0.04)", borderRadius:8, padding:"8px 10px" }}>
                      <div style={{ fontSize:10, color:"#f0d060", fontWeight:"bold", marginBottom:4 }}>PHASE 2 — KNOCKOUTS</div>
                      <div style={{ fontSize:16, fontWeight:"bold", color:"#f0d060", marginBottom:4 }}>${pot2}</div>
                      {paidCount >= 3 && <div style={{ fontSize:10, color:"#9ab8a0" }}>🥇 ${Math.round(pot2*0.6)} · 🥈 ${Math.round(pot2*0.3)} · 🥉 ${Math.round(pot2*0.1)}</div>}
                      {paidCount >= 3 && <div style={{ fontSize:10, color:"#aab0ff", marginTop:2 }}>↩ last place refunded</div>}
                    </div>
                  </div>
                </div>
              );
            })()}

            {leaderboard.length===0 && <div style={{ color:"#9ab8a0" }}>No players yet — go to Home to join!</div>}
            {leaderboard.map((p, i) => {
              const pred = predictions[p.id];
              const grpDone = pred ? Object.keys(pred.groupRankings||{}).length : 0;
              const prpDone = pred ? (pred.propPicks||[]).filter(x=>x!==null).length : 0;
              const hasPaid1 = paid[p.id+"_1"];
              const hasPaid2 = paid[p.id+"_2"];
              const prizes = calcPrizes(leaderboard, paid, settings);
              const prize = prizes[p.id];
              return (
                <div key={p.id} style={{ display:"flex", alignItems:"center", gap:12, background:i===0?"rgba(200,168,75,0.15)":"rgba(255,255,255,0.04)", borderRadius:8, padding:"12px 14px", marginBottom:8, border:`1px solid ${i===0?"rgba(200,168,75,0.4)":"rgba(255,255,255,0.06)"}` }}>
                  <div style={{ fontSize:20, minWidth:28, textAlign:"center" }}>{i===0?"🥇":i===1?"🥈":i===2?"🥉":`#${i+1}`}</div>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:15, color:i===0?"#f0d060":"#f0e6c8", display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
                      {p.name}
                      {paid[p.id] && <span style={{ fontSize:9, background:"rgba(100,200,100,0.2)", color:"#8fffb0", borderRadius:4, padding:"1px 5px" }}>paid {paid[p.id+"_method"]==="cash"?"💵":"💸"}</span>}
                      {!paid[p.id] && <span style={{ fontSize:9, background:"rgba(200,60,60,0.2)", color:"#ff9090", borderRadius:4, padding:"1px 5px" }}>unpaid</span>}
                      {prizes1[p.id] && prizes1[p.id] !== "refund" && <span style={{ fontSize:9, background:"rgba(200,168,75,0.3)", color:"#f0d060", borderRadius:4, padding:"1px 5px" }}>P1 💰${prizes1[p.id]}</span>}
                      {prizes2[p.id] && prizes2[p.id] !== "refund" && <span style={{ fontSize:9, background:"rgba(200,168,75,0.3)", color:"#f0d060", borderRadius:4, padding:"1px 5px" }}>P2 💰${prizes2[p.id]}</span>}
                      {(prizes1[p.id] === "refund" || prizes2[p.id] === "refund") && <span style={{ fontSize:9, background:"rgba(100,100,200,0.2)", color:"#aab0ff", borderRadius:4, padding:"1px 5px" }}>↩ refund</span>}
                    </div>
                    <div style={{ fontSize:10, color:"#9ab8a0" }}>
                      {pred ? `${grpDone}/12 groups · ${prpDone}/17 props${isPhase2Open() ? ` · ${Object.keys(pred.phase2Picks||{}).length}/${Object.values(KNOCKOUT_ROUNDS).flat().length} bracket` : ""}` : "No predictions yet"}
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
        )}

      </div>
    </div>
  );
}
