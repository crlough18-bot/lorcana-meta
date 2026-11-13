/* Lorcana Meta: client-side analysis of one event's match data.
   Data: data/index.json (event list) and data/events/<slug>.json
   (players [name, deckIdx], matches [phase, round, p1, p2, result, gamesW, gamesL],
   result 1 = p1 won, 2 = p2 won, 0 = draw, -1 = unreported, 3 = bye). */
(() => {
  "use strict";

  const INKS = ["amber", "amethyst", "emerald", "ruby", "sapphire", "steel"];
  const TABS = [
    ["overview", "Overview"], ["matchups", "Matchups"], ["conversion", "Conversion"],
    ["rounds", "Round by round"], ["duels", "vs Duels"], ["players", "Players"], ["run", "Player run"],
  ];
  const app = document.getElementById("app");
  const picker = document.getElementById("event-picker");
  const tip = document.getElementById("tip");
  const cache = new Map();
  let index = null;
  let refreshTimer = null;
  const sortState = {};

  // ------------------------------------------------------------ helpers
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style") el.style.cssText = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "tip") el.dataset.tip = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const svgNS = "http://www.w3.org/2000/svg";
  function s(tag, attrs, ...kids) {
    const el = document.createElementNS(svgNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null) continue;
      if (k === "tip") el.dataset.tip = v; else el.setAttribute(k, v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const pct = (v, d = 1) => (v == null || !isFinite(v) ? "—" : v.toFixed(d) + "%");
  const num = (v) => (v == null ? "—" : v.toLocaleString("en-US"));
  const signed = (v, d = 1, unit = "") => (v == null || !isFinite(v) ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "±") + Math.abs(v).toFixed(d) + unit);
  function wilson(w, n, z = 1.96) {
    if (!n) return [0, 0];
    const p = w / n, d = 1 + z * z / n, c = p + z * z / (2 * n);
    const r = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
    return [100 * (c - r) / d, 100 * (c + r) / d];
  }
  function ago(iso) {
    if (!iso) return "";
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m} min ago`;
    const hr = Math.round(m / 60);
    return hr < 48 ? `${hr} h ago` : new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  }
  function dateRange(a, b) {
    if (!a) return "";
    const o = { day: "numeric", month: "short", year: "numeric" };
    const da = new Date(a), db = b ? new Date(b) : null;
    if (!db || da.toDateString() === db.toDateString()) return da.toLocaleDateString("en-GB", o);
    return `${da.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} – ${db.toLocaleDateString("en-GB", o)}`;
  }
  const inksOf = (name) => (name || "").toLowerCase().split(/[,/]\s*/).filter((x) => INKS.includes(x));
  const slashName = (name) => (name || "Unknown").replace(/,\s*/g, " / ");
  const shortName = (name) => inksOf(name).map((x) => x[0].toUpperCase() + x.slice(1, 3)).join("/") || "Unk";
  function deckChip(name, short) {
    const inks = inksOf(name);
    return h("span", { class: "deck" },
      h("span", { class: "pips", "aria-hidden": "true" }, (inks.length ? inks : ["unknown"]).map((i) => h("i", { class: "pip", style: `background:var(--${i})` }))),
      short ? shortName(name) : slashName(name));
  }
  function seg(label, options, value, onPick) {
    return h("div", { class: "ctl-group" }, h("span", null, label),
      h("div", { class: "seg", role: "group", "aria-label": label },
        options.map(([v, text]) => h("button", { type: "button", "aria-pressed": String(String(v) === String(value)), onclick: () => onPick(v) }, text))));
  }

  // tooltips: any element with data-tip
  function showTip(ev) {
    const t = ev.target.closest("[data-tip]");
    if (!t) { tip.hidden = true; return; }
    const lines = t.dataset.tip.split("\n");
    tip.replaceChildren(h("b", null, lines[0]), ...lines.slice(1).map((l) => h("div", null, l)));
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    const x = Math.min(ev.clientX + 14, window.innerWidth - r.width - 8);
    const y = ev.clientY + 16 + r.height > window.innerHeight ? ev.clientY - r.height - 12 : ev.clientY + 16;
    tip.style.left = Math.max(8, x) + "px";
    tip.style.top = y + "px";
  }
  document.addEventListener("mousemove", showTip);
  document.addEventListener("click", (e) => { if (e.target.closest("[data-tip]")) showTip(e); });
  document.addEventListener("scroll", () => { tip.hidden = true; }, { passive: true });

  // ------------------------------------------------------------ routing
  function route() {
    const raw = location.hash.replace(/^#\/?/, "");
    const [path, qs] = raw.split("?");
    const parts = path.split("/").filter(Boolean);
    const q = Object.fromEntries(new URLSearchParams(qs || ""));
    if (parts[0] === "e" && parts[1]) return { view: "event", slug: parts[1], tab: parts[2] === "winrates" ? "overview" : parts[2] || "overview", q };
    if (parts[0] === "about") return { view: "about", q };
    return { view: "home", q };
  }
  function go(r, replace) {
    const qs = new URLSearchParams(Object.entries(r.q || {}).filter(([, v]) => v != null && v !== "")).toString();
    const hash = r.view === "event" ? `#/e/${r.slug}/${r.tab}${qs ? "?" + qs : ""}` : r.view === "about" ? "#/about" : "#/";
    if (replace) { history.replaceState(null, "", hash); render(); } else location.hash = hash;
  }
  function setQ(updates) { const r = route(); r.q = { ...r.q, ...updates }; go(r, true); }

  // ------------------------------------------------------------ data
  async function getJSON(url) {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`${res.status} loading ${url}`);
    return res.json();
  }
  async function loadIndex(force) {
    if (!index || force) index = await getJSON("data/index.json");
    picker.replaceChildren(h("option", { value: "" }, "Choose an event…"),
      ...index.events.map((e) => h("option", { value: e.slug }, `${e.live ? "● " : ""}${e.name} · ${dateRange(e.start)}`)));
    const r = route();
    picker.value = r.view === "event" ? r.slug : "";
    return index;
  }
  async function loadEvent(slug, force) {
    if (!cache.has(slug) || force) cache.set(slug, model(await getJSON(`data/events/${slug}.json`)));
    return cache.get(slug);
  }
  picker.addEventListener("change", () => { if (picker.value) go({ view: "event", slug: picker.value, tab: route().tab || "overview", q: {} }); });

  // ------------------------------------------------------------ analysis model
  function model(data) {
    const decks = data.decks;
    const unknown = decks.indexOf("Unknown");
    const P = data.players.length;
    const deckOf = data.players.map((p) => p[1]);
    const M = data.matches;
    const phases = [...new Set(M.map((m) => m[0]))].sort();
    const roundsIn = (ph) => [...new Set(M.filter((m) => m[0] === ph).map((m) => m[1]))].sort((a, b) => a - b);
    const roundDone = new Map((data.meta.rounds || []).map((r) => [`${r.phase}:${r.round}`, r.status === "COMPLETE"]));

    // field: players seated in the first phase-1 round
    const firstRound = roundsIn(1)[0];
    const field = new Array(decks.length).fill(0);
    const seated = new Set();
    for (const m of M) if (m[0] === 1 && m[1] === firstRound) for (const p of [m[2], m[3]]) if (p >= 0 && !seated.has(p)) { seated.add(p); field[deckOf[p]]++; }
    if (!seated.size) for (let p = 0; p < P; p++) { seated.add(p); field[deckOf[p]]++; }
    const fieldN = seated.size;
    const fieldKnown = fieldN - (unknown >= 0 ? field[unknown] : 0);
    const fieldSet = seated;

    const scopeTest = { all: () => true, d1: (m) => m[0] === 1, d2: (m) => m[0] === 2, cut: (m) => m[0] >= 3 };
    function stats(scope) {
      const test = scopeTest[scope] || scopeTest.all;
      const st = decks.map(() => ({ w: 0, l: 0, d: 0, mir: 0, gw: 0, gl: 0 }));
      const mu = new Map();
      for (const m of M) {
        if (!test(m) || m[3] < 0 || m[4] === -1 || m[4] === 3) continue;
        const a = deckOf[m[2]], b = deckOf[m[3]];
        if (a === unknown || b === unknown) continue;
        if (a === b) { st[a].mir++; continue; }
        if (m[4] === 0) { st[a].d++; st[b].d++; continue; }
        const [W, L] = m[4] === 1 ? [a, b] : [b, a];
        st[W].w++; st[L].l++;
        st[W].gw += m[5]; st[W].gl += m[6]; st[L].gw += m[6]; st[L].gl += m[5];
        const k1 = W + ":" + L, k2 = L + ":" + W;
        if (!mu.has(k1)) mu.set(k1, { w: 0, l: 0, gw: 0, gl: 0 });
        if (!mu.has(k2)) mu.set(k2, { w: 0, l: 0, gw: 0, gl: 0 });
        const x = mu.get(k1), y = mu.get(k2);
        x.w++; y.l++; x.gw += m[5]; x.gl += m[6]; y.gw += m[6]; y.gl += m[5];
      }
      return st.map((v, i) => {
        const n = v.w + v.l, g = v.gw + v.gl;
        return { i, name: decks[i], key: data.decks_key[i], ...v, n, wr: n ? 100 * v.w / n : null, ci: wilson(v.w, n),
                 g, gwr: g ? 100 * v.gw / g : null, gci: wilson(v.gw, g) };
      }).concat([]).map((x) => Object.assign(x, { mu }));
    }

    // records through the latest complete phase-1 round
    const p1Rounds = roundsIn(1);
    const p1Done = p1Rounds.filter((r) => roundDone.get(`1:${r}`));
    const lastP1 = p1Done.length ? p1Done[p1Done.length - 1] : null;
    function recordsThrough(phase, round) {
      const rec = Array.from({ length: P }, () => ({ w: 0, l: 0, d: 0, played: 0 }));
      for (const m of M) {
        if (m[0] > phase || (m[0] === phase && m[1] > round) || m[4] === -1) continue;
        const a = m[2], b = m[3];
        if (m[4] === 3) { if (a >= 0) { rec[a].w++; rec[a].played++; } continue; }
        if (a < 0 || b < 0) continue;
        rec[a].played++; rec[b].played++;
        if (m[4] === 0) { rec[a].d++; rec[b].d++; } else if (m[4] === 1) { rec[a].w++; rec[b].l++; } else { rec[b].w++; rec[a].l++; }
      }
      return rec;
    }
    function playersIn(phase, round) {
      const set = new Set();
      for (const m of M) if (m[0] === phase && m[1] === round) { if (m[2] >= 0) set.add(m[2]); if (m[3] >= 0) set.add(m[3]); }
      return set;
    }
    const deckCount = (set) => { const c = new Array(decks.length).fill(0); for (const p of set) c[deckOf[p]]++; return c; };
    const d2First = roundsIn(2)[0];
    const day2 = d2First != null ? playersIn(2, d2First) : null;
    const cutPhase = phases.find((p) => p >= 3);
    const cut = cutPhase != null ? playersIn(cutPhase, roundsIn(cutPhase)[0]) : null;

    // day 2: the real roster once paired; until then, projected from day 1 match points against the
    // known cutoff. Points only go up, so a player at the cutoff is locked in; one who cannot reach it
    // with the rounds left (or who dropped) is out; everyone else is still alive.
    const T = data.meta.day2_points;
    const R1 = ((data.meta.phases || []).find((p) => p.order === 1) || {}).rounds_planned || roundsIn(1).length;
    let d2 = null;
    if (day2) {
      const status = Array.from({ length: P }, (_, p) => (day2.has(p) ? "in" : "out"));
      d2 = { status, projected: false, locked: day2, alive: new Set() };
    } else if (T && roundsIn(1).length) {
      const pts = new Array(P).fill(0), known = new Array(P).fill(0);
      for (const m of M) {
        if (m[0] !== 1 || m[4] === -1) continue;
        const a = m[2], b = m[3];
        if (m[4] === 3) { if (a >= 0) { pts[a] += 3; known[a]++; } continue; }
        if (a < 0 || b < 0) continue;
        known[a]++; known[b]++;
        if (m[4] === 0) { pts[a]++; pts[b]++; } else if (m[4] === 1) pts[a] += 3; else pts[b] += 3;
      }
      const p1 = roundsIn(1), lastPaired = p1[p1.length - 1];
      const inLast = playersIn(1, lastPaired);
      const status = new Array(P).fill("out"), locked = new Set(), alive = new Set();
      for (const p of fieldSet) {
        if (pts[p] >= T) { status[p] = "in"; locked.add(p); }
        else if (inLast.has(p) && pts[p] + 3 * Math.max(0, R1 - known[p]) >= T) { status[p] = "alive"; alive.add(p); }
      }
      d2 = { status, projected: true, locked, alive, T, R1, pts };
    }

    const reported = M.filter((m) => m[4] !== -1).length;
    return { data, meta: data.meta, decks, unknown, P, deckOf, M, phases, roundsIn, roundDone, field, fieldN, fieldKnown, fieldSet,
             stats, recordsThrough, playersIn, deckCount, lastP1, day2, d2, cut, cutPhase, reported };
  }

  // decks shown: known decks ordered by field share
  const knownDecks = (md) => md.decks.map((n, i) => i).filter((i) => i !== md.unknown);
  const fieldShare = (md, i) => (md.fieldKnown ? 100 * md.field[i] / md.fieldN : 0);

  // ------------------------------------------------------------ generic sortable table
  function table(id, cols, rows, opts = {}) {
    cols = cols.filter(Boolean);
    const st = sortState[id] || (sortState[id] = { key: opts.sortKey || null, dir: opts.sortDir || "desc" });
    const sorted = rows.slice();
    if (st.key) {
      const col = cols.find((c) => c.key === st.key);
      const val = col && (col.sort || ((r) => r[col.key]));
      sorted.sort((a, b) => {
        const x = val(a), y = val(b);
        if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
        return (x < y ? -1 : x > y ? 1 : 0) * (st.dir === "asc" ? 1 : -1);
      });
    }
    const thead = h("thead", null, h("tr", null, cols.map((c) => {
      const sortable = c.sortable !== false;
      return h("th", {
        class: [c.align === "l" ? "l" : "", sortable ? "sortable" : ""].join(" ").trim(),
        "aria-sort": st.key === c.key ? (st.dir === "asc" ? "ascending" : "descending") : null,
        tip: c.help ? `${c.label}\n${c.help}` : null,
        onclick: sortable ? () => { st.dir = st.key === c.key && st.dir === "desc" ? "asc" : "desc"; st.key = c.key; render(); } : null,
      }, c.label);
    })));
    const tbody = h("tbody", null, sorted.map((r) => h("tr", { class: opts.rowClass ? opts.rowClass(r) : null },
      cols.map((c) => {
        const v = c.cell ? c.cell(r) : r[c.key];
        return h("td", { class: [c.align === "l" ? "l" : "", c.cls ? c.cls(r) || "" : ""].join(" ").trim() || null }, v);
      }))));
    return h("div", { class: "tscroll" }, h("table", { class: "data", id }, thead, tbody));
  }
  const tone = (wr, n, min = 100) => (n < min || wr == null ? "muted" : wr >= 54 ? "good" : wr <= 46 ? "bad" : "");

  // ------------------------------------------------------------ views
  const statusBadge = (e) => (e.live ? h("span", { class: "badge live" }, "Live")
    : e.final ? h("span", { class: "badge" }, "Final")
    : h("span", { class: "badge" }, e.display_status === "upcoming" ? "Upcoming" : "In progress"));
  const inkFill = (name) => {
    const inks = inksOf(name);
    const a = `var(--${inks[0] || "unknown"})`, b = `var(--${inks[1] || inks[0] || "unknown"})`;
    return `linear-gradient(90deg, ${a} 0 50%, ${b} 50% 100%)`;
  };
  function metaStrip(top) {
    if (!top || !top.length) return null;
    const used = top.reduce((a, [, v]) => a + v, 0);
    return h("div", { class: "strip-wrap" },
      h("div", { class: "strip", role: "img", "aria-label": "Most played ink pairings" },
        top.map(([name, v]) => h("i", { style: `flex:${v};background:${inkFill(name)}`, tip: `${slashName(name)}\n${pct(v)} of players` })),
        used < 100 ? h("i", { class: "rest", style: `flex:${100 - used}`, tip: `Every other pairing\n${pct(100 - used)}` }) : null),
      h("div", { class: "strip-legend" }, top.slice(0, 3).map(([name, v]) => h("span", null, deckChip(name, true), h("b", null, pct(v, 0))))));
  }
  function viewHome() {
    return h("div", { class: "home" },
      h("section", { class: "masthead home-mast" },
        h("span", { class: "kicker" }, "Disney Lorcana tournament meta"),
        h("h1", null, "Lorcana Meta")),
      h("div", { class: "section-head" }, h("h2", null, "Events"), h("span", { class: "muted" }, `${index.events.length} tracked`)),
      index.events.length ? h("div", { class: "cards" }, index.events.slice().sort((a, b) => (b.live - a.live) || (b.start || "").localeCompare(a.start || "")).map(eventCard)) : h("div", { class: "empty" }, "No events yet."));
  }
  function eventCard(e) {
    const d = new Date(e.start);
    return h("a", { class: "card ev-card", href: `#/e/${e.slug}/overview` },
      h("div", { class: "datebox", "aria-hidden": "true" },
        h("span", null, d.toLocaleDateString("en-GB", { month: "short" })), h("b", null, String(d.getDate()))),
      h("div", { class: "ev-card-body" },
        h("div", { class: "split" }, statusBadge(e), h("span", { class: "muted small" }, dateRange(e.start, e.end))),
        h("h3", null, e.name),
        h("div", { class: "stats" },
          h("span", null, h("b", null, num(e.players)), " players"),
          e.rounds_planned ? h("span", null, h("b", null, `${e.rounds_done || 0}/${e.rounds_planned}`), " rounds") : null,
          h("span", null, e.format || "")),
        metaStrip(e.top_decks || (e.top_deck ? [[e.top_deck, 0]] : null))));
  }

  function viewAbout() {
    return h("article", { class: "prose" },
      h("h1", null, "About Lorcana Meta"),
      h("p", null, "Most Lorcana meta sites count the decklists that top players choose to submit. Since November 2026, big events on the Ravensburger Play network show every player's ink pairing next to their pairings and results. Lorcana Meta reads those public results and works out how each pairing actually did across the whole field, round by round."),
      h("h2", null, "How the numbers are worked out"),
      h("p", null, "Field share counts every player seated in round 1, before anyone drops. Match win rate leaves out mirror matches, byes, draws and unreported matches, and any player who registered no deck. Game win rate does the same with the games inside each match. The range shown next to a win rate is a 95% confidence interval; a small pairing's range is wide, so read it before the headline number."),
      h("p", null, "Conversion compares a pairing's share of a later group (players with at most one loss after day 1, the day 2 field, the top cut) with its share of the starting field. Above 1 means the pairing is reaching that group more often than its numbers alone would predict."),
      h("h2", null, "The online comparison"),
      h("p", null, "The vs Duels tab compares each pairing at the event with its results on Duels.ink, a free community simulator, over the two full weeks (Sunday to Saturday) before the event's week. That is the meta players were testing against, on matching dates rather than today's numbers. It can be filtered to Legendary rank and above, and to best-of-three or best-of-one queues. Duels data is taken once per event and kept."),
      h("h2", null, "Updates"),
      h("p", null, "While an event is running, new rounds are pulled about every 15 minutes, and an open page reloads them on its own. A finished event is frozen."),
      h("h2", null, "Credits"),
      h("p", null, "Event data: the Ravensburger Play network. Online data: ", h("a", { href: "https://duels.ink/stats", rel: "noopener" }, "Duels.ink"), ". Lorcana Meta is an unofficial fan project and is not affiliated with or endorsed by Disney or Ravensburger."));
  }

  function eventHeader(md, tab) {
    const m = md.meta;
    const doneRounds = (m.rounds || []).filter((r) => r.status === "COMPLETE").length;
    const totalPlanned = (m.phases || []).reduce((a, p) => a + (p.rounds_planned || 0), 0);
    const updated = (m.rounds || []).map((r) => r.fetched_at).filter(Boolean).sort().pop() || m.built_at;
    return h("div", { class: "ev-head" },
      h("section", { class: "masthead" },
        h("div", { class: "crumbs" }, h("a", { href: "#/" }, "Events"), h("span", null, "/"), statusBadge(m)),
        h("h1", null, m.name),
        h("div", { class: "ev-sub" },
          h("span", null, dateRange(m.start, m.end)), m.venue ? h("span", null, m.venue) : null, h("span", null, m.format || ""),
          totalPlanned ? h("span", null, `Round ${doneRounds} of ${totalPlanned}`) : null,
          h("span", null, `Updated ${ago(updated)}`),
          m.sleep_until ? h("span", null, `Play resumes tomorrow; updates restart ${new Date(m.sleep_until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZoneName: "short" })}`) : null,
          h("a", { href: m.url, rel: "noopener" }, "Official event page ↗"))),
      h("nav", { class: "tabs", "aria-label": "Event views" },
        TABS.map(([k, label]) => h("a", { href: `#/e/${m.slug}/${k}${location.hash.includes("?") ? "?" + location.hash.split("?")[1] : ""}`, "aria-current": k === tab ? "page" : null }, label))));
  }

  function scopeControl(md, q) {
    const opts = [["all", "Whole event"], ["d1", "Day 1"]];
    if (md.phases.includes(2)) opts.push(["d2", "Day 2"]);
    if (md.cutPhase != null) opts.push(["cut", "Top cut"]);
    return seg("Rounds", opts, q.scope || "all", (v) => setQ({ scope: v === "all" ? null : v }));
  }
  function minControl(q, def) {
    return seg("Hide pairings under", [[0, "All"], [50, "50 matches"], [100, "100"], [200, "200"]], q.min ?? def, (v) => setQ({ min: String(v) }));
  }

  // ---- overview
  function viewOverview(md, q) {
    const scope = q.scope || "all", min = Number(q.min ?? 50);
    const all = md.stats("all");
    const st = scope === "all" ? all : md.stats(scope);
    const known = knownDecks(md);
    const big = known.filter((i) => all[i].n >= 150).sort((a, b) => all[b].wr - all[a].wr);
    const top = known.slice().sort((a, b) => md.field[b] - md.field[a]);
    const kpi = (v, l) => h("div", { class: "kpi" }, h("b", null, v), h("span", null, l));
    const doneRounds = (md.meta.rounds || []).filter((r) => r.status === "COMPLETE").length;
    const takeaway = [];
    if (top.length) takeaway.push(h("span", null, h("b", null, slashName(md.decks[top[0]])), ` is the most played pairing at ${pct(fieldShare(md, top[0]))} of the field.`));
    if (big.length) takeaway.push(h("span", null, " Among pairings with 150+ matches, ", h("b", null, slashName(md.decks[big[0]])), ` has the best match win rate at ${pct(all[big[0]].wr)}`, big.length > 1 ? h("span", null, " and ", h("b", null, slashName(md.decks[big[big.length - 1]])), ` the weakest at ${pct(all[big[big.length - 1]].wr)}.`) : "."));
    const rows = known.map((i) => Object.assign({}, st[i], { share: fieldShare(md, i), players: md.field[i] })).filter((r) => r.players || r.n + r.mir + r.d > 0);
    const maxShare = Math.max(...rows.map((r) => r.share), 1);
    return h("div", { class: "section" },
      h("div", { class: "kpis" },
        kpi(num(md.fieldN), "Players"), kpi(String(known.filter((i) => md.field[i] > 0).length), "Ink pairings"),
        kpi(String(doneRounds), "Rounds complete"), kpi(num(md.reported), "Matches reported"),
        md.unknown >= 0 && md.field[md.unknown] ? kpi(num(md.field[md.unknown]), "No deck registered") : null),
      takeaway.length ? h("p", { class: "takeaway" }, takeaway) : null,
      h("div", { class: "panel section" },
        h("div", { class: "split" }, h("h2", null, "Pairings"), h("span", { class: "note" }, "Click a column to sort. Hover a header for its definition.")),
        h("div", { class: "controls" }, scopeControl(md, q), minControl(q, 50)),
        table("wr", [
        { key: "name", label: "Pairing", align: "l", cell: (r) => deckChip(r.name), sort: (r) => r.name },
        { key: "players", label: "Players", cell: (r) => num(r.players) },
        { key: "share", label: "Field", cell: (r) => h("span", { class: "sharecell" }, h("span", { class: "bar", style: `width:${Math.max(2, 56 * r.share / maxShare)}px;background:${inkFill(r.name)}` }), pct(r.share)), help: "Share of all players seated in round 1." },
        { key: "n", label: "Matches", cell: (r) => num(r.n), help: "Non-mirror matches with a result." },
        { key: "wr", label: "Match WR", cell: (r) => pct(r.wr), cls: (r) => tone(r.wr, r.n, min || 50) },
        { key: "lo", label: "95% range", sort: (r) => r.ci[0], cell: (r) => h("span", { class: "ci" }, r.n ? `${r.ci[0].toFixed(0)}–${r.ci[1].toFixed(0)}` : "—"), help: "If two ranges overlap a lot, the difference may be noise." },
        { key: "gwr", label: "Game WR", cell: (r) => pct(r.gwr) },
        { key: "w", label: "W–L–D", sort: (r) => r.w, cell: (r) => `${r.w}–${r.l}–${r.d}` },
        { key: "mir", label: "Mirrors", cell: (r) => num(r.mir) },
      ], rows, { sortKey: "share", rowClass: (r) => (r.n < min ? "dim" : null) }),
        h("p", { class: "note" }, "Match win rate leaves out mirrors, byes, draws, unreported matches and players with no registered deck. The 95% range shows how much of a gap could be noise.")));
  }

  // ---- matchups
  function viewMatchups(md, q) {
    const scope = q.scope || "all", topN = Number(q.top || 8), minG = Number(q.mg || 20);
    const st = md.stats(scope);
    const mu = st[0] ? st[0].mu : new Map();
    const order = knownDecks(md).sort((a, b) => md.field[b] - md.field[a]).slice(0, topN);
    const sel = q.cell ? q.cell.split(":").map(Number) : null;
    const color = (wr) => {
      const t = Math.max(-1, Math.min(1, (wr - 50) / 15));
      const c = t >= 0 ? "var(--good)" : "var(--bad)";
      return `background: color-mix(in srgb, ${c} ${Math.round(Math.abs(t) * 70)}%, var(--panel-2))`;
    };
    const pipsOf = (name) => h("span", { class: "pips", "aria-hidden": "true" }, (inksOf(name).length ? inksOf(name) : ["unknown"]).map((ink) => h("i", { class: "pip", style: `background:var(--${ink})` })));
    const overall = (i) => {
      const r = st[i];
      if (!r.n) return h("td", { class: "overall muted" }, "—");
      return h("td", { class: `overall ${tone(r.wr, r.n)}`, tip: `${slashName(md.decks[i])} overall\n${r.w}–${r.l}–${r.d} in non-mirror matches (${pct(r.wr)})\n95% range ${r.ci[0].toFixed(0)}–${r.ci[1].toFixed(0)}%` },
        `${r.wr.toFixed(1)}%`, h("span", { class: "n" }, num(r.n)));
    };
    const head = h("tr", null, h("th"), order.map((j) => h("th", { class: "col", tip: slashName(md.decks[j]) }, pipsOf(md.decks[j]), h("span", null, shortName(md.decks[j])))),
      h("th", { class: "col overall-h", tip: "Overall\nMatch win rate against every pairing, mirrors left out" }, "Overall"));
    const body = order.map((i) => h("tr", null, h("th", { class: "row", tip: slashName(md.decks[i]) }, h("span", { class: "rowlab" }, pipsOf(md.decks[i]), shortName(md.decks[i]))),
      order.map((j) => {
        if (i === j) return h("td", { class: "mirror", "aria-label": "Mirror", tip: `${slashName(md.decks[i])} mirror\n${st[i].mir} matches` });
        const x = mu.get(i + ":" + j);
        if (!x) return h("td", { class: "self" }, "—");
        const n = x.w + x.l, wr = 100 * x.w / n, ci = wilson(x.w, n);
        const isSel = sel && sel[0] === i && sel[1] === j;
        return h("td", {
          class: isSel ? "sel" : null, style: color(wr) + (n < minG ? ";opacity:.45" : ""),
          tip: `${slashName(md.decks[i])} vs ${slashName(md.decks[j])}\n${x.w}–${x.l} in matches (${pct(wr)})\nGames ${x.gw}–${x.gl}\n95% range ${ci[0].toFixed(0)}–${ci[1].toFixed(0)}%`,
          onclick: () => setQ({ cell: `${i}:${j}` }),
        }, `${wr.toFixed(0)}%`, h("span", { class: "n" }, n));
      }), overall(i)));
    return h("div", { class: "section" },
      h("div", { class: "controls" }, scopeControl(md, q),
        seg("Pairings shown", [[6, "Top 6"], [8, "Top 8"], [10, "Top 10"], [14, "Top 14"]], topN, (v) => setQ({ top: String(v) })),
        seg("Fade cells under", [[10, "10 matches"], [20, "20"], [40, "40"]], minG, (v) => setQ({ mg: String(v) }))),
      h("p", { class: "note" }, "Each cell is the row pairing's match win rate against the column pairing, with the number of matches below. Faded cells have too few matches to trust. Click a cell for detail."),
      h("div", { class: "panel tscroll" },
        h("div", { class: "legend" }, h("span", null, "Row loses"), h("i", { style: "background:var(--bad)" }), h("i", { style: "background:var(--panel-2)" }), h("i", { style: "background:var(--good)" }), h("span", null, "Row wins")),
        h("table", { class: "matrix", "aria-label": "Matchup win rates" }, h("thead", null, head), h("tbody", null, body))),
      sel ? matchupDetail(md, mu, sel[0], sel[1]) : null);
  }
  function matchupDetail(md, mu, i, j) {
    const x = mu.get(i + ":" + j);
    if (!x) return null;
    const n = x.w + x.l, ci = wilson(x.w, n), g = x.gw + x.gl;
    let duels = null;
    const D = md.data.duels;
    if (D) {
      const ka = md.data.decks_key[i], kb = md.data.decks_key[j];
      const parts = [];
      for (const [qk, ql] of [["bo3", "BO3"], ["bo1", "BO1"]]) for (const [tk, tl] of [["all", "all ranks"], ["legendary", "Legendary+"]]) {
        const qq = duelsQueue(D, qk); const t = qq && qq[tk];
        const m1 = t && t.matchups[`${ka}|${kb}`], m2 = t && t.matchups[`${kb}|${ka}`];
        let games = 0, wins = 0;
        if (m1) { games += m1.games; wins += m1.winsA; }
        if (m2) { games += m2.games; wins += m2.games - m2.winsA; }
        if (games) parts.push(h("li", null, h("span", null, `Duels ${ql}, ${tl}`), h("span", null, `${pct(100 * wins / games)} of ${num(games)} games`)));
      }
      if (parts.length) duels = h("ul", { class: "list" }, parts);
    }
    return h("div", { class: "panel section" },
      h("h2", null, h("span", null, slashName(md.decks[i]), " vs ", slashName(md.decks[j]))),
      h("ul", { class: "list" },
        h("li", null, h("span", null, "Matches at this event"), h("span", null, `${x.w}–${x.l} · ${pct(100 * x.w / n)} (range ${ci[0].toFixed(0)}–${ci[1].toFixed(0)}%)`)),
        h("li", null, h("span", null, "Games at this event"), h("span", null, `${x.gw}–${x.gl} · ${pct(g ? 100 * x.gw / g : null)}`))),
      duels ? h("h3", null, "Online, two weeks before (game win rate)") : null, duels);
  }

  // ---- conversion
  function viewConversion(md) {
    const known = knownDecks(md);
    const R = md.lastP1;
    const rec = R != null ? md.recordsThrough(1, R) : null;
    // day 1 wins of every player seated in round 1, by pairing
    const wins = md.decks.map(() => []);
    if (rec) for (const p of md.fieldSet) wins[md.deckOf[p]].push(rec[p].w);
    const allWins = known.flatMap((i) => wins[i]);
    const fieldAvg = allWins.length ? allWins.reduce((a, b) => a + b, 0) / allWins.length : null;
    const D2 = md.d2;
    const d2c = D2 && D2.locked.size ? md.deckCount(D2.locked) : null;
    const alc = D2 && D2.projected ? md.deckCount(D2.alive) : null;
    const cutc = md.cut ? md.deckCount(md.cut) : null;
    const cutKnown = md.cut ? md.cut.size - (md.unknown >= 0 ? cutc[md.unknown] : 0) : 0;
    const rows = known.filter((i) => md.field[i]).map((i) => {
      const fs = fieldShare(md, i), w = wins[i];
      const ds = d2c ? 100 * d2c[i] / D2.locked.size : null;
      const cs = cutc && cutKnown ? 100 * cutc[i] / md.cut.size : null;
      const dist = R != null ? Array.from({ length: R + 1 }, (_, k) => w.filter((x) => x === k).length) : null;
      return { i, name: md.decks[i], players: md.field[i], fs, avg: w.length ? w.reduce((a, b) => a + b, 0) / w.length : null, dist,
               best: w.length ? Math.max(...w) : null,
               dn: d2c ? d2c[i] : null, alive: alc ? alc[i] : null, ds, dconv: ds != null && fs ? ds / fs : null,
               cutn: cutc ? cutc[i] : null, cs, cconv: cs != null && fs ? cs / fs : null };
    });
    const convCls = (r, v) => (r.players < 15 || v == null ? "muted" : v >= 1.15 ? "good" : v <= 0.85 ? "bad" : "");
    const avgCls = (r) => (r.players < 15 || r.avg == null || fieldAvg == null ? "muted" : r.avg - fieldAvg >= 0.25 ? "good" : fieldAvg - r.avg >= 0.25 ? "bad" : "");
    const conv = (v) => (v == null ? "—" : v.toFixed(2) + "×");
    const distCell = (r) => {
      if (!r.dist) return "—";
      const n = r.dist.reduce((a, b) => a + b, 0) || 1, mx = Math.max(...r.dist, 1);
      return h("span", { class: "dist", "aria-label": "Day 1 wins distribution" }, r.dist.map((c, k) =>
        h("i", { style: `height:${Math.max(1, 22 * c / mx)}px`, class: k >= R - 1 ? "hi" : null, tip: `${slashName(r.name)}: ${k} win${k === 1 ? "" : "s"}\n${c} players · ${pct(100 * c / n)}` })));
    };
    const pending = (what) => h("span", { class: "muted" }, what);
    const recOf = (pts) => (pts % 3 ? `${pts} points` : `${pts / 3}–${D2.R1 - pts / 3}`);
    const d2Banner = D2 && D2.projected ? h("div", { class: "d2-banner" },
      h("div", null, h("b", null, num(D2.locked.size)), h("span", null, "locked into day 2")),
      D2.alive.size ? h("div", null, h("b", null, num(D2.alive.size)), h("span", null, "still alive")) : null,
      h("p", { class: "note" }, `Day 2 needs ${D2.T} match points after ${D2.R1} rounds (${recOf(D2.T)} or better). A player is counted the moment they reach it, since points can only go up; players who can no longer reach it, or who dropped, are out. ${D2.alive.size ? "Shares update as more players lock in." : "Day 1 is settled: these are the day 2 numbers until the roster is paired."}`)) : null;
    return h("div", { class: "section" },
      d2Banner,
      h("p", { class: "note" }, R != null
        ? `Day 1 wins count every player seated in round 1, through round ${R}, with byes as wins and drops keeping the wins they had. The field averages ${fieldAvg.toFixed(2)} wins. Conversion is a pairing's share of day 2 (or the top cut) divided by its share of the starting field: above 1× it is beating its numbers.`
        : "No day 1 round is complete yet."),
      h("div", { class: "panel" }, table("conv", [
        { key: "name", label: "Pairing", align: "l", cell: (r) => deckChip(r.name), sort: (r) => r.name },
        { key: "players", label: "Players", cell: (r) => num(r.players) },
        { key: "fs", label: "Field", cell: (r) => pct(r.fs) },
        { key: "avg", label: "Avg wins", cell: (r) => (r.avg == null ? "—" : r.avg.toFixed(2)), cls: avgCls, help: `Average day 1 wins per player${R != null ? `, out of ${R}` : ""}. Green is a quarter of a win or more above the field.` },
        { key: "dist", label: "Wins spread", sortable: false, cell: distCell, help: "How many of the pairing's players are on each number of wins, 0 on the left. Gold bars are the top two records." },
        { key: "best", label: "Best", cell: (r) => (r.best == null ? "—" : `${r.best}–${R - r.best}`), help: "Best day 1 record by a player of this pairing." },
        { key: "dn", label: D2 && D2.projected ? "Day 2 locked" : "Day 2", cell: (r) => (r.dn == null ? pending("—") : num(r.dn)),
          help: D2 && D2.projected ? `Players already on ${D2.T}+ points, so certain to make day 2.` : "Players of this pairing in the first round of day 2." },
        D2 && D2.projected && D2.alive.size ? { key: "alive", label: "Still alive", cell: (r) => (r.alive ? num(r.alive) : h("span", { class: "muted" }, "0")),
          help: `Players who can still reach ${D2.T} points with the rounds left.` } : null,
        { key: "ds", label: D2 && D2.projected ? "Share so far" : "Day 2 share", cell: (r) => pct(r.ds), help: "Share of the players locked into day 2." },
        { key: "dconv", label: "Day 2 conv.", cell: (r) => conv(r.dconv), cls: (r) => convCls(r, r.dconv) },
        { key: "cutn", label: "Top cut", cell: (r) => (r.cutn == null ? "—" : num(r.cutn)) },
        { key: "cconv", label: "Cut conv.", cell: (r) => conv(r.cconv), cls: (r) => convCls(r, r.cconv) },
      ], rows, { sortKey: "fs" })),
      !md.day2 && !D2 ? h("p", { class: "note" }, "Day 2 and top cut columns fill in once those rounds are paired.") : null,
      md.cut ? topCutPanel(md) : null);
  }
  function topCutPanel(md) {
    const rec = md.recordsThrough(99, 99);
    const list = [...md.cut].sort((a, b) => rec[b].w - rec[a].w);
    return h("div", { class: "panel section" }, h("h2", null, "Top cut"),
      h("ul", { class: "list" }, list.map((p) => h("li", null, h("span", null, md.data.players[p][0] || "Player"), deckChip(md.decks[md.deckOf[p]])))));
  }

  // ---- round by round
  function viewRounds(md, q) {
    const known = knownDecks(md).sort((a, b) => md.field[b] - md.field[a]);
    const topN = Number(q.top || 6);
    const shown = known.slice(0, topN);
    const seq = [];
    for (const ph of md.phases) for (const r of md.roundsIn(ph)) seq.push([ph, r]);
    const lab = ([ph, r]) => (ph === 1 ? `R${r}` : ph === 2 ? `D2 R${r}` : `Cut ${r}`);
    // share among players seated each round, and match win rate each round
    const share = [], wr = [];
    for (const [ph, r] of seq) {
      const set = md.playersIn(ph, r);
      const c = md.deckCount(set);
      const n = set.size - (md.unknown >= 0 ? c[md.unknown] : 0);
      share.push(shown.map((i) => (n ? 100 * c[i] / n : null)));
      const w = new Array(md.decks.length).fill(0), l = new Array(md.decks.length).fill(0);
      for (const m of md.M) {
        if (m[0] !== ph || m[1] !== r || m[3] < 0 || m[4] < 1 || m[4] > 2) continue;
        const a = md.deckOf[m[2]], b = md.deckOf[m[3]];
        if (a === b || a === md.unknown || b === md.unknown) continue;
        if (m[4] === 1) { w[a]++; l[b]++; } else { w[b]++; l[a]++; }
      }
      wr.push(shown.map((i) => ({ w: w[i], l: l[i] })));
    }
    const W = 900, H = 300, pad = { l: 40, r: 120, t: 12, b: 28 };
    const step = 5;
    const maxY = Math.ceil(Math.max(5, ...share.flat().filter((v) => v != null)) / step) * step;
    const x = (k) => pad.l + (seq.length < 2 ? 0 : k * (W - pad.l - pad.r) / (seq.length - 1));
    const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / maxY);
    const ticks = []; for (let v = 0; v <= maxY; v += step) ticks.push(v);
    // end labels: keep at least 13px apart
    const ends = shown.map((i, n) => { const row = share.map((r) => r[n]).filter((v) => v != null); return { n, y: row.length ? y(row[row.length - 1]) : 0 }; })
      .sort((a, b) => a.y - b.y);
    for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 13) ends[k].y = ends[k - 1].y + 13;
    const endY = new Map(ends.map((e) => [e.n, e.y]));
    const colors = shown.map((i) => {
      const inks = inksOf(md.decks[i]);
      return `var(--${inks[0] || "unknown"})`;
    });
    const dashes = shown.map((i, k) => (shown.slice(0, k).some((j) => inksOf(md.decks[j])[0] === inksOf(md.decks[i])[0]) ? "6 4" : null));
    const chart = s("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Share of players still in the event, by ink pairing and round" },
      ticks.map((t) => [s("line", { class: "grid", x1: pad.l, x2: W - pad.r, y1: y(t), y2: y(t) }), s("text", { x: pad.l - 6, y: y(t) + 4, "text-anchor": "end" }, t + "%")]),
      seq.map((r, k) => s("text", { x: x(k), y: H - 8, "text-anchor": "middle" }, seq.length > 12 && k % 2 ? "" : lab(r))),
      shown.map((i, n) => {
        const pts = share.map((row, k) => (row[n] == null ? null : [x(k), y(row[n])])).filter(Boolean);
        const last = pts[pts.length - 1];
        return [s("polyline", { points: pts.map((p) => p.join(",")).join(" "), fill: "none", stroke: colors[n], "stroke-width": 2.5, "stroke-dasharray": dashes[n] }),
          pts.map((p, k) => s("circle", { cx: p[0], cy: p[1], r: 4, fill: colors[n], tip: `${slashName(md.decks[i])}, ${lab(seq[k])}\n${pct(share[k][n])} of players seated` })),
          last ? s("text", { x: last[0] + 8, y: endY.get(n) + 4, style: "fill:var(--fg)" }, shortName(md.decks[i])) : null];
      }));
    const heatCell = (c) => {
      const n = c.w + c.l;
      if (n < 8) return h("td", { class: "muted" }, n ? `${c.w}–${c.l}` : "—");
      const v = 100 * c.w / n;
      return h("td", { class: tone(v, n, 8), tip: `${c.w}–${c.l}\n${pct(v)}` }, `${v.toFixed(0)}%`);
    };
    return h("div", { class: "section" },
      h("div", { class: "controls" }, seg("Pairings shown", [[4, "Top 4"], [6, "Top 6"], [8, "Top 8"]], topN, (v) => setQ({ top: String(v) }))),
      h("div", { class: "panel section" }, h("h2", null, "Who is still playing"),
        h("p", { class: "note" }, "Each pairing's share of the players seated in each round. A rising line means that pairing's players are dropping less than the field. Dashed lines share a first ink with a line above them."),
        seq.length ? chart : h("p", { class: "note" }, "No rounds yet.")),
      h("div", { class: "panel section" }, h("h2", null, "Match win rate by round"),
        h("p", { class: "note" }, "Late Swiss rounds pair players on the same record, so win rates drift toward 50% as the event goes on."),
        h("div", { class: "tscroll" }, h("table", { class: "data" },
          h("thead", null, h("tr", null, h("th", { class: "l" }, "Pairing"), seq.map((r) => h("th", null, lab(r))))),
          h("tbody", null, shown.map((i, n) => h("tr", null, h("td", { class: "l" }, deckChip(md.decks[i])), wr.map((row) => heatCell(row[n])))))))));
  }

  // ---- vs Duels
  function duelsQueue(D, which) {
    const keys = Object.keys(D.queues || {});
    const k = keys.find((x) => x.endsWith(which)) || keys[0];
    return D.queues[k];
  }
  function duelsRows(md, queue, tier) {
    const D = md.data.duels;
    const st = md.stats("all");
    const t = duelsQueue(D, queue)[tier];
    return knownDecks(md).filter((i) => md.field[i] > 0).map((i) => {
      const k = md.data.decks_key[i];
      const p = t.pairs[k];
      const ev = st[i];
      return { name: md.decks[i], share: fieldShare(md, i), play: p ? p.play_rate : null, duels: p ? p.win_rate : null, dgames: p ? p.games : 0,
               gwr: ev.gwr, g: ev.g, gci: ev.gci, eventN: ev.n, wr: ev.wr,
               delta: p && ev.gwr != null ? ev.gwr - p.win_rate : null,
               sdelta: p ? fieldShare(md, i) - p.play_rate : null,
               sig: p && ev.g ? (ev.gci[0] > p.win_rate ? 1 : ev.gci[1] < p.win_rate ? -1 : 0) : 0 };
    });
  }
  function viewDuels(md, q) {
    const D = md.data.duels;
    if (!D) return h("div", { class: "empty" }, "The online comparison for this event is not in yet. It is taken once the event's week begins.");
    const queue = q.queue || "bo3", tier = q.tier || "all";
    const rows = duelsRows(md, queue, tier);
    const t = duelsQueue(D, queue)[tier];
    const fmtDay = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    const usable = rows.filter((r) => r.duels != null && r.g >= 100).sort((a, b) => b.delta - a.delta);
    // diverging gap chart: event game WR minus Duels game WR, with the event's 95% range as a whisker
    const reach = Math.max(5, ...usable.flatMap((r) => [Math.abs(r.gci[0] - r.duels), Math.abs(r.gci[1] - r.duels)]));
    const span = Math.ceil(reach / 5) * 5;
    const X = (v) => 50 + 50 * Math.max(-span, Math.min(span, v)) / span;
    const ticks = []; for (let v = -span; v <= span; v += 5) ticks.push(v);
    const gapChart = h("div", { class: "gap", role: "img", "aria-label": "Game win rate at the event minus on Duels, by ink pairing" },
      h("div", { class: "gap-row gap-axis" }, h("span"),
        h("div", { class: "gap-track" }, ticks.map((v) => h("span", { class: v % 10 ? "tick minor" : "tick", style: `left:${X(v)}%` }, v === 0 ? "0" : signed(v, 0)))),
        h("span"), h("span", { class: "gap-vals" })),
      usable.map((r) => {
        const a = X(0), b = X(r.delta), lo = X(r.gci[0] - r.duels), hi = X(r.gci[1] - r.duels);
        const cls = r.delta >= 0 ? "pos" : "neg";
        return h("div", { class: "gap-row", tip: `${slashName(r.name)}\nEvent ${pct(r.gwr)} of ${num(r.g)} games (range ${r.gci[0].toFixed(0)}–${r.gci[1].toFixed(0)}%)\nDuels ${pct(r.duels)} of ${num(r.dgames)} games\n${r.sig ? "A real gap: Duels sits outside the event's range" : "Could be noise: Duels sits inside the event's range"}` },
          deckChip(r.name),
          h("div", { class: "gap-track" },
            ticks.map((v) => h("i", { class: v === 0 ? "zero" : "grid", style: `left:${X(v)}%` })),
            h("span", { class: "whisker", style: `left:${lo}%;width:${Math.max(0.5, hi - lo)}%` }),
            h("span", { class: `gbar ${cls}${r.sig ? "" : " soft"}`, style: `left:${Math.min(a, b)}%;width:${Math.abs(b - a)}%` })),
          h("b", { class: r.sig ? (r.delta >= 0 ? "good" : "bad") : "muted" }, signed(r.delta, 1)),
          h("span", { class: "gap-vals" }, `${pct(r.gwr)} vs ${pct(r.duels)}`));
      }));
    return h("div", { class: "section" },
      h("div", { class: "controls" },
        seg("Duels queue", [["bo3", "Best of 3"], ["bo1", "Best of 1"]], queue, (v) => setQ({ queue: v === "bo3" ? null : v })),
        seg("Duels players", [["all", "All ranks"], ["legendary", "Legendary+"]], tier, (v) => setQ({ tier: v === "all" ? null : v }))),
      h("p", { class: "note" }, `Compared with ${num(t.games)} Duels games from ${fmtDay(D.first_day)} to ${fmtDay(D.last_day)}, the two full weeks before the event's week. Both sides use game win rate.`),
      h("div", { class: "panel section" },
        h("div", { class: "split" }, h("h2", null, "Over- and underperformers"),
          h("div", { class: "legend" }, h("i", { class: "lg pos" }), h("span", null, "Better at the event"), h("i", { class: "lg neg" }), h("span", null, "Worse at the event"), h("i", { class: "lg soft" }), h("span", null, "Could be noise"))),
        h("p", { class: "note" }, "Points of game win rate at the event minus on Duels, for pairings with 100+ games at the event. The thin line is the event's 95% range: a pale bar means Duels falls inside it, so the gap could be chance."),
        usable.length ? gapChart : h("p", { class: "note" }, "Not enough games yet.")),
      h("div", { class: "panel" }, table("duels", [
        { key: "name", label: "Pairing", align: "l", cell: (r) => deckChip(r.name), sort: (r) => r.name },
        { key: "share", label: "Field", cell: (r) => pct(r.share) },
        { key: "play", label: "Duels play", cell: (r) => pct(r.play), help: "Share of Duels deck-games played with this pairing in the window." },
        { key: "sdelta", label: "Share gap", cell: (r) => signed(r.sdelta, 1, " pts"), help: "Field share minus Duels play rate: positive means more popular in paper than online." },
        { key: "gwr", label: "Event game WR", cell: (r) => pct(r.gwr) },
        { key: "duels", label: "Duels game WR", cell: (r) => pct(r.duels) },
        { key: "delta", label: "Gap", cell: (r) => signed(r.delta, 1, " pts"), cls: (r) => (r.g < 100 || r.delta == null ? "muted" : r.sig > 0 ? "good" : r.sig < 0 ? "bad" : "") },
        { key: "g", label: "Event games", cell: (r) => num(r.g) },
      ], rows, { sortKey: "share" })));
  }

  // ---- players
  function viewPlayers(md, q) {
    const rec = md.recordsThrough(99, 99);
    const term = (q.find || "").toLowerCase();
    const deckFilter = q.deck != null && q.deck !== "" ? Number(q.deck) : null;
    const everyone = md.data.players.map(([name, d], p) => ({ p, name: name || "Player", deck: md.decks[d], d, w: rec[p].w, l: rec[p].l, dr: rec[p].d,
      pts: 3 * rec[p].w + rec[p].d, played: rec[p].played, day2: md.d2 ? md.d2.status[p] : null, cut: md.cut ? md.cut.has(p) : null }))
      .filter((r) => r.played);
    // each pairing's average: wins per match played by all of its pilots; a pilot's edge is wins above that pace
    const agg = md.decks.map(() => ({ w: 0, n: 0, pilots: [] }));
    for (const r of everyone) { agg[r.d].w += r.w; agg[r.d].n += r.played; agg[r.d].pilots.push(r); }
    for (const a of agg) a.pilots.sort((x, y) => y.pts - x.pts || x.l - y.l);
    const maxPlayed = Math.max(0, ...everyone.map((r) => r.played));
    for (const r of everyone) {
      const a = agg[r.d];
      r.rate = a.n ? a.w / a.n : null;
      r.edge = r.rate != null && r.d !== md.unknown ? r.w - r.played * r.rate : null;
      r.rank = a.pilots.indexOf(r) + 1;
      r.of = a.pilots.length;
    }
    // one standout per pairing: its best pilot still in the event, ranked by wins above the pairing's pace
    const eligible = (r) => r.edge != null && r.of >= 8 && r.played >= Math.max(3, maxPlayed - 1);
    const standouts = [];
    for (const a of agg) {
      const live = a.pilots.filter(eligible);
      if (!live.length) continue;
      if (deckFilter != null) { if (live[0].d === deckFilter) standouts.push(...live.slice(0, 8)); continue; }
      const top = live[0];
      top.tied = live.filter((r) => r !== top && r.pts === top.pts).length;
      standouts.push(top);
    }
    standouts.sort((a, b) => b.edge - a.edge || b.pts - a.pts);
    standouts.splice(8);
    const starred = new Set(standouts.map((r) => r.p));
    let rows = everyone;
    if (term) rows = rows.filter((r) => r.name.toLowerCase().includes(term));
    if (deckFilter != null) rows = rows.filter((r) => r.d === deckFilter);
    rows.sort((a, b) => b.pts - a.pts || a.l - b.l || a.name.localeCompare(b.name));
    const shownRows = rows.slice(0, 200);
    const input = h("input", { class: "ctl", id: "player-find", type: "search", placeholder: "Search a player", value: q.find || "",
      onchange: (e) => setQ({ find: e.target.value || null }) });
    const deckSel = h("select", { class: "ctl", id: "player-deck", onchange: (e) => setQ({ deck: e.target.value || null }) },
      h("option", { value: "" }, "All pairings"), knownDecks(md).filter((i) => md.field[i]).map((i) => h("option", { value: String(i), selected: deckFilter === i ? true : null }, slashName(md.decks[i]))));
    return h("div", { class: "section" },
      h("div", { class: "controls" }, h("label", { class: "ctl-group" }, h("span", null, "Player"), input), h("label", { class: "ctl-group" }, h("span", null, "Pairing"), deckSel)),
      standouts.length ? h("div", { class: "panel section" },
        h("div", { class: "split" }, h("h2", null, "Standout pilots"), h("span", { class: "note" }, "Decklists worth looking up")),
        h("p", { class: "note" }, deckFilter == null
          ? "The best pilot of each pairing, ranked by wins above what that pairing's average player would have from the same number of matches. A strong record on a weak pairing ranks high. Players still in the event, on pairings with 8+ pilots."
          : "The best pilots of this pairing, by wins above its average player."),
        h("div", { class: "pilots" }, standouts.map((r) => h("div", { class: "pilot" },
          h("div", { class: "split" }, h("b", null, r.name), h("span", { class: "edge" }, signed(r.edge, 1), h("small", null, " wins"))),
          deckChip(r.deck),
          h("div", { class: "pilot-meta" },
            h("span", null, h("b", null, `${r.w}–${r.l}${r.dr ? "–" + r.dr : ""}`), " record"),
            h("span", null, h("b", null, `#${r.rank}`), ` of ${num(r.of)} on the pairing`, r.tied ? `, ${r.tied} more on the same record` : ""),
            h("span", null, "pairing wins ", h("b", null, pct(100 * r.rate, 0)), " of matches")))))) : null,
      h("p", { class: "note" }, `Records from every reported match, byes counted as wins. ★ marks a standout pilot. Showing ${num(shownRows.length)} of ${num(rows.length)}; search to find anyone else. Names are as shown on the public event page.`),
      h("div", { class: "panel" }, table("players", [
        { key: "rank", label: "#", sortable: false, cell: (r) => String(shownRows.indexOf(r) + 1) },
        { key: "name", label: "Player", align: "l", sortable: false, cell: (r) => h("span", null, starred.has(r.p) ? h("span", { class: "star", "aria-label": "Standout pilot" }, "★ ") : null, playerLink(md, r.p)) },
        { key: "deck", label: "Pairing", align: "l", sortable: false, cell: (r) => deckChip(r.deck) },
        { key: "rec", label: "W–L–D", sortable: false, cell: (r) => `${r.w}–${r.l}–${r.dr}` },
        { key: "pts", label: "Points", sortable: false },
        { key: "edge", label: "vs pairing", sortable: false, cell: (r) => (r.edge == null ? "—" : signed(r.edge, 1)), cls: (r) => (r.edge == null ? "muted" : r.edge >= 1.5 ? "good" : r.edge <= -1.5 ? "bad" : ""), help: "Wins above (or below) what this pairing's average player would have from the same number of matches." },
        { key: "prank", label: "On pairing", sortable: false, cell: (r) => (r.d === md.unknown ? "—" : `#${r.rank} of ${num(r.of)}`) },
        { key: "day2", label: "Day 2", sortable: false, help: md.d2 && md.d2.projected ? `Locked: already on ${md.d2.T}+ points. Alive: can still get there.` : null,
          cell: (r) => (r.day2 == null ? "—" : r.day2 === "in" ? h("span", { class: "tag in" }, md.d2.projected ? "Locked" : "Yes") : r.day2 === "alive" ? h("span", { class: "tag alive" }, "Alive") : "") },
        { key: "cut", label: "Top cut", sortable: false, cell: (r) => (r.cut == null ? "—" : r.cut ? "Yes" : "") },
      ], shownRows)));
  }

  // ---- one player's run
  const playerName = (md, p) => md.data.players[p][0] || "Player";
  const playerLink = (md, p) => h("a", { class: "plink", href: `#/e/${md.meta.slug}/run?p=${p}` }, playerName(md, p));
  const roundLabel = (ph, r) => (ph === 1 ? `Round ${r}` : ph === 2 ? `Day 2 · R${r}` : `Top cut · R${r}`);
  function viewRun(md, q) {
    const rec = md.recordsThrough(99, 99);
    const p = q.p != null && q.p !== "" ? Number(q.p) : null;
    const seen = md.data.players.map((x, i) => i).filter((i) => rec[i].played);
    const list = h("datalist", { id: "run-names" }, seen.map((i) => h("option", { value: playerName(md, i) })));
    const pick = (name) => {
      const lower = name.trim().toLowerCase();
      const hit = seen.find((i) => playerName(md, i).toLowerCase() === lower) ?? seen.find((i) => playerName(md, i).toLowerCase().includes(lower));
      if (hit != null) setQ({ p: String(hit) });
    };
    const search = h("div", { class: "controls" }, h("label", { class: "ctl-group run-find" }, h("span", null, "Find a player"),
      h("input", { class: "ctl", type: "search", list: "run-names", placeholder: "Type a name", value: p != null ? playerName(md, p) : "",
        onchange: (e) => pick(e.target.value), onkeydown: (e) => { if (e.key === "Enter") pick(e.target.value); } })), list);
    if (p == null || !md.data.players[p]) {
      return h("div", { class: "section" }, search,
        h("p", { class: "note" }, "Pick a player to see every match they played: who they faced, the opponent's ink pairing and record, the result and the games. Player names on the Players tab open here too."));
    }
    const d = md.deckOf[p];
    const r = rec[p];
    const matches = md.M.filter((m) => m[2] === p || m[3] === p).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let w = 0, l = 0, dr = 0;
    const rows = matches.map((m) => {
      const me = m[2] === p, opp = me ? m[3] : m[2];
      let res, cls, games = "";
      if (m[4] === 3) { res = "Bye"; cls = "good"; w++; }
      else if (m[4] === -1) { res = "In progress"; cls = "muted"; }
      else if (m[4] === 0) { res = "Draw"; cls = "muted"; dr++; }
      else {
        const won = (m[4] === 1) === me;
        res = won ? "Win" : "Loss"; cls = won ? "good" : "bad";
        if (won) w++; else l++;
        games = won ? `${m[5]}–${m[6]}` : `${m[6]}–${m[5]}`;
      }
      return { m, opp, res, cls, games, after: m[4] === -1 ? "" : `${w}–${l}${dr ? "–" + dr : ""}` };
    });
    const status = md.d2 ? md.d2.status[p] : null;
    const kpi = (v, label) => h("div", { class: "kpi" }, h("b", null, v), h("span", null, label));
    const oppWins = rows.filter((x) => x.opp >= 0).map((x) => rec[x.opp]);
    const omw = oppWins.length ? 100 * oppWins.reduce((a, o) => a + (o.played ? Math.max(1 / 3, o.w / o.played) : 0), 0) / oppWins.length : null;
    return h("div", { class: "section" }, search,
      h("section", { class: "panel run-head" },
        h("div", null, h("h2", null, playerName(md, p)), deckChip(md.decks[d])),
        h("div", { class: "kpis" },
          kpi(`${r.w}–${r.l}${r.d ? "–" + r.d : ""}`, "Record"), kpi(String(3 * r.w + r.d), "Points"),
          omw != null ? kpi(pct(omw, 0), "Opponents' win %") : null,
          status ? kpi(status === "in" ? (md.d2.projected ? "Locked" : "Yes") : status === "alive" ? "Alive" : "No", "Day 2") : null,
          md.cut ? kpi(md.cut.has(p) ? "Yes" : "No", "Top cut") : null)),
      h("div", { class: "panel" }, table("run", [
        { key: "round", label: "Round", align: "l", sortable: false, cell: (x) => roundLabel(x.m[0], x.m[1]) },
        { key: "opp", label: "Opponent", align: "l", sortable: false, cell: (x) => (x.opp < 0 ? h("span", { class: "muted" }, "—") : playerLink(md, x.opp)) },
        { key: "odeck", label: "Their pairing", align: "l", sortable: false, cell: (x) => (x.opp < 0 ? "" : deckChip(md.decks[md.deckOf[x.opp]])) },
        { key: "orec", label: "Their record", sortable: false, cell: (x) => (x.opp < 0 ? "" : `${rec[x.opp].w}–${rec[x.opp].l}${rec[x.opp].d ? "–" + rec[x.opp].d : ""}`) },
        { key: "res", label: "Result", sortable: false, cell: (x) => h("span", { class: `res ${x.cls}` }, x.res) },
        { key: "games", label: "Games", sortable: false, cell: (x) => x.games },
        { key: "after", label: "Record after", sortable: false, cell: (x) => x.after },
      ], rows)),
      h("p", { class: "note" }, "Their record is the opponent's whole event so far. Opponents' win % uses the usual one-third floor for each opponent."));
  }

  // ------------------------------------------------------------ render
  async function render() {
    tip.hidden = true;
    const r = route();
    clearInterval(refreshTimer);
    for (const a of document.querySelectorAll("[data-nav]")) a.setAttribute("aria-current", a.dataset.nav === r.view ? "page" : "false");
    try {
      await loadIndex();
      if (r.view === "home") { document.title = "Lorcana Meta"; app.replaceChildren(viewHome()); return; }
      if (r.view === "about") { document.title = "About · Lorcana Meta"; app.replaceChildren(viewAbout()); return; }
      const entry = index.events.find((e) => e.slug === r.slug);
      if (!entry) { app.replaceChildren(h("div", { class: "empty" }, "That event is not on Lorcana Meta. ", h("a", { href: "#/" }, "See all events"))); return; }
      if (!cache.has(r.slug)) app.replaceChildren(h("div", { class: "empty" }, "Loading event…"));
      const md = await loadEvent(r.slug);
      document.title = `${md.meta.name} · Lorcana Meta`;
      const views = { overview: viewOverview, matchups: viewMatchups, conversion: viewConversion, rounds: viewRounds, duels: viewDuels, players: viewPlayers, run: viewRun };
      const view = views[r.tab] || viewOverview;
      const scroll = window.scrollY;
      app.replaceChildren(eventHeader(md, r.tab), md.M.length ? view(md, r.q) : h("div", { class: "empty" }, "No pairings yet. This page fills in once round 1 is paired."));
      window.scrollTo(0, scroll);
      if (md.meta.live) refreshTimer = setInterval(async () => {
        try { await loadIndex(true); await loadEvent(r.slug, true); render(); } catch (e) { /* keep the last data */ }
      }, 120000);
    } catch (e) {
      app.replaceChildren(h("div", { class: "empty" }, "Could not load the data. Refresh the page to try again."));
      console.error(e);
    }
  }
  window.addEventListener("hashchange", render);
  render();
})();
