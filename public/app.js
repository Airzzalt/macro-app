/* Macro — app logic */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const r0 = (n) => Math.round(+n || 0);
const r1 = (n) => Math.round((+n || 0) * 10) / 10;

function localISO(d = new Date()) {
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}
function addDays(iso, n) { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return localISO(d); }
function prettyDate(iso) {
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" });
}

const state = {
  user: null, profile: null,
  date: localISO(),
  view: "today",
  wdays: 30,
};

/* ---------- api ---------- */
async function api(path, opts = {}) {
  const r = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try { data = await r.json(); } catch {}
  if (r.status === 401 && !path.startsWith("/api/auth")) { showAuth(); throw new Error("Signed out"); }
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

/* ---------- haptics (Android; iOS ignores silently) ---------- */
function buzz(ms = 8) { try { navigator.vibrate?.(ms); } catch {} }

/* ---------- toast ---------- */
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}

/* ---------- sheets ---------- */
let sheetZ = 50;
function openSheet(build) {
  const bd = document.createElement("div");
  bd.className = "sheet-backdrop";
  bd.style.zIndex = ++sheetZ;
  const sh = document.createElement("div");
  sh.className = "sheet";
  sh.style.zIndex = ++sheetZ;
  sh.innerHTML = `<div class="grab"></div><div class="sheet-body"></div>`;
  const body = $(".sheet-body", sh);
  document.body.append(bd, sh);
  const close = () => {
    bd.classList.remove("show"); sh.classList.remove("show"); sh.classList.remove("dragging"); sh.style.transform = "";
    setTimeout(() => { bd.remove(); sh.remove(); }, 430);
  };
  bd.addEventListener("click", close);
  // drag-to-dismiss from the top of the sheet (grab handle / when the body is scrolled to top)
  let startY = 0, dy = 0, dragging = false;
  sh.addEventListener("touchstart", (e) => {
    if (body.scrollTop > 0 && e.target !== sh.firstElementChild) return;
    startY = e.touches[0].clientY; dy = 0; dragging = true; sh.classList.add("dragging");
  }, { passive: true });
  sh.addEventListener("touchmove", (e) => {
    if (!dragging) return;
    dy = Math.max(0, e.touches[0].clientY - startY);
    if (dy > 0) sh.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  sh.addEventListener("touchend", () => {
    if (!dragging) return;
    dragging = false; sh.classList.remove("dragging");
    if (dy > 90) { buzz(); close(); } else sh.style.transform = "";
  });
  build(body, close);
  requestAnimationFrame(() => { bd.classList.add("show"); sh.classList.add("show"); });
  return close;
}

/* ---------- views ---------- */
const VIEWS = ["auth", "onboarding", "today", "history", "weight", "settings"];
function show(view) {
  state.view = view;
  VIEWS.forEach((v) => $(`#view-${v}`).classList.toggle("hidden", v !== view));
  const appViews = ["today", "history", "weight", "settings"];
  $("#tabbar").classList.toggle("hidden", !appViews.includes(view));
  $$("#tabbar .tab").forEach((t) => t.classList.toggle("on", t.dataset.view === view));
  const el = $(`#view-${view}`);
  el.classList.remove("view-enter");
  void el.offsetWidth; // restart entrance animation
  el.classList.add("view-enter");
  window.scrollTo({ top: 0 });
  if (view === "today") loadToday();
  if (view === "history") loadHistory();
  if (view === "weight") loadWeight();
  if (view === "settings") loadSettings();
}
$$("#tabbar .tab").forEach((t) => t.addEventListener("click", () => { buzz(); show(t.dataset.view); }));
$("#fabAdd").addEventListener("click", () => { buzz(); openAddSheet(); });

/* ================= AUTH ================= */
let authMode = "login", inviteRequired = false;
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
function showAuth() {
  show("auth");
  setAuthMode(authMode);
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent);
  $("#installHint").classList.toggle("hidden", isStandalone() || !ios);
}
function setAuthMode(m) {
  authMode = m;
  $$("#authMode button").forEach((b) => b.classList.toggle("on", b.dataset.m === m));
  $("#authBtn").textContent = m === "login" ? "Sign in" : "Create account";
  $("#authSub").textContent = m === "login" ? "Welcome back" : "Your own private tracker";
  $("#authPass").autocomplete = m === "login" ? "current-password" : "new-password";
  $("#authInviteWrap").classList.toggle("hidden", !(m === "register" && inviteRequired));
}
$$("#authMode button").forEach((b) => b.addEventListener("click", () => setAuthMode(b.dataset.m)));
$("#authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#authBtn"); btn.disabled = true;
  try {
    const body = { username: $("#authUser").value.trim(), password: $("#authPass").value, invite: $("#authInvite").value.trim() };
    const { user } = await api(authMode === "login" ? "/api/auth/login" : "/api/auth/register", { method: "POST", body });
    state.user = user;
    buzz(15);
    if (!user.onboarded) startOnboarding(); else show("today");
  } catch (err) { toast(err.message); }
  btn.disabled = false;
});

/* ================= ONBOARDING ================= */
const ob = { sex: "male", birth_date: "", height_cm: "", weight_kg: "", activity_level: "moderate", goal_type: "cut", goal_rate_kg_per_week: 0.5 };
let obCalc = null;
let obStepIdx = 0;

function startOnboarding() { obStepIdx = 0; show("onboarding"); renderObStep(); }

function obDots() { $$("#obDots i").forEach((d, i) => d.classList.toggle("on", i === obStepIdx)); }

const ACT_OPTS = [
  ["sedentary", "Sedentary", "Desk job, little exercise"],
  ["light", "Lightly active", "Exercise 1–3 days a week"],
  ["moderate", "Moderately active", "Exercise 3–5 days a week"],
  ["active", "Very active", "Hard exercise 6–7 days a week"],
  ["very_active", "Athlete", "Physical job or twice-daily training"],
];
const GOAL_OPTS = [
  ["cut", "Lose fat", "Eat below maintenance"],
  ["maintain", "Maintain", "Stay where you are"],
  ["bulk", "Build muscle", "Eat above maintenance"],
];

