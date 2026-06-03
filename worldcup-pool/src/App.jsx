import { useState, useEffect, useCallback } from "react";

// ── FIREBASE CONFIG ───────────────────────────────────────────────────────────
const DB_URL = "https://wc2026-306ec-default-rtdb.firebaseio.com";

async function dbLoad() {
  const r = await fetch(`${DB_URL}/pool.json`);
  if (!r.ok) throw new Error(`Firebase error ${r.status}`);
  const data = await r.json();
  if (!data) return { players: [], predictions: {} };
  return { players: data.players || [], predictions: data.predictions || {} };
}

async function dbSave(players, predictions) {
  const r = await fetch(`${DB_URL}/pool.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ players, predictions }),
  });
  if (!r.ok) throw new Error(`Firebase save error ${r.status}`);
}

// ── GROUPS ────────────────────────────────────────────────────────────────────
const TEAMS_BY_GROUP = {
  A: ["Mexico", "South Africa", "South Korea", "Czech Republic"],
  B: ["Canada", "Bosnia and Herzegovina", "Qatar", "Switzerland"],
  C: ["Brazil", "Morocco", "Haiti", "Scotland"],
  D: ["USA", "Paraguay", "Australia", "Turkey"],
  E: ["Germany", "Curacao", "Ecuador", "Ivory Coast"],
  F: ["England", "Panama", "Croatia", "Ghana"],
  G: ["Belgium", "New Zealand", "Egypt", "Iran"],
  H: ["Spain", "Uruguay", "Saudi Arabia", "Cape Verde"],
  I: ["France", "Senegal", "Iraq", "Norway"],
  J: ["Argentina", "Algeria", "Austria", "Jordan"],
  K: ["Portugal", "DR Congo", "Uzbekistan", "Colombia"],
  L: ["Netherlands", "Sweden", "Morocco", "Qatar"],
};

const FLAG = {
  "Mexico":"🇲🇽","South Africa":"🇿🇦","South Korea":"🇰🇷","Czech Republic":"🇨🇿",
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
  "Netherlands":"🇳🇱","Sweden":"🇸🇪",
};
const tf = t => FLAG[t] || "🏳️";

// ── DAILY PROPS (Jun 11–27) ───────────────────────────────────────────────────
const DAILY_PROPS = [
  { date:"Jun 11", label:"Opening Day",  q:"Will Mexico score in the tournament opener vs South Africa?",               pts:3, yes:"Yes, El Tri score",       no:"Goalless opener" },
  { date:"Jun 12", label:"Day 2",        q:"Will the USA win their first match vs Paraguay?",                           pts:5, yes:"USA win",                 no:"Draw or Paraguay win" },
  { date:"Jun 13", label:"Day 3",        q:"Will Brazil score 3+ goals on Day 3?",                                     pts:5, yes:"Brazil go big",           no:"Under 3 goals" },
  { date:"Jun 14", label:"Day 4",        q:"Will there be a red card on Day 4?",                                       pts:5, yes:"Someone sees red",        no:"All 11 stay on" },
  { date:"Jun 15", label:"Day 5",        q:"Will France win their opening group game?",                                pts:3, yes:"Les Bleus win",           no:"Draw or loss" },
  { date:"Jun 16", label:"Day 6",        q:"Will Argentina win their opener vs Algeria?",                              pts:3, yes:"Argentina win",          no:"Draw or upset" },
  { date:"Jun 17", label:"Day 7",        q:"Will Portugal score 3+ goals vs DR Congo?",                               pts:5, yes:"Portugal put on a show", no:"Under 3 goals" },
  { date:"Jun 18", label:"Day 8",        q:"Will any Day 8 match end 0-0?",                                           pts:5, yes:"Bore draw confirmed",     no:"Every game has a goal" },
  { date:"Jun 19", label:"Day 9",        q:"Will Spain win their second group game by 2+ goals?",                     pts:5, yes:"Spain dominate",         no:"Win by 1 or less" },
  { date:"Jun 20", label:"Day 10",       q:"Will there be a penalty scored on Day 10?",                               pts:3, yes:"Spot kick converted",     no:"No penalties" },
  { date:"Jun 21", label:"Day 11",       q:"Will an African team win on Day 11?",                                     pts:5, yes:"African glory",          no:"No African wins" },
  { date:"Jun 22", label:"Day 12",       q:"Will Argentina top Group J after Matchday 2?",                            pts:5, yes:"Messi's men lead",       no:"Someone else tops" },
  { date:"Jun 23", label:"Day 13",       q:"Will any team be mathematically eliminated on Day 13?",                  pts:5, yes:"Someone goes home",      no:"Still all to play for" },
  { date:"Jun 24", label:"Day 14",       q:"Will Germany win their final group game?",                                pts:3, yes:"Die Mannschaft win",      no:"Draw or loss" },
  { date:"Jun 25", label:"Day 15",       q:"Will there be a last-minute winner (85'+ goal) on Day 15?",              pts:8, yes:"Late drama!",             no:"No late deciders" },
  { date:"Jun 26", label:"Day 16",       q:"Will France top Group I with a perfect record?",                         pts:8, yes:"Perfect France",         no:"France drop points" },
  { date:"Jun 27", label:"Final Day",    q:"Will a higher-ranked team lose on the final group stage day?",           pts:8, yes:"Shock result!",           no:"Favourites all win" },
];

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
  if (s === -1) throw new Error("No JSON returned");
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

// ── DRAG-TO-RANK ──────────────────────────────────────────────────────────────
function RankPicker({ teams, ranking, onChange }) {
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
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    const next = [...list]; [next[i], next[j]] = [next[j], next[i]]; onChange(next);
  }

  return (
    <div>
      {list.map((team, i) => (
        <div key={team} draggable
          onDragStart={() => setDragging(i)}
          onDragEnter={() => setDragOver(i)}
          onDragEnd={onDragEnd}
          onDragOver={e => e.preventDefault()}
          style={{
            display:"flex", alignItems:"center", gap:10,
            background: dragging===i ? "rgba(200,168,75,0.3)" : dragOver===i ? "rgba(200,168,75,0.12)" : "rgba(255,255,255,0.05)",
            border:`1px solid ${i<2?"rgba(100,200,100,0.3)":"rgba(255,255,255,0.08)"}`,
            borderRadius:8, padding:"10px 12px", marginBottom:6, cursor:"grab", transition:"background 0.15s",
          }}>
          <span style={{ fontSize:18 }}>{medals[i]}</span>
          <span style={{ fontSize:20 }}>{tf(team)}</span>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:13, color:"#f0e6c8" }}>{team}</div>
            <div style={{ fontSize:10, color:i<2?"#8fffb0":"#9ab8a0" }}>{posLabels[i]}</div>
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:2 }}>
            <button onClick={() => move(i,-1)} disabled={i===0} style={{ background:"rgba(255,255,255,0.08)", border:"none", borderRadius:3, color:"#9ab8a0", cursor:i===0?"default":"pointer", padding:"2px 6px", fontSize:10 }}>▲</button>
            <button onClick={() => move(i,1)} disabled={i===list.length-1} style={{ background:"rgba(255,255,255,0.08)", border:"none", borderRadius:3, color:"#9ab8a0", cursor:i===list.length-1?"default":"pointer", padding:"2px 6px", fontSize:10 }}>▼</button>
          </div>
        </div>
      ))}
      <div style={{ fontSize:10, color:"#9ab8a0", marginTop:4 }}>Drag to reorder or use ▲▼ buttons</div>
    </div>
  );
}

// ── APP ───────────────────────────────────────────────────────────────────────
export default function WorldCupPool() {
  const [screen, setScreen]               = useState("home");
  const [players, setPlayers]             = useState([]);
  const [predictions, setPredictions]     = useState({});
  const [dbLoading, setDbLoading]         = useState(true);
  const [dbError, setDbError]             = useState("");
  const [currentPlayer, setCurrentPlayer] = useState(null);
  const [newName, setNewName]             = useState("");

  const [predTab, setPredTab]             = useState("groups");
  const [selGroup, setSelGroup]           = useState("A");
  const [selPropIdx, setSelPropIdx]       = useState(0);
  const [groupRankings, setGroupRankings] = useState({});
  const [propPicks, setPropPicks]         = useState(Array(17).fill(null));
  const [saved, setSaved]                 = useState(false);
  const [saving, setSaving]               = useState(false);

  const [liveResults, setLiveResults]     = useState(null);
  const [fetchStatus, setFetchStatus]     = useState("idle");
  const [fetchError, setFetchError]       = useState("");
  const [lastFetched, setLastFetched]     = useState(null);

  // Load from Supabase on mount
  useEffect(() => {
    dbLoad()
      .then(data => { setPlayers(data.players); setPredictions(data.predictions); setDbLoading(false); })
      .catch(e => { setDbError(e.message); setDbLoading(false); });
  }, []);

  // Poll Supabase every 30s
  useEffect(() => {
    const iv = setInterval(() => {
      dbLoad().then(data => { setPlayers(data.players); setPredictions(data.predictions); }).catch(() => {});
    }, 30000);
    return () => clearInterval(iv);
  }, []);

  const refreshScores = useCallback(async () => {
    setFetchStatus("loading"); setFetchError("");
    try {
      const r = await fetchLiveResults();
      setLiveResults(r); setLastFetched(new Date()); setFetchStatus("done");
    } catch (e) { setFetchError(e.message); setFetchStatus("error"); }
  }, []);

  useEffect(() => { refreshScores(); }, []);

  async function register() {
    const name = newName.trim();
    if (!name || players.find(p => p.name === name)) return;
    const player = { name, id: `${Date.now()}-${Math.random().toString(36).slice(2)}` };
    const np = [...players, player];
    setPlayers(np);
    await dbSave(np, predictions);
    setCurrentPlayer(player);
    setNewName(""); setGroupRankings({}); setPropPicks(Array(17).fill(null));
    setScreen("predict");
  }

  function loginPlayer(player) {
    setCurrentPlayer(player);
    const e = predictions[player.id] || {};
    setGroupRankings(e.groupRankings || {});
    setPropPicks(e.propPicks || Array(17).fill(null));
    setSaved(false); setScreen("predict");
  }

  async function savePreds() {
    setSaving(true);
    const np = { ...predictions, [currentPlayer.id]: { groupRankings, propPicks } };
    setPredictions(np);
    await dbSave(players, np);
    setSaving(false); setSaved(true); setTimeout(() => setSaved(false), 2000);
  }

  const groupsDone = Object.keys(groupRankings).length;
  const propsDone  = propPicks.filter(p => p !== null).length;

  const leaderboard = players
    .map(p => ({ ...p, pts: calcPoints(predictions[p.id], liveResults), hasPred: !!predictions[p.id] }))
    .sort((a, b) => b.pts - a.pts);

  const prop       = DAILY_PROPS[selPropIdx];
  const propActual = liveResults?.propResults?.[selPropIdx];
  const propSettled = propActual !== null && propActual !== undefined;
  const propWon    = propSettled && propPicks[selPropIdx] === propActual;
  const propLost   = propSettled && propPicks[selPropIdx] !== null && !propWon;

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
              <p style={{ color:"#9ab8a0", fontSize:12, margin:"4px 0 0" }}>Phase 1: Group Stage · June 11–27 · Backed by Supabase ☁️</p>
            </div>

            <div style={S.card}>
              <div style={{ fontSize:11, fontWeight:"bold", color:"#f0d060", marginBottom:8, letterSpacing:1 }}>📊 PHASE 1 SCORING · Max {MAX_PTS} pts</div>
              {[
                ["🏅 Group Rankings", `3 pts exact position · 1 pt correct half · max ${MAX_RANKING_PTS} pts`],
                ["🎲 Daily Props (17)", `3–8 pts each · max ${MAX_PROP_PTS} pts`],
                ["🔜 Phase 2", "Knockout predictions — unlocks Jun 28"],
              ].map(([l,v]) => (
                <div key={l} style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", padding:"5px 0", borderBottom:"1px solid rgba(255,255,255,0.05)", fontSize:12, gap:8 }}>
                  <span style={{ minWidth:140 }}>{l}</span>
                  <span style={{ color:"#9ab8a0", textAlign:"right" }}>{v}</span>
                </div>
              ))}
            </div>

            <div style={{ ...S.card, borderColor:"rgba(100,200,255,0.3)", background:"rgba(0,80,160,0.15)" }}>
              <div style={{ fontSize:12, color:"#80d0ff" }}>☁️ <strong>Persistent pool</strong> — data saved to Supabase. Share this link with anyone; their picks save permanently and the leaderboard updates for everyone in real time.</div>
            </div>

            {players.length > 0 && (
              <div style={{ marginBottom:14 }}>
                <div style={{ fontSize:11, color:"#9ab8a0", letterSpacing:1, marginBottom:8 }}>PLAYERS — tap to edit your picks</div>
                <div style={{ display:"flex", flexWrap:"wrap", gap:8 }}>
                  {players.map(p => (
                    <button key={p.id} onClick={() => loginPlayer(p)} style={{ background:"rgba(200,168,75,0.15)", border:"1px solid rgba(200,168,75,0.4)", borderRadius:20, padding:"6px 14px", color:"#f0d060", cursor:"pointer", fontSize:13 }}>
                      {predictions[p.id] ? "✓ " : ""}{p.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div style={S.card}>
              <div style={{ fontSize:11, color:"#9ab8a0", marginBottom:8 }}>JOIN THE POOL</div>
              <div style={{ display:"flex", gap:8 }}>
                <input value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key==="Enter" && register()} placeholder="Your name…" style={{ ...S.input, flex:1 }} />
                <button onClick={register} style={S.btn}>Join</button>
              </div>
              {players.find(p => p.name===newName.trim()) && <div style={{ color:"#e06060", fontSize:11, marginTop:4 }}>Name already taken</div>}
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
                <button onClick={() => setScreen("home")} style={{ background:"rgba(255,255,255,0.07)", border:"1px solid rgba(255,255,255,0.1)", borderRadius:6, padding:"6px 10px", color:"#9ab8a0", cursor:"pointer", fontSize:12 }}>← Back</button>
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
              {[["groups",`🏅 Groups (${groupsDone}/12)`],["props",`🎲 Props (${propsDone}/17)`]].map(([t,l]) => (
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
                />
                <div style={{ display:"flex", justifyContent:"space-between", marginTop:12 }}>
                  <button style={S.pill(false)} onClick={() => { const ks=Object.keys(TEAMS_BY_GROUP); const i=ks.indexOf(selGroup); if(i>0) setSelGroup(ks[i-1]); }} disabled={selGroup==="A"}>← Prev</button>
                  <span style={{ fontSize:11, color:"#9ab8a0" }}>Group {selGroup} · {Object.keys(TEAMS_BY_GROUP).indexOf(selGroup)+1}/12</span>
                  <button style={S.pill(false)} onClick={() => { const ks=Object.keys(TEAMS_BY_GROUP); const i=ks.indexOf(selGroup); if(i<ks.length-1) setSelGroup(ks[i+1]); }} disabled={selGroup==="L"}>Next →</button>
                </div>
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
                    return (
                      <button key={i} style={{
                        padding:"3px 7px", borderRadius:4, border:"none", fontSize:10, fontWeight:"bold", cursor:"pointer",
                        background: selPropIdx===i ? "#c8a84b" : settled ? "rgba(100,200,100,0.2)" : picked ? "rgba(200,168,75,0.2)" : "rgba(255,255,255,0.08)",
                        color: selPropIdx===i ? "#0a1628" : settled ? "#8fffb0" : picked ? "#f0d060" : "#9ab8a0",
                      }} onClick={() => setSelPropIdx(i)}>
                        {p.date.replace("Jun ","")} {picked?"✓":""}
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

                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                    {[[true,"✅",prop.yes],[false,"❌",prop.no]].map(([val,icon,label]) => (
                      <button key={String(val)} onClick={() => { const n=[...propPicks]; n[selPropIdx]=val; setPropPicks(n); }} style={{
                        padding:"14px 8px", borderRadius:10, border:"2px solid",
                        borderColor:propPicks[selPropIdx]===val?"#f0d060":"rgba(255,255,255,0.1)",
                        background:propPicks[selPropIdx]===val?"rgba(200,168,75,0.25)":"rgba(255,255,255,0.04)",
                        color:propPicks[selPropIdx]===val?"#f0d060":"#c8b8a0",
                        cursor:"pointer", fontSize:12, textAlign:"center", lineHeight:1.4,
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
              </div>
            )}

            {leaderboard.length===0 && <div style={{ color:"#9ab8a0" }}>No players yet — go to Home to join!</div>}
            {leaderboard.map((p, i) => {
              const pred = predictions[p.id];
              const grpDone = pred ? Object.keys(pred.groupRankings||{}).length : 0;
              const prpDone = pred ? (pred.propPicks||[]).filter(x=>x!==null).length : 0;
              return (
                <div key={p.id} style={{ display:"flex", alignItems:"center", gap:12, background:i===0?"rgba(200,168,75,0.15)":"rgba(255,255,255,0.04)", borderRadius:8, padding:"12px 14px", marginBottom:8, border:`1px solid ${i===0?"rgba(200,168,75,0.4)":"rgba(255,255,255,0.06)"}` }}>
                  <div style={{ fontSize:20, minWidth:28, textAlign:"center" }}>{i===0?"🥇":i===1?"🥈":i===2?"🥉":`#${i+1}`}</div>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:15, color:i===0?"#f0d060":"#f0e6c8" }}>{p.name}</div>
                    <div style={{ fontSize:10, color:"#9ab8a0" }}>
                      {pred ? `${grpDone}/12 groups · ${prpDone}/17 props` : "No predictions yet"}
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
