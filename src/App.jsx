import { useState, useEffect, useCallback, useRef } from "react";
import { pullFromCloud, pushToCloud, pushOne, deleteRecord, supabase, loadCatalog, saveCatalog, uploadStorageSheet, setCustomerRefStart, dbSig } from "./supabase";
import { FURNITURE, ROOMS, BOX_ITEMS, WARDROBE_BOX_ID, recommendVehicle } from "./furniture";

const DB_KEY = "removals_data";
const SIG_KEY = "removals_sigs";
const TOMB_KEY = "removals_deleted";
const REF_KEY = "removals_ref_start";
const CAT_KEY = "removals_catalog";
const TABLES = ["customers", "enquiries", "jobs", "vehicles", "staff"];
const EMPTY = { customers: [], enquiries: [], jobs: [], vehicles: [], staff: [] };

// ── Editable item catalogue ────────────────────────────────────────────────
// The built-in FURNITURE/ROOMS act as the seed. A saved catalogue (local +
// Supabase) overrides them, so Dave can permanently edit volumes/weights,
// add items and add rooms, and it syncs across devices.
function buildDefaultCatalog() {
  return { rooms: ROOMS.slice(), items: FURNITURE.map(it => ({ ...it })), updatedAt: 0 };
}
let ACTIVE_ROOMS = ROOMS.slice();
let ACTIVE_FURNITURE = FURNITURE.map(it => ({ ...it }));
function getRooms() { return ACTIVE_ROOMS; }
function getFurniture() { return ACTIVE_FURNITURE; }
function applyCatalog(cat) {
  if (cat && Array.isArray(cat.rooms) && cat.rooms.length) ACTIVE_ROOMS = cat.rooms.slice();
  if (cat && Array.isArray(cat.items) && cat.items.length) ACTIVE_FURNITURE = cat.items.map(it => ({ ...it }));
}
function loadLocalCatalog() {
  try { const c = JSON.parse(localStorage.getItem(CAT_KEY) || "null"); return c && c.items ? c : null; } catch { return null; }
}
function saveLocalCatalog(cat) {
  try { localStorage.setItem(CAT_KEY, JSON.stringify(cat)); } catch {}
}
const M3_PER_CUFT = 0.0283168;
function slugId(room, name) {
  return (room.slice(0, 4) + "-" + name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) + "-" + Math.random().toString(36).slice(2, 5);
}

function getRefStart() { const v = parseInt(localStorage.getItem(REF_KEY), 10); return Number.isFinite(v) ? v : 1000; }
function setRefStart(n) { localStorage.setItem(REF_KEY, String(parseInt(n, 10) || 0)); }
const STORLOC_KEY = "removals_storage_locs";
function getStorageLocs() { try { const a = JSON.parse(localStorage.getItem(STORLOC_KEY) || "null"); return Array.isArray(a) && a.length ? a : ["Wild & Lye"]; } catch { return ["Wild & Lye"]; } }
// A customer can have several storage jobs. Migrate an old single `storage` object into one job.
function getStorageJobs(c) {
  if (Array.isArray(c && c.storageJobs)) return c.storageJobs;
  const s = c && c.storage;
  if (s && (s.inStore || s.location || s.value || s.containers)) return [{ id: "legacy", dateIn: s.dateIn || "", dateOut: s.dateOut || "", containers: s.containers || 0, containerNos: s.containerNos || [], looseItems: !!s.looseItems, looseNote: s.looseNote || "", location: s.location || "", value: s.value || 0, inStore: s.dateOut ? false : !!s.inStore }];
  return [];
}
const jobInStore = j => !!j && !j.dateOut;
// A customer qualifies for a storage job only once a quote is accepted (job Confirmed/Completed)
// and that move involves going into store.
function customerHasStorageMove(data, customerId) {
  return (data.jobs || []).some(j => {
    if (j.customerId !== customerId) return false;
    if (!["Confirmed", "Completed"].includes(j.status)) return false;
    const stageStore = jobStages(j).some(s => /store/i.test(s.type || ""));
    const enqStore = (data.enquiries || []).some(e => e.id === j.enquiryId && e.toStore);
    return stageStore || enqStore;
  });
}
// Inventory sheets belonging to a storage job (legacy sheets fall under the first job).
function sheetsForJob(c, job) {
  const jobs = getStorageJobs(c);
  const isFirst = jobs[0] && job && jobs[0].id === job.id;
  return ((c && c.storageInv) || []).filter(s => (job && s.jobId === job.id) || (!s.jobId && isFirst));
}
// Container count + numbers are derived from the job's inventory sheets, not typed in.
function jobContainerNos(c, job) {
  const nos = []; const seen = new Set();
  sheetsForJob(c, job).forEach(s => (s.containers || []).forEach(ct => { const key = (ct.number || "").trim(); if (key && !seen.has(key)) { seen.add(key); nos.push(key); } }));
  return nos;
}
function jobContainerCount(c, job) {
  let n = 0; const seen = new Set();
  sheetsForJob(c, job).forEach(s => (s.containers || []).forEach(ct => { const key = (ct.number || "").trim(); if (key) { if (!seen.has(key)) { seen.add(key); n++; } } else n++; }));
  return n;
}
// Loose items are captured on the inventory sheets; gather any notes for the job.
function jobLoose(c, job) {
  const notes = [];
  let any = false;
  sheetsForJob(c, job).forEach(s => {
    if (Array.isArray(s.looseList) && s.looseList.length) { any = true; s.looseList.forEach(li => notes.push(`${li.qty || 1}× ${li.name}`)); }
    else if (s.looseItems && (s.looseNote || "").trim()) { any = true; notes.push(s.looseNote.trim()); }
  });
  return { any, notes };
}
function saveStorageLocs(a) { try { localStorage.setItem(STORLOC_KEY, JSON.stringify(a && a.length ? a : ["Wild & Lye"])); } catch {} }
const COND_KEY = "removals_conditions";
const DEFAULT_CONDITIONS = ["OK", "Scratched", "Dented", "Cracked", "Broken", "Torn", "Soiled", "Rusty", "Loose"];
function getConditions() { try { const a = JSON.parse(localStorage.getItem(COND_KEY) || "null"); const list = Array.isArray(a) && a.length ? a.slice() : DEFAULT_CONDITIONS.slice(); if (!list.includes("OK")) list.unshift("OK"); return list; } catch { return DEFAULT_CONDITIONS.slice(); } }
function saveConditions(a) { try { localStorage.setItem(COND_KEY, JSON.stringify(a && a.length ? a : DEFAULT_CONDITIONS)); } catch {} }
const POS_KEY = "removals_positions";
const DEFAULT_POSITIONS = ["Top", "Bottom", "Front", "Back", "Left", "Right", "Top left", "Top right", "Bottom left", "Bottom right", "Front left", "Front right", "Back left", "Back right", "Inside", "All over"];
function getPositions() { try { const a = JSON.parse(localStorage.getItem(POS_KEY) || "null"); return Array.isArray(a) && a.length ? a : DEFAULT_POSITIONS.slice(); } catch { return DEFAULT_POSITIONS.slice(); } }
function savePositions(a) { try { localStorage.setItem(POS_KEY, JSON.stringify(a && a.length ? a : DEFAULT_POSITIONS)); } catch {} }
const BOX_RE = /\b(box(es|'s|’s)?|container(s)?|bag(s)?)\b/i;
const isBoxItem = name => BOX_RE.test(name || "");
const APPLIANCE_RE = /\b(washing machine|washer|dish ?washer|tumble dryer|dryer|fridge freezer|fridge|freezer|oven|cooker|range cooker|hob|microwave|television|tv|computer|monitor|printer|kettle|toaster|hoover|vacuum|extractor|dishwasher)\b/i;
const AMERICAN_FRIDGE_RE = /american\s+(fridge|style)/i;
// Show dismantle only for furniture: not boxes/bags, not electrical/appliances — except American fridge freezers.
const canDismantle = name => !isBoxItem(name) && (!APPLIANCE_RE.test(name || "") || AMERICAN_FRIDGE_RE.test(name || ""));
function maxCustomerRef(data) { return (data.customers || []).reduce((m, c) => Math.max(m, Number(c.ref) || 0), 0); }
function nextCustomerRef(data) { return Math.max(getRefStart(), maxCustomerRef(data) + 1); }

// Brand
const TEAL = "#0E7C73", TEAL_D = "#0B5F58", NAVY = "#0F2E2A", AMBER = "#F59E0B";

const ENQUIRY_STATUSES = ["New", "Surveyed", "Quoted", "Won", "Lost"];
const JOB_STATUSES = ["Provisional", "Confirmed", "Completed"];
const PROPERTY_TYPES = ["House", "Flat / Apartment", "Bungalow", "Maisonette", "Office", "Storage Unit", "Other"];
const QUOTE_STATUSES = ["Draft", "Sent", "Accepted", "Declined"];

const STATUS_META = {
  New:         { color: "#2563EB", bg: "#EFF6FF" },
  Surveyed:    { color: "#0891B2", bg: "#ECFEFF" },
  Quoted:      { color: "#D97706", bg: "#FFFBEB" },
  Won:         { color: "#059669", bg: "#ECFDF5" },
  Lost:        { color: "#DC2626", bg: "#FEF2F2" },
  Provisional: { color: "#CA8A04", bg: "#FEFCE8" },
  Confirmed:   { color: "#2563EB", bg: "#EFF6FF" },
  Booked:      { color: "#2563EB", bg: "#EFF6FF" },
  "In Progress": { color: "#2563EB", bg: "#EFF6FF" },
  Completed:   { color: "#059669", bg: "#ECFDF5" },
};

// ── Helpers ─────────────────────────────────────────────────────────────────
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function todayISO() { return new Date().toISOString().split("T")[0]; }
function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
function fmtDateShort(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
function dow(iso) {
  if (!iso) return "";
  const d = new Date(iso + (String(iso).length === 10 ? "T00:00" : ""));
  if (isNaN(d)) return "";
  return d.toLocaleDateString("en-GB", { weekday: "short" });
}
function isoAdd(iso, { days = 0, weeks = 0, months = 0 }) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00");
  if (isNaN(d)) return "";
  if (months) d.setMonth(d.getMonth() + months);
  d.setDate(d.getDate() + days + weeks * 7);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
// Next-due dates from the last-done date + interval
function nextService(m) { return m && m.serviceLast && m.serviceWeeks ? isoAdd(m.serviceLast, { weeks: Number(m.serviceWeeks) || 0 }) : ""; }
function nextMOT(m) { return m && m.motLast ? isoAdd(m.motLast, { months: 12 }) : ""; }
function nextTacho(m) { return m && m.tachoLast ? isoAdd(m.tachoLast, { months: 24 }) : ""; }
function storeSummary(e) {
  if (!e || !e.toStore) return "";
  if (e.storeMode === "Fixed date out") return e.storeOutDate ? `Into store until ${fmtUK(e.storeOutDate)}` : "Into store";
  const q = e.storeQty; return q ? `Into store for ${q} ${e.storeMode}` : `Into store (${(e.storeMode || "").toLowerCase()})`;
}
// Snap a date to the nearest given weekday (0=Sun..6=Sat), within ±3 days.
function nearestDow(iso, target) {
  const d = new Date(iso + "T00:00"); if (isNaN(d)) return iso;
  let diff = target - d.getDay();
  if (diff > 3) diff -= 7; else if (diff < -3) diff += 7;
  return isoAdd(iso, { days: diff });
}
// Push a weekend date to the following Monday.
function nextWeekday(iso) {
  const d = new Date(iso + "T00:00"); if (isNaN(d)) return iso;
  const g = d.getDay();
  if (g === 0) return isoAdd(iso, { days: 1 });
  if (g === 6) return isoAdd(iso, { days: 2 });
  return iso;
}
// Is a vehicle booked out for maintenance on a given date?
function vehOutOn(v, dateISO) {
  const b = (v && v.maint && v.maint.bookings) || [];
  return b.some(x => { if (!x.start) return false; const end = isoAdd(x.start, { days: Math.max(1, Number(x.days) || 1) - 1 }); return dateISO >= x.start && dateISO <= end; });
}
function staffOffOn(s, dateISO) {
  const b = (s && s.away) || [];
  return b.some(x => { if (!x.start) return false; const end = isoAdd(x.start, { days: Math.max(1, Number(x.days) || 1) - 1 }); return dateISO >= x.start && dateISO <= end; });
}
function staffAwayReason(s, dateISO) {
  const b = (s && s.away) || [];
  const hit = b.find(x => { if (!x.start) return false; const end = isoAdd(x.start, { days: Math.max(1, Number(x.days) || 1) - 1 }); return dateISO >= x.start && dateISO <= end; });
  return hit ? (hit.reason || "Away") : "";
}
// Map of crew-name -> why they're unavailable on a date ("Holiday"/"Sick"/… or "booked").
function crewReasonsOn(data, date, exceptJobId) {
  const m = {};
  if (!date) return m;
  (data.staff || []).forEach(s => { const r = staffAwayReason(s, date); if (r) m[s.name] = r; });
  (data.jobs || []).filter(x => x.id !== exceptJobId && ["Confirmed", "Completed"].includes(x.status)).forEach(x => jobStages(x).forEach(st => { if (st.date === date) (st.crew || []).forEach(c => { if (!m[c]) m[c] = "booked"; }); }));
  return m;
}
function fmtMonth(ym) {
  if (!ym) return "";
  const [y, m] = String(ym).split("-");
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return `${months[(+m) - 1] || ""} ${y}`.trim();
}
function gbp(n) { return "£" + (Number(n) || 0).toLocaleString("en-GB", { minimumFractionDigits: 0, maximumFractionDigits: 2 }); }

// Compute inventory totals from a list of {cuFt,m3,kg,qty}
function inventoryTotals(inv) {
  let cuFt = 0, m3 = 0, kg = 0;
  for (const it of inv || []) {
    const q = it.qty || 0;
    cuFt += (it.cuFt || 0) * q;
    m3 += (it.m3 || 0) * q;
    kg += (it.kg || 0) * q;
  }
  return { cuFt: Math.round(cuFt), m3: Math.round(m3 * 100) / 100, kg: Math.round(kg) };
}
// Canonical room ordering — always matches the inventory input fields (ROOMS),
// with Bedroom 1..N / Lounge 1..N kept in sequence and Dismantle notes last.
function roomRank(label) {
  if (!label) return 9999;
  if (label === "Dismantle / Reassemble") return 9998;
  const base = label.replace(/\s+\d+$/, "");
  const num = parseInt((label.match(/\s(\d+)$/) || [])[1] || "1", 10);
  let i = ACTIVE_ROOMS.indexOf(label);
  if (i === -1) i = ACTIVE_ROOMS.indexOf(base);
  if (i === -1) return 9997;
  return i + Math.min(num, 99) / 100;
}
function sortInventoryByRoom(inv) {
  return (inv || []).map((it, n) => [it, n]).sort((a, b) => {
    const d = roomRank(a[0].room) - roomRank(b[0].room);
    return d !== 0 ? d : a[1] - b[1];
  }).map(([it]) => it);
}
function quoteTotal(lines, vat) {
  const sub = (lines || []).reduce((s, l) => s + (Number(l.amount) || 0), 0);
  return Math.round((vat ? sub * 1.2 : sub) * 100) / 100;
}

// ── Local storage (working copy) ────────────────────────────────────────────
function loadData() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (raw) return { ...EMPTY, ...JSON.parse(raw) };
  } catch {}
  return { ...EMPTY };
}

// Add/refresh updatedAt so the newest edit wins on merge
function stampData(data) {
  const now = Date.now();
  const prev = loadData();
  const stamp = (arr, prevArr) => (arr || []).map(rec => {
    const old = (prevArr || []).find(p => p.id === rec.id);
    const a = old ? { ...old } : null; if (a) delete a.updatedAt;
    const b = { ...rec }; delete b.updatedAt;
    const changed = !old || JSON.stringify(a) !== JSON.stringify(b);
    return { ...rec, updatedAt: changed ? now : (old.updatedAt || now) };
  });
  return {
    customers: stamp(data.customers, prev.customers),
    enquiries: stamp(data.enquiries, prev.enquiries),
    jobs: stamp(data.jobs, prev.jobs),
    vehicles: stamp(data.vehicles, prev.vehicles),
    staff: stamp(data.staff, prev.staff),
  };
}

let SAVING_IN_PROGRESS = false;

// Save then reload, waiting for the cloud push first (important on mobile)
async function saveAndReload(data) {
  showSavingOverlay();
  SAVING_IN_PROGRESS = true;
  const stamped = stampData(data);
  localStorage.setItem(DB_KEY, JSON.stringify(stamped));
  try {
    await Promise.race([
      pushChangedOnly(stamped),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout after 12s")), 12000)),
    ]);
  } catch (e) {
    hideSavingOverlay();
    SAVING_IN_PROGRESS = false;
    const msg = e?.message || "";
    const offline = !navigator.onLine || /Load failed|timeout|Failed to fetch|NetworkError/.test(msg);
    if (!offline) alert("Sync problem: " + (msg || JSON.stringify(e)));
    window.location.reload();
    return;
  }
  SAVING_IN_PROGRESS = false;
  window.location.reload();
}

function showSavingOverlay() {
  if (document.getElementById("rm-saving")) return;
  const el = document.createElement("div");
  el.id = "rm-saving";
  el.style.cssText = "position:fixed;inset:0;background:rgba(15,118,110,.5);z-index:9999;display:flex;align-items:center;justify-content:center;";
  el.innerHTML = '<div style="background:#fff;border-radius:14px;padding:20px 28px;font-family:Inter,sans-serif;font-weight:700;color:#0F766E;font-size:15px;box-shadow:0 4px 20px rgba(0,0,0,.2);">💾 Saving…</div>';
  document.body.appendChild(el);
}
function hideSavingOverlay() { document.getElementById("rm-saving")?.remove(); }

// Signatures: only mark a record uploaded AFTER a genuine success
function wasUploaded(id) {
  try { return Object.prototype.hasOwnProperty.call(JSON.parse(localStorage.getItem(SIG_KEY) || "{}"), id); }
  catch { return false; }
}
// Tombstones: deleted ids can never be re-added by a merge
function addTombstone(id) {
  try {
    const t = JSON.parse(localStorage.getItem(TOMB_KEY) || "[]");
    if (!t.includes(id)) { t.push(id); localStorage.setItem(TOMB_KEY, JSON.stringify(t)); }
  } catch {}
}
function getTombstones() {
  try { return JSON.parse(localStorage.getItem(TOMB_KEY) || "[]"); } catch { return []; }
}
// Lift tombstones (used by Restore so deleted records can come back)
function removeTombstones(ids) {
  try {
    const set = new Set(ids);
    const t = (JSON.parse(localStorage.getItem(TOMB_KEY) || "[]")).filter(id => !set.has(id));
    localStorage.setItem(TOMB_KEY, JSON.stringify(t));
  } catch {}
}

// Push only changed/new records (compared against last-synced signatures)
// Signature of a record's meaningful content — excludes timestamps, which can change type
// (number vs string) on a cloud round-trip and would otherwise mark records "changed" forever.
function recSig(rec) { const { updatedAt, createdAt, ...rest } = rec; return JSON.stringify(rest); }

// One shared, throttled sync path for all the automatic triggers (focus, visibility, interval,
// realtime). Caps automatic full-database pulls to about once every 30s to keep data use low.
let LAST_SYNC_AT = 0;
async function doPullSync(setData, setSyncStatus, opts) {
  const force = opts && opts.force;
  if (SAVING_IN_PROGRESS) return;
  const ae = document.activeElement;
  if (ae && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) return; // don't disrupt an open field/picker
  const now = Date.now();
  if (!force && now - LAST_SYNC_AT < 30000) return; // throttle
  LAST_SYNC_AT = now;
  try {
    const merged = mergeAll(await pullFromCloud(), loadData());
    localStorage.setItem(DB_KEY, JSON.stringify(merged));
    pushChangedOnly(merged).catch(() => {});
    setData(prev => { try { return JSON.stringify(prev) !== JSON.stringify(merged) ? merged : prev; } catch { return merged; } });
    if (setSyncStatus) setSyncStatus("synced");
  } catch { if (setSyncStatus) setSyncStatus(navigator.onLine === false ? "offline" : "synced"); }
}

async function pushChangedOnly(data) {
  let sigs = {};
  try { sigs = JSON.parse(localStorage.getItem(SIG_KEY) || "{}"); } catch {}
  const newSigs = {};
  const changed = [];
  for (const name of TABLES) {
    for (const rec of data[name] || []) {
      const sig = dbSig(name, rec);
      if (sigs[rec.id] !== sig) changed.push({ name, rec, sig });
      else newSigs[rec.id] = sig;
    }
  }
  let failed = 0, lastError = "", failInfo = "";
  const BATCH = 6; // push several at once so many records don't take minutes
  for (let i = 0; i < changed.length; i += BATCH) {
    const slice = changed.slice(i, i + BATCH);
    const results = await Promise.allSettled(slice.map(x => pushOne(x.name, x.rec)));
    results.forEach((r, k) => {
      const x = slice[k];
      if (r.status === "fulfilled") { newSigs[x.rec.id] = x.sig; }
      else { failed++; lastError = (r.reason && r.reason.message) || String(r.reason); failInfo = `${x.name} ${x.rec.ref ? "#" + x.rec.ref : (x.rec.name || x.rec.id)}`; if (sigs[x.rec.id]) newSigs[x.rec.id] = sigs[x.rec.id]; }
    });
  }
  try { localStorage.setItem(SIG_KEY, JSON.stringify(newSigs)); } catch {}
  if (failed > 0) throw new Error(`${failed} record(s) couldn't upload (e.g. ${failInfo}): ${lastError}`);
}

// Replace or insert a record into the right table, return new data object
// Append a communication (call/text/whatsapp/email) to a customer's log without a full reload.
function logComm(customerId, entry) {
  try {
    const d = loadData();
    const cust = (d.customers || []).find(x => x.id === customerId);
    if (!cust) return;
    const comms = [...(cust.comms || []), { id: uid(), at: new Date().toISOString(), direction: "out", note: "", ...entry }];
    const d2 = upsertLocal(d, "customers", { ...cust, comms, updatedAt: Date.now() });
    try { localStorage.setItem(DB_KEY, JSON.stringify(d2)); } catch {}
    pushChangedOnly(d2).catch(() => {});
  } catch {}
}

function upsertLocal(data, table, record) {
  const arr = data[table] || [];
  const idx = arr.findIndex(r => r.id === record.id);
  const next = idx >= 0 ? arr.map(r => r.id === record.id ? record : r) : [...arr, record];
  return { ...data, [table]: next };
}

// ── Icons ───────────────────────────────────────────────────────────────────
const Icon = ({ name, size = 18, color = "currentColor" }) => {
  const paths = {
    dashboard: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6",
    enquiries: "M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 3v-3z",
    jobs: "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01",
    customers: "M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z",
    calendar: "M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z",
    plus: "M12 4v16m8-8H4", back: "M15 19l-7-7 7-7", check: "M5 13l4 4L19 7",
    truck: "M9 17a2 2 0 11-4 0 2 2 0 014 0zM19 17a2 2 0 11-4 0 2 2 0 014 0z M13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h1m8-1a1 1 0 001 1h1m-1-1V8a1 1 0 011-1h2.586a1 1 0 01.707.293l3.414 3.414a1 1 0 01.293.707V16a1 1 0 01-1 1h-1",
    box: "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4",
    trash: "M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16",
    edit: "M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z",
    quote: "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z",
    company: "M3 21h18M5 21V7l8-4v18M19 21V11l-6-4M9 9v.01M9 12v.01M9 15v.01M9 18v.01",
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d={paths[name] || ""} />
    </svg>
  );
};

// ── Shared UI ───────────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const label = status === "Won" ? "Booked" : (status === "Booked" || status === "In Progress") ? "Confirmed" : status;
  const m = STATUS_META[status] || { color: "#6B7280", bg: "#F3F4F6" };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", padding: "2px 10px", borderRadius: 99, fontSize: 12, fontWeight: 600, color: m.color, background: m.bg, border: `1px solid ${m.color}33` }}>
      {label}
    </span>
  );
}
function Field({ label, children, required, hint }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#6B7280", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>
        {label}{required && <span style={{ color: "#EF4444" }}> *</span>}
      </label>
      {children}
      {hint && <div style={{ fontSize: 12, color: "#9CA3AF", marginTop: 4 }}>{hint}</div>}
    </div>
  );
}
const inputStyle = { width: "100%", padding: "10px 13px", borderRadius: 11, border: "1.5px solid #E3E9E8", fontSize: 15, background: "#F7FAF9", boxSizing: "border-box", outline: "none", fontFamily: "inherit", color: "#10211E" };
function Input({ value, onChange, type = "text", placeholder, required, autoComplete, name, inputMode }) {
  return <input style={inputStyle} type={type} value={value ?? ""} onChange={e => onChange(e.target.value)} placeholder={placeholder} required={required} autoComplete={autoComplete} name={name} inputMode={inputMode} />;
}
function Textarea({ value, onChange, placeholder, rows = 3 }) {
  return <textarea style={{ ...inputStyle, resize: "vertical" }} rows={rows} value={value ?? ""} onChange={e => onChange(e.target.value)} placeholder={placeholder} />;
}
function Select({ value, onChange, options, placeholder }) {
  return (
    <select style={{ ...inputStyle, appearance: "none", cursor: "pointer" }} value={value ?? ""} onChange={e => onChange(e.target.value)}>
      {placeholder && <option value="">{placeholder}</option>}
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}
function DayTypeSelect({ value, onChange }) {
  const [, force] = useState(0);
  const opts = Array.from(new Set([...getDayTypes(), ...(value ? [value] : [])]));
  function addNew() {
    const t = (window.prompt("New day type (saved to your list for next time):") || "").trim();
    if (t) { addDayType(t); onChange(t); force(x => x + 1); }
  }
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
      <div style={{ flex: 1, minWidth: 0 }}><Select value={value} onChange={onChange} options={opts} placeholder="Select day type…" /></div>
      <button onClick={addNew} title="Add a new day type" style={{ flexShrink: 0, width: 44, borderRadius: 11, border: "1.5px solid #E3E9E8", background: "#F7FAF9", color: TEAL_D, fontSize: 22, fontWeight: 700, cursor: "pointer", lineHeight: 1 }}>+</button>
    </div>
  );
}
function Btn({ children, onClick, variant = "primary", size = "md", disabled, style: extra, type = "button" }) {
  const base = { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, borderRadius: 11, fontWeight: 700, cursor: disabled ? "not-allowed" : "pointer", border: "none", fontFamily: "inherit", transition: "transform .15s, opacity .15s" };
  const v = {
    primary: { background: TEAL, color: "#fff", boxShadow: "0 4px 12px rgba(14,124,115,.26)" },
    amber: { background: AMBER, color: "#fff", boxShadow: "0 4px 12px rgba(245,158,11,.30)" },
    ghost: { background: "#EEF3F2", color: TEAL_D },
    danger: { background: "#FEE2E2", color: "#DC2626" },
    grey: { background: "#EEF3F2", color: "#34433F" },
  };
  const p = size === "sm" ? { padding: "7px 13px", fontSize: 13 } : { padding: "10px 18px", fontSize: 14 };
  return <button type={type} className={size === "sm" ? "rm-btn-sm" : "rm-btn"} style={{ ...base, ...v[variant], ...p, opacity: disabled ? .5 : 1, ...extra }} onClick={onClick} disabled={disabled}>{children}</button>;
}
function Card({ children, onClick, style: extra }) {
  return <div onClick={onClick} style={{ background: "#fff", borderRadius: 16, padding: "15px 17px", boxShadow: "0 1px 2px rgba(16,33,30,.05), 0 6px 18px rgba(16,33,30,.05)", marginBottom: 11, cursor: onClick ? "pointer" : "default", border: "1px solid #E9EEED", ...extra }}>{children}</div>;
}
function Modal({ title, onClose, children, wide }) {
  return (
    <div className="rm-modal-overlay" style={{ position: "fixed", inset: 0, background: "rgba(15,46,42,.45)", zIndex: 100, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div className="rm-modal" style={{ background: "#fff", borderRadius: "22px 22px 0 0", width: "100%", maxHeight: "92vh", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "20px 20px 0", flexShrink: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: "#10211E", letterSpacing: "-.01em" }}>{title}</h3>
            <button onClick={onClose} style={{ background: "#EEF3F2", border: "none", borderRadius: 99, width: 34, height: 34, cursor: "pointer", fontSize: 18, color: "#6A7B77" }}>×</button>
          </div>
        </div>
        <div style={{ overflowY: "auto", padding: "0 20px 20px", flex: 1 }}>{children}</div>
      </div>
    </div>
  );
}
function Empty({ icon, text }) {
  return (
    <div style={{ textAlign: "center", padding: "48px 20px", color: "#94A4A0" }}>
      <div style={{ marginBottom: 10, display: "flex", justifyContent: "center" }}><Icon name={icon} size={40} color="#C4D0CD" /></div>
      <div style={{ fontSize: 14 }}>{text}</div>
    </div>
  );
}

// ── Lookups ─────────────────────────────────────────────────────────────────
function custName(data, id) {
  const c = (data.customers || []).find(x => x.id === id);
  if (!c) return "Unknown";
  const base = c.company ? `${c.name} (${c.company})` : c.name;
  return c.ref ? `#${c.ref} ${base}` : base;
}
function moveSeqOf(data, job) {
  const sib = (data.jobs || []).filter(j => j.customerId === job.customerId).sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || "") || (a.id || "").localeCompare(b.id || ""));
  const i = sib.findIndex(j => j.id === job.id);
  return i >= 0 ? i + 1 : 1;
}
function moveRef(data, job) {
  const c = (data.customers || []).find(x => x.id === job.customerId);
  const seq = moveSeqOf(data, job);
  return (c && c.ref) ? `#${c.ref}/${seq}` : `Move ${seq}`;
}
function autoCompletePastMoves(d) {
  const todayIso = todayISO();
  let changed = false;
  const jobs = (d.jobs || []).map(j => {
    if (j.status === "Completed" || j.status === "Provisional") return j;
    const dates = jobStages(j).map(s => s.date).filter(Boolean);
    if (dates.length && dates.every(dt => dt < todayIso)) { changed = true; return { ...j, status: "Completed", balancePaid: true }; }
    return j;
  });
  return changed ? { ...d, jobs } : d;
}

// ── Dashboard ───────────────────────────────────────────────────────────────
function Dashboard({ data, setView, setData }) {
  const enquiries = data.enquiries || [];
  const jobs = data.jobs || [];
  const [dashShow, setDashShow] = useState("");
  const [editFu, setEditFu] = useState(null);
  const open = enquiries.filter(e => ["New", "Surveyed", "Quoted"].includes(e.status));
  const quotesOut = enquiries.filter(e => e.status === "Quoted");
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const thisMonthEnq = enquiries.filter(e => new Date(e.createdAt).getTime() >= monthStart);
  const wonThisMonth = thisMonthEnq.filter(e => e.status === "Won").length;
  const convRate = thisMonthEnq.length ? Math.round((wonThisMonth / thisMonthEnq.length) * 100) : 0;
  const upcoming = jobs
    .filter(j => j.status !== "Completed")
    .flatMap(j => jobStages(j).filter(st => st.date && st.date > todayISO()).map(st => ({ j, st })))
    .sort((a, b) => a.st.date.localeCompare(b.st.date))
    .slice(0, 6);
  const followUps = [
    ...enquiries.filter(e => e.followUpDate && e.status !== "Lost").map(e => ({ kind: "enquiry", key: "e" + e.id, id: e.id, customerId: e.customerId, date: e.followUpDate, time: e.followUpTime || "", note: e.followUpNote, status: e.status })),
    ...(data.customers || []).filter(c => c.followUpDate).map(c => ({ kind: "customer", key: "c" + c.id, id: c.id, customerId: c.id, date: c.followUpDate, time: c.followUpTime || "", note: c.followUpNote })),
  ].sort((a, b) => ((a.date || "") + (a.time || "99:99")).localeCompare((b.date || "") + (b.time || "99:99"))).slice(0, 12);
  const custById = id => (data.customers || []).find(c => c.id === id) || {};
  const toCall = enquiries
    .filter(e => e.status === "New" && !e.surveyDate)
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  const todaysSurveys = enquiries
    .filter(e => e.surveyDate === todayISO() && e.status !== "Lost")
    .sort((a, b) => (a.surveyTime || "").localeCompare(b.surveyTime || ""));
  // Availability today
  const todayIso = todayISO();
  const todayStages = jobs.flatMap(j => jobStages(j).filter(st => st.date === todayIso));
  const todaysMoves = jobs
    .filter(j => j.status !== "Completed" && (j.moveDate === todayIso || jobStages(j).some(st => st.date === todayIso)))
    .sort((a, b) => ((jobStages(a).find(st => st.date === todayIso) || {}).time || "").localeCompare((jobStages(b).find(st => st.date === todayIso) || {}).time || ""));
  const bookedVehToday = new Set(todayStages.flatMap(st => st.vehicleIds || []));
  const todaysMovesList = todaysMoves.map(j => ({ j, st: jobStages(j).find(s => s.date === todayIso) || {} }));
  const jobLatestDate = j => { const ds = jobStages(j).map(s => s.date).filter(Boolean); return ds.length ? ds.slice().sort().slice(-1)[0] : (j.moveDate || ""); };
  const upcomingServicing = (data.vehicles || []).flatMap(v => ((v.maint && v.maint.bookings) || []).map(b => ({ v, b }))).filter(({ b }) => b.start && isoAdd(b.start, { days: Math.max(1, Number(b.days) || 1) - 1 }) >= todayIso).sort((a, c) => (a.b.start || "").localeCompare(c.b.start || ""));
  const _dNow = new Date();
  const _thisYM = `${_dNow.getFullYear()}-${String(_dNow.getMonth() + 1).padStart(2, "0")}`;
  const _nd = new Date(_dNow.getFullYear(), _dNow.getMonth() + 1, 1);
  const _nextYM = `${_nd.getFullYear()}-${String(_nd.getMonth() + 1).padStart(2, "0")}`;
  const inWindow = iso => { const ym = (iso || "").slice(0, 7); return ym === _thisYM || ym === _nextYM; };
  const pastProvisional = jobs.filter(j => j.status === "Provisional").map(j => ({ j, last: jobLatestDate(j) })).filter(x => x.last && x.last < todayIso).sort((a, b) => a.last.localeCompare(b.last));
  const changeDate = j => setView(j.enquiryId ? { screen: "enquiryDetail", id: j.enquiryId } : { screen: "jobDetail", id: j.id });
  async function removeBooking(j) {
    const nDays = jobStages(j).length;
    if (!confirm(`Remove this provisional booking for ${custName(data, j.customerId)} and its ${nDays} day${nDays !== 1 ? "s" : ""}?\n\nThe move (and its days) will be deleted. If it came from an enquiry, that enquiry goes back to "Quoted".`)) return;
    addTombstone(j.id);
    try { await deleteRecord("jobs", j.id); } catch {}
    let d = { ...data, jobs: (data.jobs || []).filter(x => x.id !== j.id) };
    if (j.enquiryId) { const en = (data.enquiries || []).find(e => e.id === j.enquiryId); if (en) d = upsertLocal(d, "enquiries", { ...en, stages: [], status: en.status === "Won" ? "Quoted" : en.status }); }
    await saveAndReload(d);
  }
  const upcomingSurveys = enquiries
    .filter(e => e.surveyDate && e.status !== "Lost" && e.surveyDate >= todayIso)
    .sort((a, b) => (a.surveyDate + (a.surveyTime || "")).localeCompare(b.surveyDate + (b.surveyTime || "")));
  const bookedStaffToday = new Set(todayStages.flatMap(st => st.crew || []));
  const vehicles = data.vehicles || [];
  const staffActive = (data.staff || []).filter(s => s.active !== false);
  const availChip = (label, booked) => (
    <span key={label} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 11px", borderRadius: 99, fontSize: 12.5, fontWeight: 700, background: booked ? "#F2F5F4" : "#E7F2F0", color: booked ? "#B7C3C0" : TEAL_D, textDecoration: booked ? "line-through" : "none", border: booked ? "1px solid #EAEFEE" : "1px solid #CDE7E2" }}>
      <span style={{ width: 8, height: 8, borderRadius: 99, background: booked ? "#C4D0CD" : "#22C55E" }} />{label}
    </span>
  );

  const Stat = ({ label, value, sub, color, onClick }) => (
    <div onClick={onClick} style={{ flex: 1, background: "#fff", borderRadius: 12, padding: "14px 12px", boxShadow: "0 1px 3px rgba(0,0,0,.07)", cursor: onClick ? "pointer" : "default", border: "1px solid #F3F4F6", minWidth: 0 }}>
      <div style={{ fontSize: 24, fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 12, color: "#6B7280", marginTop: 5, fontWeight: 600 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: "#9CA3AF", marginTop: 2 }}>{sub}</div>}
    </div>
  );

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
        <SyncControl data={data} setData={setData} compact />
      </div>
      {pastProvisional.length > 0 && (
        <Card style={{ border: "1px solid #FDE68A", background: "#FFFBEB", marginBottom: 14 }}>
          <div style={{ fontWeight: 800, color: "#92400E", marginBottom: 6, fontSize: 14 }}>Provisional bookings past their date</div>
          <div style={{ fontSize: 12.5, color: "#92400E", marginBottom: 6 }}>These moves are still provisional and their date has passed. Change the date or remove the booking.</div>
          {pastProvisional.map(({ j, last }) => (
            <div key={j.id} style={{ padding: "10px 0 4px", borderTop: "1px solid #FDE68A" }}>
              <div style={{ fontWeight: 700, color: "#10211E" }}>{custName(data, j.customerId)}</div>
              <div style={{ fontSize: 12.5, color: "#92400E", marginBottom: 8 }}>Was {fmtDate(last)} ({dow(last)}) · {jobStages(j).length} day{jobStages(j).length !== 1 ? "s" : ""}</div>
              <div style={{ display: "flex", gap: 8 }}>
                <Btn size="sm" onClick={() => changeDate(j)}>Change date</Btn>
                <Btn size="sm" variant="grey" onClick={() => removeBooking(j)} style={{ color: "#B91C1C", borderColor: "#FCA5A5" }}>Remove booking</Btn>
              </div>
            </div>
          ))}
        </Card>
      )}
      <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
        <Stat label="Open enquiries" value={open.length} color={TEAL} onClick={() => setView({ screen: "enquiries", filter: "Open" })} />
        <Stat label="Quoted" value={quotesOut.length} color={AMBER} onClick={() => setView({ screen: "enquiries", filter: "Quoted" })} />
      </div>
      <div style={{ display: "flex", gap: 10, marginBottom: 18 }}>
        <Stat label="Booked moves" value={jobs.filter(j => j.status !== "Completed").length} color="#2563EB" onClick={() => setView({ screen: "enquiries", filter: "Won" })} />
        <Stat label="Booked this month" value={`${convRate}%`} sub={`${wonThisMonth}/${thisMonthEnq.length} enquiries`} color="#059669" onClick={() => setView({ screen: "calendar", calShow: "moves", calMode: "agenda", date: todayISO() })} />
      </div>

      <Btn variant="amber" style={{ width: "100%", marginBottom: 14 }} onClick={() => setView({ screen: "newEnquiry" })}>
        <Icon name="plus" size={16} /> New Enquiry
      </Btn>

      <div style={{ display: "flex", gap: 8, marginBottom: dashShow ? 12 : 18 }}>
        <Btn variant={dashShow === "surveys" ? "primary" : "grey"} style={{ flex: 1 }} onClick={() => setDashShow(dashShow === "surveys" ? "" : "surveys")}>Surveys</Btn>
        <Btn variant={dashShow === "moves" ? "primary" : "grey"} style={{ flex: 1 }} onClick={() => setDashShow(dashShow === "moves" ? "" : "moves")}>Moves</Btn>
        <Btn variant={dashShow === "servicing" ? "primary" : "grey"} style={{ flex: 1 }} onClick={() => setDashShow(dashShow === "servicing" ? "" : "servicing")}>Servicing</Btn>
      </div>

      {(dashShow === "" || dashShow === "surveys") && (() => {
        const list = upcomingSurveys.filter(e => inWindow(e.surveyDate));
        return (
        <div style={{ marginBottom: 18 }}>
          {list.length === 0 ? <Empty icon="calendar" text="No surveys this month or next" /> : list.map(e => (
            <Card key={e.id} onClick={() => setView({ screen: "enquiryDetail", id: e.id })} style={{ borderColor: "#FBE3B3", background: "#FFFBF2" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 800, color: "#B45309", textTransform: "uppercase", letterSpacing: ".05em" }}>{fmtDate(e.surveyDate)} ({dow(e.surveyDate)}){e.surveyTime ? ` · ${e.surveyTime}` : ""}{e.surveyor ? ` · ${e.surveyor}` : ""}</div>
                  <div style={{ fontWeight: 700, color: "#10211E" }}>{custName(data, e.customerId)}</div>
                  <div style={{ fontSize: 13, color: "#6A7B77" }}>{e.fromTown || "—"} → {e.toTown || "—"}</div>
                </div>
                <StatusBadge status={e.status} />
              </div>
            </Card>
          ))}
        </div>
        );
      })()}

      {dashShow === "moves" && (
        <div style={{ marginBottom: 18 }}>
          {todaysMovesList.length === 0 ? <Empty icon="truck" text="No moves today" /> : todaysMovesList.map(({ j, st }, ix) => (
            <Card key={(j.id || "") + (st.id || ix)} onClick={() => setView(j.enquiryId ? { screen: "enquiryDetail", id: j.enquiryId } : { screen: "jobDetail", id: j.id })} style={{ borderColor: "#CDE7E2", background: "#F3FAF8" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 800, color: TEAL_D, textTransform: "uppercase", letterSpacing: ".05em" }}>{fmtDate(st.date)} ({dow(st.date)}){st.time ? ` · ${st.time}` : ""}{st.type ? ` · ${st.type}` : ""}</div>
                  <div style={{ fontWeight: 700, color: "#10211E" }}>{custName(data, j.customerId)}</div>
                  <div style={{ fontSize: 13, color: "#6A7B77" }}>{j.fromTown || "—"} → {j.toTown || "—"}</div>
                </div>
                <StatusBadge status={j.status} />
              </div>
            </Card>
          ))}
        </div>
      )}

      {(dashShow === "" || dashShow === "servicing") && (() => {
        const list = upcomingServicing.filter(({ b }) => inWindow(b.start));
        if (dashShow === "" && list.length === 0) return null;
        return (
        <>
          {dashShow === "" && <SectionTitle>Upcoming servicing</SectionTitle>}
          <div style={{ marginBottom: 18 }}>
            {list.length === 0 ? <Empty icon="truck" text="No servicing this month or next" /> : list.map(({ v, b }, ix) => (
              <Card key={ix} onClick={() => setView({ screen: "calendar", calMode: "day", date: b.start })} style={{ borderColor: "#D3DEEA", background: "#F3F6FA" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 800, color: "#475569", textTransform: "uppercase", letterSpacing: ".05em" }}>{b.type}{b.days > 1 ? ` · ${b.days} days` : ""}</div>
                    <div style={{ fontWeight: 700, color: "#10211E" }}>{v.name}</div>
                    <div style={{ fontSize: 13, color: "#6A7B77" }}>{fmtDate(b.start)} ({dow(b.start)})</div>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </>
        );
      })()}

      {toCall.length > 0 && (
        <>
          <SectionTitle>To call ({toCall.length})</SectionTitle>
          {toCall.map(e => {
            const c = custById(e.customerId);
            const route = [e.fromPostcode || e.fromTown, e.toPostcode || e.toTown].filter(Boolean).join(" → ");
            const when = e.preferredDate ? fmtDateShort(e.preferredDate) : (e.moveMonth ? fmtMonth(e.moveMonth) : "");
            return (
              <Card key={e.id} onClick={() => setView({ screen: "enquiryDetail", id: e.id })} style={{ borderColor: "#CDE7E2", background: "#F4FBF9" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, color: "#10211E" }}>{custName(data, e.customerId)}</div>
                    <div style={{ fontSize: 13, color: "#6A7B77", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{route || "New enquiry — survey not booked"}</div>
                    {when && <div style={{ fontSize: 12, color: "#9CA3AF" }}>Move: {when}{e.dateFlexible ? " (flexible)" : ""}</div>}
                  </div>
                  {c.phone
                    ? <a href={`tel:${c.phone}`} onClick={ev => ev.stopPropagation()} style={{ flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 99, background: TEAL, color: "#fff", fontWeight: 700, fontSize: 13, textDecoration: "none" }}>Call</a>
                    : <span style={{ flexShrink: 0, fontSize: 12, color: "#B7C3C0" }}>No number</span>}
                </div>
              </Card>
            );
          })}
        </>
      )}

      {followUps.length > 0 && (
        <>
          <SectionTitle>Follow-ups — to call</SectionTitle>
          {followUps.map(fu => {
            const overdue = (fu.date + (fu.time || "")) <= (todayISO() + "23:59") && fu.date <= todayISO();
            const cust = (data.customers || []).find(x => x.id === fu.customerId);
            const phone = cust && (cust.phone || cust.homePhone);
            const email = cust && cust.email;
            const noteL = (fu.note || "").toLowerCase();
            const wantsCall = /call|phone|ring/.test(noteL);
            const wantsText = /text|sms|whats ?app|message/.test(noteL);
            const wantsEmail = /email|e-mail/.test(noteL);
            const showText = wantsText && phone;
            const showEmail = wantsEmail && email;
            const showCall = phone && (wantsCall || (!showText && !showEmail));
            const btn = (bg, label, onTap) => <button onClick={ev => { ev.stopPropagation(); onTap(); }} style={{ display: "inline-flex", alignItems: "center", gap: 4, background: bg, border: "none", borderRadius: 999, padding: "6px 12px", fontSize: 12.5, fontWeight: 800, color: "#fff", cursor: "pointer" }}>{label}</button>;
            return (
              <Card key={fu.key} onClick={() => setView(fu.kind === "enquiry" ? { screen: "enquiryDetail", id: fu.id } : { screen: "customerDetail", id: fu.id })} style={overdue ? { borderColor: "#FBD9A0", background: "#FFFBF2" } : undefined}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, color: "#10211E" }}>{custName(data, fu.customerId)}</div>
                    <div style={{ fontSize: 13, color: "#6A7B77" }}>{fu.note || "Follow up"}{fu.kind === "customer" ? " · customer" : ""}</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: overdue ? "#B45309" : "#6A7B77", marginTop: 2 }}>{overdue ? "Due " : ""}{fmtUK(fu.date)}{fu.time ? ` · ${fu.time}` : ""}</div>
                    <button onClick={ev => { ev.stopPropagation(); const rec = fu.kind === "enquiry" ? (data.enquiries || []).find(x => x.id === fu.id) : (data.customers || []).find(x => x.id === fu.id); if (rec) setEditFu({ record: rec, table: fu.kind === "enquiry" ? "enquiries" : "customers" }); }} style={{ background: "none", border: "none", color: TEAL, fontSize: 12, fontWeight: 700, cursor: "pointer", padding: "4px 0 0" }}>Edit / reschedule</button>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flexShrink: 0 }}>
                    {fu.kind === "enquiry" && <StatusBadge status={fu.status} />}
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                      {showCall && btn("#0E7C73", "📞 Call", () => { logComm(fu.customerId, { type: "Call" }); window.location.href = `tel:${phone}`; })}
                      {showText && btn("#2563EB", "💬 Text", () => { logComm(fu.customerId, { type: "Text" }); window.location.href = `sms:${phone}`; })}
                      {showEmail && btn("#6B7280", "📧 Email", () => { logComm(fu.customerId, { type: "Email" }); window.location.href = `mailto:${email}`; })}
                      {!phone && !email && <span style={{ fontSize: 11.5, color: "#B7C3C0" }}>No contact saved</span>}
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
        </>
      )}

      {editFu && <FollowUpModal data={data} record={editFu.record} table={editFu.table} onClose={() => setEditFu(null)} />}

      {dashShow !== "surveys" && dashShow !== "servicing" && (() => {
        const list = upcoming.filter(({ st }) => inWindow(st.date));
        return (
        <>
          <SectionTitle>Upcoming moves</SectionTitle>
          {list.length === 0 && <Empty icon="truck" text="No moves this month or next" />}
          {list.map(({ j, st }, ix) => (
            <Card key={(j.id || "") + (st.id || ix)} onClick={() => setView(j.enquiryId ? { screen: "enquiryDetail", id: j.enquiryId } : { screen: "jobDetail", id: j.id })}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 800, color: TEAL_D, textTransform: "uppercase", letterSpacing: ".05em" }}>{st.type || "Move"}{st.time ? ` · ${st.time}` : ""}</div>
                  <div style={{ fontWeight: 700, color: "#10211E" }}>{custName(data, j.customerId)}</div>
                  <div style={{ fontSize: 13, color: "#6A7B77" }}>{fmtDate(st.date)} ({dow(st.date)}) · {j.fromTown || "—"} → {j.toTown || "—"}</div>
                </div>
                <StatusBadge status={j.status} />
              </div>
            </Card>
          ))}
        </>
        );
      })()}
    </div>
  );
}
function SectionTitle({ children }) {
  return <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", margin: "18px 0 8px", textTransform: "uppercase", letterSpacing: "0.05em" }}>{children}</div>;
}

// ── Enquiries list ──────────────────────────────────────────────────────────
function EnquiriesList({ data, setView, initialFilter }) {
  const [filter, setFilter] = useState(initialFilter || "Surveyed");
  const enquiries = data.enquiries || [];
  const filters = [...ENQUIRY_STATUSES, "All"];
  const moveCompleted = e => (data.jobs || []).some(j => j.enquiryId === e.id && j.status === "Completed");
  const moveOf = e => (data.jobs || []).find(j => j.enquiryId === e.id);
  const moveDateOf = e => { const j = moveOf(e); return (j && jobMoveDate(j)) || "9999-99"; };
  const surveyedCount = enquiries.filter(e => e.status === "Surveyed").length;
  const shown = enquiries
    .filter(e => !moveCompleted(e))
    .filter(e => filter === "All" ? true : filter === "Open" ? ["New", "Surveyed", "Quoted"].includes(e.status) : e.status === filter)
    .sort((a, b) => filter === "Won"
      ? moveDateOf(a).localeCompare(moveDateOf(b))
      : (b.createdAt || "").localeCompare(a.createdAt || ""));

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: "#111827" }}>Enquiries</h2>
        <Btn size="sm" onClick={() => setView({ screen: "newEnquiry" })}><Icon name="plus" size={14} /> New</Btn>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4, background: "#E9EDEC", borderRadius: 14, padding: 4, marginBottom: 12 }}>
        {filters.map(f => {
          const active = filter === f;
          const alert = f === "Surveyed" && surveyedCount > 0;
          return (
            <button key={f} onClick={() => setFilter(f)} style={{
              padding: "9px 4px", borderRadius: 10, border: "none", cursor: "pointer",
              fontSize: 13.5, fontWeight: active ? 700 : 600, transition: "all .15s",
              background: active ? "#fff" : "transparent",
              color: active ? (alert ? "#DC2626" : NAVY) : (alert ? "#DC2626" : "#6B7280"),
              boxShadow: active ? "0 1px 4px rgba(15,46,42,.12)" : "none",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
            }}>
              {f === "Won" ? "Booked" : f}
              {alert ? <span style={{ fontSize: 11, fontWeight: 700, color: "#fff", background: "#DC2626", borderRadius: 99, minWidth: 16, height: 16, lineHeight: "16px", padding: "0 4px", textAlign: "center" }}>{surveyedCount}</span> : null}
            </button>
          );
        })}
      </div>
      {shown.length === 0 && <Empty icon="enquiries" text="No enquiries here" />}
      {shown.map(e => (
        <Card key={e.id} onClick={() => setView({ screen: "enquiryDetail", id: e.id })}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, color: "#111827" }}>{custName(data, e.customerId)}</div>
              <div style={{ fontSize: 13, color: "#6B7280", marginTop: 2 }}>{e.fromTown || "—"} → {e.toTown || "—"}</div>
              <div style={{ fontSize: 12, color: "#9CA3AF", marginTop: 2 }}>
                {(() => { const j = moveOf(e); const md = j && jobMoveDate(j); return md ? "Move " + fmtDate(md) : (e.preferredDate ? fmtDate(e.preferredDate) : "Date TBC"); })()}
                {e.volumeCuFt ? ` · ${e.volumeCuFt} cu ft` : ""}
                {e.quoteTotal ? ` · ${gbp(e.quoteTotal)}` : ""}
              </div>
            </div>
            <StatusBadge status={(() => { const j = (data.jobs || []).find(x => x.enquiryId === e.id); return j ? j.status : e.status; })()} />
          </div>
        </Card>
      ))}
    </div>
  );
}

// ── Customer picker (existing or add new inline) ────────────────────────────
function CustomerPicker({ data, customerId, onPick, newCust, setNewCust }) {
  const [mode, setMode] = useState(customerId ? "existing" : (newCust && newCust.name) ? "new" : (data.customers || []).length ? "existing" : "new");
  const [q, setQ] = useState("");
  const customers = [...(data.customers || [])].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const selected = customers.find(c => c.id === customerId);
  const listRef = useRef(null);
  const norm = s => (s || "").toLowerCase();
  const filtered = q.trim() ? customers.filter(c => `${c.name || ""} ${c.company || ""} ${c.phone || ""} ${c.homePhone || ""} ${c.town || ""} ${c.postcode || ""} ${c.ref ? "#" + c.ref + " " + c.ref : ""}`.toLowerCase().includes(norm(q.trim()))).slice(0, 50) : [];
  const groups = {};
  customers.forEach(c => { const ch = (c.name || "#").trim().charAt(0).toUpperCase(); const key = /[A-Z]/.test(ch) ? ch : "#"; (groups[key] = groups[key] || []).push(c); });
  const letters = Object.keys(groups).sort();
  const jumpTo = L => { const el = listRef.current && listRef.current.querySelector(`[data-letter="${L}"]`); if (el) el.scrollIntoView({ block: "start", behavior: "smooth" }); };
  const Row = ({ c }) => (
    <div onClick={() => { onPick(c.id); setQ(""); }} style={{ padding: "9px 11px", borderRadius: 8, cursor: "pointer", background: "#fff", border: "1px solid #EFF2F1", marginBottom: 6 }}>
      <div style={{ fontWeight: 600, fontSize: 14, color: "#111827" }}>{c.ref ? <span style={{ color: TEAL_D, fontWeight: 800 }}>#{c.ref} </span> : ""}{c.name}</div>
      <div style={{ fontSize: 12, color: "#9CA3AF" }}>{[c.company, c.phone, c.town, c.postcode].filter(Boolean).join(" · ") || "—"}</div>
    </div>
  );
  return (
    <div style={{ background: "#F9FAFB", borderRadius: 10, padding: 12, marginBottom: 14, border: "1px solid #F3F4F6" }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <Btn size="sm" variant={mode === "existing" ? "primary" : "grey"} onClick={() => setMode("existing")}>Existing customer</Btn>
        <Btn size="sm" variant={mode === "new" ? "primary" : "grey"} onClick={() => { setMode("new"); onPick(""); }}>New customer</Btn>
      </div>
      {mode === "existing" ? (
        selected && !q ? (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#fff", border: "1px solid #E3E9E8", borderRadius: 10, padding: "10px 12px" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700, color: "#111827" }}>{selected.name}</div>
              <div style={{ fontSize: 12, color: "#9CA3AF" }}>{[selected.company, selected.phone, selected.town].filter(Boolean).join(" · ")}</div>
            </div>
            <Btn size="sm" variant="grey" onClick={() => onPick("")}>Change</Btn>
          </div>
        ) : (
          <div>
            <Input value={q} onChange={setQ} placeholder="Search name, ref #, phone, postcode…" />
            {q.trim() ? (
              <div style={{ marginTop: 8, maxHeight: 300, overflowY: "auto" }}>
                {filtered.length === 0 ? <div style={{ fontSize: 13, color: "#9CA3AF", padding: "8px 4px" }}>No matches</div>
                  : filtered.map(c => <Row key={c.id} c={c} />)}
              </div>
            ) : (
              <div style={{ position: "relative", marginTop: 8 }}>
                <div ref={listRef} style={{ maxHeight: 320, overflowY: "auto", paddingRight: 20 }}>
                  {customers.length === 0 ? <div style={{ fontSize: 13, color: "#9CA3AF", padding: "8px 4px" }}>No customers yet</div>
                    : letters.map(L => (
                      <div key={L} data-letter={L}>
                        <div style={{ position: "sticky", top: 0, background: "#F9FAFB", fontSize: 11, fontWeight: 800, color: "#94A4A0", padding: "4px 6px", zIndex: 1 }}>{L}</div>
                        {groups[L].map(c => <Row key={c.id} c={c} />)}
                      </div>
                    ))}
                </div>
                {letters.length > 1 && (
                  <div style={{ position: "absolute", top: 0, right: 0, bottom: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 1 }}>
                    {letters.map(L => <button key={L} onClick={() => jumpTo(L)} style={{ fontSize: 10, color: TEAL, fontWeight: 800, lineHeight: 1.05, padding: "1px 3px", background: "none", border: "none", cursor: "pointer" }}>{L}</button>)}
                  </div>
                )}
              </div>
            )}
          </div>
        )
      ) : (
        <div>
          <Input value={newCust.name} onChange={v => setNewCust({ ...newCust, name: v })} placeholder="Full name *" />
          <div style={{ height: 8 }} />
          <Input value={newCust.phone} onChange={v => setNewCust({ ...newCust, phone: v })} placeholder="Mobile phone" />
          <div style={{ height: 8 }} />
          <Input value={newCust.email} onChange={v => setNewCust({ ...newCust, email: v })} placeholder="Email" type="email" />
        </div>
      )}
    </div>
  );
}

// ── Enquiry form (create / edit) ────────────────────────────────────────────
const EMAIL_MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
function monthNameToYM(name) {
  const idx = EMAIL_MONTHS.indexOf((name || "").toLowerCase());
  if (idx < 0) return "";
  const now = new Date();
  let y = now.getFullYear();
  if (idx < now.getMonth()) y += 1;
  return `${y}-${String(idx + 1).padStart(2, "0")}`;
}
function stripEmailHtml(html) {
  return (html || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li|h[1-6]|td|th|table)>/gi, "\n").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#39;/g, "'").replace(/&quot;/gi, '"').replace(/[ \t]+/g, " ");
}
const EMAIL_LABELS = ["Exact Move Date", "How did you here of us", "How did you hear of us", "How did you hear", "Special Requirements", "Special Requirement", "Post Code", "Postcode", "Bedrooms", "Furnished", "Property Type", "Property", "Address Line 1", "Address", "Storage", "Packing", "Access", "Source", "Email", "Phone", "Mobile", "Title", "Name", "City", "Town", "From", "To"];
function normalizeEmailLabels(t) {
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const L of EMAIL_LABELS) t = t.replace(new RegExp("[ \\t]*\\b" + esc(L) + "[ \\t]*:", "gi"), "\n" + L + ":");
  return t.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").trim();
}
function repairLabelValueLines(t) {
  const lines = t.split("\n").map(l => l.trim()).filter(l => l !== "");
  const bareLabel = l => { const m = l.match(/^([A-Za-z][A-Za-z /]*?)\s*:\s*$/); return m ? m[1].toLowerCase() : null; };
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const bl = bareLabel(lines[i]);
    if (bl && bl !== "from" && bl !== "to") {
      const nxt = lines[i + 1];
      if (nxt && bareLabel(nxt) === null && !/^(from|to)\s*:?\s*$/i.test(nxt)) { out.push(lines[i].replace(/\s*$/, "") + " " + nxt); i++; continue; }
    }
    out.push(lines[i]);
  }
  return out.join("\n");
}
function parseEnquiryEmail(text) {
  let t = (text || "").replace(/\r/g, "");
  if (/<[a-z!\/][^>]*>/i.test(t)) t = stripEmailHtml(t);
  t = repairLabelValueLines(normalizeEmailLabels(t));
  const out = { name: "", email: "", phone: "", fromAddress1: "", fromTown: "", fromPostcode: "", fromAccess: "", fromPropertyType: "", fromBedrooms: "", toAddress1: "", toTown: "", toPostcode: "", toAccess: "", toPropertyType: "", preferredDate: "", moveMonth: "", dateFlexible: false, notes: "" };
  const PC = /[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}/i;
  const PCG = /[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}/gi;
  const em = t.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i); if (em) out.email = em[0];
  const ph = t.match(/(\+?44|0)[\d\s()-]{8,13}\d/); if (ph) { let p = ph[0].replace(/[()\s-]/g, ""); if (p.startsWith("+44")) p = "0" + p.slice(3); out.phone = p; }
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fieldIn = (block, labels) => { for (const L of labels) { const m = block.match(new RegExp("^[ \\t]*" + esc(L) + "[ \\t]*:[ \\t]*(.+?)[ \\t]*$", "im")); if (m && m[1].trim()) return m[1].trim(); } return ""; };

  // Split into top / From / To sections when the form uses "From:" / "To:" headers
  let topBlock = t, fromBlock = "", toBlock = "", sectioned = false;
  const mFrom = t.match(/^[ \t]*from[ \t]*:?[ \t]*$/im);
  const mTo = t.match(/^[ \t]*to[ \t]*:?[ \t]*$/im);
  if (mFrom && mTo && mFrom.index < mTo.index) {
    sectioned = true;
    topBlock = t.slice(0, mFrom.index);
    fromBlock = t.slice(mFrom.index + mFrom[0].length, mTo.index);
    toBlock = t.slice(mTo.index + mTo[0].length);
  }

  const title = fieldIn(topBlock, ["title"]);
  const nm = fieldIn(topBlock, ["name", "customer name", "full name", "client name", "contact name", "your name"]);
  out.name = [title, nm].filter(Boolean).join(" ").trim();

  const splitPC = line => { if (!line) return ["", ""]; const m = line.match(PC); const pc = m ? m[0].toUpperCase().replace(/\s+/g, " ") : ""; const rest = line.replace(PC, "").replace(/[,\s]+$/, "").trim(); return [rest, pc]; };
  let fromBeds = "", toBeds = "", fromFurn = "";
  if (sectioned) {
    out.fromAddress1 = fieldIn(fromBlock, ["address", "address line 1", "street", "house"]);
    out.fromTown = fieldIn(fromBlock, ["city", "town"]);
    out.fromPostcode = (fieldIn(fromBlock, ["post code", "postcode"]) || "").toUpperCase().replace(/\s+/g, " ");
    out.fromAccess = fieldIn(fromBlock, ["access"]);
    out.fromPropertyType = fieldIn(fromBlock, ["property", "property type"]);
    out.fromBedrooms = fromBeds = fieldIn(fromBlock, ["bedrooms", "beds"]);
    fromFurn = fieldIn(fromBlock, ["furnished"]);
    out.toAddress1 = fieldIn(toBlock, ["address", "address line 1", "street", "house"]);
    out.toTown = fieldIn(toBlock, ["city", "town"]);
    out.toPostcode = (fieldIn(toBlock, ["post code", "postcode"]) || "").toUpperCase().replace(/\s+/g, " ");
    out.toAccess = fieldIn(toBlock, ["access"]);
    out.toPropertyType = fieldIn(toBlock, ["property", "property type"]);
    toBeds = fieldIn(toBlock, ["bedrooms", "beds"]);
  } else {
    const fromLine = fieldIn(t, ["moving from", "move from", "collection address", "collection", "current address", "from address", "pickup", "from"]);
    const toLine = fieldIn(t, ["moving to", "move to", "delivery address", "delivery", "destination", "to address", "drop off", "to"]);
    const [fa, fpc] = splitPC(fromLine); const [ta, tpc] = splitPC(toLine);
    const allPC = (t.match(PCG) || []).map(s => s.toUpperCase().replace(/\s+/g, " "));
    out.fromAddress1 = fa; out.toAddress1 = ta;
    out.fromPostcode = fpc || allPC[0] || ""; out.toPostcode = tpc || allPC[1] || "";
    out.fromTown = fieldIn(t, ["from town", "from city"]); out.toTown = fieldIn(t, ["to town", "to city", "destination town"]);
  }

  // Move date / month
  const moveVal = fieldIn(topBlock, ["exact move date", "move date", "moving date", "preferred date", "preferred move date", "date"]);
  const dm = (moveVal || t).match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (dm) { let y = dm[3]; if (y.length === 2) y = "20" + y; out.preferredDate = `${y.padStart(4, "0")}-${dm[2].padStart(2, "0")}-${dm[1].padStart(2, "0")}`; }
  if (!out.preferredDate) { const mm = (moveVal || "").match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i); if (mm) out.moveMonth = monthNameToYM(mm[1]); }
  if (!out.preferredDate && /\bno\b/i.test(moveVal)) out.dateFlexible = true;

  if (!out.name && out.email) out.name = out.email.split("@")[0].replace(/[._\-]+/g, " ").replace(/\b\w/g, ch => ch.toUpperCase()).trim();

  // Tidy notes from the extra fields (so nothing is lost)
  const extras = [];
  const add = (label, val) => { if (val && val.trim()) extras.push(`${label}: ${val.trim()}`); };
  add("Packing", fieldIn(topBlock, ["packing"]));
  add("Storage", fieldIn(topBlock, ["storage"]));
  add("Heard via", fieldIn(topBlock, ["how did you here of us", "how did you hear of us", "how did you hear", "source", "referral"]));
  add("Special requirements", fieldIn(topBlock, ["special requirements", "special requirement", "requirements"]));
  const fromProp = [out.fromPropertyType, fromBeds ? `${fromBeds} bed` : "", fromFurn].filter(Boolean).join(", ");
  const toProp = [out.toPropertyType, toBeds ? `${toBeds} bed` : ""].filter(Boolean).join(", ");
  add("From property", fromProp);
  add("To property", toProp);
  out.notes = extras.length ? extras.join("\n") : t.trim().slice(0, 1200);
  return out;
}

function EnquiryForm({ data, onClose, editEnquiry, initialCustomerId }) {
  const e = editEnquiry || {};
  const [customerId, setCustomerId] = useState(e.customerId || initialCustomerId || "");
  useEffect(() => { if (!e.id && initialCustomerId) selectCustomer(initialCustomerId); /* eslint-disable-next-line */ }, []);
  const [newCust, setNewCust] = useState({ name: "", phone: "", email: "" });
  const [f, setF] = useState({
    preferredDate: e.preferredDate || "", dateFlexible: e.dateFlexible || false, moveMonth: e.moveMonth || "",
    surveyDate: e.surveyDate || "", surveyTime: e.surveyTime || "",
    fromAddress1: e.fromAddress1 || "", fromAddress2: e.fromAddress2 || "", fromTown: e.fromTown || "", fromPostcode: e.fromPostcode || "",
    fromPropertyType: e.fromPropertyType || "", fromBedrooms: e.fromBedrooms || "", fromFloor: e.fromFloor || "", fromAccess: e.fromAccess || "",
    toAddress1: e.toAddress1 || "", toAddress2: e.toAddress2 || "", toTown: e.toTown || "", toPostcode: e.toPostcode || "",
    toStore: !!e.toStore, storeMode: e.storeMode || "Weeks", storeQty: e.storeQty ?? "", storeOutDate: e.storeOutDate || "",
    toPropertyType: e.toPropertyType || "", toFloor: e.toFloor || "", toAccess: e.toAccess || "",
    notes: e.notes || "", stages: Array.isArray(e.stages) ? e.stages : [],
    surveyor: e.surveyor || "",
    exchanged: e.exchanged || false,
  });
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pickerKey, setPickerKey] = useState(0);
  const autofill = () => {
    const p = parseEnquiryEmail(pasteText);
    setNewCust({ name: p.name || "", phone: p.phone || "", email: p.email || "" });
    setCustomerId("");
    setF(prev => ({ ...prev,
      fromAddress1: p.fromAddress1 || prev.fromAddress1, fromTown: p.fromTown || prev.fromTown, fromPostcode: p.fromPostcode || prev.fromPostcode,
      fromAccess: p.fromAccess || prev.fromAccess, fromPropertyType: p.fromPropertyType || prev.fromPropertyType, fromBedrooms: p.fromBedrooms || prev.fromBedrooms,
      toAddress1: p.toAddress1 || prev.toAddress1, toTown: p.toTown || prev.toTown, toPostcode: p.toPostcode || prev.toPostcode,
      toAccess: p.toAccess || prev.toAccess, toPropertyType: p.toPropertyType || prev.toPropertyType,
      preferredDate: p.preferredDate || prev.preferredDate, moveMonth: p.moveMonth || prev.moveMonth,
      dateFlexible: p.dateFlexible || prev.dateFlexible,
      notes: prev.notes ? prev.notes : p.notes,
    }));
    setPickerKey(k => k + 1);
    setPasteOpen(false);
  };

  // When an existing customer is picked, prefill "moving from":
  // their last move's TO address if they've moved before, else their stored address.
  function selectCustomer(cid) {
    setCustomerId(cid);
    if (!cid) return;
    const cust = (data.customers || []).find(c => c.id === cid);
    const pastMoves = (data.jobs || [])
      .filter(jb => jb.customerId === cid && (jb.toAddress1 || jb.toTown || jb.toPostcode))
      .sort((a, b) => (b.moveDate || b.createdAt || "").localeCompare(a.moveDate || a.createdAt || ""));
    let a1 = "", a2 = "", town = "", pc = "";
    if (pastMoves[0]) { a1 = pastMoves[0].toAddress1 || ""; a2 = pastMoves[0].toAddress2 || ""; town = pastMoves[0].toTown || ""; pc = pastMoves[0].toPostcode || ""; }
    else if (cust) { a1 = cust.address1 || ""; a2 = cust.address2 || ""; town = cust.town || ""; pc = cust.postcode || ""; }
    setF(p => ({ ...p, fromAddress1: a1, fromAddress2: a2, fromTown: town, fromPostcode: pc }));
  }

  async function save() {
    let data2 = data;
    let cid = customerId;
    if (f.exchanged && !f.preferredDate) { alert("This move is marked as exchanged — please set the confirmed move date."); return; }
    if (!cid) {
      if (!newCust.name.trim()) { alert("Enter a customer name (or pick an existing customer)."); return; }
      cid = uid();
      const customer = { id: cid, name: newCust.name.trim(), company: "", phone: newCust.phone, email: newCust.email, address1: f.fromAddress1 || "", address2: f.fromAddress2 || "", town: f.fromTown || "", postcode: f.fromPostcode || "", custType: "Private", ref: null, createdAt: new Date().toISOString() };
      data2 = upsertLocal(data2, "customers", customer);
    }
    const rec = {
      id: e.id || uid(), customerId: cid,
      status: e.status || "New",
      enquiryDate: e.enquiryDate || todayISO(),
      ...f,
      inventory: e.inventory || [], volumeCuFt: e.volumeCuFt || 0, volumeM3: e.volumeM3 || 0, weightKg: e.weightKg || 0,
      extras: e.extras || [], quoteLines: e.quoteLines || [], quoteVat: e.quoteVat || false,
      quoteTotal: e.quoteTotal || 0, quoteStatus: e.quoteStatus || "Draft", quoteSentDate: e.quoteSentDate || "",
      followUpDate: e.followUpDate || "", followUpNote: e.followUpNote || "", lostReason: e.lostReason || "",
      createdAt: e.createdAt || new Date().toISOString(),
    };
    data2 = upsertLocal(data2, "enquiries", rec);
    try { sessionStorage.setItem("removals_view", JSON.stringify(e.id ? { screen: "enquiryDetail", id: e.id } : { screen: "dashboard" })); } catch {}
    await saveAndReload(data2);
  }

  return (
    <Modal title={e.id ? "Edit Enquiry" : "New Enquiry"} onClose={onClose}>
      {!e.id && (
        <Field label="Customer" required>
          {!pasteOpen
            ? <Btn size="sm" variant="grey" style={{ marginBottom: 10 }} onClick={() => setPasteOpen(true)}><Icon name="mail" size={14} /> Paste enquiry email to autofill</Btn>
            : <div style={{ background: "#F9FAFB", border: "1px solid #F3F4F6", borderRadius: 10, padding: 12, marginBottom: 10 }}>
                <div style={{ fontSize: 12.5, color: "#374151", marginBottom: 8 }}>Paste the enquiry email and I'll pull out the name, contact details, postcodes and move date. Check everything before saving.</div>
                <Textarea value={pasteText} onChange={setPasteText} rows={6} placeholder="Paste the full email here…" />
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <Btn size="sm" variant="grey" onClick={() => setPasteOpen(false)}>Cancel</Btn>
                  <Btn size="sm" onClick={autofill} disabled={!pasteText.trim()}>Autofill</Btn>
                </div>
              </div>}
          <CustomerPicker key={pickerKey} data={data} customerId={customerId} onPick={selectCustomer} newCust={newCust} setNewCust={setNewCust} />
        </Field>
      )}

      <SectionTitle>Move details</SectionTitle>
      <Field label="Preferred move date">
        <Input type="date" value={f.preferredDate} onChange={v => set("preferredDate", v)} />
        {(f.preferredDate || f.moveMonth) && <button onClick={() => setF(p => ({ ...p, preferredDate: "", moveMonth: "" }))} style={{ background: "transparent", border: "none", color: "#DC2626", fontWeight: 600, fontSize: 12, cursor: "pointer", padding: "4px 0 0" }}>Remove move date</button>}
      </Field>
      <Field label="Or month of move" hint="If no exact date is known yet">
        <select style={{ ...inputStyle, appearance: "none", cursor: "pointer" }} value={f.moveMonth || ""} onChange={ev => set("moveMonth", ev.target.value)}>
          <option value="">Select a month…</option>
          {Array.from({ length: 18 }, (_, i) => {
            const dt = new Date(new Date().getFullYear(), new Date().getMonth() + i, 1);
            const ym = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
            return <option key={ym} value={ym}>{fmtMonth(ym)}</option>;
          })}
        </select>
      </Field>
      <Field label="Survey date" hint="Leave blank until booked — shows as 'To call' on the dashboard">
        <Input type="date" value={f.surveyDate} onChange={v => set("surveyDate", v)} />
        {(f.surveyDate || f.surveyTime) && <button onClick={() => setF(p => ({ ...p, surveyDate: "", surveyTime: "" }))} style={{ background: "transparent", border: "none", color: "#DC2626", fontWeight: 600, fontSize: 12, cursor: "pointer", padding: "4px 0 0" }}>Remove survey date</button>}
      </Field>
      <Field label="Survey time"><Input type="time" value={f.surveyTime} onChange={v => set("surveyTime", v)} /></Field>
      <Field label="Surveyor">
        <Select value={f.surveyor} onChange={v => set("surveyor", v)} placeholder="Select surveyor…"
          options={Array.from(new Set([...(data.staff || []).filter(s => s.role === "Surveyor").map(s => s.name), f.surveyor].filter(Boolean)))} />
      </Field>
      <Field label="Exchanged?">
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "#374151", cursor: "pointer" }}>
          <input type="checkbox" checked={f.exchanged} onChange={ev => setF(p => ({ ...p, exchanged: ev.target.checked, dateFlexible: ev.target.checked ? false : p.dateFlexible }))} style={{ width: 18, height: 18 }} /> Contracts exchanged — move date confirmed
        </label>
        {f.exchanged && !f.preferredDate && <div style={{ fontSize: 12, color: "#DC2626", marginTop: 6 }}>Set the confirmed move date above.</div>}
      </Field>
      {!f.exchanged && (
        <Field label="Dates flexible?">
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "#374151", cursor: "pointer" }}>
            <input type="checkbox" checked={f.dateFlexible} onChange={ev => set("dateFlexible", ev.target.checked)} style={{ width: 18, height: 18 }} /> Flexible on dates
          </label>
        </Field>
      )}

      <SectionTitle>Moving from</SectionTitle>
      {customerId && (f.fromAddress1 || f.fromTown || f.fromPostcode) && (
        <div style={{ fontSize: 12, color: TEAL_D, background: "#EAF4F2", borderRadius: 9, padding: "8px 11px", marginBottom: 10 }}>
          Prefilled from {(data.jobs || []).some(jb => jb.customerId === customerId && (jb.toAddress1 || jb.toTown)) ? "their last move" : "their saved address"} — edit if needed.
        </div>
      )}
      <Field label="Address"><Input value={f.fromAddress1} onChange={v => set("fromAddress1", v)} placeholder="House/flat & street" /></Field>
      <Field label="Address line 2"><Input value={f.fromAddress2} onChange={v => set("fromAddress2", v)} placeholder="(optional)" /></Field>
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}><Field label="Town"><Input value={f.fromTown} onChange={v => set("fromTown", v)} /></Field></div>
        <div style={{ width: 120 }}><Field label="Postcode"><Input value={f.fromPostcode} onChange={v => set("fromPostcode", v)} /></Field></div>
      </div>
      <Field label="Property type"><Select value={f.fromPropertyType} onChange={v => set("fromPropertyType", v)} options={PROPERTY_TYPES} placeholder="Select…" /></Field>
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}><Field label="Bedrooms"><Input type="number" value={f.fromBedrooms} onChange={v => set("fromBedrooms", v)} placeholder="e.g. 3" /></Field></div>
        <div style={{ flex: 1 }}><Field label="Floor / level"><Input value={f.fromFloor} onChange={v => set("fromFloor", v)} placeholder="e.g. Ground, 2nd" /></Field></div>
      </div>
      <Field label="Access notes" hint="Stairs, lift, parking, long carry"><Textarea value={f.fromAccess} onChange={v => set("fromAccess", v)} rows={2} /></Field>

      <div style={{ marginTop: 4, marginBottom: 4, borderTop: "1px solid #EEF3F2", paddingTop: 12 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 9, cursor: "pointer", fontSize: 15, fontWeight: 700, color: "#10211E" }}>
          <input type="checkbox" checked={!!f.toStore} onChange={e2 => set("toStore", e2.target.checked)} style={{ width: 18, height: 18, accentColor: TEAL }} />
          Moving into store
        </label>
        {f.toStore && (
          <div style={{ marginTop: 10 }}>
            <Field label="How long in store?"><Select value={f.storeMode} onChange={v => set("storeMode", v)} options={["Days", "Weeks", "Months", "Years", "Fixed date out"]} /></Field>
            {f.storeMode === "Fixed date out"
              ? <Field label="Date out of store"><Input type="date" value={f.storeOutDate} onChange={v => set("storeOutDate", v)} /></Field>
              : <Field label={`Number of ${(f.storeMode || "weeks").toLowerCase()}`}><Input type="number" inputMode="numeric" value={f.storeQty} onChange={v => set("storeQty", v)} placeholder="e.g. 3" /></Field>}
          </div>
        )}
      </div>

      <SectionTitle>{f.toStore ? "Moving to (or store address)" : "Moving to"}</SectionTitle>
      <Field label="Address"><Input value={f.toAddress1} onChange={v => set("toAddress1", v)} placeholder="House/flat & street" /></Field>
      <Field label="Address line 2"><Input value={f.toAddress2} onChange={v => set("toAddress2", v)} placeholder="(optional)" /></Field>
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}><Field label="Town"><Input value={f.toTown} onChange={v => set("toTown", v)} /></Field></div>
        <div style={{ width: 120 }}><Field label="Postcode"><Input value={f.toPostcode} onChange={v => set("toPostcode", v)} /></Field></div>
      </div>
      <Field label="Property type"><Select value={f.toPropertyType} onChange={v => set("toPropertyType", v)} options={PROPERTY_TYPES} placeholder="Select…" /></Field>
      <Field label="Floor / level"><Input value={f.toFloor} onChange={v => set("toFloor", v)} placeholder="e.g. Ground, 2nd" /></Field>
      <Field label="Access notes" hint="Stairs, lift, parking, long carry"><Textarea value={f.toAccess} onChange={v => set("toAccess", v)} rows={2} /></Field>

      <Field label="General notes"><Textarea value={f.notes} onChange={v => set("notes", v.split("\n").slice(0, 8).join("\n"))} rows={8} /></Field>

      <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
        <Btn variant="grey" style={{ flex: 1 }} onClick={onClose}>Cancel</Btn>
        <Btn style={{ flex: 2 }} onClick={save}>{e.id ? "Save changes" : "Create enquiry"}</Btn>
      </div>
    </Modal>
  );
}

// ── Inventory / volume calculator ───────────────────────────────────────────
function InventoryModal({ data, enquiry, onClose }) {
  // Unified line store keyed by slot:
  //   catalog slot  = `${roomLabel}::${catalogId}`
  //   custom slot   = `c_<uid>`   (catalogId null)
  // Each value: { catalogId, room (label), name, cuFt, m3, kg, qty }
  const [lines, setLines] = useState(() => {
    const out = {};
    (enquiry.inventory || []).forEach(it => {
      if (it.slot) {                       // new format
        out[it.slot] = { catalogId: it.catalogId ?? null, room: it.room, name: it.name, cuFt: it.cuFt, m3: it.m3, kg: it.kg, qty: it.qty, dismantle: it.dismantle || "" };
      } else {                             // old format → migrate
        const label = it.room === "Bedroom" ? "Bedroom 1" : it.room;
        const slot = `${label}::${it.id}`;
        out[slot] = { catalogId: it.id, room: label, name: it.name, cuFt: it.cuFt, m3: it.m3, kg: it.kg, qty: it.qty };
      }
    });
    return out;
  });
  // initialise bedrooms from existing lines
  const initialBedrooms = (() => {
    const set = new Set();
    (enquiry.inventory || []).forEach(it => {
      const lbl = it.room || (it.slot ? "" : "");
      if (lbl && /^Bedroom/.test(lbl)) set.add(lbl);
      if (!it.slot && it.room === "Bedroom") set.add("Bedroom 1");
    });
    const arr = [...set].sort((a, b) => (parseInt(a.replace(/\D/g, "")) || 0) - (parseInt(b.replace(/\D/g, "")) || 0));
    return arr.length ? arr : ["Bedroom 1"];
  })();
  const [beds, setBeds] = useState(initialBedrooms);
  // initialise lounges from existing lines ("Lounge / Living Room", "...2", "...3")
  const initialLounges = (() => {
    const set = new Set();
    (enquiry.inventory || []).forEach(it => {
      if (it.room && /^Lounge \/ Living Room( \d+)?$/.test(it.room)) set.add(it.room);
    });
    const arr = [...set].sort((a, b) => (parseInt(a.replace(/\D/g, "")) || 1) - (parseInt(b.replace(/\D/g, "")) || 1));
    return arr.length ? arr : ["Lounge / Living Room"];
  })();
  const [lounges, setLounges] = useState(initialLounges);
  // ── Freehand mode (alternative to the detailed catalogue) ──
  const [invMode, setInvMode] = useState((enquiry.inventory || []).some(it => it.freehand) ? "freehand" : "detailed");
  const draftKey = "rm_fhsurvey_" + (enquiry.id || "new");
  const [freeRooms, setFreeRooms] = useState(() => {
    try { const d = JSON.parse(localStorage.getItem(draftKey) || "null"); if (d && d.freeRooms && Object.keys(d.freeRooms).length) return d.freeRooms; } catch {}
    const out = {};
    const ensure = r => (out[r] = out[r] || { text: "", cuFt: "", wardrobe: 0 });
    (enquiry.inventory || []).forEach(it => {
      if (!it.freehand || typeof it.slot !== "string") return;
      if (it.slot.startsWith("fh::")) { const r = ensure(it.room); r.text = it.raw ?? it.name ?? ""; r.cuFt = it.cuFt || ""; }
      else if (it.slot.startsWith("fhwb::")) { const r = ensure(it.room); r.wardrobe = it.qty || 0; }
    });
    // Fallback: nothing matched the freehand tags but the enquiry HAS inventory (e.g. it shows on the
    // PDF). Rebuild the rooms from whatever is saved so the survey never looks blank when data exists.
    if (!Object.keys(out).length && (enquiry.inventory || []).length) {
      (enquiry.inventory || []).forEach(it => {
        if (it.slot === "fh-dismantle") return;
        const r = ensure(it.room || "Other");
        if (it.wardrobe) { r.wardrobe = (Number(r.wardrobe) || 0) + (Number(it.qty) || 0); return; }
        const line = it.raw ?? ((Number(it.qty) || 1) > 1 && it.name ? `${it.qty} x ${it.name}` : (it.name || ""));
        if (line && line !== "(see volume)") r.text = r.text ? r.text + "\n" + line : line;
        r.cuFt = (Number(r.cuFt) || 0) + (Number(it.cuFt) || 0) * (Number(it.qty) || 1);
      });
      Object.values(out).forEach(r => { r.cuFt = r.cuFt ? Math.round(r.cuFt * 100) / 100 : ""; });
    }
    return out;
  });
  const [dismantleNote, setDismantleNote] = useState(() => {
    try { const d = JSON.parse(localStorage.getItem(draftKey) || "null"); if (d && typeof d.dismantleNote === "string") return d.dismantleNote; } catch {}
    const d = (enquiry.inventory || []).find(it => it.freehand && it.slot === "fh-dismantle");
    return d ? (d.raw ?? d.name ?? "") : "";
  });
  // Autosave the in-progress freehand survey continuously, so a reload/sync/backgrounding can't wipe it.
  useEffect(() => {
    try { localStorage.setItem(draftKey, JSON.stringify({ freeRooms, dismantleNote, at: Date.now() })); } catch {}
  }, [freeRooms, dismantleNote, draftKey]);
  const setFree = (label, key, val) => setFreeRooms(p => ({ ...p, [label]: { text: "", cuFt: "", wardrobe: 0, ...p[label], [key]: val } }));
  const [search, setSearch] = useState("");
  const [detailView, setDetailView] = useState("rooms");
  const [azRoom, setAzRoom] = useState("");
  const [openSection, setOpenSection] = useState(getRooms()[0]);
  const [customItems, setCustomItems] = useState(getCustomItems());

  const matches = txt => !search || (txt || "").toLowerCase().includes(search.toLowerCase());

  function bump(slot, meta, d) {
    setLines(p => {
      const cur = p[slot]?.qty || 0;
      const n = Math.max(-20, cur + d);
      const next = { ...p };
      if (n === 0) delete next[slot];
      else next[slot] = { ...(p[slot] || meta), qty: n };
      return next;
    });
  }
  function addCustom(label, catalogRoom) {
    const name = (prompt("Item name?") || "").trim();
    if (!name) return;
    const cuFt = parseFloat(prompt("Approx volume in cubic feet? (e.g. 20)") || "");
    if (!cuFt || cuFt <= 0) { alert("Please enter a number for cubic feet."); return; }
    const kg = parseFloat(prompt("Approx weight in kg? (optional, e.g. 30)") || "") || 0;
    const id = "cust_" + uid();
    const item = { id, room: catalogRoom || label, name, cuFt: Math.round(cuFt * 100) / 100, m3: Math.round(cuFt * 0.0283168 * 1000) / 1000, kg: Math.round(kg) };
    setCustomItems(addCustomItemToCatalog(item));          // saved permanently to the list
    const slot = `${label}::${id}`;
    setLines(p => ({ ...p, [slot]: { catalogId: id, room: label, name: item.name, cuFt: item.cuFt, m3: item.m3, kg: item.kg, qty: 1 } }));
    setOpenSection(label);
  }
  function deleteCustomItem(id) {
    if (!confirm("Remove this custom item from your saved list? (existing moves keep it)")) return;
    setCustomItems(removeCustomItemFromCatalog(id));
  }
  function addBedroom() {
    const nums = beds.map(b => parseInt(b.replace(/\D/g, "")) || 0);
    const next = `Bedroom ${Math.max(0, ...nums) + 1}`;
    setBeds([...beds, next]);
    setOpenSection(next);
  }
  function removeBedroom(label) {
    if (!confirm(`Remove ${label} and its items?`)) return;
    setBeds(b => b.filter(x => x !== label));
    setLines(p => { const n = { ...p }; Object.keys(n).forEach(s => { if (n[s].room === label) delete n[s]; }); return n; });
  }
  function addLounge() {
    const nums = lounges.map(l => parseInt(l.replace(/\D/g, "")) || 1);
    const next = `Lounge / Living Room ${Math.max(1, ...nums) + 1}`;
    setLounges([...lounges, next]);
    setOpenSection(next);
  }
  function removeLounge(label) {
    if (!confirm(`Remove ${label} and its items?`)) return;
    setLounges(l => l.filter(x => x !== label));
    setLines(p => { const n = { ...p }; Object.keys(n).forEach(s => { if (n[s].room === label) delete n[s]; }); return n; });
  }

  const totals = inventoryTotals(Object.values(lines).filter(v => v.qty > 0).map(v => ({ cuFt: v.cuFt, m3: v.m3, kg: v.kg, qty: v.qty })));
  const freeTotals = (() => {
    let cuFt = 0;
    Object.values(freeRooms).forEach(r => { cuFt += (Number(r.cuFt) || 0) + (Number(r.wardrobe) || 0) * 12; });
    cuFt = Math.round(cuFt * 100) / 100;
    return { cuFt, m3: Math.round(cuFt * 0.0283168 * 10) / 10, kg: 0 };
  })();
  const aTot = invMode === "freehand" ? freeTotals : totals;
  const setDismantle = (slot, val) => setLines(p => p[slot] ? { ...p, [slot]: { ...p[slot], dismantle: val } } : p);
  const toggleWho = slot => setLines(p => p[slot] ? { ...p, [slot]: { ...p[slot], dismantle: p[slot].dismantle === "Customer" ? "Mover" : "Customer" } } : p);
  const DisCheck = ({ slot }) => {
    const v = lines[slot];
    if (!v || v.qty <= 0) return null;
    return (
      <label style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, cursor: "pointer", userSelect: "none", flexShrink: 0 }}>
        <span style={{ fontSize: 8.5, color: v.dismantle ? TEAL : "#9CA3AF", fontWeight: 700, lineHeight: 1, whiteSpace: "nowrap" }}>Dismantle</span>
        <input type="checkbox" checked={!!v.dismantle} onChange={e => setDismantle(slot, e.target.checked ? "Mover" : "")} style={{ width: 17, height: 17, accentColor: TEAL }} />
      </label>
    );
  };
  const DisPill = ({ slot }) => {
    const v = lines[slot];
    if (!v || !v.dismantle) return null;
    return <button onClick={() => toggleWho(slot)} style={{ marginTop: 6, border: "none", background: TEAL, color: "#fff", borderRadius: 99, fontSize: 11, fontWeight: 700, padding: "3px 10px", cursor: "pointer" }}>Dismantle &amp; reassemble: {v.dismantle} ⟲</button>;
  };
  const rec = recommendVehicle(aTot.cuFt);

  function buildSurveyRec(advanceStatus) {
    let inventory, vol;
    if (invMode === "freehand") {
      inventory = [];
      Object.entries(freeRooms).forEach(([room, r]) => {
        const text = (r.text || "").trim();
        const cuFt = Number(r.cuFt) || 0;
        const wb = Number(r.wardrobe) || 0;
        if (text || cuFt) {
          inventory.push({ slot: "fh::" + room, room, name: (text.replace(/\s*\n\s*/g, " · ") || "(see volume)"), raw: text, cuFt: Math.round(cuFt * 100) / 100, m3: Math.round(cuFt * 0.0283168 * 1000) / 1000, kg: 0, qty: 1, freehand: true });
        }
        if (wb > 0) inventory.push({ slot: "fhwb::" + room, room, name: "Hanging Wardrobe Box", cuFt: 12, m3: 0.34, kg: 18, qty: wb, freehand: true, wardrobe: true });
      });
      if (dismantleNote.trim()) inventory.push({ slot: "fh-dismantle", room: "Dismantle / Reassemble", name: dismantleNote.trim().replace(/\s*\n\s*/g, " · "), raw: dismantleNote.trim(), cuFt: 0, m3: 0, kg: 0, qty: 1, freehand: true, dismantleNote: true });
      vol = freeTotals;
    } else {
      inventory = Object.entries(lines).filter(([, v]) => v.qty !== 0)
        .map(([slot, v]) => ({ slot, catalogId: v.catalogId ?? null, room: v.room, name: v.name, cuFt: v.cuFt, m3: v.m3, kg: v.kg, qty: v.qty, dismantle: v.dismantle || "" }));
      vol = totals;
    }
    return {
      ...enquiry, inventory: sortInventoryByRoom(inventory),
      volumeCuFt: vol.cuFt, volumeM3: vol.m3, weightKg: vol.kg,
      surveyDone: inventory.length > 0 ? true : enquiry.surveyDone,
      status: advanceStatus && enquiry.status === "New" ? "Surveyed" : enquiry.status,
    };
  }

  async function save() {
    const rec2 = buildSurveyRec(true);
    try { localStorage.removeItem(draftKey); } catch {}
    await saveAndReload(upsertLocal(data, "enquiries", rec2));
  }

  // Silent cloud backup: persists the in-progress survey to the cloud without reloading,
  // so it survives even if this phone is lost. Skipped while a field is focused.
  const dirtyRef = useRef(false);
  const [cloudAt, setCloudAt] = useState(null);
  useEffect(() => { dirtyRef.current = true; }, [freeRooms, dismantleNote, lines]);
  useEffect(() => {
    const id = setInterval(() => {
      if (!dirtyRef.current) return;
      const ae = document.activeElement;
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT")) return;
      try {
        const rec2 = buildSurveyRec(false);
        const d = loadData();
        const d2 = upsertLocal(d, "enquiries", { ...rec2, updatedAt: Date.now() });
        try { localStorage.setItem(DB_KEY, JSON.stringify(d2)); } catch {}
        pushChangedOnly(d2).catch(() => {});
        dirtyRef.current = false;
        setCloudAt(new Date());
      } catch {}
    }, 60000);
    return () => clearInterval(id);
    // eslint-disable-next-line
  }, [freeRooms, dismantleNote, lines, invMode]);


  // Build ordered section list, expanding Bedroom into Bedroom 1..N
  const sections = [];
  getRooms().forEach(room => {
    if (room === "Bedroom") {
      beds.forEach(lbl => sections.push({ label: lbl, catalogRoom: "Bedroom", isBedroom: true }));
      sections.push({ addBedroom: true });
    } else if (room === "Lounge / Living Room") {
      lounges.forEach(lbl => sections.push({ label: lbl, catalogRoom: "Lounge / Living Room", isLounge: true }));
      sections.push({ addLounge: true });
    } else {
      sections.push({ label: room, catalogRoom: room });
    }
  });

  function Section({ label, catalogRoom, isBedroom, isLounge }) {
    const fhNameRef = useRef(null), fhVolRef = useRef(null);
    const addFh = () => {
      const name = (fhNameRef.current?.value || "").trim();
      if (!name) return;
      const cuFt = Math.max(0, parseFloat(fhVolRef.current?.value) || 0);
      const slot = "free_" + uid();
      setLines(p => ({ ...p, [slot]: { catalogId: null, room: label, name, cuFt: Math.round(cuFt * 100) / 100, m3: Math.round(cuFt * 0.0283168 * 1000) / 1000, kg: 0, qty: 1 } }));
      if (fhNameRef.current) fhNameRef.current.value = "";
      if (fhVolRef.current) fhVolRef.current.value = "";
    };
    const boxItems = BOX_ITEMS.filter(b => b.id !== WARDROBE_BOX_ID || isBedroom || label === "Hallway");
    const catItems = [...getFurniture().filter(it => it.room === catalogRoom), ...customItems.filter(it => it.room === catalogRoom), ...boxItems].filter(it => matches(it.name));
    const customSlots = Object.entries(lines).filter(([, v]) => v.catalogId == null && v.room === label && matches(v.name));
    if (search && catItems.length === 0 && customSlots.length === 0) return null;
    const sectionQty = Object.values(lines).filter(v => v.room === label && v.qty > 0).reduce((s, v) => s + v.qty, 0);
    const isOpen = search ? true : openSection === label;
    const Stepper = ({ slot, meta }) => {
      const q = lines[slot]?.qty || 0;
      return (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button onClick={() => bump(slot, meta, -1)} style={stepBtn(true)}>−</button>
          <span style={{ minWidth: 18, textAlign: "center", fontWeight: 700, color: q < 0 ? "#DC2626" : q > 0 ? "#111827" : "#D1D5DB" }}>{q}</span>
          <button onClick={() => bump(slot, meta, 1)} style={stepBtn(true)}>+</button>
        </div>
      );
    };
    return (
      <div style={{ marginBottom: 8, border: "1px solid #F3F4F6", borderRadius: 10, overflow: "hidden" }}>
        <button onClick={() => setOpenSection(isOpen ? null : label)} style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 14px", background: "#F9FAFB", border: "none", cursor: "pointer", fontSize: 14, fontWeight: 700, color: "#111827" }}>
          <span>{label}</span>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {isBedroom && beds.length > 1 && <span onClick={e => { e.stopPropagation(); removeBedroom(label); }} style={{ color: "#DC2626", fontSize: 13, fontWeight: 600 }}>Remove</span>}
            {isLounge && lounges.length > 1 && <span onClick={e => { e.stopPropagation(); removeLounge(label); }} style={{ color: "#DC2626", fontSize: 13, fontWeight: 600 }}>Remove</span>}
            {sectionQty > 0 && <span style={{ background: TEAL, color: "#fff", borderRadius: 99, fontSize: 12, padding: "1px 8px", fontWeight: 700 }}>{sectionQty}</span>}
            <span style={{ color: "#9CA3AF" }}>{isOpen ? "▾" : "▸"}</span>
          </span>
        </button>
        {isOpen && (
          <div style={{ padding: "4px 0" }}>
            {catItems.map(it => {
              const slot = `${label}::${it.id}`;
              const isCustom = typeof it.id === "string" && it.id.startsWith("cust_");
              const q = lines[slot]?.qty || 0;
              return (
                <div key={slot} style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "8px 14px", borderTop: "1px solid #F9FAFB" }}>
                  <div style={{ flex: 1, minWidth: 0, paddingRight: 8 }}>
                    <div style={{ fontSize: 14, fontWeight: 500 }}>
                      <span style={{ color: q < 0 ? "#9CA3AF" : "#111827", textDecoration: q < 0 ? "line-through" : "none" }}>{it.name}</span>
                      {isCustom && <span style={{ fontSize: 10, color: TEAL, fontWeight: 700 }}> · custom</span>}
                      {q < 0 && <span style={{ fontSize: 10, color: "#DC2626", fontWeight: 700 }}> · not moving</span>}
                    </div>
                    <div style={{ fontSize: 11, color: "#9CA3AF" }}>{it.cuFt} cu ft · {it.kg} kg{isCustom && <span onClick={() => deleteCustomItem(it.id)} style={{ color: "#DC2626", fontWeight: 600, marginLeft: 8, cursor: "pointer" }}>remove from list</span>}</div>
                    <DisPill slot={slot} />
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <DisCheck slot={slot} />
                    <Stepper slot={slot} meta={{ catalogId: it.id, room: label, name: it.name, cuFt: it.cuFt, m3: it.m3, kg: it.kg }} />
                  </div>
                </div>
              );
            })}
            {customSlots.map(([slot, v]) => (
              <div key={slot} style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "8px 14px", borderTop: "1px solid #F9FAFB" }}>
                <div style={{ flex: 1, minWidth: 0, paddingRight: 8 }}>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>
                    <span style={{ color: v.qty < 0 ? "#9CA3AF" : "#111827", textDecoration: v.qty < 0 ? "line-through" : "none" }}>{v.name}</span>
                    <span style={{ fontSize: 10, color: TEAL, fontWeight: 700 }}> · custom</span>
                    {v.qty < 0 && <span style={{ fontSize: 10, color: "#DC2626", fontWeight: 700 }}> · not moving</span>}
                  </div>
                  <div style={{ fontSize: 11, color: "#9CA3AF" }}>{v.cuFt} cu ft · {v.kg} kg</div>
                  <DisPill slot={slot} />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <DisCheck slot={slot} />
                  <Stepper slot={slot} meta={v} />
                </div>
              </div>
            ))}
            <div style={{ display: "flex", gap: 8, padding: "10px 14px", borderTop: "1px solid #F9FAFB", alignItems: "center" }}>
              <input ref={fhNameRef} style={{ ...inputStyle, flex: 1 }} defaultValue="" placeholder="Free-hand item" onKeyDown={ev => { if (ev.key === "Enter") addFh(); }} />
              <input ref={fhVolRef} style={{ ...inputStyle, width: 72 }} type="number" defaultValue="" placeholder="cu ft" />
              <button onClick={addFh} style={{ background: TEAL, color: "#fff", border: "none", borderRadius: 8, padding: "0 13px", height: 40, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>Add</button>
            </div>
            <div style={{ padding: "2px 14px 10px" }}>
              <button onClick={() => addCustom(label, catalogRoom)} style={{ background: "transparent", border: "none", color: "#9CA3AF", fontWeight: 600, fontSize: 12.5, cursor: "pointer", padding: 0 }}>+ Add custom item to my saved list</button>
            </div>
          </div>
        )}
      </div>
    );
  }

  const removeLink = { color: "#DC2626", fontSize: 13, fontWeight: 600 };
  function renderAZ() {
    const roomOpts = sections.filter(s => s.label).map(s => s.label);
    const room = (azRoom && roomOpts.includes(azRoom)) ? azRoom : (roomOpts[0] || "");
    const seen = new Set();
    const all = [...getFurniture(), ...customItems, ...BOX_ITEMS]
      .filter(it => { if (seen.has(it.id)) return false; seen.add(it.id); return true; })
      .filter(it => matches(it.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    return (
      <div style={{ marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, background: "#F0FDFA", border: `1px solid ${TEAL}`, borderRadius: 10, padding: "8px 12px" }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: NAVY, whiteSpace: "nowrap" }}>Adding to</span>
          <select value={room} onChange={e => setAzRoom(e.target.value)} style={{ ...inputStyle, flex: 1, marginBottom: 0 }}>
            {roomOpts.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div style={{ border: "1px solid #F3F4F6", borderRadius: 10, overflow: "hidden" }}>
          {all.length === 0 && <div style={{ padding: 14, fontSize: 13, color: "#9CA3AF" }}>No items match “{search}”.</div>}
          {all.map(it => {
            const slot = `${room}::${it.id}`;
            const q = lines[slot]?.qty || 0;
            return (
              <div key={it.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 14px", borderTop: "1px solid #F9FAFB" }}>
                <div style={{ flex: 1, minWidth: 0, paddingRight: 8 }}>
                  <div style={{ fontSize: 14, fontWeight: 500, color: q < 0 ? "#9CA3AF" : "#111827" }}>{it.name}{q > 0 && <span style={{ fontSize: 11, color: TEAL, fontWeight: 700 }}> · {q} in {room}</span>}</div>
                  <div style={{ fontSize: 11, color: "#9CA3AF" }}>{it.cuFt} cu ft · {it.kg} kg</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <button onClick={() => bump(slot, { catalogId: it.id, room, name: it.name, cuFt: it.cuFt, m3: it.m3, kg: it.kg }, -1)} style={stepBtn(true)}>−</button>
                  <span style={{ minWidth: 18, textAlign: "center", fontWeight: 700, color: q < 0 ? "#DC2626" : q > 0 ? "#111827" : "#D1D5DB" }}>{q}</span>
                  <button onClick={() => bump(slot, { catalogId: it.id, room, name: it.name, cuFt: it.cuFt, m3: it.m3, kg: it.kg }, 1)} style={stepBtn(true)}>+</button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  function renderFree(s) {
    const { label, isBedroom, isLounge } = s;
    const r = freeRooms[label] || { text: "", cuFt: "", wardrobe: 0 };
    const isOpen = openSection === label;
    const showWardrobe = isBedroom || label === "Hallway";
    const hasData = (r.text || "").trim() || Number(r.cuFt) > 0 || Number(r.wardrobe) > 0;
    return (
      <div key={label} style={{ marginBottom: 8, border: "1px solid #F3F4F6", borderRadius: 10, overflow: "hidden" }}>
        <button onClick={() => setOpenSection(isOpen ? null : label)} style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 14px", background: "#F9FAFB", border: "none", cursor: "pointer", fontSize: 14, fontWeight: 700, color: "#111827" }}>
          <span>{label}</span>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {isBedroom && beds.length > 1 && <span onClick={e => { e.stopPropagation(); removeBedroom(label); }} style={removeLink}>Remove</span>}
            {isLounge && lounges.length > 1 && <span onClick={e => { e.stopPropagation(); removeLounge(label); }} style={removeLink}>Remove</span>}
            {hasData && <span style={{ background: TEAL, color: "#fff", borderRadius: 99, fontSize: 12, padding: "1px 8px", fontWeight: 700 }}>{Number(r.cuFt) > 0 ? `${r.cuFt} ft³` : "✓"}</span>}
            <span style={{ color: "#9CA3AF" }}>{isOpen ? "▾" : "▸"}</span>
          </span>
        </button>
        {isOpen && (
          <div style={{ padding: "10px 14px" }}>
            <textarea value={r.text} onChange={e => setFree(label, "text", e.target.value)} rows={4} placeholder="List the furniture in this room…" style={{ ...inputStyle, resize: "vertical", marginBottom: 8 }} />
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <label style={{ fontSize: 13, color: "#374151", fontWeight: 600 }}>Volume</label>
              <input type="number" inputMode="decimal" value={r.cuFt} onChange={e => setFree(label, "cuFt", e.target.value)} placeholder="cu ft" style={{ ...inputStyle, width: 90 }} />
              <span style={{ fontSize: 12, color: "#9CA3AF" }}>cu ft</span>
              {showWardrobe && (
                <span style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
                  <label style={{ fontSize: 13, color: "#374151", fontWeight: 600 }}>Wardrobe boxes</label>
                  <button onClick={() => setFree(label, "wardrobe", Math.max(0, (Number(r.wardrobe) || 0) - 1))} style={stepBtn(true)}>−</button>
                  <span style={{ minWidth: 18, textAlign: "center", fontWeight: 700 }}>{Number(r.wardrobe) || 0}</span>
                  <button onClick={() => setFree(label, "wardrobe", (Number(r.wardrobe) || 0) + 1)} style={stepBtn(true)}>+</button>
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <Modal title="Survey / Inventory" onClose={onClose}>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        {[["detailed", "Detailed list"], ["freehand", "Freehand"]].map(([m, lbl]) => (
          <button key={m} onClick={() => setInvMode(m)} style={{ flex: 1, padding: "9px", borderRadius: 9, border: `1.5px solid ${invMode === m ? TEAL : "#E5E7EB"}`, background: invMode === m ? "#F0FDFA" : "#fff", color: invMode === m ? TEAL : "#6B7280", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>{lbl}</button>
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "#15803D", background: "#F1F9F4", border: "1px solid #CDE9D6", borderRadius: 8, padding: "6px 10px", marginBottom: 12 }}>
        <span style={{ fontWeight: 800 }}>✓ Draft saved as you type</span>
        <span style={{ color: "#6A9E7C" }}>· nothing is lost if you look away{cloudAt ? ` · backed up ${cloudAt.getHours().toString().padStart(2, "0")}:${cloudAt.getMinutes().toString().padStart(2, "0")}` : ""}</span>
      </div>

      {invMode === "detailed" && (
        <div style={{ display: "flex", gap: 6, background: "#EEF3F2", borderRadius: 10, padding: 4, marginBottom: 10 }}>
          {[["rooms", "Rooms"], ["az", "A–Z (all items)"]].map(([m, lbl]) => (
            <button key={m} onClick={() => setDetailView(m)} style={{ flex: 1, padding: "8px 0", border: "none", borderRadius: 7, cursor: "pointer", fontWeight: 700, fontSize: 13, background: detailView === m ? "#fff" : "transparent", color: detailView === m ? TEAL : "#6A7B77", boxShadow: detailView === m ? "0 1px 3px rgba(0,0,0,.08)" : "none" }}>{lbl}</button>
          ))}
        </div>
      )}

      {invMode === "detailed" && <div style={{ marginBottom: 12 }}><Input value={search} onChange={setSearch} placeholder="🔍 Search items…" /></div>}

      {invMode === "detailed" && detailView === "az" ? renderAZ() : sections.map(s => {
        if (s.addBedroom) return (invMode === "freehand" || !search) ? <button key="addbed" onClick={addBedroom} style={{ width: "100%", marginBottom: 8, padding: "10px", borderRadius: 10, border: `1.5px dashed ${TEAL}`, background: "#F0FDFA", color: TEAL, fontWeight: 700, fontSize: 13, cursor: "pointer" }}>+ Add another bedroom</button> : null;
        if (s.addLounge) return (invMode === "freehand" || !search) ? <button key="addlounge" onClick={addLounge} style={{ width: "100%", marginBottom: 8, padding: "10px", borderRadius: 10, border: `1.5px dashed ${TEAL}`, background: "#F0FDFA", color: TEAL, fontWeight: 700, fontSize: 13, cursor: "pointer" }}>+ Add another lounge</button> : null;
        return invMode === "freehand" ? renderFree(s) : <Section key={s.label} {...s} />;
      })}

      {invMode === "freehand" && (
        <div style={{ marginBottom: 8, border: "1px solid #F3F4F6", borderRadius: 10, padding: "12px 14px" }}>
          <div style={{ fontWeight: 700, color: "#111827", marginBottom: 8 }}>Dismantle / Reassemble</div>
          <textarea value={dismantleNote} onChange={e => setDismantleNote(e.target.value)} rows={3} placeholder="Items to dismantle and reassemble…" style={{ ...inputStyle, resize: "vertical" }} />
        </div>
      )}

      {/* sticky totals */}
      <div style={{ position: "sticky", bottom: 0, background: "#fff", paddingTop: 12, marginTop: 8, borderTop: "2px solid #F3F4F6" }}>
        <div style={{ background: NAVY, color: "#fff", borderRadius: 12, padding: "12px 14px", marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
            <span style={{ fontSize: 13, opacity: .85 }}>Total volume</span>
            <span style={{ fontWeight: 800 }}>{aTot.cuFt} cu ft · {aTot.m3} m³</span>
          </div>
          {invMode === "detailed" && (
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
              <span style={{ fontSize: 13, opacity: .85 }}>Est. weight</span>
              <span style={{ fontWeight: 700 }}>{aTot.kg} kg</span>
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ fontSize: 13, opacity: .85 }}>Recommended</span>
            <span style={{ fontWeight: 700 }}>{rec.vehicle}{rec.loads > 1 ? ` × ${rec.loads} loads` : ""}</span>
          </div>
        </div>
        <Btn style={{ width: "100%" }} onClick={save}><Icon name="check" size={16} /> Save inventory</Btn>
      </div>
    </Modal>
  );
}
function stepBtn(active) {
  return { width: 30, height: 30, borderRadius: 8, border: "none", cursor: "pointer", fontSize: 18, fontWeight: 700, background: active ? "#E6F4F1" : "#F3F4F6", color: active ? TEAL : "#9CA3AF", lineHeight: 1 };
}

// ── Quote builder ───────────────────────────────────────────────────────────
const EXTRA_PRESETS = ["Packing service", "Packing materials", "Dismantle / reassemble furniture", "Storage", "Piano move", "Parking suspension / permit", "Additional crew"];

function QuoteModal({ data, enquiry, onClose }) {
  const [lines, setLines] = useState(() => {
    const days = enquiry.stages || [];
    const existing = enquiry.quoteLines || [];
    const n = Math.max(days.length, existing.length);
    if (n === 0) return [{ desc: "Removal service", amount: "" }];
    const out = [];
    for (let i = 0; i < n; i++) out.push(existing[i] || { desc: (days[i] && days[i].type) || "Move", amount: "" });
    return out;
  });
  const [vat, setVat] = useState((enquiry.quoteLines && enquiry.quoteLines.length) ? !!enquiry.quoteVat : true);
  const [extra, setExtra] = useState(enquiry.quoteExtra || {});
  const setEx = (k, v) => setExtra(p => ({ ...p, [k]: v }));
  const total = quoteTotal(lines, vat);
  const subtotalNet = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const mpPct = Number(extra.mpPct) || 10;
  const moveProtect = Math.round(subtotalNet * (mpPct / 100) * 100) / 100;
  const customer = (data.customers || []).find(c => c.id === enquiry.customerId);

  const setLine = (i, k, v) => setLines(p => p.map((l, idx) => idx === i ? { ...l, [k]: v } : l));
  const addLine = (desc = "") => setLines(p => [...p, { desc, amount: "" }]);
  const removeLine = i => setLines(p => p.filter((_, idx) => idx !== i));

  function buildRecord(status, sentDate) {
    return {
      ...enquiry,
      quoteLines: lines.filter(l => l.desc || l.amount),
      quoteVat: vat, quoteTotal: total,
      quoteExtra: { ...extra, lateKey: extra.lateKey ?? "FREE", mpPct: Number(extra.mpPct) || 10 },
      quoteStatus: status, quoteSentDate: sentDate ?? enquiry.quoteSentDate,
      status: ["Won", "Lost"].includes(enquiry.status) ? enquiry.status : (total > 0 ? "Quoted" : enquiry.status),
    };
  }
  async function saveDraft() {
    await saveAndReload(upsertLocal(data, "enquiries", buildRecord(enquiry.quoteStatus || "Draft")));
  }
  async function send() {
    const rec = buildRecord("Sent", todayISO());
    // local-first save, then open email
    const stamped = stampData(upsertLocal(data, "enquiries", rec));
    localStorage.setItem(DB_KEY, JSON.stringify(stamped));
    pushChangedOnly(stamped).catch(() => {});
    const body = encodeURIComponent(
      `Hi ${customer?.name || ""},\n\nThank you for your enquiry. Please find your removal quote below:\n\n` +
      rec.quoteLines.map(l => `• ${l.desc}: ${gbp(l.amount)}`).join("\n") +
      `\n\n${vat ? "Total (inc. VAT): " : "Total: "}${gbp(total)}\n\n` +
      `Move date: ${enquiry.preferredDate ? fmtDate(enquiry.preferredDate) : "to be confirmed"}\n` +
      `From: ${[enquiry.fromAddress1, enquiry.fromAddress2, enquiry.fromTown, enquiry.fromPostcode].filter(Boolean).join(", ")}\n` +
      `To: ${[enquiry.toAddress1, enquiry.toAddress2, enquiry.toTown, enquiry.toPostcode].filter(Boolean).join(", ")}\n\n` +
      `This quote is valid for 30 days. To book, just reply to this email.\n\nKind regards`
    );
    const subject = encodeURIComponent("Your removal quote");
    window.location.href = `mailto:${customer?.email || ""}?subject=${subject}&body=${body}`;
    setTimeout(() => window.location.reload(), 600);
  }

  return (
    <Modal title="Quote" onClose={onClose}>
      {enquiry.volumeCuFt > 0 && (
        <div style={{ background: "#F0FDFA", border: "1px solid #CCFBF1", borderRadius: 10, padding: "10px 12px", marginBottom: 14, fontSize: 13, color: "#0F766E" }}>
          Survey: <b>{enquiry.volumeCuFt} cu ft</b> · {recommendVehicle(enquiry.volumeCuFt).vehicle}
        </div>
      )}

      {lines.map((l, i) => (
        <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
          <input style={{ ...inputStyle, flex: 1 }} value={l.desc} onChange={ev => setLine(i, "desc", ev.target.value)} placeholder="Description" />
          <input style={{ ...inputStyle, width: 90 }} type="number" value={l.amount} onChange={ev => setLine(i, "amount", ev.target.value)} placeholder="£" />
          <button onClick={() => removeLine(i)} style={{ background: "#FEE2E2", color: "#DC2626", border: "none", borderRadius: 8, width: 34, height: 34, cursor: "pointer", flexShrink: 0 }}>×</button>
        </div>
      ))}
      <Btn size="sm" variant="ghost" onClick={() => addLine()} style={{ marginTop: 2 }}><Icon name="plus" size={14} /> Add line</Btn>

      <div style={{ marginTop: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#6B7280", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>Quick add</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {EXTRA_PRESETS.map(x => (
            <button key={x} onClick={() => addLine(x)} style={{ padding: "5px 10px", borderRadius: 99, border: "1px solid #E5E7EB", background: "#fff", fontSize: 12, color: "#374151", cursor: "pointer" }}>+ {x}</button>
          ))}
        </div>
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "#374151", cursor: "pointer", margin: "16px 0 8px" }}>
        <input type="checkbox" checked={vat} onChange={ev => setVat(ev.target.checked)} style={{ width: 18, height: 18 }} /> Add VAT (20%)
      </label>

      <div style={{ background: NAVY, color: "#fff", borderRadius: 12, padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", margin: "8px 0 14px" }}>
        <span style={{ fontSize: 14, opacity: .85 }}>{vat ? "Total (inc. VAT)" : "Total"}</span>
        <span style={{ fontSize: 22, fontWeight: 800 }}>{gbp(total)}</span>
      </div>

      <div style={{ fontSize: 12, fontWeight: 600, color: "#6B7280", margin: "4px 0 8px", textTransform: "uppercase", letterSpacing: "0.05em" }}>Quote extras (appear on the PDF)</div>
      <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
        <span style={{ fontSize: 13, color: "#374151", flex: 1 }}>MoveProtect <span style={{ color: "#9CA3AF" }}>(net × {mpPct}%, not in total)</span></span>
        <select style={{ ...inputStyle, width: 78 }} value={mpPct} onChange={ev => setEx("mpPct", Number(ev.target.value))}>
          {[5, 10, 15].map(v => <option key={v} value={v}>{v}%</option>)}
        </select>
        <span style={{ fontSize: 14, fontWeight: 700, color: "#111827", minWidth: 66, textAlign: "right" }}>{gbp(moveProtect)}</span>
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
        <span style={{ fontSize: 13, color: "#374151", flex: 1 }}>Late Key Waiver</span>
        <select style={{ ...inputStyle, width: 110 }} value={extra.lateKey ?? "FREE"} onChange={ev => setEx("lateKey", ev.target.value)}>
          <option value="FREE">FREE</option>
          {[80, 100, 120, 140, 160, 180, 200].map(v => <option key={v} value={v}>£{v.toFixed(2)}</option>)}
        </select>
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
        <span style={{ fontSize: 13, color: "#374151", flex: 1 }}>Storage £/container/week (ex VAT)</span>
        <input style={{ ...inputStyle, width: 100 }} type="number" value={extra.storageWeekly || ""} onChange={ev => setEx("storageWeekly", ev.target.value)} placeholder="£" />
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 14, alignItems: "center" }}>
        <span style={{ fontSize: 13, color: "#374151", flex: 1 }}>Containers required</span>
        <input style={{ ...inputStyle, width: 100 }} type="number" value={extra.storageContainers || ""} onChange={ev => setEx("storageContainers", ev.target.value)} placeholder="0" />
      </div>

      <div style={{ display: "flex", gap: 10 }}>
        <Btn variant="grey" style={{ flex: 1 }} onClick={saveDraft}>Save draft</Btn>
        <Btn variant="amber" style={{ flex: 2 }} onClick={send}>📧 Email quote</Btn>
      </div>
    </Modal>
  );
}

// ── Enquiry detail ──────────────────────────────────────────────────────────
function Row({ label, value }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid #F3F4F6", fontSize: 14, gap: 12 }}>
      <span style={{ color: "#6B7280", flexShrink: 0 }}>{label}</span>
      <span style={{ color: "#111827", fontWeight: 500, textAlign: "right" }}>{value || "—"}</span>
    </div>
  );
}

function MovePlanModal({ data, enquiry, onClose }) {
  const linkedJob = (data.jobs || []).find(j => j.enquiryId === enquiry.id);
  const vehOpts = (data.vehicles || []).map(v => ({ id: v.id, label: [v.name, v.reg].filter(Boolean).join(" · ") }));
  const crewOpts = (data.staff || []).filter(s => s.active !== false).map(s => ({ id: s.name, label: s.name }));
  const vname = id => ((data.vehicles || []).find(v => v.id === id) || {}).name;
  const [days, setDays] = useState(() => (Array.isArray(enquiry.stages) ? enquiry.stages : []).map((d, i) => {
    const js = linkedJob ? (linkedJob.stages || [])[i] : null;
    return { ...d, crew: (d.crew && d.crew.length ? d.crew : (js?.crew || [])), vehicleIds: (d.vehicleIds && d.vehicleIds.length ? d.vehicleIds : (js?.vehicleIds || [])) };
  }));
  const addDay = () => setDays(d => [...d, { id: uid(), type: "Move", date: "", staffCount: "", vehTypes: {}, crew: [], vehicleIds: [], notes: "" }]);
  const removeDay = (i) => setDays(d => d.filter((_, ix) => ix !== i));
  const setDay = (i, k, v) => setDays(d => d.map((x, ix) => ix === i ? { ...x, [k]: v } : x));
  const setVeh = (i, vt, n) => setDays(d => d.map((x, ix) => {
    if (ix !== i) return x;
    const m = { ...(x.vehTypes || {}) };
    if (n > 0) m[vt] = n; else delete m[vt];
    return { ...x, vehTypes: m };
  }));
  const toggleVehId = (i, vid) => setDays(d => d.map((x, ix) => ix === i ? { ...x, vehicleIds: (x.vehicleIds || []).includes(vid) ? x.vehicleIds.filter(z => z !== vid) : [...(x.vehicleIds || []), vid] } : x));
  const toggleCrew = (i, name) => setDays(d => d.map((x, ix) => ix === i ? { ...x, crew: (x.crew || []).includes(name) ? x.crew.filter(z => z !== name) : [...(x.crew || []), name] } : x));
  function bookedOn(date, exceptIdx) {
    const veh = new Set(), crew = new Set();
    if (!date) return { veh, crew };
    (data.jobs || []).filter(x => (!linkedJob || x.id !== linkedJob.id) && ["Confirmed", "Completed"].includes(x.status)).forEach(x => jobStages(x).forEach(st => { if (st.date === date) { (st.vehicleIds || []).forEach(v => veh.add(v)); (st.crew || []).forEach(c => crew.add(c)); } }));
    days.forEach((st, ix) => { if (ix !== exceptIdx && st.date === date) { (st.vehicleIds || []).forEach(v => veh.add(v)); (st.crew || []).forEach(c => crew.add(c)); } });
    if (date) (data.vehicles || []).forEach(vv => { if (vehOutOn(vv, date)) veh.add(vv.id); }); if (date) (data.staff || []).forEach(s => { if (staffOffOn(s, date)) crew.add(s.name); });
    return { veh, crew };
  }
  async function save() {
    if (linkedJob && ["Confirmed", "Completed"].includes(linkedJob.status)) {
      const badDays = days.map((d, i) => (!(d.crew && d.crew.length) || !(d.vehicleIds && d.vehicleIds.length)) ? i + 1 : null).filter(Boolean);
      if (badDays.length) { alert(`This job is confirmed, so please assign at least one staff member and one vehicle to every day before saving. Still needed on day ${badDays.join(", ")}.`); return; }
    }
    // Safety net: no vehicle that's booked out for maintenance can be on a move that day.
    const clashes = [];
    days.forEach((d, i) => { if (d.date) (d.vehicleIds || []).forEach(vid => { const vv = (data.vehicles || []).find(x => x.id === vid); if (vv && vehOutOn(vv, d.date)) clashes.push(`${vv.name} on day ${i + 1} (${fmtUK(d.date)})`); }); });
    if (clashes.length) { alert(`These vehicles are booked out for servicing/MOT and can't be used:\n\n${clashes.join("\n")}\n\nRemove them or move the maintenance date.`); return; }
    let d = upsertLocal(data, "enquiries", { ...enquiry, stages: days });
    if (linkedJob) {
      const newStages = days.map((day, i) => {
        const ex = (linkedJob.stages || [])[i] || {};
        return { id: ex.id || uid(), type: day.type || "Move", date: day.date || ex.date || linkedJob.moveDate || "", time: ex.time || "", vehicleIds: day.vehicleIds || [], crew: day.crew || [], staffCount: day.staffCount || "", vehTypes: day.vehTypes || {}, notes: day.notes || ex.notes || "" };
      });
      const allVeh = [...new Set(newStages.flatMap(s => s.vehicleIds || []))];
      const allCrew = [...new Set(newStages.flatMap(s => s.crew || []))];
      d = upsertLocal(d, "jobs", { ...linkedJob, stages: newStages, moveDate: newStages[0]?.date || linkedJob.moveDate || "", vehicleIds: allVeh, vehicle: allVeh.map(vname).filter(Boolean).join(", "), crew: allCrew });
    }
    await saveAndReload(d);
    onClose();
  }
  const stepBtn = { width: 34, height: 34, borderRadius: 9, border: "1.5px solid #E3E9E8", background: "#F7FAF9", color: TEAL_D, fontSize: 18, fontWeight: 700, cursor: "pointer", lineHeight: 1 };
  return (
    <Modal title="Move plan" onClose={onClose}>
      <div style={{ fontSize: 12, color: "#6B7280", marginBottom: 10 }}>{linkedJob ? "Assign the staff and vehicles for each day. Saving updates the move and the calendar." : "Scope the days for this move. These carry onto the move when you create it."}</div>
      {(enquiry.fromAccess || enquiry.toAccess) && (
        <div style={{ fontSize: 12.5, background: "#FFF7ED", border: "1px solid #FED7AA", borderRadius: 9, padding: "9px 11px", marginBottom: 12 }}>
          {enquiry.fromAccess && <div style={{ marginBottom: enquiry.toAccess ? 6 : 0 }}><span style={{ fontWeight: 700, color: "#9A3412" }}>Access at {enquiry.fromTown || "from"}: </span><span style={{ color: "#7C2D12" }}>{enquiry.fromAccess}</span></div>}
          {enquiry.toAccess && <div><span style={{ fontWeight: 700, color: "#9A3412" }}>Access at {enquiry.toTown || "to"}: </span><span style={{ color: "#7C2D12" }}>{enquiry.toAccess}</span></div>}
        </div>
      )}
      {linkedJob && days.length > 0 && (
        <div style={{ fontSize: 12.5, fontWeight: 700, color: "#10211E", background: "#F1F5F4", borderRadius: 9, padding: "8px 11px", marginBottom: 12 }}>
          You booked: {days.length} day{days.length !== 1 ? "s" : ""} · planned {days.reduce((n, d) => n + (Number(d.staffCount) || 0), 0)} staff{(() => { const tot = {}; days.forEach(d => Object.entries(d.vehTypes || {}).forEach(([k, v]) => tot[k] = (tot[k] || 0) + (Number(v) || 0))); const s = vehTypesSummary(tot); return s ? ` · ${s}` : ""; })()}
        </div>
      )}
      {days.length === 0 && <div style={{ fontSize: 13, color: "#9CA3AF", marginBottom: 10 }}>No days yet — add the first one.</div>}
      {days.map((d, i) => (
        <Card key={d.id || i} style={{ background: "#FAFCFB" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: TEAL_D }}>Day {i + 1}</div>
            <button onClick={() => removeDay(i)} style={{ background: "#FEE2E2", color: "#DC2626", border: "none", borderRadius: 8, width: 30, height: 30, cursor: "pointer" }}>×</button>
          </div>
          <Field label="Type"><DayTypeSelect value={d.type} onChange={v => setDay(i, "type", v)} /></Field>
          <Field label="Date" hint="Optional"><Input type="date" value={d.date} onChange={v => setDay(i, "date", v)} /></Field>
          {linkedJob && ["Confirmed", "Completed"].includes(linkedJob.status) ? (
            <>
              <div style={{ fontSize: 12, background: "#EAF4F2", borderRadius: 9, padding: "7px 11px", marginBottom: 10 }}>
                <span style={{ color: TEAL_D, fontWeight: 700 }}>Planned:</span> <span style={{ color: "#10211E" }}>{d.staffCount ? `${d.staffCount} staff` : "staff —"}{vehTypesSummary(d.vehTypes) ? ` · ${vehTypesSummary(d.vehTypes)}` : ""}</span>
                {(() => {
                  const plannedStaff = Number(d.staffCount) || 0;
                  const asgStaff = (d.crew || []).length;
                  const plannedVeh = Object.values(d.vehTypes || {}).reduce((n, v) => n + (Number(v) || 0), 0);
                  const asgVeh = (d.vehicleIds || []).length;
                  const sc = plannedStaff ? (asgStaff >= plannedStaff ? "#059669" : "#D97706") : "#6B7280";
                  const vc = plannedVeh ? (asgVeh >= plannedVeh ? "#059669" : "#D97706") : "#6B7280";
                  return <span style={{ color: "#6B7280", display: "block", marginTop: 2 }}>Assigned: <b style={{ color: sc }}>{asgStaff}{plannedStaff ? `/${plannedStaff}` : ""} staff</b> · <b style={{ color: vc }}>{asgVeh}{plannedVeh ? `/${plannedVeh}` : ""} vehicle{asgVeh !== 1 ? "s" : ""}</b></span>;
                })()}
              </div>
              <Field label="Crew"><PickChips options={crewOpts} selectedIds={d.crew || []} takenIds={bookedOn(d.date, i).crew} takenReasons={crewReasonsOn(data, d.date, linkedJob && linkedJob.id)} onToggle={name => toggleCrew(i, name)} empty="No staff — add under Company." /></Field>
              <Field label="Vehicles"><PickChips options={vehOpts} selectedIds={d.vehicleIds || []} takenIds={bookedOn(d.date, i).veh} onToggle={vid => toggleVehId(i, vid)} empty="No vehicles — add under Company." /></Field>
              {!d.date && <div style={{ fontSize: 11, color: "#9CA3AF", marginTop: -6, marginBottom: 8 }}>Set a date to see what's already booked that day.</div>}
            </>
          ) : (
            <>
              <Field label="Staff"><Input type="number" inputMode="numeric" value={d.staffCount} onChange={v => setDay(i, "staffCount", v)} placeholder="e.g. 3" /></Field>
              <Field label="Vehicles">
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {PLAN_VEHICLE_TYPES.map(vt => {
                    const qty = (d.vehTypes && d.vehTypes[vt]) || 0;
                    return (
                      <div key={vt} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "#fff", border: "1.5px solid #E3E9E8", borderRadius: 11, padding: "6px 12px" }}>
                        <span style={{ fontSize: 14, fontWeight: 600, color: qty ? "#10211E" : "#6B7280" }}>{vt}</span>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <button onClick={() => setVeh(i, vt, Math.max(0, qty - 1))} style={stepBtn}>−</button>
                          <span style={{ minWidth: 18, textAlign: "center", fontWeight: 700, fontSize: 15 }}>{qty}</span>
                          <button onClick={() => setVeh(i, vt, qty + 1)} style={stepBtn}>+</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Field>
            </>
          )}
          <Field label="Notes"><Input value={d.notes} onChange={v => setDay(i, "notes", v)} placeholder="(optional)" /></Field>
        </Card>
      ))}
      {linkedJob && <div style={{ fontSize: 12, color: "#0F766E", background: "#F0FDFA", border: "1px solid #CCFBF1", borderRadius: 9, padding: "8px 11px", marginBottom: 12 }}>This move is on the calendar. Saving updates its days, staff and vehicles.</div>}
      <Btn variant="grey" size="sm" onClick={addDay} style={{ marginBottom: 14 }}><Icon name="plus" size={14} /> Add day</Btn>
      <Btn style={{ width: "100%" }} onClick={save}><Icon name="check" size={16} /> {linkedJob ? "Save & update move" : "Save plan"}</Btn>
    </Modal>
  );
}
const MSG_TPL_KEY = "removals_msg_templates";
const DEFAULT_TEMPLATES = [
  { id: "t1", title: "Survey confirmation", body: "Hi {firstname}, confirming our home survey on {survey_date} at {survey_time}. Any problems just reply. Thanks, {company}" },
  { id: "t2", title: "Quote follow-up", body: "Hi {firstname}, just checking you received our removals quote. Happy to answer any questions or adjust anything. Thanks, {company}" },
  { id: "t3", title: "Booking confirmation", body: "Hi {firstname}, your move {ref} is booked for {date}. We'll confirm timings nearer the day. Thanks, {company}" },
  { id: "t4", title: "Deposit request", body: "Hi {firstname}, to secure your move on {date} we take a {deposit} deposit. Let me know and I'll send payment details. Thanks, {company}" },
  { id: "t5", title: "Day-before reminder", body: "Hi {firstname}, looking forward to your move tomorrow ({date}). Our crew will aim to arrive around {time}. Please have everything ready to go. Thanks, {company}" },
  { id: "t6", title: "Thank you / review", body: "Hi {firstname}, thanks for choosing {company}! If you have a moment, a quick Google review would mean a lot. Best wishes." },
];
function getTemplates() { try { const v = JSON.parse(localStorage.getItem(MSG_TPL_KEY)); if (Array.isArray(v) && v.length) return v; } catch {} return DEFAULT_TEMPLATES; }
function saveTemplates(list) { localStorage.setItem(MSG_TPL_KEY, JSON.stringify(list)); }
function getBusinessName() { return localStorage.getItem("removals_business_name") || ""; }
function fillTemplate(body, ctx) { return (body || "").replace(/\{(\w+)\}/g, (_, k) => (ctx[k] != null && ctx[k] !== "") ? ctx[k] : ""); }
function waNumber(phone) { let d = (phone || "").replace(/[^\d]/g, ""); if (d.startsWith("0")) d = "44" + d.slice(1); return d; }

function MessageButton({ customer, ctx, size = "sm", variant = "grey" }) {
  const [open, setOpen] = useState(false);
  if (!customer) return null;
  return (<>
    <Btn size={size} variant={variant} onClick={() => setOpen(true)}>💬 Message</Btn>
    {open && <MessageModal customer={customer} ctx={ctx || {}} onClose={() => setOpen(false)} />}
  </>);
}
function MessageModal({ customer, ctx, onClose }) {
  const [tpls, setTpls] = useState(getTemplates());
  const fullCtx = { ...ctx, company: getBusinessName(), name: customer.name || "", firstname: (customer.name || "").trim().split(" ")[0] || "there" };
  const [sel, setSel] = useState(tpls[0]?.title || "");
  const cur = tpls.find(t => t.title === sel) || tpls[0];
  const [text, setText] = useState(cur ? fillTemplate(cur.body, fullCtx) : "");
  function pick(title) { setSel(title); const t = tpls.find(x => x.title === title); setText(t ? fillTemplate(t.body, fullCtx) : ""); }
  const enc = encodeURIComponent(text);
  const phone = customer.phone || "";
  const email = customer.email || "";
  function go(u) { window.location.href = u; }
  function addTpl() {
    const title = (prompt("Template name?") || "").trim(); if (!title) return;
    const body = (prompt("Message text. You can use {firstname} {name} {ref} {date} {time} {deposit} {balance} {price} {survey_date} {survey_time} {company}") || "").trim(); if (!body) return;
    const nl = [...tpls, { id: "t" + uid(), title, body }]; saveTemplates(nl); setTpls(nl); pick(title);
  }
  function editTpl() {
    if (!cur) return;
    const body = (prompt("Edit message text:", cur.body) || "").trim(); if (!body) return;
    const nl = tpls.map(t => t.title === cur.title ? { ...t, body } : t); saveTemplates(nl); setTpls(nl); setText(fillTemplate(body, fullCtx));
  }
  function delTpl() {
    if (!cur || !confirm(`Delete template "${cur.title}"?`)) return;
    const nl = tpls.filter(t => t.title !== cur.title); saveTemplates(nl); setTpls(nl);
    const first = nl[0]; setSel(first?.title || ""); setText(first ? fillTemplate(first.body, fullCtx) : "");
  }
  function setBiz() { const v = (prompt("Your business name (used in messages):", getBusinessName()) || "").trim(); localStorage.setItem("removals_business_name", v); pick(sel); }
  const linkBtn = { background: "transparent", border: "none", color: TEAL, fontWeight: 600, fontSize: 13, cursor: "pointer", padding: 0 };
  return (
    <Modal title={`Message ${customer.name || ""}`} onClose={onClose}>
      <Field label="Template"><Select value={sel} onChange={pick} options={tpls.map(t => t.title)} placeholder="Choose a message…" /></Field>
      <Field label="Message">
        <textarea value={text} onChange={e => setText(e.target.value)} rows={6} style={{ ...inputStyle, resize: "vertical", lineHeight: 1.4 }} />
      </Field>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
        {phone && <Btn style={{ flex: 1, background: "#25D366", boxShadow: "none" }} onClick={() => { logComm(customer.id, { type: "WhatsApp", note: text }); go(`https://wa.me/${waNumber(phone)}?text=${enc}`); }}>WhatsApp</Btn>}
        {phone && <Btn style={{ flex: 1 }} variant="grey" onClick={() => { logComm(customer.id, { type: "Text", note: text }); go(`sms:${phone}&body=${enc}`); }}>Text</Btn>}
        {email && <Btn style={{ flex: 1 }} variant="grey" onClick={() => { logComm(customer.id, { type: "Email", note: text }); go(`mailto:${email}?subject=${encodeURIComponent(cur?.title || "")}&body=${enc}`); }}>Email</Btn>}
      </div>
      {!phone && !email && <div style={{ fontSize: 12, color: "#9CA3AF", marginBottom: 6 }}>No phone or email on this customer.</div>}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 4 }}>
        <button onClick={addTpl} style={linkBtn}>+ New template</button>
        <button onClick={editTpl} style={linkBtn}>Edit</button>
        <button onClick={delTpl} style={{ ...linkBtn, color: "#DC2626" }}>Delete</button>
        <button onClick={setBiz} style={linkBtn}>Business name</button>
      </div>
    </Modal>
  );
}
function fmtUK(iso) { if (!iso) return ""; const d = new Date(iso + (iso.length === 10 ? "T00:00" : "")); if (isNaN(d)) return iso; return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`; }
function fmtLong(iso) { if (!iso) return ""; const d = new Date(iso + (iso.length === 10 ? "T00:00" : "")); if (isNaN(d)) return iso; return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }); }
function gbpPlain(n) { return "£" + Number(n || 0).toFixed(2); }

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src; s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("load failed"));
    document.body.appendChild(s);
  });
}
async function loadPdfLib() {
  if (window.PDFLib) return window.PDFLib;
  const urls = [
    "https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js",
    "https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js",
  ];
  for (const u of urls) { try { await loadScript(u); if (window.PDFLib) return window.PDFLib; } catch (_e) { /* try next */ } }
  throw new Error("Could not load the PDF library — check your internet connection and try again.");
}

async function buildQuotePdf(e, c) {
  const { PDFDocument, StandardFonts, rgb } = await loadPdfLib();
  const surveyor = e.surveyor || localStorage.getItem("removals_surveyor") || "";
  const lines = (e.quoteLines || []).filter(l => l.desc || l.amount);
  const subtotal = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const vatAmt = e.quoteVat ? Math.round(subtotal * 0.2 * 100) / 100 : 0;
  const total = subtotal + vatAmt;
  const ref = c?.ref ? String(c.ref) : "";
  const fromAddr = [e.fromAddress1, e.fromAddress2, e.fromTown, e.fromPostcode].filter(Boolean).join("  ");
  const toAddr = [e.toAddress1, e.toAddress2, e.toTown, e.toPostcode].filter(Boolean).join("  ");
  const surveyWhen = e.surveyDate ? fmtUK(e.surveyDate) : "";
  const moveWhen = e.preferredDate ? fmtUK(e.preferredDate) : (e.moveMonth ? fmtMonth(e.moveMonth) : "");

  const res = await fetch("/quote-template.pdf");
  if (!res.ok) throw new Error("Template not found — upload quote-template.pdf to the public folder on GitHub.");
  const bytes = await res.arrayBuffer();
  const pdf = await PDFDocument.load(bytes);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const H = 842, black = rgb(0, 0, 0), red = rgb(0.8, 0, 0.05);
  const p1 = pdf.getPage(0);
  const clean = s => String(s == null ? "" : s)
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'").replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, "-").replace(/\u2026/g, "...").replace(/\u00A0/g, " ")
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, "");
  const L = (x, base, t, s = 9, f = font, col = black) => { const tt = clean(t); if (!tt) return; p1.drawText(tt, { x, y: H - base, size: s, font: f, color: col }); };
  const R = (xr, base, t, s = 9, f = bold) => { const tt = clean(t); if (!tt) return; const w = f.widthOfTextAtSize(tt, s); p1.drawText(tt, { x: xr - w, y: H - base, size: s, font: f, color: black }); };

  L(92, 92.5, surveyor); L(304, 92.5, surveyWhen); L(472, 93, ref, 13.2, bold, red);
  L(92, 109, c?.name); L(304, 109, c?.homePhone); L(470, 109, c?.phone);
  L(92, 126, c?.email); L(304, 126, moveWhen); L(472, 126, e.exchanged ? "Yes" : "No");
  L(92, 144, fromAddr); L(92, 180, toAddr);
  // ── MOVING grid: dynamic — one row per quote line, totals directly beneath ──
  {
    const GREY = rgb(0.5, 0.5, 0.5), HEADF = rgb(0.93, 0.93, 0.93), WHITE = rgb(1, 1, 1), BLACK = rgb(0, 0, 0);
    const yT = t => H - t;
    const hline = (a, b, t) => p1.drawLine({ start: { x: a, y: yT(t) }, end: { x: b, y: yT(t) }, thickness: 0.7, color: GREY });
    const vline = (x, t1, t2) => p1.drawLine({ start: { x, y: yT(t1) }, end: { x, y: yT(t2) }, thickness: 0.7, color: GREY });
    const x0 = 27, x1 = 293, ax = 233;
    p1.drawRectangle({ x: 26.5, y: yT(333), width: 267.5, height: 333 - 187, color: WHITE });
    const nL = Math.max(1, Math.min(lines.length, 6));
    const rowH = Math.min(16, (333 - 204) / (nL + 4));
    const rows = nL + 4, bottom = 204 + rows * rowH;
    p1.drawRectangle({ x: x0, y: yT(204), width: x1 - x0, height: 16, color: HEADF });
    hline(x0, x1, 188); hline(x0, x1, 204);
    for (let i = 1; i <= rows; i++) hline(x0, x1, 204 + i * rowH);
    vline(x0, 188, bottom); vline(x1, 188, bottom); vline(ax, 204, bottom);
    const mw = bold.widthOfTextAtSize("MOVING", 10);
    p1.drawText("MOVING", { x: (x0 + x1) / 2 - mw / 2, y: yT(200.5), size: 10, font: bold, color: BLACK });
    p1.drawText("Tick the services required", { x: 30, y: yT(200.3), size: 6.5, font: bold, color: BLACK });
    const fs = rowH >= 15 ? 9 : 8;
    const base = t => t + rowH - 4.8;
    const boxSize = Math.max(5.5, Math.min(8, rowH - 6));
    const descX = 30 + boxSize + 5;
    const tickBox = t => p1.drawRectangle({ x: 30, y: yT(t + rowH / 2 + boxSize / 2), width: boxSize, height: boxSize, borderColor: BLACK, borderWidth: 0.8, color: WHITE });
    for (let i = 0; i < nL; i++) {
      const t = 204 + i * rowH, it = lines[i] || { desc: "", amount: "" };
      if (it.desc || it.amount) tickBox(t);
      L(descX, base(t), it.desc, fs); if (it.amount) R(x1 - 4, base(t), gbpPlain(it.amount), fs);
    }
    const vT = 204 + nL * rowH, tT = 204 + (nL + 1) * rowH, lkT = 204 + (nL + 2) * rowH, mpT = 204 + (nL + 3) * rowH;
    const ex = e.quoteExtra || {};
    const lk = ex.lateKey, lkText = (lk && lk !== "FREE" && Number(lk) > 0) ? gbpPlain(lk) : "FREE";
    const mpPct = Number(ex.mpPct) || 10;
    const mp = Math.round(subtotal * (mpPct / 100) * 100) / 100;
    L(descX, base(vT), "Vat @ 20%", fs); R(x1 - 4, base(vT), e.quoteVat ? gbpPlain(vatAmt) : "", fs);
    L(descX, base(tT), "Total", fs, bold); R(x1 - 4, base(tT), gbpPlain(total), fs, bold);
    tickBox(lkT); L(descX, base(lkT), "Late Key Waiver", fs); R(x1 - 4, base(lkT), lkText, fs);
    tickBox(mpT); L(descX, base(mpT), "MoveProtect (not incl.)", Math.min(fs, 7.5));
    if (mp > 0) R(x1 - 4, base(mpT), gbpPlain(mp), fs);

    // ── STORAGE grid: mirror the quote grid geometry on the right ──
    const sx0 = 302, sx1 = 569, sax = 508.5;
    p1.drawRectangle({ x: 301, y: yT(333), width: 269, height: 333 - 187, color: WHITE });
    p1.drawRectangle({ x: sx0, y: yT(204), width: sx1 - sx0, height: 16, color: HEADF });
    hline(sx0, sx1, 188); hline(sx0, sx1, 204);
    for (let i = 1; i <= rows; i++) hline(sx0, sx1, 204 + i * rowH);
    vline(sx0, 188, bottom); vline(sx1, 188, bottom); vline(sax, 204, bottom);
    const shw = bold.widthOfTextAtSize("STORAGE", 10);
    p1.drawText("STORAGE", { x: (sx0 + sx1) / 2 - shw / 2, y: yT(200.5), size: 10, font: bold, color: BLACK });
    const sweek = Number(ex.storageWeekly) || 0, sVat = Math.round(sweek * 0.2 * 100) / 100, sCont = Number(ex.storageContainers) || 0;
    L(sx0 + 4, base(204), "Storage Charges", fs);
    const scw = font.widthOfTextAtSize("Storage Charges", fs);
    L(sx0 + 4 + scw + 6, base(204), "(per container, weekly)", 6.5, font, GREY);
    if (sweek > 0) R(sx1 - 4, base(204), gbpPlain(sweek), fs);
    L(sx0 + 4, base(vT), "Vat @ 20%", fs); if (sweek > 0) R(sx1 - 4, base(vT), gbpPlain(sVat), fs);
    L(sx0 + 4, base(tT), "Total", fs, bold); if (sweek > 0) R(sx1 - 4, base(tT), gbpPlain(sweek + sVat), fs, bold);
    L(sx0 + 4, base(lkT), "Containers Required", fs); if (sCont > 0) R(sx1 - 4, base(lkT), String(sCont), fs);
    L(sx0 + 4, base(mpT), "Estimated weekly storage cost", fs, bold);
    if (sweek > 0 && sCont > 0) R(sx1 - 4, base(mpT), gbpPlain(sCont * (sweek + sVat)), fs, bold);
  }
  // Ref + surname placed right after "...use this reference number:"
  L(476, 378, `${ref}${c?.name ? " " + c.name.split(" ").slice(-1)[0] : ""}`, 8, bold, red);

  // ── Expand the Notes box up into the empty band below the three columns ──
  {
    const WHITE = rgb(1, 1, 1), BLACK = rgb(0, 0, 0);
    const boxL = 25, boxR = 569.6, newTop = 410, boxBot = 532;
    p1.drawRectangle({ x: boxL - 1, y: H - 530, width: boxR - boxL + 2, height: 530 - 398, color: WHITE });
    L(31, 404, "Notes:", 9, bold, red);
    const ln = (xa, ya, xb, yb) => p1.drawLine({ start: { x: xa, y: H - ya }, end: { x: xb, y: H - yb }, thickness: 0.8, color: BLACK });
    ln(boxL, newTop, boxR, newTop);
    ln(boxL, 398, boxL, boxBot);
    ln(boxR, 398, boxR, boxBot);
    ln(boxL, boxBot, boxR, boxBot);
    if (e.notes) {
      const maxW = boxR - 39, lh = 13.5, maxY = boxBot - 6;
      let ny = 426;
      outer:
      for (const paraRaw of String(e.notes).split(/\r?\n/)) {
        let line = "";
        for (const w of clean(paraRaw).split(/\s+/).filter(Boolean)) {
          const test = line ? line + " " + w : w;
          if (font.widthOfTextAtSize(test, 11) > maxW && line) {
            L(31, ny, line, 11); ny += lh; line = w;
            if (ny > maxY) break outer;
          } else line = test;
        }
        if (line) { if (ny > maxY) break; L(31, ny, line, 11); ny += lh; }
      }
    }
  }

  if (pdf.getPageCount() > 2) {
    const p3 = pdf.getPage(2);
    const WHITE = rgb(1, 1, 1), BLK = rgb(0, 0, 0), GREY80 = rgb(0.8, 0.8, 0.8);
    if (c?.name) p3.drawText(clean(c.name), { x: 114, y: H - 84, size: 10, font });
    if (fromAddr) p3.drawText(clean(fromAddr), { x: 114, y: H - 108, size: 9, font });
    if (e.surveyDate) p3.drawText(clean(fmtLong(e.surveyDate)), { x: 114, y: H - 131, size: 9, font });
    // remove the old grey Reference cell from the survey-date row
    p3.drawRectangle({ x: 301, y: H - 139, width: 77, height: 22, color: WHITE });
    // "Customer #" box on the Name line, matching sheet 1's position
    const rbL = 404, rbR = 466, rbT = 68, rbB = 92;
    p3.drawRectangle({ x: rbL, y: H - rbB, width: rbR - rbL, height: rbB - rbT, color: GREY80 });
    const pln = (xa, ya, xb, yb) => p3.drawLine({ start: { x: xa, y: H - ya }, end: { x: xb, y: H - yb }, thickness: 0.8, color: BLK });
    pln(rbL, rbT, rbL, rbB); pln(rbR, rbT, rbR, rbB); pln(rbL, rbT, rbR, rbT); pln(rbL, rbB, rbR, rbB);
    const rtw = bold.widthOfTextAtSize("Customer #", 8);
    p3.drawText("Customer #", { x: (rbL + rbR) / 2 - rtw / 2, y: H - 84, size: 8, font: bold, color: BLK });
    // reference number, same position & size as sheet 1
    const accRef = ref || "";
    if (accRef) p3.drawText(clean(accRef), { x: 472, y: H - 84, size: 13.2, font: bold, color: red });
  }

  const out = await pdf.save();
  return { bytes: out, ref };
}

function QuotePdfView({ data, id, setView }) {
  const e = (data.enquiries || []).find(x => x.id === id);
  const c = e ? (data.customers || []).find(x => x.id === e.customerId) : null;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState("");
  if (!e) return <div style={{ padding: 20 }}>Quote not found.</div>;
  const copy = (which, val) => { if (!val || !navigator.clipboard) return; navigator.clipboard.writeText(val).then(() => { setCopied(which); setTimeout(() => setCopied(""), 1500); }).catch(() => {}); };

  const firstName = (() => { const n = (c?.name || "").replace(/^(mr|mrs|ms|miss|dr)\.?\s+/i, "").trim(); return (n.split(/\s+/)[0] || "there"); })();
  const makeFile = async () => {
    const { bytes, ref } = await buildQuotePdf(e, c);
    return { file: new File([bytes], `Quote-${ref || "RJ"}.pdf`, { type: "application/pdf" }), ref };
  };
  const downloadFile = file => {
    const url = URL.createObjectURL(file);
    const a = document.createElement("a"); a.href = url; a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
  const share = async () => {
    setErr(""); setBusy(true);
    try {
      const { file, ref } = await makeFile();
      const text = `Hi ${firstName}, please find your removals quotation attached${ref ? ` (ref ${ref})` : ""}. Any questions just let us know.\n\nR&J Removals & Storage`;
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: `Quotation${ref ? " " + ref : ""}`, text });
      } else { downloadFile(file); }
    } catch (ex) { if (ex && ex.name !== "AbortError") setErr(ex.message || "Could not share the PDF."); }
    setBusy(false);
  };
  const download = async () => {
    setErr(""); setBusy(true);
    try { const { file } = await makeFile(); downloadFile(file); }
    catch (ex) { setErr(ex.message || "Could not build the PDF."); }
    setBusy(false); setTimeout(resetZoom, 200);
  };
  const emailCustomer = () => {
    const ref = c?.ref ? String(c.ref) : "";
    const subject = `Your removals quotation${ref ? ` – ref ${ref}` : ""}`;
    const body = `Hi ${firstName},\n\nPlease find your removals quotation attached${ref ? ` (ref ${ref})` : ""}. Any questions just let us know.\n\nR&J Removals & Storage`;
    window.location.href = `mailto:${encodeURIComponent(c?.email || "")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };

  return (
    <div style={{ maxWidth: 560, margin: "0 auto" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14 }}>
        <Btn variant="ghost" size="sm" onClick={() => { setView({ screen: "enquiryDetail", id: e.id }); setTimeout(() => { try { window.location.reload(); } catch (_e) {} }, 30); }}><Icon name="back" size={14} /> Back</Btn>
        <div style={{ fontWeight: 800, fontSize: 18 }}>Quote PDF</div>
      </div>
      <Card>
        <div style={{ fontSize: 13, color: "#374151", marginBottom: 12 }}>This fills your R&J quotation template with {c?.name || "the customer"}'s details and quote, ready to send.</div>
        <Btn style={{ marginTop: 12 }} disabled={busy} onClick={share}><Icon name="quote" size={16} /> {busy ? "Building…" : "Create & send quote"}</Btn>
        <Btn variant="grey" style={{ marginTop: 8 }} disabled={busy} onClick={download}><Icon name="quote" size={14} /> Download PDF only</Btn>
        {c?.email ? <Btn variant="grey" style={{ marginTop: 8 }} onClick={emailCustomer}><Icon name="mail" size={14} /> Email {firstName} (pre-addressed)</Btn> : null}
        {(c?.email || c?.phone) && (
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            {c?.email && <Btn size="sm" variant="grey" onClick={() => copy("email", c.email)}>{copied === "email" ? "Copied ✓" : "Copy email"}</Btn>}
            {c?.phone && <Btn size="sm" variant="grey" onClick={() => copy("mobile", c.phone)}>{copied === "mobile" ? "Copied ✓" : "Copy mobile"}</Btn>}
          </div>
        )}
        {err ? <div style={{ marginTop: 12, fontSize: 12.5, color: "#B91C1C", background: "#FEF2F2", borderRadius: 8, padding: "8px 11px" }}>{err}</div> : null}
        <div style={{ marginTop: 14, fontSize: 11.5, color: "#6B7280" }}>"Create &amp; send" opens the share menu with the PDF attached — pick Mail, Messages or WhatsApp. "Email {firstName}" opens a ready-addressed email; download first, then attach it.</div>
      </Card>
    </div>
  );
}
function resetZoom() {
  try {
    const vp = document.querySelector('meta[name="viewport"]');
    if (!vp) return;
    vp.setAttribute("content", "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=yes");
    setTimeout(() => vp.setAttribute("content", "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"), 80);
  } catch (_e) { /* noop */ }
}

async function buildSurveyPdf(e, c, data, audience = "customer") {
  const forStaff = audience === "staff";
  const forOffice = audience === "office";
  const { PDFDocument, StandardFonts, rgb } = await loadPdfLib();
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = 595.28, H = 841.89, M = 44;
  const teal = rgb(0.055, 0.486, 0.451), navy = rgb(0.059, 0.18, 0.165), grey = rgb(0.42, 0.46, 0.45), white = rgb(1, 1, 1);
  const clean = s => String(s == null ? "" : s).replace(/[\u2018\u2019\u201A\u2032]/g, "'").replace(/[\u201C\u201D\u201E\u2033]/g, '"').replace(/[\u2013\u2014\u2212]/g, "-").replace(/\u2026/g, "...").replace(/\u00A0/g, " ").replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, "");
  let page, y;
  const np = () => { page = pdf.addPage([W, H]); y = H - M; };
  const ensure = h => { if (y - h < M) np(); };
  const at = (t, x, yy, size, f = font, col = navy) => page.drawText(clean(t), { x, y: yy, size, font: f, color: col });
  const heading = t => { ensure(30); y -= 8; at(t, M, y, 12, bold, teal); y -= 7; page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1, color: teal }); y -= 15; };
  const kv = (label, value) => { ensure(15); at(label, M, y, 9.5, bold, grey); at(value || "-", M + 92, y, 9.5, font, navy); y -= 15; };
  const wrap = (t, x, size, f, maxW) => { const words = clean(t).split(/\s+/); const lines = []; let ln = ""; for (const w of words) { const test = ln ? ln + " " + w : w; if (f.widthOfTextAtSize(test, size) > maxW && ln) { lines.push(ln); ln = w; } else ln = test; } if (ln) lines.push(ln); return lines; };

  np();
  page.drawRectangle({ x: 0, y: H - 66, width: W, height: 66, color: teal });
  at("R&J Removals & Storage", M, H - 34, 16, bold, white);
  at(forOffice ? "Survey & Move Plan — OFFICE COPY" : forStaff ? "Move Plan — STAFF COPY" : "Survey & Move Plan", M, H - 51, 11, font, rgb(0.88, 0.96, 0.94));
  const ref = c?.ref ? `Ref ${c.ref}` : "";
  if (ref) { const w = bold.widthOfTextAtSize(ref, 12); at(ref, W - M - w, H - 40, 12, bold, white); }
  y = H - 88;
  at(`Please check everything below is correct and let us know of any changes. Generated ${fmtUK(todayISO())}.`, M, y, 9, font, grey); y -= 20;

  heading("Your details");
  kv("Name", c?.name);
  if (c?.phone) kv("Mobile", c.phone);
  if (c?.homePhone) kv("Home phone", c.homePhone);
  if (c?.email) kv("Email", c.email);
  const fromAddr = [e.fromAddress1, e.fromAddress2, e.fromTown, e.fromPostcode].filter(Boolean).join(", ");
  const toAddr = [e.toAddress1, e.toAddress2, e.toTown, e.toPostcode].filter(Boolean).join(", ");
  const kvWrap = (label, value) => {
    if (!value) return;
    const ls = wrap(value, 0, 9.5, font, W - (M + 92) - M);
    ensure(13 * ls.length + 2);
    at(label, M, y, 9.5, bold, grey);
    ls.forEach(ln => { at(ln, M + 92, y, 9.5, font, navy); y -= 13; });
    y -= 2;
  };
  kv("Moving from", fromAddr);
  kv("Moving to", toAddr);
  if (storeSummary(e)) kv("Storage", storeSummary(e));

  if (e.fromAccess || e.toAccess) {
    heading("Access — please read");
    kvWrap("From", e.fromAccess);
    kvWrap("To", e.toAccess);
  }

  const stages = Array.isArray(e.stages) ? e.stages : [];
  const vName = id => { const v = (data.vehicles || []).find(x => x.id === id); return v ? v.name : ""; };
  heading("Move plan");
  if (!stages.length) { at("To be confirmed.", M, y, 9.5, font, navy); y -= 16; }
  else stages.forEach((d, i) => {
    ensure(40);
    const when = [d.date ? `${fmtUK(d.date)} (${dow(d.date)})` : "Date TBC", d.time].filter(Boolean).join(" · ");
    at(`Day ${i + 1}`, M, y, 9.5, bold, navy); at(`${d.type || "Move"}  —  ${when}`, M + 50, y, 9.5, font, navy); y -= 14;
    if (forStaff) {
      const crew = (d.crew || []).join(", "); const vehs = (d.vehicleIds || []).map(vName).filter(Boolean).join(", ");
      at("Crew:", M + 50, y, 9, bold, grey); at(crew || "-", M + 84, y, 9, font, navy); y -= 12;
      at("Vehicle:", M + 50, y, 9, bold, grey); at(vehs || "-", M + 92, y, 9, font, navy); y -= 16;
    } else { y -= 4; }
  });

  const inv = Array.isArray(e.inventory) ? e.inventory : [];
  heading("Inventory — what's moving");
  if (!inv.length) { at("No items recorded.", M, y, 9.5, font, navy); y -= 16; }
  else {
    const order = [], idx = {};
    inv.forEach(it => { const r = it.room || "Other"; if (!(r in idx)) { idx[r] = order.length; order.push([r, []]); } order[idx[r]][1].push(it); });
    order.sort((a, b) => roomRank(a[0]) - roomRank(b[0]));
    order.forEach(([room, items]) => {
      const moving = items.filter(it => it.qty > 0), staying = items.filter(it => it.qty < 0);
      const roomCuft = moving.reduce((s, it) => s + (Number(it.cuFt) || 0) * (Number(it.qty) || 0), 0);
      ensure(20); at(room, M, y, 10, bold, navy);
      if (roomCuft > 0 && forOffice) { const t = `${Math.round(roomCuft)} cu ft`; const w = font.widthOfTextAtSize(t, 9); at(t, W - M - w, y, 9, bold, teal); }
      y -= 14;
      moving.forEach(it => {
        ensure(13);
        let t = `${it.qty} x ${it.name}`;
        if (it.dismantle) t += `   (dismantle & reassemble: ${it.dismantle})`;
        at(t, M + 10, y, 9.5, font, navy); y -= 13;
      });
      if (staying.length) {
        ensure(13); at("Not moving:", M + 10, y, 9, bold, grey); y -= 12;
        staying.forEach(it => { ensure(12); at(`-  ${Math.abs(it.qty)} x ${it.name}`, M + 18, y, 9, font, grey); y -= 12; });
      }
      y -= 4;
    });
    ensure(18); page.drawLine({ start: { x: M, y: y + 4 }, end: { x: W - M, y: y + 4 }, thickness: 0.6, color: grey });
    const cuft = Math.round(e.volumeCuFt || 0), m3 = (e.volumeM3 || 0).toFixed(1);
    at(`Total volume: ${cuft} cu ft  (${m3} m3)`, M, y - 6, 10, bold, teal); y -= 22;
  }

  heading("Acknowledgement");
  wrap("I confirm that the inventory and move plan shown above are correct to the best of my knowledge. Please advise R&J Removals & Storage of any additions or changes before the move date.", M, 9.5, font, W - 2 * M).forEach(ln => { ensure(13); at(ln, M, y, 9.5, font, navy); y -= 13; });
  y -= 24; ensure(40);
  page.drawLine({ start: { x: M, y }, end: { x: M + 230, y }, thickness: 0.8, color: navy });
  page.drawLine({ start: { x: W - M - 150, y }, end: { x: W - M, y }, thickness: 0.8, color: navy });
  at("Signed", M, y - 12, 9, bold, grey); at("Date", W - M - 150, y - 12, 9, bold, grey); y -= 26;
  at(`Name: ${c?.name || ""}`, M, y, 9.5, font, navy);

  const out = await pdf.save();
  return { bytes: out, ref: c?.ref ? String(c.ref) : "" };
}

function SurveyPdfView({ data, id, setView }) {
  const e = (data.enquiries || []).find(x => x.id === id);
  const c = e ? (data.customers || []).find(x => x.id === e.customerId) : null;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState("");
  const [mode, setMode] = useState("customer");
  const staff = mode === "staff";
  if (!e) return <div style={{ padding: 20 }}>Enquiry not found.</div>;
  const copy = (which, val) => { if (!val || !navigator.clipboard) return; navigator.clipboard.writeText(val).then(() => { setCopied(which); setTimeout(() => setCopied(""), 1500); }).catch(() => {}); };
  const firstName = (() => { const n = (c?.name || "").replace(/^(mr|mrs|ms|miss|dr)\.?\s+/i, "").trim(); return (n.split(/\s+/)[0] || "there"); })();
  const makeFile = async () => { const { bytes, ref } = await buildSurveyPdf(e, c, data, mode); return { file: new File([bytes], `${mode === "staff" ? "MovePlan-STAFF" : mode === "office" ? "Survey-OFFICE" : "Survey"}-${ref || "RJ"}.pdf`, { type: "application/pdf" }), ref }; };
  const downloadFile = file => { const url = URL.createObjectURL(file); const a = document.createElement("a"); a.href = url; a.download = file.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000); };
  const share = async () => {
    setErr(""); setBusy(true);
    try {
      const { file } = await makeFile();
      const text = staff
        ? `Move plan (staff copy) attached — crew and vehicles included.\n\nR&J Removals & Storage`
        : `Hi ${firstName}, please find your survey and move plan attached. Have a look through and let us know if anything needs changing.\n\nR&J Removals & Storage`;
      if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: staff ? "Move Plan — Staff copy" : mode === "office" ? "Survey — Office copy" : "Survey & Move Plan", text });
      else downloadFile(file);
    } catch (ex) { if (ex && ex.name !== "AbortError") setErr(ex.message || "Could not share the PDF."); }
    setBusy(false);
  };
  const download = async () => { setErr(""); setBusy(true); try { const { file } = await makeFile(); downloadFile(file); } catch (ex) { setErr(ex.message || "Could not build the PDF."); } setBusy(false); setTimeout(resetZoom, 200); };
  const emailCustomer = () => {
    const subject = "Your survey & move plan";
    const body = `Hi ${firstName},\n\nPlease find your survey and move plan attached. Have a look through and let us know if anything needs changing.\n\nR&J Removals & Storage`;
    window.location.href = `mailto:${encodeURIComponent(c?.email || "")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };
  return (
    <div style={{ maxWidth: 560, margin: "0 auto" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14 }}>
        <Btn variant="ghost" size="sm" onClick={() => { setView({ screen: "enquiryDetail", id: e.id }); setTimeout(() => { try { window.location.reload(); } catch (_e) {} }, 30); }}><Icon name="back" size={14} /> Back</Btn>
        <div style={{ fontWeight: 800, fontSize: 18 }}>Survey & Move Plan PDF</div>
      </div>
      <Card>
        <div style={{ display: "flex", gap: 6, background: "#EEF3F2", borderRadius: 10, padding: 4, marginBottom: 12 }}>
          {["customer", "staff", "office"].map(mo => (
            <button key={mo} onClick={() => setMode(mo)} style={{ flex: 1, padding: "8px 0", border: "none", borderRadius: 7, cursor: "pointer", fontWeight: 700, fontSize: 12.5, background: mode === mo ? "#fff" : "transparent", color: mode === mo ? TEAL : "#6A7B77", boxShadow: mode === mo ? "0 1px 3px rgba(0,0,0,.08)" : "none" }}>{mo === "customer" ? "Customer" : mo === "staff" ? "Staff" : "Office"}</button>
          ))}
        </div>
        <div style={{ fontSize: 13, color: "#374151", marginBottom: 12 }}>
          {staff
            ? "Internal copy for your crew — shows the inventory, access notes and the move plan with crew and vehicles for each day. No prices."
            : `Customer copy for ${c?.name || "the customer"} to check and sign off. Shows the inventory and move dates, but no crew, vehicles or prices.`}
        </div>
        <Btn style={{ marginTop: 4 }} disabled={busy} onClick={share}><Icon name="quote" size={16} /> {busy ? "Building…" : (staff ? "Create staff copy" : "Create & send")}</Btn>
        <Btn variant="grey" style={{ marginTop: 8 }} disabled={busy} onClick={download}><Icon name="quote" size={14} /> Download PDF only</Btn>
        {!staff && c?.email ? <Btn variant="grey" style={{ marginTop: 8 }} onClick={emailCustomer}><Icon name="mail" size={14} /> Email {firstName} (pre-addressed)</Btn> : null}
        {(c?.email || c?.phone) && (
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            {c?.email && <Btn size="sm" variant="grey" onClick={() => copy("email", c.email)}>{copied === "email" ? "Copied ✓" : "Copy email"}</Btn>}
            {c?.phone && <Btn size="sm" variant="grey" onClick={() => copy("mobile", c.phone)}>{copied === "mobile" ? "Copied ✓" : "Copy mobile"}</Btn>}
          </div>
        )}
        {err ? <div style={{ marginTop: 12, fontSize: 12.5, color: "#B91C1C", background: "#FEF2F2", borderRadius: 8, padding: "8px 11px" }}>{err}</div> : null}
      </Card>
    </div>
  );
}

function MoveManageModal({ data, job, onClose }) {
  const [f, setF] = useState({ price: job.price ?? "", deposit: job.deposit ?? "", depositPaid: !!job.depositPaid, balancePaid: !!job.balancePaid, status: job.status || "Provisional" });
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const price = Number(f.price) || 0;
  const balanceDue = price - (Number(f.deposit) || 0);
  const [assign, setAssign] = useState(false);
  const [days, setDays] = useState(() => jobStages(job).map(st => ({ id: st.id && st.id !== "legacy" ? st.id : uid(), type: st.type || "Move", date: st.date || "", time: st.time || "", staffCount: st.staffCount || "", vehTypes: st.vehTypes || {}, crew: st.crew || [], vehicleIds: st.vehicleIds || [], notes: st.notes || "" })));
  const crewOpts = (data.staff || []).filter(s => s.active !== false).map(s => ({ id: s.name, label: s.name }));
  const vehOpts = (data.vehicles || []).map(v => ({ id: v.id, label: [v.name, v.reg].filter(Boolean).join(" · ") }));
  const bookedOn = date => {
    const veh = new Set(), crew = new Set();
    (data.jobs || []).filter(x => x.id !== job.id && ["Confirmed", "Completed"].includes(x.status)).forEach(x => jobStages(x).forEach(st => { if (st.date === date) { (st.vehicleIds || []).forEach(v => veh.add(v)); (st.crew || []).forEach(c => crew.add(c)); } }));
    if (date) (data.vehicles || []).forEach(v => { if (vehOutOn(v, date)) veh.add(v.id); });
    if (date) (data.staff || []).forEach(s => { if (staffOffOn(s, date)) crew.add(s.name); });
    return { veh, crew };
  };
  const toggleCrew = (i, name) => setDays(d => d.map((x, ix) => ix === i ? { ...x, crew: x.crew.includes(name) ? x.crew.filter(c => c !== name) : [...x.crew, name] } : x));
  const toggleVeh = (i, vid) => setDays(d => d.map((x, ix) => ix === i ? { ...x, vehicleIds: x.vehicleIds.includes(vid) ? x.vehicleIds.filter(v => v !== vid) : [...x.vehicleIds, vid] } : x));
  async function persist(extra) {
    await saveAndReload(upsertLocal(data, "jobs", { ...job, price: Number(f.price) || 0, deposit: Number(f.deposit) || 0, depositPaid: f.depositPaid, balancePaid: f.balancePaid, status: f.status, ...extra }));
    onClose();
  }
  const confirmMove = () => {
    if (!assign) { setAssign(true); return; }
    const bad = days.map((st, i) => (!(st.crew && st.crew.length) || !(st.vehicleIds && st.vehicleIds.length)) ? i + 1 : null).filter(Boolean);
    if (!days.length || bad.length) { alert(`Assign at least one staff member and one vehicle to every day before confirming.\n\nStill needed on day ${bad.join(", ")}.`); return; }
    const shortfalls = days.map((d, i) => {
      const ps = Number(d.staffCount) || 0, pv = Object.values(d.vehTypes || {}).reduce((n, v) => n + (Number(v) || 0), 0);
      const ss = Math.max(0, ps - (d.crew || []).length), vs = Math.max(0, pv - (d.vehicleIds || []).length);
      return (ss || vs) ? `Day ${i + 1}:${ss ? ` ${ss} more staff` : ""}${ss && vs ? " and" : ""}${vs ? ` ${vs} more vehicle${vs !== 1 ? "s" : ""}` : ""}` : null;
    }).filter(Boolean);
    if (shortfalls.length && !confirm(`This move is below the planned resources:\n\n${shortfalls.join("\n")}\n\nConfirm anyway?`)) return;
    persist({ stages: days, status: "Confirmed", deposit: Math.round(price * 0.6), depositPaid: true });
  };
  const completeMove = () => persist({ status: "Completed", balancePaid: true });
  const reopenConfirmed = () => persist({ status: "Confirmed" });
  const revertProvisional = () => persist({ status: "Provisional" });
  async function removeMove() {
    if (!confirm("Remove this move and send the enquiry back to Quoted? Day assignments will be lost.")) return;
    addTombstone(job.id);
    SAVING_IN_PROGRESS = true; showSavingOverlay();
    try { await deleteRecord("jobs", job.id); } catch {}
    let d2 = { ...data, jobs: (data.jobs || []).filter(x => x.id !== job.id) };
    const enq = (d2.enquiries || []).find(x => x.id === job.enquiryId);
    if (enq) d2 = upsertLocal(d2, "enquiries", { ...enq, status: "Quoted", quoteStatus: "Sent" });
    const stamped = stampData(d2);
    localStorage.setItem(DB_KEY, JSON.stringify(stamped));
    try { await pushChangedOnly(stamped); } catch {}
    SAVING_IN_PROGRESS = false;
    window.location.reload();
  }
  return (
    <Modal title={`Move ${moveRef(data, job)}`} onClose={onClose}>
      <div style={{ marginBottom: 12 }}><StatusBadge status={f.status} /></div>
      <Field label="Price (£)"><Input type="number" inputMode="decimal" value={f.price} onChange={v => set("price", v)} /></Field>
      <Field label="Deposit (£)"><Input type="number" inputMode="decimal" value={f.deposit} onChange={v => set("deposit", v)} /></Field>
      <div style={{ fontSize: 14, fontWeight: 700, color: "#10211E", margin: "2px 0 12px" }}>Balance due: {gbp(balanceDue)}</div>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, marginBottom: 8 }}><input type="checkbox" checked={f.depositPaid} onChange={ev => set("depositPaid", ev.target.checked)} style={{ width: 18, height: 18 }} /> Deposit paid</label>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, marginBottom: 16 }}><input type="checkbox" checked={f.balancePaid} onChange={ev => set("balancePaid", ev.target.checked)} style={{ width: 18, height: 18 }} /> Balance paid</label>

      {assign && f.status === "Provisional" && (
        <div style={{ marginBottom: 12, borderTop: "1px solid #EEF3F2", paddingTop: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: "#1D4ED8", background: "#EFF4FF", border: "1px solid #C7D7FE", borderRadius: 9, padding: "10px 12px", marginBottom: 12 }}>Assign named staff and a vehicle to each day, then press Confirm again.</div>
          {days.map((d, i) => {
            const plannedStaff = Number(d.staffCount) || 0;
            const plannedVeh = Object.values(d.vehTypes || {}).reduce((n, v) => n + (Number(v) || 0), 0);
            const staffShort = Math.max(0, plannedStaff - (d.crew || []).length);
            const vehShort = Math.max(0, plannedVeh - (d.vehicleIds || []).length);
            return (
              <div key={d.id} style={{ border: "1px solid #F0F3F2", borderRadius: 10, padding: 12, marginBottom: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: "#10211E", marginBottom: 8 }}>{d.type || "Move"}{d.date ? ` · ${fmtDate(d.date)}` : ` · Day ${i + 1}`}{d.time ? ` · ${d.time}` : ""}</div>
                {(plannedStaff > 0 || plannedVeh > 0) && (
                  <div style={{ fontSize: 12, color: "#6A7B77", marginBottom: 8 }}>Planned: {plannedStaff || "—"} staff{plannedVeh ? ` · ${vehTypesSummary(d.vehTypes)}` : ""} · Assigned: {(d.crew || []).length} staff, {(d.vehicleIds || []).length} vehicle{(d.vehicleIds || []).length !== 1 ? "s" : ""}</div>
                )}
                {(staffShort > 0 || vehShort > 0) && (
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: "#B45309", background: "#FFF7ED", border: "1px solid #FBD9A0", borderRadius: 8, padding: "7px 10px", marginBottom: 8 }}>
                    ⚠ Short on this day:{staffShort > 0 ? ` ${staffShort} more staff` : ""}{staffShort > 0 && vehShort > 0 ? " ·" : ""}{vehShort > 0 ? ` ${vehShort} more vehicle${vehShort !== 1 ? "s" : ""}` : ""} needed.
                  </div>
                )}
                <Field label="Vehicles"><PickChips options={vehOpts} selectedIds={d.vehicleIds} takenIds={bookedOn(d.date).veh} onToggle={vid => toggleVeh(i, vid)} empty="No vehicles — add under Company." /></Field>
                <Field label="Crew"><PickChips options={crewOpts} selectedIds={d.crew} takenIds={bookedOn(d.date).crew} takenReasons={crewReasonsOn(data, d.date, job.id)} onToggle={name => toggleCrew(i, name)} empty="No staff — add under Company." /></Field>
              </div>
            );
          })}
        </div>
      )}

      {f.status === "Provisional" && <Btn variant="primary" style={{ width: "100%", marginBottom: 10, background: "#2563EB", boxShadow: "0 4px 12px rgba(37,99,235,.26)" }} onClick={confirmMove}><Icon name="check" size={16} /> {assign ? `Confirm — take 60% deposit (${gbp(Math.round(price * 0.6))})` : "Confirm — assign crew & vehicles"}</Btn>}
      {f.status === "Confirmed" && <Btn variant="primary" style={{ width: "100%", marginBottom: 10 }} onClick={completeMove}><Icon name="check" size={16} /> Mark move complete</Btn>}
      {f.status === "Completed" && <Btn variant="grey" style={{ width: "100%", marginBottom: 10 }} onClick={reopenConfirmed}>Reopen (back to confirmed)</Btn>}
      {f.status !== "Provisional" && <Btn variant="grey" style={{ width: "100%", marginBottom: 10 }} onClick={revertProvisional}>Change back to provisional</Btn>}

      <Btn style={{ width: "100%", marginBottom: 10 }} onClick={() => persist()}><Icon name="check" size={16} /> Save</Btn>
      <Btn variant="danger" style={{ width: "100%" }} onClick={removeMove}><Icon name="trash" size={14} /> Remove move — back to Quoted</Btn>
    </Modal>
  );
}
function FollowUpModal({ data, record, table, enquiry, onClose }) {
  const rec = record || enquiry;
  const tbl = table || "enquiries";
  const [date, setDate] = useState(rec.followUpDate || todayISO());
  const [time, setTime] = useState(rec.followUpTime || "");
  const [note, setNote] = useState(rec.followUpNote || "");
  const inp = { width: "100%", padding: "9px 10px", border: "1px solid #D9E2E0", borderRadius: 9, fontSize: 14, boxSizing: "border-box", background: "#fff" };
  async function save() {
    if (!date) { alert("Please choose a date."); return; }
    await saveAndReload(upsertLocal(data, tbl, { ...rec, followUpDate: date, followUpTime: time, followUpNote: note.trim() }));
  }
  async function clear() {
    await saveAndReload(upsertLocal(data, tbl, { ...rec, followUpDate: "", followUpTime: "", followUpNote: "" }));
  }
  return (
    <Modal title="Follow-up reminder" onClose={onClose}>
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}><Field label="Date"><Input type="date" value={date} onChange={setDate} /></Field></div>
        <div style={{ width: 120 }}><Field label="Time" hint="Optional"><input type="time" value={time} onChange={e => setTime(e.target.value)} style={inp} /></Field></div>
      </div>
      <Field label="Note" hint="Mention call, text or email to get quick buttons"><Textarea value={note} onChange={setNote} placeholder="e.g. Call to check on quote" /></Field>
      <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
        {rec.followUpDate && <Btn variant="grey" onClick={clear}>Clear</Btn>}
        <Btn variant="grey" style={{ flex: 1 }} onClick={onClose}>Cancel</Btn>
        <Btn style={{ flex: 2 }} onClick={save}>Save</Btn>
      </div>
    </Modal>
  );
}

function EnquiryDetail({ data, id, setView }) {
  const e = (data.enquiries || []).find(x => x.id === id);
  const [showEdit, setShowEdit] = useState(false);
  const [showInv, setShowInv] = useState(false);
  const [showQuote, setShowQuote] = useState(false);
  const [showPlan, setShowPlan] = useState(false);
  const [showMove, setShowMove] = useState(false);
  useEffect(() => {
    try { if (sessionStorage.getItem("removals_open_plan") === id) { sessionStorage.removeItem("removals_open_plan"); setShowPlan(true); } } catch {}
  }, [id]);
  const vname = id => (((data.vehicles || []).find(v => v.id === id)) || {}).name || "Vehicle";
  const customer = (data.customers || []).find(c => c.id === e?.customerId);
  if (!e) return <div style={{ padding: 20 }}>Enquiry not found.</div>;
  const linkedJob = (data.jobs || []).find(j => j.enquiryId === e.id);

  async function setStatus(status, extra = {}) {
    await saveAndReload(upsertLocal(data, "enquiries", { ...e, status, ...extra }));
  }
  async function markWon() {
    const existing = (data.jobs || []).find(j => j.enquiryId === e.id);
    if (existing) {
      // Re-booking an enquiry that already has a move: don't create a second job.
      let d0 = upsertLocal(data, "jobs", { ...existing, status: existing.status === "Completed" ? "Provisional" : existing.status });
      d0 = upsertLocal(d0, "enquiries", { ...e, status: "Won", quoteStatus: "Accepted" });
      showSavingOverlay(); SAVING_IN_PROGRESS = true;
      const s0 = stampData(d0);
      localStorage.setItem(DB_KEY, JSON.stringify(s0));
      try { await pushChangedOnly(s0); } catch {}
      SAVING_IN_PROGRESS = false;
      try { sessionStorage.setItem("removals_open_plan", e.id); } catch {}
      setView({ screen: "enquiryDetail", id: e.id });
      window.location.reload();
      return;
    }
    const jid = uid();
    const planned = Array.isArray(e.stages) ? e.stages : [];
    const stages = planned.length
      ? planned.map(d => ({ id: uid(), type: d.type || "Move", date: d.date || e.preferredDate || "", time: "", vehicleIds: [], crew: [], staffCount: d.staffCount || "", vehTypes: d.vehTypes || {}, notes: d.notes || "" }))
      : [{ id: uid(), type: "Move", date: e.preferredDate || "", time: "", vehicleIds: [], crew: [], notes: "" }];
    const job = {
      id: jid, customerId: e.customerId, enquiryId: e.id,
      startTime: "",
      fromAddress1: e.fromAddress1, fromAddress2: e.fromAddress2, fromTown: e.fromTown, fromPostcode: e.fromPostcode, fromAccess: e.fromAccess,
      toAddress1: e.toAddress1, toAddress2: e.toAddress2, toTown: e.toTown, toPostcode: e.toPostcode, toAccess: e.toAccess,
      crew: [], vehicle: "", vehicleIds: [],
      stages,
      moveDate: stages[0]?.date || e.preferredDate || "",
      volumeCuFt: e.volumeCuFt, volumeM3: e.volumeM3, weightKg: e.weightKg,
      price: e.quoteTotal || 0, deposit: 0, depositPaid: false, balancePaid: false,
      status: "Provisional", notes: "", createdAt: new Date().toISOString(),
    };
    let d2 = upsertLocal(data, "jobs", job);
    d2 = upsertLocal(d2, "enquiries", { ...e, status: "Won", quoteStatus: "Accepted" });
    showSavingOverlay(); SAVING_IN_PROGRESS = true;
    const stamped = stampData(d2);
    localStorage.setItem(DB_KEY, JSON.stringify(stamped));
    try { await pushChangedOnly(stamped); } catch {}
    SAVING_IN_PROGRESS = false;
    try { sessionStorage.setItem("removals_open_plan", e.id); } catch {}
    setView({ screen: "enquiryDetail", id: e.id });
    window.location.reload();
  }
  async function markLost() {
    const reason = prompt("Reason lost? (optional)") || "";
    await setStatus("Lost", { lostReason: reason });
  }
  const [followUpOpen, setFollowUpOpen] = useState(false);
  const setFollowUp = () => setFollowUpOpen(true);
  async function del() {
    if (!confirm("Delete this enquiry? This cannot be undone.")) return;
    addTombstone(e.id);
    showSavingOverlay(); SAVING_IN_PROGRESS = true;
    try { await deleteRecord("enquiries", e.id); } catch {}
    const d2 = { ...data, enquiries: (data.enquiries || []).filter(x => x.id !== e.id) };
    localStorage.setItem(DB_KEY, JSON.stringify(d2));
    SAVING_IN_PROGRESS = false;
    setView({ screen: "enquiries" });
    window.location.reload();
  }

  const rec = recommendVehicle(e.volumeCuFt);

  return (
    <div>
      <button onClick={() => setView({ screen: "enquiries" })} style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "#EEF3F2", border: "1px solid #DCE5E3", borderRadius: 10, padding: "10px 16px", fontSize: 15.5, fontWeight: 800, color: NAVY, cursor: "pointer" }}><Icon name="back" size={16} /> Back</button>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "14px 0 4px" }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: "#111827" }}>{custName(data, e.customerId)}</h2>
        <StatusBadge status={e.status} />
      </div>
      {customer && (
        <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
          {customer.phone && <Btn variant="grey" onClick={() => window.location.href = `tel:${customer.phone}`}>📞 Call</Btn>}
          {customer.email && <Btn variant="grey" onClick={() => window.location.href = `mailto:${customer.email}`}>✉️ Email</Btn>}
          <MessageButton size="md" variant="primary" customer={customer} ctx={{ date: e.preferredDate ? fmtDate(e.preferredDate) : (e.moveMonth ? fmtMonth(e.moveMonth) : ""), survey_date: e.surveyDate ? fmtDate(e.surveyDate) : "", survey_time: e.surveyTime || "", price: e.quoteTotal ? gbp(e.quoteTotal) : "", deposit: e.quoteTotal ? gbp(Math.round(e.quoteTotal * 0.6)) : "" }} />
        </div>
      )}

      <Card>
        <Row label="Move date" value={e.preferredDate ? fmtDate(e.preferredDate) + (e.dateFlexible ? " (flexible)" : "") : (e.moveMonth ? fmtMonth(e.moveMonth) + " (month)" : "TBC")} />
        <Row label="From" value={[e.fromAddress1, e.fromAddress2, e.fromTown, e.fromPostcode].filter(Boolean).join(", ")} />
        <Row label="From property" value={[e.fromPropertyType, e.fromBedrooms && `${e.fromBedrooms} bed`, e.fromFloor].filter(Boolean).join(" · ")} />
        {e.fromAccess && <Row label="From access" value={e.fromAccess} />}
        {storeSummary(e) && <Row label="Storage" value={storeSummary(e)} />}
        <Row label="To" value={[e.toAddress1, e.toAddress2, e.toTown, e.toPostcode].filter(Boolean).join(", ")} />
        <Row label="To property" value={[e.toPropertyType, e.toFloor].filter(Boolean).join(" · ")} />
        {e.toAccess && <Row label="To access" value={e.toAccess} />}
        {e.notes && <Row label="Notes" value={e.notes} />}
      </Card>

      {/* Survey */}
      <Card style={{ background: e.volumeCuFt ? "#F0FDFA" : "#fff" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 700, color: "#111827" }}>Survey / Inventory</div>
            {e.surveyDate && <div style={{ fontSize: 13, color: TEAL_D, fontWeight: 600, marginTop: 2 }}>📅 {fmtDate(e.surveyDate)}{e.surveyTime ? ` · ${e.surveyTime}` : ""}</div>}
            <div style={{ fontSize: 13, color: "#6B7280", marginTop: 2 }}>
              {e.volumeCuFt ? `${e.volumeCuFt} cu ft · ${e.volumeM3} m³ · ${e.weightKg} kg` : "Not surveyed yet"}
            </div>
            {e.volumeCuFt > 0 && <div style={{ fontSize: 13, color: TEAL, fontWeight: 600, marginTop: 2 }}>{rec.vehicle}{rec.loads > 1 ? ` × ${rec.loads}` : ""}</div>}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, flexShrink: 0 }}>
            <Btn size="sm" onClick={() => setShowInv(true)}><Icon name="box" size={14} /> {e.volumeCuFt ? "Edit" : "Start"}</Btn>
            {e.surveyDate && (() => { const surveyed = e.surveyDone || ["Surveyed", "Quoted", "Won"].includes(e.status); return <Btn size="sm" variant={surveyed ? "grey" : "primary"} onClick={async () => { const done = !surveyed; await saveAndReload(upsertLocal(data, "enquiries", { ...e, surveyDone: done, status: done ? (e.status === "New" ? "Surveyed" : e.status) : (e.status === "Surveyed" ? "New" : e.status) })); }}>{surveyed ? "✓ Surveyed" : "Mark surveyed"}</Btn>; })()}
          </div>
        </div>
      </Card>

      {/* Move plan */}
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, color: "#111827" }}>Move plan</div>
            {(!e.stages || e.stages.length === 0) ? (
              <div style={{ fontSize: 13, color: "#6B7280", marginTop: 2 }}>No days planned yet</div>
            ) : (
              <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                {e.stages.map((d, i) => (
                  <div key={d.id || i} style={{ fontSize: 13, color: "#374151" }}>
                    <b style={{ color: "#10211E" }}>Day {i + 1}:</b> {d.type || "—"} · {d.date ? `${fmtDate(d.date)} (${dow(d.date)})` : "Date TBC"}
                    {(d.crew && d.crew.length) ? ` · ${d.crew.length} crew` : (d.staffCount ? ` · ${d.staffCount} staff` : "")}
                    {(d.vehicleIds && d.vehicleIds.length) ? ` · ${d.vehicleIds.map(vname).filter(Boolean).join(", ")}` : (vehTypesSummary(d.vehTypes) ? ` · ${vehTypesSummary(d.vehTypes)}` : "")}
                  </div>
                ))}
              </div>
            )}
          </div>
          <Btn size="sm" onClick={() => setShowPlan(true)}><Icon name="calendar" size={14} /> {(e.stages && e.stages.length) ? "Edit" : "Add"}</Btn>
        </div>
      </Card>

      {linkedJob && (
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <div style={{ fontWeight: 700, color: "#111827" }}>Move {moveRef(data, linkedJob)}</div>
                <StatusBadge status={linkedJob.status} />
              </div>
              <div style={{ fontSize: 13, color: "#6B7280", marginTop: 3 }}>
                {gbp(linkedJob.price)}{linkedJob.deposit ? ` · dep ${gbp(linkedJob.deposit)}${linkedJob.depositPaid ? " ✓" : ""}` : ""} · bal {gbp((Number(linkedJob.price) || 0) - (Number(linkedJob.deposit) || 0))}{linkedJob.balancePaid ? " ✓" : ""}
              </div>
            </div>
            <Btn size="sm" onClick={() => setShowMove(true)}><Icon name="check" size={14} /> Manage</Btn>
          </div>
        </Card>
      )}

      {/* Quote */}
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 700, color: "#111827" }}>Quote</div>
            <div style={{ fontSize: 13, color: "#6B7280", marginTop: 2 }}>
              {e.quoteTotal ? `${gbp(e.quoteTotal)} · ${e.quoteStatus}` : "No quote yet"}
              {e.quoteSentDate ? ` · sent ${fmtDateShort(e.quoteSentDate)}` : ""}
            </div>
          </div>
          <Btn size="sm" variant="amber" onClick={() => setShowQuote(true)}><Icon name="quote" size={14} /> {e.quoteTotal ? "Edit" : "Build"}</Btn>
        </div>
        {e.quoteTotal ? <Btn size="sm" variant="grey" style={{ marginTop: 10 }} onClick={() => setView({ screen: "quotePdf", id: e.id })}><Icon name="quote" size={14} /> Save PDF quote</Btn> : null}
        {((e.inventory && e.inventory.length) || (e.stages && e.stages.length)) ? <Btn size="sm" variant="grey" style={{ marginTop: 10 }} onClick={() => setView({ screen: "surveyPdf", id: e.id })}><Icon name="quote" size={14} /> Survey &amp; move plan PDF</Btn> : null}
      </Card>

      {e.followUpDate && (
        <Card style={{ background: "#FFFBEB" }}>
          <div style={{ fontSize: 13, color: "#92400E" }}><b>Follow-up {fmtDate(e.followUpDate)}:</b> {e.followUpNote || "—"}</div>
        </Card>
      )}

      {/* Actions */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14 }}>
        {!["Won", "Lost"].includes(e.status) && <Btn onClick={markWon} style={{ flex: 1 }}><Icon name="check" size={16} /> Create provisional move</Btn>}
        {e.status === "Won" && linkedJob && <Btn variant="grey" style={{ flex: 1 }} onClick={() => setShowMove(true)}>Manage move</Btn>}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
        <Btn onClick={() => setShowEdit(true)}><Icon name="edit" size={15} /> Edit</Btn>
        <Btn variant="grey" onClick={setFollowUp}>⏰ Follow-up</Btn>
        {!["Won", "Lost"].includes(e.status) && <Btn variant="grey" onClick={markLost}>Mark Lost</Btn>}
        <Btn variant="danger" size="sm" onClick={del}><Icon name="trash" size={14} /> Delete</Btn>
      </div>

      {showEdit && <EnquiryForm data={data} editEnquiry={e} onClose={() => setShowEdit(false)} />}
      {followUpOpen && <FollowUpModal data={data} enquiry={e} onClose={() => setFollowUpOpen(false)} />}
      {showInv && <InventoryModal data={data} enquiry={e} onClose={() => setShowInv(false)} />}
      {showQuote && <QuoteModal data={data} enquiry={e} onClose={() => setShowQuote(false)} />}
      {showPlan && <MovePlanModal data={data} enquiry={e} onClose={() => setShowPlan(false)} />}
      {showMove && linkedJob && <MoveManageModal data={data} job={linkedJob} onClose={() => setShowMove(false)} />}
    </div>
  );
}

// ── Customers ───────────────────────────────────────────────────────────────
function CustomersList({ data, setView }) {
  const [q, setQ] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [showRefPanel, setShowRefPanel] = useState(false);
  const [startVal, setStartVal] = useState(String(getRefStart()));
  const [busy, setBusy] = useState(false);
  const customers = [...(data.customers || [])]
    .filter(c => !q || `${c.name} ${c.company} ${c.phone} ${c.town} ${c.ref || ""}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const missing = (data.customers || []).filter(c => !c.ref).length;

  function saveStart() { setRefStart(startVal); setShowRefPanel(false); }
  async function assignExisting() {
    if (!confirm(`Give a reference number to ${missing} customer${missing !== 1 ? "s" : ""} that don't have one yet?`)) return;
    setBusy(true);
    const ordered = [...(data.customers || [])].sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
    let counter = Math.max(getRefStart(), maxCustomerRef(data) + 1);
    let d = data;
    for (const c of ordered) {
      if (c.ref) continue;
      d = upsertLocal(d, "customers", { ...c, ref: counter });
      counter++;
    }
    await saveAndReload(d);
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: "#111827" }}>Customers</h2>
      </div>

      {showRefPanel && false && <div />}

      <div style={{ marginBottom: 12 }}><Input value={q} onChange={setQ} placeholder="🔍 Search customers…" /></div>
      {customers.length === 0 && <Empty icon="customers" text="No customers yet" />}
      {customers.map(c => {
        const jobs = (data.jobs || []).filter(j => j.customerId === c.id).length;
        return (
          <Card key={c.id} onClick={() => setView({ screen: "customerDetail", id: c.id })}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontWeight: 700, color: "#111827" }}>{c.ref ? <span style={{ color: TEAL_D, fontWeight: 800 }}>#{c.ref} </span> : ""}{c.name}{c.company ? ` · ${c.company}` : ""}</div>
                <div style={{ fontSize: 13, color: "#6B7280", marginTop: 2 }}>{[c.phone, c.town].filter(Boolean).join(" · ") || "—"}</div>
              </div>
              <span style={{ fontSize: 12, color: "#9CA3AF" }}>{jobs} move{jobs !== 1 ? "s" : ""}</span>
            </div>
          </Card>
        );
      })}
      {showForm && <CustomerForm data={data} onClose={() => setShowForm(false)} />}
    </div>
  );
}

function CustomerForm({ data, onClose, editCustomer }) {
  const c = editCustomer || {};
  const [f, setF] = useState({
    name: c.name || "", company: c.company || "", phone: c.phone || "", homePhone: c.homePhone || "", email: c.email || "",
    address1: c.address1 || "", address2: c.address2 || "", town: c.town || "", county: c.county || "", postcode: c.postcode || "",
    custType: c.custType || "Private", notes: c.notes || "",
  });
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  async function save() {
    if (!f.name.trim()) { alert("Name is required."); return; }
    const rec = { ...c, ...f, id: c.id || uid(), ref: c.ref || null, createdAt: c.createdAt || new Date().toISOString() };
    if (!c.id) { try { sessionStorage.setItem("removals_view", JSON.stringify({ screen: "newEnquiry", customerId: rec.id })); } catch {} }
    await saveAndReload(upsertLocal(data, "customers", rec));
  }
  return (
    <Modal title={c.id ? "Edit Customer" : "New Customer"} onClose={onClose}>
      <Field label="Full name" required><Input value={f.name} onChange={v => set("name", v)} /></Field>
      <Field label="Type"><Select value={f.custType} onChange={v => set("custType", v)} options={["Private", "Commercial"]} /></Field>
      {f.custType === "Commercial" && <Field label="Company"><Input value={f.company} onChange={v => set("company", v)} /></Field>}
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}><Field label="Mobile phone"><Input value={f.phone} onChange={v => set("phone", v)} /></Field></div>
        <div style={{ flex: 1 }}><Field label="Home phone"><Input value={f.homePhone} onChange={v => set("homePhone", v)} /></Field></div>
      </div>
      <Field label="Email"><Input type="email" value={f.email} onChange={v => set("email", v)} /></Field>
      <Field label="Address"><Input value={f.address1} onChange={v => set("address1", v)} /></Field>
      <Field label="Address line 2"><Input value={f.address2} onChange={v => set("address2", v)} placeholder="(optional)" /></Field>
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}><Field label="Town"><Input value={f.town} onChange={v => set("town", v)} /></Field></div>
        <div style={{ width: 120 }}><Field label="Postcode"><Input value={f.postcode} onChange={v => set("postcode", v)} /></Field></div>
      </div>

      <Field label="Notes"><Textarea value={f.notes} onChange={v => set("notes", v)} /></Field>
      <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
        <Btn variant="grey" style={{ flex: 1 }} onClick={onClose}>Cancel</Btn>
        <Btn style={{ flex: 2 }} onClick={save}>{c.id ? "Save" : "Create"}</Btn>
      </div>
    </Modal>
  );
}

function CommLogForm({ data, customer, entry, preset, onClose }) {
  const now = new Date();
  const pad = n => String(n).padStart(2, "0");
  const [type, setType] = useState(entry?.type || preset?.type || "Call");
  const [direction, setDirection] = useState(entry?.direction || preset?.direction || "out");
  const [note, setNote] = useState(entry?.note || "");
  const [date, setDate] = useState(entry?.at ? entry.at.slice(0, 10) : `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`);
  const [time, setTime] = useState(entry?.at ? entry.at.slice(11, 16) : `${pad(now.getHours())}:${pad(now.getMinutes())}`);
  const inp = { width: "100%", padding: "9px 10px", border: "1px solid #D9E2E0", borderRadius: 9, fontSize: 14, boxSizing: "border-box", background: "#fff" };
  const paste = async () => { try { const t = await navigator.clipboard.readText(); if (t) setNote(n => n ? n + "\n" + t : t); else alert("Clipboard is empty."); } catch { alert("Couldn't read the clipboard — please paste into the box manually."); } };
  async function save() {
    let at; try { at = new Date(`${date}T${time || "00:00"}`).toISOString(); } catch { at = new Date().toISOString(); }
    const rec = { id: entry?.id || uid(), at, type, direction, note: note.trim() };
    const comms = entry ? (customer.comms || []).map(x => x.id === rec.id ? rec : x) : [...(customer.comms || []), rec];
    await saveAndReload(upsertLocal(data, "customers", { ...customer, comms }));
  }
  async function del() {
    if (!confirm("Delete this log entry?")) return;
    await saveAndReload(upsertLocal(data, "customers", { ...customer, comms: (customer.comms || []).filter(x => x.id !== entry.id) }));
  }
  return (
    <Modal title={entry ? "Edit log entry" : (preset ? "Paste reply" : "Log communication")} onClose={onClose}>
      <Field label="Type"><Select value={type} onChange={setType} options={["Call", "Text", "WhatsApp", "Email", "Note"]} /></Field>
      <Field label="Direction"><Select value={direction === "out" ? "Outbound" : "Inbound"} onChange={v => setDirection(v === "Outbound" ? "out" : "in")} options={["Outbound", "Inbound"]} /></Field>
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}><Field label="Date"><Input type="date" value={date} onChange={setDate} /></Field></div>
        <div style={{ width: 120 }}><Field label="Time"><input type="time" value={time} onChange={e => setTime(e.target.value)} style={inp} /></Field></div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#374151" }}>{type === "Call" ? "Description of call" : "Message / notes"}</div>
        <button onClick={paste} style={{ background: "#EEF3F2", border: "1px solid #DCE5E3", borderRadius: 8, padding: "5px 10px", fontSize: 12, fontWeight: 700, color: NAVY, cursor: "pointer" }}>📋 Paste from clipboard</button>
      </div>
      <Textarea value={note} onChange={setNote} placeholder={type === "Call" ? "What was discussed on the call" : "What was said / sent"} />
      <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
        {entry && <Btn variant="danger" onClick={del}><Icon name="trash" size={14} /></Btn>}
        <Btn variant="grey" style={{ flex: 1 }} onClick={onClose}>Cancel</Btn>
        <Btn style={{ flex: 2 }} onClick={save}>{entry ? "Save" : "Save to log"}</Btn>
      </div>
    </Modal>
  );
}

function CustomerDetail({ data, id, setView }) {
  const c = (data.customers || []).find(x => x.id === id);
  const latestEnq = (data.enquiries || []).filter(x => x.customerId === id).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))[0];
  const msgCtx = latestEnq ? {
    survey_date: latestEnq.surveyDate ? fmtDate(latestEnq.surveyDate) : "",
    survey_time: latestEnq.surveyTime || "",
    date: latestEnq.preferredDate ? fmtDate(latestEnq.preferredDate) : (latestEnq.moveMonth ? fmtMonth(latestEnq.moveMonth) : ""),
    price: latestEnq.quoteTotal ? gbp(latestEnq.quoteTotal) : "",
    deposit: latestEnq.quoteTotal ? gbp(Math.round(latestEnq.quoteTotal * 0.6)) : "",
  } : {};
  const [showEdit, setShowEdit] = useState(false);
  const [jobForm, setJobForm] = useState(null);
  const [commForm, setCommForm] = useState(false);
  const [followUpOpen, setFollowUpOpen] = useState(false);
  const [sheetBusy, setSheetBusy] = useState(false);
  async function openSheet(rec) {
    if (sheetBusy) return;
    // Prefer the stored PDF — just open it to view (no re-save).
    const openUrl = url => { const a = document.createElement("a"); a.href = url; a.target = "_blank"; a.rel = "noopener"; document.body.appendChild(a); a.click(); a.remove(); };
    if (rec.pdfUrl) { openUrl(rec.pdfUrl); return; }
    if (rec.pdf) { try { const b = atob(rec.pdf.split(",")[1]); const arr = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) arr[i] = b.charCodeAt(i); const url = URL.createObjectURL(new Blob([arr], { type: "application/pdf" })); openUrl(url); setTimeout(() => URL.revokeObjectURL(url), 8000); return; } catch {} }
    // Fallback (older sheets saved before PDFs were stored): rebuild once.
    setSheetBusy(true);
    try {
      const { bytes } = await buildStorageIntakePdf(rec, c, data);
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      openUrl(url); setTimeout(() => URL.revokeObjectURL(url), 8000);
    } catch (ex) { alert("Could not open sheet: " + ((ex && ex.message) || ex)); }
    setSheetBusy(false);
  }
  const openCollection = col => {
    const openUrl = url => { const a = document.createElement("a"); a.href = url; a.target = "_blank"; a.rel = "noopener"; document.body.appendChild(a); a.click(); a.remove(); };
    if (col.pdfUrl) { openUrl(col.pdfUrl); return; }
    if (col.pdf) { try { const b = atob(col.pdf.split(",")[1]); const arr = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) arr[i] = b.charCodeAt(i); const url = URL.createObjectURL(new Blob([arr], { type: "application/pdf" })); openUrl(url); setTimeout(() => URL.revokeObjectURL(url), 8000); } catch {} }
  };
  if (!c) return <div style={{ padding: 20 }}>Customer not found.</div>;
  const enquiries = (data.enquiries || []).filter(e => e.customerId === id).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  const jobs = (data.jobs || []).filter(j => j.customerId === id);
  async function del() {
    if (!confirm("Delete this customer?")) return;
    addTombstone(c.id);
    SAVING_IN_PROGRESS = true; showSavingOverlay();
    try { await deleteRecord("customers", c.id); } catch {}
    const d2 = { ...data, customers: (data.customers || []).filter(x => x.id !== c.id) };
    localStorage.setItem(DB_KEY, JSON.stringify(d2));
    SAVING_IN_PROGRESS = false; setView({ screen: "customers" }); window.location.reload();
  }
  return (
    <div>
      <button onClick={() => setView({ screen: "customers" })} style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "#EEF3F2", border: "1px solid #DCE5E3", borderRadius: 10, padding: "10px 16px", fontSize: 15.5, fontWeight: 800, color: NAVY, cursor: "pointer" }}><Icon name="back" size={16} /> Back</button>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "14px 0" }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: "#111827" }}>{c.ref ? <span style={{ color: TEAL_D }}>#{c.ref} </span> : ""}{c.name}</h2>
        <StatusBadge status={c.custType} />
      </div>
      <Card>
        <Row label="Reference" value={c.ref ? `#${c.ref}` : "Pending — assigned on next sync"} />
        <Row label="Mobile" value={c.phone} />
        {c.homePhone && <Row label="Home phone" value={c.homePhone} />}
        <Row label="Email" value={c.email} />
        {c.company && <Row label="Company" value={c.company} />}
        <Row label="Address" value={[c.address1, c.address2, c.town, c.postcode].filter(Boolean).join(", ")} />
        {c.notes && <Row label="Notes" value={c.notes} />}
      </Card>
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: getStorageJobs(c).length ? 8 : 0 }}>
          <div style={{ fontSize: 12, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".06em", color: "#94A4A0" }}>Storage jobs</div>
          <Btn size="sm" onClick={() => { if (!customerHasStorageMove(data, c.id)) { alert("No accepted storage move for this customer.\n\nThe quote must be accepted (job Confirmed) and the move must include going into store — tick “Moving into store” on the enquiry or add an “Into store” day to the move plan."); return; } setJobForm("new"); }}>+ Add storage job</Btn>
        </div>
        {getStorageJobs(c).length === 0 && <div style={{ fontSize: 13, color: "#9CA3AF", marginTop: 8 }}>No storage jobs yet.</div>}
        {getStorageJobs(c).map((j, idx) => (
          <div key={j.id || idx} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: idx < getStorageJobs(c).length - 1 ? "1px solid #F0F4F3" : "none" }}>
            <div onClick={() => setView({ screen: "storageJob", customerId: c.id, jobId: j.id })} style={{ flex: 1, minWidth: 0, cursor: "pointer" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
                <div style={{ fontWeight: 700, color: "#10211E" }}>{j.location || "—"}{j.value ? ` · £${Number(j.value).toLocaleString("en-GB")}` : ""}</div>
                <span style={{ fontSize: 11.5, fontWeight: 800, color: jobInStore(j) ? "#0F766E" : "#9CA3AF", background: jobInStore(j) ? "#E8F5F3" : "#F1F3F2", borderRadius: 999, padding: "2px 9px" }}>{jobInStore(j) ? "In store" : "Out"}</span>
              </div>
              <div style={{ fontSize: 12.5, color: "#6A7B77" }}>
                {j.dateIn ? `In ${fmtUK(j.dateIn)}` : ""}{j.dateOut ? ` · Out ${fmtUK(j.dateOut)}` : ""}{jobContainerCount(c, j) ? ` · ${jobContainerCount(c, j)} container${jobContainerCount(c, j) != 1 ? "s" : ""}` : ""}{jobContainerNos(c, j).length ? ` (${jobContainerNos(c, j).join(", ")})` : ""}
              </div>
              {jobLoose(c, j).any && <div style={{ fontSize: 12.5, color: "#6A7B77" }}>Loose: {jobLoose(c, j).notes.join("; ") || "Yes"}</div>}
            </div>
            <span onClick={() => setJobForm(j)} style={{ color: TEAL, fontSize: 12.5, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>Edit</span>
          </div>
        ))}
        {getStorageJobs(c).map(j => sheetsForJob(c, j).length ? (
          <div key={"inv" + (j.id || "")} style={{ marginTop: 8, paddingLeft: 10, borderLeft: "2px solid #EEF3F2" }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: "#B7C4C1", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 4 }}>{j.location || "Storage"}{jobInStore(j) ? "" : " · out"} — inventories</div>
            {sheetsForJob(c, j).map(rec => (
              <div key={rec.id} style={{ marginBottom: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <div style={{ fontSize: 12.5, color: "#374151" }}>Inventory {rec.date ? fmtUK(rec.date) : ""} · {(rec.containers || []).length} cont.</div>
                  <span onClick={() => openSheet(rec)} style={{ color: TEAL, fontSize: 12, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>{sheetBusy ? "…" : "PDF"}</span>
                </div>
                {(rec.collections || []).slice().reverse().map(col => (
                  <div key={col.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, paddingLeft: 10 }}>
                    <div style={{ fontSize: 12, color: "#8A6D3B" }}>Collected {col.date ? fmtUK(col.date) : ""}{col.collectedBy ? ` · ${col.collectedBy}` : ""}</div>
                    {(col.pdfUrl || col.pdf) && <span onClick={() => openCollection(col)} style={{ color: TEAL, fontSize: 12, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>Receipt</span>}
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : null)}
      </Card>
      <div style={{ display: "flex", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
        <Btn onClick={() => setShowEdit(true)}><Icon name="edit" size={15} /> Edit</Btn>
        <Btn variant="grey" onClick={() => setFollowUpOpen(true)}>⏰ {c.followUpDate ? "Follow-up ·" + fmtUK(c.followUpDate).slice(0, 5) : "Follow-up"}</Btn>
        <MessageButton customer={c} ctx={msgCtx} size="md" variant="primary" />
        {c.phone && <Btn variant="grey" onClick={() => { logComm(c.id, { type: "Call" }); window.location.href = `tel:${c.phone}`; }}>📞 Call</Btn>}
        {c.email && <Btn variant="grey" onClick={() => { logComm(c.id, { type: "Email" }); window.location.href = `mailto:${c.email}`; }}>✉️ Email</Btn>}
        <Btn size="sm" variant="danger" onClick={del}><Icon name="trash" size={14} /> Delete</Btn>
      </div>

      <SectionTitle>Enquiries</SectionTitle>
      {enquiries.length === 0 && <div style={{ fontSize: 13, color: "#9CA3AF", marginBottom: 10 }}>None yet.</div>}
      {enquiries.map(e => (
        <Card key={e.id} onClick={() => setView({ screen: "enquiryDetail", id: e.id })}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 14, color: "#111827" }}>{e.fromTown || "—"} → {e.toTown || "—"} · {fmtDateShort(e.preferredDate)}</div>
            <StatusBadge status={e.status} />
          </div>
        </Card>
      ))}

      <SectionTitle>Booked moves</SectionTitle>
      {jobs.filter(j => j.status !== "Completed").length === 0 && <div style={{ fontSize: 13, color: "#9CA3AF" }}>None yet.</div>}
      {jobs.filter(j => j.status !== "Completed").sort((a, b) => (a.moveDate || "").localeCompare(b.moveDate || "")).map(j => (
        <Card key={j.id} onClick={() => setView(j.enquiryId ? { screen: "enquiryDetail", id: j.enquiryId } : { screen: "jobDetail", id: j.id })}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 14, color: "#111827" }}><b style={{ color: TEAL_D }}>{moveRef(data, j)}</b> · {fmtDate(j.moveDate)} ({dow(j.moveDate)}) · {gbp(j.price)}</div>
            <StatusBadge status={j.status} />
          </div>
        </Card>
      ))}

      {jobs.some(j => j.status === "Completed") && (
        <>
          <SectionTitle>Completed moves</SectionTitle>
          {jobs.filter(j => j.status === "Completed").sort((a, b) => (b.moveDate || "").localeCompare(a.moveDate || "")).map(j => (
            <Card key={j.id} onClick={() => setView(j.enquiryId ? { screen: "enquiryDetail", id: j.enquiryId } : { screen: "jobDetail", id: j.id })}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontSize: 14, color: "#111827" }}><b style={{ color: TEAL_D }}>{moveRef(data, j)}</b> · {fmtDate(j.moveDate)} ({dow(j.moveDate)}) · {gbp(j.price)}</div>
                <StatusBadge status={j.status} />
              </div>
            </Card>
          ))}
        </>
      )}
      {showEdit && <CustomerForm data={data} editCustomer={c} onClose={() => setShowEdit(false)} />}
      {jobForm && <StorageJobForm data={data} customer={c} job={jobForm === "new" ? null : jobForm} onClose={() => setJobForm(null)} />}
      {commForm && <CommLogForm data={data} customer={c} entry={commForm.entry} preset={commForm.preset} onClose={() => setCommForm(null)} />}
      {followUpOpen && <FollowUpModal data={data} record={c} table="customers" onClose={() => setFollowUpOpen(false)} />}

      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: (c.comms || []).length ? 8 : 0 }}>
          <div style={{ fontSize: 12, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".06em", color: "#94A4A0" }}>Communication log</div>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn size="sm" variant="grey" onClick={() => setCommForm({ preset: { direction: "in", type: "WhatsApp" } })}>📋 Paste reply</Btn>
            <Btn size="sm" variant="grey" onClick={() => setCommForm({})}>+ Log</Btn>
          </div>
        </div>
        {(c.comms || []).length === 0 && <div style={{ fontSize: 13, color: "#9CA3AF", marginTop: 8 }}>No communications logged.</div>}
        {(c.comms || []).slice().sort((a, b) => (b.at || "").localeCompare(a.at || "")).map(cm => {
          const icon = cm.type === "Call" ? "📞" : cm.type === "WhatsApp" ? "💬" : cm.type === "Text" ? "✉️" : cm.type === "Email" ? "📧" : "📝";
          const dt = cm.at ? new Date(cm.at) : null;
          const when = dt && !isNaN(dt) ? `${fmtUK(cm.at.slice(0, 10))} ${cm.at.slice(11, 16)}` : "";
          return (
            <div key={cm.id} onClick={() => setCommForm({ entry: cm })} style={{ padding: "8px 0", borderBottom: "1px solid #F0F4F3", cursor: "pointer" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontWeight: 700, color: "#10211E", fontSize: 13.5 }}>{icon} {cm.type}<span style={{ color: "#9CA3AF", fontWeight: 600 }}> · {cm.direction === "in" ? "in" : "out"}</span></div>
                <div style={{ fontSize: 12, color: "#6A7B77" }}>{when}</div>
              </div>
              {cm.note ? <div style={{ fontSize: 12.5, color: "#6A7B77", marginTop: 2, whiteSpace: "pre-wrap" }}>{cm.note}</div> : (cm.type === "Call" ? <div style={{ fontSize: 12, color: "#B45309", marginTop: 2 }}>Tap to add a description</div> : null)}
            </div>
          );
        })}
      </Card>
    </div>
  );
}

// ── Jobs (booked moves) ─────────────────────────────────────────────────────
function JobsList({ data, setView }) {
  const [filter, setFilter] = useState("Booked");
  const jobs = (data.jobs || [])
    .filter(j => filter === "All" ? true : filter === "Completed" ? j.status === "Completed" : j.status !== "Completed")
    .sort((a, b) => (a.moveDate || "").localeCompare(b.moveDate || ""));
  const filters = ["Booked", "Completed", "All"];
  return (
    <div>
      <h2 style={{ margin: "0 0 12px", fontSize: 20, fontWeight: 800, color: "#111827" }}>Booked Moves</h2>
      <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 8, marginBottom: 6 }}>
        {filters.map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{ padding: "6px 14px", borderRadius: 99, border: "none", whiteSpace: "nowrap", cursor: "pointer", fontSize: 13, fontWeight: 600, background: filter === f ? TEAL : "#F3F4F6", color: filter === f ? "#fff" : "#6B7280" }}>{f}</button>
        ))}
      </div>
      {jobs.length === 0 && <Empty icon="truck" text="No moves here" />}
      {jobs.map(j => (
        <Card key={j.id} onClick={() => setView(j.enquiryId ? { screen: "enquiryDetail", id: j.enquiryId } : { screen: "jobDetail", id: j.id })}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 800, color: TEAL_D }}>{moveRef(data, j)}</div>
              <div style={{ fontWeight: 700, color: "#111827", marginTop: 1 }}>{custName(data, j.customerId)}</div>
              <div style={{ fontSize: 13, color: "#6B7280", marginTop: 2 }}>{fmtDate(j.moveDate)} ({dow(j.moveDate)}) · {j.fromTown || "—"} → {j.toTown || "—"}</div>
              <div style={{ fontSize: 12, color: "#9CA3AF", marginTop: 2 }}>{j.vehicle || "—"} · {gbp(j.price)}{j.deposit ? ` · dep ${gbp(j.deposit)}${j.depositPaid ? " ✓" : ""}` : ""}</div>
            </div>
            <StatusBadge status={j.status} />
          </div>
        </Card>
      ))}
    </div>
  );
}

// ── Vehicles & Staff (Company) ──────────────────────────────────────────────
const VEHICLE_COLORS = ["#0E7C73", "#4F46E5", "#D97706", "#DB2777", "#2563EB", "#16A34A", "#7C3AED", "#EA580C"];
function vehicleColor(data, vehicleId) {
  const list = data.vehicles || [];
  const idx = list.findIndex(v => v.id === vehicleId);
  return idx >= 0 ? VEHICLE_COLORS[idx % VEHICLE_COLORS.length] : "#94A4A0";
}
const VEHICLE_TYPES = ["18t", "7.5t", "3.5t", "Van"];
const STAFF_ROLES = ["Driver", "Porter", "Packer", "Driver / Porter", "Surveyor", "Owner", "Office"];

// Build a portable JSON backup of the whole dataset. Uses the native share sheet
// on mobile (save to Files / iCloud / email), falling back to a download link.
async function exportBackup(data) {
  const payload = {
    app: "removals-crm", version: 1, exportedAt: new Date().toISOString(),
    data: {
      customers: data.customers || [], enquiries: data.enquiries || [],
      jobs: data.jobs || [], vehicles: data.vehicles || [], staff: data.staff || [],
    },
  };
  const json = JSON.stringify(payload, null, 2);
  const fname = `removals-backup-${new Date().toISOString().slice(0, 10)}.json`;
  try {
    const file = new File([json], fname, { type: "application/json" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: "Removals CRM backup" });
      return;
    }
  } catch (e) { if (e && e.name === "AbortError") return; }
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url; a.download = fname; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Restore = merge the backup into the current data (backup copy wins by id).
// Non-destructive: existing records not in the backup are kept.
async function restoreBackup(currentData, inc) {
  const tables = ["customers", "enquiries", "jobs", "vehicles", "staff"];
  const merged = { ...EMPTY };
  const restoredIds = [];
  tables.forEach(t => {
    const byId = {};
    (currentData[t] || []).forEach(r => { if (r && r.id) byId[r.id] = r; });
    (inc[t] || []).forEach(r => { if (r && r.id) { byId[r.id] = r; restoredIds.push(r.id); } });
    merged[t] = Object.values(byId);
  });
  // Un-delete: clear tombstones so the merge can't strip them back out,
  // and drop their sync signatures so they're re-pushed to the cloud.
  removeTombstones(restoredIds);
  try {
    const sigs = JSON.parse(localStorage.getItem(SIG_KEY) || "{}");
    restoredIds.forEach(id => { delete sigs[id]; });
    localStorage.setItem(SIG_KEY, JSON.stringify(sigs));
  } catch {}
  const counts = tables.map(t => `${merged[t].length} ${t}`).join(", ");
  try { sessionStorage.setItem("restoreMsg", `Restore complete — now holding ${counts}.`); } catch {}
  await saveAndReload(merged);
}

// Permanently delete all customers, enquiries and jobs (keeps staff & vehicles).
// Deletes each record properly (tombstone + cloud delete) so it stays gone on every device.
async function wipeBusinessData(data) {
  const tables = ["jobs", "enquiries", "customers"];
  SAVING_IN_PROGRESS = true;
  showSavingOverlay();
  const all = [];
  tables.forEach(t => (data[t] || []).forEach(r => { if (r && r.id) all.push([t, r.id]); }));
  all.forEach(([, id]) => addTombstone(id));
  for (const [t, id] of all) { try { await deleteRecord(t, id); } catch {} }
  const cleared = { ...data, customers: [], enquiries: [], jobs: [] };
  localStorage.setItem(DB_KEY, JSON.stringify(cleared));
  try {
    const sigs = JSON.parse(localStorage.getItem(SIG_KEY) || "{}");
    all.forEach(([, id]) => { delete sigs[id]; });
    localStorage.setItem(SIG_KEY, JSON.stringify(sigs));
  } catch {}
  try { sessionStorage.setItem("restoreMsg", "All customers, enquiries and jobs have been deleted."); } catch {}
  SAVING_IN_PROGRESS = false;
  window.location.reload();
}

function RefStartControl({ data }) {
  const refs = (data.customers || []).map(c => Number(c.ref)).filter(n => !isNaN(n) && n > 0);
  const maxRef = refs.length ? Math.max(...refs) : 0;
  const [val, setVal] = useState(String(maxRef + 1));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const inp = { width: "100%", padding: "9px 10px", border: "1px solid #D9E2E0", borderRadius: 9, fontSize: 14, boxSizing: "border-box", background: "#fff" };
  async function apply() {
    setMsg("");
    const n = parseInt(val, 10);
    if (!n || n < 1) { setMsg("Enter a whole number of 1 or more."); return; }
    if (maxRef && n <= maxRef && !confirm(`Your highest existing reference is #${maxRef}. Starting at ${n} could clash with existing numbers. Continue anyway?`)) return;
    setBusy(true);
    try { await setCustomerRefStart(n); setMsg(`Done — the next new customer will be #${n}.`); }
    catch (e) { setMsg("Couldn't set it: " + ((e && e.message) || e) + ". Make sure the database function is installed."); }
    setBusy(false);
  }
  return (
    <div style={{ marginTop: 12, borderTop: "1px solid #EEF3F2", paddingTop: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 6 }}>Set the next reference number</div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <div style={{ width: 130 }}><input type="number" inputMode="numeric" value={val} onChange={e => setVal(e.target.value)} style={inp} /></div>
        <Btn size="sm" disabled={busy} onClick={apply}>{busy ? "Setting…" : "Set"}</Btn>
      </div>
      <div style={{ fontSize: 12, color: "#94A4A0", marginTop: 6 }}>Highest reference so far: {maxRef ? `#${maxRef}` : "none yet"}. The next new customer that syncs will take the number you set.</div>
      {msg && <div style={{ fontSize: 12.5, color: msg.startsWith("Done") ? "#15803D" : "#B45309", marginTop: 6 }}>{msg}</div>}
    </div>
  );
}

function unsyncedCount(data) {
  let sigs = {};
  try { sigs = JSON.parse(localStorage.getItem(SIG_KEY) || "{}"); } catch {}
  let n = 0;
  for (const name of TABLES) for (const rec of (data && data[name]) || []) { if (sigs[rec.id] !== dbSig(name, rec)) n++; }
  return n;
}

function SyncControl({ data, setData, compact }) {
  const [status, setStatus] = useState("idle");
  const [at, setAt] = useState(null);
  const [msg, setMsg] = useState("");
  const pending = unsyncedCount(data);
  async function doSync() {
    setStatus("syncing"); setMsg("");
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setStatus("error"); setMsg("This device is offline. Your changes are saved here and will upload automatically when you're back online.");
      return;
    }
    let merged;
    try {
      merged = mergeAll(await pullFromCloud(), loadData());
      try { localStorage.setItem(DB_KEY, JSON.stringify(merged)); } catch {}
      if (setData) setData(merged);
    } catch (e) {
      setStatus("error"); setMsg("Couldn't reach the cloud: " + ((e && e.message) || e));
      return;
    }
    try {
      await pushChangedOnly(merged);
      setStatus("done"); setAt(new Date());
    } catch (pe) {
      setStatus("error"); setMsg("Downloaded fine, but some changes couldn't upload — " + ((pe && pe.message) || pe));
    }
  }
  const hhmm = d => `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  const statusLine = status === "syncing" ? "Syncing…"
    : status === "error" ? "⚠ " + msg
    : status === "done" ? `✓ Synced ${at ? hhmm(at) : ""}`
    : pending > 0 ? `${pending} change${pending !== 1 ? "s" : ""} waiting to sync` : "✓ Up to date";
  const statusColor = status === "error" ? "#B45309" : (status === "done" || (status === "idle" && pending === 0)) ? "#15803D" : "#6A7B77";

  if (compact) {
    return (
      <button onClick={doSync} disabled={status === "syncing"} style={{ display: "inline-flex", alignItems: "center", gap: 6, background: pending > 0 ? "#FFF7ED" : "#F1F9F4", border: `1px solid ${pending > 0 ? "#FBD9A0" : "#CDE9D6"}`, borderRadius: 999, padding: "6px 12px", fontSize: 12, fontWeight: 700, color: statusColor, cursor: "pointer" }}>
        <span>🔄</span><span>{status === "syncing" ? "Syncing…" : pending > 0 ? `Sync (${pending})` : "Synced"}</span>
      </button>
    );
  }
  return (
    <div style={{ marginTop: 12, borderTop: "1px solid #EEF3F2", paddingTop: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Btn size="sm" disabled={status === "syncing"} onClick={doSync}>🔄 {status === "syncing" ? "Syncing…" : "Sync now"}</Btn>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: statusColor }}>{statusLine}</div>
      </div>
      <div style={{ fontSize: 12, color: "#94A4A0", marginTop: 6 }}>The app syncs on its own in the background, but you can force it here and see the result. “Waiting to sync” means changes are saved on this device and will upload as soon as there’s a connection.</div>
    </div>
  );
}

function OrphanCleanup({ data, setData }) {
  const custIds = new Set((data.customers || []).map(c => c.id));
  const orphanJobs = (data.jobs || []).filter(j => !custIds.has(j.customerId));
  const orphanEnq = (data.enquiries || []).filter(e => !custIds.has(e.customerId));
  const n = orphanJobs.length + orphanEnq.length;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  async function clean() {
    if (!n) { setMsg("Nothing to clean — no orphaned records."); return; }
    if (!confirm(`Remove ${n} orphaned record${n !== 1 ? "s" : ""} that no longer belong to a customer? This can't be undone.`)) return;
    setBusy(true);
    let d = loadData();
    for (const j of orphanJobs) { addTombstone(j.id); try { await deleteRecord("jobs", j.id); } catch {} d = { ...d, jobs: (d.jobs || []).filter(x => x.id !== j.id) }; }
    for (const e of orphanEnq) { addTombstone(e.id); try { await deleteRecord("enquiries", e.id); } catch {} d = { ...d, enquiries: (d.enquiries || []).filter(x => x.id !== e.id) }; }
    try { localStorage.setItem(DB_KEY, JSON.stringify(d)); } catch {}
    if (setData) setData(d);
    setBusy(false); setMsg(`Removed ${n} orphaned record${n !== 1 ? "s" : ""}.`);
  }
  return (
    <div style={{ marginTop: 12, borderTop: "1px solid #EEF3F2", paddingTop: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 4 }}>Clean up orphaned records</div>
      <div style={{ fontSize: 12, color: "#94A4A0", marginBottom: 8 }}>Removes any moves or enquiries left without a customer (e.g. after a reset) — including stray calendar entries.</div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Btn size="sm" variant={n ? "danger" : "grey"} disabled={busy || !n} onClick={clean}>{busy ? "Cleaning…" : n ? `Remove ${n} orphaned` : "None found"}</Btn>
        {msg && <div style={{ fontSize: 12.5, color: "#15803D", fontWeight: 700 }}>{msg}</div>}
      </div>
    </div>
  );
}

function CompanyView({ data, setView, setData }) {
  const restoreRef = useRef(null);
  const [restoring, setRestoring] = useState(false);
  const [wiping, setWiping] = useState(false);
  const [refStartVal, setRefStartVal] = useState(String(getRefStart()));
  const [refBusy, setRefBusy] = useState(false);
  const refMissing = (data.customers || []).filter(c => !c.ref).length;
  function saveRefStart() { setRefStart(refStartVal); alert("Saved. New customers will number up from " + (parseInt(refStartVal, 10) || 0) + "."); }
  async function assignRefs() {
    if (!confirm(`Give a reference number to ${refMissing} customer${refMissing !== 1 ? "s" : ""} that don't have one yet?`)) return;
    setRefBusy(true);
    const ordered = [...(data.customers || [])].sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
    let counter = Math.max(getRefStart(), maxCustomerRef(data) + 1);
    let d = data;
    for (const c of ordered) { if (c.ref) continue; d = upsertLocal(d, "customers", { ...c, ref: counter }); counter++; }
    await saveAndReload(d);
  }
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  async function doRestore(inc) {
    if (!inc || (!inc.customers && !inc.enquiries && !inc.jobs && !inc.staff && !inc.vehicles)) {
      alert("This doesn't look like a Removals CRM backup."); return;
    }
    const counts = ["customers", "enquiries", "jobs", "vehicles", "staff"].map(t => `${(inc[t] || []).length} ${t}`).join(", ");
    if (!confirm(`Restore this backup?\n\nIt contains: ${counts}.\n\nMatching records are added or updated from the backup. Nothing already on the device is deleted.`)) return;
    setRestoring(true);
    try { await restoreBackup(data, inc); }
    catch (err) { setRestoring(false); alert("Restore failed: " + ((err && err.message) || err)); }
  }
  async function onRestoreFile(ev) {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    try {
      const text = typeof file.text === "function" ? await file.text() : await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(file); });
      const payload = JSON.parse(text);
      await doRestore(payload && payload.data ? payload.data : payload);
    } catch (err) { alert("Couldn't read that file: " + ((err && err.message) || err)); }
  }
  async function onRestorePaste() {
    let payload;
    try { payload = JSON.parse(pasteText.trim()); }
    catch { alert("That isn't valid backup text. Open your backup file, Select All, Copy, then paste it here."); return; }
    await doRestore(payload && payload.data ? payload.data : payload);
  }
  async function onWipe() {
    const nc = (data.customers || []).length, ne = (data.enquiries || []).length, nj = (data.jobs || []).length;
    if (nc + ne + nj === 0) { alert("There are no customers, enquiries or jobs to delete."); return; }
    if (!confirm(`Delete ALL ${nc} customers, ${ne} enquiries and ${nj} jobs?\n\nStaff and vehicles are kept. This cannot be undone except by restoring a backup.`)) return;
    if (!confirm("Last check — permanently clear your live data on every device?")) return;
    setWiping(true);
    try { await wipeBusinessData(data); }
    catch (err) { setWiping(false); alert("Wipe failed: " + ((err && err.message) || err)); }
  }
  const [vForm, setVForm] = useState(null);   // null | {} | record
  const [sForm, setSForm] = useState(null);
  const vehicles = [...(data.vehicles || [])].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const staff = [...(data.staff || [])].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const truckIcon = <Icon name="truck" size={20} color="#fff" />;

  return (
    <div>
      <h2 style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 800, color: "#10211E" }}>Company</h2>
      <div style={{ fontSize: 13, color: "#6A7B77", marginBottom: 16 }}>Your fleet and team · <span style={{ color: TEAL, fontWeight: 700 }}>build B121</span></div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 14 }} className="rm-company-grid">
        <Card style={{ marginBottom: 0 }}>
          <h4 style={{ margin: "0 0 2px", fontSize: 12, textTransform: "uppercase", letterSpacing: ".06em", color: "#94A4A0", fontWeight: 800 }}>Sync</h4>
          <SyncControl data={data} setData={setData} />
          <OrphanCleanup data={data} setData={setData} />
        </Card>
        <Card style={{ marginBottom: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ minWidth: 0 }}>
              <h4 style={{ margin: "0 0 3px", fontSize: 12, textTransform: "uppercase", letterSpacing: ".06em", color: "#94A4A0", fontWeight: 800 }}>Item catalogue</h4>
              <div style={{ fontSize: 13, color: "#6A7B77" }}>Edit room items, volumes & weights. Syncs to all devices.</div>
            </div>
            <Btn size="sm" onClick={() => setView({ screen: "catalogue" })}>Edit</Btn>
          </div>
        </Card>

        <Card style={{ marginBottom: 0 }}>
          <h4 style={{ margin: "0 0 8px", fontSize: 12, textTransform: "uppercase", letterSpacing: ".06em", color: "#94A4A0", fontWeight: 800 }}>Tablet layout</h4>
          <div style={{ fontSize: 13, color: "#6A7B77", lineHeight: 1.5, marginBottom: 10 }}>Trial the compact iPhone-style layout on iPad. Turn it off any time to go back to the normal tablet layout.</div>
          {(() => { const on = (() => { try { return localStorage.getItem("removals_force_phone") === "1"; } catch { return false; } })();
            return <Btn variant={on ? "primary" : "grey"} onClick={() => { try { if (on) localStorage.removeItem("removals_force_phone"); else localStorage.setItem("removals_force_phone", "1"); } catch {} window.location.reload(); }}>{on ? "Compact layout ON — tap to revert" : "Use iPhone layout on this device"}</Btn>;
          })()}
        </Card>

        <Card style={{ marginBottom: 0 }}>
          <h4 style={{ margin: "0 0 8px", fontSize: 12, textTransform: "uppercase", letterSpacing: ".06em", color: "#94A4A0", fontWeight: 800 }}>Customer reference numbers</h4>
          <div style={{ fontSize: 13, color: "#6A7B77", lineHeight: 1.5 }}>Reference numbers are now assigned automatically by the cloud when a new customer syncs — so they can't clash, even if two devices add customers offline at the same time. A new customer added offline shows no number until it reconnects.</div>
          <RefStartControl data={data} />
        </Card>

        <Card style={{ marginBottom: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <h4 style={{ margin: 0, fontSize: 12, textTransform: "uppercase", letterSpacing: ".06em", color: "#94A4A0", fontWeight: 800 }}>Vehicles</h4>
            <Btn size="sm" onClick={() => setVForm({})}><Icon name="plus" size={14} /> Add</Btn>
          </div>
          {vehicles.length === 0 && <div style={{ fontSize: 13, color: "#94A4A0", padding: "10px 0" }}>No vehicles yet.</div>}
          {vehicles.map((v, i) => (
            <div key={v.id} onClick={() => setVForm(v)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 0", borderBottom: "1px solid #F2F5F4", cursor: "pointer" }}>
              <div style={{ width: 40, height: 40, borderRadius: 11, background: VEHICLE_COLORS[i % VEHICLE_COLORS.length], display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{truckIcon}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#10211E" }}>{v.name}</div>
                <div style={{ fontSize: 12, color: "#6A7B77" }}>{[v.reg, v.vtype, v.capacityCuFt ? `${v.capacityCuFt} cu ft` : ""].filter(Boolean).join(" · ") || "—"}</div>
                {(() => {
                  const items = [["Service", nextService(v.maint)], ["MOT", nextMOT(v.maint)], ["Tacho", nextTacho(v.maint)]].filter(x => x[1]);
                  if (!items.length) return null;
                  const soon = iso => { const days = Math.round((new Date(iso + "T00:00") - new Date()) / 86400000); return days < 0 ? "#DC2626" : days <= 14 ? "#B45309" : "#9CA3AF"; };
                  return <div style={{ fontSize: 11.5, marginTop: 3, display: "flex", flexWrap: "wrap", gap: 8 }}>{items.map(([label, due]) => <span key={label} style={{ color: soon(due) }}>{label}: {fmtUK(due)}</span>)}</div>;
                })()}
              </div>
            </div>
          ))}
        </Card>

        <Card style={{ marginBottom: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <h4 style={{ margin: 0, fontSize: 12, textTransform: "uppercase", letterSpacing: ".06em", color: "#94A4A0", fontWeight: 800 }}>Staff</h4>
            <Btn size="sm" onClick={() => setSForm({})}><Icon name="plus" size={14} /> Add</Btn>
          </div>
          {staff.length === 0 && <div style={{ fontSize: 13, color: "#94A4A0", padding: "10px 0" }}>No staff yet.</div>}
          {staff.map(s => (
            <div key={s.id} onClick={() => setSForm(s)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 0", borderBottom: "1px solid #F2F5F4", cursor: "pointer", opacity: s.active === false ? .5 : 1 }}>
              <div style={{ width: 40, height: 40, borderRadius: 11, background: "#7C8B87", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Icon name="customers" size={19} color="#fff" /></div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#10211E" }}>{s.name}{s.active === false ? " · inactive" : ""}</div>
                <div style={{ fontSize: 12, color: "#6A7B77" }}>{[s.role, s.phone].filter(Boolean).join(" · ") || "—"}</div>
              </div>
            </div>
          ))}
        </Card>
      </div>

      <Card style={{ marginBottom: 0, marginTop: 14 }}>
        <h4 style={{ margin: "0 0 6px", fontSize: 12, textTransform: "uppercase", letterSpacing: ".06em", color: "#94A4A0", fontWeight: 800 }}>Backup &amp; Restore</h4>
        <div style={{ fontSize: 13, color: "#6A7B77", marginBottom: 12, lineHeight: 1.5 }}>
          Save a copy of everything ({(data.customers || []).length} customers · {(data.enquiries || []).length} enquiries · {(data.jobs || []).length} jobs). Keep it in Files, iCloud or Drive. You can restore it on any device.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Btn onClick={() => exportBackup(data)}><Icon name="box" size={15} /> Download backup</Btn>
          <Btn variant="ghost" onClick={() => restoreRef.current && restoreRef.current.click()} disabled={restoring}>{restoring ? "Restoring…" : "Restore from file…"}</Btn>
          <button onClick={() => setPasteOpen(o => !o)} style={{ background: "none", border: "none", color: TEAL, fontSize: 13, fontWeight: 600, cursor: "pointer", padding: 4, alignSelf: "flex-start" }}>{pasteOpen ? "Hide paste box" : "…or paste backup text instead"}</button>
          {pasteOpen && (
            <div>
              <textarea value={pasteText} onChange={e => setPasteText(e.target.value)} rows={4} placeholder="Open your backup file, Select All, Copy, then paste it here…" style={{ ...inputStyle, resize: "vertical", marginBottom: 8 }} />
              <Btn variant="ghost" onClick={onRestorePaste} disabled={restoring || !pasteText.trim()}>{restoring ? "Restoring…" : "Restore pasted text"}</Btn>
            </div>
          )}
        </div>
        <input ref={restoreRef} type="file" accept="application/json,.json,text/plain" style={{ display: "none" }} onChange={onRestoreFile} />
        <div style={{ fontSize: 12, color: "#94A4A0", marginTop: 10, lineHeight: 1.5 }}>
          Tip: do this every week or so. On Supabase's paid plan your cloud data is also backed up automatically every day — this manual backup keeps working alongside it.
        </div>
      </Card>

      <Card style={{ marginBottom: 0, marginTop: 14, border: "1px solid #FECACA", background: "#FEF2F2" }}>
        <h4 style={{ margin: "0 0 6px", fontSize: 12, textTransform: "uppercase", letterSpacing: ".06em", color: "#DC2626", fontWeight: 800 }}>Danger zone</h4>
        <div style={{ fontSize: 13, color: "#7F1D1D", marginBottom: 12, lineHeight: 1.5 }}>
          Permanently delete every customer, enquiry and job. Your staff and vehicles are kept. <b>Download a backup first.</b>
        </div>
        <Btn variant="ghost" onClick={onWipe} disabled={wiping} style={{ color: "#DC2626", borderColor: "#FCA5A5", width: "100%" }}>{wiping ? "Deleting…" : "Delete all customers, enquiries & jobs"}</Btn>
      </Card>

      {vForm && <VehicleForm data={data} editVehicle={vForm.id ? vForm : null} onClose={() => setVForm(null)} />}
      {sForm && <StaffForm data={data} editStaff={sForm.id ? sForm : null} onClose={() => setSForm(null)} />}
    </div>
  );
}

function VehicleForm({ data, onClose, editVehicle }) {
  const v = editVehicle || {};
  const [f, setF] = useState({ reg: v.reg || "", vtype: v.vtype || "", capacityCuFt: v.capacityCuFt || "" });
  const defWeeks = vt => /18/.test(vt) ? "6" : /3\.?5/.test(vt) ? "26" : "";
  const m0 = v.maint || {};
  const [m, setM] = useState({ serviceWeeks: m0.serviceWeeks ?? defWeeks(v.vtype || ""), serviceLast: m0.serviceLast || "", motLast: m0.motLast || "", motDays: m0.motDays ?? (/18/.test(v.vtype || "") ? 3 : 1), tachoLast: m0.tachoLast || "", bookings: Array.isArray(m0.bookings) ? m0.bookings : [] });
  const set = (k, val) => setF(p => ({ ...p, [k]: val }));
  const setMv = (k, val) => setM(p => ({ ...p, [k]: val }));
  const book = (type, start, days) => { if (!start) { alert("Set the last-done date first so a due date can be worked out."); return; } const snapped = type === "Service" ? nearestDow(start, 2) : type === "MOT" ? nearestDow(start, 1) : nextWeekday(start); setM(p => ({ ...p, bookings: [...p.bookings.filter(b => !(b.type === type && b.start === snapped)), { id: uid(), type, start: snapped, days: Math.max(1, Number(days) || 1) }] })); };
  const editBooking = (id, k, val) => setM(p => ({ ...p, bookings: p.bookings.map(b => b.id === id ? { ...b, [k]: k === "days" ? Math.max(1, Number(val) || 1) : val } : b) }));
  const unbook = id => setM(p => ({ ...p, bookings: p.bookings.filter(b => b.id !== id) }));
  const nS = nextService(m), nM = nextMOT(m), nT = nextTacho(m);
  const inp = { width: "100%", padding: "9px 10px", border: "1px solid #D9E2E0", borderRadius: 9, fontSize: 14, boxSizing: "border-box", background: "#fff" };

  async function save() {
    if (!f.reg.trim() && !f.vtype) { alert("Add a registration or a type so you can tell vehicles apart."); return; }
    const label = [f.vtype, f.reg.trim()].filter(Boolean).join(" · ") || "Vehicle";
    const maint = { serviceWeeks: Number(m.serviceWeeks) || 0, serviceLast: m.serviceLast || "", motLast: m.motLast || "", motDays: Number(m.motDays) || 1, tachoLast: m.tachoLast || "", bookings: m.bookings || [] };
    const rec = { id: v.id || uid(), name: label, reg: f.reg.trim(), vtype: f.vtype, capacityCuFt: Number(f.capacityCuFt) || 0, maint, createdAt: v.createdAt || new Date().toISOString() };
    await saveAndReload(upsertLocal(data, "vehicles", rec));
  }
  async function del() {
    if (!confirm("Delete this vehicle?")) return;
    addTombstone(v.id); SAVING_IN_PROGRESS = true; showSavingOverlay();
    try { await deleteRecord("vehicles", v.id); } catch {}
    const d2 = { ...data, vehicles: (data.vehicles || []).filter(x => x.id !== v.id) };
    localStorage.setItem(DB_KEY, JSON.stringify(d2)); SAVING_IN_PROGRESS = false; window.location.reload();
  }

  const DueRow = ({ label, last, onLast, due, days, onBook, extra }) => (
    <div style={{ borderTop: "1px solid #EEF3F2", paddingTop: 10, marginTop: 10 }}>
      <div style={{ fontWeight: 700, fontSize: 13.5, color: "#10211E", marginBottom: 6 }}>{label}</div>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 130 }}><div style={{ fontSize: 12, color: "#6A7B77", marginBottom: 3 }}>Last done</div><input type="date" value={last} onChange={e => onLast(e.target.value)} style={inp} /></div>
        {extra}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8, gap: 8 }}>
        <div style={{ fontSize: 12.5, color: due ? "#0F766E" : "#9CA3AF" }}>{due ? <>Next due: <b>{fmtUK(due)} ({dow(due)})</b></> : "Set last done to see due date"}</div>
        {due && <Btn size="sm" variant="grey" onClick={() => onBook(due, days)}>Book {days} day{days !== 1 ? "s" : ""} out</Btn>}
      </div>
    </div>
  );

  return (
    <Modal title={v.id ? "Edit Vehicle" : "Add Vehicle"} onClose={onClose}>
      <Field label="Type"><Select value={f.vtype} onChange={x => { set("vtype", x); if (!m.serviceWeeks) setMv("serviceWeeks", defWeeks(x)); if (m.motDays == null) setMv("motDays", /18/.test(x) ? 3 : 1); }} options={VEHICLE_TYPES} placeholder="Select…" /></Field>
      <Field label="Reg / plate"><Input value={f.reg} onChange={x => set("reg", x)} placeholder="e.g. WX19 ABC" /></Field>
      <Field label="Capacity (cu ft)" hint="Roughly how much it holds"><Input type="number" value={f.capacityCuFt} onChange={x => set("capacityCuFt", x)} placeholder="e.g. 600" /></Field>

      <div style={{ marginTop: 10, borderTop: "1px solid #EEF3F2", paddingTop: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".06em", color: "#94A4A0", marginBottom: 4 }}>Servicing & maintenance</div>
        <div style={{ fontSize: 12, color: "#9CA3AF", marginBottom: 6 }}>Booking a date marks the vehicle unavailable for those days.</div>

        <Field label="Service interval (weeks)" hint="e.g. 18t = 6, 3.5t = 26"><Input type="number" value={m.serviceWeeks} onChange={x => setMv("serviceWeeks", x)} placeholder="weeks" /></Field>
        {DueRow({ label: "Service — Tuesdays", last: m.serviceLast, onLast: x => setMv("serviceLast", x), due: nS, days: 1, onBook: (due, days) => book("Service", due, days) })}
        {DueRow({ label: "MOT — Mon to Wed", last: m.motLast, onLast: x => setMv("motLast", x), due: nM, days: Number(m.motDays) || 1, onBook: (due, days) => book("MOT", due, days),
          extra: <div style={{ width: 92 }}><div style={{ fontSize: 12, color: "#6A7B77", marginBottom: 3 }}>Days out</div><input type="number" value={m.motDays} onChange={e => setMv("motDays", e.target.value)} style={inp} /></div> })}
        {DueRow({ label: "Tacho — weekdays (every 2 years)", last: m.tachoLast, onLast: x => setMv("tachoLast", x), due: nT, days: 1, onBook: (due, days) => book("Tacho", due, days) })}

        {m.bookings.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#6A7B77", marginBottom: 6 }}>Booked out</div>
            {m.bookings.slice().sort((a, b) => (a.start || "").localeCompare(b.start || "")).map(b => (
              <div key={b.id} style={{ padding: "8px 0", borderBottom: "1px solid #F0F4F3" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#10211E" }}>{b.type} <span style={{ color: "#6A7B77", fontWeight: 600 }}>· {dow(b.start)}{b.days > 1 ? ` – ${dow(isoAdd(b.start, { days: b.days - 1 }))}` : ""}</span></div>
                  <button onClick={() => unbook(b.id)} style={{ background: "none", border: "none", color: "#C0605A", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Remove</button>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                  <div style={{ flex: 1 }}><div style={{ fontSize: 11, color: "#94A4A0", marginBottom: 3 }}>Date</div><input type="date" value={b.start} onChange={e => editBooking(b.id, "start", e.target.value)} style={inp} /></div>
                  <div style={{ width: 80 }}><div style={{ fontSize: 11, color: "#94A4A0", marginBottom: 3 }}>Days</div><input type="number" value={b.days} onChange={e => editBooking(b.id, "days", e.target.value)} style={inp} /></div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
        {v.id && <Btn variant="danger" onClick={del}><Icon name="trash" size={14} /></Btn>}
        <Btn variant="grey" style={{ flex: 1 }} onClick={onClose}>Cancel</Btn>
        <Btn style={{ flex: 2 }} onClick={save}>{v.id ? "Save" : "Add vehicle"}</Btn>
      </div>
    </Modal>
  );
}

function StaffForm({ data, onClose, editStaff }) {
  const s = editStaff || {};
  const [f, setF] = useState({ name: s.name || "", role: s.role || "", phone: s.phone || "", active: s.active !== false });
  const [away, setAway] = useState(Array.isArray(s.away) ? s.away : []);
  const [awStart, setAwStart] = useState("");
  const [awDays, setAwDays] = useState("1");
  const [awReason, setAwReason] = useState("Holiday");
  const set = (k, val) => setF(p => ({ ...p, [k]: val }));
  const inp = { width: "100%", padding: "9px 10px", border: "1px solid #D9E2E0", borderRadius: 9, fontSize: 14, boxSizing: "border-box", background: "#fff" };
  const addAway = () => { if (!awStart) { alert("Pick a start date."); return; } setAway(a => [...a, { id: uid(), start: awStart, days: Math.max(1, Number(awDays) || 1), reason: awReason }]); setAwStart(""); setAwDays("1"); setAwReason("Holiday"); };
  const rmAway = id => setAway(a => a.filter(x => x.id !== id));
  async function save() {
    if (!f.name.trim()) { alert("Enter a name."); return; }
    const rec = { id: s.id || uid(), name: f.name.trim(), role: f.role, phone: f.phone, active: f.active, away, createdAt: s.createdAt || new Date().toISOString() };
    await saveAndReload(upsertLocal(data, "staff", rec));
  }
  async function del() {
    if (!confirm("Delete this staff member?")) return;
    addTombstone(s.id); SAVING_IN_PROGRESS = true; showSavingOverlay();
    try { await deleteRecord("staff", s.id); } catch {}
    const d2 = { ...data, staff: (data.staff || []).filter(x => x.id !== s.id) };
    localStorage.setItem(DB_KEY, JSON.stringify(d2)); SAVING_IN_PROGRESS = false; window.location.reload();
  }
  return (
    <Modal title={s.id ? "Edit Staff" : "Add Staff"} onClose={onClose}>
      <Field label="Name" required><Input value={f.name} onChange={x => set("name", x)} /></Field>
      <Field label="Role"><Select value={f.role} onChange={x => set("role", x)} options={STAFF_ROLES} placeholder="Select…" /></Field>
      <Field label="Phone"><Input value={f.phone} onChange={x => set("phone", x)} /></Field>
      <Field label="Active">
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "#374151", cursor: "pointer" }}>
          <input type="checkbox" checked={f.active} onChange={e => set("active", e.target.checked)} style={{ width: 18, height: 18 }} /> Currently working (show when assigning crew)
        </label>
      </Field>

      <div style={{ borderTop: "1px solid #EEF3F2", paddingTop: 12, marginTop: 4 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: "#10211E", marginBottom: 6 }}>Time off / unavailable</div>
        <div style={{ fontSize: 12, color: "#94A4A0", marginBottom: 8 }}>Mark holiday, sickness or other leave. They can't be assigned to a move on these days.</div>
        {away.length > 0 && away.slice().sort((a, b) => (a.start || "").localeCompare(b.start || "")).map(p => {
          const end = isoAdd(p.start, { days: Math.max(1, Number(p.days) || 1) - 1 });
          return (
            <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#F7FAF9", border: "1px solid #EEF3F2", borderRadius: 8, padding: "8px 11px", marginBottom: 6 }}>
              <div style={{ fontSize: 13, color: "#374151" }}><span style={{ fontWeight: 700 }}>{p.reason || "Off"}</span> · {fmtUK(p.start)}{p.days > 1 ? ` – ${fmtUK(end)}` : ""} <span style={{ color: "#94A4A0" }}>({p.days} day{p.days !== 1 ? "s" : ""})</span></div>
              <button onClick={() => rmAway(p.id)} style={{ background: "none", border: "none", color: "#DC2626", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>Remove</button>
            </div>
          );
        })}
        <div style={{ display: "flex", gap: 6, alignItems: "flex-end", marginTop: 6 }}>
          <div style={{ flex: 1 }}><label style={{ fontSize: 11, color: "#6A7B77", fontWeight: 700 }}>From</label><input type="date" value={awStart} onChange={e => setAwStart(e.target.value)} style={inp} /></div>
          <div style={{ width: 62 }}><label style={{ fontSize: 11, color: "#6A7B77", fontWeight: 700 }}>Days</label><input type="number" min="1" value={awDays} onChange={e => setAwDays(e.target.value)} style={inp} /></div>
          <div style={{ flex: 1 }}><label style={{ fontSize: 11, color: "#6A7B77", fontWeight: 700 }}>Reason</label>
            <select value={awReason} onChange={e => setAwReason(e.target.value)} style={inp}>{["Holiday", "Sick", "Training", "Other"].map(r => <option key={r} value={r}>{r}</option>)}</select>
          </div>
          <Btn size="sm" onClick={addAway}>Add</Btn>
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
        {s.id && <Btn variant="danger" onClick={del}><Icon name="trash" size={14} /></Btn>}
        <Btn variant="grey" style={{ flex: 1 }} onClick={onClose}>Cancel</Btn>
        <Btn style={{ flex: 2 }} onClick={save}>{s.id ? "Save" : "Add staff"}</Btn>
      </div>
    </Modal>
  );
}

const DEFAULT_DAY_TYPES = ["Move", "Full Pack", "7 Hour Pack", "Load", "Unload", "Load Travel (Night Out)", "Into store"];
const PLAN_VEHICLE_TYPES = ["18t", "7.5t", "3.5t", "Van"];
function vehTypesSummary(m) {
  if (!m) return "";
  return PLAN_VEHICLE_TYPES.filter(t => m[t]).map(t => `${m[t]}× ${t}`).join(", ");
}
const DAYTYPES_KEY = "removals_day_types";
function getDayTypes() {
  try { const v = JSON.parse(localStorage.getItem(DAYTYPES_KEY)); if (Array.isArray(v) && v.length) return v; } catch {}
  return DEFAULT_DAY_TYPES;
}
function addDayType(t) {
  const list = getDayTypes();
  if (t && !list.includes(t)) { const nl = [...list, t]; localStorage.setItem(DAYTYPES_KEY, JSON.stringify(nl)); return nl; }
  return list;
}
const CUSTOM_ITEMS_KEY = "removals_custom_items";
function getCustomItems() {
  try { const v = JSON.parse(localStorage.getItem(CUSTOM_ITEMS_KEY)); if (Array.isArray(v)) return v; } catch {}
  return [];
}
function addCustomItemToCatalog(item) {
  const nl = [...getCustomItems(), item];
  localStorage.setItem(CUSTOM_ITEMS_KEY, JSON.stringify(nl));
  return nl;
}
function removeCustomItemFromCatalog(id) {
  const nl = getCustomItems().filter(x => x.id !== id);
  localStorage.setItem(CUSTOM_ITEMS_KEY, JSON.stringify(nl));
  return nl;
}
const STAGE_TYPES = DEFAULT_DAY_TYPES;
// Returns a job's day-stages, synthesising one from legacy single-day fields if needed.
function jobStages(j) {
  if (Array.isArray(j.stages) && j.stages.length) return j.stages;
  if (j.moveDate) return [{ id: "legacy", type: "Move", date: j.moveDate, time: j.startTime || "", vehicleIds: (j.vehicleIds && j.vehicleIds.length) ? j.vehicleIds : (j.vehicleId ? [j.vehicleId] : []), crew: j.crew || [], notes: "" }];
  return [];
}
// Removal date = earliest day in the move plan (falls back to moveDate if no plan)
function jobMoveDate(j) {
  if (!j) return "";
  const ds = jobStages(j).map(s => s.date).filter(Boolean).sort();
  return ds[0] || j.moveDate || "";
}
// Generic selectable chip row (vehicles or crew). options: [{id,label}]
function PickChips({ options, selectedIds, takenIds, onToggle, empty, takenReasons }) {
  if (!options.length) return <div style={{ fontSize: 13, color: "#94A4A0", padding: "4px 0" }}>{empty}</div>;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
      {options.map(o => {
        const on = selectedIds.includes(o.id);
        const taken = !on && takenIds.has(o.id);
        const reason = taken ? ((takenReasons && takenReasons[o.id]) || "booked") : "";
        return (
          <button key={o.id} onClick={() => !taken && onToggle(o.id)} disabled={taken} title={taken ? reason : ""}
            style={{ border: on ? `1.5px solid ${TEAL}` : "1.5px solid #E3E9E8", background: on ? "#E7F2F0" : taken ? "#F2F5F4" : "#fff", color: on ? TEAL_D : taken ? "#B7C3C0" : "#43534F", borderRadius: 99, padding: "6px 12px", fontSize: 12.5, fontWeight: 600, cursor: taken ? "not-allowed" : "pointer", display: "inline-flex", alignItems: "center", gap: 5, textDecoration: taken ? "line-through" : "none" }}>
            {on && <Icon name="check" size={12} color={TEAL} />}{o.label}{taken ? ` · ${reason}` : ""}
          </button>
        );
      })}
    </div>
  );
}

function JobDetail({ data, id, setView }) {
  const j = (data.jobs || []).find(x => x.id === id);
  const customer = (data.customers || []).find(c => c.id === j?.customerId);
  if (!j) return <div style={{ padding: 20 }}>Move not found.</div>;
  const [f, setF] = useState({
    stages: jobStages(j).map(st => ({ id: st.id && st.id !== "legacy" ? st.id : uid(), type: st.type || "Move", date: st.date || "", time: st.time || "", vehicleIds: st.vehicleIds || [], crew: st.crew || [], notes: st.notes || "" })),
    price: j.price || 0, deposit: j.deposit || 0,
    depositPaid: j.depositPaid || false, balancePaid: j.balancePaid || false,
    status: (j.status === "Booked" || j.status === "In Progress") ? "Confirmed" : (j.status || "Confirmed"), notes: j.notes || "",
  });
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const [confirming, setConfirming] = useState(false);
  const vehLabel = vid => { const v = (data.vehicles || []).find(x => x.id === vid); return v ? v.name : ""; };

  const setStage = (idx, key, val) => setF(p => ({ ...p, stages: p.stages.map((st, i) => i === idx ? { ...st, [key]: val } : st) }));
  const toggleStageVeh = (idx, vid) => setF(p => ({ ...p, stages: p.stages.map((st, i) => i === idx ? { ...st, vehicleIds: st.vehicleIds.includes(vid) ? st.vehicleIds.filter(x => x !== vid) : [...st.vehicleIds, vid] } : st) }));
  const toggleStageCrew = (idx, name) => setF(p => ({ ...p, stages: p.stages.map((st, i) => i === idx ? { ...st, crew: st.crew.includes(name) ? st.crew.filter(x => x !== name) : [...st.crew, name] } : st) }));
  const addStage = () => setF(p => ({ ...p, stages: [...p.stages, { id: uid(), type: STAGE_TYPES[Math.min(p.stages.length, STAGE_TYPES.length - 1)], date: "", time: "", vehicleIds: [], crew: [], notes: "" }] }));
  const removeStage = idx => setF(p => ({ ...p, stages: p.stages.filter((_, i) => i !== idx) }));

  // Clash: what's booked on a date across OTHER jobs and this job's OTHER stages
  function bookedOn(date, exceptIdx) {
    const veh = new Set(), crew = new Set();
    if (!date) return { veh, crew };
    (data.jobs || []).filter(x => x.id !== j.id && ["Confirmed", "Completed"].includes(x.status)).forEach(x => jobStages(x).forEach(st => { if (st.date === date) { (st.vehicleIds || []).forEach(v => veh.add(v)); (st.crew || []).forEach(c => crew.add(c)); } }));
    f.stages.forEach((st, i) => { if (i !== exceptIdx && st.date === date) { (st.vehicleIds || []).forEach(v => veh.add(v)); (st.crew || []).forEach(c => crew.add(c)); } });
    (data.vehicles || []).forEach(vv => { if (vehOutOn(vv, date)) veh.add(vv.id); }); (data.staff || []).forEach(s => { if (staffOffOn(s, date)) crew.add(s.name); });
    return { veh, crew };
  }

  function buildRec(extra) {
    const stages = f.stages;
    const dated = stages.filter(s => s.date).map(s => s.date).sort();
    const moveDate = dated[0] || "";
    const firstStage = stages.find(s => s.date === moveDate);
    const allVeh = [...new Set(stages.flatMap(s => s.vehicleIds || []))];
    const allCrew = [...new Set(stages.flatMap(s => s.crew || []))];
    return {
      ...j, stages,
      moveDate, startTime: firstStage ? firstStage.time : "",
      vehicleIds: allVeh, vehicle: allVeh.map(vehLabel).filter(Boolean).join(", "), crew: allCrew,
      price: Number(f.price) || 0, deposit: Number(f.deposit) || 0,
      depositPaid: f.depositPaid, balancePaid: f.balancePaid, status: f.status, notes: f.notes,
      ...extra,
    };
  }
  function maintClash() {
    const out = [];
    (f.stages || []).forEach((st, i) => { if (st.date) (st.vehicleIds || []).forEach(vid => { const vv = (data.vehicles || []).find(x => x.id === vid); if (vv && vehOutOn(vv, st.date)) out.push(`${vv.name} on day ${i + 1} (${fmtUK(st.date)})`); }); });
    if (out.length) { alert(`These vehicles are booked out for servicing/MOT and can't be on this move:\n\n${out.join("\n")}\n\nRemove them or change the maintenance date.`); return true; }
    return false;
  }
  async function save() { if (maintClash()) return; await saveAndReload(upsertLocal(data, "jobs", buildRec())); }
  async function completeMove() { await saveAndReload(upsertLocal(data, "jobs", buildRec({ status: "Completed", balancePaid: true }))); }
  async function confirmMove() {
    if (maintClash()) return;
    // First press on a provisional move: reveal the crew/vehicle pickers and jump to them.
    if (!confirming) {
      setConfirming(true);
      setTimeout(() => { const el = document.getElementById("jd-days"); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); }, 60);
      return;
    }
    const bad = (f.stages || []).map((st, i) => (!(st.crew && st.crew.length) || !(st.vehicleIds && st.vehicleIds.length)) ? i + 1 : null).filter(Boolean);
    if (!f.stages || !f.stages.length || bad.length) { alert(`Assign named staff and at least one vehicle to every day before confirming.\n\nStill needed on day ${bad.join(", ")}.`); const el = document.getElementById("jd-days"); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
    const price = Number(f.price) || 0;
    const dep = Math.round(price * 0.6);
    setF(p => ({ ...p, status: "Confirmed", deposit: dep, depositPaid: true }));
    await saveAndReload(upsertLocal(data, "jobs", buildRec({ status: "Confirmed", deposit: dep, depositPaid: true })));
  }
  async function del() {
    if (!confirm("Delete this booked move?")) return;
    addTombstone(j.id);
    SAVING_IN_PROGRESS = true; showSavingOverlay();
    try { await deleteRecord("jobs", j.id); } catch {}
    const d2 = { ...data, jobs: (data.jobs || []).filter(x => x.id !== j.id) };
    localStorage.setItem(DB_KEY, JSON.stringify(d2));
    SAVING_IN_PROGRESS = false; setView({ screen: "enquiries", filter: "Won" }); window.location.reload();
  }
  const balance = (Number(f.price) || 0) - (Number(f.deposit) || 0);
  const vehOpts = (data.vehicles || []).map(v => ({ id: v.id, label: [v.name, v.reg].filter(Boolean).join(" · ") }));
  const crewOpts = (data.staff || []).filter(s => s.active !== false).map(s => ({ id: s.name, label: s.name }));

  return (
    <div>
      <button onClick={() => setView({ screen: "enquiries", filter: "Won" })} style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "#EEF3F2", border: "1px solid #DCE5E3", borderRadius: 10, padding: "10px 16px", fontSize: 15.5, fontWeight: 800, color: NAVY, cursor: "pointer" }}><Icon name="back" size={16} /> Back</button>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "14px 0 8px" }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 800, color: TEAL_D, letterSpacing: ".02em" }}>{moveRef(data, j)}</div>
          <h2 style={{ margin: "2px 0 0", fontSize: 20, fontWeight: 800, color: "#111827" }}>{custName(data, j.customerId)}</h2>
        </div>
        <StatusBadge status={f.status} />
      </div>
      {customer && (
        <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          {customer.phone && <Btn variant="grey" onClick={() => window.location.href = `tel:${customer.phone}`}>📞 Call</Btn>}
          {customer.email && <Btn variant="grey" onClick={() => window.location.href = `mailto:${customer.email}`}>✉️ Email</Btn>}
          <MessageButton size="md" variant="primary" customer={customer} ctx={{ ref: moveRef(data, j), date: j.moveDate ? fmtDate(j.moveDate) : "", time: (jobStages(j)[0]?.time) || j.startTime || "", price: gbp(j.price), deposit: gbp(j.deposit), balance: gbp((Number(j.price) || 0) - (Number(j.deposit) || 0)) }} />
          {j.enquiryId && <Btn size="sm" variant="grey" onClick={() => setView({ screen: "enquiryDetail", id: j.enquiryId })}>View enquiry</Btn>}
        </div>
      )}

      <Card>
        <Row label="From" value={[j.fromAddress1, j.fromAddress2, j.fromTown, j.fromPostcode].filter(Boolean).join(", ")} />
        {j.fromAccess && <Row label="From access" value={j.fromAccess} />}
        <Row label="To" value={[j.toAddress1, j.toAddress2, j.toTown, j.toPostcode].filter(Boolean).join(", ")} />
        {j.toAccess && <Row label="To access" value={j.toAccess} />}
        <Row label="Volume" value={j.volumeCuFt ? `${j.volumeCuFt} cu ft · ${j.volumeM3} m³` : ""} />
      </Card>

      <div id="jd-days" />
      <SectionTitle>Days</SectionTitle>
      {confirming && f.status === "Provisional" && <div style={{ fontSize: 13, fontWeight: 700, color: "#1D4ED8", background: "#EFF4FF", border: "1px solid #C7D7FE", borderRadius: 9, padding: "10px 12px", marginBottom: 10 }}>Assign named staff and a vehicle to every day below, then press Confirm again.</div>}
      {f.stages.map((st, idx) => {
        const booked = bookedOn(st.date, idx);
        return (
          <Card key={st.id} style={{ background: "#FAFCFB" }}>
            <div style={{ display: "flex", gap: 10, alignItems: "flex-end", marginBottom: 10 }}>
              <div style={{ flex: 1 }}><Field label="Day"><DayTypeSelect value={st.type} onChange={v => setStage(idx, "type", v)} /></Field></div>
              {f.stages.length > 1 && <button onClick={() => removeStage(idx)} style={{ background: "#FEE2E2", color: "#DC2626", border: "none", borderRadius: 9, width: 38, height: 38, cursor: "pointer", marginBottom: 14, flexShrink: 0 }}>×</button>}
            </div>
            {(st.staffCount || vehTypesSummary(st.vehTypes)) ? (
              <div style={{ fontSize: 12, color: TEAL_D, background: "#EAF4F2", borderRadius: 8, padding: "6px 10px", marginBottom: 10 }}>
                Planned:{st.staffCount ? ` ${st.staffCount} staff` : ""}{st.staffCount && vehTypesSummary(st.vehTypes) ? " ·" : ""}{vehTypesSummary(st.vehTypes) ? ` ${vehTypesSummary(st.vehTypes)}` : ""}
              </div>
            ) : null}
            <Field label="Date"><Input type="date" value={st.date} onChange={v => setStage(idx, "date", v)} /></Field>
            <Field label="Time"><Input type="time" value={st.time} onChange={v => setStage(idx, "time", v)} /></Field>
            {["Confirmed", "Completed"].includes(f.status) || confirming ? (
              <>
                <Field label="Vehicles"><PickChips options={vehOpts} selectedIds={st.vehicleIds} takenIds={booked.veh} onToggle={vid => toggleStageVeh(idx, vid)} empty="No vehicles — add under Company." /></Field>
                <Field label="Crew"><PickChips options={crewOpts} selectedIds={st.crew} takenIds={booked.crew} takenReasons={crewReasonsOn(data, st.date, j.id)} onToggle={name => toggleStageCrew(idx, name)} empty="No staff — add under Company." /></Field>
              </>
            ) : (
              <div style={{ fontSize: 12.5, color: "#6A7B77", background: "#F5F8F7", border: "1px dashed #D9E2E0", borderRadius: 9, padding: "9px 11px", marginBottom: 10 }}>Actual crew &amp; vehicles are assigned once this move is confirmed.</div>
            )}
            <Field label="Day notes"><Input value={st.notes} onChange={v => setStage(idx, "notes", v)} placeholder="(optional)" /></Field>
          </Card>
        );
      })}
      <Btn variant="ghost" size="sm" onClick={addStage} style={{ marginBottom: 6 }}><Icon name="plus" size={14} /> Add day (pack / load / delivery…)</Btn>

      <Field label="Status"><Select value={f.status} onChange={v => set("status", v)} options={JOB_STATUSES} /></Field>

      <SectionTitle>Payment</SectionTitle>
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}><Field label="Price (£)"><Input type="number" value={f.price} onChange={v => set("price", v)} /></Field></div>
        <div style={{ flex: 1 }}><Field label="Deposit (£)"><Input type="number" value={f.deposit} onChange={v => set("deposit", v)} /></Field></div>
      </div>
      <div style={{ background: "#F9FAFB", borderRadius: 10, padding: "10px 12px", marginBottom: 12, fontSize: 14, display: "flex", justifyContent: "space-between" }}>
        <span style={{ color: "#6B7280" }}>Balance due</span><span style={{ fontWeight: 700, color: "#111827" }}>{gbp(balance)}</span>
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "#374151", marginBottom: 8, cursor: "pointer" }}>
        <input type="checkbox" checked={f.depositPaid} onChange={ev => set("depositPaid", ev.target.checked)} style={{ width: 18, height: 18 }} /> Deposit paid
      </label>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "#374151", marginBottom: 12, cursor: "pointer" }}>
        <input type="checkbox" checked={f.balancePaid} onChange={ev => set("balancePaid", ev.target.checked)} style={{ width: 18, height: 18 }} /> Balance paid
      </label>

      <Field label="Move notes"><Textarea value={f.notes} onChange={v => set("notes", v)} /></Field>

      <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
        <Btn variant="danger" onClick={del}><Icon name="trash" size={14} /></Btn>
        <Btn style={{ flex: 1 }} onClick={save}><Icon name="check" size={16} /> Save move</Btn>
      </div>
      {f.status === "Provisional" && (
        <Btn variant="primary" style={{ width: "100%", marginTop: 10, background: "#2563EB", boxShadow: "0 4px 12px rgba(37,99,235,.26)" }} onClick={confirmMove}>
          <Icon name="check" size={16} /> {confirming ? `Confirm move — take 60% deposit (${gbp(Math.round((Number(f.price) || 0) * 0.6))})` : "Confirm move — assign crew & vehicles"}
        </Btn>
      )}
      {f.status === "Confirmed" && (
        <Btn variant="primary" style={{ width: "100%", marginTop: 10 }} onClick={completeMove}>
          <Icon name="check" size={16} /> Mark move complete
        </Btn>
      )}
      {f.status === "Completed" && (
        <div style={{ textAlign: "center", marginTop: 12, fontSize: 13, fontWeight: 700, color: "#059669" }}>✓ Move completed</div>
      )}
    </div>
  );
}

// ── Calendar (agenda of booked moves) ───────────────────────────────────────
const CAL_MON = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const CAL_DOW = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
function isoOf(d){ return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); }
function sameDay(a,b){ return a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate(); }
function addDays(d,n){ const x=new Date(d); x.setDate(x.getDate()+n); return x; }
function startOfWeek(d){ const x=new Date(d); const wd=(x.getDay()+6)%7; return addDays(x,-wd); }
function parseTime(t){ if(!t) return null; const m=String(t).match(/(\d{1,2}):(\d{2})/); return m ? (+m[1])+(+m[2])/60 : null; }
function fmtHour(h){ const hh=Math.floor(h),mm=Math.round((h-hh)*60),ap=hh<12?"am":"pm"; let H=hh%12; if(H===0)H=12; return mm?`${H}:${String(mm).padStart(2,"0")}${ap}`:`${H}${ap}`; }

function CalendarView({ data, setView, initialDate, initialMode, initialShow }) {
  const [mode, setMode] = useState(initialMode || "agenda");
  const [show, setShow] = useState(initialShow || "all");
  const showMoves = show === "all" || show === "moves";
  const showSurveys = show === "all" || show === "surveys";
  const showVeh = show === "all" || show === "servicing";
  const [anchor, setAnchor] = useState(() => initialDate ? new Date(initialDate + "T00:00") : new Date());
  const jobs = (data.jobs || []).filter(j => j.moveDate);
  const today = new Date();
  const hasStaff = st => !!(st.crew && st.crew.length);
  const rawJobsOn = d => { const iso = isoOf(d); const out = []; jobs.forEach(j => jobStages(j).forEach(st => { if (st.date === iso) out.push({ job: j, stage: st }); })); return out.sort((a,b)=>(a.stage.time||"").localeCompare(b.stage.time||"")); };
  const rawSurveysOn = d => (data.enquiries || []).filter(en => en.surveyDate === isoOf(d) && en.status !== "Lost").sort((a,b)=>(a.surveyTime||"").localeCompare(b.surveyTime||""));
  const jobsOn = d => showMoves ? rawJobsOn(d) : [];
  const surveysOn = d => showSurveys ? rawSurveysOn(d) : [];
  const colorOf = m => (STATUS_META[m.job.status]?.color) || TEAL;
  const bookedVehiclesOn = d => { const s = new Set(rawJobsOn(d).filter(m => ["Confirmed", "Completed"].includes(m.job.status)).flatMap(m => m.stage.vehicleIds || [])); const iso = isoOf(d); (data.vehicles || []).forEach(v => { if (vehOutOn(v, iso)) s.add(v.id); }); return s; };
  const bookedStaffOn = d => { const s = new Set(rawJobsOn(d).filter(m => ["Confirmed", "Completed"].includes(m.job.status)).flatMap(m => m.stage.crew || [])); const iso = isoOf(d); (data.staff || []).forEach(st => { if (staffOffOn(st, iso)) s.add(st.name); }); return s; };
  const maintOnIso = iso => { const out = []; (data.vehicles || []).forEach(v => ((v.maint && v.maint.bookings) || []).forEach(b => { if (b.start) { const end = isoAdd(b.start, { days: Math.max(1, Number(b.days) || 1) - 1 }); if (iso >= b.start && iso <= end) out.push({ v, b }); } })); return out; };
  const maintOn = d => showVeh ? maintOnIso(isoOf(d)) : [];
  const showStaffOff = show === "all" || show === "servicing";
  const staffOffOnIso = iso => { const out = []; (data.staff || []).forEach(s => ((s.away) || []).forEach(b => { if (b.start) { const end = isoAdd(b.start, { days: Math.max(1, Number(b.days) || 1) - 1 }); if (iso >= b.start && iso <= end) out.push({ s, b }); } })); return out; };
  const staffOffOnCal = d => showStaffOff ? staffOffOnIso(isoOf(d)) : [];

  function navg(dir){ if(mode==="month") setAnchor(new Date(anchor.getFullYear(), anchor.getMonth()+dir, 1)); else if(mode==="week") setAnchor(addDays(anchor, 7*dir)); else setAnchor(addDays(anchor, dir)); }

  let rangeLabel = "";
  if (mode==="agenda") rangeLabel = "This month & next";
  else if (mode==="month") rangeLabel = `${CAL_MON[anchor.getMonth()]} ${anchor.getFullYear()}`;
  else if (mode==="week") { const s=startOfWeek(anchor), e=addDays(s,6); rangeLabel = `${s.getDate()} ${CAL_MON[s.getMonth()].slice(0,3)} – ${e.getDate()} ${CAL_MON[e.getMonth()].slice(0,3)}`; }
  else rangeLabel = `${CAL_DOW[(anchor.getDay()+6)%7]} ${anchor.getDate()} ${CAL_MON[anchor.getMonth()]}`;

  const MoveCard = ({ m, big }) => {
    const j = m.job, st = m.stage;
    const vehNames = (st.vehicleIds || []).map(vid => { const v = (data.vehicles || []).find(x => x.id === vid); return v ? v.name : ""; }).filter(Boolean).join(", ");
    return (
    <div onClick={() => setView(j.enquiryId ? { screen:"enquiryDetail", id:j.enquiryId } : { screen:"jobDetail", id:j.id })}
      style={{ background:"#fff", border:"1px solid #E9EEED", borderLeft:`4px solid ${colorOf(m)}`, borderRadius:10, padding: big?"11px 13px":"7px 9px", cursor:"pointer", boxShadow:"0 1px 2px rgba(16,33,30,.05)" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", gap:8 }}>
        <span style={{ flex:1, minWidth:0, fontSize: big?14.5:12.5, fontWeight:800, color:"#10211E", letterSpacing:"-.01em", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{custName(data, j.customerId)}</span>
        {st.time && <span style={{ fontSize: big?12:10.5, fontWeight:700, color:"#6A7B77", flexShrink:0 }}>{st.time}</span>}
      </div>
      <div style={{ fontSize: big?12:10.5, fontWeight:800, color:colorOf(m), marginTop:1, textTransform:"uppercase", letterSpacing:".03em" }}>{st.type}</div>
      <div style={{ fontSize: big?12.5:11, color:"#6A7B77", marginTop:2, fontWeight:600, whiteSpace: big?"normal":"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
        {j.fromTown || "—"} → {j.toTown || "—"}
      </div>
      {big && (
        <div style={{ fontSize:12, color:"#41514E", marginTop:6, display:"flex", flexWrap:"wrap", gap:"2px 10px" }}>
          <span>{vehNames || "No vehicle"}</span>
          {(st.crew||[]).length>0 && <span>· {st.crew.join(", ")}</span>}
          <StatusBadge status={j.status} />
        </div>
      )}
      {!big && vehNames && <div style={{ fontSize:10.5, color:"#94A4A0", marginTop:1, fontWeight:700, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{vehNames}</div>}
    </div>
    );
  };

  const StaffOffCard = ({ s, b, big }) => (
    <div onClick={() => setView({ screen: "company" })}
      style={{ background:"#FFF7ED", border:"1px solid #FBD9A0", borderLeft:"4px solid #F59E0B", borderRadius:10, padding: big?"11px 13px":"7px 9px", cursor:"pointer" }}>
      <div style={{ fontSize: big?11:9.5, fontWeight:800, color:"#B45309", textTransform:"uppercase", letterSpacing:".05em" }}>🌴 Off · {b.reason || "Away"}</div>
      <div style={{ fontSize: big?14:12.5, fontWeight:800, color:"#10211E", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{s.name}</div>
      {b.days > 1 && <div style={{ fontSize: big?12:10.5, color:"#6A7B77", marginTop:1, fontWeight:600 }}>{fmtUK(b.start)} – {fmtUK(isoAdd(b.start, { days: b.days - 1 }))}</div>}
    </div>
  );
  const MaintCard = ({ v, b, big }) => (
    <div onClick={() => setView({ screen: "company" })}
      style={{ background:"#F3F6FA", border:"1px solid #D3DEEA", borderLeft:"4px solid #64748B", borderRadius:10, padding: big?"11px 13px":"7px 9px", cursor:"pointer" }}>
      <div style={{ fontSize: big?11:9.5, fontWeight:800, color:"#475569", textTransform:"uppercase", letterSpacing:".05em" }}>🔧 Vehicle out · {b.type}</div>
      <div style={{ fontSize: big?14:12.5, fontWeight:800, color:"#10211E", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{v.name}</div>
      {b.days > 1 && <div style={{ fontSize: big?12:10.5, color:"#6A7B77", marginTop:1, fontWeight:600 }}>{fmtUK(b.start)} – {fmtUK(isoAdd(b.start, { days: b.days - 1 }))}</div>}
    </div>
  );
  const SurveyCard = ({ en, big }) => {
    const done = en.surveyDone || en.status === "Surveyed";
    return (
    <div onClick={() => setView({ screen:"enquiryDetail", id:en.id })}
      style={{ background: done?"#F1F9F4":"#FFFBF2", border:`1px solid ${done?"#BBE6C9":"#FBE3B3"}`, borderLeft:`4px solid ${done?"#22C55E":AMBER}`, borderRadius:10, padding: big?"11px 13px":"7px 9px", cursor:"pointer", boxShadow:"0 1px 2px rgba(16,33,30,.05)" }}>
      <div style={{ fontSize: big?11:9.5, fontWeight:800, color: done?"#15803D":AMBER, textTransform:"uppercase", letterSpacing:".05em" }}>{done?"✓ Surveyed":"Survey"}{en.surveyTime ? ` · ${en.surveyTime}` : ""}</div>
      <div style={{ fontSize: big?14.5:12.5, fontWeight:800, color:"#10211E", letterSpacing:"-.01em", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{custName(data, en.customerId)}</div>
      <div style={{ fontSize: big?12.5:11, color:"#6A7B77", marginTop:1, fontWeight:600, whiteSpace: big?"normal":"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{en.fromTown || "—"} → {en.toTown || "—"}</div>
    </div>
    );
  };

  const availChip = (label, booked) => (    <span style={{ display:"inline-flex", alignItems:"center", gap:6, padding:"6px 12px", borderRadius:99, fontSize:12.5, fontWeight:700,
      background: booked ? "#F2F5F4" : "#E7F2F0", color: booked ? "#B7C3C0" : TEAL_D,
      textDecoration: booked ? "line-through" : "none", border: booked ? "1px solid #EAEFEE" : "1px solid #CDE7E2" }}>
      <span style={{ width:8, height:8, borderRadius:99, background: booked ? "#C4D0CD" : "#22C55E" }} />{label}{booked ? " · booked" : ""}
    </span>
  );
  const AvailPanel = ({ d }) => {
    if (!showMoves) return null;
    const bv = bookedVehiclesOn(d), bs = bookedStaffOn(d);
    const vehicles = data.vehicles || [];
    const staffActive = (data.staff || []).filter(s => s.active !== false);
    if (!vehicles.length && !staffActive.length) return null;
    return (
      <div style={{ background:"#fff", border:"1px solid #E9EEED", borderRadius:14, padding:"14px 16px", marginBottom:14, boxShadow:"0 1px 2px rgba(16,33,30,.05)" }}>
        <div style={{ fontSize:11.5, fontWeight:800, textTransform:"uppercase", letterSpacing:".06em", color:"#94A4A0", marginBottom:10 }}>Availability</div>
        {vehicles.length>0 && <>
          <div style={{ fontSize:12, fontWeight:700, color:"#6A7B77", marginBottom:6 }}>Vehicles</div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:8, marginBottom: staffActive.length?12:0 }}>{vehicles.map(v => { const out = vehOutOn(v, isoOf(d)); return <span key={v.id}>{availChip(out ? `${v.name} · servicing` : v.name, bv.has(v.id))}</span>; })}</div>
        </>}
        {staffActive.length>0 && <>
          <div style={{ fontSize:12, fontWeight:700, color:"#6A7B77", marginBottom:6 }}>Staff</div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:8 }}>{staffActive.map(s => { const off = staffAwayReason(s, isoOf(d)); return <span key={s.id}>{availChip(off ? `${s.name} · ${off}` : s.name, bs.has(s.name))}</span>; })}</div>
        </>}
      </div>
    );
  };

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:12, marginBottom:14 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
          <div style={{ display:"flex", gap:5 }}>
            <button onClick={()=>navg(-1)} style={navBtn}>‹</button>
            <button onClick={()=>navg(1)} style={navBtn}>›</button>
          </div>
          <Btn size="sm" variant="grey" onClick={()=>setAnchor(new Date())}>Today</Btn>
          <span style={{ fontSize:17, fontWeight:800, letterSpacing:"-.01em", color:"#10211E" }}>{rangeLabel}</span>
        </div>
        <div style={{ display: "inline-flex", background: "#E9EDEC", borderRadius: 12, padding: 4, gap: 3 }}>
          {["agenda", "day", "week", "month"].map(m => (
            <button key={m} onClick={() => setMode(m)} style={{ border: "none", background: mode === m ? "#fff" : "transparent", color: mode === m ? TEAL_D : "#6B7280", fontWeight: mode === m ? 700 : 600, fontSize: 13, padding: "7px 13px", borderRadius: 9, cursor: "pointer", textTransform: "capitalize", boxShadow: mode === m ? "0 1px 4px rgba(15,46,42,.12)" : "none" }}>{m}</button>
          ))}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4, background: "#E9EDEC", borderRadius: 14, padding: 4, marginBottom: 14 }}>
        {[["all", "All"], ["moves", "Moves"], ["surveys", "Surveys"], ["servicing", "🔧"]].map(([v, label]) => (
          <button key={v} onClick={() => setShow(v)} style={{
            border: "none", borderRadius: 10, padding: "9px 4px", fontSize: 13.5, cursor: "pointer",
            fontWeight: show === v ? 700 : 600, transition: "all .15s",
            background: show === v ? "#fff" : "transparent",
            color: show === v ? NAVY : "#6B7280",
            boxShadow: show === v ? "0 1px 4px rgba(15,46,42,.12)" : "none",
          }}>{label}</button>
        ))}
      </div>

      {showVeh && (() => {
        const nowIso = isoOf(today);
        const endIso = isoOf(new Date(today.getFullYear(), today.getMonth() + 2, 0)); // last day of next month
        const up = [];
        (data.vehicles || []).forEach(v => ((v.maint && v.maint.bookings) || []).forEach(b => { if (b.start && b.start <= endIso && isoAdd(b.start, { days: Math.max(1, Number(b.days) || 1) - 1 }) >= nowIso) up.push({ v, b }); }));
        up.sort((a, c) => (a.b.start || "").localeCompare(c.b.start || ""));
        if (!up.length) return null;
        return (
          <div style={{ background: "#F3F6FA", border: "1px solid #D3DEEA", borderRadius: 12, padding: "10px 12px", marginBottom: 14 }}>
            <div style={{ fontSize: 11.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".05em", color: "#475569", marginBottom: 8 }}>🔧 Upcoming servicing</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {up.slice(0, 8).map(({ v, b }, ix) => (
                <div key={ix} onClick={() => { setAnchor(new Date(b.start + "T00:00")); setMode("day"); }} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", fontSize: 13 }}>
                  <span style={{ fontWeight: 700, color: "#10211E", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v.name} · {b.type}</span>
                  <span style={{ color: "#475569", fontWeight: 600, flexShrink: 0, marginLeft: 8 }}>{fmtDate(b.start)} ({dow(b.start)}){b.days > 1 ? ` –${b.days}d` : ""}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* Availability chips component (used in Day + Week) */}


      {mode==="agenda" && (() => {
        const startIso = isoOf(today);
        const _nd = new Date(today.getFullYear(), today.getMonth() + 2, 0); // last day of next month
        const endIso = isoOf(_nd);
        const inRange = d => d && d >= startIso && d <= endIso;
        const items = [];
        if (showMoves) jobs.forEach(j => jobStages(j).forEach(st => { if (inRange(st.date)) items.push({ type:"move", date:st.date, time:st.time||"", job:j, stage:st }); }));
        if (showSurveys) (data.enquiries||[]).forEach(en => { if (inRange(en.surveyDate) && en.status!=="Lost") items.push({ type:"survey", date:en.surveyDate, time:en.surveyTime||"", en }); });
        if (showVeh) (data.vehicles||[]).forEach(v => ((v.maint&&v.maint.bookings)||[]).forEach(b => { if (b.start && isoAdd(b.start,{days:Math.max(1,Number(b.days)||1)-1}) >= startIso && b.start <= endIso) items.push({ type:"maint", date: b.start < startIso ? startIso : b.start, time:"00", v, b }); }));
        if (showStaffOff) (data.staff||[]).forEach(s => ((s.away)||[]).forEach(b => { if (b.start && isoAdd(b.start,{days:Math.max(1,Number(b.days)||1)-1}) >= startIso && b.start <= endIso) items.push({ type:"staffoff", date: b.start < startIso ? startIso : b.start, time:"00", s, b }); }));
        items.sort((a,b)=> (a.date+(a.time||"99")).localeCompare(b.date+(b.time||"99")));
        if (!items.length) return <Empty icon="calendar" text="Nothing this month or next" />;
        const groups = [];
        items.forEach(it => { const g = groups[groups.length-1]; if (g && g.date===it.date) g.items.push(it); else groups.push({ date:it.date, items:[it] }); });
        return (
          <div style={{ display:"flex", flexDirection:"column", gap:18 }}>
            {groups.map(g => (
              <div key={g.date}>
                <div style={{ fontSize:13, fontWeight:800, color: sameDay(new Date(g.date+"T00:00"),today)?AMBER:"#10211E", marginBottom:8, textTransform:"uppercase", letterSpacing:".04em" }}>{fmtDate(g.date)} ({dow(g.date)}){sameDay(new Date(g.date+"T00:00"),today)?" · Today":""}</div>
                <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                  {g.items.map((it,ix) => it.type==="survey" ? <SurveyCard key={ix} en={it.en} big /> : it.type==="maint" ? <MaintCard key={ix} v={it.v} b={it.b} big /> : it.type==="staffoff" ? <StaffOffCard key={ix} s={it.s} b={it.b} big /> : <MoveCard key={ix} m={{ job:it.job, stage:it.stage }} big />)}
                </div>
              </div>
            ))}
          </div>
        );
      })()}

      {mode==="month" && (() => {
        const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
        const start = startOfWeek(first);
        const cells = [];
        for (let i=0;i<42;i++) {
          const d = addDays(start,i); const out = d.getMonth()!==anchor.getMonth();
          const evs = jobsOn(d); const svs = surveysOn(d); const mnt = maintOn(d);
          const total = evs.length + svs.length + mnt.length;
          cells.push(
            <div key={i} onClick={()=>{ setAnchor(d); setMode("day"); }} style={{ background: out?"#F7F9F9":"#fff", border:"1px solid #E9EEED", borderRadius:12, minHeight:92, padding:7, cursor:"pointer", display:"flex", flexDirection:"column", gap:3, overflow:"hidden" }}>
              <div style={{ alignSelf:"flex-start", fontSize:12, fontWeight:800, color: out?"#B7C3C0":"#3c4c48", ...(sameDay(d,today)?{ background:AMBER, color:"#fff", width:23, height:23, borderRadius:7, display:"flex", alignItems:"center", justifyContent:"center" }:{}) }}>{d.getDate()}</div>
              {svs.slice(0,2).map(en => <div key={en.id} style={{ fontSize:10.5, fontWeight:700, color:"#92591A", background:"#FFF6E6", borderLeft:`3px solid ${AMBER}`, borderRadius:5, padding:"2px 5px", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>📋 {custName(data,en.customerId)}</div>)}
              {evs.slice(0,3).map((m,ix) => <div key={ix} style={{ fontSize:10.5, fontWeight:700, color:"#22332F", background:"#EEF3F2", borderLeft:`3px solid ${colorOf(m)}`, borderRadius:5, padding:"2px 5px", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{custName(data,m.job.customerId)}{m.stage.type?` · ${m.stage.type}`:""}</div>)}
              {mnt.slice(0,2).map((mm,ix) => <div key={"m"+ix} style={{ fontSize:10.5, fontWeight:700, color:"#475569", background:"#EEF2F7", borderLeft:"3px solid #64748B", borderRadius:5, padding:"2px 5px", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>🔧 {mm.v.name} · {mm.b.type}</div>)}
              {total>5 && <div style={{ fontSize:10, color:"#94A4A0", fontWeight:700 }}>+{total-5} more</div>}
            </div>
          );
        }
        return (
          <div>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:7, marginBottom:7 }}>
              {CAL_DOW.map(d => <div key={d} style={{ fontSize:11, fontWeight:800, color:"#94A4A0", textTransform:"uppercase", letterSpacing:".05em", textAlign:"center" }}>{d}</div>)}
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:7 }}>{cells}</div>
          </div>
        );
      })()}

      {mode==="week" && (() => {
        const start = startOfWeek(anchor);
        const days = []; for (let i=0;i<7;i++) days.push(addDays(start,i));
        return (
          <div style={{ overflowX:"auto", paddingBottom:6 }}>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(7, minmax(120px,1fr))", gap:8, minWidth:860 }}>
              {days.map((d,i) => {
                const evs = jobsOn(d); const isToday = sameDay(d,today);
                return (
                  <div key={i} style={{ background:"#fff", border:`1px solid ${isToday?"#FBD9A0":"#E9EEED"}`, borderRadius:12, overflow:"hidden", display:"flex", flexDirection:"column" }}>
                    <div style={{ background: isToday?"#FFF7E8":"#F4F7F6", borderBottom:"1px solid #E9EEED", padding:"7px 6px", textAlign:"center" }}>
                      <div style={{ fontSize:11, fontWeight:800, color:"#94A4A0", textTransform:"uppercase" }}>{CAL_DOW[i]}</div>
                      <div style={{ fontSize:16, fontWeight:800, color: isToday?AMBER:"#2c3c38" }}>{d.getDate()}</div>
                    </div>
                    <div style={{ padding:7, display:"flex", flexDirection:"column", gap:6, minHeight:90 }}>
                      {surveysOn(d).map(en => <SurveyCard key={en.id} en={en} />)}
                      {maintOn(d).map((mm,ix) => <MaintCard key={"m"+ix} v={mm.v} b={mm.b} />)}
                      {staffOffOnCal(d).map((so,ix) => <StaffOffCard key={"so"+ix} s={so.s} b={so.b} />)}
                      {evs.map((m,ix) => <MoveCard key={m.job.id+'-'+ix} m={m} />)}
                    </div>
                    {showMoves && ((data.vehicles||[]).length>0 || (data.staff||[]).filter(s=>s.active!==false).length>0) && (() => {
                      const bv = bookedVehiclesOn(d), bs = bookedStaffOn(d);
                      const freeV = (data.vehicles||[]).filter(v=>!bv.has(v.id)).length;
                      const freeS = (data.staff||[]).filter(s=>s.active!==false && !bs.has(s.name)).length;
                      return <div style={{ borderTop:"1px solid #F2F5F4", padding:"6px 7px", fontSize:10.5, fontWeight:700, color: (freeV||freeS)?"#3f817a":"#C4D0CD", textAlign:"center" }}>{freeV} van{freeV!==1?"s":""} · {freeS} crew free</div>;
                    })()}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {mode==="day" && (() => {
        const evs = jobsOn(anchor); const svs = surveysOn(anchor); const isToday = sameDay(anchor,today);
        return (
          <div>
            <div style={{ background: isToday?"#FFF7E8":"#F4F7F6", border:"1px solid #E9EEED", borderRadius:12, padding:"10px 14px", marginBottom:12, fontSize:13, fontWeight:800, color:"#2c3c38" }}>
              {evs.length} move{evs.length!==1?"s":""}{svs.length?` · ${svs.length} survey${svs.length!==1?"s":""}`:""} · {CAL_DOW[(anchor.getDay()+6)%7]} {anchor.getDate()} {CAL_MON[anchor.getMonth()]}
            </div>
            <AvailPanel d={anchor} />
            <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
              {svs.map(en => <SurveyCard key={en.id} en={en} big />)}
              {maintOn(anchor).map((mm,ix) => <MaintCard key={"m"+ix} v={mm.v} b={mm.b} big />)}
              {staffOffOnCal(anchor).map((so,ix) => <StaffOffCard key={"so"+ix} s={so.s} b={so.b} big />)}
              {evs.map((m,ix) => <MoveCard key={m.job.id+'-'+ix} m={m} big />)}
              {evs.length===0 && svs.length===0 && maintOn(anchor).length===0 && staffOffOnCal(anchor).length===0 && <Empty icon="truck" text="Nothing booked this day" />}
            </div>
          </div>
        );
      })()}

      {jobs.length===0 && !(data.enquiries||[]).some(e=>e.surveyDate) && <div style={{ marginTop:16 }}><Empty icon="truck" text="No moves or surveys booked yet" /></div>}
    </div>
  );
}
const navBtn = { width:36, height:36, borderRadius:11, border:"1px solid #E3E9E8", background:"#fff", color:"#41514E", cursor:"pointer", fontSize:20, lineHeight:1, fontWeight:700 };

// ── Device responsiveness ───────────────────────────────────────────────────
function useDeviceType() {
  const get = () => {
    try { if (localStorage.getItem("removals_force_phone") === "1") return "phone"; } catch {}
    const w = typeof window !== "undefined" ? window.innerWidth : 520;
    if (w >= 1024) return "desktop";
    if (w >= 768) return "tablet";
    return "phone";
  };
  const [device, setDevice] = useState(get);
  useEffect(() => {
    const onResize = () => setDevice(get());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return device;
}
function ResponsiveStyles({ device }) {
  const wide = device !== "phone";
  const common = `
    html,body{-webkit-text-size-adjust:100%;text-size-adjust:100%}
    *{-webkit-text-size-adjust:100%;text-size-adjust:100%}
    *{scrollbar-width:thin;scrollbar-color:#CBD6D3 transparent}
    ::-webkit-scrollbar{width:9px;height:9px}::-webkit-scrollbar-thumb{background:#CBD6D3;border-radius:9px}
    .rm-btn:hover,.rm-btn-sm:hover{transform:translateY(-1px)}
    input[type="date"],input[type="time"]{-webkit-appearance:none;appearance:none;min-width:0;max-width:100%;box-sizing:border-box}
    input::-webkit-date-and-time-value{text-align:left;margin:0;min-width:0}
    input::-webkit-datetime-edit{padding:0}
    @media (prefers-reduced-motion:reduce){*{transition:none!important}}
  `;
  const phone = `
    input,select,textarea{font-size:16px!important;padding:14px 14px!important}
    .rm-btn{padding:13px 18px!important;font-size:15px!important}.rm-btn-sm{padding:9px 13px!important;font-size:13.5px!important}
    .rm-modal{border-radius:22px 22px 0 0!important}
  `;
  const wideCss = `
    .rm-modal-overlay{align-items:center!important}
    .rm-modal{max-width:560px!important;border-radius:20px!important;margin:0 16px;max-height:88vh!important}
    .rm-company-grid{grid-template-columns:1fr 1fr!important;align-items:start}
    input,select,textarea{font-size:15px!important}
  `;
  return <style>{common + (wide ? wideCss : phone)}</style>;
}

// ── Merge helper (newest-wins, tombstone-aware) ─────────────────────────────
function mergeArrays(cloudArr, localArr, deleted) {
  const byId = {};
  (cloudArr || []).forEach(x => { if (!deleted.includes(x.id)) byId[x.id] = x; });
  (localArr || []).forEach(x => {
    if (deleted.includes(x.id)) return;
    const c = byId[x.id];
    if (c) {
      let winner = (x.updatedAt || 0) >= (c.updatedAt || 0) ? x : c;
      // Never lose a reference the database assigned (its updatedAt doesn't change).
      const ref = winner.ref != null ? winner.ref : (x.ref != null ? x.ref : (c.ref != null ? c.ref : null));
      byId[x.id] = (ref != null && ref !== winner.ref) ? { ...winner, ref } : winner;
    } else byId[x.id] = x; // local-only: keep (genuine deletes use tombstones)
  });
  return Object.values(byId);
}
function mergeAll(cloud, local) {
  const deleted = getTombstones();
  return {
    customers: mergeArrays(cloud.customers, local.customers || [], deleted),
    enquiries: mergeArrays(cloud.enquiries, local.enquiries || [], deleted),
    jobs: mergeArrays(cloud.jobs, local.jobs || [], deleted),
    vehicles: mergeArrays(cloud.vehicles, local.vehicles || [], deleted),
    staff: mergeArrays(cloud.staff, local.staff || [], deleted),
  };
}

// ── App ─────────────────────────────────────────────────────────────────────
const SECTIONS = {
  enquiries: { list: "enquiries", detail: "enquiryDetail", List: EnquiriesList, Detail: EnquiryDetail },
  jobs:      { list: "jobs",      detail: "jobDetail",      List: JobsList,      Detail: JobDetail },
  customers: { list: "customers", detail: "customerDetail", List: CustomersList, Detail: CustomerDetail },
};
function sectionFor(screen) {
  if (["enquiries", "enquiryDetail", "newEnquiry"].includes(screen)) return "enquiries";
  if (["jobs", "jobDetail"].includes(screen)) return "jobs";
  if (["customers", "customerDetail"].includes(screen)) return "customers";
  return null;
}

function CatalogueEditor({ catalog, onSave, setView }) {
  const [draft, setDraft] = useState(() => ({ rooms: (catalog.rooms || []).slice(), items: (catalog.items || []).map(it => ({ ...it })) }));
  const [openRoom, setOpenRoom] = useState((catalog.rooms || [])[0] || "");
  const [newRoom, setNewRoom] = useState("");
  const [saving, setSaving] = useState(false);
  const [copyRoom, setCopyRoom] = useState("");   // which room's copy-picker is open
  const [copySearch, setCopySearch] = useState("");
  const inp = { width: "100%", padding: "9px 10px", border: "1px solid #D9E2E0", borderRadius: 9, fontSize: 14, boxSizing: "border-box", background: "#fff" };
  const numInp = { ...inp, textAlign: "center", padding: "9px 4px" };

  const setItem = (id, field, val) => setDraft(d => ({ ...d, items: d.items.map(it => it.id === id ? { ...it, [field]: val } : it) }));
  const delItem = id => setDraft(d => ({ ...d, items: d.items.filter(it => it.id !== id) }));
  const addItem = room => {
    const it = { id: slugId(room, "item"), room, name: "", cuFt: 10, m3: +(10 * M3_PER_CUFT).toFixed(3), kg: 10 };
    setDraft(d => ({ ...d, items: [...d.items, it] }));
  };
  const copyItemInto = (room, src) => {
    const it = { id: slugId(room, src.name), room, name: src.name, cuFt: src.cuFt, m3: src.m3, kg: src.kg };
    setDraft(d => ({ ...d, items: [...d.items, it] }));
    setCopyRoom(""); setCopySearch("");
  };
  const addRoom = () => {
    const name = newRoom.trim();
    if (!name || draft.rooms.includes(name)) { setNewRoom(""); return; }
    setDraft(d => ({ ...d, rooms: [...d.rooms, name] }));
    setNewRoom(""); setOpenRoom(name);
  };
  const delRoom = room => {
    const n = draft.items.filter(it => it.room === room).length;
    const msg = n > 0
      ? `Remove the room "${room}" and its ${n} catalogue item${n !== 1 ? "s" : ""}?\n\nThis just removes it from the room list — surveys you've already saved keep their data.`
      : `Remove the room "${room}"?`;
    if (!confirm(msg)) return;
    setDraft(d => ({ ...d, rooms: d.rooms.filter(r => r !== room), items: d.items.filter(it => it.room !== room) }));
  };
  const moveRoom = (room, dir) => {
    setDraft(d => {
      const rooms = d.rooms.slice();
      const i = rooms.indexOf(room);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= rooms.length) return d;
      [rooms[i], rooms[j]] = [rooms[j], rooms[i]];
      return { ...d, rooms };
    });
  };

  async function doSave() {
    setSaving(true);
    const items = draft.items
      .filter(it => (it.name || "").trim())
      .map(it => {
        const cuFt = Math.max(0, Number(it.cuFt) || 0);
        return { id: it.id || slugId(it.room, it.name), room: it.room, name: it.name.trim(), cuFt, m3: +(cuFt * M3_PER_CUFT).toFixed(3), kg: Math.max(0, Number(it.kg) || 0) };
      });
    await onSave({ rooms: draft.rooms, items });
    setSaving(false);
    setView({ screen: "company" });
  }
  function resetDefaults() {
    if (!confirm("Reset the whole catalogue back to the built-in list? Your custom edits will be lost.")) return;
    const def = buildDefaultCatalog();
    setDraft({ rooms: def.rooms, items: def.items });
    setOpenRoom(def.rooms[0]);
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <button onClick={() => setView({ screen: "company" })} style={{ background: "none", border: "none", color: TEAL, fontSize: 15, fontWeight: 700, cursor: "pointer", padding: 0 }}>‹ Back</button>
      </div>
      <h2 style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 800, color: "#10211E" }}>Item catalogue</h2>
      <div style={{ fontSize: 13, color: "#6A7B77", marginBottom: 16 }}>Edit names, volumes (cu ft) and weights (kg). Add items or rooms. Changes sync to all your devices when you save.</div>

      {draft.rooms.map((room, ri) => {
        const items = draft.items.filter(it => it.room === room);
        const isOpen = openRoom === room;
        const isCopy = copyRoom === room;
        return (
          <Card key={room} style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, cursor: "pointer", minWidth: 0 }} onClick={() => setOpenRoom(isOpen ? "" : room)}>
                <span style={{ fontWeight: 800, color: "#10211E", fontSize: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{room}</span>
                <span style={{ color: "#B7C3C0", fontWeight: 600, fontSize: 13, flexShrink: 0 }}>({items.length})</span>
              </div>
              <div style={{ display: "flex", gap: 4, alignItems: "center", flexShrink: 0 }}>
                <button onClick={e => { e.stopPropagation(); moveRoom(room, -1); }} disabled={ri === 0} style={{ background: "none", border: "none", color: ri === 0 ? "#D5DDDB" : "#6A7B77", fontSize: 17, cursor: ri === 0 ? "default" : "pointer", padding: "0 4px" }}>▲</button>
                <button onClick={e => { e.stopPropagation(); moveRoom(room, 1); }} disabled={ri === draft.rooms.length - 1} style={{ background: "none", border: "none", color: ri === draft.rooms.length - 1 ? "#D5DDDB" : "#6A7B77", fontSize: 17, cursor: ri === draft.rooms.length - 1 ? "default" : "pointer", padding: "0 4px" }}>▼</button>
                <button onClick={e => { e.stopPropagation(); delRoom(room); }} style={{ background: "none", border: "none", color: "#C0605A", fontSize: 12, fontWeight: 700, cursor: "pointer", marginLeft: 4 }}>Remove</button>
                <span onClick={() => setOpenRoom(isOpen ? "" : room)} style={{ color: "#B7C3C0", fontSize: 18, cursor: "pointer", marginLeft: 2 }}>{isOpen ? "▾" : "▸"}</span>
              </div>
            </div>
            {isOpen && (
              <div style={{ marginTop: 10 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 62px 62px 26px", gap: 6, fontSize: 11, color: "#94A4A0", fontWeight: 700, padding: "0 2px 4px" }}>
                  <div>Item</div><div style={{ textAlign: "center" }}>cu ft</div><div style={{ textAlign: "center" }}>kg</div><div></div>
                </div>
                {items.map(it => (
                  <div key={it.id} style={{ display: "grid", gridTemplateColumns: "1fr 62px 62px 26px", gap: 6, marginBottom: 6, alignItems: "center" }}>
                    <input value={it.name} placeholder="Item name" onChange={e => setItem(it.id, "name", e.target.value)} style={inp} />
                    <input value={it.cuFt} inputMode="decimal" onChange={e => setItem(it.id, "cuFt", e.target.value)} style={numInp} />
                    <input value={it.kg} inputMode="numeric" onChange={e => setItem(it.id, "kg", e.target.value)} style={numInp} />
                    <button onClick={() => delItem(it.id)} style={{ background: "none", border: "none", color: "#C0605A", fontSize: 18, cursor: "pointer", padding: 0 }}>×</button>
                  </div>
                ))}
                <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                  <button onClick={() => addItem(room)} style={{ flex: 1, background: "none", border: "1px dashed #CDE7E2", color: TEAL, fontWeight: 700, fontSize: 13, borderRadius: 9, padding: "8px 0", cursor: "pointer" }}>+ Add item</button>
                  <button onClick={() => { setCopyRoom(isCopy ? "" : room); setCopySearch(""); }} style={{ flex: 1, background: "none", border: "1px dashed #CDE7E2", color: TEAL, fontWeight: 700, fontSize: 13, borderRadius: 9, padding: "8px 0", cursor: "pointer" }}>{isCopy ? "Close" : "Copy item in…"}</button>
                </div>
                {isCopy && (
                  <div style={{ marginTop: 8, border: "1px solid #E3ECEA", borderRadius: 10, padding: 8, background: "#F8FBFA" }}>
                    <input value={copySearch} autoFocus placeholder="Search all items…" onChange={e => setCopySearch(e.target.value)} style={inp} />
                    <div style={{ maxHeight: 220, overflowY: "auto", marginTop: 8 }}>
                      {draft.items
                        .filter(it => (it.name || "").toLowerCase().includes(copySearch.toLowerCase()))
                        .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
                        .slice(0, 60)
                        .map((it, i) => (
                          <div key={it.id + i} onClick={() => copyItemInto(room, it)} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 6px", borderBottom: "1px solid #EEF3F2", cursor: "pointer", gap: 8 }}>
                            <span style={{ fontSize: 14, color: "#10211E", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.name}</span>
                            <span style={{ fontSize: 12, color: "#94A4A0", flexShrink: 0 }}>{it.room} · {it.cuFt}cf</span>
                          </div>
                        ))}
                      {draft.items.filter(it => (it.name || "").toLowerCase().includes(copySearch.toLowerCase())).length === 0 && (
                        <div style={{ fontSize: 13, color: "#94A4A0", padding: "8px 6px" }}>No matching items.</div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </Card>
        );
      })}

      <Card style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: ".06em", color: "#94A4A0", fontWeight: 800, marginBottom: 8 }}>Add a room</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={newRoom} placeholder="e.g. Utility Room" onChange={e => setNewRoom(e.target.value)} style={inp} />
          <Btn onClick={addRoom} disabled={!newRoom.trim()}>Add</Btn>
        </div>
      </Card>

      <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
        <Btn onClick={doSave} disabled={saving} style={{ flex: 1 }}>{saving ? "Saving…" : "Save catalogue"}</Btn>
        <Btn variant="ghost" onClick={() => setView({ screen: "company" })}>Cancel</Btn>
      </div>
      <button onClick={resetDefaults} style={{ background: "none", border: "none", color: "#94A4A0", fontSize: 12, fontWeight: 600, cursor: "pointer", marginTop: 14, display: "block" }}>Reset to built-in defaults</button>
    </div>
  );
}

function SignaturePad({ label, value, onChange }) {
  const ref = useRef(null);
  const drawing = useRef(false);
  const last = useRef(null);
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const ctx = cv.getContext("2d");
    ctx.lineWidth = 2.2; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#10211E";
    if (value) { const img = new Image(); img.onload = () => ctx.drawImage(img, 0, 0, cv.width, cv.height); img.src = value; }
  }, []);
  const pos = e => { const cv = ref.current; const r = cv.getBoundingClientRect(); const t = e.touches ? e.touches[0] : e; return { x: (t.clientX - r.left) * (cv.width / r.width), y: (t.clientY - r.top) * (cv.height / r.height) }; };
  const start = e => { e.preventDefault(); drawing.current = true; last.current = pos(e); };
  const move = e => { if (!drawing.current) return; e.preventDefault(); const ctx = ref.current.getContext("2d"); const p = pos(e); ctx.beginPath(); ctx.moveTo(last.current.x, last.current.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last.current = p; };
  const end = () => { if (!drawing.current) return; drawing.current = false; onChange(ref.current.toDataURL("image/png")); };
  const clear = () => { const cv = ref.current; cv.getContext("2d").clearRect(0, 0, cv.width, cv.height); onChange(""); };
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>{label}</span>
        <button onClick={clear} style={{ background: "none", border: "none", color: TEAL, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Clear</button>
      </div>
      <canvas ref={ref} width={500} height={150}
        onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
        onTouchStart={start} onTouchMove={move} onTouchEnd={end}
        style={{ width: "100%", height: 150, border: "1px solid #D9E2E0", borderRadius: 10, background: "#fff", touchAction: "none", display: "block" }} />
    </div>
  );
}

async function buildStorageIntakePdf(rec, c, data) {
  const { PDFDocument, StandardFonts, rgb } = await loadPdfLib();
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = 595.28, H = 841.89, M = 44;
  const teal = rgb(0.055, 0.486, 0.451), navy = rgb(0.059, 0.18, 0.165), grey = rgb(0.42, 0.46, 0.45), white = rgb(1, 1, 1);
  const clean = s => String(s == null ? "" : s).replace(/[\u2018\u2019\u201A\u2032]/g, "'").replace(/[\u201C\u201D\u201E\u2033]/g, '"').replace(/[\u2013\u2014\u2212]/g, "-").replace(/\u2026/g, "...").replace(/\u00A0/g, " ").replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, "");
  let page, y;
  const np = () => { page = pdf.addPage([W, H]); y = H - M; };
  const ensure = h => { if (y - h < M) np(); };
  const at = (t, x, yy, size, f = font, col = navy) => page.drawText(clean(t), { x, y: yy, size, font: f, color: col });
  const heading = t => { ensure(30); y -= 8; at(t, M, y, 12, bold, teal); y -= 7; page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1, color: teal }); y -= 15; };
  const kv = (label, value) => { ensure(15); at(label, M, y, 9.5, bold, grey); at(value || "-", M + 92, y, 9.5, font, navy); y -= 15; };
  const embedSig = async url => { if (!url || url.indexOf("data:image") !== 0) return null; try { const b64 = url.split(",")[1]; const bin = atob(b64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); return await pdf.embedPng(bytes); } catch { return null; } };

  np();
  page.drawRectangle({ x: 0, y: H - 66, width: W, height: 66, color: teal });
  at("R&J Removals & Storage", M, H - 34, 16, bold, white);
  at("Storage Inventory & Condition Report", M, H - 51, 11, font, rgb(0.88, 0.96, 0.94));
  const ref = c?.ref ? `Ref ${c.ref}` : "";
  if (ref) { const w = bold.widthOfTextAtSize(ref, 12); at(ref, W - M - w, H - 40, 12, bold, white); }
  y = H - 88;

  kv("Customer", c?.name || "-");
  kv("Date", rec.date ? fmtUK(rec.date) : "-");
  kv("Location", rec.location || "-");
  kv("Crew", (rec.crew || []).join(", ") || "-");

  (rec.containers || []).forEach(ct => {
    heading(`Container ${ct.number || "-"}`);
    const items = (ct.items || []).filter(it => (it.name || "").trim());
    if (!items.length) { at("No items listed.", M, y, 9.5, font, grey); y -= 14; }
    else items.forEach(it => {
      ensure(14);
      const qty = Number(it.qty) || 1;
      at(`${qty} x`, M, y, 9.5, bold, navy);
      at(clean(it.name), M + 34, y, 9.5, font, navy);
      const condStr = Array.isArray(it.conditions) ? it.conditions.join(", ") : (it.condition || "");
      const posStr = Array.isArray(it.positions) ? it.positions.join(", ") : (it.position || "");
      const parts = [condStr, posStr].filter(Boolean);
      if (it.dismantle) parts.push(`Dismantle by ${it.dismantle}`);
      const cp = it.packedBy ? it.packedBy : parts.join(" — ");
      if (cp) { const cw = font.widthOfTextAtSize(clean(cp), 9); at(clean(cp), W - M - cw, y, 9, font, grey); }
      y -= 14;
    });
  });

  if ((Array.isArray(rec.looseList) && rec.looseList.length) || rec.looseItems) {
    ensure(30);
    heading("Loose items");
    if (Array.isArray(rec.looseList) && rec.looseList.length) { rec.looseList.forEach(li => { ensure(13); at(`${li.qty || 1} x ${clean(li.name)}`, M, y, 9.5, font, navy); y -= 13; }); }
    else { at(clean(rec.looseNote || "Yes"), M, y, 9.5, font, navy); y -= 16; }
  }

  if ((rec.collections || []).length) {
    heading("Items collected by customer");
    rec.collections.forEach(col => {
      ensure(24);
      at(`${col.date ? fmtUK(col.date) : ""}${col.sig ? "   (signed)" : ""}`, M, y, 9.5, bold, navy); y -= 13;
      (col.items || []).forEach(ci => { ensure(12); at(`${ci.qty} x ${clean(ci.name)}${ci.container ? ` (Container ${ci.container})` : ""}`, M + 12, y, 9, font, navy); y -= 12; });
      y -= 6;
    });
  }

  // Signatures
  ensure(150);
  heading("Sign off");
  at("I confirm the above is an accurate record of the goods and their condition at the time of storage.", M, y, 9, font, grey); y -= 22;
  const custImg = await embedSig(rec.custSig), empImg = await embedSig(rec.empSig);
  const boxW = (W - 2 * M - 20) / 2, boxH = 70, yTop = y;
  const drawSig = (x, img, label, name) => {
    page.drawRectangle({ x, y: yTop - boxH, width: boxW, height: boxH, borderColor: grey, borderWidth: 0.7, color: white });
    if (img) { const s = Math.min(boxW - 16, (boxH - 26) * (img.width / img.height)); const h = s * (img.height / img.width); page.drawImage(img, { x: x + (boxW - s) / 2, y: yTop - boxH + 22, width: s, height: Math.min(h, boxH - 26) }); }
    at(label, x + 4, yTop - boxH + 8, 8, bold, grey);
    if (name) { const nw = font.widthOfTextAtSize(clean(name), 8); at(clean(name), x + boxW - nw - 4, yTop - boxH + 8, 8, font, grey); }
  };
  drawSig(M, custImg, "Customer signature", c?.name || "");
  drawSig(M + boxW + 20, empImg, "Employee signature", rec.empName || "");
  y = yTop - boxH - 16;
  at(`Generated ${fmtUK(todayISO())} · R&J Removals & Storage`, M, y, 8, font, grey);

  const bytes = await pdf.save();
  return { bytes, ref: c?.ref || "" };
}

function SignatureModal({ title, initial, onCancel, onAccept }) {
  const ref = useRef(null);
  const drawing = useRef(false);
  const last = useRef(null);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const ctx = cv.getContext("2d");
    ctx.lineWidth = 2.8; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#10211E";
    if (initial) { const img = new Image(); img.onload = () => ctx.drawImage(img, 0, 0, cv.width, cv.height); img.src = initial; }
  }, []);
  const pos = e => { const cv = ref.current; const r = cv.getBoundingClientRect(); const t = e.touches ? e.touches[0] : e; return { x: (t.clientX - r.left) * (cv.width / r.width), y: (t.clientY - r.top) * (cv.height / r.height) }; };
  const start = e => { e.preventDefault(); drawing.current = true; last.current = pos(e); };
  const move = e => { if (!drawing.current) return; e.preventDefault(); const ctx = ref.current.getContext("2d"); const p = pos(e); ctx.beginPath(); ctx.moveTo(last.current.x, last.current.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last.current = p; setDirty(true); };
  const end = () => { drawing.current = false; };
  const clear = () => { const cv = ref.current; cv.getContext("2d").clearRect(0, 0, cv.width, cv.height); setDirty(true); };
  const accept = () => { const cv = ref.current; onAccept(dirty ? cv.toDataURL("image/png") : (initial || "")); };
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(16,33,30,.55)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ background: "#fff", borderRadius: 16, width: "100%", maxWidth: 660, padding: 16, boxShadow: "0 20px 60px rgba(0,0,0,.3)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={{ fontWeight: 800, fontSize: 16, color: "#10211E" }}>{title}</div>
          <button onClick={clear} style={{ background: "none", border: "none", color: TEAL, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Clear</button>
        </div>
        <canvas ref={ref} width={900} height={340}
          onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
          onTouchStart={start} onTouchMove={move} onTouchEnd={end}
          style={{ width: "100%", height: 300, border: "1px solid #D9E2E0", borderRadius: 12, background: "#fff", touchAction: "none", display: "block" }} />
        <div style={{ fontSize: 12, color: "#94A4A0", textAlign: "center", margin: "8px 0 12px" }}>Sign above with your finger or stylus</div>
        <div style={{ display: "flex", gap: 10 }}>
          <Btn variant="grey" style={{ flex: 1 }} onClick={onCancel}>Cancel</Btn>
          <Btn style={{ flex: 2 }} onClick={accept}>Accept</Btn>
        </div>
      </div>
    </div>
  );
}

function SigField({ label, value, onOpen }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 4 }}>{label}</div>
      <button onClick={onOpen} style={{ width: "100%", minHeight: value ? 90 : 60, border: "1px solid #D9E2E0", borderRadius: 10, background: value ? "#fff" : "#F8FBFA", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 8 }}>
        {value ? <img src={value} alt="signature" style={{ maxHeight: 90, maxWidth: "100%" }} /> : <span style={{ color: TEAL, fontWeight: 700, fontSize: 13 }}>Tap to sign</span>}
      </button>
      {value && <div style={{ textAlign: "right", marginTop: 4 }}><span style={{ color: TEAL, fontSize: 12, fontWeight: 700 }}>Tap to edit / re-sign</span></div>}
    </div>
  );
}

function StorageIntakeForm({ data, setView, presetCustomerId, editRecId, presetJobId }) {
  const device = useDeviceType();
  const phone = device === "phone";
  const editCust = editRecId ? (data.customers || []).find(c => (c.storageInv || []).some(r => r.id === editRecId)) : null;
  const editRec = editCust ? (editCust.storageInv || []).find(r => r.id === editRecId) : null;
  const loadConts = rec => { const cs = (rec.containers || []).map(c => ({ id: uid(), number: c.number || "", items: (c.items || []).map(it => ({ id: uid(), name: it.name || "", qty: it.qty || 1, conditions: Array.isArray(it.conditions) ? it.conditions : (it.condition ? [it.condition] : []), positions: Array.isArray(it.positions) ? it.positions : (it.position ? [it.position] : []), packedBy: it.packedBy || "", dismantle: it.dismantle || "" })) })); return cs.length ? cs : [{ id: uid(), number: "", items: [{ id: uid(), name: "", qty: 1, conditions: [], positions: [], packedBy: "", dismantle: "" }] }]; };
  const DRAFT_KEY = editRecId ? "storageIntakeDraft_" + editRecId : "storageIntakeDraft";
  const saved = (() => { try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "null"); } catch { return null; } })();
  const src = saved || (editRec ? { customerId: editCust.id, date: editRec.date, location: editRec.location, crew: editRec.crew, containers: loadConts(editRec), custSig: editRec.custSig, empSig: editRec.empSig, empName: editRec.empName } : null);
  const [customerId, setCustomerId] = useState(src?.customerId ?? (presetCustomerId || ""));
  const [jobId, setJobId] = useState((editRec && editRec.jobId) || presetJobId || "");
  const [date, setDate] = useState(src?.date ?? todayISO());
  const [location, setLocation] = useState(src?.location ?? (getStorageLocs()[0] || "Wild & Lye"));
  const [crew, setCrew] = useState(src?.crew ?? []);
  const [containers, setContainers] = useState(src?.containers ?? [{ id: uid(), number: "", items: [{ id: uid(), name: "", qty: 1, conditions: [], positions: [], packedBy: "", dismantle: "" }] }]);
  const [custSig, setCustSig] = useState(src?.custSig ?? "");
  const [empSig, setEmpSig] = useState(src?.empSig ?? "");
  const [empName, setEmpName] = useState(src?.empName ?? "");
  const [looseList, setLooseList] = useState(() => {
    const base = src?.looseList ?? (editRec && Array.isArray(editRec.looseList) ? editRec.looseList : null);
    if (Array.isArray(base)) return base.map(li => ({ id: li.id || uid(), name: li.name || "", qty: li.qty ?? 1 }));
    return [];
  });
  const addLoose = () => setLooseList(p => [...p, { id: uid(), name: "", qty: 1 }]);
  const setLoose = (id, k, v) => setLooseList(p => p.map(li => li.id === id ? { ...li, [k]: v } : li));
  const removeLoose = id => setLooseList(p => p.filter(li => li.id !== id));
  useEffect(() => {
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ customerId, date, location, crew, containers, custSig, empSig, empName, looseList })); } catch {}
  }, [customerId, date, location, crew, containers, custSig, empSig, empName]);
  const clearDraft = () => { try { sessionStorage.removeItem(DRAFT_KEY); } catch {} };
  const leave = () => { clearDraft(); setView({ screen: "storage" }); };
  // Pull the "Into store" day (date + crew) from the customer's move plan, if there is one.
  const findStoreDay = cid => {
    for (const j of (data.jobs || []).filter(x => x.customerId === cid)) { const st = jobStages(j).find(s => /store/i.test(s.type || "")); if (st) return st; }
    for (const en of (data.enquiries || []).filter(x => x.customerId === cid)) { const st = (en.stages || []).find(s => /store/i.test(s.type || "")); if (st) return st; }
    return null;
  };
  const [prefillMsg, setPrefillMsg] = useState("");
  const applyStoreDay = cid => {
    const sd = cid ? findStoreDay(cid) : null;
    if (!sd) { setPrefillMsg(""); return; }
    if (sd.date) setDate(sd.date);
    if (Array.isArray(sd.crew) && sd.crew.length) setCrew(sd.crew);
    setPrefillMsg(`Pre-filled from the move plan: ${sd.date ? fmtUK(sd.date) : "date"}${sd.crew && sd.crew.length ? " · " + sd.crew.join(", ") : ""}. Adjust if needed.`);
  };
  const pickCustomer = cid => { setCustomerId(cid); applyStoreDay(cid); };
  useEffect(() => { if (presetCustomerId && !saved) applyStoreDay(presetCustomerId); /* eslint-disable-next-line */ }, []);
  const [conds, setConds] = useState(getConditions);
  const [newCond, setNewCond] = useState("");
  const [poss, setPoss] = useState(getPositions);
  const [newPos, setNewPos] = useState("");
  const [signing, setSigning] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const crewOpts = (data.staff || []).filter(s => s.active !== false).map(s => ({ id: s.name, label: s.name }));
  const setContainerNo = (ci, v) => setContainers(cs => cs.map((c, i) => i === ci ? { ...c, number: v } : c));
  const addContainer = () => setContainers(cs => [...cs, { id: uid(), number: "", items: [{ id: uid(), name: "", qty: 1, conditions: [], positions: [], packedBy: "", dismantle: "" }] }]);
  const removeContainer = ci => setContainers(cs => cs.length > 1 ? cs.filter((_, i) => i !== ci) : cs);
  const addItem = ci => setContainers(cs => cs.map((c, i) => i === ci ? { ...c, items: [...c.items, { id: uid(), name: "", qty: 1, conditions: [], positions: [], packedBy: "", dismantle: "" }] } : c));
  const setItem = (ci, ii, field, v) => setContainers(cs => cs.map((c, i) => i === ci ? { ...c, items: c.items.map((it, j) => j === ii ? { ...it, [field]: v } : it) } : c));
  const addTag = (ci, ii, field, val) => { if (!val) return; setContainers(cs => cs.map((c, i) => i === ci ? { ...c, items: c.items.map((it, j) => j === ii ? { ...it, [field]: Array.from(new Set([...(it[field] || []), val])) } : it) } : c)); };
  const removeTag = (ci, ii, field, val) => setContainers(cs => cs.map((c, i) => i === ci ? { ...c, items: c.items.map((it, j) => j === ii ? { ...it, [field]: (it[field] || []).filter(x => x !== val) } : it) } : c));
  const removeItem = (ci, ii) => setContainers(cs => cs.map((c, i) => i === ci ? { ...c, items: c.items.filter((_, j) => j !== ii) } : c));
  const toggleCrew = name => setCrew(cr => cr.includes(name) ? cr.filter(z => z !== name) : [...cr, name]);
  const addCond = () => { const v = newCond.trim(); if (!v || conds.includes(v)) { setNewCond(""); return; } const nx = [...conds, v]; setConds(nx); saveConditions(nx); setNewCond(""); };
  const addPos = () => { const v = newPos.trim(); if (!v || poss.includes(v)) { setNewPos(""); return; } const nx = [...poss, v]; setPoss(nx); savePositions(nx); setNewPos(""); };

  const inp = { width: "100%", padding: "9px 10px", border: "1px solid #D9E2E0", borderRadius: 9, fontSize: 14, boxSizing: "border-box", background: "#fff" };

  async function makeIntakePdf() {
    setErr("");
    if (!customerId) { setErr("Please select a customer."); return; }
    const cust = (data.customers || []).find(x => x.id === customerId);
    if (!cust) { setErr("Customer not found."); return; }
    const cleanContainers = containers.map(c => ({ number: c.number, items: (c.items || []).filter(it => (it.name || "").trim()).map(it => ({ name: it.name.trim(), qty: Number(it.qty) || 1, conditions: it.conditions || [], positions: it.positions || [], packedBy: it.packedBy || "", dismantle: it.dismantle || "" })) })).filter(c => (c.number || "").trim() || c.items.length);
    if (!cleanContainers.length) { setErr("Add at least one container with items first."); return; }
    const cleanLoose = looseList.map(li => ({ name: (li.name || "").trim(), qty: Math.max(1, Number(li.qty) || 1) })).filter(li => li.name);
    const rec = { id: editRec ? editRec.id : "preview", jobId, date, location, crew, containers: cleanContainers, custSig, empSig, empName, looseList: cleanLoose, looseItems: cleanLoose.length > 0 };
    setBusy("pdf");
    try {
      const { bytes } = await buildStorageIntakePdf(rec, cust, data);
      const file = new File([bytes], `Storage-${cust.ref || "RJ"}-${date}.pdf`, { type: "application/pdf" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file] }); } catch (_e) {} }
      else { const url = URL.createObjectURL(file); const a = document.createElement("a"); a.href = url; a.download = file.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000); }
    } catch (ex) { setErr("PDF failed: " + ((ex && ex.message) || ex)); }
    setBusy(false);
  }

  async function saveIntake() {
    setErr("");
    if (!customerId) { setErr("Please select a customer."); return; }
    const cust = (data.customers || []).find(x => x.id === customerId);
    if (!cust) { setErr("Customer not found."); return; }
    const cleanContainers = containers.map(c => ({ number: c.number, items: (c.items || []).filter(it => (it.name || "").trim()).map(it => ({ name: it.name.trim(), qty: Number(it.qty) || 1, conditions: it.conditions || [], positions: it.positions || [], packedBy: it.packedBy || "", dismantle: it.dismantle || "" })) })).filter(c => (c.number || "").trim() || c.items.length);
    const cleanLoose = looseList.map(li => ({ name: (li.name || "").trim(), qty: Math.max(1, Number(li.qty) || 1) })).filter(li => li.name);
    if (!cleanContainers.length) { setErr("Add at least one container with items."); return; }
    if (!empName) { setErr("Select who completed the inventory (a crew member)."); return; }
    setBusy("save");
    const rec = { id: editRec ? editRec.id : uid(), jobId: jobId || (editRec && editRec.jobId) || "", date, location, crew, containers: cleanContainers, custSig, empSig, empName, looseList: cleanLoose, looseItems: cleanLoose.length > 0, pdfUrl: (editRec && editRec.pdfUrl) || "", pdf: (editRec && editRec.pdf) || "", createdAt: (editRec && editRec.createdAt) || new Date().toISOString() };
    const list = editRec ? (cust.storageInv || []).map(r => r.id === rec.id ? rec : r) : [...(cust.storageInv || []), rec];
    const updated = { ...cust, storageInv: list };
    clearDraft();
    try { const rj = rec.jobId; sessionStorage.setItem("removals_view", JSON.stringify(rj ? { screen: "storageJob", customerId: cust.id, jobId: rj } : { screen: "customerDetail", id: cust.id })); } catch {}
    await saveAndReload(upsertLocal(data, "customers", updated));
  }

  const Lbl = ({ children }) => <div style={{ fontSize: 13, fontWeight: 600, color: "#374151", margin: "0 0 4px" }}>{children}</div>;

  return (
    <div style={{ maxWidth: 640, margin: "0 auto" }}>
      <button onClick={leave} style={{ display: "inline-flex", alignItems: "center", background: "#EEF3F2", border: "1px solid #DCE5E3", borderRadius: 10, color: NAVY, fontSize: 15.5, fontWeight: 800, cursor: "pointer", padding: "10px 16px", marginBottom: 10 }}>‹ Back</button>
      <h2 style={{ margin: "0 0 14px", fontSize: 20, fontWeight: 800, color: "#10211E" }}>{editRec ? "Edit storage inventory" : "New storage inventory"}</h2>

      <Card>
        <Field label="Customer">
          <select value={customerId} disabled={!!editRec} onChange={e => pickCustomer(e.target.value)} style={{ ...inp, appearance: "none", cursor: editRec ? "default" : "pointer", opacity: editRec ? 0.7 : 1 }}>
            <option value="">Select customer…</option>
            {[...(data.customers || [])].sort((a, b) => (a.name || "").localeCompare(b.name || "")).map(c => <option key={c.id} value={c.id}>{c.ref ? `#${c.ref} ` : ""}{c.name}</option>)}
          </select>
        </Field>
        {prefillMsg && <div style={{ fontSize: 12, color: "#15803D", background: "#F1F9F4", border: "1px solid #BBE6C9", borderRadius: 8, padding: "7px 10px", marginBottom: 10 }}>✓ {prefillMsg}</div>}
        {customerId && (() => {
          const cc = (data.customers || []).find(x => x.id === customerId);
          const cjobs = cc ? getStorageJobs(cc) : [];
          if (!cjobs.length) return <div style={{ fontSize: 12, color: "#B45309", background: "#FFFBF2", border: "1px solid #FBE3B3", borderRadius: 8, padding: "7px 10px", marginBottom: 10 }}>No storage job yet — add one on the customer's page (Edit → Storage jobs). You can still save this inventory and link it later.</div>;
          return <Field label="Storage job"><select value={jobId} onChange={e => setJobId(e.target.value)} style={{ ...inp, appearance: "none", cursor: "pointer" }}>
            <option value="">Select storage job…</option>
            {cjobs.map(j => <option key={j.id} value={j.id}>{(j.location || "Job")}{j.value ? ` · £${Number(j.value).toLocaleString("en-GB")}` : ""}{j.dateOut ? " (out)" : ""}</option>)}
          </select></Field>;
        })()}
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1 }}><Field label="Date"><Input type="date" value={date} onChange={setDate} /></Field></div>
          <div style={{ flex: 1 }}><Field label="Storage location"><Select value={location} onChange={setLocation} options={getStorageLocs()} /></Field></div>
        </div>
        <Field label="Crew"><PickChips options={crewOpts} selectedIds={crew} takenIds={new Set()} onToggle={toggleCrew} empty="No staff — add under Company." /></Field>
      </Card>

      {containers.map((ct, ci) => (
        <Card key={ct.id} style={{ marginTop: 12 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-end", marginBottom: 10 }}>
            <div style={{ flex: 1 }}><Field label={`Container ${ci + 1} — number`}><Input value={ct.number} onChange={v => setContainerNo(ci, v)} placeholder="e.g. C-102" /></Field></div>
            {containers.length > 1 && <button onClick={() => removeContainer(ci)} style={{ background: "none", border: "none", color: "#C0605A", fontSize: 12, fontWeight: 700, cursor: "pointer", paddingBottom: 12 }}>Remove</button>}
          </div>
          <div style={{ fontSize: 11, color: "#94A4A0", fontWeight: 700, padding: "0 2px 6px" }}>Items <span style={{ fontWeight: 500 }}>— type "box", "bag" or "container" (with its colour) to mark who packed it</span></div>
          {ct.items.map((it, ii) => {
            const box = isBoxItem(it.name);
            const selStyle = { ...inp, padding: "9px 6px" };
            return (
              <div key={it.id} style={{ marginBottom: 10, paddingBottom: 10, borderBottom: "1px solid #F0F4F3" }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input value={it.qty} inputMode="numeric" onChange={e => setItem(ci, ii, "qty", e.target.value)} style={{ ...inp, width: 46, textAlign: "center", padding: "9px 2px", flexShrink: 0 }} />
                  <input value={it.name} placeholder="Item (e.g. Blue box, dining table)" onChange={e => setItem(ci, ii, "name", e.target.value)} style={{ ...inp, flex: 1 }} />
                  <button onClick={() => removeItem(ci, ii)} style={{ background: "none", border: "none", color: "#C0605A", fontSize: 20, cursor: "pointer", padding: "0 2px", flexShrink: 0 }}>×</button>
                </div>
                <div style={{ marginTop: 6 }}>
                  {box ? (
                    <select value={it.packedBy} onChange={e => setItem(ci, ii, "packedBy", e.target.value)} style={selStyle}>
                      <option value="">Packed by…</option>
                      <option value="Packed by Customer">Packed by Customer</option>
                      <option value="Packed by Mover">Packed by Mover</option>
                    </select>
                  ) : (
                    <div style={{ display: phone ? "block" : "grid", gridTemplateColumns: phone ? undefined : "1fr 1fr", gap: 8 }}>
                      <div style={{ marginBottom: phone ? 8 : 0 }}>
                        {(it.conditions || []).length > 0 && (
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 5 }}>
                            {it.conditions.map(cd => <span key={cd} onClick={() => removeTag(ci, ii, "conditions", cd)} style={{ fontSize: 12, fontWeight: 700, color: "#8A4B12", background: "#FDEBD3", border: "1px solid #F5D6A8", borderRadius: 999, padding: "3px 9px", cursor: "pointer" }}>{cd} ✕</span>)}
                          </div>
                        )}
                        <select value="" onChange={e => { addTag(ci, ii, "conditions", e.target.value); e.target.value = ""; }} style={selStyle}>
                          <option value="">+ Condition…</option>
                          {conds.filter(c => !(it.conditions || []).includes(c)).map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </div>
                      <div>
                        {(it.positions || []).length > 0 && (
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 5 }}>
                            {it.positions.map(ps => <span key={ps} onClick={() => removeTag(ci, ii, "positions", ps)} style={{ fontSize: 12, fontWeight: 700, color: "#374151", background: "#EEF2F1", border: "1px solid #DCE5E3", borderRadius: 999, padding: "3px 9px", cursor: "pointer" }}>{ps} ✕</span>)}
                          </div>
                        )}
                        <select value="" onChange={e => { addTag(ci, ii, "positions", e.target.value); e.target.value = ""; }} style={selStyle}>
                          <option value="">+ Position…</option>
                          {poss.filter(p => !(it.positions || []).includes(p)).map(p => <option key={p} value={p}>{p}</option>)}
                        </select>
                      </div>
                      {canDismantle(it.name) && (
                        <div style={{ marginTop: 8, gridColumn: phone ? undefined : "1 / -1" }}>
                          <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13, color: "#374151", cursor: "pointer" }}>
                            <input type="checkbox" checked={!!it.dismantle} onChange={e => setItem(ci, ii, "dismantle", e.target.checked ? "Mover" : "")} style={{ width: 17, height: 17, accentColor: TEAL }} />
                            Dismantle / reassemble
                          </label>
                          {it.dismantle && (
                            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                              {["Mover", "Customer"].map(who => (
                                <button key={who} onClick={() => setItem(ci, ii, "dismantle", who)} style={{ flex: 1, padding: "6px 0", borderRadius: 8, border: `1px solid ${it.dismantle === who ? TEAL : "#D9E2E0"}`, background: it.dismantle === who ? "#E8F5F3" : "#fff", color: it.dismantle === who ? TEAL_D : "#6A7B77", fontWeight: 700, fontSize: 12.5, cursor: "pointer" }}>By {who}</button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          <button onClick={() => addItem(ci)} style={{ background: "none", border: "1px dashed #CDE7E2", color: TEAL, fontWeight: 700, fontSize: 13, borderRadius: 9, padding: "8px 0", width: "100%", cursor: "pointer", marginTop: 4 }}>+ Add item</button>
        </Card>
      ))}

      <Btn variant="grey" style={{ width: "100%", marginTop: 12 }} onClick={addContainer}>+ Add container</Btn>

      <Card style={{ marginTop: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".06em", color: "#94A4A0", marginBottom: 4 }}>Loose items</div>
        <div style={{ fontSize: 12, color: "#9CA3AF", marginBottom: 8 }}>Items not in a container — add each so they can be collected individually later.</div>
        {looseList.map(li => (
          <div key={li.id} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
            <div style={{ width: 58 }}><input type="number" inputMode="numeric" value={li.qty} onChange={e => setLoose(li.id, "qty", Math.max(1, parseInt(e.target.value, 10) || 1))} style={{ ...inp, textAlign: "center", padding: "9px 4px" }} /></div>
            <div style={{ flex: 1 }}><input value={li.name} placeholder="e.g. Bike, sofa, bench" onChange={e => setLoose(li.id, "name", e.target.value)} style={inp} /></div>
            <button onClick={() => removeLoose(li.id)} style={{ background: "none", border: "none", color: "#C0605A", fontSize: 18, fontWeight: 700, cursor: "pointer", lineHeight: 1 }}>×</button>
          </div>
        ))}
        <Btn size="sm" variant="grey" onClick={addLoose}>+ Add loose item</Btn>
      </Card>

      <Card style={{ marginTop: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".06em", color: "#94A4A0", marginBottom: 8 }}>Add a condition option</div>
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ flex: 1 }}><input value={newCond} placeholder="e.g. Faded" onChange={e => setNewCond(e.target.value)} style={inp} /></div>
          <Btn size="sm" onClick={addCond} disabled={!newCond.trim()}>Add</Btn>
        </div>
        <div style={{ fontSize: 12, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".06em", color: "#94A4A0", margin: "14px 0 8px" }}>Add a position option</div>
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ flex: 1 }}><input value={newPos} placeholder="e.g. Underside" onChange={e => setNewPos(e.target.value)} style={inp} /></div>
          <Btn size="sm" onClick={addPos} disabled={!newPos.trim()}>Add</Btn>
        </div>
      </Card>

      <Card style={{ marginTop: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".06em", color: "#94A4A0", marginBottom: 10 }}>Sign off</div>
        <SigField label="Customer signature" value={custSig} onOpen={() => setSigning("cust")} />
        <Field label="Completed by (crew member)">
          <select value={empName} onChange={e => setEmpName(e.target.value)} style={{ ...inp, appearance: "none", cursor: "pointer" }}>
            <option value="">{crew.length ? "Select crew member…" : "Select crew above first"}</option>
            {crew.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </Field>
        <SigField label="Employee signature" value={empSig} onOpen={() => setSigning("emp")} />
      </Card>

      {signing === "cust" && <SignatureModal title="Customer signature" initial={custSig} onCancel={() => setSigning(null)} onAccept={v => { setCustSig(v); setSigning(null); }} />}
      {signing === "emp" && <SignatureModal title={`Employee signature${empName ? " — " + empName : ""}`} initial={empSig} onCancel={() => setSigning(null)} onAccept={v => { setEmpSig(v); setSigning(null); }} />}

      {err && <div style={{ marginTop: 12, fontSize: 12.5, color: "#B91C1C", background: "#FEF2F2", borderRadius: 8, padding: "8px 11px" }}>{err}</div>}
      <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
        <Btn variant="grey" onClick={leave}>Cancel</Btn>
        <Btn variant="grey" disabled={busy} onClick={makeIntakePdf}>{busy === "pdf" ? "…" : "PDF"}</Btn>
        <Btn style={{ flex: 1 }} disabled={busy} onClick={saveIntake}>{busy === "save" ? "Saving…" : "Save inventory"}</Btn>
      </div>
    </div>
  );
}

async function buildCollectionPdf(collection, rec, c, data, allColl) {
  const { PDFDocument, StandardFonts, rgb } = await loadPdfLib();
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = 595.28, H = 841.89, M = 44;
  const teal = rgb(0.055, 0.486, 0.451), navy = rgb(0.059, 0.18, 0.165), grey = rgb(0.42, 0.46, 0.45), amber = rgb(0.62, 0.29, 0.03), white = rgb(1, 1, 1);
  const clean = s => String(s == null ? "" : s).replace(/[\u2018\u2019\u201A\u2032]/g, "'").replace(/[\u201C\u201D\u201E\u2033]/g, '"').replace(/[\u2013\u2014\u2212]/g, "-").replace(/\u2026/g, "...").replace(/\u00A0/g, " ").replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, "");
  let page = pdf.addPage([W, H]); let y = H - M;
  const at = (t, x, yy, size, f = font, col = navy) => page.drawText(clean(t), { x, y: yy, size, font: f, color: col });
  const newPageIf = need => { if (y < M + need) { page = pdf.addPage([W, H]); y = H - M; } };
  const embedSig = async url => { if (!url || url.indexOf("data:image") !== 0) return null; try { const b64 = url.split(",")[1]; const bin = atob(b64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); return await pdf.embedPng(bytes); } catch { return null; } };
  const allC = allColl || (rec.collections || []);

  page.drawRectangle({ x: 0, y: H - 66, width: W, height: 66, color: teal });
  at("R&J Removals & Storage", M, H - 34, 16, bold, white);
  at("Storage - Items Collected by Customer", M, H - 51, 11, font, rgb(0.88, 0.96, 0.94));
  const ref = c?.ref ? `Ref ${c.ref}` : "";
  if (ref) { const w = bold.widthOfTextAtSize(ref, 12); at(ref, W - M - w, H - 40, 12, bold, white); }
  y = H - 92;
  const kv = (label, value) => { at(label, M, y, 9.5, bold, grey); at(value || "-", M + 110, y, 9.5, font, navy); y -= 16; };
  kv("Customer", c?.name || "-");
  kv("Collection date", collection.date ? fmtUK(collection.date) : "-");
  if (collection.collectedBy) kv("Collected by", collection.collectedBy);
  kv("From inventory", rec.date ? fmtUK(rec.date) + (rec.location ? " - " + rec.location : "") : (rec.location || "-"));
  y -= 4;

  // Collected totals + latest date per item across all collections up to now
  const collectedInfo = (containerNo, name) => {
    let qty = 0, last = "";
    allC.forEach(col => (col.items || []).forEach(ci => { if (ci.container === containerNo && ci.name === name) { qty += Number(ci.qty) || 0; if (!last || (col.date || "") > last) last = col.date || ""; } }));
    return { qty, last };
  };

  at("Storage inventory", M, y, 12, bold, teal); y -= 7; page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1, color: teal }); y -= 16;
  (rec.containers || []).forEach(ct => {
    newPageIf(40);
    at(`Container ${ct.number || "-"}`, M, y, 10, bold, navy); y -= 15;
    (ct.items || []).forEach(it => {
      newPageIf(16);
      const info = collectedInfo(ct.number || "", it.name);
      const full = info.qty >= (Number(it.qty) || 0) && info.qty > 0;
      const label = `${it.qty} x ${clean(it.name)}`;
      const col = full ? grey : navy;
      at(label, M + 10, y, 9.5, font, col);
      if (full) { const w = font.widthOfTextAtSize(label, 9.5); page.drawLine({ start: { x: M + 10, y: y + 3 }, end: { x: M + 10 + w, y: y + 3 }, thickness: 0.8, color: amber }); }
      if (info.qty > 0) { const note = full ? `collected ${info.last ? fmtUK(info.last) : ""}` : `${info.qty} of ${it.qty} collected ${info.last ? fmtUK(info.last) : ""}`; const w = font.widthOfTextAtSize(note, 8.5); at(note, W - M - w, y, 8.5, font, amber); }
      y -= 14;
    });
    y -= 6;
  });

  y -= 4; newPageIf(60);
  at("Collected this visit", M, y, 12, bold, teal); y -= 7; page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1, color: teal }); y -= 16;
  at((collection.date ? fmtUK(collection.date) : "") + (collection.collectedBy ? ` - by ${clean(collection.collectedBy)}` : ""), M, y, 9, bold, navy); y -= 14;
  (collection.items || []).forEach(it => {
    newPageIf(14);
    at(`${it.qty} x ${clean(it.name)}`, M + 10, y, 9.5, font, navy);
    if (it.container) { const t = `Container ${it.container}`; const w = font.widthOfTextAtSize(t, 9); at(t, W - M - w, y, 9, font, grey); }
    y -= 14;
  });
  if ((collection.looseItems || []).length) { newPageIf(14); at("Loose items:", M + 10, y, 9.5, bold, navy); y -= 13; (collection.looseItems || []).forEach(li => { newPageIf(12); at(`${li.qty} x ${clean(li.name)}`, M + 20, y, 9.5, font, navy); y -= 13; }); }

  // Previous collections (everything before this visit)
  const prev = allC.filter(col => col.id !== collection.id).slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  if (prev.length) {
    y -= 8; newPageIf(50);
    at("Previous collections", M, y, 12, bold, teal); y -= 7; page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1, color: teal }); y -= 16;
    prev.forEach(col => {
      newPageIf(24);
      at(`${col.date ? fmtUK(col.date) : ""}${col.collectedBy ? ` - by ${clean(col.collectedBy)}` : ""}`, M, y, 9, bold, navy); y -= 13;
      (col.items || []).forEach(it => { newPageIf(12); at(`${it.qty} x ${clean(it.name)}${it.container ? ` (Container ${it.container})` : ""}`, M + 10, y, 8.5, font, grey); y -= 12; });
      if ((col.looseItems || []).length) { newPageIf(12); at(`Loose: ${(col.looseItems || []).map(li => `${li.qty}x ${clean(li.name)}`).join(", ")}`, M + 10, y, 8.5, font, grey); y -= 12; }
      y -= 4;
    });
  }

  // What remains in store now (original minus everything collected)
  const remainByCont = [];
  (rec.containers || []).forEach(ct => {
    const rem = (ct.items || []).map(it => ({ name: it.name, qty: Math.max(0, (Number(it.qty) || 0) - collectedInfo(ct.number || "", it.name).qty) })).filter(it => it.qty > 0);
    if (rem.length) remainByCont.push({ number: ct.number || "", items: rem });
  });
  y -= 8; newPageIf(50);
  at("Left in store", M, y, 12, bold, teal); y -= 7; page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1, color: teal }); y -= 16;
  const looseRem = (Array.isArray(rec.looseList) ? rec.looseList : []).map(li => { const collected = allC.reduce((n, col) => n + (col.looseItems || []).filter(x => x.name === li.name).reduce((m, x) => m + (Number(x.qty) || 0), 0), 0); return { name: li.name, qty: Math.max(0, (Number(li.qty) || 0) - collected) }; }).filter(li => li.qty > 0);
  if (!remainByCont.length && !looseRem.length) { at("Nothing remaining - all items collected.", M + 10, y, 9.5, font, navy); y -= 14; }
  remainByCont.forEach(ct => {
    newPageIf(28);
    at(`Container ${ct.number || "-"}`, M, y, 10, bold, navy); y -= 14;
    ct.items.forEach(it => { newPageIf(12); at(`${it.qty} x ${clean(it.name)}`, M + 10, y, 9.5, font, navy); y -= 13; });
    y -= 5;
  });
  if (looseRem.length) { newPageIf(16 + looseRem.length * 13); at("Loose items", M, y, 10, bold, navy); y -= 14; looseRem.forEach(li => { newPageIf(12); at(`${li.qty} x ${clean(li.name)}`, M + 10, y, 9.5, font, navy); y -= 13; }); }

  y -= 16; newPageIf(120);
  at("Received the above items in good order.", M, y, 9, font, grey); y -= 26;
  const img = await embedSig(collection.sig);
  const boxW = 260, boxH = 70;
  page.drawRectangle({ x: M, y: y - boxH, width: boxW, height: boxH, borderColor: grey, borderWidth: 0.7, color: white });
  if (img) { const s = Math.min(boxW - 16, (boxH - 26) * (img.width / img.height)); page.drawImage(img, { x: M + (boxW - s) / 2, y: y - boxH + 22, width: s, height: Math.min(s * (img.height / img.width), boxH - 26) }); }
  at(collection.collectedBy ? `Signature - ${clean(collection.collectedBy)}` : "Customer signature", M + 4, y - boxH + 8, 8, bold, grey);
  y -= boxH + 16;
  at(`Generated ${fmtUK(todayISO())} - R&J Removals & Storage`, M, y, 8, font, grey);

  return await pdf.save();
}

function PartCollectionForm({ data, setView, recId }) {
  const cust = (data.customers || []).find(c => (c.storageInv || []).some(r => r.id === recId));
  const rec = cust ? (cust.storageInv || []).find(r => r.id === recId) : null;
  const [date, setDate] = useState(todayISO());
  const [collectedBy, setCollectedBy] = useState("");
  const [taking, setTaking] = useState({});
  const [sig, setSig] = useState("");
  const [signing, setSigning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (!rec) return <div style={{ padding: 20 }}>Storage sheet not found.</div>;
  const inp = { width: "100%", padding: "9px 10px", border: "1px solid #D9E2E0", borderRadius: 9, fontSize: 14, boxSizing: "border-box", background: "#fff" };
  const setTake = (k, val, max) => setTaking(p => ({ ...p, [k]: Math.max(0, Math.min(Number(max) || 0, Math.floor(Number(val) || 0))) }));
  const totalTaking = Object.values(taking).reduce((a, b) => a + (Number(b) || 0), 0);
  const looseList = Array.isArray(rec.looseList) ? rec.looseList : [];
  // How many of an item are still in store = original qty minus everything already collected.
  const collectedQty = (containerNo, name) => (rec.collections || []).reduce((n, col) => n + (col.items || []).filter(ci => ci.container === containerNo && ci.name === name).reduce((m, ci) => m + (Number(ci.qty) || 0), 0), 0);
  const available = (containerNo, it) => Math.max(0, (Number(it.qty) || 0) - collectedQty(containerNo, it.name));
  const collectedLooseQty = name => (rec.collections || []).reduce((n, col) => n + (col.looseItems || []).filter(li => li.name === name).reduce((m, li) => m + (Number(li.qty) || 0), 0), 0);
  const looseAvailable = li => Math.max(0, (Number(li.qty) || 0) - collectedLooseQty(li.name));

  async function save() {
    setErr("");
    const looseItemsTaken = [];
    looseList.forEach((li, i) => { const take = Number(taking["loose_" + i]) || 0; if (take > 0) looseItemsTaken.push({ name: li.name, qty: take }); });
    if (totalTaking <= 0 && !looseItemsTaken.length) { setErr("Enter a quantity for at least one item being collected."); return; }
    if (!sig) { setErr("Please capture the customer's signature."); return; }
    const collItems = [];
    (rec.containers || []).forEach((c, ci) => (c.items || []).forEach((it, ii) => {
      const take = Number(taking[ci + "_" + ii]) || 0;
      if (take > 0) collItems.push({ container: c.number || "", name: it.name, qty: take });
    }));
    const collection = { id: uid(), date, sig, items: collItems, looseItems: looseItemsTaken, collectedBy: collectedBy.trim() };
    const allColl = [...(rec.collections || []), collection];
    // Decide about closing the job NOW — before any async work. On iOS the share sheet/upload
    // break the user-gesture chain, so a confirm() afterwards can fail to show and hang the save.
    const collForItem = (containerNo, name) => allColl.reduce((n, col) => n + (col.items || []).filter(ci => ci.container === containerNo && ci.name === name).reduce((m, ci) => m + (Number(ci.qty) || 0), 0), 0);
    let remaining = 0;
    (rec.containers || []).forEach(cc => (cc.items || []).forEach(it => { remaining += Math.max(0, (Number(it.qty) || 0) - collForItem(cc.number || "", it.name)); }));
    (Array.isArray(rec.looseList) ? rec.looseList : []).forEach(li => { const col = allColl.reduce((n, c) => n + (c.looseItems || []).filter(x => x.name === li.name).reduce((m, x) => m + (Number(x.qty) || 0), 0), 0); remaining += Math.max(0, (Number(li.qty) || 0) - col); });
    const markOut = (remaining === 0 && rec.jobId) ? confirm("Nothing left in store for this inventory. Mark the storage job out of store?") : false;
    setBusy(true);
    // Separate signed receipt for this collection — the original inventory sheet is left untouched.
    let bytes;
    try {
      bytes = await buildCollectionPdf(collection, rec, cust, data, allColl);
      const file = new File([bytes], `Collection-${cust.ref || "RJ"}-${date}.pdf`, { type: "application/pdf" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file] }); } catch (_e) {} }
      else { const url = URL.createObjectURL(file); const a = document.createElement("a"); a.href = url; a.download = file.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000); }
    } catch (ex) { setErr("PDF failed: " + ((ex && ex.message) || ex)); setBusy(false); return; }
    try { collection.pdfUrl = await uploadStorageSheet(`${cust.id}/collection-${collection.id}.pdf`, bytes); }
    catch { try { let bin = ""; const b = new Uint8Array(bytes); for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]); collection.pdf = "data:application/pdf;base64," + btoa(bin); } catch {} }
    const newRec = { ...rec, collections: allColl };
    const list = (cust.storageInv || []).map(r => r.id === rec.id ? newRec : r);
    const updated = { ...cust, storageInv: list };
    if (markOut) {
      updated.storageJobs = getStorageJobs(cust).map(j => j.id === rec.jobId ? { ...j, dateOut: date, inStore: false } : j);
      updated.storage = null;
    }
    await saveAndReload(upsertLocal(data, "customers", updated));
  }

  return (
    <div style={{ maxWidth: 640, margin: "0 auto" }}>
      <button onClick={() => setView({ screen: "customerDetail", id: cust.id })} style={{ display: "inline-flex", alignItems: "center", background: "#EEF3F2", border: "1px solid #DCE5E3", borderRadius: 10, color: NAVY, fontSize: 15.5, fontWeight: 800, cursor: "pointer", padding: "10px 16px", marginBottom: 10 }}>‹ Back</button>
      <h2 style={{ margin: "0 0 2px", fontSize: 20, fontWeight: 800, color: "#10211E" }}>Items collected by customer</h2>
      <div style={{ fontSize: 13, color: "#6A7B77", marginBottom: 14 }}>{cust.name} · sheet {rec.date ? fmtUK(rec.date) : ""}</div>

      <Card>
        <Field label="Collection date"><Input type="date" value={date} onChange={setDate} /></Field>
        <Field label="Collected by" hint={`Leave blank if collected by ${cust.name}`}><Input value={collectedBy} onChange={setCollectedBy} placeholder={cust.name} /></Field>
      </Card>

      {(rec.containers || []).map((c, ci) => (
        <Card key={ci} style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 800, color: "#10211E", marginBottom: 8 }}>Container {c.number || "—"}</div>
          {(c.items || []).length === 0 && <div style={{ fontSize: 13, color: "#9CA3AF" }}>Empty</div>}
          {(c.items || []).map((it, ii) => {
            const k = ci + "_" + ii; const max = available(c.number || "", it);
            return (
              <div key={ii} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "7px 0", borderBottom: "1px solid #F0F4F3", opacity: max === 0 ? 0.5 : 1 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, color: "#10211E" }}>{it.name}</div>
                  <div style={{ fontSize: 12, color: "#94A4A0" }}>{max} in store{max !== (Number(it.qty) || 0) ? ` (of ${Number(it.qty) || 0})` : ""}</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                  <span style={{ fontSize: 12, color: "#6A7B77" }}>take</span>
                  <input type="number" inputMode="numeric" disabled={max === 0} value={taking[k] || ""} placeholder="0" onChange={e => setTake(k, e.target.value, max)} style={{ ...inp, width: 64, textAlign: "center", padding: "8px 4px" }} />
                </div>
              </div>
            );
          })}
        </Card>
      ))}

      {looseList.length > 0 && (
        <Card style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 800, color: "#10211E", marginBottom: 8 }}>Loose items</div>
          {looseList.map((li, i) => {
            const k = "loose_" + i; const max = looseAvailable(li);
            return (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "7px 0", borderBottom: "1px solid #F0F4F3", opacity: max === 0 ? 0.5 : 1 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, color: "#10211E" }}>{li.name}</div>
                  <div style={{ fontSize: 12, color: "#94A4A0" }}>{max} in store{max !== (Number(li.qty) || 0) ? ` (of ${Number(li.qty) || 0})` : ""}</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                  <span style={{ fontSize: 12, color: "#6A7B77" }}>take</span>
                  <input type="number" inputMode="numeric" disabled={max === 0} value={taking[k] || ""} placeholder="0" onChange={e => setTake(k, e.target.value, max)} style={{ ...inp, width: 64, textAlign: "center", padding: "8px 4px" }} />
                </div>
              </div>
            );
          })}
        </Card>
      )}

      <Card style={{ marginTop: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".06em", color: "#94A4A0", marginBottom: 10 }}>Customer sign-off</div>
        <div style={{ fontSize: 12.5, color: "#6A7B77", marginBottom: 8 }}>Taking {totalTaking} item{totalTaking !== 1 ? "s" : ""} today.</div>
        <SigField label={collectedBy.trim() ? `Signature — ${collectedBy.trim()}` : "Customer signature"} value={sig} onOpen={() => setSigning(true)} />
      </Card>

      {err && <div style={{ marginTop: 12, fontSize: 12.5, color: "#B91C1C", background: "#FEF2F2", borderRadius: 8, padding: "8px 11px" }}>{err}</div>}
      <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
        <Btn variant="grey" onClick={() => setView({ screen: "customerDetail", id: cust.id })}>Cancel</Btn>
        <Btn style={{ flex: 1 }} disabled={busy} onClick={save}>{busy ? "Saving…" : "Confirm collection"}</Btn>
      </div>

      {signing && <SignatureModal title="Customer signature" initial={sig} onCancel={() => setSigning(false)} onAccept={v => { setSig(v); setSigning(false); }} />}
    </div>
  );
}

function StorageJobForm({ data, customer, job, onClose }) {
  const isNew = !job;
  const [f, setF] = useState(() => job
    ? { id: job.id, location: job.location || (getStorageLocs()[0] || "Wild & Lye"), value: job.value ?? "", dateIn: job.dateIn || "", dateOut: job.dateOut || "" }
    : { id: uid(), location: getStorageLocs()[0] || "Wild & Lye", value: "", dateIn: todayISO(), dateOut: "" });
  const [locs, setLocs] = useState(getStorageLocs);
  const [newLoc, setNewLoc] = useState("");
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const addLoc = () => { const v = newLoc.trim(); if (!v || locs.includes(v)) { setNewLoc(""); return; } const nx = [...locs, v]; setLocs(nx); saveStorageLocs(nx); set("location", v); setNewLoc(""); };

  async function save() {
    const jrec = { id: f.id, location: f.location || "", value: Number(f.value) || 0, dateIn: f.dateIn || "", dateOut: f.dateOut || "", inStore: !f.dateOut };
    const existing = getStorageJobs(customer).map(j => ({ ...j, id: j.id === "legacy" ? uid() : j.id }));
    const jobs = existing.some(j => j.id === jrec.id) ? existing.map(j => j.id === jrec.id ? jrec : j) : [...existing, jrec];
    await saveAndReload(upsertLocal(data, "customers", { ...customer, storageJobs: jobs, storage: null }));
  }
  async function del() {
    if (!confirm("Delete this storage job? (Inventory sheets are kept.)")) return;
    const jobs = getStorageJobs(customer).filter(j => j.id !== f.id).map(j => ({ ...j, id: j.id === "legacy" ? uid() : j.id }));
    await saveAndReload(upsertLocal(data, "customers", { ...customer, storageJobs: jobs, storage: null }));
  }

  return (
    <Modal title={isNew ? "Add storage job" : "Edit storage job"} onClose={onClose}>
      <Field label="Location of storage"><Select value={f.location} onChange={v => set("location", v)} options={locs} /></Field>
      <div style={{ display: "flex", gap: 8, margin: "0 0 10px", alignItems: "flex-end" }}>
        <div style={{ flex: 1 }}><Input value={newLoc} onChange={setNewLoc} placeholder="Add a storage location…" /></div>
        <Btn size="sm" onClick={addLoc} disabled={!newLoc.trim()}>Add location</Btn>
      </div>
      <Field label="Storage value (£)"><Input type="number" inputMode="decimal" value={f.value} onChange={v => set("value", v)} /></Field>
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}><Field label="Date into store"><Input type="date" value={f.dateIn} onChange={v => set("dateIn", v)} /></Field></div>
        <div style={{ flex: 1 }}><Field label="Date out" hint="Blank while in store"><Input type="date" value={f.dateOut} onChange={v => set("dateOut", v)} /></Field></div>
      </div>
      <div style={{ fontSize: 12, color: "#9CA3AF", margin: "0 0 10px" }}>Container count and loose items are worked out automatically from this job's inventory sheets.</div>
      <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
        {!isNew && <Btn variant="danger" onClick={del}><Icon name="trash" size={14} /></Btn>}
        <Btn variant="grey" style={{ flex: 1 }} onClick={onClose}>Cancel</Btn>
        <Btn style={{ flex: 2 }} onClick={save}>{isNew ? "Add job" : "Save"}</Btn>
      </div>
    </Modal>
  );
}

function StorageJobDetail({ data, setView, customerId, jobId }) {
  const c = (data.customers || []).find(x => x.id === customerId);
  const [sheetBusy, setSheetBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  if (!c) return <div style={{ padding: 20 }}>Customer not found.</div>;
  const jobs = getStorageJobs(c);
  const job = jobs.find(j => j.id === jobId) || jobs[0];
  const isFirst = jobs[0] && job && jobs[0].id === job.id;
  const sheets = (c.storageInv || []).filter(s => (job && s.jobId === job.id) || (!s.jobId && isFirst));
  const money = n => `£${Number(n || 0).toLocaleString("en-GB")}`;
  const openUrl = url => { const a = document.createElement("a"); a.href = url; a.target = "_blank"; a.rel = "noopener"; document.body.appendChild(a); a.click(); a.remove(); };
  async function openSheet(rec) {
    if (sheetBusy) return;
    if (rec.pdfUrl) { openUrl(rec.pdfUrl); return; }
    if (rec.pdf) { try { const b = atob(rec.pdf.split(",")[1]); const arr = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) arr[i] = b.charCodeAt(i); const url = URL.createObjectURL(new Blob([arr], { type: "application/pdf" })); openUrl(url); setTimeout(() => URL.revokeObjectURL(url), 8000); return; } catch {} }
    setSheetBusy(true);
    try { const { bytes } = await buildStorageIntakePdf(rec, c, data); const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" })); openUrl(url); setTimeout(() => URL.revokeObjectURL(url), 8000); } catch (ex) { alert("Could not open sheet: " + ((ex && ex.message) || ex)); }
    setSheetBusy(false);
  }
  const openCollection = col => { if (col.pdfUrl) { openUrl(col.pdfUrl); return; } if (col.pdf) { try { const b = atob(col.pdf.split(",")[1]); const arr = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) arr[i] = b.charCodeAt(i); const url = URL.createObjectURL(new Blob([arr], { type: "application/pdf" })); openUrl(url); setTimeout(() => URL.revokeObjectURL(url), 8000); } catch {} } };

  return (
    <div style={{ maxWidth: 640, margin: "0 auto" }}>
      <button onClick={() => setView({ screen: "storage" })} style={{ display: "inline-flex", alignItems: "center", background: "#EEF3F2", border: "1px solid #DCE5E3", borderRadius: 10, color: NAVY, fontSize: 15.5, fontWeight: 800, cursor: "pointer", padding: "10px 16px", marginBottom: 10 }}>‹ Storage</button>
      <h2 style={{ margin: "0 0 2px", fontSize: 20, fontWeight: 800, color: "#10211E" }}>{job ? (job.location || "Storage job") : "Storage job"}</h2>
      <div style={{ fontSize: 13, color: "#6A7B77", marginBottom: 14 }} onClick={() => setView({ screen: "customerDetail", id: c.id })}>{c.ref ? `#${c.ref} · ` : ""}<span style={{ color: TEAL, fontWeight: 700 }}>{c.name}</span></div>

      {job && (
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <div style={{ fontWeight: 800, color: "#10211E" }}>{job.value ? money(job.value) : "No value set"}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span onClick={() => setEditing(true)} style={{ color: TEAL, fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>Edit</span>
              <span style={{ fontSize: 11.5, fontWeight: 800, color: jobInStore(job) ? "#0F766E" : "#9CA3AF", background: jobInStore(job) ? "#E8F5F3" : "#F1F3F2", borderRadius: 999, padding: "2px 9px" }}>{jobInStore(job) ? "In store" : "Out"}</span>
            </div>
          </div>
          <div style={{ fontSize: 12.5, color: "#6A7B77" }}>
            {job.dateIn ? `In ${fmtUK(job.dateIn)}` : ""}{job.dateOut ? ` · Out ${fmtUK(job.dateOut)}` : ""}{jobContainerCount(c, job) ? ` · ${jobContainerCount(c, job)} container${jobContainerCount(c, job) != 1 ? "s" : ""}` : ""}{jobContainerNos(c, job).length ? ` (${jobContainerNos(c, job).join(", ")})` : ""}
          </div>
          {jobLoose(c, job).any && <div style={{ fontSize: 12.5, color: "#6A7B77" }}>Loose: {jobLoose(c, job).notes.join("; ") || "Yes"}</div>}
          <div style={{ marginTop: 10 }}>
            {jobInStore(job)
              ? <Btn size="sm" variant="grey" onClick={async () => { if (!confirm("Mark this storage job out of store (today)?")) return; const jobs = getStorageJobs(c).map(j => j.id === job.id ? { ...j, dateOut: todayISO(), inStore: false } : j); await saveAndReload(upsertLocal(data, "customers", { ...c, storageJobs: jobs, storage: null })); }}>Mark out of store</Btn>
              : <Btn size="sm" variant="grey" onClick={async () => { const jobs = getStorageJobs(c).map(j => j.id === job.id ? { ...j, dateOut: "", inStore: true } : j); await saveAndReload(upsertLocal(data, "customers", { ...c, storageJobs: jobs, storage: null })); }}>Mark back in store</Btn>}
          </div>
        </Card>
      )}
      {editing && job && <StorageJobForm data={data} customer={c} job={job} onClose={() => setEditing(false)} />}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "16px 0 8px" }}>
        <div style={{ fontSize: 12, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".06em", color: "#94A4A0" }}>Inventory sheets</div>
        <Btn size="sm" onClick={() => setView({ screen: "storageIntake", customerId: c.id, jobId: job ? job.id : undefined })}>+ New inventory</Btn>
      </div>
      {sheets.length === 0 && <Empty icon="box" text="No inventory sheets yet" />}
      {sheets.length > 0 && (
        <Card>
          {sheets.slice().reverse().map(rec => (
            <div key={rec.id} style={{ borderBottom: "1px solid #EEF3F2", padding: "4px 0" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 4px", gap: 10 }}>
                <div onClick={() => openSheet(rec)} style={{ minWidth: 0, cursor: "pointer", flex: 1 }}>
                  <div style={{ fontWeight: 700, color: "#10211E", fontSize: 14 }}>{rec.date ? fmtUK(rec.date) : "—"}</div>
                  <div style={{ fontSize: 12.5, color: "#6A7B77" }}>{(rec.containers || []).length} container{(rec.containers || []).length !== 1 ? "s" : ""}{rec.empName ? ` · ${rec.empName}` : ""}</div>
                </div>
                <div style={{ display: "flex", gap: 12, flexShrink: 0 }}>
                  <span onClick={() => setView({ screen: "storageCollect", recId: rec.id })} style={{ color: "#B45309", fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>Collect</span>
                  <span onClick={() => setView({ screen: "storageIntake", editRecId: rec.id })} style={{ color: TEAL, fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>Edit</span>
                  <span onClick={() => openSheet(rec)} style={{ color: TEAL, fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>{sheetBusy ? "…" : "PDF"}</span>
                </div>
              </div>
              {(rec.collections || []).length > 0 && (
                <div style={{ margin: "2px 4px 8px", padding: "8px 10px", background: "#FFFBF2", border: "1px solid #FBE3B3", borderRadius: 8 }}>
                  <div style={{ fontSize: 10.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".05em", color: "#B45309", marginBottom: 5 }}>Items collected</div>
                  {rec.collections.slice().reverse().map(col => (
                    <div key={col.id} style={{ marginBottom: 6, display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 700, color: "#8A4B12" }}>{col.date ? fmtUK(col.date) : "—"} ({dow(col.date)}){col.collectedBy ? ` · ${col.collectedBy}` : ""}{col.sig ? " · signed" : ""}</div>
                        <div style={{ fontSize: 12.5, color: "#6A7B77" }}>{[(col.items || []).map(ci => `${ci.qty}× ${ci.name}`).join(", "), (col.looseItems || []).length ? `loose: ${(col.looseItems || []).map(li => `${li.qty}× ${li.name}`).join(", ")}` : ""].filter(Boolean).join(" · ") || "—"}</div>
                      </div>
                      {(col.pdfUrl || col.pdf) && <span onClick={() => openCollection(col)} style={{ color: TEAL, fontSize: 12, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>Receipt</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

function StorageView({ data, setView }) {
  const money = n => `£${Number(n || 0).toLocaleString("en-GB", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
  // Every in-store storage job across all customers (a customer can have several).
  const jobsList = [];
  (data.customers || []).forEach(c => getStorageJobs(c).forEach(j => { if (jobInStore(j)) jobsList.push({ c, j }); }));

  const groups = {};
  jobsList.forEach(({ c, j }) => { const loc = (j.location || "Unspecified").trim() || "Unspecified"; (groups[loc] = groups[loc] || []).push({ c, j }); });
  const locNames = Object.keys(groups).sort((a, b) => a.localeCompare(b));

  const totJobs = jobsList.length;
  const totContainers = jobsList.reduce((n, { c, j }) => n + jobContainerCount(c, j), 0);
  const totValue = jobsList.reduce((n, { j }) => n + (Number(j.value) || 0), 0);

  const Stat = ({ label, value }) => (
    <div style={{ flex: 1, textAlign: "center" }}>
      <div style={{ fontSize: 22, fontWeight: 800, color: "#10211E" }}>{value}</div>
      <div style={{ fontSize: 11, color: "#94A4A0", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em" }}>{label}</div>
    </div>
  );

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: "#10211E" }}>Storage</h2>
        <Btn size="sm" onClick={() => setView({ screen: "storageIntake" })}><Icon name="plus" size={14} /> New inventory</Btn>
      </div>

      <Card style={{ background: "#F4FBF9", border: "1px solid #CDE7E2" }}>
        <div style={{ display: "flex", gap: 8 }}>
          <Stat label="Jobs in store" value={totJobs} />
          <div style={{ width: 1, background: "#DCEAE7" }} />
          <Stat label="Containers" value={totContainers} />
          <div style={{ width: 1, background: "#DCEAE7" }} />
          <Stat label="Total value" value={money(totValue)} />
        </div>
      </Card>

      {totJobs === 0 && <Empty icon="box" text="No storage jobs in store" />}

      {locNames.map(loc => {
        const list = groups[loc].slice().sort((a, b) => (a.c.name || "").localeCompare(b.c.name || ""));
        const lc = list.reduce((n, { c, j }) => n + jobContainerCount(c, j), 0);
        const lv = list.reduce((n, { j }) => n + (Number(j.value) || 0), 0);
        return (
          <div key={loc} style={{ marginTop: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8, padding: "0 2px" }}>
              <div style={{ fontSize: 16, fontWeight: 800, color: TEAL_D }}>{loc}</div>
              <div style={{ fontSize: 12.5, color: "#6A7B77", fontWeight: 600 }}>{list.length} job{list.length !== 1 ? "s" : ""} · {lc} container{lc !== 1 ? "s" : ""} · {money(lv)}</div>
            </div>
            {list.map(({ c, j }) => (
              <Card key={c.id + (j.id || "")} onClick={() => setView({ screen: "storageJob", customerId: c.id, jobId: j.id })} style={{ marginBottom: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, color: "#10211E" }}>{c.ref ? <span style={{ color: TEAL_D, fontWeight: 800 }}>#{c.ref} </span> : ""}{c.name}</div>
                    <div style={{ fontSize: 12.5, color: "#6A7B77", marginTop: 2 }}>
                      {jobContainerCount(c, j)} container{jobContainerCount(c, j) !== 1 ? "s" : ""}
                      {jobContainerNos(c, j).length ? ` · ${jobContainerNos(c, j).join(", ")}` : ""}
                      {j.dateIn ? ` · in ${fmtUK(j.dateIn)}` : ""}
                      {jobLoose(c, j).any ? " · loose items" : ""}
                    </div>
                  </div>
                  <div style={{ fontWeight: 700, color: "#10211E", flexShrink: 0 }}>{Number(j.value) ? money(j.value) : ""}</div>
                </div>
              </Card>
            ))}
          </div>
        );
      })}
    </div>
  );
}

export default function App() {
  const [data, setData] = useState(loadData);
  const [view, setViewState] = useState(() => {
    try { const v = JSON.parse(sessionStorage.getItem("removals_view")); if (v && v.screen) { if (v.screen === "jobs" || v.screen === "jobDetail") return { screen: "enquiries", filter: "Won" }; return v; } } catch {}
    return { screen: "dashboard" };
  });
  const [syncStatus, setSyncStatus] = useState("syncing");
  const [catalog, setCatalogState] = useState(() => { const l = loadLocalCatalog(); if (l) applyCatalog(l); return l || buildDefaultCatalog(); });
  const device = useDeviceType();
  const wide = device !== "phone";

  // Load the item catalogue (cloud vs local, newest wins) and apply it app-wide.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const remote = await loadCatalog();
        if (cancelled) return;
        const local = loadLocalCatalog();
        const localAt = (local && local.updatedAt) || 0;
        if (remote && remote.value && (remote.updatedAt || 0) >= localAt) {
          const cat = { ...remote.value, updatedAt: remote.updatedAt || 0 };
          applyCatalog(cat); saveLocalCatalog(cat); setCatalogState(cat);
        } else if (local) {
          applyCatalog(local); setCatalogState(local);
          if (!remote && local.items) { try { await saveCatalog({ rooms: local.rooms, items: local.items }, local.updatedAt || Date.now()); } catch {} }
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);

  const applyCatalogEdit = async (nextCat) => {
    const stamped = { rooms: nextCat.rooms, items: nextCat.items, updatedAt: Date.now() };
    applyCatalog(stamped); saveLocalCatalog(stamped); setCatalogState(stamped);
    try { await saveCatalog({ rooms: stamped.rooms, items: stamped.items }, stamped.updatedAt); } catch {}
  };

  useEffect(() => {
    let m = null;
    try { m = sessionStorage.getItem("restoreMsg"); if (m) sessionStorage.removeItem("restoreMsg"); } catch {}
    if (m) setTimeout(() => alert(m), 400);
  }, []);

  useEffect(() => {
    const onBack = () => resetZoom();
    window.addEventListener("focus", onBack);
    window.addEventListener("pageshow", onBack);
    document.addEventListener("visibilitychange", onBack);
    return () => { window.removeEventListener("focus", onBack); window.removeEventListener("pageshow", onBack); document.removeEventListener("visibilitychange", onBack); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cloud = await pullFromCloud();
        if (cancelled) return;
        const merged = autoCompletePastMoves(mergeAll(cloud, loadData()));
        localStorage.setItem(DB_KEY, JSON.stringify(merged));
        setData(merged);
        pushChangedOnly(merged).catch(() => {});
        setSyncStatus("synced");
      } catch { if (!cancelled) setSyncStatus(navigator.onLine === false ? "offline" : "synced"); }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let deb = null;
    const channel = supabase
      .channel("removals-changes")
      .on("postgres_changes", { event: "*", schema: "public" }, (payload) => {
        if (SAVING_IN_PROGRESS) return;
        if (payload?.eventType === "DELETE" && payload?.old?.id) addTombstone(payload.old.id);
        // Coalesce a burst of changes into a single pull.
        if (deb) clearTimeout(deb);
        deb = setTimeout(() => doPullSync(setData, setSyncStatus, { force: true }), 3000);
      })
      .subscribe();
    return () => { if (deb) clearTimeout(deb); supabase.removeChannel(channel); };
  }, []);

  useEffect(() => {
    const syncNow = () => doPullSync(setData, setSyncStatus);
    const onVis = () => { if (document.visibilityState === "visible") syncNow(); };
    window.addEventListener("online", syncNow);
    window.addEventListener("focus", syncNow);
    document.addEventListener("visibilitychange", onVis);
    return () => { window.removeEventListener("online", syncNow); window.removeEventListener("focus", syncNow); document.removeEventListener("visibilitychange", onVis); };
  }, []);

  useEffect(() => {
    const iv = setInterval(() => doPullSync(setData, setSyncStatus), 120000);
    return () => clearInterval(iv);
  }, []);

  const setView = useCallback((v) => { try { sessionStorage.setItem("removals_view", JSON.stringify(v)); } catch {} setViewState(v); setData(loadData()); }, []);

  const NAV = [
    { id: "dashboard", icon: "dashboard", label: "Dashboard", phone: "Home" },
    { id: "enquiries", icon: "enquiries", label: "Enquiries", phone: "Enquiries" },
    { id: "calendar",  icon: "calendar",  label: "Calendar",  phone: "Calendar" },
    { id: "customers", icon: "customers", label: "Customers", phone: "Customers" },
    { id: "storage",   icon: "box",       label: "Storage",   phone: "Storage" },
    { id: "company",   icon: "company",   label: "Company",   phone: "Company" },
  ];
  const sectionKey = sectionFor(view.screen);
  const activeTab = ["dashboard", "calendar", "company", "storage"].includes(view.screen) ? view.screen : (sectionKey || "dashboard");

  const SyncDot = () => (
    <span title={syncStatus} style={{ width: 9, height: 9, borderRadius: "50%", flexShrink: 0,
      background: syncStatus === "synced" ? "#22C55E" : syncStatus === "syncing" ? "#FBBF24" : "#9CA3AF",
      boxShadow: syncStatus === "synced" ? "0 0 0 3px #22C55E22" : "none" }} />
  );

  function fullScreen() {
    if (view.screen === "dashboard") return <Dashboard data={data} setView={setView} setData={setData} />;
    if (view.screen === "calendar") return <CalendarView data={data} setView={setView} initialDate={view.date} initialMode={view.calMode} initialShow={view.calShow} />;
    if (view.screen === "quotePdf") return <QuotePdfView data={data} id={view.id} setView={setView} />;
    if (view.screen === "surveyPdf") return <SurveyPdfView data={data} id={view.id} setView={setView} />;
    if (view.screen === "company") return <CompanyView data={data} setView={setView} setData={setData} />;
    if (view.screen === "catalogue") return <CatalogueEditor catalog={catalog} onSave={applyCatalogEdit} setView={setView} />;
    if (view.screen === "storage") return <StorageView data={data} setView={setView} />;
    if (view.screen === "storageIntake") return <StorageIntakeForm data={data} setView={setView} presetCustomerId={view.customerId} editRecId={view.editRecId} presetJobId={view.jobId} />;
    if (view.screen === "storageCollect") return <PartCollectionForm data={data} setView={setView} recId={view.recId} />;
    if (view.screen === "storageJob") return <StorageJobDetail data={data} setView={setView} customerId={view.customerId} jobId={view.jobId} />;
    return null;
  }

  function content() {
    const full = fullScreen();
    if (full) return <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}><div style={{ padding: wide ? "24px 26px 40px" : "16px 16px 90px", maxWidth: 1080, margin: "0 auto" }}>{full}</div></div>;
    const sec = SECTIONS[sectionKey];
    if (!sec) return null;
    const { List, Detail } = sec;
    const detailId = view.screen === sec.detail ? view.id : null;
    if (wide) {
      return (
        <div style={{ flex: 1, display: "flex", minWidth: 0, minHeight: 0 }}>
          <div style={{ width: 384, flexShrink: 0, borderRight: "1px solid #E9EEED", overflowY: "auto", minHeight: 0, padding: "18px 15px", background: "#fff" }}>
            <List data={data} setView={setView} initialFilter={view.filter} />
          </div>
          <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "24px 28px 40px" }}>
            {detailId ? <Detail data={data} id={detailId} setView={setView} />
              : <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}><Empty icon={sec.list === "customers" ? "customers" : sec.list === "jobs" ? "truck" : "enquiries"} text="Select an item to view details" /></div>}
          </div>
        </div>
      );
    }
    return <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "16px 16px 90px" }}>{detailId ? <Detail data={data} id={detailId} setView={setView} /> : <List data={data} setView={setView} initialFilter={view.filter} />}</div>;
  }

  // ---- WIDE (iPad / desktop): sidebar + content ----
  if (wide) {
    return (
      <div style={{ display: "flex", height: "100vh", maxWidth: 1360, margin: "0 auto", background: "#EEF3F2", boxShadow: "0 0 60px rgba(16,33,30,.06)" }}>
        <ResponsiveStyles device={device} />
        <aside style={{ width: 244, flexShrink: 0, background: "#fff", borderRight: "1px solid #E9EEED", display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "22px 18px 18px" }}>
            <div style={{ width: 44, height: 44, borderRadius: 13, background: `linear-gradient(145deg, ${TEAL}, ${TEAL_D})`, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 6px 16px rgba(14,124,115,.32)" }}>
              <Icon name="truck" size={25} color="#fff" />
            </div>
            <div>
              <div style={{ fontSize: 15.5, fontWeight: 800, letterSpacing: "-.02em", lineHeight: 1.1 }}>Removals CRM</div>
              <div style={{ fontSize: 10, color: "#94A4A0", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".09em" }}>Enquiries &amp; moves</div>
            </div>
          </div>
          <nav style={{ padding: "8px 12px", display: "flex", flexDirection: "column", gap: 3 }}>
            {NAV.map(n => {
              const on = activeTab === n.id;
              return (
                <button key={n.id} onClick={() => setView({ screen: n.id })} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 13px", borderRadius: 11, border: "none", cursor: "pointer", textAlign: "left", fontSize: 14.5, fontWeight: on ? 700 : 600, position: "relative",
                  background: on ? "linear-gradient(90deg,#E6F3F1,#EDF6F5)" : "transparent", color: on ? TEAL_D : "#43534F" }}>
                  {on && <span style={{ position: "absolute", left: -12, top: 9, bottom: 9, width: 3.5, borderRadius: "0 4px 4px 0", background: AMBER }} />}
                  <Icon name={n.icon} size={20} color={on ? TEAL : "#7C8B87"} /> {n.label}
                </button>
              );
            })}
          </nav>
          <div style={{ marginTop: "auto", padding: "14px 18px", borderTop: "1px solid #E9EEED", display: "flex", alignItems: "center", gap: 9, fontSize: 12, color: "#6A7B77", fontWeight: 600 }}>
            <SyncDot /> {syncStatus === "synced" ? "All changes synced" : syncStatus === "syncing" ? "Syncing…" : "Offline — saved on device"}
          </div>
        </aside>
        <main style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, overflow: "hidden" }}>
          {content()}
        </main>
        {view.screen === "newEnquiry" && <EnquiryForm data={data} onClose={() => setView({ screen: "enquiries" })} initialCustomerId={view.customerId} />}
      </div>
    );
  }

  // ---- PHONE: header + content + bottom nav ----
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "#EEF3F2" }}>
      <ResponsiveStyles device={device} />
      <header style={{ background: `linear-gradient(135deg, ${TEAL}, ${TEAL_D})`, padding: "13px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
          <div style={{ width: 40, height: 40, borderRadius: 11, background: "rgba(255,255,255,.16)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Icon name="truck" size={23} color="#fff" />
          </div>
          <div>
            <div style={{ fontSize: 16.5, fontWeight: 800, color: "#fff", letterSpacing: "-.02em", lineHeight: 1.15 }}>Removals CRM</div>
            <div style={{ fontSize: 10, color: "#9DECDF", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".08em" }}>Enquiries &amp; moves</div>
          </div>
        </div>
        <SyncDot />
      </header>
      <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column", minHeight: 0 }}>{content()}</div>
      {view.screen === "newEnquiry" && <EnquiryForm data={data} onClose={() => setView({ screen: "enquiries" })} initialCustomerId={view.customerId} />}
      <nav style={{ background: "#fff", borderTop: "1px solid #E9EEED", display: "flex", flexShrink: 0 }}>
        {NAV.map(n => {
          const on = activeTab === n.id;
          return (
            <button key={n.id} onClick={() => setView({ screen: n.id })} style={{ flex: 1, padding: "11px 0 16px", background: "transparent", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
              <Icon name={n.icon} size={24} color={on ? TEAL : "#9CA3AF"} />
              <span style={{ fontSize: 10.5, fontWeight: 700, color: on ? TEAL : "#9CA3AF" }}>{n.phone}</span>
              {on && <span style={{ width: 16, height: 2.5, borderRadius: 99, background: AMBER }} />}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