function renderObStep() {
  obDots();
  const el = $("#obStep");
  el.className = "fade-in";
  if (obStepIdx === 0) {
    el.innerHTML = `
      <div class="stack" style="gap:18px">
        <div><h1>About you</h1><p class="sub">Used to calculate your energy needs — accurately.</p></div>
        <div class="card stack">
          <label class="field">Your name<input id="obName" value="${esc(ob.display_name || "")}" placeholder="What should we call you?" maxlength="40" autocomplete="given-name"></label>
          <div class="seg" id="obSex">
            <button data-v="male" class="${ob.sex === "male" ? "on" : ""}">Male</button>
            <button data-v="female" class="${ob.sex === "female" ? "on" : ""}">Female</button>
          </div>
          <label class="field">Date of birth<input id="obDob" type="date" value="${ob.birth_date}" max="${addDays(localISO(), -365 * 10)}"></label>
          <div class="grid-2">
            <label class="field">Height (cm)<input id="obH" type="number" inputmode="decimal" min="100" max="250" value="${ob.height_cm}" placeholder="178"></label>
            <label class="field">Weight (kg)<input id="obW" type="number" step="0.1" inputmode="decimal" min="20" max="400" value="${ob.weight_kg}" placeholder="80"></label>
          </div>
        </div>
        <button class="btn" id="obNext">Continue</button>
      </div>`;
    $$("#obSex button").forEach((b) => b.addEventListener("click", () => { ob.sex = b.dataset.v; $$("#obSex button").forEach((x) => x.classList.toggle("on", x === b)); }));
    $("#obNext").addEventListener("click", () => {
      ob.display_name = $("#obName").value.trim(); ob.birth_date = $("#obDob").value; ob.height_cm = +$("#obH").value; ob.weight_kg = +$("#obW").value;
      if (!ob.birth_date || !ob.height_cm || !ob.weight_kg) return toast("Fill in all three fields");
      obStepIdx = 1; renderObStep();
    });
  } else if (obStepIdx === 1) {
    el.innerHTML = `
      <div class="stack" style="gap:18px">
        <div><h1>Activity level</h1><p class="sub">Your typical week, training included.</p></div>
        <div class="stack" style="gap:9px">${ACT_OPTS.map(([v, t, d]) => `
          <button class="opt ${ob.activity_level === v ? "on" : ""}" data-v="${v}"><span><span class="t">${t}</span><div class="d">${d}</div></span></button>`).join("")}
        </div>
        <button class="btn" id="obNext">Continue</button>
      </div>`;
    $$(".opt", el).forEach((b) => b.addEventListener("click", () => { ob.activity_level = b.dataset.v; $$(".opt", el).forEach((x) => x.classList.toggle("on", x === b)); }));
    $("#obNext").addEventListener("click", () => { obStepIdx = 2; renderObStep(); });
  } else if (obStepIdx === 2) {
    el.innerHTML = `
      <div class="stack" style="gap:18px">
        <div><h1>Your goal</h1><p class="sub">This sets your calorie target.</p></div>
        <div class="stack" style="gap:9px">${GOAL_OPTS.map(([v, t, d]) => `
          <button class="opt ${ob.goal_type === v ? "on" : ""}" data-v="${v}"><span><span class="t">${t}</span><div class="d">${d}</div></span></button>`).join("")}
        </div>
        <div class="card stack hidden" id="obRateWrap">
          <div class="spread"><span style="font-weight:600;font-size:14px" id="obRateLbl"></span><span class="num" style="font-weight:700" id="obRateVal"></span></div>
          <input id="obRate" type="range" min="0.25" max="1" step="0.25" value="${ob.goal_rate_kg_per_week}" style="min-height:0;padding:0;accent-color:var(--accent)">
        </div>
        <button class="btn" id="obNext">Calculate my plan</button>
      </div>`;
    const rateWrap = $("#obRateWrap");
    const syncRate = () => {
      rateWrap.classList.toggle("hidden", ob.goal_type === "maintain");
      $("#obRateLbl").textContent = ob.goal_type === "bulk" ? "Gain per week" : "Loss per week";
      $("#obRateVal").textContent = `${(+$("#obRate").value).toFixed(2)} kg`;
    };
    $$(".opt", el).forEach((b) => b.addEventListener("click", () => { ob.goal_type = b.dataset.v; $$(".opt", el).forEach((x) => x.classList.toggle("on", x === b)); syncRate(); }));
    $("#obRate").addEventListener("input", syncRate);
    syncRate();
    $("#obNext").addEventListener("click", async () => {
      ob.goal_rate_kg_per_week = +$("#obRate").value;
      try {
        obCalc = await api("/api/profile/calculate", { method: "POST", body: ob });
        obStepIdx = 3; renderObStep();
      } catch (e) { toast(e.message); }
    });
  } else {
    const c = obCalc;
    el.innerHTML = `
      <div class="stack" style="gap:18px">
        <div><h1>Your plan</h1><p class="sub">Maintenance ≈ <b class="num">${c.tdee.toLocaleString()}</b> kcal/day. Tweak anything before you start.</p></div>
        <div class="card" style="text-align:center;padding:24px">
          <div class="eyebrow">Daily target</div>
          <div class="num" style="font-size:54px;font-weight:700;letter-spacing:-0.03em"><input id="obCal" type="number" value="${c.calorie_goal}" style="all:unset;width:200px;text-align:center;font-variant-numeric:tabular-nums"></div>
          <div class="eyebrow">kcal</div>
        </div>
        <div class="card stack">
          <div class="grid-2" style="grid-template-columns:1fr 1fr 1fr;gap:10px">
            <label class="field" style="color:var(--protein)">Protein g<input id="obP" type="number" value="${c.protein_goal_g}" inputmode="numeric"></label>
            <label class="field" style="color:var(--carbs)">Carbs g<input id="obC" type="number" value="${c.carbs_goal_g}" inputmode="numeric"></label>
            <label class="field" style="color:var(--fat)">Fat g<input id="obF" type="number" value="${c.fat_goal_g}" inputmode="numeric"></label>
          </div>
        </div>
        <button class="btn" id="obFinish">Start tracking</button>
      </div>`;
    $("#obFinish").addEventListener("click", async () => {
      try {
        await api("/api/profile", { method: "PUT", body: {
          ...ob, calorie_goal: +$("#obCal").value, protein_goal_g: +$("#obP").value,
          carbs_goal_g: +$("#obC").value, fat_goal_g: +$("#obF").value,
          onboarded: true, log_weight_date: localISO(),
        }});
        state.user.onboarded = true;
        state.displayName = ob.display_name || "";
        buzz(20); toast("You're all set");
        show("today");
      } catch (e) { toast(e.message); }
    });
  }
}

/* ================= TODAY ================= */
const ICON = {
  breakfast: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 17h18M5 17a7 7 0 0 1 14 0M12 3v3M5.6 6.6l2 2M18.4 6.6l-2 2"/></svg>`,
  lunch: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`,
  dinner: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg>`,
  snack: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8c-4 0-7 3-7 7s3 6 5 6 2-1 2-1 0 1 2 1 5-2 5-6-3-7-7-7zM12 8V5M12 5c0-1.5 1.5-2.5 3-2.5"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
  bookmark: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M6 3h12v18l-6-4-6 4z"/></svg>`,
  trash: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>`,
  tag: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.5" fill="currentColor"/></svg>`,
  camera: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>`,
  chat: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 5h16v11H9l-5 4z"/></svg>`,
  x: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  warn: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3L2 21h20zM12 10v4M12 17.5v.5"/></svg>`,
  chevL: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>`,
  chevR: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>`,
};
const MEAL_META = { breakfast: ["Breakfast", "breakfast"], lunch: ["Lunch", "lunch"], dinner: ["Dinner", "dinner"], snack: ["Snacks", "snack"] };
const RING_LEN = 2 * Math.PI * 96;

const dayCache = {}; // date -> {summary, entries} for instant re-renders
function refreshToday() { delete dayCache[state.date]; buzz(12); return loadToday(); }

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Late night" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

async function loadToday() {
  const today = localISO();
  const isToday = state.date === today;
  $("#todayEyebrow").textContent = isToday ? "Today" : state.date > today ? "Planning ahead" : "Looking back";
  $("#todayDate").textContent = `${greeting()}${state.displayName ? ", " + state.displayName : ""}`;
  renderDateBar();
  const cached = dayCache[state.date];
  if (cached) { renderRing(cached.summary.totals, cached.summary.goals); renderWater(cached.summary); renderStreak(cached.summary.streak); renderMeals(cached.entries); }
  try {
    const [summary, { entries }] = await Promise.all([
      api(`/api/summary?date=${state.date}`),
      api(`/api/entries?date=${state.date}`),
    ]);
    dayCache[state.date] = { summary, entries };
    state.profileGoals = summary.goals;
    if (summary.goals?.display_name && summary.goals.display_name !== state.displayName) { state.displayName = summary.goals.display_name; if (isToday) $("#todayDate").textContent = `${greeting()}, ${state.displayName}`; }
    renderRing(summary.totals, summary.goals);
    renderWater(summary);
    renderStreak(summary.streak);
    renderMeals(entries);
  } catch (e) { if (e.message !== "Signed out") toast(e.message); }
}

function renderDateBar() {
  const today = localISO(), isToday = state.date === today;
  const dt = new Date(state.date + "T12:00");
  const yesterday = state.date === addDays(today, -1), tomorrow = state.date === addDays(today, 1);
  $("#datePickLabel").textContent = isToday ? `Today, ${dt.toLocaleDateString("en-AU", { day: "numeric", month: "short" })}`
    : yesterday ? "Yesterday" : tomorrow ? "Tomorrow" : dt.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
  $("#todayJump").classList.toggle("hidden", isToday);
}
$("#dayPrev").addEventListener("click", () => { buzz(); state.date = addDays(state.date, -1); loadToday(); });
$("#dayNext").addEventListener("click", () => { buzz(); state.date = addDays(state.date, 1); loadToday(); });
$("#datePick").addEventListener("click", (e) => {
  if (e.target.id === "todayJump") { buzz(); state.date = localISO(); loadToday(); return; }
  openCalendar();
});

