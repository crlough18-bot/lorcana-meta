/* Lorcana Meta: client-side analysis of one event's match data.
   Data: data/index.json (event list) and data/events/<slug>.json
   (players [name, deckIdx], matches [phase, round, p1, p2, result, gamesW, gamesL],
   result 1 = p1 won, 2 = p2 won, 0 = draw, -1 = unreported, 3 = bye). */
(() => {
  "use strict";

  const INKS = ["amber", "amethyst", "emerald", "ruby", "sapphire", "steel"];
  const TABS = [
    ["overview", "Overview"], ["winrates", "Win rates"], ["matchups", "Matchups"], ["conversion", "Conversion"],
    ["rounds", "Round by round"], ["duels", "vs Duels"], ["players", "Players"],
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
    if (parts[0] === "e" && parts[1]) return { view: "event", slug: parts[1], tab: parts[2] || "overview", q };
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

    const reported = M.filter((m) => m[4] !== -1).length;
    return { data, meta: data.meta, decks, unknown, P, deckOf, M, phases, roundsIn, roundDone, field, fieldN, fieldKnown,
             stats, recordsThrough, playersIn, deckCount, lastP1, day2, cut, cutPhase, reported };
  }

  // decks shown: known decks ordered by field share
  const knownDecks = (md) => md.decks.map((n, i) => i).filter((i) => i !== md.unknown);
  const fieldShare = (md, i) => (md.fieldKnown ? 100 * md.field[i] / md.fieldN : 0);

  // ------------------------------------------------------------ generic sortable table
  function table(id, cols, rows, opts = {}) {
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
  function viewHome() {
    const live = index.events.filter((e) => e.live);
    return h("div", { class: "section" },
      h("section", { class: "hero" },
        h("h1", null, "The Lorcana tournament meta, from every match played"),
        h("p", null, "Ink pairing share, win rates, matchups and conversion for big Disney Lorcana events, built from every pairing and result the event reports, not just the top decklists. Updated every few minutes while an event runs, and compared with the online meta from the same weeks.")),
      live.length ? h("p", null, h("span", { class: "badge live" }, "Live"), " ", live.map((e) => h("a", { href: `#/e/${e.slug}/overview` }, e.name))) : null,
      h("h2", null, "Events"),
      index.events.length ? h("div", { class: "cards" }, index.events.map(eventCard)) : h("div", { class: "empty" }, "No events yet."),
      h("p", { class: "note" }, "Ink pairings became public on the Ravensburger Play network with DLC London in November 2026, so events before it cannot be covered. New big events with public pairings are picked up automatically."));
  }
  function eventCard(e) {
    return h("a", { class: "card", href: `#/e/${e.slug}/overview` },
      h("div", { class: "split" }, h("span", { class: "when" }, dateRange(e.start, e.end)),
        e.live ? h("span", { class: "badge live" }, "Live") : e.final ? h("span", { class: "badge" }, "Final") : h("span", { class: "badge" }, e.display_status === "upcoming" ? "Upcoming" : "In progress")),
      h("h3", null, e.name),
      h("div", { class: "stats" },
        h("span", null, `${num(e.players)} players`), h("span", null, e.format || ""),
        e.rounds_done ? h("span", null, `${e.rounds_done} rounds done`) : null),
      e.top_deck ? h("div", null, h("span", { class: "muted" }, "Most played "), deckChip(e.top_deck)) : null);
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
    const status = m.live ? h("span", { class: "badge live" }, "Live") : m.final ? h("span", { class: "badge" }, "Final") : h("span", { class: "badge" }, m.display_status === "upcoming" ? "Upcoming" : "In progress");
    return h("div", { class: "ev-head" },
      status,
      h("h1", null, m.name),
      h("div", { class: "ev-sub" },
        h("span", null, dateRange(m.start, m.end)), m.venue ? h("span", null, m.venue) : null, h("span", null, m.format || ""),
        h("span", null, `Updated ${ago(m.fetched_at || m.built_at)}`),
        h("a", { href: m.url, rel: "noopener" }, "Official page")),
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
    const st = md.stats("all");
    const known = knownDecks(md);
    const big = known.filter((i) => st[i].n >= 150).sort((a, b) => st[b].wr - st[a].wr);
    const top = known.slice().sort((a, b) => md.field[b] - md.field[a]);
    const kpi = (v, l) => h("div", { class: "kpi" }, h("b", null, v), h("span", null, l));
    const doneRounds = (md.meta.rounds || []).filter((r) => r.status === "COMPLETE").length;
    const takeaway = [];
    if (top.length) takeaway.push(h("span", null, h("b", null, slashName(md.decks[top[0]])), ` is the most played pairing at ${pct(fieldShare(md, top[0]))} of the field.`));
    if (big.length) takeaway.push(h("span", null, " Among pairings with 150+ matches, ", h("b", null, slashName(md.decks[big[0]])), ` has the best match win rate at ${pct(st[big[0]].wr)}`, big.length > 1 ? h("span", null, " and ", h("b", null, slashName(md.decks[big[big.length - 1]])), ` the weakest at ${pct(st[big[big.length - 1]].wr)}.`) : "."));
    const maxShare = Math.max(...top.map((i) => fieldShare(md, i)), 1);
    return h("div", { class: "section" },
      h("div", { class: "kpis" },
        kpi(num(md.fieldN), "Players"), kpi(String(known.filter((i) => md.field[i] > 0).length), "Ink pairings"),
        kpi(String(doneRounds), "Rounds complete"), kpi(num(md.reported), "Matches reported"),
        md.unknown >= 0 && md.field[md.unknown] ? kpi(num(md.field[md.unknown]), "No deck registered") : null),
      takeaway.length ? h("p", { class: "takeaway" }, takeaway) : null,
      h("div", { class: "grid-2" },
        h("div", { class: "panel section" }, h("h2", null, "Field share"),
          h("p", { class: "note" }, "Share of all players seated in round 1."),
          table("ov-share", [
            { key: "name", label: "Pairing", align: "l", cell: (r) => deckChip(r.name), sortable: false },
            { key: "players", label: "Players", sortable: false },
            { key: "share", label: "Share", cell: (r) => pct(r.share), sortable: false },
            { key: "bar", label: "", sortable: false, cell: (r) => h("span", { class: "bar", style: `width:${Math.max(2, 72 * r.share / maxShare)}px`, tip: `${slashName(r.name)}\n${r.players} players · ${pct(r.share)}` }) },
          ], top.filter((i) => md.field[i] > 0).map((i) => ({ name: md.decks[i], players: md.field[i], share: fieldShare(md, i) })))),
        h("div", { class: "panel section" }, h("h2", null, "Match win rate, biggest pairings"),
          h("p", { class: "note" }, "Pairings with 150+ non-mirror matches. The range is a 95% interval."),
          big.length ? table("ov-wr", [
            { key: "name", label: "Pairing", align: "l", cell: (r) => deckChip(r.name), sortable: false },
            { key: "n", label: "Matches", cell: (r) => num(r.n), sortable: false },
            { key: "wr", label: "Win rate", cell: (r) => pct(r.wr), cls: (r) => tone(r.wr, r.n), sortable: false },
            { key: "ci", label: "Range", cell: (r) => h("span", { class: "ci" }, `${r.ci[0].toFixed(0)}–${r.ci[1].toFixed(0)}%`), sortable: false },
          ], big.map((i) => st[i])) : h("p", { class: "note" }, "Not enough results yet."))),
      md.cut ? topCutPanel(md) : null,
      duelsTeaser(md));
  }
  function topCutPanel(md) {
    const rec = md.recordsThrough(99, 99);
    const list = [...md.cut].sort((a, b) => rec[b].w - rec[a].w);
    return h("div", { class: "panel section" }, h("h2", null, "Top cut"),
      h("ul", { class: "list" }, list.map((p) => h("li", null, h("span", null, md.data.players[p][0] || "Player"), deckChip(md.decks[md.deckOf[p]])))));
  }
  function duelsTeaser(md) {
    if (!md.data.duels) return null;
    const rows = duelsRows(md, "bo3", "all").filter((r) => r.eventN >= 150 && r.duels != null).sort((a, b) => b.delta - a.delta);
    if (!rows.length) return null;
    const best = rows[0], worst = rows[rows.length - 1];
    return h("div", { class: "panel section" }, h("h2", null, "Against the online meta"),
      h("p", null, h("b", null, slashName(best.name)), ` won ${Math.abs(best.delta).toFixed(1)} points ${best.delta >= 0 ? "more" : "less"} of its games here than on Duels in the two weeks before, the biggest gain; `,
        h("b", null, slashName(worst.name)), ` won ${Math.abs(worst.delta).toFixed(1)} points ${worst.delta >= 0 ? "more" : "fewer"}, the biggest drop. `,
        h("a", { href: `#/e/${md.meta.slug}/duels` }, "See every pairing")));
  }

  // ---- win rates
  function viewWinrates(md, q) {
    const scope = q.scope || "all", min = Number(q.min ?? 50);
    const st = md.stats(scope);
    const rows = knownDecks(md).map((i) => Object.assign({}, st[i], { share: fieldShare(md, i), players: md.field[i] })).filter((r) => r.n + r.mir + r.d > 0);
    return h("div", { class: "section" },
      h("div", { class: "controls" }, scopeControl(md, q), minControl(q, 50)),
      h("p", { class: "note" }, "Match win rate leaves out mirrors, byes, draws, unreported matches and players with no registered deck. Click a column to sort; hover a header for its definition."),
      h("div", { class: "panel" }, table("wr", [
        { key: "name", label: "Pairing", align: "l", cell: (r) => deckChip(r.name), sort: (r) => r.name },
        { key: "players", label: "Players", cell: (r) => num(r.players) },
        { key: "share", label: "Field", cell: (r) => pct(r.share), help: "Share of all players seated in round 1." },
        { key: "n", label: "Matches", cell: (r) => num(r.n), help: "Non-mirror matches with a result." },
        { key: "wr", label: "Match WR", cell: (r) => pct(r.wr), cls: (r) => tone(r.wr, r.n, min || 50) },
        { key: "lo", label: "95% range", sort: (r) => r.ci[0], cell: (r) => h("span", { class: "ci" }, r.n ? `${r.ci[0].toFixed(0)}–${r.ci[1].toFixed(0)}` : "—"), help: "If two ranges overlap a lot, the difference may be noise." },
        { key: "gwr", label: "Game WR", cell: (r) => pct(r.gwr) },
        { key: "w", label: "W–L–D", sort: (r) => r.w, cell: (r) => `${r.w}–${r.l}–${r.d}` },
        { key: "mir", label: "Mirrors", cell: (r) => num(r.mir) },
      ], rows, { sortKey: "share", rowClass: (r) => (r.n < min ? "dim" : null) })));
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
    const head = h("tr", null, h("th"), order.map((j) => h("th", { tip: slashName(md.decks[j]) }, shortName(md.decks[j]))));
    const body = order.map((i) => h("tr", null, h("th", { class: "row", tip: slashName(md.decks[i]) }, shortName(md.decks[i])),
      order.map((j) => {
        if (i === j) return h("td", { class: "self" }, `mirror ${st[i].mir}`);
        const x = mu.get(i + ":" + j);
        if (!x) return h("td", { class: "self" }, "—");
        const n = x.w + x.l, wr = 100 * x.w / n, ci = wilson(x.w, n);
        const isSel = sel && sel[0] === i && sel[1] === j;
        return h("td", {
          class: isSel ? "sel" : null, style: color(wr) + (n < minG ? ";opacity:.45" : ""),
          tip: `${slashName(md.decks[i])} vs ${slashName(md.decks[j])}\n${x.w}–${x.l} in matches (${pct(wr)})\nGames ${x.gw}–${x.gl}\n95% range ${ci[0].toFixed(0)}–${ci[1].toFixed(0)}%`,
          onclick: () => setQ({ cell: `${i}:${j}` }),
        }, `${wr.toFixed(0)}%`, h("span", { class: "n" }, n));
      })));
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
  function viewConversion(md, q) {
    const L = Number(q.losses ?? 1);
    const known = knownDecks(md);
    const rows = [];
    let bracket = null, bracketN = 0, label = "";
    if (md.lastP1 != null) {
      const rec = md.recordsThrough(1, md.lastP1);
      bracket = new Set();
      for (let p = 0; p < md.P; p++) if (rec[p].played && rec[p].l <= L) bracket.add(p);
      bracketN = bracket.size;
      label = `${md.lastP1 - L}–${L} or better after round ${md.lastP1}`;
    }
    const bc = bracket ? md.deckCount(bracket) : null;
    const d2c = md.day2 ? md.deckCount(md.day2) : null;
    const cutc = md.cut ? md.deckCount(md.cut) : null;
    const share = (c, n, i) => (c && n ? 100 * c[i] / n : null);
    for (const i of known) {
      if (!md.field[i]) continue;
      const fs = fieldShare(md, i);
      const bs = share(bc, bracketN, i), ds = share(d2c, md.day2 && md.day2.size, i);
      rows.push({ name: md.decks[i], players: md.field[i], fs, bs, bconv: bs != null && fs ? bs / fs : null, bn: bc ? bc[i] : null,
                  ds, dconv: ds != null && fs ? ds / fs : null, dn: d2c ? d2c[i] : null, cutn: cutc ? cutc[i] : null });
    }
    const convCls = (r, v) => (r.players < 15 || v == null ? "muted" : v >= 1.15 ? "good" : v <= 0.85 ? "bad" : "");
    return h("div", { class: "section" },
      h("div", { class: "controls" }, seg("Day 1 bracket", [[0, "Undefeated"], [1, "At most 1 loss"], [2, "At most 2 losses"]], L, (v) => setQ({ losses: String(v) }))),
      h("p", { class: "note" }, md.lastP1 != null ? `Bracket: players ${label} (${num(bracketN)} players). Conversion is a pairing's share of a group divided by its share of the starting field, so above 1 means it is overperforming its numbers.` : "No day 1 round is complete yet."),
      h("div", { class: "panel" }, table("conv", [
        { key: "name", label: "Pairing", align: "l", cell: (r) => deckChip(r.name), sort: (r) => r.name },
        { key: "fs", label: "Field", cell: (r) => pct(r.fs) },
        { key: "bn", label: "In bracket", cell: (r) => num(r.bn) },
        { key: "bs", label: "Bracket share", cell: (r) => pct(r.bs) },
        { key: "bconv", label: "Conversion", cell: (r) => (r.bconv == null ? "—" : r.bconv.toFixed(2)), cls: (r) => convCls(r, r.bconv) },
        { key: "dn", label: "Day 2", cell: (r) => (r.dn == null ? "—" : num(r.dn)), help: "Players of this pairing in the first round of day 2." },
        { key: "ds", label: "Day 2 share", cell: (r) => pct(r.ds) },
        { key: "dconv", label: "Day 2 conv.", cell: (r) => (r.dconv == null ? "—" : r.dconv.toFixed(2)), cls: (r) => convCls(r, r.dconv) },
        { key: "cutn", label: "Top cut", cell: (r) => (r.cutn == null ? "—" : num(r.cutn)) },
      ], rows, { sortKey: "fs" })));
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
    const usable = rows.filter((r) => r.duels != null && r.g >= 100);
    const over = usable.filter((r) => r.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 5);
    const under = usable.filter((r) => r.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 5);
    // scatter: x = Duels game WR, y = event game WR
    const W = 640, H = 420, pad = 44;
    const vals = usable.flatMap((r) => [r.duels, r.gwr]);
    const lo = Math.floor(Math.min(40, ...vals) / 5) * 5, hi = Math.ceil(Math.max(60, ...vals) / 5) * 5;
    const sx = (v) => pad + (v - lo) / (hi - lo) * (W - 2 * pad), sy = (v) => H - pad - (v - lo) / (hi - lo) * (H - 2 * pad);
    const maxShare = Math.max(...usable.map((r) => r.share), 1);
    const ticks = []; for (let v = lo; v <= hi; v += 5) ticks.push(v);
    const scatter = s("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Event game win rate against Duels game win rate by ink pairing" },
      ticks.map((v) => [s("line", { class: "grid", x1: sx(v), x2: sx(v), y1: pad, y2: H - pad }), s("line", { class: "grid", x1: pad, x2: W - pad, y1: sy(v), y2: sy(v) }),
        s("text", { x: sx(v), y: H - pad + 16, "text-anchor": "middle" }, v + "%"), s("text", { x: pad - 6, y: sy(v) + 4, "text-anchor": "end" }, v + "%")]),
      s("line", { class: "ref", x1: sx(lo), y1: sy(lo), x2: sx(hi), y2: sy(hi) }),
      s("text", { x: W - pad, y: H - 6, "text-anchor": "end" }, "Duels game win rate →"),
      s("text", { x: 4, y: pad - 14 }, "↑ Event game win rate"),
      s("text", { x: sx(lo) + 8, y: sy(hi) + 4 }, "above the line: better here than online"),
      usable.map((r) => {
        const inks = inksOf(r.name);
        const rad = 5 + 14 * Math.sqrt(r.share / maxShare);
        return [s("circle", { cx: sx(r.duels), cy: sy(r.gwr), r: rad, fill: `var(--${inks[0] || "unknown"})`, "fill-opacity": 0.75, stroke: `var(--${inks[1] || inks[0] || "unknown"})`, "stroke-width": 3,
          tip: `${slashName(r.name)}\nEvent ${pct(r.gwr)} of ${num(r.g)} games\nDuels ${pct(r.duels)} of ${num(r.dgames)} games\nField ${pct(r.share)} · Duels play ${pct(r.play)}` }),
          r.share >= 4 || Math.abs(r.delta) >= 4 ? s("text", { x: sx(r.duels) + rad + 3, y: sy(r.gwr) + 4, style: "fill:var(--fg)" }, shortName(r.name)) : null];
      }));
    const perfList = (list, sign) => list.length ? h("ul", { class: "list" }, list.map((r) => h("li", null, deckChip(r.name),
      h("span", { class: sign > 0 ? "good" : "bad", tip: `${slashName(r.name)}\nEvent ${pct(r.gwr)} (range ${r.gci[0].toFixed(0)}–${r.gci[1].toFixed(0)}%)\nDuels ${pct(r.duels)}${r.sig ? "\nOutside the event's 95% range" : "\nWithin the event's 95% range: could be noise"}` },
        signed(r.delta, 1, " pts"), r.sig ? "" : " ?")))) : h("p", { class: "note" }, "None with 100+ games.");
    return h("div", { class: "section" },
      h("div", { class: "controls" },
        seg("Duels queue", [["bo3", "Best of 3"], ["bo1", "Best of 1"]], queue, (v) => setQ({ queue: v === "bo3" ? null : v })),
        seg("Duels players", [["all", "All ranks"], ["legendary", "Legendary+"]], tier, (v) => setQ({ tier: v === "all" ? null : v }))),
      h("p", { class: "note" }, `Compared with ${num(t.games)} Duels games from ${fmtDay(D.first_day)} to ${fmtDay(D.last_day)}, the two full weeks before the event's week. Both sides use game win rate. A "?" means the gap sits inside the event's own 95% range, so it could be noise.`),
      h("div", { class: "grid-2" },
        h("div", { class: "panel section" }, h("h2", null, "Overperformers"), h("p", { class: "note" }, "Won more games here than online."), perfList(over, 1)),
        h("div", { class: "panel section" }, h("h2", null, "Underperformers"), h("p", { class: "note" }, "Won fewer games here than online."), perfList(under, -1))),
      h("div", { class: "panel section" }, h("h2", null, "Event against online, every pairing"),
        h("p", { class: "note" }, "Dot size is field share; each dot is filled with its first ink and ringed with its second. The dashed line is equal performance."), scatter),
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
    let rows = md.data.players.map(([name, d], p) => ({ p, name: name || "Player", deck: md.decks[d], d, w: rec[p].w, l: rec[p].l, dr: rec[p].d,
      pts: 3 * rec[p].w + rec[p].d, played: rec[p].played, day2: md.day2 ? md.day2.has(p) : null, cut: md.cut ? md.cut.has(p) : null }))
      .filter((r) => r.played);
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
      h("p", { class: "note" }, `Records from every reported match, byes counted as wins. Showing ${num(shownRows.length)} of ${num(rows.length)}; search to find anyone else. Names are as shown on the public event page.`),
      h("div", { class: "panel" }, table("players", [
        { key: "rank", label: "#", sortable: false, cell: (r) => String(shownRows.indexOf(r) + 1) },
        { key: "name", label: "Player", align: "l", sortable: false },
        { key: "deck", label: "Pairing", align: "l", sortable: false, cell: (r) => deckChip(r.deck) },
        { key: "rec", label: "W–L–D", sortable: false, cell: (r) => `${r.w}–${r.l}–${r.dr}` },
        { key: "pts", label: "Points", sortable: false },
        { key: "day2", label: "Day 2", sortable: false, cell: (r) => (r.day2 == null ? "—" : r.day2 ? "Yes" : "") },
        { key: "cut", label: "Top cut", sortable: false, cell: (r) => (r.cut == null ? "—" : r.cut ? "Yes" : "") },
      ], shownRows)));
  }

  // ------------------------------------------------------------ render
  async function render() {
    tip.hidden = true;
    const r = route();
    clearInterval(refreshTimer);
    try {
      await loadIndex();
      if (r.view === "home") { document.title = "Lorcana Meta"; app.replaceChildren(viewHome()); return; }
      if (r.view === "about") { document.title = "About · Lorcana Meta"; app.replaceChildren(viewAbout()); return; }
      const entry = index.events.find((e) => e.slug === r.slug);
      if (!entry) { app.replaceChildren(h("div", { class: "empty" }, "That event is not on Lorcana Meta. ", h("a", { href: "#/" }, "See all events"))); return; }
      if (!cache.has(r.slug)) app.replaceChildren(h("div", { class: "empty" }, "Loading event…"));
      const md = await loadEvent(r.slug);
      document.title = `${md.meta.name} · Lorcana Meta`;
      const views = { overview: viewOverview, winrates: viewWinrates, matchups: viewMatchups, conversion: viewConversion, rounds: viewRounds, duels: viewDuels, players: viewPlayers };
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