function openCalendar() {
  openSheet((body, close) => {
    let ym = state.date.slice(0, 7); // YYYY-MM
    async function draw() {
      const [y, m] = ym.split("-").map(Number);
      const first = new Date(y, m - 1, 1), daysIn = new Date(y, m, 0).getDate(), today = localISO();
      const endIso = `${ym}-${String(daysIn).padStart(2, "0")}`;
      body.innerHTML = `
        <div class="cal-head">
          <button class="icon-btn" id="calPrev">${ICON.chevL}</button>
          <h2 style="font-size:17px">${first.toLocaleDateString("en-AU", { month: "long", year: "numeric" })}</h2>
          <button class="icon-btn" id="calNext">${ICON.chevR}</button>
        </div>
        <div class="cal-grid" id="calGrid">${["M","T","W","T","F","S","S"].map((d) => `<div class="dow">${d}</div>`).join("")}
          ${Array.from({ length: (first.getDay() + 6) % 7 }, () => `<button class="pad"></button>`).join("")}
          ${Array.from({ length: daysIn }, (_, i) => { const iso = `${ym}-${String(i + 1).padStart(2, "0")}`;
            return `<button data-d="${iso}" class="${iso === state.date ? "on" : ""} ${iso === today ? "today" : ""} ${iso > today ? "future" : ""}">${i + 1}<i></i></button>`; }).join("")}
        </div>
        <button class="btn btn-glass btn-sm" id="calToday" style="margin:0 auto">Jump to today</button>`;
      $("#calPrev", body).addEventListener("click", () => { const d = new Date(y, m - 2, 1); ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; draw(); });
      $("#calNext", body).addEventListener("click", () => { const d = new Date(y, m, 1); ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; draw(); });
      $("#calToday", body).addEventListener("click", () => { buzz(); state.date = today; close(); loadToday(); });
      $$("[data-d]", body).forEach((b) => b.addEventListener("click", () => { buzz(); state.date = b.dataset.d; close(); loadToday(); }));
      try {
        const { days, calorie_goal } = await api(`/api/history?days=${daysIn}&end=${endIso}`);
        for (const d of days) { const b = $(`[data-d="${d.date}"] i`, body); if (b) b.className = calorie_goal && d.calories > calorie_goal ? "over" : "logged"; }
      } catch {}
    }
    draw();
  });
}

// roll over to the new day automatically (app left open past midnight / resumed next morning)
let bootDay = localISO();
function checkDayRollover() {
  const now = localISO();
  if (now === bootDay) return;
  if (state.date === bootDay) state.date = now;
  bootDay = now;
  Object.keys(dayCache).forEach((k) => delete dayCache[k]);
  if (state.view === "today") loadToday();
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) { checkDayRollover(); if (state.view === "today" && state.user) loadToday(); } });
setInterval(checkDayRollover, 60000);

function renderStreak(n) {
  const chip = $("#streakChip");
  const prev = +chip.querySelector("b").textContent;
  chip.querySelector("b").textContent = n || 0;
  chip.style.opacity = n ? 1 : 0.55;
  if (n > prev) { chip.classList.remove("bump"); void chip.offsetWidth; chip.classList.add("bump"); }
}

function renderWater(s) {
  const goal = +s.goals?.water_goal_ml || 2500, ml = +s.water_ml || 0;
  state.waterMl = ml; state.waterGoal = goal;
  $("#waterNow").textContent = ml.toLocaleString();
  $("#waterGoal").textContent = goal.toLocaleString();
  $("#waterFill").style.width = `${Math.min((ml / goal) * 100, 100)}%`;
  const glasses = Math.max(Math.round(goal / 250), 4);
  const full = Math.min(Math.round(ml / 250), glasses);
  $("#glasses").innerHTML = Array.from({ length: glasses }, (_, i) => `<span class="${i < full ? "full" : ""}"></span>`).join("");
}
$$("[data-water]").forEach((b) => b.addEventListener("click", async () => {
  const delta = +b.dataset.water;
  buzz();
  // optimistic
  renderWater({ goals: { water_goal_ml: state.waterGoal }, water_ml: Math.max(0, (state.waterMl || 0) + delta) });
  try {
    const { ml } = await api("/api/water", { method: "POST", body: { date: state.date, delta_ml: delta } });
    renderWater({ goals: { water_goal_ml: state.waterGoal }, water_ml: ml });
    if (dayCache[state.date]) dayCache[state.date].summary.water_ml = ml;
    if (ml >= state.waterGoal && ml - delta < state.waterGoal) toast("Water goal reached");
  } catch (e) { toast(e.message); loadToday(); }
}));

// animated count-up for the hero numbers
const countState = {};
function countUp(sel, to, suffix = "") {
  const el = $(sel);
  const from = countState[sel] ?? 0;
  countState[sel] = to;
  if (from === to || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    el.textContent = to.toLocaleString() + suffix; return;
  }
  const t0 = performance.now(), dur = 600;
  (function tick(now) {
    const p = Math.min((now - t0) / dur, 1);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(from + (to - from) * eased).toLocaleString() + suffix;
    if (p < 1) requestAnimationFrame(tick);
  })(t0);
}

function renderRing(t, g) {
  const goal = +g?.calorie_goal || 2000;
  const eaten = r0(t.calories);
  const remaining = goal - eaten;
  const pct = Math.min(eaten / goal, 1);
  const arc = $("#ringArc");
  arc.style.strokeDashoffset = RING_LEN * (1 - pct);
  arc.style.stroke = remaining < 0 ? "var(--bad)" : "url(#ringGrad)";
  arc.classList.toggle("over", remaining < 0);
  countUp("#ringNum", Math.abs(remaining));
  $("#ringLabel").textContent = remaining < 0 ? "kcal over" : "kcal remaining";
  countUp("#statEaten", eaten);
  $("#statGoal").textContent = goal.toLocaleString();
  countUp("#statBurnPct", Math.round((eaten / goal) * 100), "%");
  setBar("#barP", "#valP", t.protein_g, g?.protein_goal_g);
  setBar("#barC", "#valC", t.carbs_g, g?.carbs_goal_g);
  setBar("#barF", "#valF", t.fat_g, g?.fat_goal_g);
}
function setBar(barSel, valSel, v, goal) {
  const pct = goal ? Math.min((v / goal) * 100, 100) : 0;
  $(barSel).style.width = `${pct}%`;
  $(valSel).innerHTML = `<b>${r0(v)}</b> / ${r0(goal) || "–"} g`;
}

function renderMeals(entries) {
  const byMeal = { breakfast: [], lunch: [], dinner: [], snack: [] };
  for (const e of entries) (byMeal[e.meal_type] || byMeal.snack).push(e);
  $("#mealList").innerHTML = Object.entries(MEAL_META).map(([key, [label, icon]]) => {
    const items = byMeal[key];
    const kcal = r0(items.reduce((a, e) => a + +e.calories, 0));
    return `<div class="card meal-card">
      <div class="meal-head">
        <span class="ic-badge ${icon}">${ICON[icon]}</span><h2 style="font-size:16px">${label}</h2>
        <span class="kcal num">${items.length ? kcal.toLocaleString() + " kcal" : ""}</span>
        ${items.length ? `<button class="icon-btn" style="width:32px;height:32px" data-savemeal="${key}" aria-label="Save as meal">${ICON.bookmark}</button>` : ""}
        <button class="icon-btn" style="width:32px;height:32px" data-addmeal="${key}" aria-label="Add to ${label}">${ICON.plus}</button>
      </div>
      ${items.map((e) => `
        <div class="swipe" data-swipe="${e.id}">
          <button class="swipe-del" data-delentry="${e.id}">${ICON.trash} Delete</button>
          <button class="entry-row" data-entry="${e.id}">
            <span class="n"><span class="t">${esc(e.name)}</span><span class="s">${esc([e.brand, e.serving_desc, +e.quantity !== 1 ? `×${+e.quantity}` : ""].filter(Boolean).join(" · "))}</span></span>
            <span class="kc num">${r0(e.calories)}</span>
          </button>
        </div>`).join("")}
      ${!items.length ? `<div class="empty-hint">Nothing logged yet</div>` : ""}
    </div>`;
  }).join("");
  $$("[data-addmeal]").forEach((b) => b.addEventListener("click", () => { buzz(); openAddSheet(b.dataset.addmeal); }));
  $$("[data-savemeal]").forEach((b) => b.addEventListener("click", () => saveMealFromDay(b.dataset.savemeal, byMeal[b.dataset.savemeal])));
  $$("[data-delentry]").forEach((b) => b.addEventListener("click", async () => {
    buzz(15);
    try { await api(`/api/entries/${b.dataset.delentry}`, { method: "DELETE" }); toast("Deleted"); refreshToday(); }
    catch (err) { toast(err.message); }
  }));
  $$(".swipe").forEach((wrap) => {
    const row = $(".entry-row", wrap);
    const entry = entries.find((e) => e.id === +row.dataset.entry);
    let x0 = null, y0 = null, dx = 0, horizontal = null;
    row.addEventListener("touchstart", (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; horizontal = null; }, { passive: true });
    row.addEventListener("touchmove", (e) => {
      if (x0 == null) return;
      const mx = e.touches[0].clientX - x0, my = e.touches[0].clientY - y0;
      if (horizontal == null && (Math.abs(mx) > 6 || Math.abs(my) > 6)) horizontal = Math.abs(mx) > Math.abs(my);
      if (!horizontal) return;
      dx = Math.min(0, Math.max(mx + (wrap.classList.contains("open") ? -88 : 0), -110));
      wrap.classList.add("dragging");
      row.style.transform = `translateX(${dx}px)`;
    }, { passive: true });
    row.addEventListener("touchend", () => {
      if (x0 == null) return;
      wrap.classList.remove("dragging"); row.style.transform = "";
      if (horizontal) {
        const open = dx < -50;
        $$(".swipe.open").forEach((o) => o !== wrap && o.classList.remove("open"));
        wrap.classList.toggle("open", open);
        if (open) buzz();
      }
      x0 = null;
    });
    row.addEventListener("click", () => {
      if (wrap.classList.contains("open")) { wrap.classList.remove("open"); return; }
      if ($(".swipe.open")) { $$(".swipe.open").forEach((o) => o.classList.remove("open")); return; }
      openEntryEdit(entry);
    });
  });
}

// swipe left/right on the ring card to move a day
(() => {
  let x0 = null;
  const ring = $(".ring-wrap");
  ring.addEventListener("touchstart", (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  ring.addEventListener("touchend", (e) => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0; x0 = null;
    if (Math.abs(dx) < 60) return;
    buzz(); state.date = addDays(state.date, dx < 0 ? 1 : -1); loadToday();
  });
})();

/* ---------- entry edit ---------- */
function openEntryEdit(e) {
  openSheet((body, close) => {
    body.innerHTML = `
      <h2>Edit entry</h2>
      <label class="field">Name<input id="eeName" value="${esc(e.name)}"></label>
      <div class="mini-grid">
        <label>kcal<input id="eeCal" type="number" inputmode="decimal" value="${r1(e.calories)}"></label>
        <label>Protein<input id="eeP" type="number" inputmode="decimal" value="${r1(e.protein_g)}"></label>
        <label>Carbs<input id="eeC" type="number" inputmode="decimal" value="${r1(e.carbs_g)}"></label>
        <label>Fat<input id="eeF" type="number" inputmode="decimal" value="${r1(e.fat_g)}"></label>
      </div>
      <div class="seg" id="eeMeal">${Object.entries(MEAL_META).map(([k, [l]]) => `<button data-v="${k}" class="${e.meal_type === k ? "on" : ""}">${l}</button>`).join("")}</div>
      <button class="btn" id="eeSave">Save changes</button>
      <button class="btn btn-danger" id="eeDel">Delete entry</button>`;
    let meal = e.meal_type;
    $$("#eeMeal button", body).forEach((b) => b.addEventListener("click", () => { meal = b.dataset.v; $$("#eeMeal button", body).forEach((x) => x.classList.toggle("on", x === b)); }));
    $("#eeSave", body).addEventListener("click", async () => {
      try {
        await api(`/api/entries/${e.id}`, { method: "PUT", body: {
          name: $("#eeName", body).value, calories: +$("#eeCal", body).value, protein_g: +$("#eeP", body).value,
          carbs_g: +$("#eeC", body).value, fat_g: +$("#eeF", body).value, meal_type: meal,
        }});
        close(); refreshToday();
      } catch (err) { toast(err.message); }
    });
    $("#eeDel", body).addEventListener("click", async () => {
      try { await api(`/api/entries/${e.id}`, { method: "DELETE" }); close(); refreshToday(); toast("Deleted"); }
      catch (err) { toast(err.message); }
    });
  });
}

async function saveMealFromDay(mealType, items) {
  openSheet((body, close) => {
    body.innerHTML = `
      <h2>Save as meal</h2>
      <p class="sub">Saves ${items.length} item${items.length > 1 ? "s" : ""} (${r0(items.reduce((a, i) => a + +i.calories, 0))} kcal) for one-tap logging later.</p>
      <input id="smName" placeholder="Name it — e.g. My usual breakfast" maxlength="100">
      <button class="btn" id="smSave">Save meal</button>`;
    $("#smSave", body).addEventListener("click", async () => {
      const name = $("#smName", body).value.trim();
      if (!name) return toast("Give it a name");
      try {
        await api("/api/meals", { method: "POST", body: { name, items: items.map((i) => ({
          name: i.name, serving_desc: i.serving_desc, quantity: 1,
          calories: +i.calories, protein_g: +i.protein_g, carbs_g: +i.carbs_g, fat_g: +i.fat_g })) } });
        close(); toast(`Saved “${name}”`);
      } catch (e) { toast(e.message); }
    });
  });
}

/* ================= ADD SHEET ================= */
function defaultMeal() {
  const h = new Date().getHours();
  if (h < 11) return "breakfast";
  if (h < 15) return "lunch";
  if (h < 17) return "snack";
  if (h < 21.5) return "dinner";
  return "snack";
}

function openAddSheet(mealType = defaultMeal()) {
  openSheet((body, close) => {
    let meal = mealType, tab = "search";
    body.innerHTML = `
      <div class="seg" id="addMeal">${Object.entries(MEAL_META).map(([k, [l]]) => `<button data-v="${k}" class="${meal === k ? "on" : ""}">${l}</button>`).join("")}</div>
      <div class="seg" id="addTabs">
        <button data-t="search" class="on">Search</button><button data-t="ai">AI</button>
        <button data-t="saved">Saved</button><button data-t="manual">Manual</button>
      </div>
      <div id="addBody" class="stack"></div>`;
    $$("#addMeal button", body).forEach((b) => b.addEventListener("click", () => { meal = b.dataset.v; $$("#addMeal button", body).forEach((x) => x.classList.toggle("on", x === b)); }));
    $$("#addTabs button", body).forEach((b) => b.addEventListener("click", () => { tab = b.dataset.t; $$("#addTabs button", body).forEach((x) => x.classList.toggle("on", x === b)); renderTab(); }));

    const getMeal = () => meal;
    const ctx = { body: $("#addBody", body), close, getMeal };
    function renderTab() {
      if (tab === "search") renderSearchTab(ctx);
      else if (tab === "ai") renderAiTab(ctx);
      else if (tab === "saved") renderSavedTab(ctx);
      else renderManualTab(ctx);
    }
    renderTab();
  });
}

/* ---------- search tab ---------- */
function renderSearchTab({ body, close, getMeal }) {
  body.innerHTML = `
    <div class="row">
      <input id="q" placeholder="Search foods…" autocomplete="off" enterkeyhint="search">
      <button class="icon-btn" id="scanBtn" aria-label="Scan barcode" style="width:48px;height:48px">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2M7 8v8M11 8v8M15 8v8M17.5 8v8"/></svg>
      </button>
    </div>
    <div id="qResults"></div>`;
  const input = $("#q", body), results = $("#qResults", body);
  let timer, seq = 0;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { results.innerHTML = ""; return; }
    timer = setTimeout(async () => {
      const mySeq = ++seq;
      results.innerHTML = `<div class="stack" style="gap:8px;padding-top:6px"><div class="skel" style="height:54px"></div><div class="skel" style="height:54px;animation-delay:.12s"></div><div class="skel" style="height:54px;animation-delay:.24s"></div></div>`;
      try {
        const { results: list } = await api(`/api/search?q=${encodeURIComponent(q)}`);
        if (mySeq !== seq) return;
        results.innerHTML = list.length ? list.map((f, i) => `
          <button class="result-row" data-i="${i}">
            <span class="n"><span class="t">${esc(f.name)}</span><span class="s">${esc([f.brand, f.serving_desc].filter(Boolean).join(" · "))} · ${r0(f.calories)} kcal</span></span>
            <span class="chip ${f.source}">${f.source === "common" ? "common" : f.source === "usda" ? "usda" : "brand"}</span>
          </button>`).join("") : `<p class="sub" style="text-align:center;padding:16px">Nothing found — try the AI tab or Manual</p>`;
        $$(".result-row", results).forEach((b) => b.addEventListener("click", () => openPortionSheet(list[+b.dataset.i], getMeal(), close)));
      } catch (e) { if (mySeq === seq) results.innerHTML = `<p class="sub" style="text-align:center;padding:16px">${esc(e.message)}</p>`; }
    }, 350);
  });
  $("#scanBtn", body).addEventListener("click", () => startBarcodeScan(getMeal(), close));
  setTimeout(() => input.focus(), 350);
}

/* ---------- portion sheet ---------- */
function openPortionSheet(food, meal, closeParent) {
  openSheet((body, close) => {
    let qty = 1;
    body.innerHTML = `
      <div><h2>${esc(food.name)}</h2><p class="sub">${esc([food.brand, food.serving_desc].filter(Boolean).join(" · ") || "per serving")}</p></div>
      <div class="spread">
        <span style="font-weight:600;font-size:14px;color:var(--text-2)">Servings</span>
        <div class="stepper"><button id="qMinus">−</button><input id="qVal" type="number" step="0.25" min="0.1" value="1" inputmode="decimal"><button id="qPlus">+</button></div>
      </div>
      <div class="card" style="padding:14px">
        <div class="spread num" style="font-weight:700;font-size:22px"><span id="pCal">–</span><span class="eyebrow" style="align-self:center">kcal</span></div>
        <div class="row num" style="gap:16px;margin-top:8px;font-size:13.5px;color:var(--text-2)">
          <span>P <b id="pP" style="color:var(--protein)">–</b></span>
          <span>C <b id="pC" style="color:var(--carbs)">–</b></span>
          <span>F <b id="pF" style="color:var(--fat)">–</b></span>
        </div>
      </div>
      <button class="btn" id="pAdd">Add to ${MEAL_META[meal][0]}</button>`;
    const qv = $("#qVal", body);
    const sync = () => {
      qty = Math.max(+qv.value || 1, 0.1);
      $("#pCal", body).textContent = r0(food.calories * qty).toLocaleString();
      $("#pP", body).textContent = `${r1(food.protein_g * qty)}g`;
      $("#pC", body).textContent = `${r1(food.carbs_g * qty)}g`;
      $("#pF", body).textContent = `${r1(food.fat_g * qty)}g`;
    };
    $("#qMinus", body).addEventListener("click", () => { qv.value = Math.max((+qv.value || 1) - 0.5, 0.5); sync(); });
    $("#qPlus", body).addEventListener("click", () => { qv.value = (+qv.value || 1) + 0.5; sync(); });
    qv.addEventListener("input", sync);
    sync();
    $("#pAdd", body).addEventListener("click", async () => {
      try {
        await api("/api/entries", { method: "POST", body: { entry_date: state.date, meal_type: meal, items: [{
          name: food.name, brand: food.brand, serving_desc: food.serving_desc, quantity: qty,
          calories: food.calories * qty, protein_g: food.protein_g * qty, carbs_g: food.carbs_g * qty, fat_g: food.fat_g * qty,
          source: food.source || "search",
        }] } });
        close(); closeParent?.();
        toast(`Added ${food.name}`);
        refreshToday();
      } catch (e) { toast(e.message); }
    });
  });
}

/* ---------- AI tab ---------- */
function renderAiTab({ body, close, getMeal }) {
  body.innerHTML = `
    <button class="ai-tile" id="aiLabel"><span class="ic-badge ai">${ICON.tag}</span><span><div class="t">Scan a nutrition label</div><div class="d">Photo of the panel — reads kJ/kcal, serving size, macros</div></span></button>
    <button class="ai-tile" id="aiMeal"><span class="ic-badge ai">${ICON.camera}</span><span><div class="t">Photo of your meal</div><div class="d">Snap the plate, optionally describe what's in it</div></span></button>
    <button class="ai-tile" id="aiText"><span class="ic-badge ai">${ICON.chat}</span><span><div class="t">Describe what you ate</div><div class="d">"Chicken wrap and a flat white" — AI estimates it</div></span></button>
    <input type="file" accept="image/*" capture="environment" id="aiFileLabel" class="hidden">`;
  $("#aiLabel", body).addEventListener("click", () => {
    const f = $("#aiFileLabel", body);
    f.onchange = async () => {
      if (!f.files[0]) return;
      const img = await downscale(f.files[0]);
      aiAnalyze(body, () => api("/api/ai/label", { method: "POST", body: { image: img } }), getMeal, close);
    };
    f.click();
  });
  $("#aiMeal", body).addEventListener("click", () => renderMealPhotoForm(body, getMeal, close));
  $("#aiText", body).addEventListener("click", () => {
    body.innerHTML = `
      <h2 style="font-size:18px">Describe what you ate</h2>
      <textarea id="descTxt" placeholder="e.g. large chicken burrito with extra rice, and a can of Coke Zero"></textarea>
      <button class="btn" id="descGo">Analyse</button>`;
    $("#descGo", body).addEventListener("click", () => {
      const d = $("#descTxt", body).value.trim();
      if (!d) return toast("Describe it first");
      aiAnalyze(body, () => api("/api/ai/describe", { method: "POST", body: { description: d } }), getMeal, close);
    });
    $("#descTxt", body).focus();
  });
}

function renderMealPhotoForm(body, getMeal, close) {
  body.innerHTML = `
    <h2 style="font-size:18px">Photo of your meal</h2>
    <button class="btn btn-glass" id="mpPick">Take / choose photo</button>
    <div id="mpPreview" class="hidden" style="border-radius:14px;overflow:hidden;max-height:180px"><img id="mpImg" style="width:100%;object-fit:cover" alt="Meal photo"></div>
    <textarea id="mpDesc" placeholder="Optional — describe it: what you used, portion sizes, cooking oil…"></textarea>
    <button class="btn" id="mpGo" disabled>Analyse meal</button>
    <input type="file" accept="image/*" capture="environment" id="mpFile" class="hidden">`;
  let imgData = null;
  const f = $("#mpFile", body);
  $("#mpPick", body).addEventListener("click", () => f.click());
  f.onchange = async () => {
    if (!f.files[0]) return;
    imgData = await downscale(f.files[0]);
    $("#mpImg", body).src = imgData;
    $("#mpPreview", body).classList.remove("hidden");
    $("#mpGo", body).disabled = false;
  };
  $("#mpGo", body).addEventListener("click", () => {
    aiAnalyze(body, () => api("/api/ai/meal", { method: "POST", body: { image: imgData, description: $("#mpDesc", body).value.trim() } }), getMeal, close);
  });
}

async function aiAnalyze(body, call, getMeal, closeParent) {
  body.innerHTML = `<div class="stack" style="align-items:center;padding:30px 0;gap:14px"><div class="spin" style="width:34px;height:34px"></div><p class="sub">Analysing with AI…</p></div>`;
  try {
    const res = await call();
    renderAiConfirm(body, res, getMeal, closeParent);
  } catch (e) {
    body.innerHTML = `<div class="stack" style="align-items:center;padding:20px 0"><p class="sub" style="text-align:center">${esc(e.message)}</p><button class="btn btn-glass btn-sm" id="aiBack">Try again</button></div>`;
    $("#aiBack", body).addEventListener("click", () => renderAiTab({ body, close: closeParent, getMeal }));
  }
}

function renderAiConfirm(body, { items, confidence, notes }, getMeal, closeParent) {
  body.innerHTML = `
    <div><h2 style="font-size:18px">Check &amp; confirm</h2>
      <p class="sub" style="font-size:13px">${esc(notes || "")} <span class="chip" style="vertical-align:1px">${esc(confidence)} confidence</span></p></div>
    <div id="ciList" class="stack" style="gap:10px"></div>
    <div class="row"><input id="ciRefine" placeholder="Not quite? e.g. “it was a large bowl, with cheese”" style="flex:1"><button class="btn btn-sm" id="ciRefineGo" style="flex:none">Adjust</button></div>
    <button class="btn" id="ciSave"></button>
    <button class="btn btn-quiet" id="ciSaveMeal" style="margin:-6px auto 0">Also save as a reusable meal…</button>`;
  const list = $("#ciList", body);
  const rows = items.map((it) => ({ ...it }));
  $("#ciRefineGo", body).addEventListener("click", () => {
    const instruction = $("#ciRefine", body).value.trim();
    if (!instruction) return toast("Tell the AI what to change");
    aiAnalyze(body, () => api("/api/ai/refine", { method: "POST", body: { items: rows, instruction } }), getMeal, closeParent);
  });
  function draw() {
    list.innerHTML = rows.map((it, i) => `
      <div class="confirm-item">
        <div class="row"><input value="${esc(it.name)}" data-f="name" data-i="${i}" style="flex:1"><button class="icon-btn" style="width:32px;height:32px;font-size:14px" data-del="${i}" aria-label="Remove">${ICON.x}</button></div>
        <div class="s" style="font-size:12px;color:var(--text-3)">${esc(it.serving_desc || "")}</div>
        ${it.warning ? `<div class="warn">${ICON.warn} ${esc(it.warning)}</div>` : ""}
        <div class="mini-grid">
          <label>kcal<input type="number" inputmode="decimal" value="${r0(it.calories)}" data-f="calories" data-i="${i}"></label>
          <label>P g<input type="number" inputmode="decimal" value="${r1(it.protein_g)}" data-f="protein_g" data-i="${i}"></label>
          <label>C g<input type="number" inputmode="decimal" value="${r1(it.carbs_g)}" data-f="carbs_g" data-i="${i}"></label>
          <label>F g<input type="number" inputmode="decimal" value="${r1(it.fat_g)}" data-f="fat_g" data-i="${i}"></label>
        </div>
      </div>`).join("");
    $("#ciSave", body).textContent = `Log ${rows.length} item${rows.length !== 1 ? "s" : ""} · ${r0(rows.reduce((a, x) => a + +x.calories, 0))} kcal`;
    $$("input[data-f]", list).forEach((inp) => inp.addEventListener("input", () => {
      const it = rows[+inp.dataset.i];
      it[inp.dataset.f] = inp.dataset.f === "name" ? inp.value : +inp.value || 0;
      if (inp.dataset.f !== "name") $("#ciSave", body).textContent = `Log ${rows.length} item${rows.length !== 1 ? "s" : ""} · ${r0(rows.reduce((a, x) => a + +x.calories, 0))} kcal`;
    }));
    $$("[data-del]", list).forEach((b) => b.addEventListener("click", () => { rows.splice(+b.dataset.del, 1); rows.length ? draw() : closeParent?.(); }));
  }
  draw();
  $("#ciSave", body).addEventListener("click", async () => {
    try {
      await api("/api/entries", { method: "POST", body: { entry_date: state.date, meal_type: getMeal(), items: rows.map(({ warning, ...x }) => ({ ...x, source: "ai" })) } });
      closeParent?.(); toast("Logged"); refreshToday();
    } catch (e) { toast(e.message); }
  });
  $("#ciSaveMeal", body).addEventListener("click", () => {
    openSheet((b2, close2) => {
      b2.innerHTML = `<h2>Save as meal</h2><input id="cmName" placeholder="Meal name" maxlength="100"><button class="btn" id="cmGo">Save</button>`;
      $("#cmGo", b2).addEventListener("click", async () => {
        const name = $("#cmName", b2).value.trim();
        if (!name) return toast("Give it a name");
        try { await api("/api/meals", { method: "POST", body: { name, items: rows } }); close2(); toast(`Saved “${name}”`); }
        catch (e) { toast(e.message); }
      });
    });
  });
}

/* ---------- saved tab ---------- */
async function renderSavedTab({ body, close, getMeal }) {
  body.innerHTML = `<div class="skel" style="height:54px"></div><div class="skel" style="height:54px;animation-delay:.12s"></div><div class="skel" style="height:54px;animation-delay:.24s"></div>`;
  try {
    const [{ meals }, { recent }] = await Promise.all([api("/api/meals"), api("/api/recent")]);
    body.innerHTML = `
      ${meals.length ? `<div class="eyebrow">Saved meals</div>` : ""}
      ${meals.map((m) => `
        <div class="result-row" style="cursor:default">
          <span class="n"><span class="t">${esc(m.name)}</span><span class="s num">${r0(m.calories)} kcal · P${r0(m.protein_g)} C${r0(m.carbs_g)} F${r0(m.fat_g)}</span></span>
          <button class="btn btn-sm" data-logmeal="${m.id}" style="flex:none">Log</button>
        </div>`).join("")}
      ${recent.length ? `<div class="eyebrow" style="margin-top:6px">Recent foods</div>` : ""}
      ${recent.map((f, i) => `
        <button class="result-row" data-recent="${i}">
          <span class="n"><span class="t">${esc(f.name)}</span><span class="s">${esc(f.serving_desc || "")} · ${r0(f.calories)} kcal</span></span>
          <span class="chip">recent</span>
        </button>`).join("")}
      ${!meals.length && !recent.length ? `<p class="sub" style="text-align:center;padding:18px">Nothing saved yet — log some food and bookmark a meal, or save one from an AI result</p>` : ""}`;
    $$("[data-logmeal]", body).forEach((b) => b.addEventListener("click", async () => {
      try {
        await api(`/api/meals/${b.dataset.logmeal}/log`, { method: "POST", body: { entry_date: state.date, meal_type: getMeal() } });
        close(); toast("Logged"); refreshToday();
      } catch (e) { toast(e.message); }
    }));
    $$("[data-recent]", body).forEach((b) => b.addEventListener("click", () => {
      const f = recent[+b.dataset.recent];
      openPortionSheet({ name: f.name, brand: f.brand, serving_desc: f.serving_desc, calories: +f.calories, protein_g: +f.protein_g, carbs_g: +f.carbs_g, fat_g: +f.fat_g, source: "recent" }, getMeal(), close);
    }));
  } catch (e) { body.innerHTML = `<p class="sub">${esc(e.message)}</p>`; }
}

/* ---------- manual tab ---------- */
function renderManualTab({ body, close, getMeal }) {
  body.innerHTML = `
    <label class="field">Food name<input id="mName" placeholder="e.g. Protein shake" maxlength="200"></label>
    <div class="spread"><span class="eyebrow">Energy unit</span>
      <div class="seg" style="width:140px"><button id="uKcal" class="on">kcal</button><button id="uKj">kJ</button></div>
    </div>
    <div class="mini-grid">
      <label id="mCalLbl">kcal<input id="mCal" type="number" inputmode="decimal"></label>
      <label>P g<input id="mP" type="number" inputmode="decimal"></label>
      <label>C g<input id="mC" type="number" inputmode="decimal"></label>
      <label>F g<input id="mF" type="number" inputmode="decimal"></label>
    </div>
    <label class="field">Serving (optional)<input id="mServ" placeholder="e.g. 1 scoop (30g)" maxlength="120"></label>
    <button class="btn" id="mAdd">Add</button>`;
  let unit = "kcal";
  $("#uKcal", body).addEventListener("click", () => { unit = "kcal"; $("#uKcal", body).classList.add("on"); $("#uKj", body).classList.remove("on"); $("#mCalLbl", body).firstChild.textContent = "kcal"; });
  $("#uKj", body).addEventListener("click", () => { unit = "kj"; $("#uKj", body).classList.add("on"); $("#uKcal", body).classList.remove("on"); $("#mCalLbl", body).firstChild.textContent = "kJ"; });
  $("#mAdd", body).addEventListener("click", async () => {
    const name = $("#mName", body).value.trim();
    let cal = +$("#mCal", body).value;
    if (!name || !cal) return toast("Name and energy are required");
    if (unit === "kj") cal = cal / 4.184;
    try {
      await api("/api/entries", { method: "POST", body: { entry_date: state.date, meal_type: getMeal(), items: [{
        name, calories: cal, protein_g: +$("#mP", body).value || 0, carbs_g: +$("#mC", body).value || 0,
        fat_g: +$("#mF", body).value || 0, serving_desc: $("#mServ", body).value.trim() || null, quantity: 1, source: "manual",
      }] } });
      close(); toast(`Added ${name}`); refreshToday();
    } catch (e) { toast(e.message); }
  });
}

/* ---------- barcode ---------- */
async function startBarcodeScan(meal, closeParent) {
  if (!("BarcodeDetector" in window)) {
    toast("Live scanning isn't supported in this browser — use AI label scan instead", 3500);
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  } catch { toast("Camera access denied"); return; }
  const overlay = document.createElement("div");
  overlay.id = "scanOverlay";
  overlay.innerHTML = `<video autoplay playsinline muted></video><div class="frame"></div><button class="icon-btn close">${ICON.x}</button>`;
  document.body.append(overlay);
  const video = $("video", overlay);
  video.srcObject = stream;
  let stopped = false;
  const stop = () => { stopped = true; stream.getTracks().forEach((t) => t.stop()); overlay.remove(); };
  $(".close", overlay).addEventListener("click", stop);
  const detector = new BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"] });
  const tick = async () => {
    if (stopped) return;
    try {
      const codes = await detector.detect(video);
      if (codes.length) {
        const code = codes[0].rawValue;
        stop();
        toast("Looking up product…");
        try {
          const { product } = await api(`/api/barcode/${encodeURIComponent(code)}`);
          openPortionSheet(product, meal, closeParent);
        } catch (e) { toast(e.message, 3500); }
        return;
      }
    } catch {}
    setTimeout(tick, 280);
  };
  video.addEventListener("loadedmetadata", tick);
}

/* ---------- image downscale ---------- */
function downscale(file, max = 1280, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(max / Math.max(img.width, img.height), 1);
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL("image/jpeg", quality));
      URL.revokeObjectURL(img.src);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

/* ================= HISTORY ================= */
async function loadHistory() {
  if (!$("#histChart").innerHTML) {
    $("#histChart").innerHTML = `<div class="skel" style="height:150px"></div>`;
    $("#histList").innerHTML = `<div class="stack" style="gap:8px;padding:12px"><div class="skel" style="height:48px"></div><div class="skel" style="height:48px;animation-delay:.12s"></div></div>`;
  }
  try {
    const { days, calorie_goal } = await api("/api/history?days=30");
    const byDate = Object.fromEntries(days.map((d) => [d.date, d]));
    const goal = +calorie_goal || 2000;
    // this week: last 7 days incl. today
    const wk = Array.from({ length: 7 }, (_, i) => byDate[addDays(localISO(), -i)]).filter(Boolean);
    const avg = (k) => (wk.length ? Math.round(wk.reduce((a, d) => a + +d[k], 0) / wk.length) : 0);
    const onTarget = wk.filter((d) => d.calories <= goal && d.calories >= goal * 0.75).length;
    $("#weekStats").innerHTML = `
      <div><div class="v">${avg("calories").toLocaleString()}</div><div class="l">avg kcal</div></div>
      <div><div class="v">${onTarget}<span style="font-size:13px;color:var(--text-3)">/${wk.length}</span></div><div class="l">on target</div></div>
      <div><div class="v" style="font-size:13.5px;line-height:1.6;letter-spacing:0"><span style="color:var(--protein)">${avg("protein_g")}</span> · <span style="color:var(--carbs)">${avg("carbs_g")}</span> · <span style="color:var(--fat)">${avg("fat_g")}</span></div><div class="l">avg P · C · F</div></div>`;
    // chart: last 14 days
    const N = 14, W = 380, H = 150, PAD = 6;
    const dates = Array.from({ length: N }, (_, i) => addDays(localISO(), i - N + 1));
    const maxV = Math.max(goal * 1.25, ...dates.map((d) => +byDate[d]?.calories || 0));
    const bw = (W - PAD * 2) / N;
    const bars = dates.map((d, i) => {
      const v = +byDate[d]?.calories || 0;
      const h = Math.max((v / maxV) * (H - 26), v > 0 ? 3 : 0);
      const x = PAD + i * bw + bw * 0.18;
      const over = v > goal;
      const day = new Date(d + "T12:00").toLocaleDateString("en-AU", { weekday: "narrow" });
      return `<rect x="${x.toFixed(1)}" y="${(H - 18 - h).toFixed(1)}" width="${(bw * 0.64).toFixed(1)}" height="${h.toFixed(1)}" rx="3.5" fill="${over ? "var(--bad)" : "url(#hg)"}" opacity="${v ? 1 : 0.25}"/>
        <text x="${(x + bw * 0.32).toFixed(1)}" y="${H - 4}" font-size="9" fill="var(--text-3)" text-anchor="middle">${day}</text>`;
    }).join("");
    const gy = H - 18 - (goal / maxV) * (H - 26);
    $("#histChart").innerHTML = `
      <div class="spread" style="margin-bottom:6px"><span class="eyebrow">Last 14 days</span><span class="eyebrow num">goal ${goal.toLocaleString()}</span></div>
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="Daily calories, last 14 days">
        <defs><linearGradient id="hg" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="#0a84ff"/><stop offset="100%" stop-color="#5ac8fa"/></linearGradient></defs>
        <line x1="${PAD}" x2="${W - PAD}" y1="${gy.toFixed(1)}" y2="${gy.toFixed(1)}" stroke="rgba(255,255,255,0.35)" stroke-width="1" stroke-dasharray="4 4"/>
        ${bars}
      </svg>`;
    $("#histList").innerHTML = days.length ? days.map((d) => {
      const over = +d.calories > goal;
      return `<button class="day-row" data-date="${d.date}">
        <span class="n"><span class="t">${new Date(d.date + "T12:00").toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" })}</span>
        <span class="s num">P${r0(d.protein_g)} · C${r0(d.carbs_g)} · F${r0(d.fat_g)} · ${d.items} item${d.items !== 1 ? "s" : ""}</span></span>
        <span class="pill ${over ? "over" : "under"}">${over ? "+" + r0(d.calories - goal) : r0(goal - d.calories) + " left"}</span>
        <span class="kc num">${r0(d.calories).toLocaleString()}</span>
      </button>`;
    }).join("") : `<p class="sub" style="padding:18px;text-align:center">No days logged yet</p>`;
    $$("[data-date]", $("#histList")).forEach((b) => b.addEventListener("click", () => { state.date = b.dataset.date; show("today"); }));
  } catch (e) { if (e.message !== "Signed out") toast(e.message); }
}

/* ================= WEIGHT ================= */
async function loadWeight() {
  try {
    const [{ weights }, { profile }] = await Promise.all([api(`/api/weight?days=${state.wdays}`), api("/api/profile")]);
    const last = weights[weights.length - 1];
    $("#wNow").textContent = last ? `${r1(last.weight_kg)} kg` : "–";
    const gw = +profile?.goal_weight_kg;
    const gl = $("#wGoalLine");
    if (gw && last) {
      const diff = r1(last.weight_kg - gw);
      gl.textContent = Math.abs(diff) < 0.3 ? `At your goal weight of ${gw} kg` : `${Math.abs(diff)} kg ${diff > 0 ? "to lose" : "to gain"} to reach ${gw} kg`;
      gl.classList.remove("hidden");
    } else gl.classList.add("hidden");
    $("#wTrendLabel").textContent = `${state.wdays}-day change`;
    if (weights.length >= 2) {
      const diff = r1(last.weight_kg - weights[0].weight_kg);
      $("#wTrend").textContent = `${diff > 0 ? "+" : ""}${diff} kg`;
      $("#wTrend").style.color = diff <= 0 ? "var(--good)" : "var(--text)";
    } else $("#wTrend").textContent = "–";
    // chart
    const W = 380, H = 140, PAD = 10;
    if (weights.length >= 2) {
      const vs = weights.map((w) => +w.weight_kg);
      const min = Math.min(...vs), max = Math.max(...vs);
      const lo = min - Math.max((max - min) * 0.2, 0.5), hi = max + Math.max((max - min) * 0.2, 0.5);
      const t0 = new Date(weights[0].date).getTime(), t1 = new Date(last.date).getTime() || t0 + 1;
      const X = (d) => PAD + ((new Date(d).getTime() - t0) / Math.max(t1 - t0, 1)) * (W - PAD * 2);
      const Y = (v) => H - PAD - ((v - lo) / (hi - lo)) * (H - PAD * 2);
      const pts = weights.map((w) => `${X(w.date).toFixed(1)},${Y(+w.weight_kg).toFixed(1)}`).join(" ");
      $("#wChart").innerHTML = `
        <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="Weight trend">
          <polyline points="${pts}" fill="none" stroke="url(#wg)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
          <defs><linearGradient id="wg" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#5ac8fa"/><stop offset="100%" stop-color="#0a84ff"/></linearGradient></defs>
          ${weights.map((w) => `<circle cx="${X(w.date).toFixed(1)}" cy="${Y(+w.weight_kg).toFixed(1)}" r="3.5" fill="#0a84ff" stroke="#050508" stroke-width="1.5"/>`).join("")}
          <text x="${PAD}" y="12" font-size="10" fill="var(--text-3)">${r1(hi)}</text>
          <text x="${PAD}" y="${H - 2}" font-size="10" fill="var(--text-3)">${r1(lo)}</text>
        </svg>`;
    } else {
      $("#wChart").innerHTML = `<p class="sub" style="text-align:center;padding:14px">Log a few weigh-ins to see your trend</p>`;
    }
    $("#wList").innerHTML = [...weights].reverse().slice(0, 14).map((w) => `
      <div class="day-row"><span class="n"><span class="t">${new Date(w.date + "T12:00").toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" })}</span></span>
      <span class="kc num">${r1(w.weight_kg)} kg</span>
      <button class="icon-btn" style="width:30px;height:30px;font-size:13px" data-wdel="${w.date}" aria-label="Delete">${ICON.x}</button></div>`).join("") ||
      `<p class="sub" style="padding:18px;text-align:center">No weigh-ins yet</p>`;
    $$("[data-wdel]").forEach((b) => b.addEventListener("click", async () => {
      try { await api(`/api/weight/${b.dataset.wdel}`, { method: "DELETE" }); loadWeight(); } catch (e) { toast(e.message); }
    }));
  } catch (e) { if (e.message !== "Signed out") toast(e.message); }
}
$("#wForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const v = +$("#wInput").value;
  if (!v) return;
  try {
    await api("/api/weight", { method: "POST", body: { date: localISO(), weight_kg: v } });
    $("#wInput").value = "";
    toast("Weight logged");
    loadWeight();
  } catch (err) { toast(err.message); }
});
$$("[data-wdays]").forEach((b) => b.addEventListener("click", () => {
  state.wdays = +b.dataset.wdays;
  $$("[data-wdays]").forEach((x) => x.classList.toggle("on", x === b));
  loadWeight();
}));

/* ================= SETTINGS ================= */
async function loadSettings() {
  $("#setHello").textContent = state.user ? `@${state.user.username}` : "";
  try {
    const [{ profile }, { meals }, aiInfo] = await Promise.all([api("/api/profile"), api("/api/meals"), api("/api/ai/status")]);
    state.profile = profile;
    if (profile) {
      $("#gCal").value = profile.calorie_goal || "";
      $("#gPro").value = profile.protein_goal_g || "";
      $("#gCarb").value = profile.carbs_goal_g || "";
      $("#gFat").value = profile.fat_goal_g || "";
      $("#gWater").value = profile.water_goal_ml || 2500;
      $("#gWeight").value = profile.goal_weight_kg || "";
      $("#sName").value = profile.display_name || "";
      $("#sSex").value = profile.sex || "male";
      $("#sDob").value = profile.birth_date ? profile.birth_date.slice(0, 10) : "";
      $("#sHeight").value = profile.height_cm || "";
      $("#sWeight").value = profile.weight_kg || "";
      $("#sAct").value = profile.activity_level || "moderate";
      $("#sGoal").value = profile.goal_type || "maintain";
      $("#sRate").value = profile.goal_rate_kg_per_week ?? 0.5;
      $("#sRateWrap").classList.toggle("hidden", $("#sGoal").value === "maintain");
    }
    $("#aiInfo").innerHTML = aiInfo.configured
      ? (aiInfo.model ? `Photo &amp; description analysis is on, powered by <b>${esc(aiInfo.model)}</b>.` : `Key configured, but no model detected: ${esc(aiInfo.error || "unknown")}`)
      : "No OpenAI key configured on the server — AI features are off.";
    $("#setMeals").innerHTML = meals.length ? meals.map((m) => `
      <div class="spread" style="padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05)">
        <span><b style="font-size:14.5px">${esc(m.name)}</b><div class="sub num" style="font-size:12px">${r0(m.calories)} kcal · used ${m.use_count}×</div></span>
        <button class="btn-quiet" data-mdel="${m.id}" style="color:var(--bad)">Delete</button>
      </div>`).join("") : `<p class="sub" style="font-size:13.5px">None yet — save one from a day's meals (bookmark icon) or an AI result.</p>`;
    $$("[data-mdel]").forEach((b) => b.addEventListener("click", async () => {
      try { await api(`/api/meals/${b.dataset.mdel}`, { method: "DELETE" }); loadSettings(); } catch (e) { toast(e.message); }
    }));
  } catch (e) { if (e.message !== "Signed out") toast(e.message); }
}
$("#sGoal").addEventListener("change", () => $("#sRateWrap").classList.toggle("hidden", $("#sGoal").value === "maintain"));
$("#saveGoals").addEventListener("click", async () => {
  try {
    await api("/api/profile", { method: "PUT", body: {
      calorie_goal: +$("#gCal").value || null, protein_goal_g: +$("#gPro").value || null,
      carbs_goal_g: +$("#gCarb").value || null, fat_goal_g: +$("#gFat").value || null,
      water_goal_ml: +$("#gWater").value || null, goal_weight_kg: +$("#gWeight").value || null,
    }});
    Object.keys(dayCache).forEach((k) => delete dayCache[k]);
    buzz(12); toast("Goals saved");
  } catch (e) { toast(e.message); }
});
$("#saveName").addEventListener("click", async () => {
  try {
    await api("/api/profile", { method: "PUT", body: { display_name: $("#sName").value.trim() || null } });
    state.displayName = $("#sName").value.trim();
    Object.keys(dayCache).forEach((k) => delete dayCache[k]);
    toast("Saved");
  } catch (e) { toast(e.message); }
});
$("#exportBtn").addEventListener("click", () => { window.location.href = "/api/export.csv"; });
$("#deleteAcct").addEventListener("click", () => {
  openSheet((body, close) => {
    body.innerHTML = `<h2>Delete account</h2><p class="sub">This permanently deletes your account and every entry, meal and weigh-in. There's no undo.</p>
      <input id="delPw" type="password" placeholder="Confirm your password" autocomplete="current-password">
      <button class="btn btn-danger" id="delGo">Delete everything</button>`;
    $("#delGo", body).addEventListener("click", async () => {
      try {
        await api("/api/auth/account", { method: "DELETE", body: { password: $("#delPw", body).value } });
        close(); state.user = null; toast("Account deleted"); showAuth();
      } catch (e) { toast(e.message); }
    });
  });
});
$("#recalcBtn").addEventListener("click", async () => {
  const stats = {
    sex: $("#sSex").value, birth_date: $("#sDob").value, height_cm: +$("#sHeight").value,
    weight_kg: +$("#sWeight").value, activity_level: $("#sAct").value, goal_type: $("#sGoal").value,
    goal_rate_kg_per_week: +$("#sRate").value || 0,
  };
  if (!stats.birth_date || !stats.height_cm || !stats.weight_kg) return toast("Fill in your stats first");
  try {
    const calc = await api("/api/profile/calculate", { method: "POST", body: stats });
    await api("/api/profile", { method: "PUT", body: { ...stats,
      calorie_goal: calc.calorie_goal, protein_goal_g: calc.protein_goal_g,
      carbs_goal_g: calc.carbs_goal_g, fat_goal_g: calc.fat_goal_g,
    }});
    $("#recalcOut").innerHTML = `Maintenance ≈ <b class="num">${calc.tdee.toLocaleString()}</b> kcal · new target <b class="num">${calc.calorie_goal.toLocaleString()}</b> kcal (P${calc.protein_goal_g} / C${calc.carbs_goal_g} / F${calc.fat_goal_g})`;
    toast("Goals recalculated");
    loadSettings();
  } catch (e) { toast(e.message); }
});
$("#pwForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/auth/password", { method: "POST", body: { current: $("#pwCur").value, next: $("#pwNew").value } });
    $("#pwCur").value = ""; $("#pwNew").value = "";
    toast("Password changed");
  } catch (err) { toast(err.message); }
});
$("#logoutBtn").addEventListener("click", async () => {
  try { await api("/api/auth/logout", { method: "POST" }); } catch {}
  state.user = null;
  showAuth();
});

/* ================= BOOT ================= */
(async function boot() {
  try {
    const [s, cfg] = await Promise.all([api("/api/auth/state"), api("/api/auth/config").catch(() => ({}))]);
    inviteRequired = !!cfg.inviteRequired;
    if (s.user) {
      state.user = s.user;
      if (!s.user.onboarded) startOnboarding(); else show("today");
    } else showAuth();
  } catch { showAuth(); }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
})();
