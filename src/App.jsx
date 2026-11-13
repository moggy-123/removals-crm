import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createClient } from "@supabase/supabase-js";
import { pullFromCloud, pushToCloud, pushOne, pushMany, deleteMany, deleteRecord as deleteRecordRaw, supabase, loadCatalog, saveCatalog, uploadStorageSheet, setCustomerRefStart, dbSig } from "./supabase";
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
// A container is still "in store" if any of its items have quantity remaining after collections.
function containerInStore(sheet, ct) {
  const items = ct.items || [];
  if (!items.length) return true; // no item detail — assume still in store
  const collectedQty = name => (sheet.collections || []).reduce((n, col) => n + (col.items || []).filter(ci => ci.container === (ct.number || "") && ci.name === name).reduce((m, ci) => m + (Number(ci.qty) || 0), 0), 0);
  return items.some(it => Math.max(0, (Number(it.qty) || 0) - collectedQty(it.name)) > 0);
}
// Container count + numbers are derived from the job's inventory sheets, not typed in.
function jobContainerNos(c, job) {
  const nos = []; const seen = new Set();
  sheetsForJob(c, job).forEach(s => (s.containers || []).forEach(ct => { if (!containerInStore(s, ct)) return; const key = (ct.number || "").trim(); if (key && !seen.has(key)) { seen.add(key); nos.push(key); } }));
  return nos;
}
function jobContainerCount(c, job) {
  let n = 0; const seen = new Set();
  sheetsForJob(c, job).forEach(s => (s.containers || []).forEach(ct => { if (!containerInStore(s, ct)) return; const key = (ct.number || "").trim(); if (key) { if (!seen.has(key)) { seen.add(key); n++; } } else n++; }));
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
// Items that usually need dismantling and reassembling — ticked automatically when added to a survey.
const LIKELY_DISMANTLE_RE = /\b(bunk ?beds?|cabin ?beds?|high ?sleepers?|mid ?sleepers?|bed ?frames?|bedsteads?|four ?poster|beds?|cots?|wardrobes?|robes?|armoires?|dining tables?|extending tables?|kitchen tables?|garden tables?|patio tables?|tables?|desks?|workstations?|bookcases?|shelving units?|wall units?|tv units?|display cabinets?|dressers?|welsh dressers?|dressing tables?|corner sofas?|sectional|sofa ?beds?|trampolines?|treadmills?|cross ?trainers?|multi ?gyms?|home ?gyms?|weight benches?|exercise bikes?|rowing machines?|swing sets?|climbing frames?|playhouses?|sheds?|greenhouses?|gazebos?|pergolas?|pool tables?|snooker tables?|table tennis|american (fridge|style)|mirrors? \(wall\)|headboards?)\b/i;
const NOT_DISMANTLE_RE = /\b(bedside|bedding|bedroom|bed ?linen|coffee tables?|side tables?|lamp tables?|nest of tables|occasional tables?|console|hall tables?|telephone tables?|children'?s tables?|kids'? tables?|dressing table stool|table lamps?|tablecloths?|garden bed|flower bed|raised bed|dog bed|cat bed|pet bed|bean ?bag|boxes?|bags?|mattress|duvet|pillows?|chairs?)\b/i;
const likelyDismantle = name => canDismantle(name) && LIKELY_DISMANTLE_RE.test(name || "") && !NOT_DISMANTLE_RE.test(name || "");
function maxCustomerRef(data) { return (data.customers || []).reduce((m, c) => Math.max(m, Number(c.ref) || 0), 0); }
function nextCustomerRef(data) { return Math.max(getRefStart(), maxCustomerRef(data) + 1); }

// Brand
const TEAL = "#0E7C73", TEAL_D = "#0B5F58", NAVY = "#0F2E2A", AMBER = "#F59E0B";

const ENQUIRY_STATUSES = ["New", "Surveyed", "Quoted", "Won", "Lost", "Not quoted", "Let Go"];
const JOB_STATUSES = ["Provisional", "Confirmed", "Completed", "Let Go"];
const PROPERTY_TYPES = ["Detached house", "Semi-detached house", "Terraced house", "End of terrace house", "Townhouse", "Cottage", "House",
  "Detached bungalow", "Semi-detached bungalow", "Bungalow", "Flat / Apartment", "Maisonette", "Farmhouse", "Barn conversion",
  "Mobile / park home", "Office", "Commercial unit", "Storage Unit", "Other"];
// Turn whatever the customer typed ("detached", "3 bed semi", "ground floor flat"…) into one of our types.
function normalizePropertyType(raw) {
  const t = String(raw || "").toLowerCase().trim();
  if (!t) return "";
  const exact = PROPERTY_TYPES.find(p => p.toLowerCase() === t);
  if (exact) return exact;
  const bung = /bungalow|dormer/.test(t);
  if (/mobile|park home|caravan|static/.test(t)) return "Mobile / park home";
  if (/barn/.test(t)) return "Barn conversion";
  if (/farm/.test(t)) return "Farmhouse";
  if (/cottage/.test(t)) return "Cottage";
  if (/maisonette/.test(t)) return "Maisonette";
  if (/flat|apartment|studio|penthouse/.test(t)) return "Flat / Apartment";
  if (/town ?house/.test(t)) return "Townhouse";
  if (/end[\s-]*(of[\s-]*)?terrace|end[\s-]*terr/.test(t)) return "End of terrace house";
  if (/terrace|mid[\s-]*terr/.test(t)) return "Terraced house";
  if (/semi/.test(t)) return bung ? "Semi-detached bungalow" : "Semi-detached house";
  if (/detached/.test(t)) return bung ? "Detached bungalow" : "Detached house";
  if (bung) return "Bungalow";
  if (/house|home/.test(t)) return "House";
  if (/office/.test(t)) return "Office";
  if (/storage|unit|garage|lock[\s-]*up/.test(t)) return /office|shop|commercial|industrial/.test(t) ? "Commercial unit" : "Storage Unit";
  if (/shop|commercial|warehouse|industrial|retail/.test(t)) return "Commercial unit";
  return raw.trim().replace(/^./, c => c.toUpperCase()); // keep it as typed if we can't tell
}
const propertyOptions = v => (v && !PROPERTY_TYPES.includes(v) ? [...PROPERTY_TYPES, v] : PROPERTY_TYPES);
const REFERRAL_SUGGESTIONS = ["Google", "Facebook", "Website", "Previous customer", "Recommendation", "Checkatrade", "Estate agent", "Van / vehicle", "Leaflet", "Other"];
const QUOTE_STATUSES = ["Draft", "Sent", "Accepted", "Declined"];

const STATUS_META = {
  New:         { color: "#2563EB", bg: "#EFF6FF" },
  "Survey booked": { color: "#7C3AED", bg: "#F5F3FF" },
  "Survey missed": { color: "#DC2626", bg: "#FEF2F2" },
  Surveyed:    { color: "#0891B2", bg: "#ECFEFF" },
  "Let Go":    { color: "#6B7280", bg: "#F3F4F6" },
  "Not quoted": { color: "#6B7280", bg: "#F3F4F6" },
  "Alt. not chosen": { color: "#6B7280", bg: "#F3F4F6" },
  Quoted:      { color: "#D97706", bg: "#FFFBEB" },
  Won:         { color: "#059669", bg: "#ECFDF5" },
  Lost:        { color: "#DC2626", bg: "#FEF2F2" },
  Provisional: { color: "#CA8A04", bg: "#FEFCE8" },
  "No date provisional": { color: "#C2410C", bg: "#FFF7ED" },
  Confirmed:   { color: "#2563EB", bg: "#EFF6FF" },
  Booked:      { color: "#2563EB", bg: "#EFF6FF" },
  "In Progress": { color: "#2563EB", bg: "#EFF6FF" },
  Completed:   { color: "#059669", bg: "#ECFDF5" },
};

// ── Who's signed in ─────────────────────────────────────────────────────────
// Roles: admin (everything) · office / surveyor (everything except settings & deleting) · crew (today's jobs only)
let CURRENT_USER = { role: "admin", email: "", staffName: "" };
const ROLE_LABEL = { admin: "Admin", office: "Office", surveyor: "Surveyor", viewer: "Read only", crew: "Crew" };
const isReadOnly = () => CURRENT_USER.role === "viewer";
const isAdmin = () => CURRENT_USER.role === "admin";
const canDelete = () => isAdmin();

// ── Helpers ─────────────────────────────────────────────────────────────────
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function todayISO() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; } // local date (UK), not UTC
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
// Previous weekday (Sat/Sun → Friday).
function prevWeekday(iso) {
  const d = new Date(iso + "T00:00"); if (isNaN(d)) return iso;
  const g = d.getDay();
  if (g === 0) return isoAdd(iso, { days: -2 });
  if (g === 6) return isoAdd(iso, { days: -1 });
  return iso;
}
const isWeekday = iso => { const g = new Date(iso + "T00:00").getDay(); return g !== 0 && g !== 6; };
// Move n working days (Mon–Fri) forward, or back if n is negative.
function workdayAdd(iso, n) {
  let d = iso, left = Math.abs(n); const step = n < 0 ? -1 : 1;
  while (left > 0) { d = isoAdd(d, { days: step }); if (isWeekday(d)) left--; }
  return d;
}
// Vehicle bookings (service / MOT / tacho) only cover WORKING days: a 3-day MOT that
// starts on Thursday is Thu, Fri and the following Mon.
function bookingDates(b) {
  if (!b || !b.start) return [];
  const n = Math.max(1, Number(b.days) || 1);
  const out = []; let d = b.start, guard = 0;
  while (out.length < n && guard++ < 60) { if (isWeekday(d)) out.push(d); d = isoAdd(d, { days: 1 }); }
  return out;
}
// "Tue 15/12", or "Fri 29/10/27" when it's not this year
const shortDay = iso => { const y = String(new Date().getFullYear()); return `${dow(iso)} ${iso.slice(0, 4) === y ? fmtUK(iso).slice(0, 5) : fmtUK(iso).slice(0, 6) + iso.slice(2, 4)}`; };
const bookingEnd = b => { const ds = bookingDates(b); return ds[ds.length - 1] || (b && b.start) || ""; };
const inBooking = (b, iso) => bookingDates(b).includes(iso);
// MOT: you enter the test day; the garage has the vehicle the working days before it.
function motBooking(motDate, days, id) {
  const test = prevWeekday(motDate);
  const n = Math.max(1, Number(days) || 1);
  return { id: id || uid(), type: "MOT", motDate: test, start: workdayAdd(test, -(n - 1)), days: n };
}
// ── Automatic servicing / MOT / tacho bookings ─────────────────────────────
// 1. When a booked date has passed, it counts as done (Last done moves on).
// 2. The next one is booked automatically from Last done + interval:
//    Service → nearest Tuesday · MOT → test day + prep days before · Tacho → weekday.
// Bookings you change by hand are left alone; removing an automatic one skips that cycle.
const MAINT_TYPES = [["Service", "serviceLast"], ["MOT", "motLast"], ["Tacho", "tachoLast"]];
function maintDue(m, type) { return type === "Service" ? nextService(m) : type === "MOT" ? nextMOT(m) : nextTacho(m); }
function maintPlanned(m, type, base) {
  if (!base) return null;
  if (type === "MOT") { const b = motBooking(base, m.motDays || 1, "x"); return { start: b.start, days: b.days, motDate: b.motDate, key: b.motDate }; }
  const start = type === "Service" ? nearestDow(base, 2) : nextWeekday(base);
  return { start, days: 1, key: start };
}
function autoMaint(m0, today) {
  if (!m0) return m0;
  let m = { ...m0, bookings: Array.isArray(m0.bookings) ? [...m0.bookings] : [] };
  let changed = false;
  // 1. passed bookings → done (each booking only once, so a Last done you type in yourself sticks)
  for (const [type, key] of MAINT_TYPES) {
    m.bookings = m.bookings.map(b => {
      if (b.type !== type || b.done) return b;
      const end = bookingEnd(b);
      if (!end || end >= today) return b;
      const done = type === "MOT" ? (b.motDate || end) : b.start;
      if (!m[key] || m[key] < done) m[key] = done;
      changed = true;
      return { ...b, done: true };
    });
  }
  // A past booking dated AFTER the Last done you've entered can't have happened — drop it
  // (otherwise it still shows on the calendar on the wrong day).
  for (const [type, key] of MAINT_TYPES) {
    if (!m[key]) continue;
    const before = m.bookings.length;
    m.bookings = m.bookings.filter(b => !(b.type === type && b.done && (type === "MOT" ? (b.motDate || bookingEnd(b)) : b.start) > m[key]));
    if (m.bookings.length !== before) changed = true;
  }
  // Past bookings are kept, so the calendar keeps a history of every service, MOT and tacho.
  // 2. make sure the next one is booked
  const skipped = Array.isArray(m.skipped) ? m.skipped : [];
  for (const [type] of MAINT_TYPES) {
    const due = maintDue(m, type);
    const want = maintPlanned(m, type, due);
    const upcoming = m.bookings.filter(b => b.type === type && bookingEnd(b) >= today);
    const stale = upcoming.filter(b => b.auto && (!want || (type === "MOT" ? b.motDate : b.start) !== want.key || Number(b.days) !== Number(want.days)));
    if (stale.length) { const ids = new Set(stale.map(b => b.id)); m.bookings = m.bookings.filter(b => !ids.has(b.id)); changed = true; }
    if (!want) continue;
    const still = m.bookings.some(b => b.type === type && bookingEnd(b) >= today);
    if (still || skipped.includes(type + "|" + due)) continue;
    const nb = { id: `auto-${type}-${want.key}`, type, start: want.start, days: want.days, auto: true };
    if (want.motDate) nb.motDate = want.motDate;
    if (bookingEnd(nb) < today) continue; // overdue — shown as overdue instead of booking in the past
    m.bookings = [...m.bookings, nb]; changed = true;
  }
  return changed ? m : m0;
}
function applyAutoMaint(vehicles) {
  const today = todayISO();
  return (vehicles || []).map(v => { if (!v || !v.maint) return v; const nm = autoMaint(v.maint, today); return nm === v.maint ? v : { ...v, maint: nm, updatedAt: Date.now() }; });
}
// Is a vehicle booked out for maintenance on a given date?
function vehOutOn(v, dateISO) {
  const b = (v && v.maint && v.maint.bookings) || [];
  return b.some(x => inBooking(x, dateISO));
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
    if (raw) { const d = { ...EMPTY, ...JSON.parse(raw) }; d.vehicles = applyAutoMaint(d.vehicles); return d; }
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

// ── Change history (activity log) ───────────────────────────────────────────
// Every save is compared with what was there before, and the differences (prices,
// dates, contacts, move plans, status…) are written to the 'activity_log' table.
// Entries are queued on the device first, so nothing is lost without signal.
const LOG_QUEUE_KEY = "removals_log_queue";
const LOG_FIELDS = {
  customers: { name: "Name", phone: "Mobile", homePhone: "Home phone", email: "Email", address1: "Address", address2: "Address line 2", town: "Town", postcode: "Postcode", company: "Company", custType: "Type", notes: "Notes", contacts: "Other contacts", storageJobs: "Storage jobs" },
  enquiries: { status: "Status", preferredDate: "Move date", moveMonth: "Move month", dateFlexible: "Flexible dates", surveyDate: "Survey date", surveyTime: "Survey time", surveyor: "Surveyor", surveyDone: "Surveyed", quoteTotal: "Quote price", quoteStatus: "Quote status", quoteLines: "Quote lines", fromAddress1: "From address", fromTown: "From town", fromPostcode: "From postcode", toAddress1: "To address", toTown: "To town", toPostcode: "To postcode", fromPropertyType: "From property", toPropertyType: "To property", fromBedrooms: "Bedrooms", inventory: "Inventory", toStore: "Into store", notes: "Notes", lostReason: "Lost reason", referredBy: "Referred by", exchanged: "Exchanged" },
  jobs: { status: "Status", price: "Price", deposit: "Deposit", moveDate: "Move date", stages: "Move plan", notes: "Notes", depositPaid: "Deposit paid", balancePaid: "Balance paid" },
  vehicles: { name: "Name", reg: "Reg", vtype: "Type", maint: "Servicing" },
  staff: { name: "Name", role: "Role", phone: "Phone", active: "Active", away: "Time off" },
};
const LOG_MONEY = new Set(["quoteTotal", "price", "deposit"]);
const LOG_DATES = new Set(["preferredDate", "surveyDate", "moveDate"]);
function logWho() {
  if (CURRENT_USER && (CURRENT_USER.staffName || CURRENT_USER.email)) return CURRENT_USER.staffName || CURRENT_USER.email;
  const ua = navigator.userAgent || "";
  return /iPad|Macintosh.*Mobile|Macintosh(?=.*Safari)(?!.*Chrome)/.test(ua) && navigator.maxTouchPoints > 1 ? "iPad" : /iPhone/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : "Computer";
}
function logFmt(table, k, v, d) {
  if (k === "custType" && !v) v = "Private";
  if (k === "status" && !v && table === "enquiries") v = "New";
  if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (LOG_MONEY.has(k)) return "£" + Number(v || 0).toLocaleString("en-GB", { maximumFractionDigits: 2 });
  if (LOG_DATES.has(k) && /^\d{4}-\d\d-\d\d/.test(String(v))) return fmtUK(String(v).slice(0, 10));
  if (k === "moveMonth" && /^\d{4}-\d\d$/.test(String(v))) return fmtMonth(v);
  if (k === "contacts") return v.filter(c => c && (c.name || c.phone)).map(c => [c.name, c.relation && `(${c.relation})`, c.phone].filter(Boolean).join(" ")).join("; ") || "—";
  if (k === "stages") {
    const vn = id => ((d && d.vehicles) || []).find(x => x.id === id)?.name || "";
    return v.map(st => [st.type || "Day", st.date ? fmtUK(st.date) : "no date", st.time, (st.crew || []).length ? (st.crew || []).join(", ") : "", (st.vehicleIds || []).map(vn).filter(Boolean).join(", ")].filter(Boolean).join(" · ")).join(" | ");
  }
  if (k === "quoteLines") return v.filter(l => l && (l.desc || l.amount)).map(l => `${l.desc || "Line"} £${Number(l.amount || 0).toLocaleString("en-GB")}`).join("; ") || "—";
  if (k === "inventory") return `${v.length} item${v.length !== 1 ? "s" : ""}`;
  if (k === "storageJobs") return v.map(j => [j.location, j.value ? `£${j.value}` : "", j.dateIn && `in ${fmtUK(j.dateIn)}`, j.dateOut && `out ${fmtUK(j.dateOut)}`].filter(Boolean).join(" ")).join("; ");
  if (k === "away") return v.map(a => `${a.reason || "Off"} ${a.start ? fmtUK(a.start) : ""}${Number(a.days) > 1 ? ` (${a.days} days)` : ""}`).join("; ");
  if (k === "maint") return (v.bookings || []).filter(b => b.start >= todayISO()).map(b => `${b.type} ${fmtUK(b.start)}`).join("; ") || "—";
  const s = String(v); return s.length > 160 ? s.slice(0, 157) + "…" : s;
}
const logSame = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null) || ((a ?? "") === "" && (b ?? "") === "") || (Array.isArray(a) && !a.length && (b == null)) || (Array.isArray(b) && !b.length && (a == null));
function logRecName(table, r, d) {
  if (!r) return "";
  if (table === "customers") return r.name || "Customer";
  if (table === "enquiries") return "Enquiry" + ([r.fromTown, r.toTown].filter(Boolean).length ? ` ${[r.fromTown, r.toTown].filter(Boolean).join(" → ")}` : "");
  if (table === "jobs") { try { return "Move " + moveRef(d, r); } catch { return "Move"; } }
  return r.name || table;
}
function diffForLog(prev, next) {
  const out = [], at = new Date().toISOString(), who = logWho();
  for (const table of TABLES) {
    const fields = LOG_FIELDS[table]; if (!fields) continue;
    const before = new Map((prev[table] || []).map(r => [r.id, r]));
    for (const r of next[table] || []) {
      const p = before.get(r.id);
      const custId = table === "customers" ? r.id : (r.customerId || null);
      if (!p) { out.push({ id: uid() + uid(), at, who, customer_id: custId, rec_table: table, rec_id: r.id, summary: `Created ${logRecName(table, r, next)}`, changes: [] }); continue; }
      const changes = [];
      for (const [k, label] of Object.entries(fields)) {
        if (logSame(p[k], r[k])) continue;
        const from = logFmt(table, k, p[k], prev), to = logFmt(table, k, r[k], next);
        if (from === to) continue;
        changes.push({ field: label, from, to });
      }
      if (changes.length) out.push({ id: uid() + uid(), at, who, customer_id: custId, rec_table: table, rec_id: r.id, summary: `${logRecName(table, r, next)}: ${changes.map(c => c.field).join(", ")} changed`, changes });
    }
  }
  return out;
}
function queueLog(entries) {
  if (!entries || !entries.length) return;
  try { const q = JSON.parse(localStorage.getItem(LOG_QUEUE_KEY) || "[]"); localStorage.setItem(LOG_QUEUE_KEY, JSON.stringify([...q, ...entries].slice(-1000))); } catch {}
}
function logDeletion(table, rec, d) {
  if (!rec) return;
  queueLog([{ id: uid() + uid(), at: new Date().toISOString(), who: logWho(), customer_id: table === "customers" ? rec.id : (rec.customerId || null), rec_table: table, rec_id: rec.id, summary: `Deleted ${logRecName(table, rec, d)}`, changes: [] }]);
}
let LOG_FLUSHING = false;
async function flushLog() {
  if (LOG_FLUSHING) return; LOG_FLUSHING = true;
  try {
    const q = JSON.parse(localStorage.getItem(LOG_QUEUE_KEY) || "[]");
    if (!q.length) return;
    const batch = q.slice(0, 100);
    const { error } = await Promise.race([supabase.from("activity_log").upsert(batch), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 10000))]);
    if (error) return; // table not set up yet / offline — keep them queued
    const sent = new Set(batch.map(x => x.id));
    const left = JSON.parse(localStorage.getItem(LOG_QUEUE_KEY) || "[]").filter(x => !sent.has(x.id));
    localStorage.setItem(LOG_QUEUE_KEY, JSON.stringify(left));
  } catch { /* try again later */ } finally { LOG_FLUSHING = false; }
}
// Customers whose name, ref, phone, email, address or postcode match the search words.
function logCustomerIds(q) {
  const words = String(q || "").toLowerCase().replace(/^#/, "").split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  let d = {}; try { d = loadData(); } catch {}
  const enqText = {};
  (d.enquiries || []).forEach(e => { enqText[e.customerId] = (enqText[e.customerId] || "") + " " + [e.fromAddress1, e.fromTown, e.fromPostcode, e.toAddress1, e.toTown, e.toPostcode].filter(Boolean).join(" "); });
  return (d.customers || []).filter(c => {
    const t = [c.ref, c.name, c.company, c.phone, c.homePhone, c.email, c.address1, c.town, c.postcode, enqText[c.id]].filter(Boolean).join(" ").toLowerCase();
    return words.every(w => t.includes(w));
  }).map(c => c.id).slice(0, 150);
}
function logMatches(r, q, custIds) {
  q = String(q || "").trim().toLowerCase();
  if (!q) return true;
  if (r.customer_id && custIds.includes(r.customer_id)) return true;
  const t = [r.summary, r.who, JSON.stringify(r.changes || [])].join(" ").toLowerCase();
  return q.split(/\s+/).every(w => t.includes(w));
}
async function loadLog(customerId, search = "") {
  let rows = [], err = "";
  const q = String(search || "").trim();
  const custIds = q ? logCustomerIds(q) : [];
  try {
    let qy = supabase.from("activity_log").select("*").order("at", { ascending: false }).limit(q ? 500 : (customerId ? 300 : 200));
    if (customerId) qy = qy.eq("customer_id", customerId);
    if (q) {
      const safe = q.replace(/[%,()*\\"']/g, " ").trim();
      const ors = safe ? [`summary.ilike.%${safe}%`, `who.ilike.%${safe}%`] : [];
      if (custIds.length) ors.push(`customer_id.in.(${custIds.join(",")})`);
      if (ors.length) qy = qy.or(ors.join(","));
    }
    const { data, error } = await qy;
    if (error) err = /activity_log|relation|does not exist|schema cache/i.test(error.message || "") ? "setup" : (error.message || "error"); else rows = data || [];
  } catch (e) { err = "offline"; }
  let queued = []; try { queued = JSON.parse(localStorage.getItem(LOG_QUEUE_KEY) || "[]"); } catch {}
  const have = new Set(rows.map(r => r.id));
  const pending = queued.filter(x => !have.has(x.id) && (!customerId || x.customer_id === customerId) && logMatches(x, q, custIds)).map(x => ({ ...x, pending: true }));
  return { rows: [...pending, ...rows].sort((a, b) => String(b.at).localeCompare(String(a.at))), err };
}
// Admin: see deletions by day and undo a batch (e.g. records removed by mistake).
function RecentlyDeleted() {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    try {
      const { ids } = await readCloudDeletesFull();
      const by = {};
      Object.entries(ids).forEach(([id, t]) => { const d = new Date(Number(t)).toISOString().slice(0, 10); (by[d] = by[d] || []).push(id); });
      setDays(Object.entries(by).sort((a, b) => b[0].localeCompare(a[0])));
    } catch { setDays([]); }
  };
  useEffect(() => { if (open && !days) load(); /* eslint-disable-next-line */ }, [open]);
  async function undo(day, ids) {
    if (!confirm(`Undo ${ids.length} deletion${ids.length !== 1 ? "s" : ""} from ${fmtUK(day)}?\n\nAny phone or iPad that still has these records will put them back in the cloud the next time it syncs.`)) return;
    setBusy(true);
    try {
      await undeleteInCloud(ids);
      removeTombstones(ids);
      await load();
      alert("Done. Open the app on any device that still shows those records and they'll upload again.");
    } catch (e) { alert("Couldn't undo: " + ((e && e.message) || e)); }
    setBusy(false);
  }
  return (
    <Card style={{ marginBottom: 0 }}>
      <div onClick={() => setOpen(o => !o)} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}>
        <div style={{ fontSize: 12, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".06em", color: "#94A4A0" }}>Recently deleted</div>
        <span style={{ fontSize: 13, fontWeight: 700, color: TEAL }}>{open ? "Hide ▾" : "Show ▸"}</span>
      </div>
      {open && (
        <div style={{ marginTop: 10 }}>
          {!days && <div style={{ fontSize: 13, color: "#9CA3AF" }}>Loading…</div>}
          {days && !days.length && <div style={{ fontSize: 13, color: "#9CA3AF" }}>Nothing deleted recently.</div>}
          {(days || []).map(([day, ids]) => (
            <div key={day} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderTop: "1px solid #F0F4F3" }}>
              <div style={{ fontSize: 13.5 }}><b>{fmtUK(day)}</b> <span style={{ color: "#6A7B77" }}>· {ids.length} record{ids.length !== 1 ? "s" : ""} deleted</span></div>
              <Btn size="sm" variant="grey" disabled={busy} onClick={() => undo(day, ids)}>Undo</Btn>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function HistoryList({ customerId, title = "History", startOpen = false }) {
  const [open, setOpen] = useState(startOpen);
  const [state, setState] = useState({ rows: null, err: "" });
  const [expanded, setExpanded] = useState({});
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    let live = true;
    const t = setTimeout(async () => {
      setBusy(true);
      const res = await loadLog(customerId, search);
      if (live) { setState(res); setBusy(false); }
    }, search ? 450 : 0);
    return () => { live = false; clearTimeout(t); };
    /* eslint-disable-next-line */
  }, [open, search]);
  const rows = state.rows || [];
  const refOf = (() => { const m = {}; try { (loadData().customers || []).forEach(c => { m[c.id] = c; }); } catch {} return id => m[id]; })();
  return (
    <Card>
      <div onClick={() => setOpen(o => !o)} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}>
        <div style={{ fontSize: 12, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".06em", color: "#94A4A0" }}>{title}</div>
        <span style={{ fontSize: 13, fontWeight: 700, color: TEAL }}>{open ? "Hide ▾" : "Show ▸"}</span>
      </div>
      {open && (
        <div style={{ marginTop: 10 }}>
          <input data-ro-ok type="search" value={search} onChange={ev => setSearch(ev.target.value)} placeholder="Search: name, ref, postcode, or what changed" style={{ width: "100%", height: 42, border: "1px solid #DDE6E4", borderRadius: 10, padding: "0 12px", fontFamily: "inherit", fontSize: 15, boxSizing: "border-box", marginBottom: 6 }} />
          {search.trim() && <div style={{ fontSize: 12.5, color: "#6A7B77", marginBottom: 8 }}>{busy ? "Searching…" : `${rows.length}${rows.length >= 500 ? "+" : ""} change${rows.length !== 1 ? "s" : ""} found`}</div>}
          {!state.rows && <div style={{ fontSize: 13, color: "#9CA3AF" }}>Loading…</div>}
          {state.err === "setup" && <div style={{ fontSize: 12.5, color: "#7C4A03", background: "#FFF7E8", border: "1px solid #FBD9A0", borderRadius: 8, padding: "8px 10px", marginBottom: 8 }}>The history table isn't set up in the database yet (run add-history.sql). Changes are being kept on this device until it is.</div>}
          {state.err === "offline" && <div style={{ fontSize: 12.5, color: "#6A7B77", marginBottom: 8 }}>No signal — showing changes made on this device only.</div>}
          {state.rows && !rows.length && <div style={{ fontSize: 13, color: "#9CA3AF" }}>{search.trim() ? "Nothing matches that search." : "No changes recorded yet."}</div>}
          {rows.map(r => {
            const ch = Array.isArray(r.changes) ? r.changes : [];
            const isOpen = expanded[r.id] || ch.length <= 3;
            const when = new Date(r.at);
            return (
              <div key={r.id} style={{ borderTop: "1px solid #F0F4F3", padding: "8px 0", minWidth: 0, overflowWrap: "anywhere" }}>
                <div style={{ fontSize: 13.5, fontWeight: 800, color: "#10211E" }}>
                  {r.who || "Unknown"} · {isNaN(when) ? "" : `${fmtUK(when.toISOString().slice(0, 10))} ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`}
                  {r.pending ? <span style={{ fontWeight: 600, color: "#B45309", fontSize: 11.5 }}> · not uploaded yet</span> : null}
                </div>
                <div style={{ fontSize: 12.5, color: "#6A7B77", marginBottom: ch.length ? 4 : 0 }}>
                  {(() => { const c = r.customer_id && refOf(r.customer_id); return c && c.ref ? <b style={{ color: TEAL }}>#{c.ref}</b> : null; })()}
                  {(() => { const c = r.customer_id && refOf(r.customer_id); return c && c.ref ? " · " : ""; })()}
                  {ch.length ? (r.summary || "").replace(/:.*$/, "") : r.summary}
                </div>
                {(isOpen ? ch : ch.slice(0, 3)).map((c, i) => (
                  <div key={i} style={{ fontSize: 12.5, color: "#374151", lineHeight: 1.45, overflowWrap: "anywhere", wordBreak: "break-word" }}>
                    <b>{c.field}:</b> <span style={{ color: "#9CA3AF", textDecoration: "line-through" }}>{c.from}</span> → <span style={{ color: "#0F766E", fontWeight: 600 }}>{c.to}</span>
                  </div>
                ))}
                {!isOpen && <span onClick={() => setExpanded(e => ({ ...e, [r.id]: true }))} style={{ fontSize: 12, color: TEAL, fontWeight: 700, cursor: "pointer" }}>+ {ch.length - 3} more</span>}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// Save then reload, waiting for the cloud push first (important on mobile)
async function saveAndReload(data) {
  if (isReadOnly()) { alert("You have read-only access, so changes can't be saved. Ask Dave if you need to change something."); return; }
  showSavingOverlay();
  SAVING_IN_PROGRESS = true;
  try { queueLog(diffForLog(loadData(), data)); } catch { /* history is best effort */ }
  const stamped = stampData(data);
  setDB(JSON.stringify(stamped));
  flushLog().catch(() => {});
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
  } catch (e) { storageFullWarning(e); }
}
// Write the app's data to this device. If the device's storage is full the write fails
// silently in Safari — then deletes/edits "come back". Tell the user instead.
let STORAGE_WARNED = false;
function storageFullWarning(e) {
  if (STORAGE_WARNED) return; STORAGE_WARNED = true;
  let kb = 0; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); kb += ((localStorage.getItem(k) || "").length + k.length) / 512; } } catch {}
  setTimeout(() => alert(`This device couldn't save its copy of the app's data (${(e && e.name) || "storage error"}, about ${Math.round(kb)} KB used).\n\nChanges made here may not stick. Please tell Dave / the developer.`), 50);
}
function setDB(str) {
  try { localStorage.setItem(DB_KEY, str); }
  catch (e) { storageFullWarning(e); throw e; }
}
function getTombstones() {
  try { return JSON.parse(localStorage.getItem(TOMB_KEY) || "[]"); } catch { return []; }
}
// Delete a record in the cloud and CHECK it has actually gone. Supabase reports success even
// when its permissions silently block a delete, which used to leave "deleted" vans/staff in the
// cloud — they then reappeared (as duplicates) after a reset. Throws if the row is still there.
async function deleteRecord(table, id) {
  if (isReadOnly()) throw new Error("Read-only access — can't delete.");
  try { const d0 = loadData(); const rec = (d0[table] || []).find(x => x.id === id); if (rec && !SKIP_DELLOG) logDeletion(table, rec, d0); } catch {}
  await deleteRecordRaw(table, id);
  const { data: left, error } = await supabase.from(table).select("id").eq("id", id);
  if (error) throw error;
  if (left && left.length) throw new Error(`The cloud did not allow deleting this ${table} record`);
  if (!SKIP_DELLOG) await logCloudDeletes([id]);
}
// ── Shared "deleted" list in the cloud ──────────────────────────────────────
// Each device used to remember its own deletions only. If another device (or the
// iPad's Safari vs Home Screen copy) still had the record, it could put it back.
// Now every delete is also written to app_config key 'deleted', and every device
// reads that list when it syncs, so a deleted record stays deleted everywhere.
let SKIP_DELLOG = false;
const DELLOG_DAYS = 180;
async function readCloudDeletesFull() {
  const { data: row, error } = await supabase.from("app_config").select("value").eq("key", "deleted").maybeSingle();
  if (error) throw error;
  const v = (row && row.value) || {};
  return { ids: v.ids || {}, undone: v.undone || {} };
}
async function readCloudDeletes() { return (await readCloudDeletesFull()).ids; }
// Take records OFF the shared deleted list (used by Restore and by Undo), so no device deletes them again.
async function undeleteInCloud(ids) {
  if (!ids || !ids.length) return;
  const cur = await readCloudDeletesFull();
  const now = Date.now();
  const nextIds = { ...cur.ids }, undone = { ...cur.undone };
  ids.forEach(id => { delete nextIds[id]; undone[id] = now; });
  const { error } = await supabase.from("app_config").upsert({ key: "deleted", value: { ids: nextIds, undone }, updated_at: now }, { onConflict: "key" });
  if (error) throw error;
}
async function logCloudDeletes(ids) {
  try {
    const cur = await readCloudDeletesFull().catch(() => ({ ids: {}, undone: {} }));
    const now = Date.now(), cutoff = now - DELLOG_DAYS * 864e5;
    const next = {}, undone = {};
    Object.entries(cur.ids).forEach(([k, t]) => { if (Number(t) > cutoff) next[k] = t; });
    Object.entries(cur.undone).forEach(([k, t]) => { if (Number(t) > cutoff) undone[k] = t; });
    ids.forEach(id => { if (id) { next[id] = now; delete undone[id]; } });
    await supabase.from("app_config").upsert({ key: "deleted", value: { ids: next, undone }, updated_at: now }, { onConflict: "key" });
  } catch { /* best effort — the local tombstone still applies on this device */ }
}
async function applyCloudDeletes() {
  try {
    const full = await readCloudDeletesFull();
    // Deletions an admin has undone: lift them on this device too (so they're not deleted again).
    const undoneIds = Object.keys(full.undone || {});
    if (undoneIds.length) removeTombstones(undoneIds);
    const ids = Object.keys(full.ids);
    if (!ids.length) return;
    const have = new Set(getTombstones());
    const fresh = ids.filter(id => !have.has(id));
    if (!fresh.length) return;
    try { const t = getTombstones(); localStorage.setItem(TOMB_KEY, JSON.stringify([...t, ...fresh])); } catch {}
    const dead = new Set(fresh);
    const d = loadData();
    let changed = false;
    const next = { ...d };
    ["customers", "enquiries", "jobs", "vehicles", "staff"].forEach(t => { const before = (d[t] || []).length; next[t] = (d[t] || []).filter(r => !dead.has(r.id)); if (next[t].length !== before) changed = true; });
    if (changed) setDB(JSON.stringify(next));
  } catch { /* offline or not set up yet */ }
}
// Deleted on this device but still in the cloud? Try again (runs on every successful sync).
async function purgeTombstoned(cloud) {
  const dead = new Set(getTombstones());
  if (!dead.size) return;
  for (const t of ["customers", "enquiries", "jobs", "vehicles", "staff"]) {
    for (const r of (cloud[t] || [])) { if (dead.has(r.id)) { try { await deleteRecord(t, r.id); } catch {} } }
  }
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
// ── "Delete everything" reaching other devices ─────────────────────────────
// A wipe leaves a marker in the cloud (app_config key 'wipe'). Any device that
// hasn't seen that marker yet drops its old customers/enquiries/jobs, rather
// than keeping (and later re-uploading) its own copies.
const WIPE_SEEN_KEY = "removals_wipe_seen";
async function applyRemoteWipe() {
  try {
    const { data: row, error } = await supabase.from("app_config").select("value").eq("key", "wipe").maybeSingle();
    if (error) return;
    const at = row && row.value && row.value.at;
    if (!at) return;
    let seen = ""; try { seen = localStorage.getItem(WIPE_SEEN_KEY) || ""; } catch {}
    if (seen && seen >= at) return;
    let sigs = {}; try { sigs = JSON.parse(localStorage.getItem(SIG_KEY) || "{}"); } catch {}
    const d = loadData();
    const wiped = [];
    const keep = (t) => (d[t] || []).filter(r => { if (Object.prototype.hasOwnProperty.call(sigs, r.id)) { wiped.push(r.id); return false; } return true; });
    const next = { ...d, customers: keep("customers"), enquiries: keep("enquiries"), jobs: keep("jobs") };
    wiped.forEach(id => { delete sigs[id]; });
    setDB(JSON.stringify(next));
    localStorage.setItem(SIG_KEY, JSON.stringify(sigs));
    localStorage.setItem(WIPE_SEEN_KEY, at);
  } catch { /* offline or table missing — try again next sync */ }
}
async function pullCloud() {
  await applyRemoteWipe();
  await applyCloudDeletes();
  return pullFromCloud();
}

async function doPullSync(setData, setSyncStatus, opts) {
  const force = opts && opts.force;
  if (SAVING_IN_PROGRESS) return;
  const ae = document.activeElement;
  if (ae && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) return; // don't disrupt an open field/picker
  const now = Date.now();
  if (!force && now - LAST_SYNC_AT < 30000) return; // throttle
  LAST_SYNC_AT = now;
  try {
    const cloud = await pullCloud();
    const readOnly = (opts && opts.readOnly) || CURRENT_USER.role === "crew" || CURRENT_USER.role === "viewer";
    if (!readOnly) purgeTombstoned(cloud).catch(() => {});
    const merged = mergeAll(cloud, loadData());
    setDB(JSON.stringify(merged));
    if (!readOnly) pushChangedOnly(merged).catch(() => {});
    if (!readOnly) flushLog().catch(() => {});
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
    const deadIds = new Set(getTombstones());
    for (const rec of data[name] || []) {
      if (deadIds.has(rec.id)) continue; // deleted — never upload it again
      const sig = dbSig(name, rec);
      if (sigs[rec.id] !== sig) changed.push({ name, rec, sig });
      else newSigs[rec.id] = sig;
    }
  }
  // Lots to send (e.g. after an import): send them 100 at a time. Any batch that fails is
  // left for the one-at-a-time uploads below, which report exactly which record is the problem.
  if (changed.length > 30) {
    const rest = [];
    for (const name of TABLES) {
      const list = changed.filter(x => x.name === name);
      for (let i = 0; i < list.length; i += 100) {
        const chunk = list.slice(i, i + 100);
        try { await pushMany(name, chunk.map(x => x.rec)); chunk.forEach(x => { newSigs[x.rec.id] = x.sig; }); }
        catch { rest.push(...chunk); }
      }
    }
    changed.length = 0; changed.push(...rest);
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
    try { setDB(JSON.stringify(d2)); } catch {}
    pushChangedOnly(d2).catch(() => {});
  } catch {}
}

function upsertLocal(data, table, record) {
  const arr = data[table] || [];
  const idx = arr.findIndex(r => r.id === record.id);
  const next = idx >= 0 ? arr.map(r => r.id === record.id ? record : r) : [...arr, record];
  return { ...data, [table]: next };
}

// Build label — date/time and commit are stamped automatically by vite.config.js on each deploy
const BUILD_NO = "B241";
const BUILD_LABEL = (() => {
  const t = typeof __BUILD_TIME__ !== "undefined" ? new Date(__BUILD_TIME__) : null;
  const sha = typeof __BUILD_SHA__ !== "undefined" ? __BUILD_SHA__ : "";
  if (!t || isNaN(t)) return BUILD_NO;
  const when = t.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
  return `${BUILD_NO} · ${when}${sha ? ` (${sha})` : ""}`;
})();

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
    <span style={{ display: "inline-flex", alignItems: "center", padding: "2px 10px", borderRadius: 99, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0, color: m.color, background: m.bg, border: `1px solid ${m.color}33` }}>
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
function Input({ value, onChange, type = "text", placeholder, required, autoComplete, name, inputMode, noAutofill }) {
  return <input style={inputStyle} type={type} value={value ?? ""} onChange={e => onChange(e.target.value)} placeholder={placeholder} required={required} autoComplete={noAutofill ? "off" : autoComplete} name={name} inputMode={inputMode} />;
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
  // One button family across the app: same shape, border, weight and shadow — only the colour changes.
  const base = { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, borderRadius: 11, fontWeight: 700, cursor: disabled ? "not-allowed" : "pointer", border: "1.5px solid transparent", fontFamily: "inherit", lineHeight: 1.2, transition: "transform .15s, opacity .15s", boxShadow: "0 1px 3px rgba(16,33,30,.10)" };
  const v = {
    primary: { background: TEAL, borderColor: TEAL, color: "#fff", boxShadow: "0 3px 10px rgba(14,124,115,.24)" },
    amber: { background: AMBER, borderColor: AMBER, color: "#fff", boxShadow: "0 3px 10px rgba(245,158,11,.28)" },
    ghost: { background: "#fff", borderColor: "#BFDCD7", color: TEAL_D },
    danger: { background: "#FEF2F2", borderColor: "#FCA5A5", color: "#B91C1C" },
    grey: { background: "#fff", borderColor: "#D3DDDB", color: "#24403B" },
  };
  const p = size === "sm" ? { padding: "8px 14px", fontSize: 13.5 } : { padding: "11px 18px", fontSize: 14.5 };
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
        <div style={{ overflowY: "auto", padding: "0 20px 20px", flex: 1 }}>
          {isReadOnly()
            ? <><div style={{ fontSize: 12, fontWeight: 700, color: "#6B7280", background: "#F3F4F6", borderRadius: 8, padding: "6px 10px", marginBottom: 12 }}>👁 View only</div><div className="rm-ro">{children}</div></>
            : children}
        </div>
      </div>
    </div>
  );
}
// Read-only users: everything inside a pop-up is look-only. Room headers (data-ro-ok) can still open/close.
const RO_CSS = `.rm-ro *{pointer-events:none!important}
.rm-ro [data-ro-ok],.rm-ro [data-ro-ok] *{pointer-events:auto!important}
.rm-ro button:not([data-ro-ok]):not([data-ro-show]){display:none!important}
.rm-ro input,.rm-ro textarea,.rm-ro select{background:#F9FAFB!important;color:#10211E!important;-webkit-text-fill-color:#10211E}`;
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
// Volume to be moved for a job (from its survey), e.g. "850 cu ft". Items marked NOT MOVING are left out.
// Hanging wardrobe (H/W) boxes in a survey: freehand per-room counts or catalogue "Wardrobe Box" lines.
function hwBoxes(inv) {
  return (inv || []).reduce((n, it) => n + ((it && it.qty > 0 && (it.wardrobe || /wardrobe box/i.test(it.name || ""))) ? Number(it.qty) || 0 : 0), 0);
}
// ── Furniture covers (equipment required) ──
// Worked out from the survey (detailed list OR freehand text): sofas, armchairs and mattresses.
// Corner sofa = 1 × 2 seater + 1 × 3 seater cover. 3 piece suite = 3 seater + 2 armchairs.
// A sofa with no size given gets a 3 seater cover (the bigger one always fits).
const COVER_TYPES = ["3 Seater Sofa", "2 Seater Sofa", "Armchair", "King Mattress", "Double Mattress", "Single Mattress"];
const COVER_CATALOG = { "cons-sofa": { "2 Seater Sofa": 1 } };
const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
const COVER_RE = /\b(?:(\d+|one|two|three|four|five|six)\s*(?:x|×)\s*|(\d+|one|two|three|four|five|six)\s+(?=[a-z]))?((?:3|three)[\s-]*(?:piece|pce|pc)[\s-]*suites?|(?:large\s+|small\s+)?corner[\s-]*(?:sofa|settee|couch|suite|unit)s?(?:\s*\/\s*sectional)?|sectional(?:\s*(?:sofa|settee|couch))?s?|(?:[34]|three|four)[\s-]*seat(?:er|ed)?(?:\s*(?:sofa|settee|couch)(?:es|s)?)?(?![\s-]*(?:dining|kitchen|garden|patio|table|bench))|(?:2|two)[\s-]*seat(?:er|ed)?(?:\s*(?:sofa|settee|couch)(?:es|s)?)?(?![\s-]*(?:dining|kitchen|garden|patio|table|bench))|(?<!(?:garden|rattan|patio|outdoor|conservatory)\s)(?:sofa[\s-]*beds?|sofas?|settees?|couch(?:es)?)|arm[\s-]*chairs?|easy[\s-]*chairs?|recliners?(?:\s*chairs?)?|wing[\s-]*(?:back[\s-]*)?chairs?|(?:super[\s-]*)?king[\s-]*(?:size[d]?\s*)?mattress(?:es)?|(?:small[\s-]*)?double[\s-]*mattress(?:es)?|single[\s-]*mattress(?:es)?|cot[\s-]*mattress(?:es)?|mattress(?:es)?(?![\s-]*(?:topper|protector|cover)))\b(?:\s*(?:x|×)\s*(\d+))?/gi;
// Freehand only: a bed includes its mattress (we don't write mattresses separately), so each bed
// gets a mattress cover. Bunk bed = 2 singles; cabin / high / mid sleeper / cot bed = single;
// a bed with no size given = double. Sofa beds, dog beds, day beds, air beds etc. are ignored.
const BED_RE = /\b(?:(\d+|one|two|three|four|five|six)\s*(?:x|×)\s*|(\d+|one|two|three|four|five|six)\s+(?=[a-z]))?(?<!(?:sofa|dog|cat|pet|garden|flower|raised|day|camp|air|futon|water|plant|seed)[\s-]?)((?:(?:super[\s-]*)?king(?:[\s-]*size[d]?)?|(?:small[\s-]*)?double|single|bunk|cabin|cot|guest|divan|kids?|childs?|children'?s)?[\s-]*(?:beds?|divans?)|high[\s-]*sleepers?|mid[\s-]*sleepers?)\b(?:\s*(?:x|×)\s*(\d+))?/gi;
function bedsInText(chunk, add) {
  const re = new RegExp(BED_RE.source, "gi"); let m, found = false;
  while ((m = re.exec(chunk))) {
    const w = m[3].toLowerCase().trim();
    if (!w) continue;
    found = true;
    const q0 = m[1] || m[2] || m[4];
    const q = q0 ? (NUM_WORDS[q0.toLowerCase()] || parseInt(q0, 10) || 1) : 1;
    if (/bunk/.test(w)) add("Single Mattress", q * 2);
    else if (/king/.test(w)) add("King Mattress", q);
    else if (/single|cabin|cot|sleeper|kid|child/.test(w)) add("Single Mattress", q);
    else add("Double Mattress", q);
  }
  return found;
}
function coversInText(text, mult = 1, add, withBeds = false) {
  String(text || "").split(/\n|,|;|·/).forEach(line => {
    // "Double bed & mattress" → one cover, not two.
    const hasBed = withBeds && bedsInText(line, add);
    line.split(/\+|&|\band\b|\bwith\b/i).forEach(chunk => {
    const re = new RegExp(COVER_RE.source, "gi"); let m;
    while ((m = re.exec(chunk))) {
      if (hasBed && /mattress/i.test(m[3])) continue;
      const q0 = m[1] || m[2] || m[4];
      const q = (q0 ? (NUM_WORDS[q0.toLowerCase()] || parseInt(q0, 10) || 1) : 1) * mult;
      const w = m[3].toLowerCase();
      if (/piece|pce|pc/.test(w) && /suite/.test(w)) { add("3 Seater Sofa", q); add("Armchair", q * 2); }
      else if (/corner|sectional/.test(w)) { add("2 Seater Sofa", q); add("3 Seater Sofa", q); }
      else if (/^(2|two)[\s-]*seat/.test(w)) add("2 Seater Sofa", q);
      else if (/seat|sofa|settee|couch/.test(w)) add("3 Seater Sofa", q);
      else if (/chair|recliner/.test(w)) add("Armchair", q);
      else if (/king/.test(w)) add("King Mattress", q);
      else if (/single|cot/.test(w)) add("Single Mattress", q);
      else add("Double Mattress", q); // double, small double, or size not given
    }
    });
  });
}
function coversRequired(inv) {
  const tot = {};
  const add = (k, q) => { if (q > 0) tot[k] = (tot[k] || 0) + q; };
  (inv || []).forEach(it => {
    if (!it || it.wardrobe || it.dismantleNote || !(Number(it.qty) > 0)) return;
    const qty = Number(it.qty) || 1;
    const fixed = it.catalogId && COVER_CATALOG[it.catalogId];
    if (fixed) Object.entries(fixed).forEach(([k, n]) => add(k, n * qty));
    else coversInText(it.freehand ? (it.raw ?? it.name) : it.name, it.freehand ? 1 : qty, add, !!it.freehand);
  });
  return COVER_TYPES.filter(k => tot[k]).map(k => ({ name: k + " Cover", qty: tot[k] }));
}
const coversText = list => (list || []).map(c => `${c.qty} × ${c.name}`).join(", ");
function CoversBox({ inv }) {
  const list = coversRequired(inv);
  if (!list.length) return null;
  return (
    <div style={{ fontSize: 14, fontWeight: 800, color: "#10211E", background: "#F3FAF8", borderRadius: 9, padding: "7px 10px", marginBottom: 8 }}>
      🛋 Equipment required
      {list.map(c => <div key={c.name} style={{ fontSize: 13.5, fontWeight: 700, color: "#374151", paddingLeft: 8 }}>{c.qty} × {c.name}</div>)}
    </div>
  );
}
function jobVolume(data, j) {
  const e = j && (data.enquiries || []).find(x => x.id === j.enquiryId);
  if (!e) return 0;
  let v = Number(e.volumeCuFt) || 0;
  if (!v && Array.isArray(e.inventory)) v = e.inventory.filter(it => !it.notMoving).reduce((a, it) => a + (Number(it.cuFt) || 0) * (Number(it.qty) || 1), 0);
  return Math.round(v);
}
const volText = (data, j) => { const v = jobVolume(data, j); return v ? `${v.toLocaleString("en-GB")} cu ft` : ""; };
function moveRef(data, job) {
  const c = (data.customers || []).find(x => x.id === job.customerId);
  const seq = moveSeqOf(data, job);
  return (c && c.ref) ? `#${c.ref}/${seq}` : `Move ${seq}`;
}
// Mark an enquiry lost (the reason shows on the customer screen under that enquiry).
function withLost(d, en, reason) {
  return upsertLocal(d, "enquiries", { ...en, status: "Lost", lostReason: reason });
}
// Delete a customer together with their enquiries and moves, everywhere (this device + cloud).
async function deleteCustomerFully(d, customerId) {
  const enqs = (d.enquiries || []).filter(e => e.customerId === customerId);
  const jobs = (d.jobs || []).filter(j => j.customerId === customerId);
  for (const [t, recs] of [["jobs", jobs], ["enquiries", enqs], ["customers", [{ id: customerId }]]]) {
    for (const r of recs) { addTombstone(r.id); try { await deleteRecord(t, r.id); } catch {} }
  }
  const gone = new Set([customerId, ...enqs.map(e => e.id), ...jobs.map(j => j.id)]);
  return { ...d, customers: (d.customers || []).filter(x => !gone.has(x.id)), enquiries: (d.enquiries || []).filter(x => !gone.has(x.id)), jobs: (d.jobs || []).filter(x => !gone.has(x.id)) };
}
function customerDeleteSummary(d, customerId) {
  const ne = (d.enquiries || []).filter(e => e.customerId === customerId).length, nj = (d.jobs || []).filter(j => j.customerId === customerId).length;
  const bits = [ne ? `${ne} enquir${ne === 1 ? "y" : "ies"}` : "", nj ? `${nj} move${nj === 1 ? "" : "s"}` : ""].filter(Boolean);
  return bits.length ? ` This also deletes their ${bits.join(" and ")}.` : "";
}
// We decided not to quote (too far, too small, not our kind of job…). Doesn't count against win rates.
async function markNotQuotedFlow(data, en) {
  const cur = en.status === "Not quoted" ? en.lostReason : "";
  const reason = await pickLostReason(NOT_QUOTED_REASONS.includes(cur) ? cur : (cur ? "Other" : ""), { list: NOT_QUOTED_REASONS, title: "Why didn't we quote?" });
  if (reason === null) return;
  await saveAndReload(upsertLocal(data, "enquiries", { ...en, status: "Not quoted", lostReason: reason, updatedAt: Date.now() }));
}
// Ask for a reason and mark lost. Cancel = no change.
async function markLostFlow(data, en) {
  const reason = await pickLostReason(normalizeLost(en.lostReason));
  if (reason === null) return;
  await saveAndReload(withLost(data, en, reason));
}

// Survey date/time has passed and it hasn't been done (includes earlier today).
function surveyOverdue(e) {
  if (!e || !e.surveyDate || e.surveyDone || (e.inventory && e.inventory.length) || e.status !== "New") return false;
  const t = todayISO();
  if (e.surveyDate < t) return true;
  if (e.surveyDate === t && e.surveyTime) { const n = new Date(); return e.surveyTime <= String(n.getHours()).padStart(2, "0") + ":" + String(n.getMinutes()).padStart(2, "0"); }
  return false;
}
// Quick pop-up to give an out-of-date survey a new date/time. Once saved it's a normal "Survey booked" again.
function RescheduleSurveyModal({ data, enquiry, onClose }) {
  const tomorrow = isoAdd(todayISO(), { days: 1 });
  const [date, setDate] = useState(enquiry.surveyDate && enquiry.surveyDate >= todayISO() ? enquiry.surveyDate : tomorrow);
  const [time, setTime] = useState(enquiry.surveyTime || "");
  const [surveyor, setSurveyor] = useState(enquiry.surveyor || "");
  const surveyors = Array.from(new Set([...(data.staff || []).filter(s => s.role === "Surveyor").map(s => s.name), surveyor].filter(Boolean)));
  async function save() {
    if (!date) { alert("Pick the new survey date."); return; }
    await saveAndReload(upsertLocal(data, "enquiries", { ...enquiry, surveyDate: date, surveyTime: time, surveyor, surveyDone: false, status: "New", lostReason: "" }));
  }
  return (
    <Modal title={`Reschedule survey — ${custName(data, enquiry.customerId)}`} onClose={onClose}>
      {enquiry.surveyDate && <div style={{ fontSize: 13, color: "#B91C1C", fontWeight: 600, marginBottom: 12 }}>Was due {fmtDate(enquiry.surveyDate)} ({dow(enquiry.surveyDate)}){enquiry.surveyTime ? ` · ${enquiry.surveyTime}` : ""}</div>}
      <Field label="New survey date"><Input type="date" value={date} onChange={setDate} /></Field>
      <Field label="Time"><Input type="time" value={time} onChange={setTime} /></Field>
      {surveyors.length > 0 && <Field label="Surveyor"><Select value={surveyor} onChange={setSurveyor} options={surveyors} placeholder="Select surveyor…" /></Field>}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 8, marginTop: 6 }}>
        <Btn variant="grey" style={{ width: "100%" }} onClick={onClose}>Cancel</Btn>
        <Btn style={{ width: "100%" }} onClick={save}>📅 Save new date</Btn>
      </div>
    </Modal>
  );
}

// What an enquiry's badge says: a New enquiry with a survey date shows "Survey booked" (or "Survey missed").
function enqStatus(e) {
  if (!e) return "";
  if (e.status === "New" && e.surveyDate) return isMissedSurvey(e) ? "Survey missed" : "Survey booked";
  return e.status;
}
// Badge for an enquiry anywhere in the app: once it has a move, show the move's status
// (Provisional / Confirmed / Completed) so it matches the move cards.
// ── Alternative quotes (e.g. Direct move vs Into store for the same customer) ──
// Options share a group: the first enquiry is the "root", copies point at it with altOf.
// Lists and Reports count a group once, using the option that got furthest.
const altRoot = e => (e && (e.altOf || e.id)) || "";
const altGroup = (data, e) => (data.enquiries || []).filter(x => altRoot(x) === altRoot(e));
// Re-open the other options when the booked one is taken off (customer changed their mind).
function altReopen(d, e) {
  altGroup(d, e).filter(x => x.id !== e.id && x.altClosed).forEach(x => {
    d = upsertLocal(d, "enquiries", { ...x, altClosed: false, status: Number(x.quoteTotal) > 0 ? "Quoted" : (x.volumeCuFt ? "Surveyed" : "New"), updatedAt: Date.now() });
  });
  // Keep the option that was booked as the selected one until you pick another.
  const root = altGroup(d, e).find(x => !x.altOf);
  if (root && altGroup(d, e).length > 1) d = upsertLocal(d, "enquiries", { ...root, altPick: e.id, updatedAt: Date.now() });
  return d;
}
function altReps(data, list) {
  const jobEnq = new Set((data.jobs || []).filter(j => j.status !== "Let Go").map(j => j.enquiryId));
  const rank = x => (x.status === "Won" || jobEnq.has(x.id)) ? 0
    : (["New", "Surveyed", "Quoted"].includes(x.status) && !x.altClosed) ? (x.altOf ? 2 : 1)
    : ["Lost", "Let Go"].includes(x.status) ? 3 : 4;
  // The option you've selected (altPick on the first enquiry) wins unless another is booked.
  const picks = {}; (list || []).forEach(x => { if (!x.altOf && x.altPick) picks[x.id] = x.altPick; });
  const score = x => { const r = rank(x); return r === 0 ? 0 : (picks[altRoot(x)] === x.id && !x.altClosed) ? 0.5 : r; };
  const best = {};
  (list || []).forEach(x => { const k = altRoot(x); if (!best[k] || score(x) < score(best[k]) || (score(x) === score(best[k]) && !x.altOf)) best[k] = x; });
  return (list || []).filter(x => best[altRoot(x)] === x);
}
// Net (ex VAT) value of a move/quote. Quotes with "Add VAT" ticked include 20% VAT in the price.
function netValue(e, j) {
  const gross = Number(j && j.price ? j.price : (e && e.quoteTotal)) || 0;
  return e && e.quoteVat ? gross / 1.2 : gross;
}
function enqBadge(data, e) {
  if (!e) return "";
  if (e.altClosed && e.status === "Not quoted") return "Alt. not chosen";
  const j = (data.jobs || []).find(x => x.enquiryId === e.id && x.status !== "Let Go");
  if (j) return jobBadge(j);
  return enqStatus(e);
}
// Sent quote waiting for an answer → remind to ring the customer.
function quoteChase(data, e) {
  if (!e || e.status !== "Quoted" || !(Number(e.quoteTotal) > 0) || e.quoteStatus !== "Sent") return null;
  if ((data.jobs || []).some(j => j.enquiryId === e.id)) return null;
  const cust = (data.customers || []).find(c => c.id === e.customerId) || {};
  const days = e.quoteSentDate ? Math.max(0, Math.round((new Date(todayISO() + "T00:00") - new Date(e.quoteSentDate + "T00:00")) / 86400000)) : null;
  return { phone: cust.phone || cust.homePhone || "", days, sent: e.quoteSentDate || "", lastCall: e.quoteChasedAt || "" };
}
// When a sent quote should come up in To do: on the date you picked, otherwise
// a week after it was sent (or a week after your last chase call).
function quoteChaseDue(e) {
  if (e.quoteChaseDate) return e.quoteChaseDate;
  const base = e.quoteChasedAt ? e.quoteChasedAt.slice(0, 10) : (e.quoteSentDate || todayISO());
  return isoAdd(base, { days: 7 });
}
function ChaseDateModal({ data, enquiry, onClose }) {
  const [date, setDate] = useState(quoteChaseDue(enquiry));
  const save = v => saveAndReload(upsertLocal(data, "enquiries", { ...enquiry, quoteChaseDate: v }));
  return (
    <Modal title={`Chase reminder — ${custName(data, enquiry.customerId)}`} onClose={onClose}>
      <div style={{ fontSize: 13, color: "#6A7B77", marginBottom: 12 }}>The quote will come up in your To do list on this date. If you don't pick one, it comes up a week after the quote was sent (or a week after your last chase call).</div>
      <Field label="Remind me on"><Input type="date" value={date} onChange={setDate} /></Field>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
        {[["In 3 days", 3], ["In 1 week", 7], ["In 2 weeks", 14], ["In 1 month", 30]].map(([l, n]) => <Btn key={l} variant="grey" size="sm" style={{ width: "100%" }} onClick={() => setDate(isoAdd(todayISO(), { days: n }))}>{l}</Btn>)}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 8, marginTop: 6 }}>
        <Btn variant="grey" style={{ width: "100%" }} onClick={() => save("")}>Use default</Btn>
        <Btn style={{ width: "100%" }} onClick={() => date && save(date)}>📅 Save date</Btn>
      </div>
    </Modal>
  );
}
function quoteChaseText(q) {
  const sent = q.days == null ? "Quote sent" : q.days === 0 ? "Quote sent today" : `Quote sent ${q.days} day${q.days !== 1 ? "s" : ""} ago`;
  return sent + (q.lastCall ? ` · last called ${fmtDateShort(q.lastCall.slice(0, 10))}` : " · not called yet");
}
// Ring the customer about their quote: logs the call and remembers when, without a full reload.
function callAboutQuote(e, phone) {
  try {
    logComm(e.customerId, { type: "Call", note: "Quote follow-up call" });
    const d = loadData();
    const en = (d.enquiries || []).find(x => x.id === e.id);
    if (en) { const d2 = upsertLocal(d, "enquiries", { ...en, quoteChasedAt: new Date().toISOString(), quoteChaseDate: "", noChase: false, updatedAt: Date.now() }); setDB(JSON.stringify(d2)); pushChangedOnly(d2).catch(() => {}); }
  } catch {}
  if (phone) window.location.href = `tel:${phone}`;
}
function ChaseCallBtn({ data, e, small }) {
  const q = quoteChase(data, e);
  if (!q || !q.phone) return null;
  return <Btn size="sm" style={{ whiteSpace: "nowrap", flexShrink: 0, ...(small ? { padding: "5px 10px", fontSize: 12 } : {}) }} onClick={ev => { ev.stopPropagation(); callAboutQuote(e, q.phone); }}>📞 Chase quote</Btn>;
}

// New enquiry with no survey booked yet → prompt to ring and book the survey.
function newEnqCall(data, e) {
  if (!e || e.status !== "New" || e.surveyDate) return null;
  const cust = (data.customers || []).find(c => c.id === e.customerId) || {};
  return { phone: cust.phone || cust.homePhone || "", lastCall: e.newCalledAt || "" };
}
function callNewEnquiry(e, phone) {
  try {
    logComm(e.customerId, { type: "Call", note: "New enquiry call — book survey" });
    const d = loadData();
    const en = (d.enquiries || []).find(x => x.id === e.id);
    if (en) { const d2 = upsertLocal(d, "enquiries", { ...en, newCalledAt: new Date().toISOString(), updatedAt: Date.now() }); setDB(JSON.stringify(d2)); pushChangedOnly(d2).catch(() => {}); }
  } catch {}
  if (phone) window.location.href = `tel:${phone}`;
}
function NewEnqCallBtn({ data, e, small }) {
  const q = newEnqCall(data, e);
  if (!q || !q.phone) return null;
  return <Btn size="sm" style={{ whiteSpace: "nowrap", flexShrink: 0, ...(small ? { padding: "5px 10px", fontSize: 12 } : {}) }} onClick={ev => { ev.stopPropagation(); callNewEnquiry(e, q.phone); }}>{small ? "📞 Call" : "📞 Call to book survey"}</Btn>;
}

// Quote reminder for a surveyed enquiry with no move yet: "build" or "send", else null.
function quoteTodo(data, e) {
  if (!e || ["Lost", "Let Go", "Not quoted", "Won"].includes(e.status) || (data.jobs || []).some(j => j.enquiryId === e.id)) return null;
  if (!(e.surveyDone || (e.inventory && e.inventory.length) || ["Surveyed", "Quoted"].includes(e.status))) return null;
  if (!(Number(e.quoteTotal) > 0)) return { t: "Quote to build", c: "#0369A1" };
  if (!["Sent", "Accepted"].includes(e.quoteStatus)) return { t: "⚠️ Quote not emailed", c: "#C2410C" };
  return null;
}
// Which Enquiries tile an enquiry belongs to (missed surveys sit under "Survey booked").
const enqGroup = e => (e.status === "New" && e.surveyDate) ? "Survey booked" : e.status;

// A survey is "missed" when its date has passed and it was never done (not surveyed, no inventory).
function isMissedSurvey(e, todayIso = todayISO()) {
  return !!(e && e.surveyDate && e.surveyDate < todayIso && !e.surveyDone && !(e.inventory && e.inventory.length)
    && !["Surveyed", "Quoted", "Won", "Lost", "Let Go", "Not quoted"].includes(e.status));
}
function missedSurveys(data) { const t = todayISO(); return (data.enquiries || []).filter(e => isMissedSurvey(e, t)).sort((a, b) => a.surveyDate.localeCompare(b.surveyDate)); }
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
// Home screen: "Upcoming surveys" and "Upcoming moves" are hidden for now while the staff
// get used to the app. Change false → true to bring them back (they're still on the Calendar).
const SHOW_UPCOMING_ON_HOME = false;

function Dashboard({ data, setView, setData }) {
  const enquiries = altReps(data, data.enquiries || []); // one per customer when there are alternative quotes
  const jobs = data.jobs || [];
  const dashShow = ""; // the Surveys / Moves / Servicing buttons were removed
  const [tmOpen, toggleTm] = useRemembered("removals_home_today_moves");
  const [homeBy, setHomeByRaw] = useState(() => { try { return localStorage.getItem("removals_home_dateby") === "move" ? "move" : "survey"; } catch { return "survey"; } });
  const setHomeBy = v => { setHomeByRaw(v); try { localStorage.setItem("removals_home_dateby", v); } catch {} };
  const [tsOpen, toggleTs] = useRemembered("removals_home_today_surveys");
  const [svOpen, toggleSv] = useRemembered("removals_home_servicing", false);
  const [usOpen, toggleUs] = useRemembered("removals_home_upsurveys", true);
  const [umOpen, toggleUm] = useRemembered("removals_home_upmoves", true);
  const [editFu, setEditFu] = useState(null);
  const [resched, setResched] = useState(null);
  const [chaseFor, setChaseFor] = useState(null);
  const [todoOpen, setTodoOpen] = useState(() => { try { return localStorage.getItem("removals_todo_hidden") !== "1"; } catch { return true; } });
  const toggleTodo = () => setTodoOpen(o => { try { localStorage.setItem("removals_todo_hidden", o ? "1" : "0"); } catch {} return !o; });
  const open = enquiries.filter(e => ["New", "Surveyed", "Quoted"].includes(e.status));
  const quotesOut = enquiries.filter(e => e.status === "Quoted");
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const thisMonthEnq = enquiries.filter(e => new Date(e.createdAt).getTime() >= monthStart);
  const wonThisMonth = thisMonthEnq.filter(e => e.status === "Won").length;
  const convRate = thisMonthEnq.length ? Math.round((wonThisMonth / thisMonthEnq.length) * 100) : 0;
  const upcoming = jobs
    .filter(j => j.status !== "Completed" && j.status !== "Let Go")
    .flatMap(j => jobStages(j).filter(st => st.date && st.date > todayISO()).map(st => ({ j, st })))
    .sort((a, b) => a.st.date.localeCompare(b.st.date));
  const followUps = [
    ...enquiries.filter(e => e.followUpDate && !["Lost", "Not quoted"].includes(e.status)).map(e => ({ kind: "enquiry", key: "e" + e.id, id: e.id, customerId: e.customerId, date: e.followUpDate, time: e.followUpTime || "", note: e.followUpNote, status: e.status })),
    ...(data.customers || []).filter(c => c.followUpDate).map(c => ({ kind: "customer", key: "c" + c.id, id: c.id, customerId: c.id, date: c.followUpDate, time: c.followUpTime || "", note: c.followUpNote })),
  ].sort((a, b) => ((a.date || "") + (a.time || "99:99")).localeCompare((b.date || "") + (b.time || "99:99"))).slice(0, 12);
  const custById = id => (data.customers || []).find(c => c.id === id) || {};
  const toCall = enquiries
    .filter(e => e.status === "New" && !e.surveyDate)
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  const todaysSurveys = enquiries
    .filter(e => e.surveyDate === todayISO() && !["Lost", "Not quoted"].includes(e.status))
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
  const upcomingServicing = (data.vehicles || []).flatMap(v => ((v.maint && v.maint.bookings) || []).map(b => ({ v, b }))).filter(({ b }) => b.start && bookingEnd(b) >= todayIso).sort((a, c) => (a.b.start || "").localeCompare(c.b.start || ""));
  const _dNow = new Date();
  const _thisYM = `${_dNow.getFullYear()}-${String(_dNow.getMonth() + 1).padStart(2, "0")}`;
  const _nd = new Date(_dNow.getFullYear(), _dNow.getMonth() + 1, 1);
  const _nextYM = `${_nd.getFullYear()}-${String(_nd.getMonth() + 1).padStart(2, "0")}`;
  // Home only looks ahead two weeks (today + 14 days).
  const twoWeeksIso = isoAdd(todayIso, { days: 14 });
  const inWindow = iso => !!iso && iso >= todayIso && iso <= twoWeeksIso;
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
  // Drop surveys once their date/time has passed (no time set = stays until the end of that day).
  const _now = new Date();
  const nowHM = String(_now.getHours()).padStart(2, "0") + ":" + String(_now.getMinutes()).padStart(2, "0");
  const surveyLapsed = e => e.surveyDate < todayIso || (e.surveyDate === todayIso && !!e.surveyTime && e.surveyTime <= nowHM);
  const isSurveyed = e => !!(e.surveyDone || (e.inventory && e.inventory.length) || ["Surveyed", "Quoted", "Won", "Lost", "Let Go", "Not quoted"].includes(e.status));
  // Upcoming surveys, plus today's that have passed but aren't marked surveyed (shown red).
  // Earlier days' missed surveys live in the red "Missed survey" box at the top instead.
  // A survey stays on Home until its quote has been built AND emailed (or a move is created).
  const hasMove = e => (data.jobs || []).some(j => j.enquiryId === e.id);
  const quoteBuilt = e => Number(e.quoteTotal) > 0;
  const quoteSent = e => quoteBuilt(e) && ["Sent", "Accepted"].includes(e.quoteStatus);
  const surveyStage = e => !isSurveyed(e) ? (surveyLapsed(e) ? "overdue" : "booked") : !quoteBuilt(e) ? "needQuote" : !quoteSent(e) ? "notSent" : "done";
  const upcomingSurveys = enquiries
    .filter(e => e.surveyDate && !["Lost", "Let Go", "Not quoted", "Won"].includes(e.status) && !hasMove(e))
    .filter(e => surveyStage(e) === "booked")
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
    <div onClick={onClick} style={{ flex: 1, display: "flex", alignItems: "baseline", gap: 7, background: "#fff", borderRadius: 10, padding: "7px 12px", boxShadow: "0 1px 3px rgba(0,0,0,.07)", cursor: onClick ? "pointer" : "default", border: "2px solid #F3F4F6", minWidth: 0 }}>
      <div style={{ fontSize: 17, fontWeight: 800, color, lineHeight: 1.4, flexShrink: 0 }}>{value}</div>
      <div style={{ fontSize: 12, color: "#6B7280", fontWeight: 600, lineHeight: 1.4, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}{sub && <span style={{ fontSize: 11, color: "#9CA3AF", fontWeight: 500 }}> · {sub}</span>}</div>
    </div>
  );

  return (
    <div>
      {(() => {
        // Two simple results for this month:
        //  • Quotes booked — of this month's surveys, how many have been booked (and the % / £).
        //  • Moves booked  — moves with a move date this month (count and £).
        const ym = todayISO().slice(0, 7);
        const jobOf = e => (data.jobs || []).find(x => x.enquiryId === e.id && x.status !== "Let Go");
        // Quotes booked in to see: survey visits with a survey date this month.
        const quotesDone = enquiries.filter(e => String(e.surveyDate || "").slice(0, 7) === ym);
        const seen = quotesDone.filter(e => e.surveyDone || (e.inventory && e.inventory.length) || ["Surveyed", "Quoted", "Won", "Lost"].includes(e.status)).length;
        const movesMonth = jobs.filter(j => j.status !== "Let Go" && String(jobMoveDate(j) || "").slice(0, 7) === ym);
        const mMoney = Math.round(movesMonth.reduce((t, j) => t + netValue((data.enquiries || []).find(e => e.id === j.enquiryId), j), 0) * 100) / 100;
        const monthName = new Date().toLocaleDateString("en-GB", { month: "long" });
        const tile = { flex: 1, minWidth: 0, background: "#fff", borderRadius: 12, padding: "10px 14px", boxShadow: "0 1px 3px rgba(0,0,0,.07)", border: "2px solid #F3F4F6", cursor: "pointer" };
        const big = { fontSize: 24, fontWeight: 800, lineHeight: 1.2 };
        const lab = { fontSize: 12.5, color: "#6B7280", fontWeight: 700 };
        return (
          <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
            <div style={tile} onClick={() => { try { localStorage.setItem("removals_enq_period", "month"); localStorage.setItem("removals_enq_dateby", "survey"); } catch {} setView({ screen: "enquiries", filter: "All" }); }}>
              <div style={lab}>Quotes booked in · {monthName}</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={{ ...big, color: AMBER }}>{quotesDone.length}</span>
                <span style={{ fontSize: 12, color: "#9CA3AF", fontWeight: 600 }}>to see this month</span>
              </div>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: "#41514E" }}>{seen} seen · {quotesDone.length - seen} to go</div>
            </div>
            <div style={tile} onClick={() => setView({ screen: "calendar", calShow: "moves", calMode: "agenda", date: todayISO() })}>
              <div style={lab}>Moving · {monthName}</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={{ ...big, color: "#2563EB" }}>{movesMonth.length}</span>
                <span style={{ fontSize: 12, color: "#9CA3AF", fontWeight: 600 }}>moving this month</span>
              </div>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: "#41514E" }}>{gbp(mMoney)} <span style={{ fontWeight: 600, color: "#9CA3AF", fontSize: 12 }}>net</span></div>
            </div>
          </div>
        );
      })()}

      <button onClick={() => setView({ screen: "newEnquiry" })} style={{ width: "100%", marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "5px 18px", borderRadius: 10, border: "none", background: AMBER, color: "#fff", fontWeight: 700, fontSize: 14, fontFamily: "inherit", cursor: "pointer", boxShadow: "0 4px 12px rgba(245,158,11,.30)" }}>
        <Icon name="plus" size={15} /> New Enquiry
      </button>

      {/* ── To do: every reminder in one list, most urgent first ── */}
      {(() => {
        const items = [];
        const phoneOf = cid => { const c = (data.customers || []).find(x => x.id === cid) || {}; return c.phone || c.homePhone || ""; };
        const markDone = en => saveAndReload(upsertLocal(data, "enquiries", { ...en, surveyDone: true, status: en.status === "New" ? "Surveyed" : en.status }));
        const openQuote = en => { try { sessionStorage.setItem("removals_open_quote", en.id); } catch {} setView({ screen: "enquiryDetail", id: en.id }); };
        const openEdit = en => { try { sessionStorage.setItem("removals_open_edit", en.id); } catch {} setView({ screen: "enquiryDetail", id: en.id }); };
        const go = en => setView({ screen: "enquiryDetail", id: en.id });
        const RED = { tint: { borderColor: "#FCA5A5", background: "#FEF2F2" }, col: "#B91C1C" };
        const ORANGE = { tint: { borderColor: "#FDBA74", background: "#FFF7ED" }, col: "#C2410C" };
        const AMBERC = { tint: { borderColor: "#FDE68A", background: "#FFFBEB" }, col: "#B45309" };
        const BLUE = { tint: { borderColor: "#BAE6FD", background: "#F0F9FF" }, col: "#0369A1" };
        const TEALC = { tint: { borderColor: "#CDE7E2", background: "#F4FBF9" }, col: TEAL_D };
        const sm = { width: "100%", minWidth: 0, padding: "8px 4px", whiteSpace: "nowrap", fontSize: 13 };
        enquiries.forEach(e => {
          if (["Lost", "Let Go", "Not quoted"].includes(e.status)) return;
          const route = `${e.fromTown || e.fromPostcode || "—"} → ${e.toTown || e.toPostcode || "—"}`;
          if (surveyOverdue(e)) items.push({ key: "ms" + e.id, p: 1, sort: e.surveyDate, e, ...RED, label: `⚠️ Missed survey · was due ${fmtDateShort(e.surveyDate)}${e.surveyTime ? ` ${e.surveyTime}` : ""}`, sub: route, acts: [
            <Btn key="r" size="sm" style={sm} onClick={() => setResched(e)}>Reschedule</Btn>,
            <Btn key="d" size="sm" variant="grey" style={sm} onClick={() => markDone(e)}>✓ Surveyed</Btn>,
            <Btn key="l" size="sm" variant="grey" style={{ ...sm, color: "#B91C1C" }} onClick={() => markLostFlow(data, e)}>✕ Lost</Btn>] });
          const qt = quoteTodo(data, e);
          if (qt && Number(e.quoteTotal) > 0) items.push({ key: "qs" + e.id, p: 3, sort: e.surveyDate || "", e, ...ORANGE, label: `⚠️ Send quote · ${gbp(e.quoteTotal)} built, not emailed`, sub: route, acts: [<Btn key="q" size="sm" variant="amber" style={sm} onClick={() => openQuote(e)}>📧 Email quote</Btn>] });
          else if (qt) items.push({ key: "qb" + e.id, p: 4, sort: e.surveyDate || "", e, ...BLUE, label: "Build quote · surveyed, no quote yet", sub: route, acts: [<Btn key="q" size="sm" variant="amber" style={sm} onClick={() => openQuote(e)}>Build quote</Btn>] });
          const nc = newEnqCall(data, e);
          if (nc) items.push({ key: "bs" + e.id, p: 6, sort: e.createdAt || "", e, ...TEALC, label: `Book survey · ${e.newCalledAt ? `last called ${fmtDateShort(e.newCalledAt.slice(0, 10))}` : "not called yet"}`, sub: route + (e.preferredDate ? ` · move ${fmtDateShort(e.preferredDate)}` : e.moveMonth ? ` · move ${fmtMonth(e.moveMonth)}` : ""), acts: [
            nc.phone ? <Btn key="c" size="sm" style={sm} onClick={() => callNewEnquiry(e, nc.phone)}>📞 Call</Btn> : null,
            <Btn key="b" size="sm" variant="grey" style={sm} onClick={() => openEdit(e)}>📅 Book survey</Btn>] });
          const qc = quoteChase(data, e);
          if (qc && !(e.noChase && !e.quoteChaseDate) && quoteChaseDue(e) <= todayISO()) items.push({ key: "qc" + e.id, p: 7, sort: quoteChaseDue(e), e, ...AMBERC, label: `Chase quote · ${quoteChaseText(qc).replace(/^Quote /, "")}`, sub: `${route} · ${gbp(e.quoteTotal)}`, acts: [
            qc.phone ? <Btn key="c" size="sm" style={sm} onClick={() => callAboutQuote(e, qc.phone)}>📞 Chase quote</Btn> : null,
            <Btn key="d" size="sm" variant="grey" style={sm} onClick={() => setChaseFor(e)}>📅 Remind later</Btn>] });
        });
        pastProvisional.forEach(({ j, last }) => items.push({ key: "pp" + j.id, p: 2, sort: last, cid: j.customerId, ...AMBERC, label: `Provisional move date passed · was ${fmtDateShort(last)}`, sub: `${j.fromTown || "—"} → ${j.toTown || "—"}`, onOpen: () => changeDate(j), acts: [
          <Btn key="c" size="sm" style={sm} onClick={() => changeDate(j)}>Change date</Btn>,
          canDelete() ? <Btn key="r" size="sm" variant="grey" style={{ ...sm, color: "#B91C1C" }} onClick={() => removeBooking(j)}>Remove booking</Btn> : null] }));
        followUps.forEach(fu => {
          const due = fu.date <= todayISO();
          const ph = phoneOf(fu.customerId), cust = (data.customers || []).find(x => x.id === fu.customerId) || {};
          const rec = fu.kind === "enquiry" ? (data.enquiries || []).find(x => x.id === fu.id) : cust;
          items.push({ key: "fu" + fu.key, p: due ? 5 : 8, sort: fu.date + (fu.time || ""), cid: fu.customerId, ...(due ? AMBERC : { tint: null, col: "#6A7B77" }), label: `Follow-up · ${due ? "due " : ""}${fmtDateShort(fu.date)}${fu.time ? ` ${fu.time}` : ""}`, sub: fu.note || "Follow up",
            onOpen: () => setView(fu.kind === "enquiry" ? { screen: "enquiryDetail", id: fu.id } : { screen: "customerDetail", id: fu.id }), acts: [
            ph ? <Btn key="c" size="sm" style={sm} onClick={() => { logComm(fu.customerId, { type: "Call" }); window.location.href = `tel:${ph}`; }}>📞 Call</Btn> : null,
            cust.email ? <Btn key="m" size="sm" variant="grey" style={sm} onClick={() => { logComm(fu.customerId, { type: "Email" }); window.location.href = `mailto:${cust.email}`; }}>📧 Email</Btn> : null,
            rec ? <Btn key="e" size="sm" variant="grey" style={sm} onClick={() => setEditFu({ record: rec, table: fu.kind === "enquiry" ? "enquiries" : "customers" })}>Reschedule</Btn> : null] });
        });
        items.sort((a, b) => a.p - b.p || (a.sort || "").localeCompare(b.sort || ""));
        return (
          <>
            <button onClick={toggleTodo} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, margin: "18px 0 8px", padding: "10px 14px", background: "#fff", border: `1.5px solid ${items.length ? "#FCA5A5" : "#E3E9E8"}`, borderRadius: 12, cursor: "pointer", fontFamily: "inherit", boxShadow: "0 1px 3px rgba(0,0,0,.06)" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 14, fontWeight: 800, color: "#10211E", textTransform: "uppercase", letterSpacing: ".05em" }}>To do</span>
                {items.length > 0
                  ? <span style={{ minWidth: 24, height: 24, padding: "0 7px", borderRadius: 99, background: "#DC2626", color: "#fff", fontSize: 13, fontWeight: 800, lineHeight: "24px", textAlign: "center" }}>{items.length}</span>
                  : <span style={{ fontSize: 12.5, fontWeight: 700, color: "#15803D" }}>✓ All caught up</span>}
              </span>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: "#6A7B77" }}>{todoOpen ? "Hide ▾" : "Show ▸"}</span>
            </button>
            {todoOpen && items.map(it => {
              const acts = it.acts.filter(Boolean);
              const open = it.onOpen || (() => go(it.e));
              return (
                <Card key={it.key} onClick={open} style={it.tint || undefined}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 10, fontWeight: 800, color: it.col, textTransform: "uppercase", letterSpacing: ".05em" }}>{it.label}</div>
                      <div style={{ fontWeight: 700, color: "#10211E" }}>{custName(data, it.e ? it.e.customerId : it.cid)}</div>
                      <div style={{ fontSize: 13, color: "#6A7B77" }}>{it.sub}</div>
                    </div>
                    {it.e && <StatusBadge status={enqBadge(data, it.e)} />}
                  </div>
                  {acts.length > 0 && <div onClick={ev => ev.stopPropagation()} style={{ display: "grid", gridTemplateColumns: `repeat(${acts.length}, 1fr)`, gap: 6, marginTop: 10 }}>{acts}</div>}
                </Card>
              );
            })}
          </>
        );
      })()}

      {/* ── Today: moves and surveys happening today ── */}
      {(() => {
        const tMoves = jobs.filter(j => j.status !== "Let Go").flatMap(j => jobStages(j).filter(st => st.date === todayIso).map(st => ({ j, st })))
          .sort((a, b) => (a.st.time || "99").localeCompare(b.st.time || "99"));
        const tSurveys = enquiries.filter(e => e.surveyDate === todayIso && !["Lost", "Let Go", "Not quoted"].includes(e.status))
          .sort((a, b) => (a.surveyTime || "99").localeCompare(b.surveyTime || "99"));
        return (
          <>
            <CollapseBar title="Today's moves" count={tMoves.length} open={tmOpen} onToggle={toggleTm} color={TEAL} emptyText="None today" />
            {tmOpen && tMoves.map(({ j, st }, ix) => {
              const provisional = !["Confirmed", "Completed"].includes(j.status);
              const vehNames = (st.vehicleIds || []).map(vid => { const v = (data.vehicles || []).find(x => x.id === vid); return v ? v.name : ""; }).filter(Boolean).join(", ");
              const resLine = provisional
                ? `${vehTypesSummary(st.vehTypes) || "Vehicle TBC"} · ${Number(st.staffCount) || "—"} crew (planned)`
                : `${vehNames || "No vehicle"}${(st.crew || []).length ? " · " + st.crew.join(", ") : ""}`;
              return (
                <Card key={"tm" + (j.id || "") + (st.id || ix)} onClick={() => setView(j.enquiryId ? { screen: "enquiryDetail", id: j.enquiryId } : { screen: "jobDetail", id: j.id })} style={{ borderColor: "#CDE7E2", background: "#F3FAF8" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 10, fontWeight: 800, color: TEAL_D, textTransform: "uppercase", letterSpacing: ".05em" }}>Today{st.time ? ` · ${st.time}` : ""} · {st.type || "Move"}</div>
                      <div style={{ fontWeight: 700, color: "#10211E" }}>{custName(data, j.customerId)}</div>
                      <div style={{ fontSize: 13, color: "#6A7B77" }}>{j.fromTown || "—"} → {j.toTown || "—"}{volText(data, j) ? <b style={{ color: "#10211E" }}> · 📦 {volText(data, j)}</b> : null}</div>
                      <div style={{ fontSize: 12.5, color: "#41514E", marginTop: 3, fontWeight: 600 }}>🚚 {resLine}</div>
                    </div>
                    <StatusBadge status={jobBadge(j)} />
                  </div>
                </Card>
              );
            })}
            <CollapseBar title="Today's surveys" count={tSurveys.length} open={tsOpen} onToggle={toggleTs} color={AMBER} emptyText="None today" />
            {tsOpen && tSurveys.map(e => {
              const done = isSurveyed(e), late = !done && surveyLapsed(e);
              const tint = done ? { borderColor: "#BBE6C9", background: "#F1F9F4" } : late ? { borderColor: "#FCA5A5", background: "#FEF2F2" } : { borderColor: "#FBE3B3", background: "#FFFBF2" };
              const col = done ? "#15803D" : late ? "#B91C1C" : "#B45309";
              return (
                <Card key={"ts" + e.id} onClick={() => setView({ screen: "enquiryDetail", id: e.id })} style={tint}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 10, fontWeight: 800, color: col, textTransform: "uppercase", letterSpacing: ".05em" }}>{done ? "✓ Done" : late ? "⚠️ Time passed" : "Today"}{e.surveyTime ? ` · ${e.surveyTime}` : ""}{e.surveyor ? ` · ${e.surveyor}` : ""}</div>
                      <div style={{ fontWeight: 700, color: "#10211E" }}>{custName(data, e.customerId)}</div>
                      <div style={{ fontSize: 13, color: "#6A7B77" }}>{e.fromTown || e.fromPostcode || "—"} → {e.toTown || e.toPostcode || "—"}</div>
                      <AltNote data={data} e={e} />
                      <ReasonLine e={e} />
                    </div>
                    <StatusBadge status={enqBadge(data, e)} />
                  </div>
                </Card>
              );
            })}
          </>
        );
      })()}


      {SHOW_UPCOMING_ON_HOME && (dashShow === "" || dashShow === "surveys") && (() => {
        const list = upcomingSurveys.filter(e => e.surveyDate !== todayIso && inWindow(e.surveyDate));
        const openQuote = (ev, e) => { ev.stopPropagation(); try { sessionStorage.setItem("removals_open_quote", e.id); } catch {} setView({ screen: "enquiryDetail", id: e.id }); };
        const STAGE = {
          booked:    { card: { borderColor: "#FBE3B3", background: "#FFFBF2" }, col: "#B45309", note: "" },
          overdue:   { card: { borderColor: "#FCA5A5", background: "#FEF2F2" }, col: "#B91C1C", note: "⚠️ Time passed — not marked surveyed" },
          needQuote: { card: { borderColor: "#BAE6FD", background: "#F0F9FF" }, col: "#0369A1", note: "✓ Surveyed — quote still to build" },
          notSent:   { card: { borderColor: "#FCA5A5", background: "#FFF7ED" }, col: "#C2410C", note: "⚠️ Quote built but not emailed yet" },
        };
        return (
        <div style={{ marginBottom: 18 }}>
          <CollapseBar title="Surveys · next 2 weeks" count={list.length} open={usOpen} onToggle={toggleUs} color={AMBER} emptyText="None booked" />
          {!usOpen ? null : list.map(e => { const stage = surveyStage(e); const S = STAGE[stage] || STAGE.booked; const overdue = stage === "overdue"; return (
            <Card key={e.id} onClick={() => setView({ screen: "enquiryDetail", id: e.id })} style={S.card}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  {S.note && <div style={{ fontSize: 10, fontWeight: 800, color: S.col, textTransform: "uppercase", letterSpacing: ".05em" }}>{S.note}{stage === "notSent" ? ` · ${gbp(e.quoteTotal)}` : ""}</div>}
                  <div style={{ fontSize: 10, fontWeight: 800, color: S.col, textTransform: "uppercase", letterSpacing: ".05em" }}>{fmtDate(e.surveyDate)} ({dow(e.surveyDate)}){e.surveyTime ? ` · ${e.surveyTime}` : ""}{e.surveyor ? ` · ${e.surveyor}` : ""}</div>
                  <div style={{ fontWeight: 700, color: "#10211E" }}>{custName(data, e.customerId)}</div>
                  <div style={{ fontSize: 13, color: "#6A7B77" }}>{e.fromTown || "—"} → {e.toTown || "—"}</div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flexShrink: 0 }}>
                  <StatusBadge status={enqBadge(data, e)} />
                  {stage === "needQuote" && <Btn size="sm" variant="amber" style={{ padding: "6px 10px", fontSize: 12.5 }} onClick={ev => openQuote(ev, e)}>Build quote</Btn>}
                  {stage === "notSent" && <Btn size="sm" variant="amber" style={{ padding: "6px 10px", fontSize: 12.5 }} onClick={ev => openQuote(ev, e)}>📧 Email quote</Btn>}
                  {overdue && <Btn size="sm" style={{ padding: "6px 10px", fontSize: 12.5 }} onClick={ev => { ev.stopPropagation(); setResched(e); }}>📅 Reschedule</Btn>}
                  {overdue && <Btn size="sm" variant="grey" style={{ padding: "6px 10px", fontSize: 12.5 }} onClick={ev => { ev.stopPropagation(); saveAndReload(upsertLocal(data, "enquiries", { ...e, surveyDone: true, status: e.status === "New" ? "Surveyed" : e.status })); }}>✓ Surveyed</Btn>}
                </div>
              </div>
            </Card>
          ); })}
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
                <StatusBadge status={jobBadge(j)} />
              </div>
            </Card>
          ))}
        </div>
      )}

      {SHOW_UPCOMING_ON_HOME && dashShow !== "surveys" && dashShow !== "servicing" && (() => {
        const list = upcoming.filter(({ st }) => inWindow(st.date));
        return (
        <>
          <CollapseBar title="Moves · next 2 weeks" count={list.length} open={umOpen} onToggle={toggleUm} color={TEAL} emptyText="None booked" />
          {!umOpen ? null : list.map(({ j, st }, ix) => {
            const provisional = !["Confirmed", "Completed"].includes(j.status);
            const vehNames = (st.vehicleIds || []).map(vid => { const v = (data.vehicles || []).find(x => x.id === vid); return v ? v.name : ""; }).filter(Boolean).join(", ");
            const resLine = provisional
              ? `${vehTypesSummary(st.vehTypes) || "Vehicle TBC"} · ${Number(st.staffCount) || "—"} crew (planned)`
              : `${vehNames || "No vehicle"}${(st.crew || []).length ? " · " + st.crew.length + " crew" : ""}`;
            return (
            <Card key={(j.id || "") + (st.id || ix)} onClick={() => setView(j.enquiryId ? { screen: "enquiryDetail", id: j.enquiryId } : { screen: "jobDetail", id: j.id })}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 10, fontWeight: 800, color: TEAL_D, textTransform: "uppercase", letterSpacing: ".05em" }}>{st.type || "Move"}{st.time ? ` · ${st.time}` : ""}</div>
                  <div style={{ fontWeight: 700, color: "#10211E" }}>{custName(data, j.customerId)}</div>
                  <div style={{ fontSize: 13, color: "#6A7B77" }}>{fmtDate(st.date)} ({dow(st.date)}) · {j.fromTown || "—"} → {j.toTown || "—"}</div>
                  <div style={{ fontSize: 12.5, color: "#41514E", marginTop: 3, fontWeight: 600 }}>🚚 {resLine}</div>
                </div>
                <StatusBadge status={jobBadge(j)} />
              </div>
            </Card>
            );
          })}
        </>
        );
      })()}
      {(dashShow === "" || dashShow === "servicing") && (() => {
        const list = upcomingServicing.filter(({ b }) => inWindow(b.start) || (b.start <= todayIso && bookingEnd(b) >= todayIso));
        return (
        <>
          {dashShow === "" && <CollapseBar title="Servicing · next 2 weeks" count={list.length} open={svOpen} onToggle={toggleSv} color="#475569" emptyText="None booked" />}
          {(dashShow !== "" || svOpen) && <div style={{ marginBottom: 18 }}>
            {list.length === 0 ? (dashShow !== "" ? <Empty icon="truck" text="No servicing in the next 2 weeks" /> : null) : list.map(({ v, b }, ix) => (
              <Card key={ix} onClick={() => setView({ screen: "calendar", calMode: "day", date: b.start })} style={{ borderColor: "#D3DEEA", background: "#F3F6FA" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 800, color: "#475569", textTransform: "uppercase", letterSpacing: ".05em" }}>{b.type}{b.days > 1 ? ` · ${b.days} days` : ""}</div>
                    <div style={{ fontWeight: 700, color: "#10211E" }}>{v.name}</div>
                    <div style={{ fontSize: 13, color: "#6A7B77" }}>{fmtDate(b.start)} ({dow(b.start)}){b.days > 1 ? ` – ${fmtDate(bookingEnd(b))} (${dow(bookingEnd(b))})` : ""}{b.motDate ? ` · MOT ${dow(b.motDate)}` : ""}</div>
                  </div>
                </div>
              </Card>
            ))}
          </div>}
        </>
        );
      })()}

      {resched && <RescheduleSurveyModal data={data} enquiry={resched} onClose={() => setResched(null)} />}
      {chaseFor && <ChaseDateModal data={data} enquiry={chaseFor} onClose={() => setChaseFor(null)} />}
      {editFu && <FollowUpModal data={data} record={editFu.record} table={editFu.table} onClose={() => setEditFu(null)} />}

    </div>
  );
}
// Tap-to-hide section header with a count (open/closed remembered per device)
function useRemembered(key, def = true) {
  const [open, setOpen] = useState(() => { try { const v = localStorage.getItem(key); return v == null ? def : v === "1"; } catch { return def; } });
  const toggle = () => setOpen(o => { try { localStorage.setItem(key, o ? "0" : "1"); } catch {} return !o; });
  return [open, toggle];
}
function CollapseBar({ title, count, open, onToggle, color = TEAL, emptyText }) {
  return (
    <button onClick={onToggle} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, margin: "14px 0 8px", padding: "10px 14px", background: "#fff", border: "1.5px solid #E3E9E8", borderRadius: 12, cursor: "pointer", fontFamily: "inherit", boxShadow: "0 1px 3px rgba(0,0,0,.06)" }}>
      <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 14, fontWeight: 800, color: "#10211E", textTransform: "uppercase", letterSpacing: ".05em" }}>{title}</span>
        {count > 0
          ? <span style={{ minWidth: 24, height: 24, padding: "0 7px", borderRadius: 99, background: color, color: "#fff", fontSize: 13, fontWeight: 800, lineHeight: "24px", textAlign: "center" }}>{count}</span>
          : <span style={{ fontSize: 12.5, fontWeight: 700, color: "#94A4A0" }}>{emptyText || "None"}</span>}
      </span>
      <span style={{ fontSize: 12.5, fontWeight: 700, color: "#6A7B77" }}>{open ? "Hide ▾" : "Show ▸"}</span>
    </button>
  );
}
function SectionTitle({ children }) {
  return <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", margin: "18px 0 8px", textTransform: "uppercase", letterSpacing: "0.05em" }}>{children}</div>;
}

// ── Enquiries list ──────────────────────────────────────────────────────────
function EnquiriesList({ data, setView, initialFilter }) {
  const [filterRaw, setFilter] = useState(initialFilter || "Surveyed");
  const enquiries = altReps(data, data.enquiries || []); // alternative quotes count once
  const filters = ["All", ...ENQUIRY_STATUSES];
  const moveCompleted = e => (data.jobs || []).some(j => j.enquiryId === e.id && j.status === "Completed");
  const moveOf = e => (data.jobs || []).find(j => j.enquiryId === e.id);
  const moveDateOf = e => { const j = moveOf(e); return (j && jobMoveDate(j)) || "9999-99"; };
  // Period: when the enquiry came in. Remembered on this device.
  const [period, setPeriodRaw] = useState(() => { try { return localStorage.getItem("removals_enq_period") || "all"; } catch { return "all"; } });
  const setPeriod = v => { setPeriodRaw(v); try { localStorage.setItem("removals_enq_period", v); } catch {} };
  const PERIODS = [["all", "All time"], ["month", "This month"], ["7", "Last week"], ["31", "Last month"], ["92", "Last 3 months"], ["183", "Last 6 months"], ["365", "Last year"], ["custom", "Custom dates…"]];
  const [custom, setCustomRaw] = useState(() => { try { return JSON.parse(localStorage.getItem("removals_enq_custom") || "null") || { from: "", to: "" }; } catch { return { from: "", to: "" }; } });
  const setCustom = v => { setCustomRaw(v); try { localStorage.setItem("removals_enq_custom", JSON.stringify(v)); } catch {} };
  const thisMonth = todayISO().slice(0, 7);
  // "Last month" = the whole of the previous calendar month; "Last week" = the previous Mon–Sun.
  const _now = new Date();
  const _iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const lastMonthFrom = _iso(new Date(_now.getFullYear(), _now.getMonth() - 1, 1));
  const lastMonthTo = _iso(new Date(_now.getFullYear(), _now.getMonth(), 0));
  const _mon = new Date(_now.getFullYear(), _now.getMonth(), _now.getDate() - ((_now.getDay() + 6) % 7)); // this Monday
  const lastWeekFrom = _iso(new Date(_mon.getFullYear(), _mon.getMonth(), _mon.getDate() - 7));
  const lastWeekTo = _iso(new Date(_mon.getFullYear(), _mon.getMonth(), _mon.getDate() - 1));
  const sinceISO = period === "all" ? "" : period === "custom" ? (custom.from || "") : period === "month" ? thisMonth + "-01" : period === "31" ? lastMonthFrom : period === "7" ? lastWeekFrom : new Date(Date.now() - Number(period) * 86400000).toISOString().slice(0, 10);
  const untilISO = period === "custom" ? (custom.to || "") : period === "month" ? thisMonth + "-31" : period === "31" ? lastMonthTo : period === "7" ? lastWeekTo : "";
  // Same date as Reports uses (survey date, or when it came in if there's no survey), so the
  // numbers here and in Reports always agree.
  // Which date the period looks at: survey date (default, matches Reports), move date or enquiry date.
  const [dateBy, setDateByRaw] = useState(() => { try { return localStorage.getItem("removals_enq_dateby") === "move" ? "move" : "survey"; } catch { return "survey"; } });
  const setDateBy = v => { setDateByRaw(v); try { localStorage.setItem("removals_enq_dateby", v); } catch {} };
  // Survey date hides New/Surveyed; move date also hides Survey booked/Not quoted — a hidden pick falls back to all.
  const hideTiles = dateBy === "survey" ? ["New", "Surveyed"] : ["New", "Surveyed", "Survey booked", "Quoted", "No date provisional", "Lost", "Not quoted", "Let Go", "All"];
  const filter = hideTiles.includes(filterRaw) ? (dateBy === "move" ? "Won" : "All") : filterRaw;
  const moveDay = e => { const j = moveOf(e); return (j && jobMoveDate(j)) || e.preferredDate || ""; };
  const cameIn = e => String(dateBy === "move" ? moveDay(e) : dateBy === "enquiry" ? (e.createdAt || e.enquiryDate || "") : (e.surveyDate || "")).slice(0, 10);
  const inPeriod = e => { const d = cameIn(e); if (!d) return !sinceISO && !untilISO; return (!sinceISO || d >= sinceISO) && (!untilISO || d <= untilISO); };
  const periodList = enquiries.filter(inPeriod);
  const baseList = periodList.filter(e => !moveCompleted(e));
  // Booked but no date yet gets its own tile ("No date provisional").
  const grp = e => { const j = moveOf(e); return j && j.status !== "Let Go" && jobBadge(j) === "No date provisional" ? "No date provisional" : enqGroup(e); };
  // Net £ value (ex VAT) of the moves in a tile: move price, or the quote if no price is set.
  const tileList = f => f === "Completed" ? periodList.filter(moveCompleted) : baseList.filter(e => grp(e) === f);
  const valueFor = f => Math.round(tileList(f).reduce((t, e) => t + netValue(e, moveOf(e)), 0) * 100) / 100;
  const countFor = f => f === "All" ? periodList.length : f === "Completed" ? periodList.filter(moveCompleted).length : f === "Open" ? baseList.filter(e => ["New", "Surveyed", "Quoted"].includes(e.status)).length : baseList.filter(e => grp(e) === f).length;
  const surveyedCount = enquiries.filter(e => e.status === "Surveyed").length;
  const shown = (filter === "All" || filter === "Completed" ? periodList : baseList)
    .filter(e => filter === "All" ? true : filter === "Completed" ? moveCompleted(e) : filter === "Open" ? ["New", "Surveyed", "Quoted"].includes(e.status) : grp(e) === filter)
    .sort((a, b) => filter === "Won"
      ? moveDateOf(a).localeCompare(moveDateOf(b))
      : (b.createdAt || "").localeCompare(a.createdAt || ""));
  try { sessionStorage.setItem("removals_enq_order", JSON.stringify(shown.map(e => e.id))); } catch {}

  return (
    <div>
      <div className="rm-page-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h2 className="rm-page-title" style={{ margin: 0, fontSize: 20, fontWeight: 800, color: "#111827" }}>Enquiries</h2>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <select value={dateBy} onChange={e => setDateBy(e.target.value)} aria-label="Which date" style={{ padding: "10px 8px", borderRadius: 10, border: "1.5px solid #D9E2E0", background: "#F3F7F6", fontSize: 14, fontWeight: 700, color: "#10211E", flexShrink: 0 }}>
          <option value="survey">Survey date</option>
          <option value="move">Move date</option>
        </select>
        <select value={period} onChange={e => setPeriod(e.target.value)} style={{ flex: 1, padding: "10px 12px", borderRadius: 10, border: "1.5px solid #D9E2E0", background: "#fff", fontSize: 15, fontWeight: 700, color: "#10211E" }}>
          {PERIODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
      {period !== "all" && period !== "custom" && sinceISO && <div style={{ fontSize: 12.5, fontWeight: 700, color: "#6A7B77", margin: "-4px 2px 10px" }}>{dateBy === "move" ? "Moves" : "Surveys"} {fmtDate(sinceISO)} – {untilISO ? fmtDate(untilISO.endsWith("-31") ? _iso(new Date(Number(untilISO.slice(0, 4)), Number(untilISO.slice(5, 7)), 0)) : untilISO) : "today"}</div>}
      {period === "custom" && (
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          {[["from", "From"], ["to", "To"]].map(([k, l]) => (
            <label key={k} style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#6A7B77", marginBottom: 3 }}>{l}</div>
              <input type="date" value={custom[k]} onChange={e => setCustom({ ...custom, [k]: e.target.value })} style={{ width: "100%", boxSizing: "border-box", padding: "9px 10px", borderRadius: 10, border: "1.5px solid #D9E2E0", background: "#fff", fontSize: 15, color: "#10211E" }} />
            </label>
          ))}
        </div>
      )}
      {/* Status tiles — same style as the dashboard stat cards. Tap a tile to filter. */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
        {["New", "Survey booked", ...ENQUIRY_STATUSES.filter(x => x !== "New").flatMap(x => x === "Won" ? ["Won", "No date provisional", "Completed"] : [x]), "All"].filter(f => !hideTiles.includes(f)).map(f => {
          const active = filter === f;
          const label = f === "Won" ? "Moves Booked" : f === "Completed" ? "Moves completed" : f === "All" ? "All enquiries" : f;
          const n = countFor(f);
          const meta = STATUS_META[f] || { color: "#374151", bg: "#F3F4F6" };
          const accent = f === "All" ? "#374151" : (meta.color || "#374151");
          return (
            <button key={f} onClick={() => setFilter(f)} style={{
              gridColumn: f === "All" ? "1 / -1" : "auto",
              textAlign: "left", minWidth: 0, cursor: "pointer", fontFamily: "inherit",
              background: active ? meta.bg : "#fff", borderRadius: 10, padding: "7px 12px", display: "flex", flexWrap: "wrap", alignItems: "baseline", columnGap: 7, rowGap: 0,
              border: active ? `2px solid ${accent}` : "2px solid #F3F4F6",
              boxShadow: "0 1px 3px rgba(0,0,0,.07)", transition: "all .15s",
            }}>
              <div style={{ fontSize: 17, fontWeight: 800, color: accent, lineHeight: 1.4 }}>{n}</div>
              <div style={{ fontSize: 12, color: "#6B7280", fontWeight: 600, lineHeight: 1.25, minWidth: 0, flex: 1 }}>{label}</div>
              {f !== "All" && dateBy !== "move" && periodList.length > 0 && <div style={{ fontSize: 11.5, fontWeight: 800, color: n ? accent : "#C4CDCB", lineHeight: 1.4, flexShrink: 0 }}>{Math.round((n / periodList.length) * 100)}%</div>}
              {(f === "Won" || f === "Completed") && <div style={{ width: "100%", fontSize: 13, fontWeight: 700, color: "#41514E", lineHeight: 1.3 }}>{gbp(valueFor(f))} <span style={{ fontWeight: 600, color: "#9CA3AF", fontSize: 11.5 }}>net</span></div>}
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
              <AltNote data={data} e={e} />
              <ReasonLine e={e} />
              <div style={{ fontSize: 13, color: "#6B7280", marginTop: 2 }}>{e.fromTown || "—"} → {e.toTown || "—"}</div>
              <div style={{ fontSize: 12, color: "#9CA3AF", marginTop: 2 }}>
                {(() => {
                  // Show the date being filtered on first, so the list matches the dates picked.
                  const j = moveOf(e); const md = j && jobMoveDate(j);
                  const mv = md ? "Move " + fmtDate(md) : (e.preferredDate ? "Move " + fmtDate(e.preferredDate) : "Move date TBC");
                  const sv = e.surveyDate ? "Survey " + fmtDate(e.surveyDate) : "";
                  const en = e.createdAt ? "Enquiry " + fmtDate(String(e.createdAt).slice(0, 10)) : "";
                  const order = dateBy === "move" ? [mv, sv] : dateBy === "enquiry" ? [en, sv, mv] : [sv, mv];
                  const [first, ...rest] = order.filter(Boolean);
                  return <>{first ? <b style={{ color: "#41514E" }}>{first}</b> : null}{rest.length ? " · " + rest.join(" · ") : ""}</>;
                })()}
                {e.volumeCuFt ? ` · ${e.volumeCuFt} cu ft` : ""}
                {e.quoteTotal ? ` · ${gbp(e.quoteTotal)}` : ""}
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0 }}>
              <StatusBadge status={enqBadge(data, e)} />
              {(() => { const q = quoteTodo(data, e); return q ? <span style={{ fontSize: 11.5, fontWeight: 800, color: q.c, whiteSpace: "nowrap" }}>{q.t}</span> : null; })()}
              <ChaseCallBtn data={data} e={e} small />
              <NewEnqCallBtn data={data} e={e} small />
            </div>
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
  const searchIndex = useMemo(() => q.trim() ? buildCustomerSearch(data) : {}, [data, !!q.trim()]);
  const filtered = q.trim() ? customers.filter(c => customerMatches(searchIndex, c, q)).slice(0, 50) : [];
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
            <Input value={q} onChange={setQ} placeholder="Search anything – name, address, phone, email…" />
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
          <div style={{ height: 10 }} />
          <ContactsEditor contacts={newCust.contacts || []} onChange={v => setNewCust({ ...newCust, contacts: v })} />
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
// ── Read a free-typed message ("We currently live in Hanham BS15 3NG…") ─────
// Picks out postcodes (which is from / which is to), towns, bedrooms, property
// types, packing, move month, chain status and any second contact number.
// Only fills fields the form itself didn't already fill.
const RM_MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const RM_NUMS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };
function readMessage(t, out, opts) {
  const o = opts || {};
  const lines = [];
  const msgM = t.match(/^[ \t]*(message|comments?|details|enquiry|your enquiry|additional information|further information|more information|notes?)[ \t]*:[ \t]*([\s\S]*?)(?=^[ \t]*(how did you|where did you|source|referr\w*)[^\n:]*:|$(?![\s\S]))/im);
  const msg = (msgM ? msgM[2] : t.split("\n").filter(l => !/^\s*[A-Za-z][A-Za-z /]{0,30}:/.test(l)).join(" ")).replace(/\s+/g, " ").trim();
  if (!msg) return { lines, message: "" };
  const lastIdx = (s, re) => { let i = -1, m; const g = new RegExp(re.source, "gi"); while ((m = g.exec(s))) i = m.index + m[0].length; return i; };
  const FROM_CUE = /(currently (live|living|reside|based)|we live|i live|live (in|at)|living (in|at)|moving from|move from|moving out of|our (current|existing) (home|house|property|address)|current (home|house|property|address)|selling|sold our|collect(ion)? from)/;
  const TO_CUE = /(buying|bought|purchas\w*|moving to|move to|moving into|new (home|house|property|address|place)|relocat\w* to|going to|deliver\w* to|completing on)/;
  const side = before => { const f = lastIdx(before, FROM_CUE), tt = lastIdx(before, TO_CUE); return f < 0 && tt < 0 ? "" : f > tt ? "from" : "to"; };

  // Postcodes
  const pcs = [];
  const PCG = /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/gi; let m;
  while ((m = PCG.exec(msg))) pcs.push({ pc: m[0].toUpperCase().replace(/\s+/g, " ").replace(/^(\S+?)(\d[A-Z]{2})$/, "$1 $2"), side: side(msg.slice(Math.max(0, m.index - 140), m.index)) });
  if (!o.lockPostcodes && pcs.length) {
    const f = pcs.find(p => p.side === "from"), to = pcs.find(p => p.side === "to");
    if (f || to) {
      if (f) out.fromPostcode = f.pc;
      if (to) out.toPostcode = to.pc;
      const rest = pcs.filter(p => p !== f && p !== to);
      if (!f && rest[0]) out.fromPostcode = rest.shift().pc;
      if (!to && rest[0]) out.toPostcode = rest.shift().pc;
    }
  }

  // Towns ("live in Hanham", "a property in Ilfracombe", "moving to Bath")
  const TOWN = "([A-Z][a-z'’-]+(?:(?:[ -](?:upon|on|under|in|le|by|super))?[ -][A-Z][a-z'’-]+)?)";
  const NOT_TOWN = /^(The|A|An|November|December|January|February|March|April|May|June|July|August|September|October|Nov|Dec|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Mon|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Spring|Summer|Autumn|Winter|We|I|It|Our)$/;
  const grab = re => { const r = msg.match(re); return r && !NOT_TOWN.test(r[1].split(/\s/)[0]) ? r[1].trim() : ""; };
  const SKIP = "(?:[a-z0-9-]+\\s+){0,6}?";
  if (!out.fromTown) out.fromTown = grab(new RegExp("(?:currently (?:live|living|based|reside)|we live|i live|living|based|moving from|move from|moving out of|selling)\\s+" + SKIP + "(?:in|at|from)\\s+" + TOWN)) || grab(new RegExp("(?:moving from|move from)\\s+" + TOWN));
  if (!out.toTown) out.toTown = grab(new RegExp("(?:buying|bought|purchasing|moving to|move to|moving into|relocating to|moving down to|moving up to)\\s+" + SKIP + "(?:in|at)\\s+" + TOWN)) || grab(new RegExp("(?:moving to|move to|relocating to|moving down to|moving up to)\\s+(?:the\\s+)?" + TOWN))
    || (/moving from|move from/i.test(msg) ? grab(new RegExp("\\bto\\s+(?:a|an|our|the)\\s+" + SKIP + "(?:in|at)\\s+" + TOWN)) : "");

  // Bedrooms + property type ("4 bed dormer bungalow", "three bedroom semi")
  const BED = /\b(\d|one|two|three|four|five|six|seven|eight)[\s-]*bed(?:room)?(?:ed|s)?\b\s*((?:[a-z]+[\s-]+){0,3}?(?:house|bungalow|flat|apartment|cottage|maisonette|semi|detached|terrace|terraced|townhouse|property|home|barn|farmhouse))?/gi;
  const beds = [];
  while ((m = BED.exec(msg))) {
    const n = /\d/.test(m[1]) ? m[1] : String(RM_NUMS[m[1].toLowerCase()] || "");
    const before = msg.slice(Math.max(0, m.index - 60), m.index);
    beds.push({ n, kind: (m[2] || "").trim(), side: side(before), text: m[0].trim() });
  }
  let fromBed = beds.find(b => b.side === "from") || null, toBed = beds.find(b => b.side === "to") || null;
  for (const b of beds) { if (b === fromBed || b === toBed) continue; if (!fromBed) fromBed = b; else if (!toBed) toBed = b; }
  if (fromBed) { if (!out.fromBedrooms) out.fromBedrooms = fromBed.n; if (!out.fromPropertyType && fromBed.kind) out.fromPropertyType = fromBed.kind; }
  if (toBed) { if (!out.toPropertyType && toBed.kind) out.toPropertyType = toBed.kind; if (toBed.n) out.toBedrooms = toBed.n; }
  if (!out.toPropertyType) { const k = msg.match(/\b(?:moving to|move to|moving into|buying|bought|purchasing|(?:from|in) [^.]{0,60}? to)\s+(?:a|an)\s+((?:[a-z]+[\s-]+){0,2}?(?:house|bungalow|flat|apartment|cottage|maisonette|semi|townhouse|barn conversion|farmhouse))/i); if (k) out.toPropertyType = k[1]; }
  if (!out.fromPropertyType) { const k = msg.match(/\b(?:we (?:have|live in|own)|currently (?:in|have)|our)\s+(?:a|an)?\s*((?:[a-z]+[\s-]+){0,2}(?:house|bungalow|flat|apartment|cottage|maisonette|semi|townhouse|barn conversion|farmhouse))/i); if (k) out.fromPropertyType = k[1]; }

  // Packing
  if (/(pack(?:ing)?\s+(?:it\s+|everything\s+|all\s+)?(?:ourselves|myself|themselves)|self[\s-]*pack|(?:do|done|doing|be doing)\s+(?:all\s+)?(?:of\s+)?(?:the|our|my)\s+(?:own\s+)?packing|(?:own|our) packing|packing ourselves|no packing)/i.test(msg)) lines.push("Packing: customer packing themselves");
  else if (/(packing service|pack for us|pack (?:everything|it all|up) for|need (?:help with )?packing|full pack|would like (?:you to )?pack|require packing|packing (?:required|needed))/i.test(msg)) lines.push("Packing: wants us to pack");
  if (/\bstorage\b|\bstore (?:our|some|the|my)\b/i.test(msg)) lines.push("Mentions storage");
  if (/piano|hot tub|safe\b|american fridge|range cooker|snooker|pool table|grandfather clock/i.test(msg)) lines.push("Heavy/special items mentioned: " + [...new Set((msg.match(/piano|hot tub|safe\b|american fridge|range cooker|snooker table|pool table|grandfather clock/gi) || []).map(s => s.toLowerCase()))].join(", "));

  // Move month(s)
  const monthHits = [];
  const MRE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/gi;
  while ((m = MRE.exec(msg))) { const i = RM_MONTHS.findIndex(x => x.startsWith(m[1].toLowerCase().slice(0, 3))); if (i >= 0 && !(m[1].toLowerCase() === "may" && !/\b(in|of|end of|early|late|mid|by|or|and|until|from)\s+may\b/i.test(msg.slice(Math.max(0, m.index - 10), m.index + 3)))) monthHits.push(RM_MONTHS[i]); }
  const months = [...new Set(monthHits)];
  if (months.length) {
    if (!out.preferredDate && !out.moveMonth) out.moveMonth = monthNameToYM(months[0]);
    lines.push("Move window: " + months.map(x => x[0].toUpperCase() + x.slice(1)).join(" or "));
  }
  if (/(not (?:yet )?(?:confirmed|got|set|fixed|agreed) (?:a |the )?date|no (?:fixed |confirmed |set )?(?:move )?date|date (?:is )?(?:tbc|to be confirmed|not confirmed|flexible)|dates? (?:are )?flexible|flexible (?:on|with) (?:the )?dates?|haven'?t (?:got|set|confirmed) a date)/i.test(msg)) { out.dateFlexible = true; lines.push("No date confirmed yet"); }

  // Chain
  const chain = [...new Set((msg.match(/cash buyer|first[- ]time buyers?|first in (?:the )?chain|chain[\s-]*free|no chain|nothing to sell|not in a chain|completion|exchanged?|exchange of contracts/gi) || []).map(s => s.toLowerCase()))];
  if (chain.length) lines.push("Chain: " + chain.join(", "));

  // Other contact numbers ("my husband's no is 07970… and his name is Andy")
  const mainP = (out.phone || "").replace(/\D/g, "");
  const PH = /(?:\+?44[ \t]?|0)\d[\d \t-]{8,12}\d/g;
  while ((m = PH.exec(msg))) {
    let p = m[0].replace(/[\s-]/g, ""); if (p.startsWith("+44") || p.startsWith("44")) p = "0" + p.replace(/^\+?44/, "");
    if (!mainP) { out.phone = p; continue; }
    if (p === mainP || p.length < 10) continue;
    const near = msg.slice(Math.max(0, m.index - 70), m.index + m[0].length + 90);
    const rel = (near.match(/\b(husband|wife|partner|son|daughter|mum|mother|dad|father|brother|sister|fianc[eé]e?|boyfriend|girlfriend|colleague|work)\b/i) || [])[1] || "";
    const nm = (near.match(/(?:(?:his|her|their) name is|called|ask for|speak to|contact)\s+([A-Z][a-z]+)/) || near.match(/\b(?:husband|wife|partner|son|daughter)(?:'s)?\s+([A-Z][a-z]+)\b/) || [])[1] || "";
    const pref = /call (?:him|her|them)|(?:best|easier) to (?:call|contact)|(?:difficult|hard) to get to the phone|work (?:full|long)/i.test(msg) ? " — prefers calls to this number" : "";
    lines.push(`Other contact: ${[nm, rel ? `(${rel.toLowerCase()})` : ""].filter(Boolean).join(" ") || "number"} ${p}${pref}`);
    if (!out.contacts) out.contacts = [];
    if (!out.contacts.some(x => x.phone === p)) out.contacts.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: nm, relation: rel ? rel[0].toUpperCase() + rel.slice(1).toLowerCase() : "", phone: p, email: "", preferred: !!pref });
  }
  return { lines, message: msgM ? msgM[2].trim() : "" };
}

// Split a whole address typed on one line ("12 Laxton Drive, Kingswood, Wotton under Edge, Glos. GL12 8SQ")
// into address line 1, line 2, town and postcode.
const COUNTY_RE = /^(glos|gloucs|gloucestershire|somerset|n\.?\s*somerset|north somerset|avon|wilts|wiltshire|devon|dorset|cornwall|hants|hampshire|berks|berkshire|oxon|oxfordshire|herefordshire|worcs|worcestershire|south glos|s\.?\s*glos|south gloucestershire|bristol|monmouthshire|gwent|glamorgan|south glamorgan|mid glamorgan|west glamorgan|vale of glamorgan|powys|carmarthenshire|pembrokeshire|newport|cardiff|swansea|uk|united kingdom|england|wales)\.?$/i;
function tidyAddress(a1, a2, town, pc) {
  const PC = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;
  let line = String(a1 || "").trim(), postcode = String(pc || "").trim(), t = String(town || "").replace(/[\s.,]+$/, "").trim(), l2 = String(a2 || "").trim();
  const m = line.match(PC);
  if (!line.includes(",") && !m) return { address1: line, address2: l2, town: t, postcode };
  if (m) { if (!postcode) postcode = (m[1] + " " + m[2]).toUpperCase(); line = line.replace(PC, " "); }
  let parts = line.split(/\s*,\s*/).map(x => x.replace(/^[\s.]+|[\s.]+$/g, "").trim()).filter(Boolean);
  // drop county / country and anything that's the town again
  parts = parts.filter(x => !COUNTY_RE.test(x));
  const same = (x, y) => x.toLowerCase().replace(/[^a-z]/g, "") === y.toLowerCase().replace(/[^a-z]/g, "");
  if (t) parts = parts.filter((x, i) => i === 0 || !same(x, t));
  if (!t && parts.length > 1) t = parts.pop();
  if (parts.length > 1 && (/^(flat|apartment|apt|unit|suite|room|no\.?)\b/i.test(parts[0]) || /^\d+[a-z]?$/i.test(parts[0]))) parts.splice(0, 2, parts[0] + ", " + parts[1]);
  const address1 = parts.shift() || "";
  if (!l2 && parts.length) l2 = parts.join(", ");
  return { address1, address2: l2, town: t, postcode: postcode.toUpperCase().replace(/\s+/g, " ") };
}


// ── Email replies copied from the inbox ─────────────────────────────────────
// "We are moving from / 2 Faye Close / Warmley / BS30 5AE" style blocks, our own
// quoted message underneath ("On 5 Nov … wrote:"), and our own phone numbers/emails.
const OWN_EMAIL_RE = /rjremovals\.co\.uk|rj-removals|rjremovals\.com/i;
const OWN_PHONES = ["01179611112", "01454550873"];
const FROM_HDR = /^\s*(?:we\s+are\s+|we're\s+|i\s+am\s+|i'm\s+)?(?:moving|move|relocating)\s+(?:out\s+)?from\b|^\s*(?:current|collection|pick\s*up|pickup|old|existing|from)\s+address\b|^\s*from\s*:?\s*$/i;
const TO_HDR = /^\s*(?:and\s+)?(?:we\s+are\s+|we're\s+|i\s+am\s+|i'm\s+)?(?:moving|move|going|relocating)\s+(?:in)?to\b|^\s*(?:new|delivery|destination|to)\s+address\b|^\s*to\s*:?\s*$/i;
function splitQuotedReply(t) {
  const m = t.match(/^[ \t>]*(On .{4,160}?wrote:|-{2,}\s*Original Message\s*-{2,}|From:[^\n]*\n[ \t]*(?:Sent|Date):)/im);
  if (!m || m.index < 10) return { body: t, quoted: "" };
  return { body: t.slice(0, m.index), quoted: t.slice(m.index) };
}
// Lines under a "moving from" / "moving to" heading, up to a blank line or the next heading.
function addressBlock(t, hdr, otherHdr) {
  const lines = t.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!hdr.test(line)) continue;
    // inline: "We're moving from 2 Faye Close, Warmley BS30 5AE"
    const rest = line.replace(hdr, "").replace(/^[\s:,-]+/, "").trim();
    const PCx = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i;
    if (rest && (PCx.test(rest) || /^\d/.test(rest))) return rest;
    const got = [];
    for (let k = i + 1; k < lines.length && got.length < 6; k++) {
      const l = lines[k].trim();
      if (!l) { if (got.length) break; else continue; }
      if (otherHdr.test(l) || hdr.test(l) || /^(many thanks|thanks|thank you|kind regards|regards|cheers|sent from)/i.test(l)) break;
      got.push(l.replace(/[,]+$/, ""));
      if (PCx.test(l)) break; // postcode ends the address
    }
    if (got.length) return got.join(", ");
  }
  return "";
}
function nameFromReply(body, quoted) {
  // Customer's sign-off: "Many thanks\nChelsie"
  const so = body.match(/(?:many thanks|thanks|thank you|kind regards|best regards|regards|cheers|best wishes)[,!.]*\s*\n\s*([A-Z][a-zA-Z'’-]+(?:\s+[A-Z][a-zA-Z'’-]+){0,2})\s*(?:\n|$)/i);
  if (so && !/^sent\b/i.test(so[1])) return so[1].trim();
  // Our quoted greeting to them: "Morning Chelsie"
  const gr = (quoted || "").match(/^[ \t>]*(?:good\s+)?(?:morning|afternoon|evening|hi|hello|hiya|dear)\s+([A-Z][a-zA-Z'’-]+)/im);
  return gr ? gr[1] : "";
}

function parseEnquiryEmail(text) {
  let t = (text || "").replace(/\r/g, "");
  if (/<[a-z!\/][^>]*>/i.test(t)) t = stripEmailHtml(t);
  t = repairLabelValueLines(normalizeEmailLabels(t));
  const out = { referredBy: "", name: "", email: "", phone: "", fromAddress1: "", fromTown: "", fromPostcode: "", fromAccess: "", fromPropertyType: "", fromBedrooms: "", toAddress1: "", toTown: "", toPostcode: "", toAccess: "", toPropertyType: "", preferredDate: "", moveMonth: "", dateFlexible: false, notes: "" };
  const PC = /[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}/i;
  const PCG = /[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}/gi;
  // A copied email reply: work from the customer's part; our own quoted message is kept aside.
  const reply = splitQuotedReply(t);
  const quotedPart = reply.quoted;
  t = reply.body;
  const pickEmail = txt => (String(txt || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).find(e => !OWN_EMAIL_RE.test(e)) || "";
  out.email = pickEmail(t) || pickEmail(quotedPart);
  const pickPhone = txt => { for (const m of String(txt || "").match(/(\+?44|0)[\d \t()-]{8,13}\d/g) || []) { let p = m.replace(/[()\s-]/g, ""); if (p.startsWith("+44")) p = "0" + p.slice(3); if (!OWN_PHONES.includes(p)) return p; } return ""; };
  out.phone = pickPhone(t) || pickPhone(quotedPart);
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fieldIn = (block, labels) => { for (const L of labels) { const m = block.match(new RegExp("^[ \\t]*" + esc(L) + "[ \\t]*:[ \\t]*(.+?)[ \\t]*$", "im")); if (m && m[1].trim()) return m[1].trim(); } return ""; };
  { const lp = fieldIn(t, ["phone", "mobile", "telephone", "tel", "phone number", "contact number"]).replace(/[()\s-]/g, ""); if (/^(\+?44|0)\d{9,10}$/.test(lp)) out.phone = lp.startsWith("+44") ? "0" + lp.slice(3) : lp; }
  { const le = fieldIn(t, ["email", "email address", "e-mail"]).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i); if (le) out.email = le[0]; }
  out.email = (out.email || "").toLowerCase();

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
  let fromBeds = "", toBeds = "", fromFurn = ""; let labelledPC = false;
  if (sectioned) {
    out.fromAddress1 = fieldIn(fromBlock, ["address", "address line 1", "street", "house"]);
    out.fromTown = fieldIn(fromBlock, ["city", "town"]);
    out.fromPostcode = (fieldIn(fromBlock, ["post code", "postcode"]) || "").toUpperCase().replace(/\s+/g, " ");
    out.fromAccess = fieldIn(fromBlock, ["access"]);
    out.fromPropertyType = normalizePropertyType(fieldIn(fromBlock, ["property", "property type"]));
    out.fromBedrooms = fromBeds = fieldIn(fromBlock, ["bedrooms", "beds"]);
    fromFurn = fieldIn(fromBlock, ["furnished"]);
    out.toAddress1 = fieldIn(toBlock, ["address", "address line 1", "street", "house"]);
    out.toTown = fieldIn(toBlock, ["city", "town"]);
    out.toPostcode = (fieldIn(toBlock, ["post code", "postcode"]) || "").toUpperCase().replace(/\s+/g, " ");
    out.toAccess = fieldIn(toBlock, ["access"]);
    out.toPropertyType = normalizePropertyType(fieldIn(toBlock, ["property", "property type"]));
    toBeds = fieldIn(toBlock, ["bedrooms", "beds"]);
  } else {
    const fromLine = fieldIn(t, ["moving from", "move from", "collection address", "collection", "current address", "from address", "pickup", "from"]);
    const toLine = fieldIn(t, ["moving to", "move to", "delivery address", "delivery", "destination", "to address", "drop off", "to"]);
    const [fa, fpc] = splitPC(fromLine); const [ta, tpc] = splitPC(toLine);
    labelledPC = !!(fpc || tpc);
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

  if (!sectioned) {
    const fb = addressBlock(t, FROM_HDR, TO_HDR), tb = addressBlock(t, TO_HDR, FROM_HDR);
    if (fb) { out.fromAddress1 = fb; out.fromAddress2 = ""; out.fromPostcode = ""; out.fromTown = ""; labelledPC = true; }
    if (tb) { out.toAddress1 = tb; out.toAddress2 = ""; out.toPostcode = ""; out.toTown = ""; labelledPC = true; }
  }
  if (!out.name) out.name = nameFromReply(t, quotedPart);
  out.referredBy = normalizeReferral(out.referredBy);
  const rm = readMessage(t, out, { lockPostcodes: sectioned || labelledPC });
  out.fromPropertyType = normalizePropertyType(out.fromPropertyType); out.toPropertyType = normalizePropertyType(out.toPropertyType);
  if (!fromBeds && !sectioned) fromBeds = "";
  if (!toBeds && out.toBedrooms) toBeds = out.toBedrooms;
  delete out.toBedrooms;
  { const fa = tidyAddress(out.fromAddress1, out.fromAddress2, out.fromTown, out.fromPostcode); out.fromAddress1 = fa.address1; out.fromAddress2 = fa.address2; out.fromTown = fa.town; out.fromPostcode = fa.postcode; }
  { const ta = tidyAddress(out.toAddress1, out.toAddress2, out.toTown, out.toPostcode); out.toAddress1 = ta.address1; out.toAddress2 = ta.address2; out.toTown = ta.town; out.toPostcode = ta.postcode; }
  if (!out.name && out.email) out.name = out.email.split("@")[0].replace(/[._\-]+/g, " ").replace(/\b\w/g, ch => ch.toUpperCase()).trim();

  // Tidy notes from the extra fields (so nothing is lost)
  const extras = [];
  const add = (label, val) => { if (val && val.trim()) extras.push(`${label}: ${val.trim()}`); };
  add("Packing", fieldIn(topBlock, ["packing"]));
  add("Storage", fieldIn(topBlock, ["storage"]));
  out.referredBy = fieldIn(topBlock, ["how did you here of us", "how did you hear of us", "how did you hear", "where did you hear about us", "source", "referral", "referred by"]);
  add("Special requirements", fieldIn(topBlock, ["special requirements", "special requirement", "requirements"]));
  const fromProp = [out.fromPropertyType, fromBeds ? `${fromBeds} bed` : "", fromFurn].filter(Boolean).join(", ");
  const toProp = [out.toPropertyType, toBeds ? `${toBeds} bed` : ""].filter(Boolean).join(", ");
  if (sectioned) add("From property", fromProp);
  add("To property", toProp);
  const keyPoints = [...extras, ...rm.lines];
  out.notes = (keyPoints.join("\n") + (rm.message ? (keyPoints.length ? "\n\n" : "") + "Message:\n" + rm.message : "")).trim() || t.trim().slice(0, 1200);
  return out;
}

function EnquiryForm({ data, onClose, editEnquiry, initialCustomerId, reopen }) {
  const e = editEnquiry || {};
  const [customerId, setCustomerId] = useState(e.customerId || initialCustomerId || "");
  useEffect(() => { if (!e.id && initialCustomerId) selectCustomer(initialCustomerId); /* eslint-disable-next-line */ }, []);
  const [newCust, setNewCust] = useState({ name: "", phone: "", email: "" });
  const [f, setF] = useState({
    preferredDate: e.preferredDate || "", dateFlexible: e.dateFlexible || false, moveMonth: e.moveMonth || "",
    surveyDate: reopen ? "" : (e.surveyDate || ""), surveyTime: reopen ? "" : (e.surveyTime || ""),
    fromAddress1: e.fromAddress1 || "", fromAddress2: e.fromAddress2 || "", fromTown: e.fromTown || "", fromPostcode: e.fromPostcode || "",
    fromPropertyType: normalizePropertyType(e.fromPropertyType), fromBedrooms: e.fromBedrooms || "", fromFloor: e.fromFloor || "", fromAccess: e.fromAccess || "",
    toAddress1: e.toAddress1 || "", toAddress2: e.toAddress2 || "", toTown: e.toTown || "", toPostcode: e.toPostcode || "",
    toStore: !!e.toStore, storeMode: e.storeMode || "Weeks", storeQty: e.storeQty ?? "", storeOutDate: e.storeOutDate || "",
    toPropertyType: normalizePropertyType(e.toPropertyType), toFloor: e.toFloor || "", toAccess: e.toAccess || "",
    notes: e.notes || "", stages: Array.isArray(e.stages) ? e.stages : [],
    referredBy: normalizeReferral(e.referredBy),
    surveyor: e.surveyor || "",
    exchanged: e.exchanged || false,
    extraFrom: Array.isArray(e.extraFrom) ? e.extraFrom : [],
    extraTo: Array.isArray(e.extraTo) ? e.extraTo : [],
  });
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const addStop = key => set(key, [...(f[key] || []), { id: uid(), address1: "", town: "", postcode: "", note: "" }]);
  const setStop = (key, i, k, v) => set(key, (f[key] || []).map((x, ix) => ix === i ? { ...x, [k]: v } : x));
  const rmStop = (key, i) => set(key, (f[key] || []).filter((_, ix) => ix !== i));
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pickerKey, setPickerKey] = useState(0);
  // Editing an enquiry also edits the customer's own details (same fields as Edit Customer).
  const cust0 = e.id ? ((data.customers || []).find(c => c.id === e.customerId) || null) : null;
  const [cf, setCf] = useState(() => cust0 ? { name: cust0.name || "", custType: cust0.custType || "Private", company: cust0.company || "", phone: cust0.phone || "", homePhone: cust0.homePhone || "", email: cust0.email || "", address1: cust0.address1 || "", address2: cust0.address2 || "", town: cust0.town || "", postcode: cust0.postcode || "", notes: cust0.notes || "" } : null);
  const [cContacts, setCContacts] = useState(() => (cust0 && cust0.contacts) || []);
  const setC = (k, v) => setCf(p => ({ ...p, [k]: v }));
  const autofill = () => {
    const p = parseEnquiryEmail(pasteText);
    // Already a customer? (same email or mobile, or the only customer with that name) → use them, don't duplicate.
    const digits = x => String(x || "").replace(/\D/g, "");
    const custs = data.customers || [];
    let match = custs.find(c => (p.email && (c.email || "").toLowerCase() === p.email.toLowerCase()) || (p.phone && digits(c.phone) && digits(c.phone) === digits(p.phone)));
    if (!match && p.name) { const nm = p.name.toLowerCase().replace(/^(mr|mrs|ms|miss|dr)\.?\s+/, ""); const hits = custs.filter(c => (c.name || "").toLowerCase().split(/\s+/).includes(nm.split(/\s+/)[0]) && (nm.split(/\s+/).length === 1 || (c.name || "").toLowerCase().includes(nm))); if (hits.length === 1) match = hits[0]; }
    if (match) { setNewCust({ name: "", phone: "", email: "", contacts: [] }); setCustomerId(match.id); }
    else { setNewCust({ name: p.name || "", phone: p.phone || "", email: p.email || "", contacts: p.contacts || [] }); setCustomerId(""); }
    setF(prev => ({ ...prev,
      fromAddress1: p.fromAddress1 || prev.fromAddress1, fromAddress2: p.fromAddress2 || prev.fromAddress2, fromTown: p.fromTown || prev.fromTown, fromPostcode: p.fromPostcode || prev.fromPostcode,
      referredBy: normalizeReferral(p.referredBy) || prev.referredBy,
      fromAccess: p.fromAccess || prev.fromAccess, fromPropertyType: p.fromPropertyType || prev.fromPropertyType, fromBedrooms: p.fromBedrooms || prev.fromBedrooms,
      toAddress1: p.toAddress1 || prev.toAddress1, toAddress2: p.toAddress2 || prev.toAddress2, toTown: p.toTown || prev.toTown, toPostcode: p.toPostcode || prev.toPostcode,
      toAccess: p.toAccess || prev.toAccess, toPropertyType: p.toPropertyType || prev.toPropertyType,
      preferredDate: p.preferredDate || prev.preferredDate, moveMonth: p.moveMonth || prev.moveMonth,
      dateFlexible: p.dateFlexible || prev.dateFlexible,
      notes: prev.notes ? prev.notes : p.notes,
    }));
    setPickerKey(k => k + 1);
    setPasteOpen(false);
  };

  // When an existing customer is picked, prefill as much as we already know:
  //  • moved with us before → "moving from" = where we last moved them TO, with that property's
  //    type, floor and access (and Referred by = Moved Before);
  //  • enquired before but didn't move → copy that enquiry's from AND to details (re-quote);
  //  • otherwise → their stored address.
  function selectCustomer(cid) {
    setCustomerId(cid);
    if (!cid) return;
    const cust = (data.customers || []).find(c => c.id === cid);
    const byDate = (x, y) => (y.moveDate || y.createdAt || "").localeCompare(x.moveDate || x.createdAt || "");
    const pastMoves = (data.jobs || []).filter(jb => jb.customerId === cid && jb.status !== "Let Go" && (jb.toAddress1 || jb.toTown || jb.toPostcode)).sort(byDate);
    const enqs = (data.enquiries || []).filter(x => x.customerId === cid && x.id !== e.id).sort((x, y) => (y.createdAt || y.enquiryDate || "").localeCompare(x.createdAt || x.enquiryDate || ""));
    const blankTo = { toAddress1: "", toAddress2: "", toTown: "", toPostcode: "", toPropertyType: "", toFloor: "", toAccess: "", toStore: false };
    if (pastMoves[0]) {
      const m = pastMoves[0];
      const me = enqs.find(x => x.id === m.enquiryId) || {};
      setF(p => ({ ...p, ...blankTo,
        fromAddress1: m.toAddress1 || "", fromAddress2: m.toAddress2 || "", fromTown: m.toTown || "", fromPostcode: m.toPostcode || "",
        fromPropertyType: normalizePropertyType(me.toPropertyType), fromBedrooms: "", fromFloor: me.toFloor || "", fromAccess: m.toAccess || me.toAccess || "",
        referredBy: "Moved Before" }));
    } else if (enqs[0]) {
      const q = enqs[0];
      setF(p => ({ ...p,
        fromAddress1: q.fromAddress1 || "", fromAddress2: q.fromAddress2 || "", fromTown: q.fromTown || "", fromPostcode: q.fromPostcode || "",
        fromPropertyType: normalizePropertyType(q.fromPropertyType), fromBedrooms: q.fromBedrooms || "", fromFloor: q.fromFloor || "", fromAccess: q.fromAccess || "",
        toAddress1: q.toAddress1 || "", toAddress2: q.toAddress2 || "", toTown: q.toTown || "", toPostcode: q.toPostcode || "",
        toPropertyType: normalizePropertyType(q.toPropertyType), toFloor: q.toFloor || "", toAccess: q.toAccess || "",
        toStore: !!q.toStore, storeMode: q.storeMode || p.storeMode,
        extraFrom: Array.isArray(q.extraFrom) ? q.extraFrom : [], extraTo: Array.isArray(q.extraTo) ? q.extraTo : [],
        referredBy: normalizeReferral(q.referredBy) || p.referredBy }));
    } else if (cust) {
      setF(p => ({ ...p, fromAddress1: cust.address1 || "", fromAddress2: cust.address2 || "", fromTown: cust.town || "", fromPostcode: cust.postcode || "" }));
    }
  }

  async function save() {
    let data2 = data;
    let cid = customerId;
    if (f.exchanged && !f.preferredDate) { alert("This move is marked as exchanged — please set the confirmed move date."); return; }
    if (!e.id && !f.referredBy) { alert("Please choose where they heard of us (Referred by)."); return; }
    if (cust0 && cf) {
      if (!cf.name.trim()) { alert("The customer's name can't be blank."); return; }
      const keep = cContacts.filter(contactFilled);
      const crec = { ...cust0, ...cf, name: cf.name.trim(), contacts: keep, contactsCleared: !keep.length && ((cust0.contacts || []).length > 0 || !!cust0.contactsCleared) ? true : undefined };
      if (JSON.stringify(crec) !== JSON.stringify(cust0)) data2 = upsertLocal(data2, "customers", crec);
    }
    if (!cid) {
      if (!newCust.name.trim()) { alert("Enter a customer name (or pick an existing customer)."); return; }
      cid = uid();
      const customer = { id: cid, name: newCust.name.trim(), company: "", phone: newCust.phone, email: newCust.email, contacts: (newCust.contacts || []).filter(contactFilled), address1: f.fromAddress1 || "", address2: f.fromAddress2 || "", town: f.fromTown || "", postcode: f.fromPostcode || "", custType: "Private", ref: null, createdAt: new Date().toISOString() };
      data2 = upsertLocal(data2, "customers", customer);
    }
    const rec = {
      // Keep everything already on the enquiry (quote options link, quote settings, reminders…)
      // and only overwrite what this form edits — editing used to drop those extra details.
      ...(e.id ? e : {}),
      id: e.id || uid(), customerId: cid,
      status: reopen ? "New" : (e.status || "New"),
      surveyDone: reopen ? false : !!e.surveyDone,
      enquiryDate: e.enquiryDate || todayISO(),
      ...f,
      inventory: e.inventory || [], volumeCuFt: e.volumeCuFt || 0, volumeM3: e.volumeM3 || 0, weightKg: e.weightKg || 0,
      extras: e.extras || [], quoteLines: e.quoteLines || [], quoteVat: e.quoteVat || false,
      quoteTotal: e.quoteTotal || 0, quoteStatus: e.quoteStatus || "Draft", quoteSentDate: e.quoteSentDate || "",
      followUpDate: e.followUpDate || "", followUpNote: e.followUpNote || "", lostReason: reopen ? "" : (e.lostReason || ""),
      createdAt: e.createdAt || new Date().toISOString(),
    };
    data2 = upsertLocal(data2, "enquiries", rec);
    try { sessionStorage.setItem("removals_view", JSON.stringify(e.id ? { screen: "enquiryDetail", id: e.id } : { screen: "dashboard" })); } catch {}
    await saveAndReload(data2);
  }

  return (
    <Modal title={reopen ? "Rebook survey" : e.id ? "Edit Enquiry" : "New Enquiry"} onClose={onClose}>
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

      {e.id && (!pasteOpen
        ? <Btn size="sm" variant="grey" style={{ marginBottom: 10 }} onClick={() => setPasteOpen(true)}><Icon name="mail" size={14} /> Paste an email to fill in details</Btn>
        : <div style={{ background: "#F9FAFB", border: "1px solid #F3F4F6", borderRadius: 10, padding: 12, marginBottom: 10 }}>
            <div style={{ fontSize: 12.5, color: "#374151", marginBottom: 8 }}>Paste the customer's email (e.g. their reply with the addresses). Only the move details below get filled in — check them before saving.</div>
            <Textarea value={pasteText} onChange={setPasteText} rows={6} placeholder="Paste the email here…" />
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <Btn size="sm" variant="grey" onClick={() => setPasteOpen(false)}>Cancel</Btn>
              <Btn size="sm" disabled={!pasteText.trim()} onClick={() => {
                const p = parseEnquiryEmail(pasteText);
                setF(prev => ({ ...prev,
                  fromAddress1: p.fromAddress1 || prev.fromAddress1, fromAddress2: p.fromAddress1 ? (p.fromAddress2 || "") : prev.fromAddress2, fromTown: p.fromTown || prev.fromTown, fromPostcode: p.fromPostcode || prev.fromPostcode,
                  toAddress1: p.toAddress1 || prev.toAddress1, toAddress2: p.toAddress1 ? (p.toAddress2 || "") : prev.toAddress2, toTown: p.toTown || prev.toTown, toPostcode: p.toPostcode || prev.toPostcode,
                  fromAccess: p.fromAccess || prev.fromAccess, toAccess: p.toAccess || prev.toAccess,
                  fromPropertyType: p.fromPropertyType || prev.fromPropertyType, toPropertyType: p.toPropertyType || prev.toPropertyType, fromBedrooms: p.fromBedrooms || prev.fromBedrooms,
                  preferredDate: p.preferredDate || prev.preferredDate, moveMonth: p.moveMonth || prev.moveMonth, dateFlexible: p.dateFlexible || prev.dateFlexible,
                }));
                setPasteOpen(false); setPasteText("");
              }}>Fill in</Btn>
            </div>
          </div>)}
      {cust0 && cf && <>
        <SectionTitle>Customer</SectionTitle>
        <Field label="Full name" required><Input value={cf.name} onChange={v => setC("name", v)} /></Field>
        <Field label="Type"><Select value={cf.custType} onChange={v => setC("custType", v)} options={["Private", "Commercial"]} /></Field>
        {cf.custType === "Commercial" && <Field label="Company"><Input value={cf.company} onChange={v => setC("company", v)} /></Field>}
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1 }}><Field label="Mobile phone"><Input value={cf.phone} onChange={v => setC("phone", v)} /></Field></div>
          <div style={{ flex: 1 }}><Field label="Home phone"><Input value={cf.homePhone} onChange={v => setC("homePhone", v)} /></Field></div>
        </div>
        <Field label="Email"><Input type="email" value={cf.email} onChange={v => setC("email", v)} /></Field>
        <ContactsEditor contacts={cContacts} onChange={setCContacts} />
        <Field label="Customer address" hint="Their home/billing address"><Input value={cf.address1} onChange={v => setC("address1", v)} /></Field>
        <Field label="Address line 2"><Input value={cf.address2} onChange={v => setC("address2", v)} placeholder="(optional)" /></Field>
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1 }}><Field label="Town"><Input value={cf.town} onChange={v => setC("town", v)} /></Field></div>
          <div style={{ width: 120 }}><Field label="Postcode"><Input value={cf.postcode} onChange={v => setC("postcode", v)} /></Field></div>
        </div>
        <Field label="Customer notes"><Textarea value={cf.notes} onChange={v => setC("notes", v)} /></Field>
      </>}
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
      <form autoComplete="off" onSubmit={e => e.preventDefault()} style={{ display: "contents" }}>
      <Field label="Address"><Input value={f.fromAddress1} onChange={v => set("fromAddress1", v)} placeholder="House/flat & street" name="from-address1" /></Field>
      <Field label="Address line 2"><Input value={f.fromAddress2} onChange={v => set("fromAddress2", v)} placeholder="(optional)" /></Field>
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}><Field label="Town"><Input value={f.fromTown} onChange={v => set("fromTown", v)} name="from-town" /></Field></div>
        <div style={{ width: 120 }}><Field label="Postcode"><Input value={f.fromPostcode} onChange={v => set("fromPostcode", v)} name="from-postcode" /></Field></div>
      </div>
      </form>
      <Field label="Property type"><Select value={f.fromPropertyType} onChange={v => set("fromPropertyType", v)} options={propertyOptions(f.fromPropertyType)} placeholder="Select…" /></Field>
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}><Field label="Bedrooms"><Input type="number" value={f.fromBedrooms} onChange={v => set("fromBedrooms", v)} placeholder="e.g. 3" /></Field></div>
        <div style={{ flex: 1 }}><Field label="Floor / level"><Input value={f.fromFloor} onChange={v => set("fromFloor", v)} placeholder="e.g. Ground, 2nd" /></Field></div>
      </div>
      <Field label="Access notes" hint="Stairs, lift, parking, long carry"><Textarea value={f.fromAccess} onChange={v => set("fromAccess", v)} rows={2} /></Field>

      {(f.extraFrom || []).map((s, i) => (
        <div key={s.id || i} style={{ border: "1px solid #E9EEED", borderRadius: 10, padding: 11, marginTop: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <span style={{ fontSize: 12.5, fontWeight: 800, color: TEAL_D }}>Extra pickup {i + 1}</span>
            <button type="button" onClick={() => rmStop("extraFrom", i)} style={{ background: "none", border: "none", color: "#DC2626", fontWeight: 700, fontSize: 12.5, cursor: "pointer" }}>Remove</button>
          </div>
          <Field label="Address"><Input value={s.address1} onChange={v => setStop("extraFrom", i, "address1", v)} placeholder="House/flat & street" noAutofill /></Field>
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 1 }}><Field label="Town"><Input value={s.town} onChange={v => setStop("extraFrom", i, "town", v)} noAutofill /></Field></div>
            <div style={{ width: 120 }}><Field label="Postcode"><Input value={s.postcode} onChange={v => setStop("extraFrom", i, "postcode", v)} noAutofill /></Field></div>
          </div>
          <Field label="Note" hint="e.g. lock-up, garage, storage unit"><Input value={s.note} onChange={v => setStop("extraFrom", i, "note", v)} /></Field>
        </div>
      ))}
      <button type="button" onClick={() => addStop("extraFrom")} style={{ background: "#F0FDFA", border: `1px dashed ${TEAL}`, color: TEAL_D, borderRadius: 9, padding: "9px", fontSize: 13, fontWeight: 700, cursor: "pointer", width: "100%", marginTop: 8 }}>+ Add another pickup address</button>

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
      <form autoComplete="off" onSubmit={e => e.preventDefault()} style={{ display: "contents" }}>
      <Field label="Address"><Input value={f.toAddress1} onChange={v => set("toAddress1", v)} placeholder="House/flat & street" noAutofill /></Field>
      <Field label="Address line 2"><Input value={f.toAddress2} onChange={v => set("toAddress2", v)} placeholder="(optional)" /></Field>
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}><Field label="Town"><Input value={f.toTown} onChange={v => set("toTown", v)} noAutofill /></Field></div>
        <div style={{ width: 120 }}><Field label="Postcode"><Input value={f.toPostcode} onChange={v => set("toPostcode", v)} noAutofill /></Field></div>
      </div>
      </form>
      <Field label="Property type"><Select value={f.toPropertyType} onChange={v => set("toPropertyType", v)} options={propertyOptions(f.toPropertyType)} placeholder="Select…" /></Field>
      <Field label="Floor / level"><Input value={f.toFloor} onChange={v => set("toFloor", v)} placeholder="e.g. Ground, 2nd" /></Field>
      <Field label="Access notes" hint="Stairs, lift, parking, long carry"><Textarea value={f.toAccess} onChange={v => set("toAccess", v)} rows={2} /></Field>

      {(f.extraTo || []).map((s, i) => (
        <div key={s.id || i} style={{ border: "1px solid #E9EEED", borderRadius: 10, padding: 11, marginTop: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <span style={{ fontSize: 12.5, fontWeight: 800, color: TEAL_D }}>Extra delivery {i + 1}</span>
            <button type="button" onClick={() => rmStop("extraTo", i)} style={{ background: "none", border: "none", color: "#DC2626", fontWeight: 700, fontSize: 12.5, cursor: "pointer" }}>Remove</button>
          </div>
          <Field label="Address"><Input value={s.address1} onChange={v => setStop("extraTo", i, "address1", v)} placeholder="House/flat & street" noAutofill /></Field>
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 1 }}><Field label="Town"><Input value={s.town} onChange={v => setStop("extraTo", i, "town", v)} noAutofill /></Field></div>
            <div style={{ width: 120 }}><Field label="Postcode"><Input value={s.postcode} onChange={v => setStop("extraTo", i, "postcode", v)} noAutofill /></Field></div>
          </div>
          <Field label="Note" hint="e.g. storage, second address"><Input value={s.note} onChange={v => setStop("extraTo", i, "note", v)} /></Field>
        </div>
      ))}
      <button type="button" onClick={() => addStop("extraTo")} style={{ background: "#F0FDFA", border: `1px dashed ${TEAL}`, color: TEAL_D, borderRadius: 9, padding: "9px", fontSize: 13, fontWeight: 700, cursor: "pointer", width: "100%", marginTop: 8 }}>+ Add another delivery address</button>

      <Field label="Referred by" required hint="How did they hear about us? Used on the Reports page.">
        <Select value={f.referredBy} onChange={v => set("referredBy", v)} options={[...LEAD_SOURCES, "Other"]} placeholder="Choose where they heard of us…" />
      </Field>
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
      else {
        next[slot] = { ...(p[slot] || meta), qty: n };
        // Newly added bed, wardrobe, dining table…: tick "Dismantle & reassemble" (untick it if not needed).
        if (cur === 0 && n > 0 && !next[slot].dismantle && likelyDismantle(next[slot].name)) next[slot] = { ...next[slot], dismantle: "Mover" };
        if (n < 0 && next[slot].dismantle) next[slot] = { ...next[slot], dismantle: "" }; // not moving → nothing to dismantle
      }
      return next;
    });
  }
  // Items already on this survey that probably need dismantling but aren't ticked
  const disSuggest = Object.entries(lines).filter(([, v]) => v && v.qty > 0 && !v.dismantle && likelyDismantle(v.name));
  const tickAllDis = () => setLines(p => { const n = { ...p }; disSuggest.forEach(([slot]) => { if (n[slot]) n[slot] = { ...n[slot], dismantle: "Mover" }; }); return n; });
  function addCustom(label, catalogRoom) {
    const name = (prompt("Item name?") || "").trim();
    if (!name) return;
    const cuFtRaw = prompt("Approx volume in cubic feet? (e.g. 20)");
    if (cuFtRaw === null) return; // Cancel
    const cuFt = parseFloat(cuFtRaw);
    if (!cuFt || cuFt <= 0) { alert("Please enter a number for cubic feet."); return; }
    const kgRaw = prompt("Approx weight in kg? (optional, e.g. 30)");
    if (kgRaw === null) return; // Cancel
    const kg = parseFloat(kgRaw) || 0;
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
    Object.values(freeRooms).forEach(r => { cuFt += (Number(r.cuFt) || 0) + (Number(r.wardrobe) || 0) * 15; });
    cuFt = Math.round(cuFt * 100) / 100;
    return { cuFt, m3: Math.round(cuFt * 0.0283168 * 10) / 10, kg: 0 };
  })();
  const aTot = invMode === "freehand" ? freeTotals : totals;
  const setDismantle = (slot, val) => setLines(p => p[slot] ? { ...p, [slot]: { ...p[slot], dismantle: val } } : p);
  const toggleWho = slot => setLines(p => p[slot] ? { ...p, [slot]: { ...p[slot], dismantle: p[slot].dismantle === "Customer" ? "Mover" : "Customer" } } : p);
  const DisCheck = ({ slot }) => {
    const v = lines[slot];
    if (!v || v.qty <= 0 || !canDismantle(v.name)) return null;
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
    return <button data-ro-show onClick={() => toggleWho(slot)} style={{ marginTop: 6, border: "none", background: TEAL, color: "#fff", borderRadius: 99, fontSize: 11, fontWeight: 700, padding: "3px 10px", cursor: "pointer" }}>Dismantle &amp; reassemble: {v.dismantle} ⟲</button>;
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
        if (wb > 0) inventory.push({ slot: "fhwb::" + room, room, name: "Hanging Wardrobe Box", cuFt: 15, m3: 0.42, kg: 18, qty: wb, freehand: true, wardrobe: true });
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
        try { setDB(JSON.stringify(d2)); } catch {}
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
    const sectionCuFt = Math.round(Object.values(lines).filter(v => v.room === label && v.qty > 0).reduce((s, v) => s + (Number(v.cuFt) || 0) * v.qty, 0));
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
        <button data-ro-ok onClick={() => setOpenSection(isOpen ? null : label)} style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 14px", background: "#F9FAFB", border: "none", cursor: "pointer", fontSize: 14, fontWeight: 700, color: "#111827" }}>
          <span>{label}</span>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {isBedroom && beds.length > 1 && <span onClick={e => { e.stopPropagation(); removeBedroom(label); }} style={{ color: "#DC2626", fontSize: 13, fontWeight: 600 }}>Remove</span>}
            {isLounge && lounges.length > 1 && <span onClick={e => { e.stopPropagation(); removeLounge(label); }} style={{ color: "#DC2626", fontSize: 13, fontWeight: 600 }}>Remove</span>}
            {sectionQty > 0 && <span style={{ background: TEAL, color: "#fff", borderRadius: 99, fontSize: 12, padding: "1px 8px", fontWeight: 700, whiteSpace: "nowrap" }}>{sectionQty} item{sectionQty !== 1 ? "s" : ""} · {sectionCuFt} cu ft</span>}
            <span style={{ color: "#9CA3AF" }}>{isOpen ? "▾" : "▸"}</span>
          </span>
        </button>
        {isOpen && (
          <div style={{ padding: "4px 0" }}>
            {catItems.map((it, rowIx) => {
              const slot = `${label}::${it.id}`;
              const isCustom = typeof it.id === "string" && it.id.startsWith("cust_");
              const q = lines[slot]?.qty || 0;
              return (
                <div key={slot} style={invRowStyle(q, rowIx)}>
                  <div style={{ flex: 1, minWidth: 0, paddingRight: 8 }}>
                    <div style={{ fontSize: 14 }}>
                      <span style={invName(q)}>{it.name}</span>
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
            {customSlots.map(([slot, v], j) => (
              <div key={slot} style={invRowStyle(v.qty, catItems.length + j)}>
                <div style={{ flex: 1, minWidth: 0, paddingRight: 8 }}>
                  <div style={{ fontSize: 14 }}>
                    <span style={invName(v.qty)}>{v.name}</span>
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
          {all.map((it, rowIx) => {
            const slot = `${room}::${it.id}`;
            const q = lines[slot]?.qty || 0;
            return (
              <div key={it.id} style={invRowStyle(q, rowIx, "center")}>
                <div style={{ flex: 1, minWidth: 0, paddingRight: 8 }}>
                  <div style={{ fontSize: 14 }}><span style={invName(q)}>{it.name}</span>{q > 0 && <span style={{ fontSize: 11, color: TEAL, fontWeight: 700 }}> · {q} in {room}</span>}</div>
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

  // Spot furniture that usually needs dismantling (beds, wardrobes…) in what's been typed.
  const DIS_RE = /\b(bunk ?beds?|cabin ?beds?|beds?|bedframes?|bed frames?|divans?|cots?|wardrobes?|robes?|dining tables?|extending tables?|desks?|bookcases?|shelving units?|trampolines?|treadmills?|cross ?trainers?|multi ?gyms?|home ?gyms?|exercise bikes?|swing sets?|playhouses?|sheds?|greenhouses?|gazebos?)\b/i;
  const DIS_NOT = /\b(bedside|bedding|bedroom|bedspread|wardrobe box|robe hooks?|bed linen|beds? only|garden bed|raised bed|flower bed|dog bed|cat bed|pet bed|bean ?bag)\b/i;
  // Pick out just the furniture words (e.g. "Chair Double Bed" → "Double Bed"), so lists typed
  // without commas (like the old Mover ones) still give sensible buttons.
  const DIS_ADJ = /^(single|double|king|super|queen|small|large|bunk|cabin|corner|triple|fitted|sliding|dining|extending|kitchen|computer|office|corner|wall|tall|2 door|3 door|4 door)$/i;
  const disItemsIn = (text, room) => {
    const out = [];
    const notRe = new RegExp(DIS_NOT.source, "gi");
    String(text || "").split(/\n|,|;|·/).map(x => x.replace(notRe, " | ").trim()).filter(Boolean).forEach(chunk => {
      const re = new RegExp(DIS_RE.source, "gi"); let m;
      while ((m = re.exec(chunk))) {
        const before = chunk.slice(0, m.index).trim().split(/\s+/).pop() || "";
        const name = (DIS_ADJ.test(before) ? before + " " : "") + m[0];
        const label = name.replace(/\b\w/g, c => c.toUpperCase());
        if (!out.some(o => o.toLowerCase() === `${label} (${room})`.toLowerCase())) out.push(`${label} (${room})`);
      }
    });
    return out;
  };
  // Only counts as added if that item AND its room are on the list (e.g. "Double bed (Bedroom 1)"),
  // so a bed in one room doesn't show as ticked in every bedroom.
  const onDisList = item => dismantleNote.toLowerCase().split("\n").some(l => l.includes(item.toLowerCase()));
  // Added from a room button → always says who's doing it ("– Mover" until switched).
  const addDis = items => setDismantleNote(p => [p.trim(), ...items.map(x => `${x} – Mover`)].filter(Boolean).join("\n"));
  // Who's dismantling: a line ending "– Customer" means the customer does it, otherwise we do.
  const WHO_RE = /\s*[-–·]\s*(customer|mover)\s*$/i;
  const disLineIdx = item => dismantleNote.split("\n").findIndex(l => l.toLowerCase().includes(item.toLowerCase()));
  const disWho = item => { const i = disLineIdx(item); const l = i >= 0 ? dismantleNote.split("\n")[i] : ""; return /[-–·]\s*customer\s*$/i.test(l) ? "Customer" : "Mover"; };
  const toggleDisWho = item => setDismantleNote(p => {
    const lines = p.split("\n");
    const i = lines.findIndex(l => l.toLowerCase().includes(item.toLowerCase())); if (i < 0) return p;
    const isCust = /[-–·]\s*customer\s*$/i.test(lines[i]);
    lines[i] = lines[i].replace(WHO_RE, "") + (isCust ? " – Mover" : " – Customer");
    return lines.join("\n");
  });

  function renderFree(s) {
    const { label, isBedroom, isLounge } = s;
    const r = freeRooms[label] || { text: "", cuFt: "", wardrobe: 0 };
    const isOpen = openSection === label;
    const showWardrobe = isBedroom || label === "Hallway";
    const hasData = (r.text || "").trim() || Number(r.cuFt) > 0 || Number(r.wardrobe) > 0;
    return (
      <div key={label} style={{ marginBottom: 8, border: "1px solid #F3F4F6", borderRadius: 10, overflow: "hidden" }}>
        <button data-ro-ok onClick={() => setOpenSection(isOpen ? null : label)} style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 14px", background: "#F9FAFB", border: "none", cursor: "pointer", fontSize: 14, fontWeight: 700, color: "#111827" }}>
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
            {(() => {
              const found = disItemsIn(r.text, label);
              if (!found.length) return null;
              return (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", margin: "0 0 8px" }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#6A7B77" }}>Dismantle &amp; reassemble? <span style={{ fontWeight: 600, color: "#94A4A0" }}>(tap a ✓ to switch Mover / Customer)</span></span>
                  {found.map(it => onDisList(it)
                    ? (disWho(it) === "Customer"
                      ? <button key={it} type="button" onClick={() => toggleDisWho(it)} title="Tap to change who dismantles" style={{ fontSize: 12, fontWeight: 700, color: "#B45309", background: "#FFF7ED", border: "1.5px solid #FDBA74", borderRadius: 99, padding: "4px 10px", cursor: "pointer" }}>✓ {it.replace(/\s*\([^)]*\)$/, "")} · Customer ⇄</button>
                      : <button key={it} type="button" onClick={() => toggleDisWho(it)} title="Tap to change who dismantles" style={{ fontSize: 12, fontWeight: 700, color: "#0F766E", background: "#E8F5F3", border: "1.5px solid #9FD6CE", borderRadius: 99, padding: "4px 10px", cursor: "pointer" }}>✓ {it.replace(/\s*\([^)]*\)$/, "")} · Mover ⇄</button>)
                    : <button key={it} type="button" onClick={() => addDis([it])} style={{ fontSize: 12, fontWeight: 700, color: TEAL, background: "#fff", border: `1.5px solid ${TEAL}`, borderRadius: 99, padding: "4px 10px", cursor: "pointer" }}>+ {it.replace(/\s*\([^)]*\)$/, "")}</button>)}
                </div>
              );
            })()}
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
      {invMode === "detailed" && disSuggest.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, background: "#E8F5F3", border: "1px solid #BFE3DD", borderRadius: 10, padding: "8px 12px", marginBottom: 12 }}>
          <div style={{ fontSize: 12.5, color: "#0B5F58", fontWeight: 600 }}>{disSuggest.length} item{disSuggest.length !== 1 ? "s" : ""} probably need dismantling ({disSuggest.slice(0, 3).map(([, v]) => v.name).join(", ")}{disSuggest.length > 3 ? "…" : ""})</div>
          <Btn size="sm" onClick={tickAllDis}>Tick them</Btn>
        </div>
      )}

      {invMode === "detailed" && detailView === "az" ? renderAZ() : sections.map(s => {
        if (s.addBedroom) return (invMode === "freehand" || !search) ? <button key="addbed" onClick={addBedroom} style={{ width: "100%", marginBottom: 8, padding: "10px", borderRadius: 10, border: `1.5px dashed ${TEAL}`, background: "#F0FDFA", color: TEAL, fontWeight: 700, fontSize: 13, cursor: "pointer" }}>+ Add another bedroom</button> : null;
        if (s.addLounge) return (invMode === "freehand" || !search) ? <button key="addlounge" onClick={addLounge} style={{ width: "100%", marginBottom: 8, padding: "10px", borderRadius: 10, border: `1.5px dashed ${TEAL}`, background: "#F0FDFA", color: TEAL, fontWeight: 700, fontSize: 13, cursor: "pointer" }}>+ Add another lounge</button> : null;
        return invMode === "freehand" ? renderFree(s) : <Section key={s.label} {...s} />;
      })}

      {invMode === "freehand" && (
        <div style={{ marginBottom: 8, border: "1px solid #F3F4F6", borderRadius: 10, padding: "12px 14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 8 }}>
            <div style={{ fontWeight: 700, color: "#111827" }}>Dismantle / Reassemble</div>
          </div>
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
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
            <span style={{ fontSize: 13, opacity: .85 }}>H/W boxes required</span>
            <span style={{ fontWeight: 700 }}>{invMode === "freehand"
              ? Object.values(freeRooms).reduce((n, r) => n + (Number(r.wardrobe) || 0), 0)
              : Object.values(lines).reduce((n, v) => n + (v.qty > 0 && /wardrobe box/i.test(v.name || "") ? Number(v.qty) || 0 : 0), 0)}</span>
          </div>
          {(() => {
            const cv = coversRequired(invMode === "freehand"
              ? Object.values(freeRooms).map(r => ({ freehand: true, raw: r.text, qty: 1 }))
              : Object.values(lines));
            return cv.length ? (
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginBottom: 6 }}>
                <span style={{ fontSize: 13, opacity: .85, flexShrink: 0 }}>Covers required</span>
                <span style={{ fontWeight: 700, textAlign: "right", fontSize: 13 }}>{cv.map(c => <div key={c.name}>{c.qty} × {c.name.replace(/ Cover$/, "")}</div>)}</span>
              </div>
            ) : null;
          })()}
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
// Inventory rows: alternate shading, teal when counted, red when not moving
function invRowStyle(q, i, align = "flex-start") {
  return {
    display: "flex", alignItems: align, justifyContent: "space-between", padding: "9px 14px 9px 10px",
    borderTop: "1px solid #E3E9E8",
    borderLeft: `4px solid ${q > 0 ? TEAL : q < 0 ? "#DC2626" : "transparent"}`,
    background: q > 0 ? "#E6F4F1" : q < 0 ? "#FEF2F2" : (i % 2 ? "#F4F7F6" : "#fff"),
  };
}
const invName = q => ({ color: q < 0 ? "#B91C1C" : "#111827", fontWeight: q !== 0 ? 800 : 500, textDecoration: q < 0 ? "line-through" : "none" });
function stepBtn(active) {
  return { width: 38, height: 38, flexShrink: 0, borderRadius: 9, border: "none", cursor: "pointer", fontSize: 22, fontWeight: 700, background: active ? "#D3ECE7" : "#F3F4F6", color: active ? TEAL : "#9CA3AF", lineHeight: 1 };
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
      status: ["Won", "Lost", "Not quoted"].includes(enquiry.status) ? enquiry.status : (total > 0 ? "Quoted" : enquiry.status),
    };
  }
  // Keep the linked move's price in step with the quote total
  function withMovePrice(d, rec) {
    const job = (d.jobs || []).find(j => j.enquiryId === enquiry.id);
    return job && Number(job.price) !== Number(rec.quoteTotal) ? upsertLocal(d, "jobs", { ...job, price: rec.quoteTotal }) : d;
  }
  async function saveDraft() {
    const rec = buildRecord(enquiry.quoteStatus || "Draft");
    await saveAndReload(withMovePrice(upsertLocal(data, "enquiries", rec), rec));
  }
  async function send() {
    const rec = buildRecord("Sent", todayISO());
    // local-first save, then open email
    const stamped = stampData(withMovePrice(upsertLocal(data, "enquiries", rec), rec));
    setDB(JSON.stringify(stamped));
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
  const toggleVehId = (i, vid) => { setShortWarn(null); return setDays(d => d.map((x, ix) => ix === i ? { ...x, vehicleIds: (x.vehicleIds || []).includes(vid) ? x.vehicleIds.filter(z => z !== vid) : [...(x.vehicleIds || []), vid] } : x)); };
  const toggleCrew = (i, name) => { setShortWarn(null); return setDays(d => d.map((x, ix) => ix === i ? { ...x, crew: (x.crew || []).includes(name) ? x.crew.filter(z => z !== name) : [...(x.crew || []), name] } : x)); };
  function bookedOn(date, exceptIdx) {
    const veh = new Set(), crew = new Set();
    if (!date) return { veh, crew };
    (data.jobs || []).filter(x => (!linkedJob || x.id !== linkedJob.id) && ["Confirmed", "Completed"].includes(x.status)).forEach(x => jobStages(x).forEach(st => { if (st.date === date) { (st.vehicleIds || []).forEach(v => veh.add(v)); (st.crew || []).forEach(c => crew.add(c)); } }));
    days.forEach((st, ix) => { if (ix !== exceptIdx && st.date === date) { (st.vehicleIds || []).forEach(v => veh.add(v)); (st.crew || []).forEach(c => crew.add(c)); } });
    if (date) (data.vehicles || []).forEach(vv => { if (vehOutOn(vv, date)) veh.add(vv.id); }); if (date) (data.staff || []).forEach(s => { if (staffOffOn(s, date)) crew.add(s.name); });
    return { veh, crew };
  }
  const [shortWarn, setShortWarn] = useState(null);
  async function save(force) {
    if (force !== true && linkedJob && ["Confirmed", "Completed"].includes(linkedJob.status)) {
      // Fewer staff / vans than planned or than were booked before: warn, but let them make do.
      const before = (linkedJob.stages || []).map((st, i) => ({ ...st, id: "d" + i }));
      const short = shortDays(days.map((d, i) => ({ ...d, id: "d" + i })), before);
      if (short.length) { setShortWarn(short); return; }
    }
    // Safety net: no vehicle that's booked out for maintenance can be on a move that day.
    const clashes = [];
    days.forEach((d, i) => { if (d.date) (d.vehicleIds || []).forEach(vid => { const vv = (data.vehicles || []).find(x => x.id === vid); if (vv && vehOutOn(vv, d.date)) clashes.push(`${vv.name} on day ${i + 1} (${fmtUK(d.date)})`); }); });
    if (clashes.length) { alert(`These vehicles are booked out for servicing/MOT and can't be used:\n\n${clashes.join("\n")}\n\nRemove them or move the maintenance date.`); return; }
    // Plan deleted (no days left) before any move exists → step back to "Surveyed".
    const stepBack = !days.length && !linkedJob && enquiry.status === "Quoted";
    let d = upsertLocal(data, "enquiries", { ...enquiry, stages: days, ...(stepBack ? { status: "Surveyed", surveyDone: true } : {}) });
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
      {shortWarn && <ShortBanner list={shortWarn} onBack={() => setShortWarn(null)} onSave={() => { setShortWarn(null); save(true); }} />}
      <Btn style={{ width: "100%" }} onClick={() => save()}><Icon name="check" size={16} /> {linkedJob ? "Save & update move" : "Save plan"}</Btn>
      {!linkedJob && (enquiry.stages || []).length > 0 && (
        <Btn variant="danger" style={{ width: "100%", marginTop: 8 }} onClick={async () => {
          if (!confirm("Delete the whole move plan?" + (enquiry.status === "Quoted" ? " The enquiry will go back to Surveyed." : ""))) return;
          await saveAndReload(upsertLocal(data, "enquiries", { ...enquiry, stages: [], ...(enquiry.status === "Quoted" ? { status: "Surveyed", surveyDone: true } : {}) }));
          onClose();
        }}><Icon name="trash" size={15} /> Delete move plan</Btn>
      )}
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

// Call · Message · Email — one row, equal widths, same teal style
const contactRowStyle = n => ({ display: "grid", gridTemplateColumns: `repeat(${Math.max(1, n)}, 1fr)`, gap: 8 });
const contactBtn = { width: "100%", minWidth: 0, padding: "10px 6px", whiteSpace: "nowrap" };
function MessageButton({ customer, ctx, size = "sm", variant = "grey", style }) {
  const [open, setOpen] = useState(false);
  if (!customer) return null;
  return (<>
    <Btn size={size} variant={variant} style={style} onClick={() => setOpen(true)}>💬 Message</Btn>
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
  function setBiz() { const raw = prompt("Your business name (used in messages):", getBusinessName()); if (raw === null) return; localStorage.setItem("removals_business_name", raw.trim()); pick(sel); }
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
        {canDelete() && <button onClick={delTpl} style={{ ...linkBtn, color: "#DC2626" }}>Delete</button>}
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
  const extraStr = list => (list || []).map(s => { const a = [s.address1, s.town, s.postcode].filter(Boolean).join(" "); return a ? a + (s.note ? ` (${s.note})` : "") : ""; }).filter(Boolean);
  const fromFull = [fromAddr, ...extraStr(e.extraFrom)].filter(Boolean).join("   +   ");
  const toAddrFull = [toAddr, ...extraStr(e.extraTo)].filter(Boolean).join("   +   ");
  // Into store: say so on the quote with roughly how long, then where it goes out of store to.
  const storeLen = (() => {
    if (!e.toStore) return "";
    const q = Number(e.storeQty) || 0;
    if (e.storeMode === "Fixed date out" && e.storeOutDate) {
      const start = e.preferredDate || todayISO();
      const wk = Math.max(1, Math.round((new Date(e.storeOutDate) - new Date(start)) / (7 * 86400000)));
      return `until ${fmtUK(e.storeOutDate)}, approx. ${wk} week${wk === 1 ? "" : "s"}`;
    }
    const m = String(e.storeMode || "Weeks").toLowerCase();
    if (q && m.startsWith("month")) return `approx. ${q} month${q === 1 ? "" : "s"} (about ${Math.round(q * 4.33)} weeks)`;
    if (q && m.startsWith("day")) return `approx. ${q} day${q === 1 ? "" : "s"}`;
    if (q && m.startsWith("year")) return `approx. ${q} year${q === 1 ? "" : "s"}`;
    if (q) return `approx. ${q} week${q === 1 ? "" : "s"}`;
    return "length to be confirmed";
  })();
  const toFull = toAddrFull;
  const storeLine = e.toStore ? `Into store - ${storeLen}${toAddrFull ? "  (then delivered out of store to the address below)" : ""}` : "";
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
  const fitSize = (t, maxW, base = 9, min = 6) => { let s = base; const tt = clean(t); while (s > min && font.widthOfTextAtSize(tt, s) > maxW) s -= 0.5; return s; };
  L(92, 144, fromFull, fitSize(fromFull, 468)); L(92, 180, toFull, fitSize(toFull, 468));
  if (storeLine) L(92, 162, storeLine, fitSize(storeLine, 468), bold);
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
    // The enquiry's Notes field (imported notes are cut down to just the survey notes).
    const qNotes = [e.notes, e.quoteExtra && e.quoteExtra.notes].map(x => String(x || "").trim()).filter(Boolean).join("\n");
    if (qNotes) {
      const maxW = boxR - 39, lh = 13.5, maxY = boxBot - 6;
      let ny = 426;
      outer:
      for (const paraRaw of qNotes.split(/\r?\n/)) {
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
  const downloadFile = file => showPdf(file, file.name);
  const share = async () => {
    setErr(""); setBusy(true);
    try {
      const { file, ref } = await makeFile();
      const text = `Hi ${firstName}, please find your removals quotation attached${ref ? ` (ref ${ref})` : ""}. Any questions just let us know.\n\nR&J Removals & Storage`;
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: `Quotation${ref ? " " + ref : ""}`, text }); resetZoomSoon();
      } else { downloadFile(file); }
    } catch (ex) { if (ex && ex.name !== "AbortError") setErr(ex.message || "Could not share the PDF."); }
    setBusy(false);
  };
  const download = async () => {
    setErr(""); setBusy(true);
    try { const { file } = await makeFile(); downloadFile(file); }
    catch (ex) { setErr(ex.message || "Could not build the PDF."); }
    setBusy(false); resetZoomSoon();
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
const VP_LOCKED = "width=device-width, initial-scale=1.0, minimum-scale=1.0, maximum-scale=1.0, user-scalable=no";
const IS_IOS_APP = (() => { try { if (localStorage.getItem("removals_test_ios") === "1") return true; return /iPad|iPhone|iPod/.test(navigator.userAgent) && (window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches); } catch { return false; } })();
// iOS sometimes comes back from its PDF viewer with the app zoomed in. Nudge the
// viewport (slightly different scale, then back to 1) so Safari re-lays the page out.
// Back to the original, gentle zoom reset (same as before 30 Oct): it never changes the
// page scale, so it can't make the screen shimmer.
function resetZoom() {
  try {
    const vp = document.querySelector('meta[name="viewport"]');
    if (!vp) return;
    vp.setAttribute("content", "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=yes");
    setTimeout(() => vp.setAttribute("content", "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"), 80);
  } catch (_e) { /* noop */ }
}
function resetZoomSoon() { setTimeout(resetZoom, 200); }
// ── In-app PDF viewer (iPhone Home Screen app) ──────────────────────────────
// iOS's own PDF viewer leaves the app zoomed in when you come back, so on the iPhone app
// we show the PDF inside the app instead: scroll through the pages, zoom with the
// buttons, and Share (save / print / mail) from there.
async function loadPdfJs() {
  if (window.pdfjsLib) return window.pdfjsLib;
  const base = ["https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/", "https://unpkg.com/pdfjs-dist@3.11.174/build/"];
  for (const b of base) {
    try {
      await loadScript(b + "pdf.min.js");
      if (window.pdfjsLib) { window.pdfjsLib.GlobalWorkerOptions.workerSrc = b + "pdf.worker.min.js"; return window.pdfjsLib; }
    } catch (_e) { /* try next */ }
  }
  throw new Error("Could not load the PDF viewer");
}
async function openPdfViewer(blob, name) {
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
  const prevOverflow = document.body.style.overflow;
  const wrap = document.createElement("div");
  wrap.id = "rm-pdf-viewer";
  wrap.style.cssText = "position:fixed;inset:0;z-index:10000;background:#525659;display:flex;flex-direction:column;font-family:Inter,system-ui,sans-serif;";
  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;align-items:center;gap:8px;padding:calc(env(safe-area-inset-top, 0px) + 10px) 12px 10px;background:#0F2E2A;color:#fff;";
  const btn = (label, primary) => { const b = document.createElement("button"); b.textContent = label; b.style.cssText = `border:none;border-radius:10px;padding:9px 13px;font-weight:700;font-size:14px;cursor:pointer;${primary ? "background:#14B8A6;color:#fff;" : "background:rgba(255,255,255,.14);color:#fff;"}`; return b; };
  const close = btn("✕ Close"), minus = btn("−"), plus = btn("+"), print = btn("🖨 Print"), share = btn("Share", true);
  const title = document.createElement("div");
  title.textContent = name.replace(/\.pdf$/i, "");
  title.style.cssText = "flex:1;min-width:0;font-size:13px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.85;";
  bar.append(close, title, minus, plus, print, share);
  const scroller = document.createElement("div");
  scroller.style.cssText = "flex:1;overflow:auto;-webkit-overflow-scrolling:touch;padding:12px 0 calc(env(safe-area-inset-bottom, 0px) + 20px);";
  const pages = document.createElement("div");
  pages.style.cssText = "margin:0 auto;display:flex;flex-direction:column;align-items:center;gap:12px;padding:0 10px;";
  scroller.appendChild(pages);
  wrap.append(bar, scroller);
  document.body.appendChild(wrap);
  document.body.style.overflow = "hidden";
  let zoom = 1;
  const applyZoom = () => { pages.style.width = `${zoom * 100}%`; pages.querySelectorAll("canvas").forEach(c => { c.style.width = "100%"; }); minus.disabled = zoom <= 1; minus.style.opacity = zoom <= 1 ? .4 : 1; plus.style.opacity = zoom >= 3 ? .4 : 1; };
  minus.onclick = () => { zoom = Math.max(1, zoom - .5); applyZoom(); };
  plus.onclick = () => { zoom = Math.min(3, zoom + .5); applyZoom(); };
  close.onclick = () => { wrap.remove(); document.body.style.overflow = prevOverflow; };
  // Print: put the drawn pages into a print-only layer and open the print dialog (AirPrint on iPhone/iPad).
  let drawing = true;
  print.onclick = async () => {
    if (drawing) { print.textContent = "Wait…"; while (drawing && document.body.contains(wrap)) await new Promise(r => setTimeout(r, 200)); print.textContent = "🖨 Print"; }
    document.getElementById("rm-print")?.remove(); document.getElementById("rm-print-css")?.remove();
    const holder = document.createElement("div"); holder.id = "rm-print";
    pages.querySelectorAll("canvas").forEach(c => { const img = document.createElement("img"); img.src = c.toDataURL("image/jpeg", 0.92); holder.appendChild(img); });
    const css = document.createElement("style"); css.id = "rm-print-css";
    css.textContent = "#rm-print{display:none}@media print{@page{size:A4;margin:0}html,body{background:#fff!important;height:auto!important;overflow:visible!important}body>*:not(#rm-print){display:none!important}#rm-print{display:block!important}#rm-print img{display:block;width:100%;height:auto;page-break-after:always;break-after:page}#rm-print img:last-child{page-break-after:auto;break-after:auto}}";
    document.head.appendChild(css); document.body.appendChild(holder);
    const cleanup = () => { holder.remove(); css.remove(); window.removeEventListener("afterprint", cleanup); };
    window.addEventListener("afterprint", cleanup);
    setTimeout(() => { try { window.print(); } catch (_e) {} setTimeout(cleanup, 60000); }, 150);
  };
  share.onclick = async () => {
    const file = new File([blob], name, { type: "application/pdf" });
    try { if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file] }); return; } } catch (_e) { return; }
    const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 8000);
  };
  applyZoom();
  const cssW = Math.min(window.innerWidth - 20, 900);
  const dpr = Math.min(window.devicePixelRatio || 1, 2) * 1.5; // extra detail so zooming in stays sharp
  for (let n = 1; n <= doc.numPages; n++) {
    if (!document.body.contains(wrap)) break; // closed while still drawing
    const page = await doc.getPage(n);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: (cssW / vp1.width) * dpr });
    const c = document.createElement("canvas");
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    c.style.cssText = "width:100%;height:auto;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.35);display:block;";
    pages.appendChild(c);
    await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
  }
  drawing = false;
}
// Show a PDF: inside the app on the iPhone Home Screen app, otherwise the device's usual way.
async function showPdf(src, name = "document.pdf") {
  if (IS_IOS_APP) {
    try {
      const blob = src instanceof Blob ? src : await (await fetch(src)).blob();
      await openPdfViewer(blob, (src instanceof File && src.name) || name);
      return;
    } catch (_e) {
      document.getElementById("rm-pdf-viewer")?.remove(); document.body.style.overflow = "";
      /* viewer couldn't load (no signal?) — fall back to the share menu */
      try {
        const blob = src instanceof Blob ? src : await (await fetch(src)).blob();
        const file = src instanceof File ? src : new File([blob], name, { type: "application/pdf" });
        if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file] }); } catch (_e2) {} return; }
      } catch (_e3) { /* open it the normal way */ }
    }
  }
  const url = src instanceof Blob ? URL.createObjectURL(src) : src;
  const a = document.createElement("a"); a.href = url; a.target = "_blank"; a.rel = "noopener";
  if (src instanceof File) a.download = src.name;
  document.body.appendChild(a); a.click(); a.remove();
  if (src instanceof Blob) setTimeout(() => URL.revokeObjectURL(url), 8000);
  resetZoomSoon();
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
  (e.extraFrom || []).forEach((s, i) => { const a = [s.address1, s.town, s.postcode].filter(Boolean).join(", "); if (a) kv(`+ Pickup ${i + 2}`, a + (s.note ? `  (${s.note})` : "")); });
  kv("Moving to", toAddr);
  (e.extraTo || []).forEach((s, i) => { const a = [s.address1, s.town, s.postcode].filter(Boolean).join(", "); if (a) kv(`+ Delivery ${i + 2}`, a + (s.note ? `  (${s.note})` : "")); });
  if (storeSummary(e)) kv("Storage", storeSummary(e));

  if (e.fromAccess || e.toAccess) {
    heading("Access — please read");
    kvWrap("From", e.fromAccess);
    kvWrap("To", e.toAccess);
  }

  const _job = (data.jobs || []).find(j => j.enquiryId === e.id);
  const stages = (_job && Array.isArray(_job.stages) && _job.stages.length) ? _job.stages : (Array.isArray(e.stages) ? e.stages : []);
  const vName = id => { const v = (data.vehicles || []).find(x => x.id === id); return v ? (v.reg ? `${v.name} (${v.reg})` : v.name) : ""; };
  heading("Move plan");
  if (!stages.length) { at("To be confirmed.", M, y, 9.5, font, navy); y -= 16; }
  else stages.forEach((d, i) => {
    ensure(40);
    const when = [d.date ? `${fmtUK(d.date)} (${dow(d.date)})` : "Date TBC", d.time].filter(Boolean).join(" · ");
    at(`Day ${i + 1}`, M, y, 9.5, bold, navy); at(`${d.type || "Move"}  —  ${when}`, M + 50, y, 9.5, font, navy); y -= 14;
    if (forStaff || forOffice) {
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
        const red = rgb(0.86, 0.15, 0.15);
        ensure(13); at("NOT MOVING:", M + 10, y, 9.5, bold, red); y -= 13;
        staying.forEach(it => { ensure(13); at(`-  ${Math.abs(it.qty)} x ${it.name}`, M + 18, y, 9.5, bold, red); y -= 13; });
      }
      y -= 4;
    });
    ensure(18); page.drawLine({ start: { x: M, y: y + 4 }, end: { x: W - M, y: y + 4 }, thickness: 0.6, color: grey });
    const cuft = Math.round(e.volumeCuFt || 0), m3 = (e.volumeM3 || 0).toFixed(1);
    at(`Total volume: ${cuft} cu ft  (${m3} m3)`, M, y - 6, 10, bold, teal); y -= 22;
  }

  const covers = coversRequired(inv);
  const hw = hwBoxes(inv);
  if ((forStaff || forOffice) && (covers.length || hw)) {
    heading("Equipment required");
    if (hw) { ensure(13); at(`${hw} x Hanging Wardrobe Box`, M + 10, y, 9.5, font, navy); y -= 13; }
    covers.forEach(cv => { ensure(13); at(`${cv.qty} x ${cv.name}`, M + 10, y, 9.5, font, navy); y -= 13; });
    y -= 6;
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
  const downloadFile = file => showPdf(file, file.name);
  const share = async () => {
    setErr(""); setBusy(true);
    try {
      const { file } = await makeFile();
      const text = staff
        ? `Move plan (staff copy) attached — crew and vehicles included.\n\nR&J Removals & Storage`
        : `Hi ${firstName}, please find your survey and move plan attached. Have a look through and let us know if anything needs changing.\n\nR&J Removals & Storage`;
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: staff ? "Move Plan — Staff copy" : mode === "office" ? "Survey — Office copy" : "Survey & Move Plan", text }); resetZoomSoon(); }
      else downloadFile(file);
    } catch (ex) { if (ex && ex.name !== "AbortError") setErr(ex.message || "Could not share the PDF."); }
    setBusy(false);
  };
  const download = async () => { setErr(""); setBusy(true); try { const { file } = await makeFile(); downloadFile(file); } catch (ex) { setErr(ex.message || "Could not build the PDF."); } setBusy(false); resetZoomSoon(); };
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

// Days with fewer staff / vans than planned, or than were booked on before this change.
function shortDays(days, before) {
  return (days || []).map((d, i) => {
    const prev = (before || []).find(b => b.id === d.id) || {};
    const ps = Math.max(Number(d.staffCount) || 0, (prev.crew || []).length);
    const pv = Math.max(Object.values(d.vehTypes || {}).reduce((n, v) => n + (Number(v) || 0), 0), (prev.vehicleIds || []).length);
    const nc = (d.crew || []).length, nv = (d.vehicleIds || []).length;
    const ss = Math.max(0, ps - nc), vs = Math.max(0, pv - nv);
    const bits = [];
    if (!nc) bits.push("no crew"); else if (ss) bits.push(`${ss} staff short (${nc} of ${ps})`);
    if (!nv) bits.push("no vehicle"); else if (vs) bits.push(`${vs} vehicle${vs !== 1 ? "s" : ""} short (${nv} of ${pv})`);
    return bits.length ? `${d.type || "Day " + (i + 1)}${d.date ? " " + fmtDate(d.date) : ""}: ${bits.join(", ")}` : null;
  }).filter(Boolean);
}
function ShortBanner({ list, onBack, onSave }) {
  return (
    <div style={{ background: "#FFF7ED", border: "2px solid #F59E0B", borderRadius: 12, padding: "12px 13px", marginBottom: 10 }}>
      <div style={{ fontSize: 15, fontWeight: 800, color: "#9A3412", marginBottom: 6 }}>⚠ Fewer staff / vehicles than planned</div>
      {list.map(t => <div key={t} style={{ fontSize: 13.5, color: "#7C2D12", fontWeight: 600, marginBottom: 3 }}>• {t}</div>)}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <Btn variant="grey" style={{ flex: 1 }} onClick={onBack}>Go back</Btn>
        <Btn style={{ flex: 1, background: "#D97706" }} onClick={onSave}>Save anyway</Btn>
      </div>
    </div>
  );
}
function MoveManageModal({ data, job, onClose }) {
  const [f, setF] = useState({ price: job.price ?? "", deposit: job.deposit ?? "", depositPaid: !!job.depositPaid, balancePaid: !!job.balancePaid, status: job.status || "Provisional" });
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const price = Number(f.price) || 0;
  const balanceDue = price - (Number(f.deposit) || 0);
  const [assign, setAssign] = useState(false);
  const [changing, setChanging] = useState(false); // change crew / vans on a confirmed move (sickness, van off road…)
  const [shortWarn, setShortWarn] = useState(null); // list of short days, shown as a banner before saving
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
  const toggleCrew = (i, name) => { setShortWarn(null); setDays(d => d.map((x, ix) => ix === i ? { ...x, crew: x.crew.includes(name) ? x.crew.filter(c => c !== name) : [...x.crew, name] } : x)); };
  const toggleVeh = (i, vid) => { setShortWarn(null); setDays(d => d.map((x, ix) => ix === i ? { ...x, vehicleIds: x.vehicleIds.includes(vid) ? x.vehicleIds.filter(v => v !== vid) : [...x.vehicleIds, vid] } : x)); };
  async function persist(extra) {
    await saveAndReload(upsertLocal(data, "jobs", { ...job, price: Number(f.price) || 0, deposit: Number(f.deposit) || 0, depositPaid: f.depositPaid, balancePaid: f.balancePaid, status: f.status, ...extra }));
    onClose();
  }
  // Anyone/anything assigned who's now off (holiday, sick, van off road) on that day.
  const clashes = days.flatMap(d => {
    if (!d.date) return [];
    const out = [];
    (d.crew || []).forEach(n => { const st = (data.staff || []).find(x => x.name === n); if (st && staffOffOn(st, d.date)) out.push(`${n} is off on ${fmtDate(d.date)}`); });
    (d.vehicleIds || []).forEach(vid => { const v = (data.vehicles || []).find(x => x.id === vid); if (v && vehOutOn(v, d.date)) out.push(`${[v.name, v.reg].filter(Boolean).join(" ")} is off the road on ${fmtDate(d.date)}`); });
    return out;
  });
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
  const letGoMove = async () => {
    if (!confirm("Let this move go?\n\nIt'll be kept for your records but removed from the calendar, availability and upcoming moves. You can reinstate it later.")) return;
    let d2 = upsertLocal(data, "jobs", { ...job, price: Number(f.price) || 0, deposit: Number(f.deposit) || 0, depositPaid: f.depositPaid, balancePaid: f.balancePaid, status: "Let Go" });
    const enq = (data.enquiries || []).find(x => x.id === job.enquiryId);
    if (enq) d2 = upsertLocal(d2, "enquiries", { ...enq, status: "Let Go" });
    await saveAndReload(d2);
  };
  const reinstateMove = async () => {
    let d2 = upsertLocal(data, "jobs", { ...job, price: Number(f.price) || 0, deposit: Number(f.deposit) || 0, depositPaid: f.depositPaid, balancePaid: f.balancePaid, status: "Provisional" });
    const enq = (data.enquiries || []).find(x => x.id === job.enquiryId);
    if (enq && enq.status === "Let Go") d2 = upsertLocal(d2, "enquiries", { ...enq, status: "Won" });
    await saveAndReload(d2);
  };
  const reopenConfirmed = () => persist({ status: "Confirmed" });
  const revertProvisional = () => persist({ status: "Provisional" });
  async function removeMove() {
    if (!confirm("Remove this move and send the enquiry back to Quoted? Day assignments will be lost.")) return;
    addTombstone(job.id);
    SAVING_IN_PROGRESS = true; showSavingOverlay();
    try { await deleteRecord("jobs", job.id); } catch {}
    let d2 = { ...data, jobs: (data.jobs || []).filter(x => x.id !== job.id) };
    const enq = (d2.enquiries || []).find(x => x.id === job.enquiryId);
    if (enq) { d2 = upsertLocal(d2, "enquiries", { ...enq, status: "Quoted", quoteStatus: "Sent" }); d2 = altReopen(d2, enq); }
    const stamped = stampData(d2);
    setDB(JSON.stringify(stamped));
    try { await pushChangedOnly(stamped); } catch {}
    SAVING_IN_PROGRESS = false;
    window.location.reload();
  }
  return (
    <Modal title={`Move ${moveRef(data, job)}`} onClose={onClose}>
      <div style={{ marginBottom: 12 }}><StatusBadge status={jobBadge({ ...job, status: f.status })} /></div>
      <Field label="Price (£)"><Input type="number" inputMode="decimal" value={f.price} onChange={v => set("price", v)} /></Field>
      <Field label="Deposit (£)"><Input type="number" inputMode="decimal" value={f.deposit} onChange={v => set("deposit", v)} /></Field>
      <div style={{ fontSize: 14, fontWeight: 700, color: "#10211E", margin: "2px 0 12px" }}>Balance due: {gbp(balanceDue)}</div>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, marginBottom: 8 }}><input type="checkbox" checked={f.depositPaid} onChange={ev => set("depositPaid", ev.target.checked)} style={{ width: 18, height: 18 }} /> Deposit paid</label>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, marginBottom: 16 }}><input type="checkbox" checked={f.balancePaid} onChange={ev => set("balancePaid", ev.target.checked)} style={{ width: 18, height: 18 }} /> Balance paid</label>

      {f.status === "Confirmed" && !changing && (
        <div style={{ marginBottom: 12 }}>
          {clashes.length > 0 && <div style={{ fontSize: 13, fontWeight: 700, color: "#B91C1C", background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 9, padding: "9px 12px", marginBottom: 8 }}>⚠ {clashes.join(" · ")} — change them below.</div>}
          <Btn variant="grey" style={{ width: "100%" }} onClick={() => setChanging(true)}>👷 Change crew / vehicles</Btn>
        </div>
      )}
      {((assign && f.status === "Provisional") || (changing && f.status === "Confirmed")) && (
        <div style={{ marginBottom: 12, borderTop: "1px solid #EEF3F2", paddingTop: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: "#1D4ED8", background: "#EFF4FF", border: "1px solid #C7D7FE", borderRadius: 9, padding: "10px 12px", marginBottom: 12 }}>{changing ? "Change who's on each day: tap a name or van to take it off, tap another to put it on, then press Save." : "Assign named staff and a vehicle to each day, then press Confirm again."}</div>
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

      {["Provisional", "Confirmed"].includes(f.status) && <Btn variant="grey" style={{ width: "100%", marginBottom: 10 }} onClick={letGoMove}>Let this move go</Btn>}
      {f.status === "Let Go" && (
        <>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#6B7280", background: "#F3F4F6", border: "1px solid #E5E7EB", borderRadius: 9, padding: "10px 12px", marginBottom: 10 }}>Let go — kept for your records but hidden from the calendar, availability and upcoming moves.</div>
          <Btn variant="primary" style={{ width: "100%", marginBottom: 10 }} onClick={reinstateMove}>Reinstate move</Btn>
        </>
      )}
      {shortWarn && <ShortBanner list={shortWarn} onBack={() => setShortWarn(null)} onSave={() => persist({ stages: days })} />}
      <Btn style={{ width: "100%", marginBottom: 10 }} onClick={() => {
        if (changing) {
          // Warn (but allow) when a day has fewer staff or vans than planned/booked — sometimes you have to make do.
          const short = shortDays(days, jobStages(job));
          if (short.length && !shortWarn) { setShortWarn(short); return; }
        }
        persist(changing || assign ? { stages: days } : undefined);
      }}><Icon name="check" size={16} /> Save</Btn>
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

// "Why" line for Didn't quote / Lost / Let Go enquiries, shown on cards everywhere.
function ReasonLine({ e, small }) {
  if (!e || !["Not quoted", "Lost", "Let Go"].includes(e.status) || e.altClosed) return null;
  const r = String(e.lostReason || "").trim();
  const col = e.status === "Lost" ? "#B91C1C" : "#6B7280";
  return <div style={{ fontSize: small ? 11 : 12.5, fontWeight: 700, color: r ? col : "#9CA3AF", marginTop: 2 }}>{e.status === "Not quoted" ? "🚫 " : e.status === "Lost" ? "✕ " : ""}{r || "No reason given"}</div>;
}
// Small "🔀 2 quotes · showing Into store" note for cards when a customer has alternative quotes.
function AltNote({ data, e, small }) {
  const g = altGroup(data, e);
  if (g.length < 2) return null;
  return <div style={{ fontSize: small ? 10.5 : 12, fontWeight: 800, color: "#7C3AED", marginTop: 2 }}>🔀 {g.length} quotes{e.altLabel ? ` · showing ${e.altLabel}` : ""}</div>;
}
function AltOptions({ data, e, setView }) {
  const [picking, setPicking] = useState(false);
  const [other, setOther] = useState("");
  const group = altGroup(data, e).sort((a, b) => (a.altOf ? 1 : 0) - (b.altOf ? 1 : 0) || String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  const labelOf = x => x.altLabel || (x.toStore ? "Into store" : "Direct move");
  const closedAll = group.some(x => x.status === "Won" || (data.jobs || []).some(j => j.enquiryId === x.id && j.status !== "Let Go"));
  const shownId = (altReps(data, group)[0] || {}).id;
  // Email every priced option in one go: both PDFs go into one share (pick Mail on the iPhone),
  // then each option is marked as emailed.
  const priced = group.filter(x => Number(x.quoteTotal) > 0 && !x.altClosed);
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState("");
  async function emailAll() {
    const cust = (data.customers || []).find(c => c.id === e.customerId) || {};
    setSendErr(""); setSending(true);
    try {
      const files = [];
      for (const x of priced) {
        const { bytes, ref } = await buildQuotePdf(x, cust);
        files.push(new File([bytes], `Quote ${ref || cust.ref || "RJ"} - ${labelOf(x)}.pdf`.replace(/[\/:*?"<>|]/g, "-"), { type: "application/pdf" }));
      }
      const first = String(cust.name || "").replace(/^(mr|mrs|ms|miss|dr)\.?\s+/i, "").trim().split(/\s+/)[0] || "there";
      const opts = priced.map(x => `• ${labelOf(x)}: ${gbp(x.quoteTotal)}`).join("\n");
      const text = `Hi ${first}, please find your removals quotations attached, one for each option:\n${opts}\n\nAny questions just let us know.\n\nR&J Removals & Storage`;
      let sent = false;
      if (navigator.canShare && navigator.canShare({ files })) {
        try { await navigator.share({ files, title: "Removals quotations", text }); sent = true; resetZoomSoon(); }
        catch (ex) { if (ex && ex.name !== "AbortError") throw ex; }
      } else {
        files.forEach(f => showPdf(f, f.name));
        sent = confirm("The quotes have been saved. Mark them all as emailed?");
      }
      if (sent) {
        let d2 = data;
        priced.forEach(x => { d2 = upsertLocal(d2, "enquiries", { ...x, quoteStatus: x.quoteStatus === "Accepted" ? "Accepted" : "Sent", quoteSentDate: todayISO(), status: ["Won", "Lost", "Not quoted"].includes(x.status) ? x.status : "Quoted" }); });
        setSending(false);
        await saveAndReload(d2);
        return;
      }
    } catch (ex) { setSendErr((ex && ex.message) || "Could not make the quotes."); }
    setSending(false);
  }
  async function reopen(x) {
    const root = group.find(y => !y.altOf) || e;
    let d2 = upsertLocal(data, "enquiries", { ...x, altClosed: false, status: Number(x.quoteTotal) > 0 ? "Quoted" : (x.volumeCuFt ? "Surveyed" : "New"), updatedAt: Date.now() });
    const r2 = (d2.enquiries || []).find(y => y.id === root.id) || root;
    d2 = upsertLocal(d2, "enquiries", { ...r2, altPick: x.id, updatedAt: Date.now() });
    await saveAndReload(d2);
  }
  async function select(x) {
    const root = group.find(y => !y.altOf) || e;
    await saveAndReload(upsertLocal(data, "enquiries", { ...root, altPick: x.id, updatedAt: Date.now() }));
  }
  async function create(label) {
    const root = group.find(x => !x.altOf) || e;
    const nid = uid();
    const copy = { ...e, id: nid, altOf: root.id, altLabel: label,
      toStore: label === "Into store" ? true : label === "Direct move" ? false : !!e.toStore,
      quoteLines: [], quoteTotal: 0, quoteVat: e.quoteVat, quoteStatus: "Draft", quoteSentDate: "", quoteChasedAt: "", quoteChaseDate: "", noChase: false,
      status: (e.volumeCuFt || (e.inventory || []).length) ? "Surveyed" : (["Won", "Lost", "Let Go", "Not quoted", "Quoted"].includes(e.status) ? "Surveyed" : e.status),
      altClosed: false, followUpDate: "", followUpTime: "", followUpNote: "", lostReason: "", createdAt: new Date().toISOString(), updatedAt: Date.now() };
    let d2 = upsertLocal(data, "enquiries", copy);
    if (!root.altLabel) d2 = upsertLocal(d2, "enquiries", { ...root, altLabel: labelOf(root) });
    try { sessionStorage.setItem("removals_view", JSON.stringify({ screen: "enquiryDetail", id: nid })); } catch {}
    await saveAndReload(d2);
  }
  const chip = x => {
    const cur = x.id === e.id;
    const j = (data.jobs || []).find(jb => jb.enquiryId === x.id && jb.status !== "Let Go");
    return (
      <button key={x.id} type="button" data-ro-ok onClick={() => !cur && setView({ screen: "enquiryDetail", id: x.id })} style={{ textAlign: "left", padding: "8px 11px", borderRadius: 11, cursor: cur ? "default" : "pointer", fontFamily: "inherit",
        border: cur ? "2px solid #7C3AED" : "1.5px solid #DDD6FE", background: cur ? "#F5F3FF" : "#fff", minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: "#5B21B6" }}>{labelOf(x)}{cur ? " · viewing" : ""}</div>
        <div style={{ fontSize: 12, color: "#6B7280", fontWeight: 600 }}>{x.volumeCuFt ? `${x.volumeCuFt} cu ft` : "no survey"} · {x.quoteTotal ? gbp(x.quoteTotal) : "no quote"} · {j ? "Booked" : enqBadge(data, x)}</div>
        {x.id === shownId
          ? <div style={{ fontSize: 11.5, fontWeight: 800, color: "#059669", marginTop: 3 }}>✓ Selected — used on lists &amp; reports</div>
          : (!closedAll && !isReadOnly() && x.altClosed) ? <span role="button" onClick={ev => { ev.stopPropagation(); reopen(x); }} style={{ display: "inline-block", fontSize: 11.5, fontWeight: 800, color: "#7C3AED", background: "#fff", border: "1.5px solid #C4B5FD", borderRadius: 99, padding: "3px 9px", marginTop: 4 }}>↺ Reopen this one</span>
          : (!closedAll && !isReadOnly() && !x.altClosed) ? <span role="button" onClick={ev => { ev.stopPropagation(); select(x); }} style={{ display: "inline-block", fontSize: 11.5, fontWeight: 800, color: "#fff", background: "#7C3AED", borderRadius: 99, padding: "3px 9px", marginTop: 4 }}>Select this one</span> : null}
      </button>
    );
  };
  if (isReadOnly() && group.length < 2) return null;
  return (
    <div style={{ marginBottom: 12 }}>
      {group.length > 1 && <div style={{ fontSize: 11.5, fontWeight: 800, color: "#7C3AED", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 6 }}>🔀 Quote options</div>}
      {group.length > 1 && <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>{group.map(chip)}</div>}
      {!isReadOnly() && !closedAll && priced.length > 1 && (
        <button type="button" disabled={sending} onClick={emailAll} style={{ width: "100%", padding: "10px 12px", borderRadius: 11, border: "none", background: "#F59E0B", color: "#fff", fontWeight: 800, fontSize: 14.5, cursor: "pointer", fontFamily: "inherit", marginBottom: 8 }}>
          {sending ? "Making the quotes…" : `📧 Email all ${priced.length} quotes${priced.every(x => ["Sent", "Accepted"].includes(x.quoteStatus)) ? " again" : ""}`}
        </button>
      )}
      {sendErr && <div style={{ fontSize: 13, color: "#B91C1C", marginBottom: 8 }}>{sendErr}</div>}
      {!isReadOnly() && !closedAll && !picking && (
        <button type="button" onClick={() => setPicking(true)} style={{ width: "100%", padding: "9px 12px", borderRadius: 11, border: "1.5px dashed #C4B5FD", background: "#FAF5FF", color: "#6D28D9", fontWeight: 800, fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}>＋ Alternative quote</button>
      )}
      {picking && (
        <div style={{ border: "1.5px solid #DDD6FE", background: "#FAF5FF", borderRadius: 12, padding: 12 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: "#10211E", marginBottom: 4 }}>Copy this enquiry and its inventory as another option:</div>
          <div style={{ fontSize: 12.5, color: "#6A7B77", marginBottom: 10 }}>Then edit the copy's inventory (e.g. take off clothes and plants not going into store) and build its own quote.</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <Btn size="sm" onClick={() => create("Into store")}>📦 Into store</Btn>
            <Btn size="sm" onClick={() => create("Direct move")}>🚚 Direct move</Btn>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input value={other} onChange={ev => setOther(ev.target.value)} placeholder="Or name it, e.g. Part load" style={{ flex: 1, minWidth: 0, padding: "9px 11px", borderRadius: 10, border: "1px solid #D9E2E0", fontSize: 15 }} />
            <Btn size="sm" variant="grey" disabled={!other.trim()} onClick={() => create(other.trim())}>Add</Btn>
          </div>
          <div style={{ textAlign: "right", marginTop: 8 }}><Btn size="sm" variant="grey" onClick={() => setPicking(false)}>Cancel</Btn></div>
        </div>
      )}
    </div>
  );
}

// ── FileMaker-style customer record (iPad, "FileMaker" layout) ──────────────
// Same data and buttons as the classic screen, laid out like the old FileMaker
// record: customer + addresses on top, tabs underneath. Switch back any time
// with "Layout" at the bottom of the side menu.
const LAYOUT_KEY = "removals_layout";
const getLayout = () => { try { return localStorage.getItem(LAYOUT_KEY) === "filemaker" ? "filemaker" : "classic"; } catch { return "classic"; } };
const setLayoutPref = v => { try { localStorage.setItem(LAYOUT_KEY, v); } catch {} };
const fmStamp = v => { if (!v) return ""; const d = typeof v === "number" ? new Date(v) : new Date(v); return isNaN(d) ? "" : fmtUK(d.toISOString().slice(0, 10)); };
const FM_LINE = "#D9E2E0";
function FmField({ label, children, lw = 112, onClick }) {
  return (
    <div onClick={onClick} style={{ display: "flex", alignItems: "stretch", minHeight: 44, border: `1px solid ${FM_LINE}`, borderRadius: 10, background: "#fff", overflow: "hidden", fontSize: 14.5, cursor: onClick ? "pointer" : "default" }}>
      <span style={{ width: lw, flexShrink: 0, background: "#F3F7F6", borderRight: `1px solid ${FM_LINE}`, display: "flex", alignItems: "center", padding: "0 12px", color: "#55665F", fontSize: 13, fontWeight: 700 }}>{label}</span>
      <span style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", padding: "8px 12px", color: "#10211E", fontWeight: 600, overflowWrap: "anywhere" }}>{children || <span style={{ color: "#94A4A0", fontWeight: 500 }}>—</span>}</span>
    </div>
  );
}
function FmBox({ children, ph }) {
  return <div style={{ minHeight: 44, border: `1px solid ${FM_LINE}`, borderRadius: 10, background: "#fff", display: "flex", alignItems: "center", padding: "8px 12px", fontSize: 15, fontWeight: ph ? 500 : 600, color: ph ? "#94A4A0" : "#10211E", boxSizing: "border-box" }}>{children}</div>;
}
function FmSeg({ items, value, onChange, big }) {
  return (
    <div role="tablist" style={{ display: "flex", background: "#E4ECEA", borderRadius: 12, padding: 4, gap: 4 }}>
      {items.map(([k, l]) => {
        const on = k === value;
        return <button key={k} type="button" role="tab" aria-selected={on} data-ro-ok onClick={() => onChange(k)} style={{ flex: 1, minWidth: 0, height: big ? 44 : 38, border: "none", borderRadius: 9, background: on ? "#fff" : "transparent", boxShadow: on ? "0 1px 3px rgba(16,33,30,.15)" : "none", color: on ? TEAL : "#55665F", fontFamily: "inherit", fontSize: big ? 14.5 : 13, fontWeight: on ? 800 : 600, cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", padding: "0 6px" }}>{l}</button>;
      })}
    </div>
  );
}
function BookedNoMove({ data, e, linkedJob, onCreate }) {
  // A "Booked" (Won) enquiry with no move behind it — e.g. brought over from Mover, or its
  // move was removed. Without a move there's nothing to change, so offer to set one up.
  if (isReadOnly() || e.status !== "Won" || linkedJob) return null;
  const backTo = Number(e.quoteTotal) > 0 ? "Quoted" : (e.surveyDone || e.volumeCuFt ? "Surveyed" : "New");
  return (
    <div style={{ background: "#FFFBEB", border: "1.5px solid #FDE68A", borderRadius: 14, padding: "12px 14px", marginBottom: 12 }}>
      <div style={{ fontWeight: 800, color: "#10211E", fontSize: 15 }}>Manage booking</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: "#92400E", marginTop: 2 }}>Booked, but no move has been set up yet. Choose how to book it:</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 8 }}>
        <Btn size="sm" style={{ whiteSpace: "nowrap" }} onClick={() => onCreate("Provisional")}>Provisional move</Btn>
        <Btn size="sm" style={{ whiteSpace: "nowrap" }} onClick={() => onCreate("Confirmed")}>Confirmed move</Btn>
        <Btn size="sm" variant="grey" style={{ whiteSpace: "nowrap" }} onClick={() => saveAndReload(upsertLocal(data, "enquiries", { ...e, status: backTo, quoteStatus: e.quoteStatus === "Accepted" ? "Sent" : e.quoteStatus }))}>Back to {backTo}</Btn>
      </div>
    </div>
  );
}
function EnquiryFileMaker({ data, e, customer, linkedJob, setView, quoteDone, act }) {
  const c = customer || {};
  const [side, setSide] = useState("from");
  const [tab, setTabRaw] = useState(() => { try { return localStorage.getItem("removals_fm_tab") || "survey"; } catch { return "survey"; } });
  const setTab = t => { setTabRaw(t); try { localStorage.setItem("removals_fm_tab", t); } catch {} };
  const ro = isReadOnly();
  // Previous / Next follow the order of the enquiries list you came from.
  let order = [];
  try { order = JSON.parse(sessionStorage.getItem("removals_enq_order") || "[]"); } catch {}
  if (!order.includes(e.id)) order = (data.enquiries || []).slice().sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")).map(x => x.id);
  const pos = order.indexOf(e.id);
  const go = id => id && setView({ screen: "enquiryDetail", id });
  const nm = (c.company ? `${c.name} (${c.company})` : c.name) || "Unknown";
  const fromLines = [e.fromAddress1, e.fromAddress2, e.fromTown, e.fromPostcode];
  const toLines = [e.toAddress1, e.toAddress2, e.toTown, e.toPostcode];
  const addr = a => a.filter(Boolean).join(", ");
  const maps = q => window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`, "_blank");
  const distance = () => window.open(`https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(addr(fromLines))}&destination=${encodeURIComponent(addr(toLines))}`, "_blank");
  const hdrBtn = { height: 44, padding: "0 14px", borderRadius: 10, border: "none", background: "rgba(255,255,255,.12)", color: "#fff", fontFamily: "inherit", fontSize: 14, fontWeight: 700, cursor: "pointer" };
  const sb = { padding: "10px 12px", whiteSpace: "nowrap" };
  const surveyed = !!(e.surveyDone || ["Surveyed", "Quoted", "Won"].includes(e.status));
  const hasInv = !!(e.inventory && e.inventory.length);
  const covers = coversRequired(e.inventory);
  const hw = hwBoxes(e.inventory);
  const sideLines = side === "from" ? fromLines : toLines;
  const extra = side === "from" ? (e.extraFrom || []) : (e.extraTo || []);
  const q = quoteChase(data, e);
  const H2 = ({ children }) => <div style={{ fontSize: 12.5, fontWeight: 800, letterSpacing: ".05em", textTransform: "uppercase", color: "#10211E", margin: "4px 0 2px" }}>{children}</div>;
  const grid2 = { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0, minHeight: "100%" }}>
      {/* Header: name, ref, status, Previous / Next */}
      <div style={{ background: NAVY, color: "#fff", padding: "12px 18px", display: "flex", alignItems: "center", gap: 10, borderRadius: 14 }}>
        <button type="button" data-ro-ok onClick={() => setView({ screen: "enquiries" })} style={hdrBtn} aria-label="Back to list">‹ List</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#A7D3CC" }}>{c.ref ? `Ref ${c.ref}` : "No ref"}{pos >= 0 ? ` · ${pos + 1} of ${order.length}` : ""}</div>
          <div style={{ fontSize: 21, fontWeight: 800, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{nm}</div>
        </div>
        <StatusBadge status={enqBadge(data, e)} />
        <button type="button" data-ro-ok disabled={pos <= 0} onClick={() => go(order[pos - 1])} style={{ ...hdrBtn, opacity: pos <= 0 ? .4 : 1 }}>‹ Previous</button>
        <button type="button" data-ro-ok disabled={pos < 0 || pos >= order.length - 1} onClick={() => go(order[pos + 1])} style={{ ...hdrBtn, opacity: pos < 0 || pos >= order.length - 1 ? .4 : 1 }}>Next ›</button>
      </div>

      {/* Top buttons, like FileMaker's */}
      <div style={{ marginTop: 12 }}>
        <FmSeg big value="customer" onChange={k => {
          if (k === "quote") act.setShowQuote(true);
          else if (k === "spec") { if (hasInv || (e.stages && e.stages.length)) setView({ screen: "surveyPdf", id: e.id }); else act.setShowInv(true); }
          else if (k === "all") setView({ screen: "enquiries", filter: "All" });
          else if (k === "home") setView({ screen: "dashboard" });
        }} items={[["customer", "Customer"], ["quote", "Quotation"], ["spec", "Spec sheet"], ["all", "Show all"], ["home", "Home"]]} />
      </div>
      <AltOptions data={data} e={e} setView={setView} />
      <div style={{ marginTop: 10 }}><BookedNoMove data={data} e={e} linkedJob={linkedJob} onCreate={act.markWon} /></div>

      {/* Customer (left) + addresses (right) */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.25fr)", gap: 14, marginTop: 12 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <FmField label="Ref">{c.ref}</FmField>
          <FmBox>{nm}</FmBox>
          <FmField label="Mobile" onClick={c.phone ? () => { logComm(c.id, { type: "Call" }); window.location.href = `tel:${c.phone}`; } : undefined}>{c.phone ? <span style={{ color: TEAL }}>📞 {c.phone}</span> : ""}</FmField>
          <FmField label="Home phone" onClick={c.homePhone ? () => { window.location.href = `tel:${c.homePhone}`; } : undefined}>{c.homePhone ? <span style={{ color: TEAL }}>📞 {c.homePhone}</span> : ""}</FmField>
          <FmField label="Email" onClick={c.email ? () => { logComm(c.id, { type: "Email" }); window.location.href = `mailto:${c.email}`; } : undefined}>{c.email ? <span style={{ color: TEAL }}>{c.email}</span> : ""}</FmField>
          {customer && <MessageButton size="md" variant="primary" style={{ width: "100%" }} customer={customer} ctx={{ date: e.preferredDate ? fmtDate(e.preferredDate) : (e.moveMonth ? fmtMonth(e.moveMonth) : ""), survey_date: e.surveyDate ? fmtDate(e.surveyDate) : "", survey_time: e.surveyTime || "", price: e.quoteTotal ? gbp(e.quoteTotal) : "", deposit: e.quoteTotal ? gbp(Math.round(e.quoteTotal * 0.6)) : "" }} />}
        </div>
        <div style={{ background: "#fff", border: `1px solid ${FM_LINE}`, borderRadius: 14, padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
          <FmSeg value={side} onChange={setSide} items={[["from", "From"], ["to", "To"], ["store", "Store"]]} />
          {side === "store" ? (
            <FmBox ph={!storeSummary(e)}>{storeSummary(e) || "Not going into store"}</FmBox>
          ) : (
            <>
              <FmBox ph={!sideLines[0]}>{sideLines[0] || "Address 1"}</FmBox>
              <FmBox ph={!sideLines[1]}>{sideLines[1] || "Address 2"}</FmBox>
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.3fr) minmax(0, 1fr)", gap: 8 }}>
                <FmBox ph={!sideLines[2]}>{sideLines[2] || "Town"}</FmBox>
                <FmBox ph={!sideLines[3]}>{sideLines[3] || "Postcode"}</FmBox>
              </div>
              {extra.map((s, i) => { const a = [s.address1, s.town, s.postcode].filter(Boolean).join(", "); return a ? <div key={i} style={{ fontSize: 13, color: "#374151" }}>+ {side === "from" ? "Pickup" : "Delivery"} {i + 2}: {a}{s.note ? ` (${s.note})` : ""}</div> : null; })}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Btn size="sm" style={sb} disabled={!addr(fromLines) || !addr(toLines)} onClick={distance}>Check distance</Btn>
                <Btn size="sm" variant="grey" style={sb} onClick={() => setTab("access")}>Access</Btn>
                <Btn size="sm" variant="grey" style={sb} disabled={!addr(sideLines)} onClick={() => maps(addr(sideLines))}>Map</Btn>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Lower tabs */}
      <div style={{ marginTop: 14 }}>
        <FmSeg value={tab} onChange={setTab} items={[["survey", "Survey info"], ["notes", "Notes"], ["move", "Move info"], ["access", "Access"]]} />
      </div>
      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        {tab === "survey" && <>
          <div style={grid2}>
            <FmField label="Surveyor">{e.surveyor}</FmField>
            <FmField label="Referred by">{e.referredBy}</FmField>
            <FmField label="Status">{enqBadge(data, e)}</FmField>
            <FmField label="Move date">{e.preferredDate ? fmtDate(e.preferredDate) + (e.dateFlexible ? " (flexible)" : "") : (e.moveMonth ? fmtMonth(e.moveMonth) + " (month)" : "TBC")}</FmField>
            <FmField label="Survey date">{e.surveyDate ? <span style={{ color: surveyOverdue(e) ? "#B91C1C" : undefined }}>{fmtDate(e.surveyDate)}{surveyOverdue(e) ? " — not surveyed" : ""}</span> : ""}</FmField>
            <FmField label="Survey time">{e.surveyTime}</FmField>
            <FmField label="Quote">{e.quoteTotal ? `${gbp(e.quoteTotal)} · ${e.quoteStatus || ""}` : ""}</FmField>
            <FmField label="Quote sent">{e.quoteSentDate ? fmtDate(e.quoteSentDate) : ""}</FmField>
            <FmField label="Volume">{e.volumeCuFt ? `${e.volumeCuFt} cu ft · ${e.volumeM3} m³` : "Not surveyed yet"}</FmField>
            <FmField label="Call back" onClick={!ro ? act.setFollowUp : undefined}>{e.followUpDate ? `${fmtDate(e.followUpDate)}${e.followUpTime ? " " + e.followUpTime : ""}` : ""}</FmField>
          </div>
          {e.followUpNote ? <div style={{ fontSize: 13.5, color: "#92400E", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 10, padding: "8px 12px" }}><b>Call back note:</b> {e.followUpNote}</div> : null}
          {q ? <div style={{ padding: "10px 12px", borderRadius: 10, background: "#FFFBEB", border: "1px solid #FDE68A", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: "#92400E" }}>{quoteChaseText(q)}<div style={{ fontWeight: 600, color: "#B45309", marginTop: 2 }}>Reminder: {e.noChase && !e.quoteChaseDate ? "none set" : fmtDate(quoteChaseDue(e))} <button onClick={() => act.setShowChaseDate(true)} style={{ background: "none", border: "none", color: TEAL, fontWeight: 800, cursor: "pointer", padding: 0, fontSize: 12.5 }}>Change</button></div></div>
            {q.phone ? <ChaseCallBtn data={data} e={e} /> : null}
          </div> : null}
          <div style={{ border: `1px solid ${FM_LINE}`, borderRadius: 12, background: "#fff", overflow: "hidden" }}>
            <div style={{ padding: "9px 12px", background: "#F3F7F6", borderBottom: `1px solid ${FM_LINE}`, fontSize: 13, fontWeight: 700, color: "#55665F" }}>Notes</div>
            <div style={{ minHeight: 70, padding: "10px 12px", fontSize: 14, color: e.notes ? "#10211E" : "#94A4A0", whiteSpace: "pre-wrap" }}>{e.notes || "No notes"}</div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {(!ro || hasInv) && <Btn size="sm" style={sb} onClick={() => act.setShowInv(true)}><Icon name="box" size={14} /> {ro ? "View survey" : e.volumeCuFt ? "Edit survey" : "Start survey"}</Btn>}
            {!ro && e.surveyDate && <Btn size="sm" variant={surveyed ? "grey" : "primary"} style={sb} onClick={async () => { const done = !surveyed; await saveAndReload(upsertLocal(data, "enquiries", { ...e, surveyDone: done, status: done ? (e.status === "New" ? "Surveyed" : e.status) : (e.status === "Surveyed" ? "New" : e.status) })); }}>{surveyed ? "✓ Surveyed" : "Mark surveyed"}</Btn>}
            {!ro && surveyOverdue(e) && <Btn size="sm" variant="danger" style={sb} onClick={() => act.setShowResched(true)}>📅 Reschedule</Btn>}
            <NewEnqCallBtn data={data} e={e} small />
            {(!ro || e.quoteTotal) && <Btn size="sm" variant="amber" style={sb} onClick={() => act.setShowQuote(true)}><Icon name="quote" size={14} /> {ro ? "View quote" : e.quoteTotal ? "Edit quote" : "Build quote"}</Btn>}
            {e.quoteTotal ? <Btn size="sm" variant="grey" style={sb} onClick={() => setView({ screen: "quotePdf", id: e.id })}>Quote PDF</Btn> : null}
          </div>
          <div style={{ display: "flex", gap: 16, fontSize: 12.5, color: "#55665F", padding: "2px 2px 0" }}>
            {e.createdAt ? <span>Created <b style={{ color: "#10211E" }}>{fmStamp(e.createdAt)}</b></span> : null}
            {e.updatedAt ? <span>Modified <b style={{ color: "#10211E" }}>{fmStamp(e.updatedAt)}</b></span> : null}
          </div>
        </>}

        {tab === "notes" && <>
          <div style={{ border: `1px solid ${FM_LINE}`, borderRadius: 12, background: "#fff", overflow: "hidden" }}>
            <div style={{ padding: "9px 12px", background: "#F3F7F6", borderBottom: `1px solid ${FM_LINE}`, fontSize: 13, fontWeight: 700, color: "#55665F" }}>Enquiry notes</div>
            <div style={{ minHeight: 120, padding: "10px 12px", fontSize: 14.5, color: e.notes ? "#10211E" : "#94A4A0", whiteSpace: "pre-wrap" }}>{e.notes || "No notes"}</div>
          </div>
          {c.notes ? <div style={{ border: `1px solid ${FM_LINE}`, borderRadius: 12, background: "#fff", overflow: "hidden" }}>
            <div style={{ padding: "9px 12px", background: "#F3F7F6", borderBottom: `1px solid ${FM_LINE}`, fontSize: 13, fontWeight: 700, color: "#55665F" }}>Customer notes</div>
            <div style={{ padding: "10px 12px", fontSize: 14.5, color: "#10211E", whiteSpace: "pre-wrap" }}>{c.notes}</div>
          </div> : null}
          {customer && <OtherContacts customer={customer} onLog={en => logComm(customer.id, en)} />}
          {!ro && <Btn size="sm" style={{ ...sb, alignSelf: "flex-start" }} onClick={() => act.setShowEdit(true)}><Icon name="edit" size={14} /> Edit notes</Btn>}
        </>}

        {tab === "move" && <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 8 }}>
            {[["Volume", e.volumeCuFt ? `${e.volumeCuFt} cu ft` : "—"],
              ["Price", linkedJob ? gbp(linkedJob.price) : (e.quoteTotal ? gbp(e.quoteTotal) : "—")],
              ["Deposit", linkedJob && linkedJob.deposit ? `${gbp(linkedJob.deposit)}${linkedJob.depositPaid ? " ✓" : ""}` : "—"],
              ["Balance", linkedJob ? `${gbp((Number(linkedJob.price) || 0) - (Number(linkedJob.deposit) || 0))}${linkedJob.balancePaid ? " ✓" : ""}` : "—"]].map(([l, v]) => (
              <div key={l} style={{ background: "#fff", border: `1px solid ${FM_LINE}`, borderRadius: 12, padding: "10px 12px" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#55665F" }}>{l}</div>
                <div style={{ fontSize: 16.5, fontWeight: 800, color: "#10211E" }}>{v}</div>
              </div>))}
          </div>
          <div style={{ background: "#fff", border: `1px solid ${FM_LINE}`, borderRadius: 12, padding: "10px 12px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <H2>{linkedJob ? `Move ${moveRef(data, linkedJob)}` : "Move plan"}</H2>
              {linkedJob ? <StatusBadge status={jobBadge(linkedJob)} /> : null}
            </div>
            {(linkedJob ? jobStages(linkedJob) : (e.stages || [])).length === 0
              ? <div style={{ fontSize: 13.5, color: "#55665F", marginTop: 4 }}>No days planned yet</div>
              : (linkedJob ? jobStages(linkedJob) : e.stages).map((d, i) => {
                const vn = (d.vehicleIds || []).map(id => (((data.vehicles || []).find(v => v.id === id)) || {}).name).filter(Boolean).join(", ");
                return <div key={d.id || i} style={{ fontSize: 13.5, color: "#374151", padding: "6px 0", borderTop: i ? `1px solid ${FM_LINE}` : "none" }}>
                  <b style={{ color: "#10211E" }}>{d.type || "Day"}</b> · {d.date ? `${fmtDate(d.date)} (${dow(d.date)})` : "Date TBC"}{d.time ? ` ${d.time}` : ""}
                  {vn ? ` · ${vn}` : (vehTypesSummary(d.vehTypes) ? ` · ${vehTypesSummary(d.vehTypes)}` : "")}
                  {(d.crew && d.crew.length) ? ` · ${d.crew.join(", ")}` : (d.staffCount ? ` · ${d.staffCount} staff` : "")}
                </div>; })}
            {linkedJob && (() => { const so = Object.values(linkedJob.signOffs || {}); if (!so.length) return null; const last = so.sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
              return <div onClick={() => act.setShowSignOff(true)} style={{ fontSize: 13, color: "#059669", fontWeight: 700, marginTop: 6, cursor: "pointer" }}>✅ Signed off · {last.staffName} &amp; {last.custName}{so.some(x => x.notes) ? <span style={{ color: "#B45309" }}> · 📝 note</span> : null}</div>; })()}
          </div>
          {(hw || covers.length) ? <div style={{ background: "#fff", border: `1px solid ${FM_LINE}`, borderRadius: 12, padding: "10px 12px" }}>
            <H2>Equipment required</H2>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
              {hw ? <span style={{ padding: "5px 10px", borderRadius: 99, background: "#F1F5F4", fontSize: 13, fontWeight: 600 }}>{hw} × H/W boxes</span> : null}
              {covers.map(cv => <span key={cv.name} style={{ padding: "5px 10px", borderRadius: 99, background: "#F1F5F4", fontSize: 13, fontWeight: 600 }}>{cv.qty} × {cv.name}</span>)}
            </div>
          </div> : null}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {(!ro || (e.stages && e.stages.length)) && <Btn size="sm" variant="grey" style={sb} onClick={() => act.setShowPlan(true)}><Icon name="calendar" size={14} /> {ro ? "View plan" : (e.stages && e.stages.length) ? "Edit plan" : "Add plan"}</Btn>}
            {(hasInv || (e.stages && e.stages.length)) ? <Btn size="sm" variant="grey" style={sb} onClick={() => setView({ screen: "surveyPdf", id: e.id })}>Survey PDF</Btn> : null}
            {e.quoteTotal ? <Btn size="sm" variant="grey" style={sb} onClick={() => setView({ screen: "quotePdf", id: e.id })}>Quote PDF</Btn> : null}
            {linkedJob && <Btn size="sm" variant="grey" style={sb} onClick={() => act.setShowCrew(true)}>👷 Crew view</Btn>}
            {linkedJob && <Btn size="sm" style={sb} onClick={() => act.setShowMove(true)}><Icon name="check" size={14} /> {ro ? "View move" : "Manage move"}</Btn>}
            {!ro && !linkedJob && quoteDone && !["Won", "Lost", "Not quoted"].includes(e.status) && <Btn size="sm" style={sb} onClick={() => act.markWon()}><Icon name="check" size={14} /> Create provisional move</Btn>}
          </div>
        </>}

        {tab === "access" && <>
          <div style={grid2}>
            <FmField label="From property">{[e.fromPropertyType, e.fromBedrooms && `${e.fromBedrooms} bed`, e.fromFloor].filter(Boolean).join(" · ")}</FmField>
            <FmField label="To property">{[e.toPropertyType, e.toFloor].filter(Boolean).join(" · ")}</FmField>
          </div>
          {[["From access", e.fromAccess], ["To access", e.toAccess]].map(([l, v]) => (
            <div key={l} style={{ border: `1px solid ${FM_LINE}`, borderRadius: 12, background: "#fff", overflow: "hidden" }}>
              <div style={{ padding: "9px 12px", background: "#F3F7F6", borderBottom: `1px solid ${FM_LINE}`, fontSize: 13, fontWeight: 700, color: "#55665F" }}>{l}</div>
              <div style={{ minHeight: 50, padding: "10px 12px", fontSize: 14.5, color: v ? "#10211E" : "#94A4A0", whiteSpace: "pre-wrap" }}>{v || "Nothing noted"}</div>
            </div>))}
          {!ro && <Btn size="sm" style={{ ...sb, alignSelf: "flex-start" }} onClick={() => act.setShowEdit(true)}><Icon name="edit" size={14} /> Edit access</Btn>}
        </>}
      </div>

      {/* Bottom bar: the usual actions */}
      <div style={{ marginTop: 16, paddingTop: 12, borderTop: `1px solid ${FM_LINE}`, display: "flex", gap: 8, flexWrap: "wrap" }}>
        {ro ? <Btn variant="grey" style={sb} onClick={() => act.setShowEdit(true)}>👁 View enquiry details</Btn> : <>
          <Btn style={sb} onClick={() => act.setShowEdit(true)}><Icon name="edit" size={15} /> Edit</Btn>
          {!linkedJob && <Btn variant="grey" style={sb} onClick={act.setFollowUp}>⏰ Call back</Btn>}
          {!["Won", "Lost", "Not quoted"].includes(e.status) && <Btn variant="grey" style={{ ...sb, color: "#B91C1C" }} onClick={act.markLost}>✕ Mark Lost</Btn>}
          {!["Won", "Lost", "Not quoted"].includes(e.status) && !linkedJob && <Btn variant="grey" style={{ ...sb, color: "#4B5563" }} onClick={() => markNotQuotedFlow(data, e)}>🚫 Didn't quote</Btn>}
          {canDelete() && <Btn variant="danger" style={{ ...sb, marginLeft: "auto" }} onClick={act.del}><Icon name="trash" size={15} /> Delete</Btn>}
        </>}
      </div>
    </div>
  );
}
function EnquiryDetail({ data, id, setView, fm = false }) {
  const e = (data.enquiries || []).find(x => x.id === id);
  const [showEdit, setShowEdit] = useState(false);
  const [showInv, setShowInv] = useState(false);
  const [showQuote, setShowQuote] = useState(false);
  const [showPlan, setShowPlan] = useState(false);
  const [showMove, setShowMove] = useState(false);
  const [showCrew, setShowCrew] = useState(false);
  const [showSignOff, setShowSignOff] = useState(false);
  const [rebook, setRebook] = useState(false);
  const [showResched, setShowResched] = useState(false);
  const [showChaseDate, setShowChaseDate] = useState(false);
  useEffect(() => {
    try { if (sessionStorage.getItem("removals_open_plan") === id) { sessionStorage.removeItem("removals_open_plan"); setShowPlan(true); } } catch {}
    try { if (sessionStorage.getItem("removals_open_edit") === id) { sessionStorage.removeItem("removals_open_edit"); setShowEdit(true); } } catch {}
    try { if (sessionStorage.getItem("removals_rebook") === id) { sessionStorage.removeItem("removals_rebook"); setRebook(true); } } catch {}
    try { if (sessionStorage.getItem("removals_open_quote") === id) { sessionStorage.removeItem("removals_open_quote"); setShowQuote(true); } } catch {}
  }, [id]);
  const vname = id => (((data.vehicles || []).find(v => v.id === id)) || {}).name || "Vehicle";
  const customer = (data.customers || []).find(c => c.id === e?.customerId);
  const [followUpOpen, setFollowUpOpen] = useState(false);
  if (!e) return <div style={{ padding: 20 }}>Enquiry not found.</div>;
  const linkedJob = (data.jobs || []).find(j => j.enquiryId === e.id);

  async function setStatus(status, extra = {}) {
    await saveAndReload(upsertLocal(data, "enquiries", { ...e, status, ...extra }));
  }
  async function markWon(newStatus = "Provisional") {
    if (typeof newStatus !== "string") newStatus = "Provisional";
    const existing = (data.jobs || []).find(j => j.enquiryId === e.id);
    if (existing) {
      // Re-booking an enquiry that already has a move: don't create a second job.
      let d0 = upsertLocal(data, "jobs", { ...existing, status: existing.status === "Completed" ? "Provisional" : existing.status });
      d0 = upsertLocal(d0, "enquiries", { ...e, status: "Won", quoteStatus: "Accepted" });
      showSavingOverlay(); SAVING_IN_PROGRESS = true;
      const s0 = stampData(d0);
      setDB(JSON.stringify(s0));
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
      status: newStatus, notes: "", createdAt: new Date().toISOString(),
    };
    let d2 = upsertLocal(data, "jobs", job);
    d2 = upsertLocal(d2, "enquiries", { ...e, status: "Won", quoteStatus: "Accepted" });
    // The customer picked this option, so the other alternative quotes close themselves.
    altGroup(data, e).filter(x => x.id !== e.id && !(data.jobs || []).some(j => j.enquiryId === x.id)).forEach(x => {
      d2 = upsertLocal(d2, "enquiries", { ...x, status: "Not quoted", altClosed: true });
    });
    showSavingOverlay(); SAVING_IN_PROGRESS = true;
    const stamped = stampData(d2);
    setDB(JSON.stringify(stamped));
    try { await pushChangedOnly(stamped); } catch {}
    SAVING_IN_PROGRESS = false;
    try { sessionStorage.setItem("removals_open_plan", e.id); } catch {}
    setView({ screen: "enquiryDetail", id: e.id });
    window.location.reload();
  }
  async function markLost() { await markLostFlow(data, e, setView); }
  const setFollowUp = () => setFollowUpOpen(true);
  async function del() {
    if (!confirm("Delete this enquiry? This cannot be undone.")) return;
    addTombstone(e.id);
    showSavingOverlay(); SAVING_IN_PROGRESS = true;
    try { await deleteRecord("enquiries", e.id); } catch {}
    const d2 = { ...data, enquiries: (data.enquiries || []).filter(x => x.id !== e.id) };
    setDB(JSON.stringify(d2));
    SAVING_IN_PROGRESS = false;
    setView({ screen: "enquiries" });
    window.location.reload();
  }

  const rec = recommendVehicle(e.volumeCuFt);
  // Step-by-step: survey → move plan → quote → provisional move
  const surveyDone = !!(e.surveyDone || (e.inventory && e.inventory.length) || ["Surveyed", "Quoted", "Won"].includes(e.status));
  const planDone = !!((e.stages && e.stages.length) || linkedJob);
  const quoteDone = Number(e.quoteTotal) > 0;
  const showPlanCard = surveyDone || planDone;
  const showQuoteCard = planDone || quoteDone;
  const nextHint = !surveyDone ? "Next: complete the survey — the move plan appears once it's done."
    : !planDone ? "Next: add the move plan — the quote appears once it's done."
    : !quoteDone && !["Won", "Lost", "Not quoted"].includes(e.status) ? "Next: build the quote — you can then create the provisional move."
    : "";

  const modals = (
    <>
      {showEdit && <EnquiryForm data={data} editEnquiry={e} reopen={rebook} onClose={() => { setShowEdit(false); setRebook(false); }} />}
      {followUpOpen && <FollowUpModal data={data} enquiry={e} onClose={() => setFollowUpOpen(false)} />}
      {showInv && <InventoryModal data={data} enquiry={e} onClose={() => setShowInv(false)} />}
      {showResched && <RescheduleSurveyModal data={data} enquiry={e} onClose={() => setShowResched(false)} />}
      {showChaseDate && <ChaseDateModal data={data} enquiry={e} onClose={() => setShowChaseDate(false)} />}
      {showQuote && <QuoteModal data={data} enquiry={e} onClose={() => setShowQuote(false)} />}
      {showPlan && <MovePlanModal data={data} enquiry={e} onClose={() => setShowPlan(false)} />}
      {showMove && linkedJob && <MoveManageModal data={data} job={linkedJob} onClose={() => setShowMove(false)} />}
      {showCrew && linkedJob && <CrewPreviewModal data={data} job={linkedJob} onClose={() => setShowCrew(false)} />}
      {showSignOff && linkedJob && <SignOffRecordModal data={data} job={linkedJob} onClose={() => setShowSignOff(false)} />}
    </>
  );
  if (fm) return (
    <>
      <EnquiryFileMaker data={data} e={e} customer={customer} linkedJob={linkedJob} setView={setView} quoteDone={quoteDone}
        act={{ setShowEdit, setShowInv, setShowQuote, setShowPlan, setShowMove, setShowCrew, setShowSignOff, setShowResched, setShowChaseDate, setFollowUp, markWon, markLost, del }} />
      {modals}
    </>
  );

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "0 0 10px" }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: "#111827" }}>{custName(data, e.customerId)}</h2>
        <StatusBadge status={enqBadge(data, e)} />
      </div>
      <AltOptions data={data} e={e} setView={setView} />
      {e.status === "Not quoted" && !e.altClosed && (
        <div style={{ background: "#F3F4F6", border: "1px solid #E5E7EB", borderRadius: 12, padding: "10px 12px", marginBottom: 12, fontSize: 13.5, color: "#374151" }}>
          <b>🚫 We didn't quote</b>{e.lostReason ? `: ${e.lostReason}` : " — no reason given"}
          {!isReadOnly() && <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <Btn size="sm" variant="grey" onClick={() => markNotQuotedFlow(data, e)}>{e.lostReason ? "Change reason" : "Add reason"}</Btn>
            <Btn size="sm" variant="grey" onClick={() => saveAndReload(upsertLocal(data, "enquiries", { ...e, status: Number(e.quoteTotal) > 0 ? "Quoted" : (e.surveyDone || e.volumeCuFt ? "Surveyed" : "New"), lostReason: "", updatedAt: Date.now() }))}>↺ Undo — back to {Number(e.quoteTotal) > 0 ? "Quoted" : (e.surveyDone || e.volumeCuFt ? "Surveyed" : "New")}</Btn>
          </div>}
        </div>
      )}
      {customer && (
        <div style={{ ...contactRowStyle(1 + !!customer.phone + !!customer.email), marginBottom: 14 }}>
          {customer.phone && <Btn variant="primary" style={contactBtn} onClick={() => window.location.href = `tel:${customer.phone}`}>📞 Call</Btn>}
          <MessageButton size="md" variant="primary" style={contactBtn} customer={customer} ctx={{ date: e.preferredDate ? fmtDate(e.preferredDate) : (e.moveMonth ? fmtMonth(e.moveMonth) : ""), survey_date: e.surveyDate ? fmtDate(e.surveyDate) : "", survey_time: e.surveyTime || "", price: e.quoteTotal ? gbp(e.quoteTotal) : "", deposit: e.quoteTotal ? gbp(Math.round(e.quoteTotal * 0.6)) : "" }} />
          {customer.email && <Btn variant="primary" style={contactBtn} onClick={() => window.location.href = `mailto:${customer.email}`}>✉️ Email</Btn>}
        </div>
      )}
      {customer && <OtherContacts customer={customer} onLog={en => logComm(customer.id, en)} />}

      <Card>
        <Row label="Move date" value={e.preferredDate ? fmtDate(e.preferredDate) + (e.dateFlexible ? " (flexible)" : "") : (e.moveMonth ? fmtMonth(e.moveMonth) + " (month)" : "TBC")} />
        <Row label="From" value={[e.fromAddress1, e.fromAddress2, e.fromTown, e.fromPostcode].filter(Boolean).join(", ")} />
        {(e.extraFrom || []).map((s, i) => { const a = [s.address1, s.town, s.postcode].filter(Boolean).join(", "); return a ? <Row key={"ef" + i} label={`+ Pickup ${i + 2}`} value={a + (s.note ? ` (${s.note})` : "")} /> : null; })}
        <Row label="From property" value={[e.fromPropertyType, e.fromBedrooms && `${e.fromBedrooms} bed`, e.fromFloor].filter(Boolean).join(" · ")} />
        {e.fromAccess && <Row label="From access" value={e.fromAccess} />}
        {storeSummary(e) && <Row label="Storage" value={storeSummary(e)} />}
        <Row label="To" value={[e.toAddress1, e.toAddress2, e.toTown, e.toPostcode].filter(Boolean).join(", ")} />
        {(e.extraTo || []).map((s, i) => { const a = [s.address1, s.town, s.postcode].filter(Boolean).join(", "); return a ? <Row key={"et" + i} label={`+ Delivery ${i + 2}`} value={a + (s.note ? ` (${s.note})` : "")} /> : null; })}
        <Row label="To property" value={[e.toPropertyType, e.toFloor].filter(Boolean).join(" · ")} />
        {e.toAccess && <Row label="To access" value={e.toAccess} />}
        {e.referredBy && <Row label="Referred by" value={e.referredBy} />}
        {e.notes && <Row label="Notes" value={e.notes} />}
      </Card>

      {/* Survey */}
      <Card style={{ background: e.volumeCuFt ? "#F0FDFA" : "#fff" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 700, color: "#111827" }}>Survey / Inventory</div>
            {newEnqCall(data, e) && <div style={{ fontSize: 13, color: "#2563EB", fontWeight: 700, marginTop: 2 }}>📞 New enquiry — call to book the survey{e.newCalledAt ? ` · last called ${fmtDateShort(e.newCalledAt.slice(0, 10))}` : ""}</div>}
            {e.surveyDate && <div style={{ fontSize: 13, color: surveyOverdue(e) ? "#B91C1C" : TEAL_D, fontWeight: 600, marginTop: 2 }}>📅 {fmtDate(e.surveyDate)}{e.surveyTime ? ` · ${e.surveyTime}` : ""}{surveyOverdue(e) ? " — date passed, not surveyed" : ""}</div>}
            <div style={{ fontSize: 13, color: "#6B7280", marginTop: 2 }}>
              {e.volumeCuFt ? `${e.volumeCuFt} cu ft · ${e.volumeM3} m³${Number(e.weightKg) ? ` · ${e.weightKg} kg` : ""}${hwBoxes(e.inventory) ? ` · ${hwBoxes(e.inventory)} H/W boxes` : ""}` : "Not surveyed yet"}
            </div>
            {coversRequired(e.inventory).length > 0 && <div style={{ fontSize: 12.5, color: "#374151", marginTop: 2 }}>🛋 {coversText(coversRequired(e.inventory))}</div>}
            {e.volumeCuFt > 0 && <div style={{ fontSize: 13, color: TEAL, fontWeight: 600, marginTop: 2 }}>{rec.vehicle}{rec.loads > 1 ? ` × ${rec.loads}` : ""}</div>}
            {((e.inventory && e.inventory.length) || (e.stages && e.stages.length)) ? <Btn size="sm" variant="grey" style={{ marginTop: 10 }} onClick={() => setView({ screen: "surveyPdf", id: e.id })}><Icon name="quote" size={14} /> Survey &amp; move plan PDF</Btn> : null}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, flexShrink: 0 }}>
            {!isReadOnly() && surveyOverdue(e) && <Btn size="sm" variant="danger" onClick={() => setShowResched(true)}>📅 Reschedule</Btn>}
            <NewEnqCallBtn data={data} e={e} small />
            {(!isReadOnly() || (e.inventory && e.inventory.length)) && <Btn size="sm" onClick={() => setShowInv(true)}><Icon name="box" size={14} /> {isReadOnly() ? "View" : e.volumeCuFt ? "Edit" : "Start"}</Btn>}
            {!isReadOnly() && e.surveyDate && (() => { const surveyed = e.surveyDone || ["Surveyed", "Quoted", "Won"].includes(e.status); return <Btn size="sm" variant={surveyed ? "grey" : "primary"} onClick={async () => { const done = !surveyed; await saveAndReload(upsertLocal(data, "enquiries", { ...e, surveyDone: done, status: done ? (e.status === "New" ? "Surveyed" : e.status) : (e.status === "Surveyed" ? "New" : e.status) })); }}>{surveyed ? "✓ Surveyed" : "Mark surveyed"}</Btn>; })()}
          </div>
        </div>
      </Card>

      {/* Move plan — shown once the survey is complete */}
      {showPlanCard && <Card>
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
          {(!isReadOnly() || (e.stages && e.stages.length)) && <Btn size="sm" onClick={() => setShowPlan(true)}><Icon name="calendar" size={14} /> {isReadOnly() ? "View" : (e.stages && e.stages.length) ? "Edit" : "Add"}</Btn>}
        </div>
      </Card>}

      {/* Quote — shown once the move plan is complete */}
      {showQuoteCard && <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 700, color: "#111827" }}>Quote</div>
            <div style={{ fontSize: 13, color: "#6B7280", marginTop: 2 }}>
              {e.quoteTotal ? `${gbp(e.quoteTotal)} · ${e.quoteStatus}` : "No quote yet"}
              {e.quoteSentDate ? ` · sent ${fmtDateShort(e.quoteSentDate)}` : ""}
            </div>
          </div>
          {(!isReadOnly() || e.quoteTotal) && <Btn size="sm" variant="amber" onClick={() => setShowQuote(true)}><Icon name="quote" size={14} /> {isReadOnly() ? "View" : e.quoteTotal ? "Edit" : "Build"}</Btn>}
        </div>
        {e.quoteTotal ? <Btn size="sm" variant="grey" style={{ marginTop: 10 }} onClick={() => setView({ screen: "quotePdf", id: e.id })}><Icon name="quote" size={14} /> Save PDF quote</Btn> : null}
        {(() => { const q = quoteChase(data, e); return q ? (
          <div style={{ marginTop: 10, padding: "10px 12px", borderRadius: 10, background: "#FFFBEB", border: "1px solid #FDE68A", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: "#92400E" }}>{quoteChaseText(q)}
              <div style={{ fontWeight: 600, color: "#B45309", marginTop: 2 }}>Reminder: {e.noChase && !e.quoteChaseDate ? "none set" : fmtDate(quoteChaseDue(e))} <button onClick={() => setShowChaseDate(true)} style={{ background: "none", border: "none", color: TEAL, fontWeight: 800, cursor: "pointer", padding: 0, fontSize: 12.5 }}>Change</button></div>
            </div>
            {q.phone ? <ChaseCallBtn data={data} e={e} /> : <span style={{ fontSize: 12, color: "#B7C3C0" }}>No number</span>}
          </div>) : null; })()}
      </Card>}

      {/* Booked but no move behind it: set the move up here (where Manage move normally sits) */}
      <BookedNoMove data={data} e={e} linkedJob={linkedJob} onCreate={markWon} />
      {/* Manage move — below the quote once a provisional move exists */}
      {linkedJob && (
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <div style={{ fontWeight: 700, color: "#111827" }}>Move {moveRef(data, linkedJob)}</div>
                <StatusBadge status={jobBadge(linkedJob)} />
              </div>
              <div style={{ fontSize: 13, color: "#6B7280", marginTop: 3 }}>
                {gbp(linkedJob.price)}{linkedJob.deposit ? ` · dep ${gbp(linkedJob.deposit)}${linkedJob.depositPaid ? " ✓" : ""}` : ""} · bal {gbp((Number(linkedJob.price) || 0) - (Number(linkedJob.deposit) || 0))}{linkedJob.balancePaid ? " ✓" : ""}
              </div>
              {(() => { const so = Object.values(linkedJob.signOffs || {}); if (!so.length) return null; const last = so.sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
                return <div onClick={() => setShowSignOff(true)} style={{ fontSize: 12.5, color: "#059669", fontWeight: 700, marginTop: 4, cursor: "pointer" }}>✅ Signed off{so.length > 1 ? ` (${so.length} days)` : ""} · {last.staffName} &amp; {last.custName}{so.some(x => x.notes) ? <span style={{ color: "#B45309" }}> · 📝 note</span> : null}</div>; })()}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "stretch" }}>
              <Btn size="sm" onClick={() => setShowMove(true)}><Icon name="check" size={14} /> {isReadOnly() ? "View" : "Manage"}</Btn>
              <Btn size="sm" variant="grey" onClick={() => setShowCrew(true)}>👷 Crew view</Btn>
            </div>
          </div>
        </Card>
      )}
      {nextHint && <div style={{ fontSize: 13, color: "#6A7B77", fontWeight: 600, background: "#F4F7F6", border: "1px dashed #CBD5D2", borderRadius: 12, padding: "10px 14px", marginBottom: 11 }}>{nextHint}</div>}

      {e.followUpDate && (
        <Card style={{ background: "#FFFBEB" }}>
          <div style={{ fontSize: 13, color: "#92400E" }}><b>Follow-up {fmtDate(e.followUpDate)}:</b> {e.followUpNote || "—"}</div>
        </Card>
      )}

      {/* Actions */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14 }}>
        {!isReadOnly() && quoteDone && !["Won", "Lost", "Not quoted"].includes(e.status) && <Btn onClick={() => markWon()} style={{ flex: 1 }}><Icon name="check" size={16} /> Create provisional move</Btn>}
      </div>
      {(() => {
        const showFu = !linkedJob, showLost = !["Won", "Lost", "Not quoted"].includes(e.status);
        const showNq = showLost && !linkedJob;
        const n = (showFu ? 1 : 0) + (showLost ? 1 : 0) + (showNq ? 1 : 0);
        const eq = { width: "100%", minWidth: 0, whiteSpace: "nowrap" };
        if (isReadOnly()) return <Btn variant="grey" style={{ ...eq, marginTop: 8 }} onClick={() => setShowEdit(true)}>👁 View enquiry details</Btn>;
        return <>
          {n > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: `repeat(${n}, 1fr)`, gap: 8, marginTop: 8 }}>
              {showFu && <Btn variant="primary" style={eq} onClick={setFollowUp}>⏰ Follow-up</Btn>}
              {showLost && <Btn variant="grey" style={{ ...eq, color: "#B91C1C" }} onClick={markLost}>✕ Mark Lost</Btn>}
              {showNq && <Btn variant="grey" style={{ ...eq, color: "#4B5563" }} onClick={() => markNotQuotedFlow(data, e)}>🚫 Didn't quote</Btn>}
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: canDelete() ? "1fr 1fr" : "1fr", gap: 8, marginTop: 8 }}>
            <Btn style={eq} onClick={() => setShowEdit(true)}><Icon name="edit" size={15} /> Edit</Btn>
            {canDelete() && <Btn variant="danger" style={eq} onClick={del}><Icon name="trash" size={15} /> Delete</Btn>}
          </div>
        </>;
      })()}

      {modals}
    </div>
  );
}

// ── Customer search: looks through every field of the customer AND their enquiries/moves
// (addresses, postcodes, emails, notes, contacts…). Every word typed must appear somewhere.
const SEARCH_SKIP_KEY = /^(id|.*Id|.*Ids|inventory|items|photos?|images?|signature.*|sig|pdf.*|history|log|createdAt|updatedAt|_.*)$/;
function searchBits(v, out, depth) {
  if (v == null || depth > 4) return;
  if (typeof v === "string") { if (v.length < 2000 && !v.startsWith("data:")) out.push(v); return; }
  if (typeof v === "number") { out.push(String(v)); return; }
  if (Array.isArray(v)) { v.forEach(x => searchBits(x, out, depth + 1)); return; }
  if (typeof v === "object") for (const k of Object.keys(v)) { if (!SEARCH_SKIP_KEY.test(k)) searchBits(v[k], out, depth + 1); }
}
function buildCustomerSearch(data) {
  const extra = {};
  const add = (cid, rec) => { if (!cid) return; const bits = []; searchBits(rec, bits, 0); (extra[cid] = extra[cid] || []).push(...bits); };
  (data.enquiries || []).forEach(e => add(e.customerId, e));
  (data.jobs || []).forEach(j => add(j.customerId, j));
  const map = {};
  (data.customers || []).forEach(c => {
    const bits = []; searchBits(c, bits, 0);
    if (c.ref) bits.push("#" + c.ref);
    const text = (bits.join(" ") + " " + (extra[c.id] || []).join(" ")).toLowerCase();
    map[c.id] = text + " " + text.replace(/\s+/g, ""); // squashed copy so "BS11AA" finds "BS1 1AA"
  });
  return map;
}
function customerMatches(index, c, q) {
  const words = (q || "").toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = index[c.id] || "";
  if (words.every(w => text.includes(w))) return true;
  // Phone numbers typed with spaces or +44 still match however they were saved
  const qd = q.replace(/\D/g, "").replace(/^44/, "0");
  return qd.length >= 5 && /^[\d\s()+-]+$/.test(q.trim()) && text.replace(/\D/g, "").includes(qd);
}

// ── Customers ───────────────────────────────────────────────────────────────
function CustomersList({ data, setView }) {
  const [q, setQ] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [showRefPanel, setShowRefPanel] = useState(false);
  const [startVal, setStartVal] = useState(String(getRefStart()));
  const [busy, setBusy] = useState(false);
  const searchIndex = useMemo(() => q.trim() ? buildCustomerSearch(data) : {}, [data, !!q.trim()]);
  const customers = [...(data.customers || [])]
    .filter(c => !q.trim() || customerMatches(searchIndex, c, q))
    // Newest first: highest reference number at the top. Brand-new customers still waiting for a
    // reference (it's given on the next sync) go above everyone, newest first.
    .sort((a, b) => {
      const ra = Number(a.ref) || 0, rb = Number(b.ref) || 0;
      if (!ra || !rb) return (!ra && !rb) ? (b.createdAt || "").localeCompare(a.createdAt || "") : (!ra ? -1 : 1);
      return rb - ra;
    });
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
      <div className="rm-page-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h2 className="rm-page-title" style={{ margin: 0, fontSize: 20, fontWeight: 800, color: "#111827" }}>Customers</h2>
      </div>

      {showRefPanel && false && <div />}

      <div style={{ marginBottom: 12 }}><Input value={q} onChange={setQ} placeholder="🔍 Search anything – name, address, postcode, phone, email…" /></div>
      {customers.length === 0 && <Empty icon="customers" text="No customers yet" />}
      {customers.map(c => {
        const cJobs = (data.jobs || []).filter(j => j.customerId === c.id);
        const jobs = cJobs.length;
        const latestEnq = (data.enquiries || []).filter(e => e.customerId === c.id).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))[0];
        // Once there's an active move, show the move's status (Provisional / Confirmed) — like the Home screen.
        const activeMove = cJobs.filter(j => !["Completed", "Let Go"].includes(j.status)).sort((x, y) => (jobMoveDate(x) || "").localeCompare(jobMoveDate(y) || ""))[0];
        // Active move → its status; otherwise the latest enquiry's badge (which shows "Completed" once its move is done)
        const lastDone = cJobs.filter(j => j.status === "Completed").sort((x, y) => (jobMoveDate(y) || "").localeCompare(jobMoveDate(x) || ""))[0];
        const badge = activeMove ? jobBadge(activeMove) : latestEnq ? enqBadge(data, latestEnq) : lastDone ? "Completed" : null;
        // Quote still to build / email (surveyed, no move yet)
        const qe = (data.enquiries || []).filter(e => e.customerId === c.id && !["Lost", "Let Go", "Not quoted", "Won"].includes(e.status) && !cJobs.some(j => j.enquiryId === e.id)
          && (e.surveyDone || (e.inventory && e.inventory.length) || ["Surveyed", "Quoted"].includes(e.status))
          && !(Number(e.quoteTotal) > 0 && ["Sent", "Accepted"].includes(e.quoteStatus)));
        const quoteFlag = qe.length ? (qe.some(e => Number(e.quoteTotal) > 0) ? { t: "⚠️ Quote not emailed", c: "#C2410C" } : { t: "Quote to build", c: "#0369A1" }) : null;
        return (
          <Card key={c.id} onClick={() => setView({ screen: "customerDetail", id: c.id })}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700, color: "#111827" }}>{c.ref ? <span style={{ color: TEAL_D, fontWeight: 800 }}>#{c.ref} </span> : ""}{c.name}{c.company ? ` · ${c.company}` : ""}</div>
                <div style={{ fontSize: 13, color: "#6B7280", marginTop: 2 }}>{[c.phone, c.town].filter(Boolean).join(" · ") || "—"}</div>
                {!activeMove && latestEnq && <ReasonLine e={latestEnq} />}
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0 }}>
                {badge && <StatusBadge status={badge} />}
                {latestEnq && <ChaseCallBtn data={data} e={latestEnq} small />}
                {latestEnq && <NewEnqCallBtn data={data} e={latestEnq} small />}
                {quoteFlag
                  ? <span style={{ fontSize: 11.5, fontWeight: 800, color: quoteFlag.c, whiteSpace: "nowrap" }}>{quoteFlag.t}</span>
                  : <span style={{ fontSize: 11.5, color: "#9CA3AF" }}>{jobs} move{jobs !== 1 ? "s" : ""}</span>}
              </div>
            </div>
          </Card>
        );
      })}
      {showForm && <CustomerForm data={data} onClose={() => setShowForm(false)} />}
    </div>
  );
}

// ── Extra contacts on a customer (husband, partner, solicitor…) ────────────
const CONTACT_RELATIONS = ["Husband", "Wife", "Partner", "Son", "Daughter", "Mum", "Dad", "Brother", "Sister", "Friend", "Colleague", "Solicitor", "Estate agent", "Other"];
const contactFilled = c => !!(c && ((c.name || "").trim() || (c.phone || "").trim() || (c.email || "").trim()));
function ContactsEditor({ contacts, onChange }) {
  const list = contacts || [];
  const upd = (i, k, v) => onChange(list.map((c, j) => j === i ? { ...c, [k]: v } : c));
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 6 }}>Other contacts</div>
      {list.map((c, i) => (
        <div key={c.id || i} style={{ border: "1px solid #E3E9E8", borderRadius: 12, padding: 10, marginBottom: 8, background: "#FAFCFB" }}>
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}><Input value={c.name} onChange={v => upd(i, "name", v)} placeholder="Name" /></div>
            <div style={{ width: 132 }}><Select value={c.relation || ""} onChange={v => upd(i, "relation", v)} options={CONTACT_RELATIONS} placeholder="Who are they?" /></div>
          </div>
          <div style={{ height: 8 }} />
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}><Input value={c.phone} onChange={v => upd(i, "phone", v)} placeholder="Phone" type="tel" /></div>
            <div style={{ flex: 1, minWidth: 0 }}><Input value={c.email} onChange={v => upd(i, "email", v)} placeholder="Email (optional)" type="email" /></div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8, gap: 8 }}>
            <label style={{ fontSize: 13, color: "#374151", display: "flex", gap: 7, alignItems: "center", cursor: "pointer" }}>
              <input type="checkbox" checked={!!c.preferred} onChange={e => upd(i, "preferred", e.target.checked)} style={{ width: 18, height: 18 }} /> Call this person first
            </label>
            <button type="button" onClick={() => onChange(list.filter((_, j) => j !== i))} style={{ background: "none", border: "none", color: "#B91C1C", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>Remove</button>
          </div>
        </div>
      ))}
      <Btn size="sm" variant="grey" onClick={() => onChange([...list, { id: uid(), name: "", relation: "", phone: "", email: "", preferred: false }])}>+ Add contact</Btn>
    </div>
  );
}
function OtherContacts({ customer, onLog }) {
  const list = ((customer && customer.contacts) || []).filter(contactFilled);
  if (!list.length) return null;
  const tel = p => String(p || "").replace(/[^\d+]/g, "");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
      {list.map(c => (
        <div key={c.id || c.phone} style={{ background: c.preferred ? "#FFF9EE" : "#fff", border: `1px solid ${c.preferred ? "#FBD9A0" : "#E3E9E8"}`, borderRadius: 12, padding: "9px 12px", display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 14, color: "#1F2D2A" }}>{c.name || "Other contact"}{c.relation ? <span style={{ fontWeight: 600, color: "#6A7B77" }}> · {c.relation}</span> : null}</div>
            <div style={{ fontSize: 12.5, color: "#6A7B77", overflow: "hidden", textOverflow: "ellipsis" }}>{[c.phone, c.email].filter(Boolean).join(" · ")}{c.preferred ? <b style={{ color: AMBER }}> · Call first</b> : null}</div>
          </div>
          {c.phone && <Btn size="sm" variant="grey" onClick={() => { if (onLog) onLog({ type: "Call", note: `Called ${c.name || "other contact"}${c.relation ? ` (${c.relation.toLowerCase()})` : ""}` }); window.location.href = `tel:${tel(c.phone)}`; }}>📞 Call</Btn>}
          {c.phone && <Btn size="sm" variant="grey" onClick={() => { window.location.href = `sms:${tel(c.phone)}`; }}>💬 Text</Btn>}
          {!c.phone && c.email && <Btn size="sm" variant="grey" onClick={() => { window.location.href = `mailto:${c.email}`; }}>✉️ Email</Btn>}
        </div>
      ))}
    </div>
  );
}

function CustomerForm({ data, onClose, editCustomer }) {
  const c = editCustomer || {};
  const ta0 = tidyAddress(c.address1, c.address2, c.town, c.postcode); // splits an address typed all on one line
  const [f, setF] = useState({
    name: c.name || "", company: c.company || "", phone: c.phone || "", homePhone: c.homePhone || "", email: c.email || "",
    address1: ta0.address1, address2: ta0.address2, town: ta0.town, county: c.county || "", postcode: ta0.postcode,
    custType: c.custType || "Private", notes: c.notes || "",
  });
  const [contacts, setContacts] = useState(c.contacts || []);
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  async function save() {
    if (!f.name.trim()) { alert("Name is required."); return; }
    const keep = contacts.filter(contactFilled);
    const rec = { ...c, ...f, contacts: keep, contactsCleared: !keep.length && ((c.contacts || []).length > 0 || !!c.contactsCleared) ? true : undefined, id: c.id || uid(), ref: c.ref || null, createdAt: c.createdAt || new Date().toISOString() };
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
      <ContactsEditor contacts={contacts} onChange={setContacts} />
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
        <button onClick={paste} style={{ background: "#fff", border: "1.5px solid #D3DDDB", borderRadius: 8, padding: "5px 10px", fontSize: 12, fontWeight: 700, color: NAVY, cursor: "pointer" }}>📋 Paste from clipboard</button>
      </div>
      <Textarea value={note} onChange={setNote} placeholder={type === "Call" ? "What was discussed on the call" : "What was said / sent"} />
      <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
        {entry && canDelete() && <Btn variant="danger" onClick={del}><Icon name="trash" size={14} /></Btn>}
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
  const [resched, setResched] = useState(null);
  const [followUpOpen, setFollowUpOpen] = useState(false);
  const [sheetBusy, setSheetBusy] = useState(false);
  async function openSheet(rec) {
    if (sheetBusy) return;
    if (rec.amendedAt) { setSheetBusy(true); await openInventoryPdf(rec, c, data, "current"); setSheetBusy(false); return; }
    // Prefer the stored PDF — just open it to view (no re-save).
    const openUrl = url => showPdf(url, "Storage-sheet.pdf");
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
    const openUrl = url => showPdf(url, "Storage-sheet.pdf");
    if (col.pdfUrl) { openUrl(col.pdfUrl); return; }
    if (col.pdf) { try { const b = atob(col.pdf.split(",")[1]); const arr = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) arr[i] = b.charCodeAt(i); const url = URL.createObjectURL(new Blob([arr], { type: "application/pdf" })); openUrl(url); setTimeout(() => URL.revokeObjectURL(url), 8000); } catch {} }
  };
  if (!c) return <div style={{ padding: 20 }}>Customer not found.</div>;
  const enquiries = (data.enquiries || []).filter(e => e.customerId === id).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  const jobs = (data.jobs || []).filter(j => j.customerId === id);
  // Storage and move options only appear once the customer has been surveyed (or already has a move / storage job).
  // A lost / let-go enquiry doesn't count, even if it was surveyed before it was lost.
  const surveyedEnq = enquiries.some(e => !["Lost", "Let Go", "Not quoted"].includes(e.status) && (e.surveyDone || (e.inventory && e.inventory.length) || ["Surveyed", "Quoted", "Won"].includes(e.status)));
  const showMoveStorage = surveyedEnq || jobs.length > 0 || getStorageJobs(c).length > 0;
  const latest = enquiries[0];
  const openEnquiryEdit = en => { try { sessionStorage.setItem("removals_open_edit", en.id); } catch {} setView({ screen: "enquiryDetail", id: en.id }); };
  // Opens the enquiry's edit form. It only goes back to "New" if you tap Save — Cancel leaves it lost.
  function reopenAndRebook(en) {
    try { sessionStorage.setItem("removals_open_edit", en.id); sessionStorage.setItem("removals_rebook", en.id); } catch {}
    setView({ screen: "enquiryDetail", id: en.id });
  }
  // Quote still to build / still to email for a surveyed enquiry with no move yet
  const quotePanel = (() => {
    const pending = enquiries.filter(e => !["Lost", "Let Go", "Not quoted", "Won"].includes(e.status) && !jobs.some(j => j.enquiryId === e.id)
      && (e.surveyDone || (e.inventory && e.inventory.length) || ["Surveyed", "Quoted"].includes(e.status))
      && !(Number(e.quoteTotal) > 0 && ["Sent", "Accepted"].includes(e.quoteStatus)));
    if (!pending.length) return null;
    const openQuote = e => { try { sessionStorage.setItem("removals_open_quote", e.id); } catch {} setView({ screen: "enquiryDetail", id: e.id }); };
    return pending.map(e => {
      const built = Number(e.quoteTotal) > 0;
      return (
        <Card key={"q" + e.id} style={built ? { borderColor: "#FCA5A5", background: "#FFF7ED" } : { borderColor: "#BAE6FD", background: "#F0F9FF" }}>
          <div style={{ fontSize: 12, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".06em", color: built ? "#C2410C" : "#0369A1", marginBottom: 6 }}>Quote</div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
            <div style={{ fontSize: 13.5, color: "#374151", fontWeight: 600 }}>
              {built ? `⚠️ Quote built (${gbp(e.quoteTotal)}) but not emailed yet.` : "✓ Surveyed — quote still to build."}
              <div style={{ fontSize: 12, color: "#6A7B77", fontWeight: 500, marginTop: 2 }}>{e.fromTown || "—"} → {e.toTown || "—"}</div>
            </div>
            <div style={{ flexShrink: 0 }}><Btn size="sm" variant="amber" onClick={() => openQuote(e)}>{built ? "📧 Email quote" : "Build quote"}</Btn></div>
          </div>
        </Card>
      );
    });
  })();
  const chasePanel = enquiries.map(e => ({ e, q: quoteChase(data, e) })).filter(x => x.q).map(({ e, q }) => (
    <Card key={"ch" + e.id} style={{ borderColor: "#FDE68A", background: "#FFFBEB" }}>
      <div style={{ fontSize: 12, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".06em", color: "#B45309", marginBottom: 6 }}>Quote follow-up</div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
        <div style={{ fontSize: 13.5, color: "#374151", fontWeight: 600 }}>{quoteChaseText(q)}<div style={{ fontSize: 12, color: "#6A7B77", fontWeight: 500, marginTop: 2 }}>{gbp(e.quoteTotal)} · {e.fromTown || "—"} → {e.toTown || "—"}</div></div>
        <div style={{ flexShrink: 0 }}>{q.phone ? <ChaseCallBtn data={data} e={e} /> : <span style={{ fontSize: 12, color: "#B7C3C0" }}>No number</span>}</div>
      </div>
    </Card>
  ));
  const surveyPanel = (() => {
    if (showMoveStorage) return null;
    let line, btn;
    if (!latest) { line = "No enquiry yet."; btn = <Btn size="sm" onClick={() => setView({ screen: "newEnquiry", customerId: c.id })}>+ New enquiry</Btn>; }
    else if (["Lost", "Let Go", "Not quoted"].includes(latest.status)) { line = `${latest.status === "Lost" ? "Enquiry lost" : latest.status === "Not quoted" ? "We didn't quote" : "Enquiry let go"}${latest.lostReason ? ` — ${latest.lostReason}` : ""}. Changed their mind?`; btn = <Btn size="sm" onClick={() => reopenAndRebook(latest)}>📅 Rebook survey</Btn>; }
    else if (surveyOverdue(latest)) { line = `Survey missed — was due ${fmtDate(latest.surveyDate)} (${dow(latest.surveyDate)})${latest.surveyTime ? ` · ${latest.surveyTime}` : ""}.`; btn = <Btn size="sm" onClick={() => setResched(latest)}>📅 Reschedule</Btn>; }
    else if (latest.surveyDate) { line = `Survey booked: ${fmtDate(latest.surveyDate)} (${dow(latest.surveyDate)})${latest.surveyTime ? ` · ${latest.surveyTime}` : ""}.`; btn = <Btn size="sm" variant="grey" onClick={() => openEnquiryEdit(latest)}>📅 Rebook survey</Btn>; }
    else { line = `Survey not booked yet.${latest.newCalledAt ? ` Last called ${fmtDateShort(latest.newCalledAt.slice(0, 10))}.` : " Not called yet."}`; btn = <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}><NewEnqCallBtn data={data} e={latest} /><Btn size="sm" variant="grey" onClick={() => openEnquiryEdit(latest)}>📅 Book survey</Btn></div>; }
    return (
      <Card>
        <div style={{ fontSize: 12, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".06em", color: "#94A4A0", marginBottom: 6 }}>Survey</div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
          <div style={{ fontSize: 13.5, color: "#374151", fontWeight: 600 }}>{line}</div>
          <div style={{ flexShrink: 0 }}>{btn}</div>
        </div>
        <div style={{ fontSize: 12, color: "#94A4A0", marginTop: 8 }}>Storage and move options appear once the survey is done.</div>
      </Card>
    );
  })();
  async function del() {
    if (!confirm(`Delete ${c.name}?${customerDeleteSummary(data, c.id)} This can't be undone.`)) return;
    SAVING_IN_PROGRESS = true; showSavingOverlay();
    const d2 = await deleteCustomerFully(data, c.id);
    setDB(JSON.stringify(d2));
    SAVING_IN_PROGRESS = false; setView({ screen: "customers" }); window.location.reload();
  }
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "0 0 14px" }}>
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
      <div style={{ ...contactRowStyle(1 + !!c.phone + !!c.email), marginBottom: 8, marginTop: 4 }}>
        {c.phone && <Btn variant="primary" style={contactBtn} onClick={() => { logComm(c.id, { type: "Call" }); window.location.href = `tel:${c.phone}`; }}>📞 Call</Btn>}
        <MessageButton customer={c} ctx={msgCtx} size="md" variant="primary" style={contactBtn} />
        {c.email && <Btn variant="primary" style={contactBtn} onClick={() => { logComm(c.id, { type: "Email" }); window.location.href = `mailto:${c.email}`; }}>✉️ Email</Btn>}
      </div>
      <OtherContacts customer={c} onLog={en => logComm(c.id, en)} />
      {surveyPanel}
      {quotePanel}
      {chasePanel}
      {showMoveStorage && (
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: getStorageJobs(c).length ? 8 : 0 }}>
          <div style={{ fontSize: 12, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".06em", color: "#94A4A0" }}>Storage jobs</div>
          <Btn size="sm" onClick={() => setJobForm("new")}>+ Add storage job</Btn>
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
                  <span onClick={() => openSheet(rec)} style={{ color: TEAL, fontSize: 12, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>{sheetBusy ? "…" : rec.amendedAt ? "Current" : "PDF"}</span>
                  {rec.amendedAt && <span onClick={async () => { if (sheetBusy) return; setSheetBusy(true); await openInventoryPdf(rec, c, data, "original"); setSheetBusy(false); }} style={{ color: "#B45309", fontSize: 12.5, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>Original</span>}
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
      )}
      {(() => {
        const showFu = !(data.jobs || []).some(j => j.customerId === c.id && j.status === "Provisional");
        const eq = { width: "100%", minWidth: 0, whiteSpace: "nowrap" };
        return (
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${1 + (showFu ? 1 : 0) + (canDelete() ? 1 : 0)}, 1fr)`, gap: 8, marginBottom: 6 }}>
            <Btn style={eq} onClick={() => setShowEdit(true)}><Icon name="edit" size={15} /> Edit</Btn>
            {showFu && <Btn variant="grey" style={eq} onClick={() => setFollowUpOpen(true)}>⏰ {c.followUpDate ? fmtUK(c.followUpDate).slice(0, 5) : "Follow-up"}</Btn>}
            {canDelete() && <Btn variant="danger" style={eq} onClick={del}><Icon name="trash" size={15} /> Delete</Btn>}
          </div>
        );
      })()}

      <SectionTitle>Enquiries</SectionTitle>
      {enquiries.length === 0 && <div style={{ fontSize: 13, color: "#9CA3AF", marginBottom: 10 }}>None yet.</div>}
      {enquiries.map(e => (
        <Card key={e.id} onClick={() => setView({ screen: "enquiryDetail", id: e.id })}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 14, color: "#111827" }}>{e.fromTown || "—"} → {e.toTown || "—"} · {fmtDateShort(e.preferredDate)}</div>
            <StatusBadge status={enqBadge(data, e)} />
          </div>
          {e.status === "Lost" && <div style={{ fontSize: 13, color: "#B91C1C", fontWeight: 600, marginTop: 6 }}>Lost reason: {e.lostReason || "none given"}</div>}
          {e.status === "Not quoted" && <div style={{ fontSize: 13, color: "#6B7280", fontWeight: 600, marginTop: 6 }}>We didn't quote{e.lostReason ? `: ${e.lostReason}` : " — no reason given"}{!isReadOnly() && !e.altClosed && <> · <span role="button" onClick={() => markNotQuotedFlow(data, e)} style={{ color: TEAL, textDecoration: "underline", cursor: "pointer" }}>{e.lostReason ? "change" : "add reason"}</span></>}</div>}
        </Card>
      ))}

      {showMoveStorage && <SectionTitle>Moves</SectionTitle>}
      {showMoveStorage && jobs.filter(j => j.status !== "Completed").length === 0 && <div style={{ fontSize: 13, color: "#9CA3AF" }}>None yet.</div>}
      {jobs.filter(j => j.status !== "Completed").sort((a, b) => (a.moveDate || "").localeCompare(b.moveDate || "")).map(j => (
        <Card key={j.id} onClick={() => setView(j.enquiryId ? { screen: "enquiryDetail", id: j.enquiryId } : { screen: "jobDetail", id: j.id })}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 14, color: "#111827" }}><b style={{ color: TEAL_D }}>{moveRef(data, j)}</b> · {fmtDate(j.moveDate)} ({dow(j.moveDate)}) · {gbp(j.price)}{volText(data, j) ? ` · 📦 ${volText(data, j)}` : ""}</div>
            <StatusBadge status={jobBadge(j)} />
          </div>
        </Card>
      ))}

      {jobs.some(j => j.status === "Completed") && (
        <>
          <SectionTitle>Completed moves</SectionTitle>
          {jobs.filter(j => j.status === "Completed").sort((a, b) => (b.moveDate || "").localeCompare(a.moveDate || "")).map(j => (
            <Card key={j.id} onClick={() => setView(j.enquiryId ? { screen: "enquiryDetail", id: j.enquiryId } : { screen: "jobDetail", id: j.id })}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontSize: 14, color: "#111827" }}><b style={{ color: TEAL_D }}>{moveRef(data, j)}</b> · {fmtDate(j.moveDate)} ({dow(j.moveDate)}) · {gbp(j.price)}{volText(data, j) ? ` · 📦 ${volText(data, j)}` : ""}</div>
                <StatusBadge status={jobBadge(j)} />
              </div>
            </Card>
          ))}
        </>
      )}
      {showEdit && <CustomerForm data={data} editCustomer={c} onClose={() => setShowEdit(false)} />}
      {jobForm && <StorageJobForm data={data} customer={c} job={jobForm === "new" ? null : jobForm} onClose={() => setJobForm(null)} />}
      {resched && <RescheduleSurveyModal data={data} enquiry={resched} onClose={() => setResched(null)} />}
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
      <HistoryList customerId={c.id} title="History of changes" />
    </div>
  );
}

// ── Jobs (booked moves) ─────────────────────────────────────────────────────
function JobsList({ data, setView }) {
  const [filter, setFilter] = useState("Upcoming");
  const jobs = (data.jobs || [])
    .filter(j => filter === "All" ? true : filter === "Completed" ? j.status === "Completed" : filter === "No date" ? jobBadge(j) === "No date provisional" : j.status !== "Completed")
    .sort((a, b) => (a.moveDate || "9999").localeCompare(b.moveDate || "9999"));
  const filters = ["Upcoming", "No date", "Completed", "All"];
  return (
    <div>
      <h2 style={{ margin: "0 0 12px", fontSize: 20, fontWeight: 800, color: "#111827" }}>Moves</h2>
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
              <div style={{ fontSize: 13, color: "#6B7280", marginTop: 2 }}>{j.moveDate ? `${fmtDate(j.moveDate)} (${dow(j.moveDate)})` : "No date yet"} · {j.fromTown || "—"} → {j.toTown || "—"}</div>
              <div style={{ fontSize: 12, color: "#9CA3AF", marginTop: 2 }}>{volText(data, j) ? <b style={{ color: "#41514E" }}>📦 {volText(data, j)} · </b> : null}{j.vehicle || "—"} · {gbp(j.price)}{j.deposit ? ` · dep ${gbp(j.deposit)}${j.depositPaid ? " ✓" : ""}` : ""}</div>
            </div>
            <StatusBadge status={jobBadge(j)} />
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

// Importing from the old Mover system: skip customers already in the app (same mobile, home
// phone or email) along with their enquiries/moves, and drop any reference number that's
// already taken by someone else so the database can give them a fresh one.
function prepareMoverImport(cur, inc) {
  const dig = v => String(v || "").replace(/\D/g, "").replace(/^44/, "0");
  const phones = new Set(), emails = new Set(), refs = new Set(), ids = new Set();
  (cur.customers || []).forEach(c => {
    ids.add(c.id);
    if (c.ref != null && c.ref !== "") refs.add(String(c.ref));
    [c.phone, c.homePhone, ...(c.contacts || []).map(x => x.phone)].map(dig).filter(x => x.length >= 10).forEach(x => phones.add(x));
    [c.email, ...(c.contacts || []).map(x => x.email)].map(x => String(x || "").trim().toLowerCase()).filter(Boolean).forEach(x => emails.add(x));
  });
  const skipped = [], skipIds = new Set(); let refsCleared = 0;
  const customers = (inc.customers || []).filter(c => {
    if (ids.has(c.id)) return true; // imported before: just update it
    const ph = [c.phone, c.homePhone].map(dig).filter(x => x.length >= 10);
    const em = String(c.email || "").trim().toLowerCase();
    if (ph.some(x => phones.has(x)) || (em && emails.has(em))) { skipped.push(c.name || "?"); skipIds.add(c.id); return false; }
    return true;
  }).map(c => (c.ref != null && refs.has(String(c.ref)) && !ids.has(c.id)) ? (refsCleared++, { ...c, ref: null }) : c);
  const keep = r => !skipIds.has(r.customerId);
  return { inc: { ...inc, customers, enquiries: (inc.enquiries || []).filter(keep), jobs: (inc.jobs || []).filter(keep) }, skipped, refsCleared };
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
  // ...and take them off the shared deleted list, or the next sync would delete them again.
  try { await undeleteInCloud(restoredIds); }
  catch (e) { alert("Restore needs a signal (it has to tell the cloud these records are back). Connect and try again.\n\n" + ((e && e.message) || "")); hideSavingOverlay(); return; }
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
  const all = [], seen = new Set();
  const add = (t, r) => { if (r && r.id && !seen.has(r.id)) { seen.add(r.id); all.push([t, r.id]); } };
  tables.forEach(t => (data[t] || []).forEach(r => add(t, r)));
  // Also anything still in the cloud that this device isn't showing (e.g. a delete that was
  // interrupted part-way), so a second go always finishes the job.
  try { const cloud = await pullFromCloud(); tables.forEach(t => ((cloud && cloud[t]) || []).forEach(r => add(t, r))); } catch {}
  all.forEach(([, id]) => addTombstone(id));
  SKIP_DELLOG = true;
  // Delete in bulk (a few requests per table) — one request per record took many minutes.
  for (const t of tables) {
    const ids = all.filter(([tt]) => tt === t).map(([, id]) => id);
    if (!ids.length) continue;
    try { await deleteMany(t, ids); }
    catch { for (const id of ids) { try { await deleteRecord(t, id); } catch {} } }
  }
  SKIP_DELLOG = false;
  await logCloudDeletes(all.map(([, id]) => id));
  queueLog([{ id: uid() + uid(), at: new Date().toISOString(), who: logWho(), customer_id: null, rec_table: "all", rec_id: "", summary: `Deleted all customers, enquiries and jobs (${all.length} records)`, changes: [] }]); await flushLog();
  const cleared = { ...data, customers: [], enquiries: [], jobs: [] };
  setDB(JSON.stringify(cleared));
  try {
    const sigs = JSON.parse(localStorage.getItem(SIG_KEY) || "{}");
    all.forEach(([, id]) => { delete sigs[id]; });
    localStorage.setItem(SIG_KEY, JSON.stringify(sigs));
  } catch {}
  try {
    const at = new Date().toISOString();
    await supabase.from("app_config").upsert({ key: "wipe", value: { at }, updated_at: Date.now() }, { onConflict: "key" });
    localStorage.setItem(WIPE_SEEN_KEY, at);
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
      merged = mergeAll(await pullCloud(), loadData());
      try { setDB(JSON.stringify(merged)); } catch {}
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
    try { setDB(JSON.stringify(d)); } catch {}
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

// Find vans with the same name/reg and staff with the same name.
function findDuplicates(data) {
  const group = (arr, key) => { const g = {}; (arr || []).forEach(r => { const k = key(r); if (k) (g[k] = g[k] || []).push(r); }); return Object.values(g).filter(x => x.length > 1); };
  return {
    vehicles: group(data.vehicles, v => (v.name || v.reg || "").trim().toLowerCase()),
    staff: group(data.staff, s => (s.name || "").trim().toLowerCase()),
  };
}
function DuplicateCleanup({ data, setData }) {
  const dups = findDuplicates(data);
  const extra = dups.vehicles.reduce((n, g) => n + g.length - 1, 0) + dups.staff.reduce((n, g) => n + g.length - 1, 0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  async function clean() {
    const names = [...dups.vehicles, ...dups.staff].map(g => g[0].name).join(", ");
    if (!confirm(`Merge ${extra} duplicate${extra !== 1 ? "s" : ""} (${names})?\n\nOne copy of each is kept. Bookings, servicing and holidays from the copies are moved onto it, so nothing is lost.`)) return;
    setBusy(true);
    let d = loadData();
    const usage = id => (d.jobs || []).reduce((n, j) => n + ((j.vehicleIds || []).includes(id) || j.vehicleId === id ? 1 : 0) + jobStages(j).filter(st => (st.vehicleIds || []).includes(id)).length, 0);
    const failed = [];
    for (const g of dups.vehicles) {
      const cur = g.map(v => (d.vehicles || []).find(x => x.id === v.id) || v);
      const keep = cur.slice().sort((a, b) => usage(b.id) - usage(a.id) || (b.updatedAt || 0) - (a.updatedAt || 0))[0];
      const gone = cur.filter(v => v.id !== keep.id), goneIds = new Set(gone.map(v => v.id));
      const fix = ids => Array.from(new Set((ids || []).map(id => goneIds.has(id) ? keep.id : id)));
      const fixStages = st => Array.isArray(st) ? st.map(x => ({ ...x, vehicleIds: fix(x.vehicleIds) })) : st;
      d = { ...d,
        jobs: (d.jobs || []).map(j => ({ ...j, vehicleIds: fix(j.vehicleIds), vehicleId: goneIds.has(j.vehicleId) ? keep.id : j.vehicleId, stages: fixStages(j.stages) })),
        enquiries: (d.enquiries || []).map(e => ({ ...e, stages: fixStages(e.stages) })) };
      const bookings = {}; [keep, ...gone].forEach(v => ((v.maint && v.maint.bookings) || []).forEach(b => { bookings[b.id || (b.start + b.type)] = b; }));
      d = upsertLocal(d, "vehicles", { ...keep, maint: { ...(keep.maint || {}), bookings: Object.values(bookings) }, updatedAt: Date.now() });
      for (const v of gone) { addTombstone(v.id); try { await deleteRecord("vehicles", v.id); } catch { failed.push(v.name); } d = { ...d, vehicles: d.vehicles.filter(x => x.id !== v.id) }; }
    }
    for (const g of dups.staff) {
      const cur = g.map(s => (d.staff || []).find(x => x.id === s.id) || s);
      const keep = cur.slice().sort((a, b) => (b.active !== false) - (a.active !== false) || (b.updatedAt || 0) - (a.updatedAt || 0))[0];
      const gone = cur.filter(s => s.id !== keep.id);
      const away = {}; [keep, ...gone].forEach(s => (s.away || []).forEach(b => { away[b.id || (b.start + "|" + b.days)] = b; }));
      d = upsertLocal(d, "staff", { ...keep, away: Object.values(away), updatedAt: Date.now() });
      for (const s of gone) { addTombstone(s.id); try { await deleteRecord("staff", s.id); } catch { failed.push(s.name); } d = { ...d, staff: d.staff.filter(x => x.id !== s.id) }; }
    }
    setBusy(false);
    if (failed.length) alert(`Merged on this device. The cloud copy of ${failed.join(", ")} couldn't be deleted yet (offline, or the cloud is blocking deletes). The app will keep retrying each time it syncs.`);
    await saveAndReload(d);
  }
  return (
    <div style={{ marginTop: 12, borderTop: "1px solid #EEF3F2", paddingTop: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 4 }}>Merge duplicate vans &amp; staff</div>
      <div style={{ fontSize: 12, color: "#94A4A0", marginBottom: 8 }}>{extra ? `Found: ${[...dups.vehicles, ...dups.staff].map(g => `${g[0].name} ×${g.length}`).join(", ")}.` : "Finds vans or staff that appear more than once and merges them into one."}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <Btn size="sm" variant={extra ? "danger" : "grey"} disabled={busy || !extra} onClick={clean}>{busy ? "Merging…" : extra ? `Merge ${extra} duplicate${extra !== 1 ? "s" : ""}` : "None found"}</Btn>
        {msg && <div style={{ fontSize: 12.5, color: msg.startsWith("Merged ") ? "#15803D" : "#B45309", fontWeight: 700 }}>{msg}</div>}
      </div>
    </div>
  );
}

// ══ Reports: where leads come from and which turn into work ═════════════════
const LEAD_SOURCES = ["Moved Before", "Customer Referral", "Google", "YBA", "Vehicle Spotted", "Estate Agent", "Website", "Reference Line"];
// Turn whatever was typed (or came in by email) into one of the sources above.
function normalizeReferral(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  const hit = LEAD_SOURCES.find(x => x.toLowerCase() === s.toLowerCase());
  if (hit) return hit;
  const t = s.toLowerCase();
  if (/reference\s*line|ref\.?\s*line/.test(t)) return "Reference Line";
  if (/moved?\s*(with\s*(you|us)\s*)?before|previous|used (you|us)|repeat|return(ing)? customer|again|existing customer|past customer/.test(t)) return "Moved Before";
  if (/recommend|referr|friend|family|word of mouth|neighbou?r|colleague|relative/.test(t)) return "Customer Referral";
  if (/estate|agent|letting|solicitor/.test(t)) return "Estate Agent";
  if (/\byba\b|yell/.test(t)) return "YBA";
  if (/van|lorry|vehicle|truck|spotted|saw (your|you|the)|on the road/.test(t)) return "Vehicle Spotted";
  if (/google|search|internet|maps/.test(t)) return "Google";
  if (/website|web site|\bweb\b|online|site/.test(t)) return "Website";
  return "Other";
}
const LOST_REASONS = ["Too expensive", "Went with another company", "No response", "Move cancelled / postponed", "Date not available", "Decided to do it themselves", "Other"];
function normalizeLost(v) {
  const s = String(v || "").trim(); if (!s) return "Not given";
  const hit = LOST_REASONS.find(x => x.toLowerCase() === s.toLowerCase()); if (hit) return hit;
  const t = s.toLowerCase();
  if (/expens|price|cheap|cost|budget|too much|dear/.test(t)) return "Too expensive";
  if (/another|other (company|firm|remov)|elsewhere|competitor|went with/.test(t)) return "Went with another company";
  if (/no (response|reply|answer)|ignored|ghost|didn'?t (reply|answer|respond)|not heard/.test(t)) return "No response";
  if (/cancel|postpon|fell through|not moving|delayed|on hold/.test(t)) return "Move cancelled / postponed";
  if (/date|availab|booked up|fully booked/.test(t)) return "Date not available";
  if (/themsel|diy|own van|friends/.test(t)) return "Decided to do it themselves";
  return "Other";
}
// Pick a lost reason from a list (replaces the old free-text box). Resolves null on Cancel.
const NOT_QUOTED_REASONS = ["Too far / out of area", "Job too small", "Fully booked on their date", "Customer cancelled / not moving", "Customer went quiet", "Duplicate enquiry", "Not our type of work", "Other"];
function pickLostReason(current, opts = {}) {
  const LIST = opts.list || LOST_REASONS;
  const TITLE = opts.title || "Why was it lost?";
  return new Promise(resolve => {
    const wrap = document.createElement("div");
    wrap.style.cssText = "position:fixed;inset:0;z-index:10001;background:rgba(15,46,42,.45);display:flex;align-items:flex-end;justify-content:center;font-family:Inter,system-ui,sans-serif;";
    const box = document.createElement("div");
    box.style.cssText = "background:#fff;width:100%;max-width:460px;border-radius:18px 18px 0 0;padding:18px 16px calc(env(safe-area-inset-bottom,0px) + 16px);box-shadow:0 -6px 30px rgba(0,0,0,.2);";
    box.innerHTML = '<div style="font-size:17px;font-weight:800;color:#10211E;margin-bottom:4px">' + TITLE + '</div><div style="font-size:13px;color:#6A7B77;margin-bottom:12px">This feeds the Reports page.</div>';
    const done = v => { wrap.remove(); resolve(v); };
    LIST.forEach(r => {
      const b = document.createElement("button");
      b.textContent = r;
      b.style.cssText = `display:block;width:100%;text-align:left;margin-bottom:7px;padding:12px 14px;border-radius:11px;font-size:15px;font-weight:700;cursor:pointer;border:1.5px solid ${r === current ? "#0F766E" : "#E3E9E8"};background:${r === current ? "#E8F5F3" : "#fff"};color:#10211E;`;
      b.onclick = () => {
        if (r !== "Other") return done(r);
        const extra = prompt("Other reason (optional):", "");
        if (extra === null) return;
        done(extra.trim() ? `Other: ${extra.trim()}` : "Other");
      };
      box.appendChild(b);
    });
    const c = document.createElement("button");
    c.textContent = "Cancel";
    c.style.cssText = "display:block;width:100%;margin-top:4px;padding:12px;border-radius:11px;border:none;background:#F1F5F4;font-size:15px;font-weight:700;color:#374151;cursor:pointer;";
    c.onclick = () => done(null);
    box.appendChild(c);
    wrap.appendChild(box);
    wrap.onclick = e => { if (e.target === wrap) done(null); };
    document.body.appendChild(wrap);
  });
}

const WON_JOB = ["Confirmed", "Booked", "In Progress", "Completed"];
function enquiryOutcome(data, e) {
  const jobs = (data.jobs || []).filter(j => j.enquiryId === e.id && j.status !== "Let Go");
  const wonJob = jobs.find(j => WON_JOB.includes(j.status));
  const provisional = !wonJob && jobs.find(j => j.status === "Provisional");
  const quoted = Number(e.quoteTotal) > 0 || ["Quoted", "Won"].includes(e.status) || jobs.length > 0;
  const surveyed = quoted || !!e.surveyDone || (e.inventory && e.inventory.length > 0) || ["Surveyed", "Booked", "Quoted", "Won"].includes(e.status);
  const won = !!wonJob || e.status === "Won";
  const value = won ? (Number(wonJob && wonJob.price) || Number(e.quoteTotal) || 0) : 0;
  return {
    source: normalizeReferral(e.referredBy) || "Not recorded",
    surveyor: e.surveyor || "",
    surveyed, quoted, won,
    completed: !!jobs.find(j => j.status === "Completed"),
    provisional: !!provisional,
    open: quoted && !won && !["Lost", "Let Go", "Not quoted"].includes(e.status),
    lost: e.status === "Lost", letGo: e.status === "Let Go", notQuoted: e.status === "Not quoted",
    nqReason: e.status === "Not quoted" ? (String(e.lostReason || "").trim() || "No reason given") : "",
    lostReason: e.status === "Lost" ? normalizeLost(e.lostReason) : "",
    quote: Number(e.quoteTotal) || Number(jobs[0] && jobs[0].price) || 0,
    value,
    town: (e.fromTown || "").trim(),
    beds: Number(e.fromBedrooms) || 0,
    created: String(e.createdAt || e.surveyDate || "").slice(0, 10),
    surveyDate: String(e.surveyDate || "").slice(0, 10),
    moveDate: (() => { const j = wonJob || provisional || jobs[0]; const ds = j ? jobStages(j).map(st => st.date).filter(Boolean).sort() : []; return ds[0] || j?.moveDate || e.preferredDate || (e.moveMonth ? e.moveMonth + "-01" : ""); })(),
  };
}

// ── Printable PDF of the Reports screen ─────────────────────────────────────
// spec: { title, subtitle, tiles: [[label, value]], sections: [{ title, note, head: [...], rows: [[...]], bold: rowIndex }] }
function ReportPdfButton({ build }) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const spec = build();
      const bytes = await buildReportPdf(spec);
      const f = new File([bytes], `RJ Sales report ${todayISO()}.pdf`, { type: "application/pdf" });
      await showPdf(f, f.name);
    } catch (ex) { alert("Could not make the report: " + ((ex && ex.message) || ex)); }
    setBusy(false);
  };
  return <button type="button" data-ro-ok onClick={go} disabled={busy} style={{ width: "100%", marginBottom: 14, padding: "12px 14px", borderRadius: 12, border: "1.5px solid #CFE3DF", background: "#fff", color: TEAL_D, fontWeight: 800, fontSize: 15, cursor: "pointer", fontFamily: "inherit" }}>{busy ? "Making the report…" : "🖨️ Printable PDF report"}</button>;
}

async function buildReportPdf(spec) {
  const { PDFDocument, StandardFonts, rgb } = await loadPdfLib();
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = 595.28, H = 841.89, M = 40;
  const TEALc = rgb(0.06, 0.46, 0.43), GREY = rgb(0.42, 0.48, 0.47), LINE = rgb(0.86, 0.89, 0.88), BLACK = rgb(0.06, 0.13, 0.12), SHADE = rgb(0.95, 0.97, 0.97);
  const clean = t => String(t == null ? "" : t).replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2013\u2014]/g, "-").replace(/\u2026/g, "...").replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, "");
  let page, y, pageNo = 0;
  const newPage = () => {
    page = pdf.addPage([W, H]); pageNo++; y = H - M;
    page.drawText("R&J Removals & Storage", { x: M, y: H - 26, size: 8, font, color: GREY });
    const pn = `Page ${pageNo}`; page.drawText(pn, { x: W - M - font.widthOfTextAtSize(pn, 8), y: H - 26, size: 8, font, color: GREY });
  };
  const need = h => { if (y - h < M) newPage(); };
  const text = (t, x, size, f = font, col = BLACK) => page.drawText(clean(t), { x, y, size, font: f, color: col });
  const rtext = (t, xr, size, f = font, col = BLACK) => { const c = clean(t); page.drawText(c, { x: xr - f.widthOfTextAtSize(c, size), y, size, font: f, color: col }); };
  const wrap = (t, size, maxW, f = font) => { const out = []; let line = ""; clean(t).split(/\s+/).forEach(w => { const test = line ? line + " " + w : w; if (f.widthOfTextAtSize(test, size) > maxW && line) { out.push(line); line = w; } else line = test; }); if (line) out.push(line); return out; };
  newPage();
  y -= 14;
  text(spec.title, M, 20, bold, TEALc); y -= 18;
  text(spec.subtitle, M, 10, font, GREY); y -= 24;
  // tiles: 3 per row
  const tw = (W - 2 * M - 20) / 3, th = 46;
  spec.tiles.forEach(([l, v], i) => {
    if (i % 3 === 0) { need(th + 10); if (i) y -= th + 10; }
    const x = M + (i % 3) * (tw + 10);
    page.drawRectangle({ x, y: y - th + 10, width: tw, height: th, color: SHADE, borderColor: LINE, borderWidth: 0.6 });
    page.drawText(clean(v), { x: x + 10, y: y - 10, size: 16, font: bold, color: BLACK });
    page.drawText(clean(l), { x: x + 10, y: y - 26, size: 8.5, font, color: GREY });
  });
  y -= th + 18;
  for (const sec of spec.sections) {
    const cols = sec.head.length, tableW = W - 2 * M;
    const firstW = sec.firstFrac ? tableW * sec.firstFrac : Math.min(170, tableW * (cols > 4 ? 0.34 : 0.42)), otherW = (tableW - firstW) / Math.max(1, cols - 1);
    const xs = sec.head.map((_, i) => i === 0 ? M : M + firstW + otherW * i);
    need(60);
    text(sec.title.toUpperCase(), M, 10.5, bold, TEALc); y -= 13;
    if (sec.note) { for (const ln of wrap(sec.note, 8, tableW)) { need(12); text(ln, M, 8, font, GREY); y -= 10; } }
    y -= 4;
    const headRow = () => {
      page.drawRectangle({ x: M, y: y - 5, width: tableW, height: 16, color: SHADE });
      sec.head.forEach((h, i) => i === 0 ? text(h, xs[0] + 4, 8, bold, GREY) : rtext(h, xs[i] - 4, 8, bold, GREY));
      y -= 17;
    };
    if (!sec.rows.length) { need(14); text(sec.empty || "Nothing in this period.", M, 9, font, GREY); y -= 22; continue; }
    headRow();
    sec.rows.forEach((r, ri) => {
      if (y - 15 < M) { newPage(); headRow(); }
      const f = (sec.boldRows || []).includes(ri) ? bold : font;
      r.forEach((c, i) => {
        if (i === 0) { let t = clean(c); while (t.length > 3 && f.widthOfTextAtSize(t, 9) > firstW - 8) t = t.slice(0, -2); text(t, xs[0] + 4, 9, f); }
        else rtext(c, xs[i] - 4, 9, f);
      });
      page.drawLine({ start: { x: M, y: y - 4 }, end: { x: M + tableW, y: y - 4 }, thickness: 0.5, color: LINE });
      y -= 15;
    });
    y -= 14;
  }
  return await pdf.save();
}

function ReportsView({ data }) {
  const [period, setPeriod] = useState(() => { try { const v = localStorage.getItem("rm_rep_period") || "12m"; return v === "next" ? "12m" : v; } catch { return "12m"; } });
  const [who, setWho] = useState("");
  // Reports go by the survey date (or the date the enquiry came in, if there's no survey yet).
  const basis = "survey";
  useEffect(() => { try { localStorage.setItem("rm_rep_period", period); } catch {} }, [period]);
  const [repCustom, setRepCustomRaw] = useState(() => { try { return JSON.parse(localStorage.getItem("rm_rep_custom") || "null") || { from: "", to: "" }; } catch { return { from: "", to: "" }; } });
  const setRepCustom = v => { setRepCustomRaw(v); try { localStorage.setItem("rm_rep_custom", JSON.stringify(v)); } catch {} };
  const today = todayISO();
  const monthStart = today.slice(0, 7) + "-01";
  const monthEnd = isoAdd(isoAdd(monthStart, { months: 1 }), { days: -1 });
  const nextStart = isoAdd(monthStart, { months: 1 });
  const [from, to] = {
    "1m": [monthStart, monthEnd],
    "next": [nextStart, isoAdd(isoAdd(nextStart, { months: 1 }), { days: -1 })],
    "last": [isoAdd(monthStart, { months: -1 }), isoAdd(monthStart, { days: -1 })],
    "3m": [isoAdd(today, { months: -3 }), basis === "created" ? today : isoAdd(today, { months: 3 })],
    "6m": [isoAdd(today, { months: -6 }), basis === "created" ? today : isoAdd(today, { months: 6 })],
    "12m": [isoAdd(today, { months: -12 }), basis === "created" ? today : isoAdd(today, { months: 12 })],
    ytd: [today.slice(0, 4) + "-01-01", today.slice(0, 4) + "-12-31"],
    all: ["", ""],
    custom: [repCustom.from || "", repCustom.to || ""],
  }[period] || ["", ""];
  const dateOf = o => o.surveyDate || o.created;
  const all = altReps(data, data.enquiries || []).map(e => enquiryOutcome(data, e)); // alternative quotes = one lead
  const surveyors = Array.from(new Set(all.map(o => o.surveyor).filter(Boolean))).sort();
  const inRange = o => { if (!from && !to) return true; const d = dateOf(o); if (!d) return false; return (!from || d >= from) && (!to || d <= to); };
  const rows = all.filter(o => inRange(o) && (!who || o.surveyor === who));

  const sum = (arr, f) => arr.reduce((a, o) => a + (f(o) ? 1 : 0), 0);
  const money = arr => arr.reduce((a, o) => a + o.value, 0);
  const pct = (a, b) => b ? Math.round((a / b) * 100) : 0;
  const gbp0 = n => "£" + Math.round(n || 0).toLocaleString("en-GB");
  // Win rate = jobs booked ÷ leads (leads we chose not to quote don't count).
  const decided = arr => sum(arr, o => !o.notQuoted);

  const wonN = sum(rows, o => o.won);
  const head = (t, sub) => <div style={{ marginBottom: 10 }}><div style={{ fontSize: 12, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".06em", color: "#94A4A0" }}>{t}</div>{sub && <div style={{ fontSize: 12, color: "#9CA3AF", marginTop: 2 }}>{sub}</div>}</div>;
  const Bar = ({ v, max, color = TEAL }) => <div style={{ height: 8, background: "#EEF3F2", borderRadius: 99, overflow: "hidden" }}><div style={{ width: `${max ? Math.max(2, Math.round((v / max) * 100)) : 0}%`, height: "100%", background: color, borderRadius: 99 }} /></div>;
  const group = (arr, key) => { const m = {}; arr.forEach(o => { const k = key(o); if (k == null || k === "") return; (m[k] = m[k] || []).push(o); }); return Object.entries(m); };

  // Lead sources
  const sources = group(rows, o => o.source).map(([k, arr]) => ({ k, n: arr.length, dq: decided(arr), surveyed: sum(arr, o => o.surveyed), quoted: sum(arr, o => o.quoted), open: sum(arr, o => o.open), won: sum(arr, o => o.won), lost: sum(arr, o => o.lost), win: pct(sum(arr, o => o.won), decided(arr)), money: money(arr) }))
    .sort((a, b) => b.money - a.money || b.won - a.won || b.n - a.n);
  const bestSrc = sources.filter(s => s.k !== "Not recorded" && s.k !== "Other" && s.n >= 3).sort((a, b) => b.win - a.win)[0];
  const topMoney = Math.max(1, ...sources.map(s => s.money));
  // Funnel
  const funnel = [["Enquiries", rows.length], ["Surveyed", sum(rows, o => o.surveyed)], ["Quotes given", sum(rows, o => o.quoted)], ["Won", wonN], ["Completed", sum(rows, o => o.completed)]];
  const lostN = sum(rows, o => o.lost);
  // Surveyors
  const survs = group(rows.filter(o => o.surveyor), o => o.surveyor).map(([k, arr]) => { const q = arr.filter(o => o.quote > 0); return { k, surveyed: sum(arr, o => o.surveyed), quoted: sum(arr, o => o.quoted), open: sum(arr, o => o.open), won: sum(arr, o => o.won), win: pct(sum(arr, o => o.won), decided(arr)), avgQuote: q.length ? q.reduce((a, o) => a + o.quote, 0) / q.length : 0, money: money(arr) }; }).sort((a, b) => b.money - a.money);
  // Lost reasons
  const lostRows = rows.filter(o => o.lost);
  const reasons = group(lostRows, o => o.lostReason).map(([k, arr]) => ({ k, n: arr.length, srcs: group(arr, o => o.source).sort((a, b) => b[1].length - a[1].length).slice(0, 2).map(([s, a]) => `${s} ${a.length}`).join(", ") })).sort((a, b) => b.n - a.n);
  // Didn't quote reasons
  const nqRows = rows.filter(o => o.notQuoted);
  const nqReasons = group(nqRows, o => o.nqReason).map(([k, arr]) => ({ k, n: arr.length })).sort((a, b) => b.n - a.n);
  // Monthly (always last 12 months, filtered by surveyor only)
  const months = Array.from({ length: 12 }, (_, i) => isoAdd(today.slice(0, 7) + "-01", { months: -(11 - i) }).slice(0, 7));
  const monthly = months.map(m => { const arr = all.filter(o => (dateOf(o) || "").slice(0, 7) === m && (!who || o.surveyor === who)); return { m, n: arr.length, won: sum(arr, o => o.won) }; });
  const maxMonth = Math.max(1, ...monthly.map(x => x.n));
  // Areas & sizes
  const towns = group(rows, o => o.town ? o.town.replace(/\b\w/g, c => c.toUpperCase()) : "").map(([k, arr]) => ({ k, n: arr.length, won: sum(arr, o => o.won), win: pct(sum(arr, o => o.won), decided(arr)), money: money(arr) })).sort((a, b) => b.n - a.n).slice(0, 8);
  const sizes = group(rows, o => o.beds ? (o.beds >= 5 ? "5+ bed" : `${o.beds} bed`) : "").map(([k, arr]) => ({ k, n: arr.length, won: sum(arr, o => o.won), win: pct(sum(arr, o => o.won), decided(arr)), money: money(arr), avg: sum(arr, o => o.won) ? money(arr) / sum(arr, o => o.won) : 0 })).sort((a, b) => a.k.localeCompare(b.k));
  // Price bands (quoted jobs only)
  const BANDS = [[0, 500, "Under £500"], [500, 1000, "£500–£1,000"], [1000, 2000, "£1,000–£2,000"], [2000, 3000, "£2,000–£3,000"], [3000, 1e12, "£3,000+"]];
  const bands = BANDS.map(([lo, hi, k]) => { const arr = rows.filter(o => o.quote > 0 && o.quote >= lo && o.quote < hi); return { k, n: arr.length, won: sum(arr, o => o.won), win: pct(sum(arr, o => o.won), decided(arr)) }; });

  const th = { fontSize: 10.5, fontWeight: 800, color: "#94A4A0", textTransform: "uppercase", letterSpacing: ".04em", padding: "0 0 6px", textAlign: "right", whiteSpace: "nowrap" };
  const td = { fontSize: 13, padding: "7px 0", borderTop: "1px solid #F0F4F3", textAlign: "right", whiteSpace: "nowrap" };
  const Table = ({ cols, rows: rs, first, lead }) => (
    <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 300 }}>
        <thead><tr>{lead && <th style={{ ...th, textAlign: "left", paddingRight: 8 }}>{lead[0]}</th>}<th style={{ ...th, textAlign: "left" }}>{first}</th>{cols.map(c => <th key={c[0]} style={{ ...th, paddingLeft: 10 }}>{c[0]}</th>)}</tr></thead>
        <tbody>{rs.map(r => <tr key={r.k} style={r.hl ? { background: "#F0FAF8" } : null}>{lead && <td style={{ ...td, textAlign: "left", paddingRight: 8, fontWeight: 800, color: TEAL }}>{lead[1](r)}</td>}<td style={{ ...td, textAlign: "left", fontWeight: 700, color: "#10211E", whiteSpace: "normal" }}>{r.k}{r.hl ? " ★" : ""}</td>{cols.map(c => <td key={c[0]} style={{ ...td, paddingLeft: 10, fontWeight: c[2] ? 800 : 500, color: c[2] ? TEAL : "#374151" }}>{c[1](r)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
  const chip = (val, label, cur, set) => <button key={val} type="button" onClick={() => set(val)} style={{ padding: "7px 11px", borderRadius: 99, border: `1.5px solid ${cur === val ? TEAL : "#DDE5E3"}`, background: cur === val ? "#E8F5F3" : "#fff", color: cur === val ? TEAL : "#374151", fontWeight: 700, fontSize: 12.5, cursor: "pointer" }}>{label}</button>;

  return (
    <div>
      <Card>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
          {[["last", "Last month"], ["1m", "This month"], ["3m", "3 months"], ["6m", "6 months"], ["12m", "12 months"], ["ytd", "This year"], ["all", "All time"], ["custom", "Custom dates"]].map(([v, l]) => chip(v, l, period, setPeriod))}
        </div>
        {period === "custom" && (
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            {[["from", "From"], ["to", "To"]].map(([k, l]) => (
              <label key={k} style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#6A7B77", marginBottom: 3 }}>{l}</div>
                <input type="date" value={repCustom[k]} onChange={e => setRepCustom({ ...repCustom, [k]: e.target.value })} style={{ width: "100%", boxSizing: "border-box", padding: "9px 10px", borderRadius: 10, border: "1.5px solid #D9E2E0", background: "#fff", fontSize: 15, color: "#10211E" }} />
              </label>
            ))}
          </div>
        )}
        <div style={{ fontSize: 12, color: "#9CA3AF", marginBottom: 10 }}>
          {from || to ? `${from ? fmtUK(from) : "start"} – ${to ? fmtUK(to) : "no end"}` : "All dates"} · by survey date
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {chip("", "All surveyors", who, setWho)}
          {surveyors.map(s => chip(s, s, who, setWho))}
        </div>
      </Card>

      <ReportPdfButton build={() => ({
        title: "Sales report",
        subtitle: `${from || to ? `${from ? fmtUK(from) : "start"} - ${to ? fmtUK(to) : "no end"}` : "All dates"} (by survey date) · ${who || "All surveyors"} · printed ${fmtUK(todayISO())}`,
        tiles: [["Leads", rows.length], ["Quoted (waiting)", sum(rows, o => o.open)], ["Won", wonN], ["Lost", sum(rows, o => o.lost)], ["Win rate", `${pct(wonN, decided(rows))}%`], ["£ won" + (wonN ? ` (avg ${gbp0(money(rows) / wonN)})` : ""), gbp0(money(rows))]],
        sections: [
          { title: "Lead sources", note: "% = share of leads (not counting ones we didn't quote). Quoted = still waiting. Win % = won / leads quoted. * = best win rate (3+ leads).", head: ["Source", "%", "Leads", "Quoted", "Won", "Lost", "Win %", "£ won"],
            rows: sources.map(r => [r.k + (bestSrc && r.k === bestSrc.k ? " *" : ""), `${pct(r.dq, decided(rows))}%`, r.n, r.open, r.won, r.lost, `${r.win}%`, gbp0(r.money)]) },
          { title: "Conversion funnel", head: ["Stage", "Count", "% of enquiries"],
            rows: [...funnel.map(([l, v]) => [l, v, `${pct(v, rows.length)}%`]), ["Lost", lostN, `${pct(lostN, rows.length)}%`], ["Didn't quote", sum(rows, o => o.notQuoted), `${pct(sum(rows, o => o.notQuoted), rows.length)}%`], ["Quoted (waiting)", sum(rows, o => o.open), `${pct(sum(rows, o => o.open), rows.length)}%`]] },
          ...(!who ? [{ title: "Surveyors", head: ["Surveyor", "Surveys", "Quoted", "Won", "Win %", "Avg quote", "£ won"], rows: survs.map(r => [r.k, r.surveyed, r.open, r.won, `${r.win}%`, gbp0(r.avgQuote), gbp0(r.money)]) }] : []),
          { title: "Why jobs are lost", note: `${lostRows.length} lost in this period`, head: ["Reason (mostly from)", "Lost", "%"], firstFrac: 0.66, rows: reasons.map(r => [`${r.k}${r.srcs ? ` (${r.srcs})` : ""}`, r.n, `${pct(r.n, lostRows.length)}%`]), empty: "None lost, or no reasons recorded." },
          { title: "Why we didn't quote", note: `${nqRows.length} not quoted in this period`, head: ["Reason", "Count", "%"], firstFrac: 0.66, rows: nqReasons.map(r => [r.k, r.n, `${pct(r.n, nqRows.length)}%`]), empty: "None in this period." },
          { title: "Last 12 months", head: ["Month", "Leads", "Won", "Win %"], rows: monthly.map(x => [new Date(x.m + "-01T00:00").toLocaleDateString("en-GB", { month: "long", year: "numeric" }), x.n, x.won, x.n ? `${pct(x.won, x.n)}%` : "-"]) },
          { title: "Areas (top 8 towns moving from)", head: ["Town", "Leads", "Won", "Win %", "£ won"], rows: towns.map(r => [r.k, r.n, r.won, `${r.win}%`, gbp0(r.money)]), empty: "No towns recorded." },
          { title: "Property size", head: ["Size", "Leads", "Won", "Win %", "Avg job"], rows: sizes.map(r => [r.k, r.n, r.won, `${r.win}%`, gbp0(r.avg)]), empty: "No bedroom numbers recorded." },
          { title: "Price bands", head: ["Quote", "Quoted", "Won", "Win %"], rows: bands.map(r => [r.k, r.n, r.won, `${r.win}%`]) },
        ],
      })} />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(100px, 1fr))", gap: 10, marginBottom: 14 }}>
        {[["Leads", rows.length], ["Quoted (waiting)", sum(rows, o => o.open)], ["Won", wonN], ["Lost", sum(rows, o => o.lost)], ["Win rate", `${pct(wonN, decided(rows))}%`], ["£ won", gbp0(money(rows)), wonN ? `avg ${gbp0(money(rows) / wonN)}` : ""]].map(([l, v, sub]) => (
          <div key={l} style={{ background: "#fff", borderRadius: 14, padding: "12px 14px", boxShadow: "0 1px 3px rgba(16,33,30,.06)" }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: "#10211E" }}>{v}</div>
            <div style={{ fontSize: 12, color: "#6A7B77", fontWeight: 600 }}>{l}{sub ? <span style={{ fontWeight: 500 }}> · {sub}</span> : null}</div>
          </div>
        ))}
      </div>

      <Card>
        {head("Lead sources", "% = share of leads in this period (not counting ones we didn't quote). Quoted = quotes still waiting for an answer. Win % = won ÷ leads (leads we didn't quote aren't counted). ★ = best win rate (3+ leads). £ won by source is in the bars below.")}
        {!sources.length ? <div style={{ fontSize: 13, color: "#9CA3AF" }}>No enquiries in this period.</div> : <>
          <Table first="Source" lead={["%", r => `${pct(r.dq, decided(rows))}%`]} rows={sources.map(s => ({ ...s, hl: bestSrc && s.k === bestSrc.k }))} cols={[["Leads", r => r.n], ["Quoted", r => r.open], ["Won", r => r.won], ["Lost", r => r.lost], ["Win %", r => `${r.win}%`, true]]} />
          <div style={{ marginTop: 12 }}>{sources.map(s => <div key={s.k} style={{ display: "grid", gridTemplateColumns: "110px 1fr 70px", gap: 8, alignItems: "center", fontSize: 12, marginBottom: 6 }}><span style={{ color: "#374151", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.k}</span><Bar v={s.money} max={topMoney} /><span style={{ textAlign: "right", color: "#6A7B77" }}>{gbp0(s.money)}</span></div>)}</div>
          {rows.some(o => o.notQuoted) && <div style={{ fontSize: 12, color: "#6A7B77", marginTop: 8 }}>{sum(rows, o => o.notQuoted)} lead{sum(rows, o => o.notQuoted) !== 1 ? "s" : ""} marked "Didn't quote" — left out of the win %.</div>}
          {sources.some(s => s.k === "Not recorded") && <div style={{ fontSize: 12, color: "#B45309", marginTop: 8 }}>"Not recorded" = enquiries with no Referred by. New enquiries now have to have one.</div>}
        </>}
      </Card>

      <Card>
        {head("Conversion funnel", "How many leads make it to each stage.")}
        {funnel.map(([l, v], i) => (
          <div key={l} style={{ marginBottom: 9 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 3 }}>
              <span style={{ fontWeight: 700, color: "#10211E" }}>{l}</span>
              <span style={{ color: "#6A7B77" }}><b style={{ color: "#10211E" }}>{v}</b>{i > 0 ? ` · ${pct(v, funnel[i - 1][1])}% of ${funnel[i - 1][0].toLowerCase()}` : ""}</span>
            </div>
            <Bar v={v} max={Math.max(1, funnel[0][1])} color={i === 3 ? "#059669" : TEAL} />
          </div>
        ))}
        <div style={{ marginTop: 4, paddingTop: 9, borderTop: "1px solid #F0F4F3" }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 3 }}>
            <span style={{ fontWeight: 700, color: "#B91C1C" }}>Lost</span>
            <span style={{ color: "#6A7B77" }}><b style={{ color: "#10211E" }}>{lostN}</b> · {pct(lostN, funnel[2][1])}% of quotes given</span>
          </div>
          <Bar v={lostN} max={Math.max(1, funnel[0][1])} color="#DC2626" />
          {(() => { const nq = sum(rows, o => o.notQuoted); return nq ? (
            <div style={{ marginTop: 9 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 3 }}>
                <span style={{ fontWeight: 700, color: "#6B7280" }}>Didn't quote</span>
                <span style={{ color: "#6A7B77" }}><b style={{ color: "#10211E" }}>{nq}</b> · not counted in win %</span>
              </div>
              <Bar v={nq} max={Math.max(1, funnel[0][1])} color="#9CA3AF" />
            </div>) : null; })()}
          {(() => { const waiting = sum(rows, o => o.open); return (
            <div style={{ marginTop: 9 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 3 }}>
                <span style={{ fontWeight: 700, color: "#B45309" }}>Quoted (waiting)</span>
                <span style={{ color: "#6A7B77" }}><b style={{ color: "#10211E" }}>{waiting}</b> · {pct(waiting, funnel[2][1])}% of quotes given</span>
              </div>
              <Bar v={waiting} max={Math.max(1, funnel[0][1])} color="#F59E0B" />
            </div>); })()}
        </div>
      </Card>

      {!who && <Card>
        {head("Surveyors", "Average quote: " + (survs.map(s => `${s.k.split(" ")[0]} ${gbp0(s.avgQuote)}`).join(" · ") || "—"))}
        {!survs.length ? <div style={{ fontSize: 13, color: "#9CA3AF" }}>No surveys with a surveyor in this period.</div>
          : <Table first="Surveyor" rows={survs} cols={[["Surveys", r => r.surveyed], ["Quoted", r => r.open], ["Won", r => r.won], ["Win %", r => `${r.win}%`, true], ["£ won", r => gbp0(r.money), true]]} />}
      </Card>}

      <Card>
        {head("Why jobs are lost", `${lostRows.length} lost in this period`)}
        {!reasons.length ? <div style={{ fontSize: 13, color: "#9CA3AF" }}>None lost — or no reasons recorded.</div> : reasons.map(r => (
          <div key={r.k} style={{ marginBottom: 9 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 3, gap: 8 }}>
              <span style={{ fontWeight: 700, color: "#10211E" }}>{r.k}</span>
              <span style={{ color: "#6A7B77", textAlign: "right" }}><b style={{ color: "#10211E" }}>{r.n}</b> · {pct(r.n, lostRows.length)}%</span>
            </div>
            <Bar v={r.n} max={Math.max(1, reasons[0].n)} color="#DC2626" />
            <div style={{ fontSize: 11.5, color: "#9CA3AF", marginTop: 2 }}>Mostly from: {r.srcs}</div>
          </div>
        ))}
      </Card>

      <Card>
        {head("Why we didn't quote", `${nqRows.length} not quoted in this period`)}
        {!nqReasons.length ? <div style={{ fontSize: 13, color: "#9CA3AF" }}>None in this period.</div> : nqReasons.map(r => (
          <div key={r.k} style={{ marginBottom: 9 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 3, gap: 8 }}>
              <span style={{ fontWeight: 700, color: "#10211E" }}>{r.k}</span>
              <span style={{ color: "#6A7B77" }}><b style={{ color: "#10211E" }}>{r.n}</b> · {pct(r.n, nqRows.length)}%</span>
            </div>
            <Bar v={r.n} max={Math.max(1, nqReasons[0].n)} color="#6B7280" />
          </div>
        ))}
      </Card>

      <Card>
        {head("Last 12 months", "Leads (grey) and won (green) each month.")}
        <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 120 }}>
          {monthly.map(x => (
            <div key={x.m} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", height: "100%" }}>
              <div style={{ fontSize: 10, color: "#6A7B77", marginBottom: 2 }}>{x.n || ""}</div>
              <div style={{ width: "100%", maxWidth: 26, height: `${Math.round((x.n / maxMonth) * 90)}%`, minHeight: x.n ? 3 : 0, background: "#D5DEDC", borderRadius: "4px 4px 0 0", position: "relative" }}>
                <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: x.n ? `${Math.round((x.won / x.n) * 100)}%` : 0, background: "#059669", borderRadius: x.won === x.n ? "4px 4px 0 0" : 0 }} />
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 4, marginTop: 4 }}>{monthly.map(x => <div key={x.m} style={{ flex: 1, textAlign: "center", fontSize: 10, color: "#94A4A0" }}>{new Date(x.m + "-01T00:00").toLocaleDateString("en-GB", { month: "short" }).slice(0, 1)}</div>)}</div>
      </Card>

      <Card>
        {head("Areas", "Top 8 towns customers are moving from.")}
        {!towns.length ? <div style={{ fontSize: 13, color: "#9CA3AF" }}>No towns recorded.</div>
          : <Table first="Town" rows={towns} cols={[["Leads", r => r.n], ["Won", r => r.won], ["Win %", r => `${r.win}%`, true], ["£ won", r => gbp0(r.money)]]} />}
      </Card>

      <Card>
        {head("Property size")}
        {!sizes.length ? <div style={{ fontSize: 13, color: "#9CA3AF" }}>No bedroom numbers recorded.</div>
          : <Table first="Size" rows={sizes} cols={[["Leads", r => r.n], ["Won", r => r.won], ["Win %", r => `${r.win}%`, true], ["Avg job", r => gbp0(r.avg)]]} />}
      </Card>

      <Card>
        {head("Price bands", "Win rate by quote price.")}
        <Table first="Quote" rows={bands} cols={[["Quoted", r => r.n], ["Won", r => r.won], ["Win %", r => `${r.win}%`, true]]} />
      </Card>
    </div>
  );
}

// Fetch the newest version: ask the service worker to update, clear its cached files,
// then reload. Customer data is kept (it lives separately, and unsynced changes are uploaded first).
async function updateAppNow(setMsg) {
  // A clean update: save first, then drop the stored copy of the app completely and load a
  // fresh one from the website. (Clearing half of it while the old copy was still in charge is
  // what could leave a blank screen on the iPhone.)
  try {
    setMsg && setMsg("Checking…");
    try { await Promise.race([pushChangedOnly(loadData()), new Promise(r => setTimeout(r, 6000))]); } catch {}
    setMsg && setMsg("Updating…");
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister().catch(() => {})));
    }
    if (window.caches) { const keys = await caches.keys(); await Promise.all(keys.map(k => caches.delete(k).catch(() => {}))); }
  } catch { /* load the fresh copy anyway */ }
  setTimeout(() => window.location.replace("/?fresh=" + Date.now()), 300);
}
// If a part of the app that loads later (e.g. the PDF viewer) has gone after an update, reload once.
if (typeof window !== "undefined") {
  window.addEventListener("vite:preloadError", (e) => {
    try { if (sessionStorage.getItem("removals_chunk_reload")) return; sessionStorage.setItem("removals_chunk_reload", "1"); } catch { return; }
    e.preventDefault(); window.location.reload();
  });
}
// ── "New version available" notice ───────────────────────────────────────────
// Every few minutes (and when the app comes back to the front) it quietly checks the
// live site. If the app's code file has changed since this copy loaded, a bar appears.
function currentScriptName() {
  const sc = Array.from(document.querySelectorAll("script[type=module][src]")).map(x => x.getAttribute("src")).find(x => /\/assets\/index-.*\.js/.test(x || ""));
  return sc ? sc.split("/").pop() : "";
}
async function newVersionWaiting() {
  const mine = currentScriptName();
  if (!mine) return false; // running the developer preview, nothing to compare
  try {
    const r = await fetch(`/index.html?v=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) return false;
    const m = (await r.text()).match(/\/assets\/(index-[^"']+\.js)/);
    return !!(m && m[1] !== mine);
  } catch { return false; }
}
function UpdateNotice() {
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState("");
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    let alive = true;
    const check = async () => { if (alive && !document.hidden && await newVersionWaiting() && alive) setReady(true); };
    const t0 = setTimeout(check, 4000);
    const iv = setInterval(check, 5 * 60 * 1000);
    const onVis = () => { if (!document.hidden) check(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { alive = false; clearTimeout(t0); clearInterval(iv); document.removeEventListener("visibilitychange", onVis); };
  }, []);
  if (!ready || hidden) return null;
  return (
    <div style={{ position: "fixed", left: 12, right: 12, bottom: "calc(env(safe-area-inset-bottom, 0px) + 78px)", zIndex: 9000, maxWidth: 520, margin: "0 auto", background: "#0F2E2A", color: "#fff", borderRadius: 14, padding: "11px 12px 11px 16px", display: "flex", alignItems: "center", gap: 10, boxShadow: "0 8px 24px rgba(0,0,0,.25)" }}>
      <div style={{ flex: 1, fontSize: 14, fontWeight: 700 }}>✨ A new version of the app is ready</div>
      <button type="button" onClick={() => updateAppNow(setBusy)} disabled={!!busy} style={{ background: "#14B8A6", color: "#fff", border: "none", borderRadius: 10, padding: "9px 14px", fontWeight: 800, fontSize: 14, cursor: "pointer" }}>{busy || "Update"}</button>
      <button type="button" onClick={() => setHidden(true)} aria-label="Later" style={{ background: "none", border: "none", color: "#A7C4BF", fontSize: 20, lineHeight: 1, cursor: "pointer", padding: "0 2px" }}>×</button>
    </div>
  );
}
function UpdateButton({ style }) {
  const [msg, setMsg] = useState("");
  return <Btn size="sm" variant="grey" style={style} disabled={!!msg} onClick={() => updateAppNow(setMsg)}>{msg || "↻ Update app"}</Btn>;
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
  async function doRestore(inc, source) {
    if (!inc || (!inc.customers && !inc.enquiries && !inc.jobs && !inc.staff && !inc.vehicles)) {
      alert("This doesn't look like a Removals CRM backup."); return;
    }
    const isMover = source === "Mover import";
    let extra = "";
    if (isMover) {
      const prep = prepareMoverImport(data, inc);
      inc = prep.inc;
      if (prep.skipped.length) extra += `\n\n${prep.skipped.length} already in the app (same phone or email) will be skipped: ${prep.skipped.slice(0, 12).join(", ")}${prep.skipped.length > 12 ? "…" : ""}`;
      if (prep.refsCleared) extra += `\n\n${prep.refsCleared} reference number(s) are already used here, so those customers will get new numbers.`;
    }
    const counts = ["customers", "enquiries", "jobs", "vehicles", "staff"].map(t => `${(inc[t] || []).length} ${t}`).join(", ");
    if (!confirm(`${isMover ? "Import from Mover?" : "Restore this backup?"}\n\nIt contains: ${counts}.${extra}\n\nMatching records are added or updated. Nothing already on the device is deleted.`)) return;
    setRestoring(true);
    if (isMover) {
      // Next new customer number = one after the highest number in the app + the import.
      const all = [...(data.customers || []), ...(inc.customers || [])].map(c => Number(c.ref)).filter(n => n > 0 && n < 1e6);
      if (all.length) {
        const next = Math.max(...all) + 1;
        try { await setCustomerRefStart(next); try { sessionStorage.setItem("importRefMsg", String(next)); } catch {} }
        catch (e) { alert(`Imported records are going in, but the next reference number couldn't be set (${(e && e.message) || e}). Set it to ${next} on the Company page.`); }
      }
    }
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
      await doRestore(payload && payload.data ? payload.data : payload, payload && payload.source);
    } catch (err) { alert("Couldn't read that file: " + ((err && err.message) || err)); }
  }
  async function onRestorePaste() {
    let payload;
    try { payload = JSON.parse(pasteText.trim()); }
    catch { alert("That isn't valid backup text. Open your backup file, Select All, Copy, then paste it here."); return; }
    await doRestore(payload && payload.data ? payload.data : payload, payload && payload.source);
  }
  async function onWipe() {
    const nc = (data.customers || []).length, ne = (data.enquiries || []).length, nj = (data.jobs || []).length;
    if (nc + ne + nj === 0) {
      if (!confirm("There's nothing on this device to delete.\n\nClear any old customers, enquiries and jobs still showing on your other phones and iPads?")) return;
      setWiping(true);
      try { await wipeBusinessData(data); } catch (err) { setWiping(false); alert("Failed: " + ((err && err.message) || err)); }
      return;
    }
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
      <h2 className="rm-page-title" style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 800, color: "#10211E" }}>Company</h2>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: "#6A7B77" }}>Your fleet and team · <span style={{ color: TEAL, fontWeight: 700 }}>build {BUILD_LABEL}</span></div>
        <UpdateButton />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 14 }} className="rm-company-grid">
        <Btn style={{ width: "100%", marginBottom: 0 }} onClick={() => setView({ screen: "reports" })}>📊 Reports — where leads come from &amp; what wins</Btn>
        {LOGINS_ENABLED && <AccountCard />}
        <HistoryList title="Activity log (all changes)" />
        {isAdmin() && <RecentlyDeleted />}
        {LOGINS_ENABLED && isAdmin() && <UsersAdmin data={data} />}
        <Card style={{ marginBottom: 0 }}>
          <h4 style={{ margin: "0 0 2px", fontSize: 12, textTransform: "uppercase", letterSpacing: ".06em", color: "#94A4A0", fontWeight: 800 }}>Sync</h4>
          <SyncControl data={data} setData={setData} />
          {isAdmin() && <OrphanCleanup data={data} setData={setData} />}
          {isAdmin() && <DuplicateCleanup data={data} setData={setData} />}
        </Card>
{isAdmin() && (
        <Card style={{ marginBottom: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ minWidth: 0 }}>
              <h4 style={{ margin: "0 0 3px", fontSize: 12, textTransform: "uppercase", letterSpacing: ".06em", color: "#94A4A0", fontWeight: 800 }}>Item catalogue</h4>
              <div style={{ fontSize: 13, color: "#6A7B77" }}>Edit room items, volumes & weights. Syncs to all devices.</div>
            </div>
            <Btn size="sm" onClick={() => setView({ screen: "catalogue" })}>Edit</Btn>
          </div>
        </Card>
        )}

        <Card style={{ marginBottom: 0 }}>
          <h4 style={{ margin: "0 0 8px", fontSize: 12, textTransform: "uppercase", letterSpacing: ".06em", color: "#94A4A0", fontWeight: 800 }}>Tablet layout</h4>
          <div style={{ fontSize: 13, color: "#6A7B77", lineHeight: 1.5, marginBottom: 10 }}>Trial the compact iPhone-style layout on iPad. Turn it off any time to go back to the normal tablet layout.</div>
          {(() => { const on = (() => { try { return localStorage.getItem("removals_force_phone") === "1"; } catch { return false; } })();
            return <Btn variant={on ? "primary" : "grey"} onClick={() => { try { if (on) localStorage.removeItem("removals_force_phone"); else localStorage.setItem("removals_force_phone", "1"); } catch {} window.location.reload(); }}>{on ? "Compact layout ON — tap to revert" : "Use iPhone layout on this device"}</Btn>;
          })()}
        </Card>

{isAdmin() && (
        <Card style={{ marginBottom: 0 }}>
          <h4 style={{ margin: "0 0 8px", fontSize: 12, textTransform: "uppercase", letterSpacing: ".06em", color: "#94A4A0", fontWeight: 800 }}>Customer reference numbers</h4>
          <div style={{ fontSize: 13, color: "#6A7B77", lineHeight: 1.5 }}>Reference numbers are now assigned automatically by the cloud when a new customer syncs — so they can't clash, even if two devices add customers offline at the same time. A new customer added offline shows no number until it reconnects.</div>
          <RefStartControl data={data} />
        </Card>
        )}

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
                  // Show the BOOKED day (what the calendar shows); if nothing's booked, the due date.
                  const today = todayISO();
                  const items = [["Service", nextService(v.maint)], ["MOT", nextMOT(v.maint)], ["Tacho", nextTacho(v.maint)]].filter(x => x[1]).map(([label, due]) => {
                    const bk = ((v.maint && v.maint.bookings) || []).filter(b => b.type === label && bookingEnd(b) >= today).sort((a, b) => a.start.localeCompare(b.start))[0];
                    return [label, bk ? bk.start : due, !!bk, bk];
                  });
                  if (!items.length) return null;
                  const soon = (iso, booked) => { const days = Math.round((new Date(iso + "T00:00") - new Date()) / 86400000); return (!booked && days < 0) ? "#DC2626" : days <= 14 ? "#B45309" : "#9CA3AF"; };
                  return <div style={{ fontSize: 11.5, marginTop: 3, display: "flex", flexWrap: "wrap", gap: 8 }}>{items.map(([label, d, booked, bk]) => <span key={label} style={{ color: soon(d, booked) }}>{label}: {booked ? (bk.days > 1 ? `${shortDay(bk.start)}–${shortDay(bookingEnd(bk))}` : shortDay(d)) : `${fmtUK(d)}${d < today ? " overdue" : ""}`}</span>)}</div>;
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

{isAdmin() && (
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
      )}

{isAdmin() && (
      <Card style={{ marginBottom: 0, marginTop: 14, border: "1px solid #FECACA", background: "#FEF2F2" }}>
        <h4 style={{ margin: "0 0 6px", fontSize: 12, textTransform: "uppercase", letterSpacing: ".06em", color: "#DC2626", fontWeight: 800 }}>Danger zone</h4>
        <div style={{ fontSize: 13, color: "#7F1D1D", marginBottom: 12, lineHeight: 1.5 }}>
          Permanently delete every customer, enquiry and job. Your staff and vehicles are kept. <b>Download a backup first.</b>
        </div>
        <Btn variant="ghost" onClick={onWipe} disabled={wiping} style={{ color: "#DC2626", borderColor: "#FCA5A5", width: "100%" }}>{wiping ? "Deleting…" : "Delete all customers, enquiries & jobs"}</Btn>
      </Card>
      )}

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
  const [m, setM] = useState({ serviceWeeks: m0.serviceWeeks ?? defWeeks(v.vtype || ""), serviceLast: m0.serviceLast || "", motLast: m0.motLast || "", motDays: m0.motDays ?? (/18/.test(v.vtype || "") ? 3 : 1), tachoLast: m0.tachoLast || "", bookings: Array.isArray(m0.bookings) ? m0.bookings : [], skipped: Array.isArray(m0.skipped) ? m0.skipped : [] });
  // Keep the automatic bookings in step as Last done / intervals change.
  useEffect(() => { setM(p => autoMaint(p, todayISO())); }, [m.serviceLast, m.serviceWeeks, m.motLast, m.motDays, m.tachoLast]);
  const set = (k, val) => setF(p => ({ ...p, [k]: val }));
  const setMv = (k, val) => setM(p => ({ ...p, [k]: val }));
  const book = (type, start0, days) => {
    if (!start0) { alert("Set the last-done date first so a due date can be worked out."); return; }
    const start = start0 < todayISO() ? (type === "MOT" ? workdayAdd(nextWeekday(todayISO()), Math.max(1, Number(days) || 1) - 1) : todayISO()) : start0; // overdue: book from today
    if (type === "MOT") { const nb = motBooking(start, days); setM(p => ({ ...p, bookings: [...p.bookings.filter(b => !(b.type === "MOT" && (b.motDate || bookingEnd(b)) === nb.motDate)), nb] })); return; }
    const snapped = type === "Service" ? nearestDow(start, 2) : nextWeekday(start);
    setM(p => ({ ...p, bookings: [...p.bookings.filter(b => !(b.type === type && b.start === snapped)), { id: uid(), type, start: snapped, days: Math.max(1, Number(days) || 1) }] }));
  };
  const editBooking = (id, k, val) => setM(p => ({ ...p, bookings: p.bookings.map(b => {
    if (b.id !== id) return b;
    if (b.type === "MOT" && (k === "motDate" || k === "days")) {
      const test = k === "motDate" ? val : (b.motDate || bookingEnd(b));
      if (!test) return { ...b, [k]: val, auto: false };
      return { ...motBooking(test, k === "days" ? val : b.days, b.id), auto: false };
    }
    return { ...b, [k]: k === "days" ? Math.max(1, Number(val) || 1) : val, auto: false };
  }) }));
  const unbook = id => setM(p => {
    const b = p.bookings.find(x => x.id === id);
    const due = b ? maintDue(p, b.type) : "";
    const skipped = b && b.auto && due ? [...(p.skipped || []).filter(k => !k.startsWith(b.type + "|")), b.type + "|" + due] : (p.skipped || []);
    return { ...p, bookings: p.bookings.filter(x => x.id !== id), skipped };
  });
  const nS = nextService(m), nM = nextMOT(m), nT = nextTacho(m);
  const inp = { width: "100%", padding: "9px 10px", border: "1px solid #D9E2E0", borderRadius: 9, fontSize: 14, boxSizing: "border-box", background: "#fff" };

  async function save() {
    if (!f.reg.trim() && !f.vtype) { alert("Add a registration or a type so you can tell vehicles apart."); return; }
    const label = [f.vtype, f.reg.trim()].filter(Boolean).join(" · ") || "Vehicle";
    const maint = autoMaint({ serviceWeeks: Number(m.serviceWeeks) || 0, serviceLast: m.serviceLast || "", motLast: m.motLast || "", motDays: Number(m.motDays) || 1, tachoLast: m.tachoLast || "", bookings: m.bookings || [], skipped: m.skipped || [] }, todayISO());
    const rec = { id: v.id || uid(), name: label, reg: f.reg.trim(), vtype: f.vtype, capacityCuFt: Number(f.capacityCuFt) || 0, maint, createdAt: v.createdAt || new Date().toISOString() };
    await saveAndReload(upsertLocal(data, "vehicles", rec));
  }
  async function del() {
    if (!confirm("Delete this vehicle?")) return;
    addTombstone(v.id); SAVING_IN_PROGRESS = true; showSavingOverlay();
    try { await deleteRecord("vehicles", v.id); } catch (err) { alert("Removed from this device, but the cloud copy couldn't be deleted yet — the app will retry when it next syncs.\n\n" + ((err && err.message) || "")); }
    const d2 = { ...data, vehicles: (data.vehicles || []).filter(x => x.id !== v.id) };
    setDB(JSON.stringify(d2)); SAVING_IN_PROGRESS = false; window.location.reload();
  }

  const DueRow = ({ label, type, last, onLast, due, days, onBook, extra }) => {
    const today = todayISO();
    const next = (m.bookings || []).filter(b => b.type === type && bookingEnd(b) >= today).sort((a, b) => a.start.localeCompare(b.start))[0];
    return (
    <div style={{ borderTop: "1px solid #EEF3F2", paddingTop: 10, marginTop: 10 }}>
      <div style={{ fontWeight: 700, fontSize: 13.5, color: "#10211E", marginBottom: 6 }}>{label}</div>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 130 }}><div style={{ fontSize: 12, color: "#6A7B77", marginBottom: 3 }}>Last done</div><input type="date" value={last} onChange={e => onLast(e.target.value)} style={inp} /></div>
        {extra}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8, gap: 8 }}>
        <div style={{ fontSize: 12.5, color: !due ? "#9CA3AF" : (!next && due < today) ? "#B91C1C" : "#0F766E" }}>
          {!due ? "Set last done and it books itself" : next ? <>Booked: <b>{bookingDates(next).map(shortDay).join(", ")}</b>{next.auto ? " (auto)" : ""}</> : due < today ? <>Overdue since <b>{fmtUK(due)}</b></> : <>Next due: <b>{fmtUK(due)} ({dow(due)})</b></>}
        </div>
        {due && !next && <Btn size="sm" variant="grey" onClick={() => onBook(due, days)}>Book {days} day{days !== 1 ? "s" : ""} out</Btn>}
      </div>
    </div>
    );
  };

  return (
    <Modal title={v.id ? "Edit Vehicle" : "Add Vehicle"} onClose={onClose}>
      <Field label="Type"><Select value={f.vtype} onChange={x => { set("vtype", x); if (!m.serviceWeeks) setMv("serviceWeeks", defWeeks(x)); if (m.motDays == null) setMv("motDays", /18/.test(x) ? 3 : 1); }} options={VEHICLE_TYPES} placeholder="Select…" /></Field>
      <Field label="Reg / plate"><Input value={f.reg} onChange={x => set("reg", x)} placeholder="e.g. WX19 ABC" /></Field>
      <Field label="Capacity (cu ft)" hint="Roughly how much it holds"><Input type="number" value={f.capacityCuFt} onChange={x => set("capacityCuFt", x)} placeholder="e.g. 600" /></Field>

      <div style={{ marginTop: 10, borderTop: "1px solid #EEF3F2", paddingTop: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".06em", color: "#94A4A0", marginBottom: 4 }}>Servicing & maintenance</div>
        <div style={{ fontSize: 12, color: "#9CA3AF", marginBottom: 6 }}>Set the Last done dates and the next service, MOT and tacho book themselves. Once a booked date has passed it counts as done and the next one is booked. Change a date if the garage gives you a different one.</div>

        <Field label="Service interval (weeks)" hint="e.g. 18t = 6, 3.5t = 26"><Input type="number" value={m.serviceWeeks} onChange={x => setMv("serviceWeeks", x)} placeholder="weeks" /></Field>
        {DueRow({ type: "Service", label: "Service — Tuesdays", last: m.serviceLast, onLast: x => setMv("serviceLast", x), due: nS, days: 1, onBook: (due, days) => book("Service", due, days) })}
        {DueRow({ type: "MOT", label: `MOT — garage has it ${Math.max(0, (Number(m.motDays) || 1) - 1)} working day${(Number(m.motDays) || 1) - 1 === 1 ? "" : "s"} before the test (weekdays only)`, last: m.motLast, onLast: x => setMv("motLast", x), due: nM, days: Number(m.motDays) || 1, onBook: (due, days) => book("MOT", due, days),
          extra: <div style={{ width: 92 }}><div style={{ fontSize: 12, color: "#6A7B77", marginBottom: 3 }}>Days out</div><input type="number" value={m.motDays} onChange={e => setMv("motDays", e.target.value)} style={inp} /></div> })}
        {DueRow({ type: "Tacho", label: "Tacho — weekdays (every 2 years)", last: m.tachoLast, onLast: x => setMv("tachoLast", x), due: nT, days: 1, onBook: (due, days) => book("Tacho", due, days) })}

        {m.bookings.some(b => bookingEnd(b) >= todayISO()) && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#6A7B77", marginBottom: 6 }}>Booked out</div>
            {m.bookings.filter(b => bookingEnd(b) >= todayISO()).sort((a, b) => (a.start || "").localeCompare(b.start || "")).map(b => (
              <div key={b.id} style={{ padding: "8px 0", borderBottom: "1px solid #F0F4F3" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#10211E" }}>{b.type} <span style={{ color: "#6A7B77", fontWeight: 600 }}>· {bookingDates(b).map(shortDay).join(", ")}{b.type === "MOT" ? ` (test ${dow(b.motDate || bookingEnd(b))})` : ""}</span></div>
                  <button onClick={() => unbook(b.id)} style={{ background: "none", border: "none", color: "#C0605A", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Remove</button>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                  {b.type === "MOT"
                    ? <div style={{ flex: 1 }}><div style={{ fontSize: 11, color: "#94A4A0", marginBottom: 3 }}>MOT test date</div><input type="date" value={b.motDate || bookingEnd(b)} onChange={e => editBooking(b.id, "motDate", e.target.value)} style={inp} /></div>
                    : <div style={{ flex: 1 }}><div style={{ fontSize: 11, color: "#94A4A0", marginBottom: 3 }}>Date</div><input type="date" value={b.start} onChange={e => editBooking(b.id, "start", e.target.value)} style={inp} /></div>}
                  <div style={{ width: 80 }}><div style={{ fontSize: 11, color: "#94A4A0", marginBottom: 3 }}>Days</div><input type="number" value={b.days} onChange={e => editBooking(b.id, "days", e.target.value)} style={inp} /></div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
        {v.id && canDelete() && <Btn variant="danger" onClick={del}><Icon name="trash" size={14} /></Btn>}
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
    try { await deleteRecord("staff", s.id); } catch (err) { alert("Removed from this device, but the cloud copy couldn't be deleted yet — the app will retry when it next syncs.\n\n" + ((err && err.message) || "")); }
    const d2 = { ...data, staff: (data.staff || []).filter(x => x.id !== s.id) };
    setDB(JSON.stringify(d2)); SAVING_IN_PROGRESS = false; window.location.reload();
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
        {s.id && canDelete() && <Btn variant="danger" onClick={del}><Icon name="trash" size={14} /></Btn>}
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
// A provisional move with no dates yet shows as "No date provisional" everywhere.
const jobUndated = j => !!j && !j.moveDate && !jobStages(j).some(st => st && st.date);
function jobBadge(j) {
  if (!j) return "";
  const st = (j.status === "Booked" || j.status === "In Progress") ? "Confirmed" : j.status;
  return st === "Provisional" && jobUndated(j) ? "No date provisional" : st;
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
  // Hooks must run the same way every time, so the "not found" check sits outside the screen itself.
  const j = (data.jobs || []).find(x => x.id === id);
  if (!j) return <div style={{ padding: 20 }}>Move not found.</div>;
  return <JobDetailScreen key={id} data={data} j={j} setView={setView} />;
}
function JobDetailScreen({ data, j, setView }) {
  const customer = (data.customers || []).find(c => c.id === j?.customerId);
  const [f, setF] = useState({
    stages: jobStages(j).map(st => ({ id: st.id && st.id !== "legacy" ? st.id : uid(), type: st.type || "Move", date: st.date || "", time: st.time || "", vehicleIds: st.vehicleIds || [], crew: st.crew || [], notes: st.notes || "" })),
    price: j.price || 0, deposit: j.deposit || 0,
    depositPaid: j.depositPaid || false, balancePaid: j.balancePaid || false,
    status: (j.status === "Booked" || j.status === "In Progress") ? "Confirmed" : (j.status || "Confirmed"), notes: j.notes || "",
  });
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const [confirming, setConfirming] = useState(false);
  const [crewPreview, setCrewPreview] = useState(false);
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
  const [shortWarn, setShortWarn] = useState(null);
  async function save(force) {
    if (maintClash()) return;
    if (!force && j && ["Confirmed", "Booked", "In Progress"].includes(f.status)) {
      const short = shortDays(f.stages || [], jobStages(j));
      if (short.length) { setShortWarn(short); return; }
    }
    await saveAndReload(upsertLocal(data, "jobs", buildRec()));
  }
  async function completeMove() { await saveAndReload(upsertLocal(data, "jobs", buildRec({ status: "Completed", balancePaid: true }))); }
  async function letGo() {
    if (!confirm("Let this move go?\n\nIt'll be kept for your records but removed from the calendar, availability and upcoming moves. You can reinstate it later.")) return;
    let d = upsertLocal(data, "jobs", buildRec({ status: "Let Go" }));
    const enq = (data.enquiries || []).find(x => x.id === j.enquiryId);
    if (enq) d = upsertLocal(d, "enquiries", { ...enq, status: "Let Go" });
    await saveAndReload(d);
  }
  async function reinstate() {
    let d = upsertLocal(data, "jobs", buildRec({ status: "Provisional" }));
    const enq = (data.enquiries || []).find(x => x.id === j.enquiryId);
    if (enq && enq.status === "Let Go") d = upsertLocal(d, "enquiries", { ...enq, status: "Won" });
    await saveAndReload(d);
  }
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
    setDB(JSON.stringify(d2));
    SAVING_IN_PROGRESS = false; setView({ screen: "enquiries", filter: "Won" }); window.location.reload();
  }
  const balance = (Number(f.price) || 0) - (Number(f.deposit) || 0);
  const vehOpts = (data.vehicles || []).map(v => ({ id: v.id, label: [v.name, v.reg].filter(Boolean).join(" · ") }));
  const crewOpts = (data.staff || []).filter(s => s.active !== false).map(s => ({ id: s.name, label: s.name }));

  return (
    <div>
      <button onClick={() => setView({ screen: "enquiries", filter: "Won" })} style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "#fff", border: "1.5px solid #D3DDDB", borderRadius: 10, padding: "10px 16px", fontSize: 15.5, fontWeight: 800, color: NAVY, cursor: "pointer" }}><Icon name="back" size={16} /> Back</button>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "14px 0 8px" }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 800, color: TEAL_D, letterSpacing: ".02em" }}>{moveRef(data, j)}{volText(data, j) ? <span style={{ color: "#41514E" }}> · 📦 {volText(data, j)}</span> : null}</div>
          <h2 style={{ margin: "2px 0 0", fontSize: 20, fontWeight: 800, color: "#111827" }}>{custName(data, j.customerId)}</h2>
        </div>
        <StatusBadge status={jobBadge(f)} />
      </div>
      {customer && (
        <div style={{ ...contactRowStyle(1 + !!customer.phone + !!customer.email), marginBottom: 12 }}>
          {customer.phone && <Btn variant="primary" style={contactBtn} onClick={() => window.location.href = `tel:${customer.phone}`}>📞 Call</Btn>}
          <MessageButton size="md" variant="primary" style={contactBtn} customer={customer} ctx={{ ref: moveRef(data, j), date: j.moveDate ? fmtDate(j.moveDate) : "", time: (jobStages(j)[0]?.time) || j.startTime || "", price: gbp(j.price), deposit: gbp(j.deposit), balance: gbp((Number(j.price) || 0) - (Number(j.deposit) || 0)) }} />
          {customer.email && <Btn variant="primary" style={contactBtn} onClick={() => window.location.href = `mailto:${customer.email}`}>✉️ Email</Btn>}
        </div>
      )}
      {customer && <OtherContacts customer={customer} onLog={en => logComm(customer.id, en)} />}
      <div style={{ marginBottom: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
        {customer && j.enquiryId && <Btn size="sm" variant="grey" onClick={() => setView({ screen: "enquiryDetail", id: j.enquiryId })}>View enquiry</Btn>}
        <Btn size="sm" variant="grey" onClick={() => setCrewPreview(true)}>👷 Crew view</Btn>
      </div>
      {crewPreview && <CrewPreviewModal data={data} job={j} onClose={() => setCrewPreview(false)} />}

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

      {shortWarn && <ShortBanner list={shortWarn} onBack={() => setShortWarn(null)} onSave={() => { setShortWarn(null); save(true); }} />}
      <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
        {canDelete() && <Btn variant="danger" onClick={del}><Icon name="trash" size={14} /></Btn>}
        <Btn style={{ flex: 1 }} onClick={() => save()}><Icon name="check" size={16} /> Save move</Btn>
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
      {["Provisional", "Confirmed"].includes(f.status) && (
        <Btn variant="grey" style={{ width: "100%", marginTop: 10 }} onClick={letGo}>Let this move go</Btn>
      )}
      {f.status === "Let Go" && (
        <>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#6B7280", background: "#F3F4F6", border: "1px solid #E5E7EB", borderRadius: 9, padding: "10px 12px", marginTop: 10 }}>This move has been let go — kept for your records but hidden from the calendar, availability and upcoming moves.</div>
          <Btn variant="primary" style={{ width: "100%", marginTop: 10 }} onClick={reinstate}>Reinstate move</Btn>
        </>
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
  // What to show — pick any mix of moves / surveys / servicing (remembered on this device)
  const CAL_TYPES = [["moves", "🚚 Moves"], ["surveys", "📋 Surveys"], ["servicing", "🔧 Servicing"]];
  const [types, setTypes] = useState(() => {
    if (initialShow && ["moves", "surveys", "servicing"].includes(initialShow)) return [initialShow];
    try { const t = JSON.parse(localStorage.getItem("removals_cal_types") || "null"); if (Array.isArray(t) && t.length) return t; } catch {}
    return ["moves", "surveys", "servicing"];
  });
  const toggleType = k => setTypes(prev => {
    const next = prev.includes(k) ? prev.filter(x => x !== k) : [...prev, k];
    const final = next.length ? next : prev; // always keep at least one ticked
    try { localStorage.setItem("removals_cal_types", JSON.stringify(final)); } catch {}
    return final;
  });
  const [typesOpen, setTypesOpen] = useState(false);
  const [availOpen, setAvailOpen] = useState(false);
  const [availPick, setAvailPick] = useState(null); // date chosen inside the availability dropdown
  const showMoves = types.includes("moves");
  const showSurveys = types.includes("surveys");
  const showVeh = types.includes("servicing");
  const [anchor, setAnchor] = useState(() => initialDate ? new Date(initialDate + "T00:00") : new Date());
  const jobs = (data.jobs || []).filter(j => j.moveDate && j.status !== "Let Go");
  const today = new Date();
  const hasStaff = st => !!(st.crew && st.crew.length);
  const rawJobsOn = d => { const iso = isoOf(d); const out = []; jobs.forEach(j => jobStages(j).forEach(st => { if (st.date === iso) out.push({ job: j, stage: st }); })); return out.sort((a,b)=>(a.stage.time||"").localeCompare(b.stage.time||"")); };
  const rawSurveysOn = d => altReps(data, data.enquiries || []).filter(en => en.surveyDate === isoOf(d) && !["Lost", "Not quoted"].includes(en.status)).sort((a,b)=>(a.surveyTime||"").localeCompare(b.surveyTime||""));
  const jobsOn = d => showMoves ? rawJobsOn(d) : [];
  const surveysOn = d => showSurveys ? rawSurveysOn(d) : [];
  const colorOf = m => (STATUS_META[m.job.status]?.color) || TEAL;
  const bookedVehiclesOn = d => { const s = new Set(rawJobsOn(d).filter(m => ["Confirmed", "Completed"].includes(m.job.status)).flatMap(m => m.stage.vehicleIds || [])); const iso = isoOf(d); (data.vehicles || []).forEach(v => { if (vehOutOn(v, iso)) s.add(v.id); }); return s; };
  const bookedStaffOn = d => { const s = new Set(rawJobsOn(d).filter(m => ["Confirmed", "Completed"].includes(m.job.status)).flatMap(m => m.stage.crew || [])); const iso = isoOf(d); (data.staff || []).forEach(st => { if (staffOffOn(st, iso)) s.add(st.name); }); return s; };
  const maintOnIso = iso => { const out = []; (data.vehicles || []).forEach(v => ((v.maint && v.maint.bookings) || []).forEach(b => { if (inBooking(b, iso)) out.push({ v, b }); })); return out; };
  const maintOn = d => showVeh ? maintOnIso(isoOf(d)) : [];
  const showStaffOff = true; // staff time off always shows, whatever is ticked
  const staffOffOnIso = iso => { const out = []; (data.staff || []).forEach(s => ((s.away) || []).forEach(b => { if (b.start) { const total = Math.max(1, Number(b.days) || 1); const end = isoAdd(b.start, { days: total - 1 }); if (iso >= b.start && iso <= end) { const dayNo = Math.round((new Date(iso + "T00:00") - new Date(b.start + "T00:00")) / 86400000) + 1; out.push({ s, b, dayNo, total }); } } })); return out; };
  const staffOffOnCal = d => showStaffOff ? staffOffOnIso(isoOf(d)) : [];

  useEffect(() => { setAvailPick(null); }, [mode, anchor]);
  function navg(dir){ if(mode==="month") setAnchor(new Date(anchor.getFullYear(), anchor.getMonth()+dir, 1)); else if(mode==="week") setAnchor(addDays(anchor, 7*dir)); else setAnchor(addDays(anchor, dir)); }

  let rangeLabel = "";
  if (mode==="agenda") rangeLabel = "This month & next";
  else if (mode==="month") rangeLabel = `${CAL_MON[anchor.getMonth()]} ${anchor.getFullYear()}`;
  else if (mode==="week") { const s=startOfWeek(anchor), e=addDays(s,6); rangeLabel = `${s.getDate()} ${CAL_MON[s.getMonth()].slice(0,3)} – ${e.getDate()} ${CAL_MON[e.getMonth()].slice(0,3)}`; }
  else rangeLabel = `${CAL_DOW[(anchor.getDay()+6)%7]} ${anchor.getDate()} ${CAL_MON[anchor.getMonth()]}`;

  const MoveCard = ({ m, big }) => {
    const j = m.job, st = m.stage;
    const vehNames = (st.vehicleIds || []).map(vid => { const v = (data.vehicles || []).find(x => x.id === vid); return v ? v.name : ""; }).filter(Boolean).join(", ");
    const provisional = !["Confirmed", "Completed"].includes(j.status);
    const plannedVeh = vehTypesSummary(st.vehTypes);
    const plannedStaff = Number(st.staffCount) || 0;
    const resLine = provisional
      ? `${plannedVeh || "Vehicle TBC"} · ${plannedStaff || "—"} crew (planned)`
      : `${vehNames || "No vehicle"}${(st.crew || []).length ? " · " + st.crew.join(", ") : ""}`;
    const resShort = provisional ? `${plannedVeh || "Veh TBC"} · ${plannedStaff || "—"} crew` : vehNames;
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
      {volText(data, j) && <div style={{ fontSize: big?12:10.5, color:"#10211E", marginTop:1, fontWeight:800, whiteSpace:"nowrap" }}>📦 {volText(data, j)}</div>}
      {big && (
        <div style={{ fontSize:12, color:"#41514E", marginTop:6, display:"flex", flexWrap:"wrap", alignItems:"center", gap:"2px 10px" }}>
          <span>{resLine}</span>
          <StatusBadge status={jobBadge(j)} />
        </div>
      )}
      {!big && resShort && <div style={{ fontSize:10.5, color:"#94A4A0", marginTop:1, fontWeight:700, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{resShort}</div>}
    </div>
    );
  };

  const StaffOffCard = ({ s, b, big, dayNo, total }) => (
    <div onClick={() => setView({ screen: "company" })}
      style={{ background:"#FFF7ED", border:"1px solid #FBD9A0", borderLeft:"4px solid #F59E0B", borderRadius:10, padding: big?"11px 13px":"7px 9px", cursor:"pointer" }}>
      <div style={{ fontSize: big?11:9.5, fontWeight:800, color:"#B45309", textTransform:"uppercase", letterSpacing:".05em" }}>🌴 Off · {b.reason || "Away"}{(total || b.days) > 1 && dayNo ? ` · Day ${dayNo} of ${total || b.days}` : ""}</div>
      <div style={{ fontSize: big?14:12.5, fontWeight:800, color:"#10211E", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{s.name}</div>
      {(total || b.days) > 1 && <div style={{ fontSize: big?12:10.5, color:"#6A7B77", marginTop:1, fontWeight:600 }}>{fmtUK(b.start)} – {fmtUK(isoAdd(b.start, { days: (total || b.days) - 1 }))}</div>}
    </div>
  );
  const MaintCard = ({ v, b, big }) => (
    <div onClick={() => setView({ screen: "company" })}
      style={{ background:"#F3F6FA", border:"1px solid #D3DEEA", borderLeft:"4px solid #64748B", borderRadius:10, padding: big?"11px 13px":"7px 9px", cursor:"pointer" }}>
      <div style={{ fontSize: big?11:9.5, fontWeight:800, color:"#475569", textTransform:"uppercase", letterSpacing:".05em" }}>🔧 Vehicle out · {b.type}</div>
      <div style={{ fontSize: big?14:12.5, fontWeight:800, color:"#10211E", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{v.name}</div>
      {b.days > 1 && <div style={{ fontSize: big?12:10.5, color:"#6A7B77", marginTop:1, fontWeight:600 }}>{fmtUK(b.start)} – {fmtUK(bookingEnd(b))}{b.motDate ? ` · test ${fmtUK(b.motDate)}` : ""}</div>}
    </div>
  );
  const SurveyCard = ({ en, big }) => {
    const done = en.surveyDone || en.status === "Surveyed";
    const missed = isMissedSurvey(en);
    const bg = missed ? "#FEF2F2" : done ? "#F1F9F4" : "#FFFBF2", bd = missed ? "#FCA5A5" : done ? "#BBE6C9" : "#FBE3B3", bar = missed ? "#DC2626" : done ? "#22C55E" : AMBER, tc = missed ? "#B91C1C" : done ? "#15803D" : AMBER;
    return (
    <div onClick={() => setView({ screen:"enquiryDetail", id:en.id })}
      style={{ background: bg, border:`1px solid ${bd}`, borderLeft:`4px solid ${bar}`, borderRadius:10, padding: big?"11px 13px":"7px 9px", cursor:"pointer", boxShadow:"0 1px 2px rgba(16,33,30,.05)" }}>
      <div style={{ fontSize: big?11:9.5, fontWeight:800, color: tc, textTransform:"uppercase", letterSpacing:".05em" }}>{missed ? "⚠️ Missed survey" : done ? "✓ Surveyed" : "Survey"}{en.surveyTime ? ` · ${en.surveyTime}` : ""}</div>
      <div style={{ fontSize: big?14.5:12.5, fontWeight:800, color:"#10211E", letterSpacing:"-.01em", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{custName(data, en.customerId)}</div>
      <div style={{ fontSize: big?12.5:11, color:"#6A7B77", marginTop:1, fontWeight:600, whiteSpace: big?"normal":"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{en.fromTown || "—"} → {en.toTown || "—"}</div>
      <AltNote data={data} e={en} small={!big} />
      <ReasonLine e={en} small={!big} />
    </div>
    );
  };

  const availChip = (label, booked) => (    <span style={{ display:"inline-flex", alignItems:"center", gap:6, padding:"6px 12px", borderRadius:99, fontSize:12.5, fontWeight:700,
      background: booked ? "#F2F5F4" : "#E7F2F0", color: booked ? "#B7C3C0" : TEAL_D,
      textDecoration: booked ? "line-through" : "none", border: booked ? "1px solid #EAEFEE" : "1px solid #CDE7E2" }}>
      <span style={{ width:8, height:8, borderRadius:99, background: booked ? "#C4D0CD" : "#22C55E" }} />{label}{booked && !label.includes(" · ") ? " · booked" : ""}
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

  // ── Staff & vehicle availability dropdown (shown on every view) ──
  const availDefault = (() => {
    const t = isoOf(today);
    if (mode === "day") return isoOf(anchor);
    if (mode === "week") { const s0 = isoOf(startOfWeek(anchor)), e0 = isoOf(addDays(startOfWeek(anchor), 6)); return t >= s0 && t <= e0 ? t : s0; }
    if (mode === "month") { const s0 = isoOf(new Date(anchor.getFullYear(), anchor.getMonth(), 1)), e0 = isoOf(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0)); return t >= s0 && t <= e0 ? t : s0; }
    return t;
  })();
  const availIso = (mode === "day" ? null : availPick) || availDefault;
  const renderAvail = () => {
    const d = new Date(availIso + "T00:00");
    const bv = bookedVehiclesOn(d), bs = bookedStaffOn(d);
    const vehicles = data.vehicles || [];
    const staffActive = (data.staff || []).filter(s => s.active !== false);
    if (!vehicles.length && !staffActive.length) return null;
    const freeV = vehicles.filter(v => !bv.has(v.id)).length;
    const freeS = staffActive.filter(s => !bs.has(s.name)).length;
    const step = n => setAvailPick(isoOf(addDays(d, n)));
    return (
      <div style={{ background: "#fff", border: "1px solid #E9EEED", borderRadius: 12, marginBottom: 14, boxShadow: "0 1px 2px rgba(16,33,30,.05)", overflow: "hidden" }}>
        <button onClick={() => setAvailOpen(o => !o)} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "10px 14px", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
          <span style={{ fontSize: 14, fontWeight: 800, color: "#10211E" }}>Staff & vehicle availability</span>
          <span style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            {!availOpen && <span style={{ fontSize: 12, fontWeight: 700, color: (freeV || freeS) ? TEAL_D : "#B7C3C0" }}>{freeV} van{freeV !== 1 ? "s" : ""} · {freeS} crew free</span>}
            <span style={{ color: "#9CA3AF" }}>{availOpen ? "▾" : "▸"}</span>
          </span>
        </button>
        {availOpen && (
          <div style={{ padding: "0 14px 14px", borderTop: "1px solid #F2F5F4" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "10px 0 12px" }}>
              {mode !== "day" && <button onClick={() => step(-1)} style={{ ...navBtn, width: 32, height: 32, fontSize: 18 }}>‹</button>}
              <span style={{ flex: 1, textAlign: mode === "day" ? "left" : "center", fontSize: 13.5, fontWeight: 800, color: sameDay(d, today) ? AMBER : "#10211E" }}>{fmtDate(availIso)} ({dow(availIso)}){sameDay(d, today) ? " · Today" : ""}</span>
              {mode !== "day" && <button onClick={() => step(1)} style={{ ...navBtn, width: 32, height: 32, fontSize: 18 }}>›</button>}
            </div>
            {vehicles.length > 0 && <>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#6A7B77", marginBottom: 6 }}>Vehicles</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: staffActive.length ? 12 : 0 }}>{vehicles.map(v => { const out = vehOutOn(v, availIso); return <span key={v.id}>{availChip(out ? `${v.name} · servicing` : v.name, bv.has(v.id))}</span>; })}</div>
            </>}
            {staffActive.length > 0 && <>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#6A7B77", marginBottom: 6 }}>Staff</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>{staffActive.map(s => { const off = staffAwayReason(s, availIso); return <span key={s.id}>{availChip(off ? `${s.name} · ${off}` : s.name, bs.has(s.name))}</span>; })}</div>
            </>}
          </div>
        )}
      </div>
    );
  };

  return (
    <div>

      {/* Show: moves / surveys / servicing — dropdown with tick boxes */}
      <div style={{ background: "#fff", border: "1px solid #E9EEED", borderRadius: 12, marginBottom: 10, boxShadow: "0 1px 2px rgba(16,33,30,.05)", overflow: "hidden" }}>
        <button onClick={() => setTypesOpen(o => !o)} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "10px 14px", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
          <span style={{ fontSize: 14, fontWeight: 800, color: "#10211E", flexShrink: 0 }}>Show</span>
          <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: TEAL_D, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{types.length === 3 ? "Everything" : CAL_TYPES.filter(([k]) => types.includes(k)).map(([, l]) => l.replace(/^\S+ /, "")).join(" + ")}</span>
            <span style={{ color: "#9CA3AF" }}>{typesOpen ? "▾" : "▸"}</span>
          </span>
        </button>
        {typesOpen && (
          <div style={{ padding: "4px 14px 12px", borderTop: "1px solid #F2F5F4", display: "flex", flexDirection: "column", gap: 6 }}>
            {CAL_TYPES.map(([k, label]) => {
              const on = types.includes(k);
              return (
                <label key={k} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 10, cursor: "pointer", background: on ? "#EAF4F2" : "#F7FAF9", border: `1.5px solid ${on ? TEAL : "#E3E9E8"}`, fontSize: 14, fontWeight: 700, color: "#10211E" }}>
                  <input type="checkbox" checked={on} onChange={() => toggleType(k)} style={{ width: 18, height: 18, accentColor: TEAL }} />
                  {label}
                </label>
              );
            })}
          </div>
        )}
      </div>

      {/* View tiles — same size and style as the filter tiles above */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 18 }}>
        {[["agenda", "Agenda", "2 months"], ["day", "Day", "One day"], ["week", "Week", "7 days"], ["month", "Month", "Full month"]].map(([m, label, sub]) => {
          const active = mode === m;
          return (
            <button key={m} onClick={() => setMode(m)} style={{
              textAlign: "left", minWidth: 0, cursor: "pointer", fontFamily: "inherit",
              background: active ? "#EAF4F2" : "#fff", borderRadius: 10, padding: "7px 12px", display: "flex", alignItems: "baseline", gap: 7,
              border: active ? `2px solid ${TEAL}` : "2px solid #F3F4F6",
              boxShadow: "0 1px 3px rgba(0,0,0,.07)", transition: "all .15s",
            }}>
              <div style={{ fontSize: 15, fontWeight: 800, color: active ? TEAL : "#374151", lineHeight: 1.4 }}>{label}</div>
              <div style={{ fontSize: 12, color: "#6B7280", fontWeight: 600, lineHeight: 1.4, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sub}</div>
            </button>
          );
        })}
      </div>

      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:12, marginBottom:14 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
          <div style={{ display:"flex", gap:5 }}>
            <button onClick={()=>navg(-1)} style={navBtn}>‹</button>
            <button onClick={()=>navg(1)} style={navBtn}>›</button>
          </div>
          <Btn size="sm" variant="grey" onClick={()=>setAnchor(new Date())}>Today</Btn>
          <span style={{ fontSize:17, fontWeight:800, letterSpacing:"-.01em", color:"#10211E" }}>{rangeLabel}</span>
        </div>
      </div>

      {renderAvail()}

      {showVeh && (() => {
        const nowIso = isoOf(today);
        const endIso = isoOf(new Date(today.getFullYear(), today.getMonth() + 2, 0)); // last day of next month
        const up = [];
        (data.vehicles || []).forEach(v => ((v.maint && v.maint.bookings) || []).forEach(b => { if (b.start && b.start <= endIso && bookingEnd(b) >= nowIso) up.push({ v, b }); }));
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
        if (showSurveys) altReps(data, data.enquiries || []).forEach(en => { if (inRange(en.surveyDate) && !["Lost","Not quoted"].includes(en.status)) items.push({ type:"survey", date:en.surveyDate, time:en.surveyTime||"", en }); });
        if (showVeh) (data.vehicles||[]).forEach(v => ((v.maint&&v.maint.bookings)||[]).forEach(b => { const first = bookingDates(b).find(d => d >= startIso); if (first && first <= endIso) items.push({ type:"maint", date: first, time:"00", v, b }); }));
        if (showStaffOff) (data.staff||[]).forEach(s => ((s.away)||[]).forEach(b => { const total = Math.max(1,Number(b.days)||1); if (b.start && isoAdd(b.start,{days:total-1}) >= startIso && b.start <= endIso) { const shown = b.start < startIso ? startIso : b.start; const dayNo = Math.round((new Date(shown+"T00:00") - new Date(b.start+"T00:00"))/86400000) + 1; items.push({ type:"staffoff", date: shown, time:"00", s, b, dayNo, total }); } }));
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
                  {g.items.map((it,ix) => it.type==="survey" ? <SurveyCard key={ix} en={it.en} big /> : it.type==="maint" ? <MaintCard key={ix} v={it.v} b={it.b} big /> : it.type==="staffoff" ? <StaffOffCard key={ix} s={it.s} b={it.b} dayNo={it.dayNo} total={it.total} big /> : <MoveCard key={ix} m={{ job:it.job, stage:it.stage }} big />)}
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
              {svs.slice(0,2).map(en => <div key={en.id} style={{ fontSize:10.5, fontWeight:700, color: isMissedSurvey(en) ? "#B91C1C" : "#92591A", background: isMissedSurvey(en) ? "#FEE2E2" : "#FFF6E6", borderLeft:`3px solid ${isMissedSurvey(en) ? "#DC2626" : AMBER}`, borderRadius:5, padding:"2px 5px", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>📋 {custName(data,en.customerId)}</div>)}
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
                    <div onClick={()=>{ setAnchor(d); setMode("day"); }} title="Open this day" style={{ background: isToday?"#FFF7E8":"#F4F7F6", borderBottom:"1px solid #E9EEED", padding:"7px 6px", textAlign:"center", cursor:"pointer" }}>
                      <div style={{ fontSize:11, fontWeight:800, color:"#94A4A0", textTransform:"uppercase" }}>{CAL_DOW[i]} ›</div>
                      <div style={{ fontSize:16, fontWeight:800, color: isToday?AMBER:"#2c3c38" }}>{d.getDate()}</div>
                    </div>
                    <div onClick={e=>{ if (e.target === e.currentTarget) { setAnchor(d); setMode("day"); } }} style={{ padding:7, display:"flex", flexDirection:"column", gap:6, minHeight:90, flex:1, cursor:"pointer" }}>
                      {surveysOn(d).map(en => <SurveyCard key={en.id} en={en} />)}
                      {maintOn(d).map((mm,ix) => <MaintCard key={"m"+ix} v={mm.v} b={mm.b} />)}
                      {staffOffOnCal(d).map((so,ix) => <StaffOffCard key={"so"+ix} s={so.s} b={so.b} dayNo={so.dayNo} total={so.total} />)}
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
            <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
              {svs.map(en => <SurveyCard key={en.id} en={en} big />)}
              {maintOn(anchor).map((mm,ix) => <MaintCard key={"m"+ix} v={mm.v} b={mm.b} big />)}
              {staffOffOnCal(anchor).map((so,ix) => <StaffOffCard key={"so"+ix} s={so.s} b={so.b} dayNo={so.dayNo} total={so.total} big />)}
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
    html,body,#root{height:100%;overflow:hidden;overscroll-behavior:none}
    *{overscroll-behavior:none}
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
    .rm-btn{padding:12px 18px!important;font-size:15px!important}.rm-btn-sm{padding:9px 14px!important;font-size:13.5px!important}
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
function mergeArrays(cloudArr, localArr, deleted, goneElsewhere) {
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
      // Job sign-offs only ever get added (by the crew), so keep every one either copy has.
      if (c.signOffs || x.signOffs) { const so = { ...(x.signOffs || {}), ...(c.signOffs || {}) }; if (Object.keys(so).length !== Object.keys(byId[x.id].signOffs || {}).length) byId[x.id] = { ...byId[x.id], signOffs: so }; }
    } else if (goneElsewhere && goneElsewhere.has(x.id)) {
      addTombstone(x.id); // was in the cloud before, now isn't → deleted on another device
    } else byId[x.id] = x; // never uploaded yet: keep (it's waiting to sync)
  });
  return Object.values(byId);
}
// Records this device has synced before but which are no longer in the cloud were deleted on
// another device (e.g. the Home Screen app vs Safari). Drop them here too. Safety net: if a
// table suddenly looks mostly empty, assume a cloud glitch rather than mass deletion and skip.
// Records this device has synced before but the cloud no longer has.
// It used to guess these had been deleted elsewhere and drop them — but if the cloud
// ever answers "nothing" (e.g. permissions changing), that wrongly wiped real records.
// Now: real deletes come only from the shared deleted list (applyCloudDeletes), and
// anything else the cloud has lost is uploaded again from this device.
function findGoneElsewhere(cloud, local) {
  let sigs = {};
  try { sigs = JSON.parse(localStorage.getItem(SIG_KEY) || "{}"); } catch {}
  const dead = new Set(getTombstones());
  let changed = false;
  TABLES.forEach(t => {
    const inCloud = new Set((cloud[t] || []).map(r => r.id));
    (local[t] || []).forEach(r => { if (!inCloud.has(r.id) && !dead.has(r.id) && Object.prototype.hasOwnProperty.call(sigs, r.id)) { delete sigs[r.id]; changed = true; } });
  });
  if (changed) { try { localStorage.setItem(SIG_KEY, JSON.stringify(sigs)); } catch {} }
  return new Set();
}
function mergeAll(cloud, local) {
  const goneElsewhere = findGoneElsewhere(cloud, local);
  goneElsewhere.forEach(id => addTombstone(id));
  const deleted = getTombstones();
  return {
    customers: mergeArrays(cloud.customers, local.customers || [], deleted, goneElsewhere),
    enquiries: mergeArrays(cloud.enquiries, local.enquiries || [], deleted, goneElsewhere),
    jobs: mergeArrays(cloud.jobs, local.jobs || [], deleted, goneElsewhere),
    vehicles: applyAutoMaint(mergeArrays(cloud.vehicles, local.vehicles || [], deleted, goneElsewhere)),
    staff: mergeArrays(cloud.staff, local.staff || [], deleted, goneElsewhere),
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
  if (rec.amendedAt) { ensure(30); y -= 2; at(`AMENDED COPY - last changed ${fmtUK(String(rec.amendedAt).slice(0, 10))}. The original signed inventory (with condition notes) is kept on file.`, M, y, 8.5, bold, rgb(0.71, 0.33, 0.04)); y -= 14; }

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

// Amount picker for storage items: 1–50, keeping any odd number already saved.
function QtySelect({ value, onChange, style }) {
  const v = Math.max(1, parseInt(value, 10) || 1);
  const opts = Array.from({ length: 50 }, (_, i) => i + 1); if (!opts.includes(v)) opts.push(v);
  return <select value={v} onChange={e => onChange(Number(e.target.value))} style={{ ...style, textAlign: "center", appearance: "none", WebkitAppearance: "none", cursor: "pointer", fontWeight: 700 }}>{opts.map(n => <option key={n} value={n}>{n}</option>)}</select>;
}

function StorageIntakeForm({ data, setView, presetCustomerId, editRecId, presetJobId }) {
  const device = useDeviceType();
  const phone = device === "phone";
  const editCust = editRecId ? (data.customers || []).find(c => (c.storageInv || []).some(r => r.id === editRecId)) : null;
  const editRec = editCust ? (editCust.storageInv || []).find(r => r.id === editRecId) : null;
  const loadConts = rec => { const cs = (rec.containers || []).map(c => ({ id: uid(), number: c.number || "", items: (c.items || []).map(it => ({ id: uid(), name: it.name || "", qty: it.qty || 1, conditions: Array.isArray(it.conditions) ? it.conditions : (it.condition ? [it.condition] : []), positions: Array.isArray(it.positions) ? it.positions : (it.position ? [it.position] : []), packedBy: it.packedBy || "", dismantle: it.dismantle || "" })) })); return cs.length ? cs : [{ id: uid(), number: "", items: [{ id: uid(), name: "", qty: 1, conditions: ["OK"], positions: [], packedBy: "", dismantle: "" }] }]; };
  const DRAFT_KEY = editRecId ? "storageIntakeDraft_" + editRecId : "storageIntakeDraft";
  const saved = (() => { try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || sessionStorage.getItem(DRAFT_KEY) || "null"); } catch { return null; } })();
  const src = saved || (editRec ? { customerId: editCust.id, date: editRec.date, location: editRec.location, crew: editRec.crew, containers: loadConts(editRec), custSig: editRec.custSig, empSig: editRec.empSig, empName: editRec.empName } : null);
  const [customerId, setCustomerId] = useState(src?.customerId ?? (presetCustomerId || ""));
  const [jobId, setJobId] = useState((editRec && editRec.jobId) || presetJobId || "");
  const [date, setDate] = useState(src?.date ?? todayISO());
  const [location, setLocation] = useState(src?.location ?? (getStorageLocs()[0] || "Wild & Lye"));
  const [crew, setCrew] = useState(src?.crew ?? []);
  const [containers, setContainers] = useState(src?.containers ?? [{ id: uid(), number: "", items: [{ id: uid(), name: "", qty: 1, conditions: ["OK"], positions: [], packedBy: "", dismantle: "" }] }]);
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
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ customerId, date, location, crew, containers, custSig, empSig, empName, looseList })); } catch {}
  }, [customerId, date, location, crew, containers, custSig, empSig, empName, looseList]);
  const clearDraft = () => { try { sessionStorage.removeItem(DRAFT_KEY); localStorage.removeItem(DRAFT_KEY); } catch {} };
  const leave = () => { clearDraft(); setView({ screen: "storage" }); };
  // Pull the "Into store" day (date + crew) from the customer's move plan, if there is one.
  const findStoreDay = (cid, sjId) => {
    const cc = (data.customers || []).find(x => x.id === cid);
    const sj = cc && sjId ? getStorageJobs(cc).find(x => x.id === sjId) : null;
    const linked = sj && sj.moveJobId ? (data.jobs || []).find(x => x.id === sj.moveJobId) : null;
    if (linked) { const d = storeDayOf(linked); if (d) return d; }
    for (const j of bookedMovesFor(data, cid)) { const st = jobStages(j).find(s => /store/i.test(s.type || "") && s.date); if (st) return st; }
    const first = bookedMovesFor(data, cid)[0];
    return first ? storeDayOf(first) : null;
  };
  const [prefillMsg, setPrefillMsg] = useState("");
  const applyStoreDay = (cid, sjId) => {
    const sd = cid ? findStoreDay(cid, sjId) : null;
    if (!sd) { setPrefillMsg(""); return; }
    if (sd.date) setDate(sd.date);
    if (Array.isArray(sd.crew) && sd.crew.length) setCrew(sd.crew);
    setPrefillMsg(`Staff copied from the booked move: ${sd.date ? fmtUK(sd.date) : "date"}${sd.crew && sd.crew.length ? " · " + sd.crew.join(", ") : ""}. Adjust if needed.`);
  };
  const onlyJob = cid => { const cc = (data.customers || []).find(x => x.id === cid); const js = cc ? getStorageJobs(cc).filter(j => !j.dateOut) : []; return js.length === 1 ? js[0].id : ""; };
  const pickCustomer = cid => { setCustomerId(cid); const sj = onlyJob(cid); setJobId(sj); applyStoreDay(cid, sj); };
  const pickJob = sj => { setJobId(sj); if (!editRec) applyStoreDay(customerId, sj); };
  useEffect(() => { if (presetCustomerId && !saved && !editRec) { const sj = presetJobId || onlyJob(presetCustomerId); if (sj && !jobId) setJobId(sj); applyStoreDay(presetCustomerId, sj); } /* eslint-disable-next-line */ }, []);
  const [conds, setConds] = useState(getConditions);
  const [newCond, setNewCond] = useState("");
  const [poss, setPoss] = useState(getPositions);
  const [newPos, setNewPos] = useState("");
  const [signing, setSigning] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [completing, setCompleting] = useState(false);
  const [readyToSave, setReadyToSave] = useState(false);
  useEffect(() => { if (readyToSave) { setReadyToSave(false); setCompleting(false); saveIntake("complete"); } /* eslint-disable-next-line */ }, [readyToSave]);
  function startComplete() {
    setErr("");
    if (!customerId) { setErr("Please select a customer."); return; }
    const hasItems = containers.some(c => (c.items || []).some(it => (it.name || "").trim())) || looseList.some(li => (li.name || "").trim());
    if (!hasItems) { setErr("Add the items first."); return; }
    let who = empName;
    if (!who && crew.length === 1) { who = crew[0]; setEmpName(who); }
    if (!who) { setErr("Pick who completed it under Sign off (choose the crew first), then tap Complete again."); return; }
    setCompleting(true);
    if (!custSig) setSigning("cust");
    else if (!empSig) setSigning("emp");
    else setReadyToSave(true);
  }

  const crewOpts = (data.staff || []).filter(s => s.active !== false).map(s => ({ id: s.name, label: s.name }));
  const setContainerNo = (ci, v) => setContainers(cs => cs.map((c, i) => i === ci ? { ...c, number: v } : c));
  const addContainer = () => setContainers(cs => [...cs, { id: uid(), number: "", items: [{ id: uid(), name: "", qty: 1, conditions: ["OK"], positions: [], packedBy: "", dismantle: "" }] }]);
  const removeContainer = ci => setContainers(cs => cs.length > 1 ? cs.filter((_, i) => i !== ci) : cs);
  const addItem = ci => setContainers(cs => cs.map((c, i) => i === ci ? { ...c, items: [...c.items, { id: uid(), name: "", qty: 1, conditions: ["OK"], positions: [], packedBy: "", dismantle: "" }] } : c));
  const setItem = (ci, ii, field, v) => setContainers(cs => cs.map((c, i) => i === ci ? { ...c, items: c.items.map((it, j) => j === ii ? { ...it, [field]: v } : it) } : c));
  const addTag = (ci, ii, field, val) => { if (!val) return; setContainers(cs => cs.map((c, i) => i === ci ? { ...c, items: c.items.map((it, j) => {
    if (j !== ii) return it;
    let list = Array.from(new Set([...(it[field] || []), val]));
    // Condition: "OK" is the default — picking a damage note replaces it, picking OK clears the rest.
    if (field === "conditions") list = val === "OK" ? ["OK"] : list.filter(x => x !== "OK");
    return { ...it, [field]: list };
  }) } : c)); };
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

  // mode "draft" = save progress (no signatures needed); "complete" = signed and final.
  async function saveIntake(mode = "complete") {
    setErr("");
    if (!customerId) { setErr("Please select a customer."); return; }
    const cust = (data.customers || []).find(x => x.id === customerId);
    if (!cust) { setErr("Customer not found."); return; }
    const draft = mode === "draft";
    const cleanContainers = containers.map(c => ({ number: c.number, items: (c.items || []).filter(it => (it.name || "").trim()).map(it => ({ name: it.name.trim(), qty: Number(it.qty) || 1, conditions: it.conditions || [], positions: it.positions || [], packedBy: it.packedBy || "", dismantle: it.dismantle || "" })) })).filter(c => (c.number || "").trim() || c.items.length);
    const cleanLoose = looseList.map(li => ({ name: (li.name || "").trim(), qty: Math.max(1, Number(li.qty) || 1) })).filter(li => li.name);
    if (!draft) {
      if (!cleanContainers.length) { setErr("Add at least one container with items."); return; }
      if (!empName) { setErr("Select who completed the inventory (a crew member)."); return; }
      if (!custSig || !empSig) { setErr("Both signatures are needed to complete it."); return; }
    }
    setBusy(draft ? "draft" : "save");
    const rec = { id: editRec ? editRec.id : uid(), jobId: jobId || (editRec && editRec.jobId) || "", date, location, crew, containers: cleanContainers, custSig, empSig, empName, looseList: cleanLoose, looseItems: cleanLoose.length > 0, pdfUrl: (editRec && editRec.pdfUrl) || "", pdf: (editRec && editRec.pdf) || "", createdAt: (editRec && editRec.createdAt) || new Date().toISOString() };
    // Keep the ORIGINAL inventory exactly as first signed (damage/condition notes included).
    // Edits never overwrite it: they become the "current" sheet, and the original stays on file.
    const snap = r => ({ date: r.date, location: r.location, crew: r.crew || [], containers: r.containers || [], looseList: r.looseList || [], looseItems: !!r.looseItems, custSig: r.custSig || "", empSig: r.empSig || "", empName: r.empName || "", savedAt: r.createdAt || new Date().toISOString() });
    rec.draft = draft;
    if (draft) {
      // Work in progress: nothing is locked yet, no original copy or PDF until it's completed.
      delete rec.original; rec.originalPdfUrl = "";
    } else if (editRec && !editRec.draft) {
      rec.original = editRec.original || snap(editRec);
      rec.originalPdfUrl = editRec.originalPdfUrl || editRec.pdfUrl || "";
      rec.amendedAt = new Date().toISOString();
      rec.collections = editRec.collections || [];
    } else {
      rec.original = snap(rec);
    }
    // Also store a PDF copy of the original in the cloud (best effort — the saved copy above is the safety net).
    if (!draft && !rec.originalPdfUrl) {
      const to = ms => new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms));
      try {
        const { bytes } = await Promise.race([buildStorageIntakePdf({ ...rec.original, id: rec.id }, cust, data), to(12000)]);
        rec.originalPdfUrl = await Promise.race([uploadStorageSheet(`${cust.id}/inventory-${rec.id}-original.pdf`, bytes), to(15000)]);
      } catch (_e) { /* offline — the original can still be rebuilt from the saved copy */ }
    }
    const list = editRec ? (cust.storageInv || []).map(r => r.id === rec.id ? rec : r) : [...(cust.storageInv || []), rec];
    const updated = { ...cust, storageInv: list };
    clearDraft();
    try { const rj = rec.jobId; sessionStorage.setItem("removals_view", JSON.stringify(rj ? { screen: "storageJob", customerId: cust.id, jobId: rj } : { screen: "customerDetail", id: cust.id })); } catch {}
    await saveAndReload(upsertLocal(data, "customers", updated));
  }

  const Lbl = ({ children }) => <div style={{ fontSize: 13, fontWeight: 600, color: "#374151", margin: "0 0 4px" }}>{children}</div>;

  return (
    <div style={{ maxWidth: 640, margin: "0 auto" }}>
      <button onClick={leave} style={{ display: "inline-flex", alignItems: "center", background: "#fff", border: "1.5px solid #D3DDDB", borderRadius: 11, color: NAVY, fontSize: 15.5, fontWeight: 800, cursor: "pointer", padding: "10px 16px", marginBottom: 10 }}>‹ Back</button>
      <h2 style={{ margin: "0 0 14px", fontSize: 20, fontWeight: 800, color: "#10211E" }}>{editRec ? (editRec.draft ? "Continue storage inventory" : "Edit storage inventory") : "New storage inventory"}</h2>
      {editRec && !editRec.draft && <div style={{ fontSize: 12.5, color: "#7C4A03", background: "#FFF7E8", border: "1px solid #FBD9A0", borderRadius: 8, padding: "8px 11px", marginBottom: 12 }}>The original signed inventory{editRec.original && editRec.original.savedAt ? ` from ${fmtUK(String(editRec.original.savedAt).slice(0, 10))}` : ""}, with its damage and condition notes, is kept on file. Your changes save as an amended copy.</div>}

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
          if (!cjobs.length) return <div style={{ fontSize: 12, color: "#B45309", background: "#FFFBF2", border: "1px solid #FBE3B3", borderRadius: 8, padding: "7px 10px", marginBottom: 10 }}>No storage job yet. Once the move is Confirmed and booked in the calendar, add a storage job on the customer's page. You can still save this inventory and link it later.</div>;
          return <Field label="Storage job"><select value={jobId} onChange={e => pickJob(e.target.value)} style={{ ...inp, appearance: "none", cursor: "pointer" }}>
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
                  <QtySelect value={it.qty} onChange={v => setItem(ci, ii, "qty", v)} style={{ ...inp, width: 62, padding: "9px 4px", flexShrink: 0 }} />
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
            <div style={{ width: 66 }}><QtySelect value={li.qty} onChange={v => setLoose(li.id, "qty", v)} style={{ ...inp, padding: "9px 4px" }} /></div>
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

      {signing === "cust" && <SignatureModal title="Customer signature" initial={custSig} onCancel={() => { setSigning(null); setCompleting(false); }} onAccept={v => { setCustSig(v); setSigning(completing && !empSig ? "emp" : null); if (completing && empSig) setReadyToSave(true); }} />}
      {signing === "emp" && <SignatureModal title={`Employee signature${empName ? " — " + empName : ""}`} initial={empSig} onCancel={() => { setSigning(null); setCompleting(false); }} onAccept={v => { setEmpSig(v); setSigning(null); if (completing) setReadyToSave(true); }} />}

      {err && <div style={{ marginTop: 12, fontSize: 12.5, color: "#B91C1C", background: "#FEF2F2", borderRadius: 8, padding: "8px 11px" }}>{err}</div>}
      <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
        <Btn variant="grey" onClick={leave}>Cancel</Btn>
        <Btn variant="grey" disabled={busy} onClick={makeIntakePdf}>{busy === "pdf" ? "…" : "PDF"}</Btn>
        <Btn variant="grey" style={{ flex: 1 }} disabled={busy} onClick={() => saveIntake("draft")}>{busy === "draft" ? "Saving…" : "💾 Save progress"}</Btn>
      </div>
      <Btn style={{ width: "100%", marginTop: 10, padding: "14px 12px", fontSize: 16 }} disabled={busy} onClick={startComplete}>{busy === "save" ? "Saving…" : "✅ Complete — get signatures"}</Btn>
      <div style={{ fontSize: 12, color: "#94A4A0", textAlign: "center", marginTop: 6 }}>Save progress keeps it to finish later. Complete asks the customer and crew member to sign, then locks in the original.</div>
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

// Open the ORIGINAL inventory as first signed, or the CURRENT one if it's been edited since.
async function openInventoryPdf(rec, c, data, which) {
  try {
    if (which === "original") {
      if (rec.originalPdfUrl) return showPdf(rec.originalPdfUrl, "Storage-inventory-original.pdf");
      const { bytes } = await buildStorageIntakePdf({ ...(rec.original || rec), id: rec.id, amendedAt: undefined }, c, data);
      return showPdf(new Blob([bytes], { type: "application/pdf" }), "Storage-inventory-original.pdf");
    }
    const { bytes } = await buildStorageIntakePdf(rec, c, data);
    return showPdf(new Blob([bytes], { type: "application/pdf" }), "Storage-inventory.pdf");
  } catch (ex) { alert("Could not open the inventory: " + ((ex && ex.message) || ex)); }
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
      <button onClick={() => setView({ screen: "customerDetail", id: cust.id })} style={{ display: "inline-flex", alignItems: "center", background: "#fff", border: "1.5px solid #D3DDDB", borderRadius: 10, color: NAVY, fontSize: 15.5, fontWeight: 800, cursor: "pointer", padding: "10px 16px", marginBottom: 10 }}>‹ Back</button>
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

// Storage jobs can only be added against a CONFIRMED move that's booked in the calendar.
const BOOKED_MOVE_STATUSES = ["Confirmed", "In Progress", "Completed"];
function bookedMovesFor(data, customerId) {
  // ...and the move must be a storage job: "Moving into store" ticked on the enquiry, or an "Into store" day in the move plan.
  const isStorage = j => jobStages(j).some(st => /store/i.test(st.type || "")) || (data.enquiries || []).some(e => e.id === j.enquiryId && e.toStore);
  return (data.jobs || []).filter(j => j.customerId === customerId && BOOKED_MOVE_STATUSES.includes(j.status) && jobStages(j).some(st => st.date) && isStorage(j));
}
// The day goods go into store: an "Into store" day if there is one, otherwise the first booked day.
function storeDayOf(j) {
  const st = jobStages(j).filter(x => x.date);
  return st.find(x => /store/i.test(x.type || "")) || st.sort((a, b) => a.date.localeCompare(b.date))[0] || null;
}
function StorageJobForm({ data, customer, job, onClose }) {
  const isNew = !job;
  const moves = bookedMovesFor(data, customer.id);
  const [moveJobId, setMoveJobId] = useState(() => (job ? job.moveJobId || "" : (moves[0] && moves[0].id) || ""));
  const linkedMove = moves.find(m => m.id === moveJobId) || (data.jobs || []).find(m => m.id === moveJobId) || null;
  const storeDay = linkedMove ? storeDayOf(linkedMove) : null;
  const [f, setF] = useState(() => job
    ? { id: job.id, location: job.location || (getStorageLocs()[0] || "Wild & Lye"), value: job.value ?? "", dateIn: job.dateIn || "", dateOut: job.dateOut || "" }
    : { id: uid(), location: getStorageLocs()[0] || "Wild & Lye", value: "", dateIn: (moves[0] && storeDayOf(moves[0]) && storeDayOf(moves[0]).date) || todayISO(), dateOut: "" });
  const [locs, setLocs] = useState(getStorageLocs);
  const [newLoc, setNewLoc] = useState("");
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const addLoc = () => { const v = newLoc.trim(); if (!v || locs.includes(v)) { setNewLoc(""); return; } const nx = [...locs, v]; setLocs(nx); saveStorageLocs(nx); set("location", v); setNewLoc(""); };

  async function save() {
    if (isNew && !moveJobId) { alert("Pick the confirmed move this storage is for."); return; }
    const jrec = { ...(job || {}), id: f.id, location: f.location || "", value: Number(f.value) || 0, dateIn: f.dateIn || "", dateOut: f.dateOut || "", inStore: !f.dateOut, moveJobId: moveJobId || "", crew: (storeDay && storeDay.crew) || (job && job.crew) || [] };
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
      {isNew && !moves.length ? (
        <div>
          <div style={{ fontSize: 14, color: "#7C4A03", background: "#FFF7E8", border: "1px solid #FBD9A0", borderRadius: 10, padding: "12px 14px", lineHeight: 1.5 }}>
            <b>No confirmed storage move booked yet.</b><br />A storage job can only be added once {customer.name || "the customer"}'s job is:
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              <li>booked as storage: <b>Moving into store</b> ticked on the enquiry, or an <b>Into store</b> day in the move plan</li>
              <li><b>Confirmed</b> and booked in the calendar with a date</li>
            </ul>
          </div>
          <Btn style={{ width: "100%", marginTop: 12 }} onClick={onClose}>OK</Btn>
        </div>
      ) : (<>
      <Field label="Confirmed move" hint={storeDay ? `Into store ${fmtUK(storeDay.date)}${storeDay.crew && storeDay.crew.length ? " · " + storeDay.crew.join(", ") : ""}` : undefined}>
        <select value={moveJobId} onChange={e => { const id = e.target.value; setMoveJobId(id); const m = moves.find(x => x.id === id); const d = m && storeDayOf(m); if (d && d.date) set("dateIn", d.date); }} style={{ ...inputStyle, appearance: "none", cursor: "pointer" }}>
          {!isNew && <option value="">Not linked to a move</option>}
          {moves.map(m => { const d = storeDayOf(m); return <option key={m.id} value={m.id}>{moveRef(data, m)}{d ? ` · ${fmtUK(d.date)} · ${d.type || "Move"}` : ""}</option>; })}
        </select>
      </Field>
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
        {!isNew && canDelete() && <Btn variant="danger" onClick={del}><Icon name="trash" size={14} /></Btn>}
        <Btn variant="grey" style={{ flex: 1 }} onClick={onClose}>Cancel</Btn>
        <Btn style={{ flex: 2 }} onClick={save}>{isNew ? "Add job" : "Save"}</Btn>
      </div>
      </>)}
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
  const openUrl = url => showPdf(url, "Storage-sheet.pdf");
  async function openSheet(rec) {
    if (sheetBusy) return;
    if (rec.amendedAt) { setSheetBusy(true); await openInventoryPdf(rec, c, data, "current"); setSheetBusy(false); return; }
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
                  {rec.draft && <div style={{ fontSize: 12, color: "#7C3AED", fontWeight: 800 }}>✏️ In progress — not signed yet</div>}
                  {rec.amendedAt && !rec.draft && <div style={{ fontSize: 12, color: "#B45309", fontWeight: 700 }}>Amended {fmtUK(String(rec.amendedAt).slice(0, 10))} · original kept</div>}
                </div>
                <div style={{ display: "flex", gap: 12, flexShrink: 0 }}>
                  {!rec.draft && <span onClick={() => setView({ screen: "storageCollect", recId: rec.id })} style={{ color: "#B45309", fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>Collect</span>}
                  <span onClick={() => setView({ screen: "storageIntake", editRecId: rec.id })} style={{ color: rec.draft ? "#7C3AED" : TEAL, fontSize: 12.5, fontWeight: 800, cursor: "pointer" }}>{rec.draft ? "Continue" : "Edit"}</span>
                  <span onClick={() => openSheet(rec)} style={{ color: TEAL, fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>{sheetBusy ? "…" : rec.amendedAt ? "Current" : "PDF"}</span>
                  {rec.amendedAt && <span onClick={async () => { if (sheetBusy) return; setSheetBusy(true); await openInventoryPdf(rec, c, data, "original"); setSheetBusy(false); }} style={{ color: "#B45309", fontSize: 12.5, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>Original</span>}
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
      <div className="rm-page-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <h2 className="rm-page-title" style={{ margin: 0, fontSize: 20, fontWeight: 800, color: "#10211E" }}>Storage</h2>
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

// Page names shown in the green top bar on phones
const PAGE_TITLES = { enquiries: "Enquiries", calendar: "Calendar", customers: "Customers", storage: "Storage", company: "Company", reports: "Reports" };

// ══ Logins & roles ═══════════════════════════════════════════════════════════
// Remember the invite / password-reset link details before Supabase tidies the URL.
const AUTH_HASH = typeof window !== "undefined" ? (window.location.hash || "") : "";
const NEEDS_PASSWORD = /type=(invite|recovery|signup)/.test(AUTH_HASH);

// Wipe this device's copy of the business data (used on sign out / when someone else signs in).
function clearAppData() {
  try {
    Object.keys(localStorage).forEach(k => { if (k.startsWith("removals_") || k.startsWith("rm_")) localStorage.removeItem(k); });
    sessionStorage.clear();
  } catch {}
}
async function signOutFlow() {
  let pending = false;
  if (CURRENT_USER.role !== "crew" && CURRENT_USER.role !== "viewer") try {
    await Promise.race([pushChangedOnly(loadData()), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000))]);
  } catch { pending = true; }
  if (pending && !confirm("Some changes on this device haven't uploaded yet (no signal?). If you sign out now they'll be lost.\n\nSign out anyway?")) return;
  clearAppData();
  try { await supabase.auth.signOut(); } catch {}
  window.location.reload();
}
// Users are managed straight in Supabase (functions from setup-logins.sql), so no Vercel key is needed.
let SIGNUP_CLIENT = null;
function signupClient() {
  // A separate, throwaway client: signing someone up must not sign YOU out.
  if (!SIGNUP_CLIENT) SIGNUP_CLIENT = createClient(supabase.supabaseUrl, supabase.supabaseKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: "rm-signup-tmp" } });
  return SIGNUP_CLIENT;
}
const friendlyUsersErr = e => {
  const m = (e && (e.message || e.details)) || String(e || "");
  if (/admin_list_users|admin_set_user|admin_delete_user|function .* does not exist|schema cache/i.test(m)) return "The logins setup hasn't been run in Supabase yet — run setup-logins.sql in the SQL Editor.";
  if (/rate limit|too many/i.test(m)) return "Supabase is only allowed to send a few emails an hour — wait a bit and try again.";
  if (/signups? not allowed|signup is disabled/i.test(m)) return "New sign-ups are switched off in Supabase (Authentication → Sign In / Providers → Allow new users to sign up). Switch it on.";
  return m;
};
async function usersApi(method, body) {
  const redirectTo = window.location.origin;
  try {
    if (method === "GET") {
      const { data, error } = await supabase.rpc("admin_list_users");
      if (error) throw error;
      return { users: (data || []).map(u => ({ id: u.id, email: u.email, role: u.role || "", staffName: u.staff_name || "", lastSignIn: u.last_sign_in || "", confirmed: !!u.confirmed })) };
    }
    if (method === "POST" && body.action === "resend") {
      const email = String(body.email || "").trim().toLowerCase();
      if (body.confirmed === false) {
        const { error } = await signupClient().auth.resend({ type: "signup", email, options: { emailRedirectTo: redirectTo } });
        if (!error) return { ok: true };
      }
      const { error: e2 } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
      if (e2) throw e2;
      return { ok: true };
    }
    if (method === "POST") {
      const email = String(body.email || "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Enter a valid email address.");
      const pw = Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, "0")).join("") + "Aa1!";
      const { data, error } = await signupClient().auth.signUp({ email, password: pw, options: { emailRedirectTo: redirectTo } });
      if (error && !/already|registered|exists/i.test(error.message || "")) throw error;
      const { data: ok, error: e2 } = await supabase.rpc("admin_set_user", { p_email: email, p_role: body.role, p_staff: body.staffName || "" });
      if (e2) throw e2;
      if (!ok) throw new Error("Supabase didn't create the login — check the email address and try again.");
      // If Supabase confirmed them straight away (email confirmation switched off), send a set-password email instead.
      if (data && data.session) { try { await signupClient().auth.signOut(); } catch {} await supabase.auth.resetPasswordForEmail(email, { redirectTo }); }
      return { ok: true };
    }
    if (method === "PATCH") {
      const { data: ok, error } = await supabase.rpc("admin_set_user", { p_email: body.email, p_role: body.role, p_staff: body.staffName || "" });
      if (error) throw error;
      if (!ok) throw new Error("Couldn't find that login.");
      return { ok: true };
    }
    if (method === "DELETE") {
      const { error } = await supabase.rpc("admin_delete_user", { p_id: body.id });
      if (error) throw error;
      return { ok: true };
    }
  } catch (e) { throw new Error(friendlyUsersErr(e)); }
  throw new Error("Unknown request");
}

function AuthShell({ title, children }) {
  return (
    <div style={{ minHeight: "100vh", background: "#EEF3F2", display: "flex", flexDirection: "column" }}>
      <header style={{ background: `linear-gradient(135deg, ${TEAL}, ${TEAL_D})`, padding: "13px 18px", display: "flex", alignItems: "center", gap: 11 }}>
        <div style={{ width: 40, height: 40, borderRadius: 11, background: "rgba(255,255,255,.16)", display: "flex", alignItems: "center", justifyContent: "center" }}><Icon name="truck" size={23} color="#fff" /></div>
        <div>
          <div style={{ fontSize: 16.5, fontWeight: 800, color: "#fff", lineHeight: 1.15 }}>{title || "Removals CRM"}</div>
          <div style={{ fontSize: 10, color: "#9DECDF", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".08em" }}>R&amp;J Removals &amp; Storage</div>
        </div>
      </header>
      <div style={{ flex: 1, padding: 18, display: "flex", justifyContent: "center" }}><div style={{ width: "100%", maxWidth: 420 }}>{children}</div></div>
    </div>
  );
}
function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  async function signIn(ev) {
    ev && ev.preventDefault();
    if (!email.trim() || !password) { setMsg("Enter your email and password."); return; }
    setBusy(true); setMsg("");
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) setMsg(/invalid/i.test(error.message) ? "That email and password don't match. Try again or tap 'Forgot password'." : error.message);
  }
  async function forgot() {
    if (!email.trim()) { setMsg("Type your email above first, then tap 'Forgot password'."); return; }
    setBusy(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: window.location.origin });
    setBusy(false);
    setMsg(error ? error.message : "Check your email — we've sent a link to set a new password.");
  }
  return (
    <AuthShell title="Sign in">
      <Card>
        <form onSubmit={signIn}>
          <Field label="Email"><Input type="email" value={email} onChange={setEmail} autoComplete="username" name="email" /></Field>
          <Field label="Password"><Input type="password" value={password} onChange={setPassword} autoComplete="current-password" name="password" /></Field>
          {msg && <div style={{ fontSize: 13, fontWeight: 600, color: /Check your email/.test(msg) ? "#15803D" : "#B91C1C", marginBottom: 10 }}>{msg}</div>}
          <Btn type="submit" style={{ width: "100%" }} disabled={busy}>{busy ? "Please wait…" : "Sign in"}</Btn>
        </form>
        <button onClick={forgot} style={{ marginTop: 12, background: "none", border: "none", color: TEAL, fontWeight: 700, fontSize: 13.5, cursor: "pointer", padding: 0 }}>Forgot password?</button>
      </Card>
    </AuthShell>
  );
}
function SetPasswordScreen({ onDone }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  async function save() {
    if (pw.length < 8) { setMsg("Use at least 8 characters."); return; }
    if (pw !== pw2) { setMsg("The two passwords don't match."); return; }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pw });
    setBusy(false);
    if (error) setMsg(error.message); else onDone();
  }
  return (
    <AuthShell title="Set your password">
      <Card>
        <div style={{ fontSize: 13.5, color: "#374151", marginBottom: 12 }}>Choose a password for your account. You'll use it with your email to sign in.</div>
        <Field label="New password"><Input type="password" value={pw} onChange={setPw} autoComplete="new-password" /></Field>
        <Field label="Type it again"><Input type="password" value={pw2} onChange={setPw2} autoComplete="new-password" /></Field>
        {msg && <div style={{ fontSize: 13, fontWeight: 600, color: "#B91C1C", marginBottom: 10 }}>{msg}</div>}
        <Btn style={{ width: "100%" }} disabled={busy} onClick={save}>{busy ? "Saving…" : "Save password"}</Btn>
      </Card>
    </AuthShell>
  );
}
function NoAccessScreen({ email }) {
  return (
    <AuthShell>
      <Card>
        <div style={{ fontWeight: 800, color: "#10211E", marginBottom: 6 }}>No access yet</div>
        <div style={{ fontSize: 13.5, color: "#374151", marginBottom: 14 }}>You're signed in as <b>{email}</b>, but your account hasn't been given a role yet. Ask Dave to set you up in Company → Users &amp; access.</div>
        <Btn variant="grey" style={{ width: "100%" }} onClick={signOutFlow}>Sign out</Btn>
      </Card>
    </AuthShell>
  );
}
function AccountCard() {
  const [pwOpen, setPwOpen] = useState(false);
  const [pw1, setPw1] = useState(""), [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false), [msg, setMsg] = useState("");
  async function changePw() {
    setMsg("");
    if (pw1.length < 8) { setMsg("Use at least 8 characters."); return; }
    if (pw1 !== pw2) { setMsg("The two passwords don't match."); return; }
    setBusy(true);
    try {
      // Make sure this device still has a live sign-in (it can lapse if the app sat open a long time).
      let { data: { session } } = await supabase.auth.getSession();
      if (!session) { const r = await supabase.auth.refreshSession(); session = r && r.data && r.data.session; }
      if (!session) throw new Error("SESSION_GONE");
      const { error } = await supabase.auth.updateUser({ password: pw1 });
      if (error) throw error;
      setPw1(""); setPw2(""); setPwOpen(false); alert("Password changed. Use the new one next time you sign in.");
    } catch (e) { setMsg(/SESSION_GONE|session missing|reauth|nonce|recent|jwt/i.test(e.message || "") ? "Your sign-in on this device has expired. Tap Sign out, sign back in, then change your password straight away." : (e.message || "Couldn't change it.")); }
    setBusy(false);
  }
  return (
    <Card style={{ marginBottom: 0 }}>
      <h4 style={{ margin: "0 0 8px", fontSize: 12, textTransform: "uppercase", letterSpacing: ".06em", color: "#94A4A0", fontWeight: 800 }}>Your account</h4>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0, flex: "1 1 180px" }}>
          <div style={{ fontWeight: 700, color: "#10211E", overflow: "hidden", textOverflow: "ellipsis" }}>{CURRENT_USER.email}</div>
          <div style={{ fontSize: 12.5, color: "#6A7B77" }}>{ROLE_LABEL[CURRENT_USER.role]}{CURRENT_USER.staffName ? ` · ${CURRENT_USER.staffName}` : ""}</div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {!pwOpen && <Btn size="sm" variant="grey" onClick={() => setPwOpen(true)}>Change password</Btn>}
          <Btn size="sm" variant="grey" onClick={signOutFlow}>Sign out</Btn>
        </div>
      </div>
      {pwOpen && (
        <div style={{ marginTop: 12, borderTop: "1px solid #EEF3F2", paddingTop: 12 }}>
          <Field label="New password"><Input type="password" value={pw1} onChange={setPw1} autoComplete="new-password" placeholder="At least 8 characters" /></Field>
          <Field label="Type it again"><Input type="password" value={pw2} onChange={setPw2} autoComplete="new-password" /></Field>
          {msg && <div style={{ fontSize: 12.5, color: "#B91C1C", fontWeight: 600, marginBottom: 8 }}>{msg}</div>}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 8 }}>
            <Btn variant="grey" style={{ width: "100%" }} onClick={() => { setPwOpen(false); setPw1(""); setPw2(""); setMsg(""); }}>Cancel</Btn>
            <Btn style={{ width: "100%" }} disabled={busy} onClick={changePw}>{busy ? "Saving…" : "Save new password"}</Btn>
          </div>
        </div>
      )}
    </Card>
  );
}
function UsersAdmin({ data }) {
  const [users, setUsers] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(null); // { id?, email, role, staffName }
  const staffNames = (data.staff || []).filter(s => s.active !== false).map(s => s.name).filter(Boolean);
  const load = async () => { setErr(""); try { const r = await usersApi("GET"); setUsers(r.users || []); } catch (e) { setErr(e.message); setUsers([]); } };
  useEffect(() => { load(); }, []);
  async function save() {
    if (!form.email.trim() && !form.id) { alert("Enter their email address."); return; }
    if (form.role === "crew" && !form.staffName) { alert("Pick which staff member this is — crew only see jobs they're booked on."); return; }
    setBusy(true);
    try {
      if (form.id) await usersApi("PATCH", { id: form.id, email: form.email, role: form.role, staffName: form.staffName });
      else await usersApi("POST", { email: form.email.trim(), role: form.role, staffName: form.staffName });
      setForm(null); await load();
      if (!form.id) alert(`Invite sent to ${form.email.trim()}. They'll get an email from Supabase — tapping the link opens the app and asks them to choose a password.`);
    } catch (e) { alert("Couldn't save: " + e.message); }
    setBusy(false);
  }
  async function remove(u) {
    if (!confirm(`Remove access for ${u.email}? They won't be able to sign in any more.`)) return;
    setBusy(true);
    try { await usersApi("DELETE", { id: u.id }); await load(); } catch (e) { alert("Couldn't remove: " + e.message); }
    setBusy(false);
  }
  async function resend(u) {
    setBusy(true);
    if (u.lastSignIn && !confirm(`Send ${u.email} an email with a link to set a new password?`)) { setBusy(false); return; }
    try { await usersApi("POST", { action: "resend", email: u.email, confirmed: u.confirmed }); alert(`Email sent to ${u.email}.`); } catch (e) { alert("Couldn't send: " + e.message); }
    setBusy(false);
  }
  const roleHelp = { admin: "Everything, including settings and deleting", office: "Everything except settings and deleting", surveyor: "Everything except settings and deleting", viewer: "Can see everything but can't change, add or delete anything", crew: "Only their own jobs for today, from 7:30am" };
  return (
    <Card style={{ marginBottom: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <h4 style={{ margin: 0, fontSize: 12, textTransform: "uppercase", letterSpacing: ".06em", color: "#94A4A0", fontWeight: 800 }}>Users &amp; access</h4>
        {!form && <Btn size="sm" onClick={() => setForm({ email: "", role: "viewer", staffName: "" })}>+ Add user</Btn>}
      </div>
      {err && <div style={{ fontSize: 12.5, color: "#B91C1C", fontWeight: 600, marginBottom: 8 }}>{err}</div>}
      {form && (
        <div style={{ border: "1px solid #E3E9E8", borderRadius: 12, padding: 12, marginBottom: 10, background: "#F7FAF9" }}>
          {!form.id && <Field label="Email"><Input type="email" value={form.email} onChange={v => setForm({ ...form, email: v })} placeholder="name@example.com" /></Field>}
          {form.id && <div style={{ fontWeight: 700, marginBottom: 10 }}>{form.email}</div>}
          <Field label="Role" hint={roleHelp[form.role]}><Select value={form.role} onChange={v => setForm({ ...form, role: v })} options={["admin", "office", "surveyor", "viewer", "crew"]} /></Field>
          <Field label="Staff member" hint="Their name in the change log. Crew must be linked — it's how they see their jobs.">
            <Select value={form.staffName} onChange={v => setForm({ ...form, staffName: v })} options={staffNames} placeholder="Not linked" />
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 8 }}>
            <Btn variant="grey" style={{ width: "100%" }} onClick={() => setForm(null)}>Cancel</Btn>
            <Btn style={{ width: "100%" }} disabled={busy} onClick={save}>{busy ? "Saving…" : form.id ? "Save" : "Send invite"}</Btn>
          </div>
        </div>
      )}
      {users === null && <div style={{ fontSize: 13, color: "#94A4A0" }}>Loading…</div>}
      {users && users.length === 0 && !err && <div style={{ fontSize: 13, color: "#94A4A0" }}>No users yet.</div>}
      {(users || []).map(u => (
        <div key={u.id} style={{ padding: "10px 0", borderTop: "1px solid #EEF3F2" }}>
          <div style={{ minWidth: 0, marginBottom: 7 }}>
            <div style={{ fontWeight: 700, color: "#10211E", fontSize: 14, overflow: "hidden", textOverflow: "ellipsis" }}>{u.email}</div>
            <div style={{ fontSize: 12, color: "#6A7B77" }}>{ROLE_LABEL[u.role] || "No role"}{u.staffName ? ` · ${u.staffName}` : ""} · {u.lastSignIn ? `last in ${fmtDateShort(u.lastSignIn.slice(0, 10))}` : "invited, not signed in yet"}</div>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <Btn size="sm" variant="grey" style={{ padding: "6px 10px" }} onClick={() => setForm({ id: u.id, email: u.email, role: u.role || "crew", staffName: u.staffName || "" })}>Edit</Btn>
            <Btn size="sm" variant="grey" style={{ padding: "6px 10px" }} onClick={() => resend(u)}>{u.lastSignIn ? "Reset password" : "Resend"}</Btn>
            {u.email !== CURRENT_USER.email && <Btn size="sm" variant="danger" style={{ padding: "6px 10px" }} onClick={() => remove(u)}>Remove</Btn>}
          </div>
        </div>
      ))}
    </Card>
  );
}

// ── Crew: just their jobs for today, shown from 7:30am ──
function CrewPreviewModal({ data, job, onClose }) {
  const stages = jobStages(job);
  return (
    <Modal title="What the crew see" onClose={onClose}>
      <div style={{ fontSize: 13, color: "#6A7B77", marginBottom: 10 }}>This is the job as porters and drivers see it on their phones (on the day, from 7:30am).</div>
      <div style={{ background: "#EEF3F2", borderRadius: 14, padding: 10 }}>
        {stages.length ? stages.map((st, i) => <CrewJobCard key={st.id || i} data={data} j={job} st={st} />) : <div style={{ fontSize: 13, color: "#94A4A0" }}>No days booked on this move yet.</div>}
      </div>
    </Modal>
  );
}
const CREW_OPENS_AT = "07:30";
function crewAddress(parts) { return parts.filter(Boolean).join(", "); }
function CrewJobCard({ data, j, st }) {
  const en = (data.enquiries || []).find(e => e.id === j.enquiryId) || {};
  const cust = (data.customers || []).find(c => c.id === j.customerId) || {};
  const phone = cust.phone || cust.homePhone || "";
  const vans = (st.vehicleIds || []).map(id => { const v = (data.vehicles || []).find(x => x.id === id); return v ? v.name : ""; }).filter(Boolean);
  const from = crewAddress([j.fromAddress1 || en.fromAddress1, j.fromAddress2 || en.fromAddress2, j.fromTown || en.fromTown, j.fromPostcode || en.fromPostcode]);
  const to = crewAddress([j.toAddress1 || en.toAddress1, j.toAddress2 || en.toAddress2, j.toTown || en.toTown, j.toPostcode || en.toPostcode]);
  const fromAccess = j.fromAccess || en.fromAccess, toAccess = j.toAccess || en.toAccess;
  const mapLink = a => `https://maps.apple.com/?q=${encodeURIComponent(a)}`;
  const inv = sortInventoryByRoom(Array.isArray(en.inventory) ? en.inventory : []);
  const rooms = []; const idx = {};
  inv.forEach(it => { const r = it.room || "Other"; if (!(r in idx)) { idx[r] = rooms.length; rooms.push([r, []]); } rooms[idx[r]][1].push(it); });
  // Packing days (Full Pack, 7 Hour Pack, Part Pack…) don't need the full inventory.
  const packDay = /pack/i.test(st.type || "") && !/unpack/i.test(st.type || "");
  const bedrooms = en.fromBedrooms || (() => { const n = new Set(inv.map(it => it.room).filter(r => /bedroom|^bed\s*\d/i.test(r || ""))).size; return n || ""; })();
  const disList = [
    ...inv.filter(it => it.dismantleNote).flatMap(it => String(it.raw || it.name || "").split(/\n/).map(x => x.trim()).filter(Boolean)),
    ...inv.filter(it => !it.dismantleNote && it.qty > 0 && it.dismantle).map(it => `${it.qty > 1 ? it.qty + " × " : ""}${it.name} (${it.room}) – ${it.dismantle}`),
  ];
  const H = ({ children }) => <div style={{ fontSize: 11, fontWeight: 800, color: "#94A4A0", textTransform: "uppercase", letterSpacing: ".06em", margin: "12px 0 4px" }}>{children}</div>;
  const Addr = ({ label, addr, access }) => addr ? (
    <div style={{ marginBottom: 6 }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: TEAL_D }}>{label}</div>
      <a href={mapLink(addr)} style={{ fontSize: 15, fontWeight: 700, color: "#10211E", textDecoration: "none" }}>📍 {addr}</a>
      {access && <div style={{ fontSize: 13, color: "#92400E", background: "#FFFBEB", borderRadius: 8, padding: "6px 9px", marginTop: 4 }}>⚠️ {access}</div>}
    </div>
  ) : null;
  return (
    <Card>
      <div style={{ fontSize: 11, fontWeight: 800, color: TEAL_D, textTransform: "uppercase", letterSpacing: ".05em" }}>{st.time ? `${st.time} · ` : ""}{st.type || "Move"}{volText(data, j) ? ` · 📦 ${volText(data, j)}` : ""}</div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, margin: "2px 0 8px" }}>
        <div style={{ fontSize: 18, fontWeight: 800, color: "#10211E" }}>{cust.name || "Customer"}</div>
        {phone && <a href={`tel:${phone}`} style={{ flexShrink: 0, padding: "8px 14px", borderRadius: 10, background: TEAL, color: "#fff", fontWeight: 800, fontSize: 14, textDecoration: "none" }}>📞 Call</a>}
      </div>
      <Addr label="FROM" addr={from} access={fromAccess} />
      {(en.extraFrom || []).map((x, i) => <Addr key={"ef" + i} label={`EXTRA PICKUP ${i + 2}${x.note ? " · " + x.note : ""}`} addr={crewAddress([x.address1, x.town, x.postcode])} />)}
      <Addr label={en.toStore ? "TO (STORE)" : "TO"} addr={to} access={toAccess} />
      {(en.extraTo || []).map((x, i) => <Addr key={"et" + i} label={`EXTRA DELIVERY ${i + 2}${x.note ? " · " + x.note : ""}`} addr={crewAddress([x.address1, x.town, x.postcode])} />)}
      <H>Van &amp; crew</H>
      <div style={{ fontSize: 14, color: "#10211E", fontWeight: 600 }}>🚚 {vans.join(", ") || "Van TBC"}</div>
      <div style={{ fontSize: 14, color: "#10211E", fontWeight: 600 }}>👷 {(st.crew || []).join(", ") || "—"}</div>
      {st.notes && <><H>Notes</H><div style={{ fontSize: 14, color: "#374151", whiteSpace: "pre-wrap" }}>{st.notes}</div></>}
      {packDay ? <>
        {/* Packing day: no full inventory — just what the packers need. */}
        <H>Packing</H>
        <div style={{ fontSize: 14, fontWeight: 800, color: "#10211E", background: "#F3FAF8", borderRadius: 9, padding: "7px 10px", marginBottom: 6 }}>🛏 {bedrooms ? `${bedrooms} bedroom${bedrooms === "1" || bedrooms === 1 ? "" : "s"}` : "Bedrooms not recorded"}{en.fromPropertyType ? ` · ${en.fromPropertyType}` : ""}</div>
        <div style={{ fontSize: 14, fontWeight: 800, color: "#10211E", background: "#F3FAF8", borderRadius: 9, padding: "7px 10px", marginBottom: 6 }}>👔 {hwBoxes(inv)} H/W boxes required</div>
        <CoversBox inv={inv} />
        <H>Dismantling</H>
        {disList.length === 0 ? <div style={{ fontSize: 13, color: "#94A4A0" }}>Nothing to dismantle.</div>
          : disList.map((t, i) => <div key={i} style={{ fontSize: 13.5, color: TEAL_D, fontWeight: 700, whiteSpace: "pre-wrap", marginBottom: 2 }}>🔧 {t}</div>)}
      </> : <>
      <H>Inventory</H>
      {hwBoxes(inv) > 0 && <div style={{ fontSize: 14, fontWeight: 800, color: "#10211E", background: "#F3FAF8", borderRadius: 9, padding: "7px 10px", marginBottom: 8 }}>👔 {hwBoxes(inv)} H/W boxes required</div>}
      <CoversBox inv={inv} />
      {rooms.length === 0 && <div style={{ fontSize: 13, color: "#94A4A0" }}>No inventory recorded.</div>}
      {rooms.map(([room, items]) => {
        const moving = items.filter(it => it.qty > 0 && !it.dismantleNote), staying = items.filter(it => it.qty < 0), dis = items.filter(it => it.dismantleNote);
        return (
          <div key={room} style={{ marginBottom: 8 }}>
            <div style={{ fontWeight: 800, color: "#10211E", fontSize: 14 }}>{room}</div>
            {moving.map((it, i) => it.freehand && !it.wardrobe
              ? <div key={i} style={{ fontSize: 13.5, color: "#374151", whiteSpace: "pre-wrap", paddingLeft: 8 }}>{it.raw || it.name}</div>
              : <div key={i} style={{ fontSize: 13.5, color: "#374151", paddingLeft: 8 }}>{it.qty} × {it.name}{it.dismantle ? <span style={{ color: TEAL_D, fontWeight: 700 }}> · dismantle ({it.dismantle})</span> : ""}</div>)}
            {dis.map((it, i) => <div key={"d" + i} style={{ fontSize: 13.5, color: TEAL_D, fontWeight: 700, paddingLeft: 8, whiteSpace: "pre-wrap" }}>🔧 {it.raw || it.name}</div>)}
            {staying.length > 0 && <div style={{ fontSize: 13, fontWeight: 800, color: "#DC2626", paddingLeft: 8, marginTop: 2 }}>NOT MOVING:</div>}
            {staying.map((it, i) => <div key={"s" + i} style={{ fontSize: 13.5, fontWeight: 800, color: "#DC2626", paddingLeft: 16 }}>{Math.abs(it.qty)} × {it.name}</div>)}
          </div>
        );
      })}
      </>}
      <JobSignOff j={j} st={st} cust={cust} from={from} to={to} />
    </Card>
  );
}

// ── Job sign-off (crew member + customer sign on the day) ───────────────────
// Saved on the job under signOffs[<day key>]. Crew logins can't edit jobs, so it goes through
// the crew_sign_off database function. No signal? It's kept on the phone and sent later.
const SIGNOFF_QUEUE = "removals_signoff_queue";
const signOffKey = st => String(st.id || `${st.date || ""}-${st.type || "move"}`);
const readSignQueue = () => { try { return JSON.parse(localStorage.getItem(SIGNOFF_QUEUE) || "[]"); } catch { return []; } };
const writeSignQueue = q => { try { localStorage.setItem(SIGNOFF_QUEUE, JSON.stringify(q)); } catch {} };
// Sent ones are remembered on the phone too, so the sign-off still shows before the next sync.
const SIGNOFF_SENT = "removals_signoff_sent";
const readSignSent = () => { try { return JSON.parse(localStorage.getItem(SIGNOFF_SENT) || "[]"); } catch { return []; } };
const rememberSent = item => { try { localStorage.setItem(SIGNOFF_SENT, JSON.stringify([...readSignSent().filter(x => !(x.jobId === item.jobId && x.key === item.key)), item].slice(-30))); } catch {} };
async function sendSignOff(item) {
  const { error } = await supabase.rpc("crew_sign_off", { p_job: String(item.jobId), p_stage: item.key, p_data: item.data });
  if (error && !/already signed/i.test(error.message || "")) throw new Error(error.message || "Couldn't save");
  rememberSent(item);
}
async function flushSignOffs() {
  const q = readSignQueue(); if (!q.length) return;
  const left = [];
  for (const it of q) { try { await sendSignOff(it); } catch { left.push(it); } }
  writeSignQueue(left);
}
const isPackDay = st => /pack/i.test((st && st.type) || "") && !/unpack/i.test((st && st.type) || "");
// Is this the job's last day? (latest date; same date → the later one in the list)
function isLastJobDay(j, st) {
  const days = jobStages(j).filter(Boolean);
  if (days.length < 2) return true;
  let last = days[0];
  days.forEach(d => { if (String(d.date || "") >= String(last.date || "")) last = d; });
  return signOffKey(last) === signOffKey(st);
}
function JobSignOff({ j, st, cust, from = "", to = "" }) {
  const key = signOffKey(st);
  const [saved, setSaved] = useState(null);
  const done = (j.signOffs && j.signOffs[key]) || saved || ([...readSignQueue(), ...readSignSent()].find(x => x.jobId === j.id && x.key === key) || {}).data;
  const [open, setOpen] = useState(false);
  const [staffName, setStaffName] = useState(CURRENT_USER.staffName || "");
  const [staffSig, setStaffSig] = useState("");
  const [custName, setCustName] = useState(cust.name || "");
  const [custSig, setCustSig] = useState("");
  const [notes, setNotes] = useState("");
  const [signing, setSigning] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const crewNames = (st.crew || []).filter(Boolean);
  const box = { marginTop: 14, paddingTop: 12, borderTop: "1px solid #E5ECEA" };
  if (done) {
    const when = done.at ? new Date(done.at) : null;
    return (
      <div style={box}>
        <div style={{ fontSize: 11, fontWeight: 800, color: "#059669", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6 }}>✅ Job signed off{when ? ` · ${fmtDate(when.toISOString().slice(0, 10))} ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}` : ""}</div>
        {done.notes ? <div style={{ fontSize: 13, color: "#B45309", background: "#FFFBEB", borderRadius: 8, padding: "6px 9px", marginBottom: 8, whiteSpace: "pre-wrap" }}>📝 {done.notes}</div> : null}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {[["Staff", done.staffName, done.staffSig], ["Customer", done.custName, done.custSig]].map(([l, n, sg]) => (
            <div key={l}>
              <div style={{ fontSize: 11.5, color: "#6A7B77", fontWeight: 700 }}>{l}: {n || "-"}</div>
              {sg ? <img src={sg} alt={`${l} signature`} style={{ width: "100%", maxHeight: 70, objectFit: "contain", border: "1px solid #E5ECEA", borderRadius: 8, background: "#fff" }} /> : null}
            </div>
          ))}
        </div>
        {msg ? <div style={{ fontSize: 12, color: "#B45309", marginTop: 6 }}>{msg}</div> : null}
      </div>
    );
  }
  if (isReadOnly()) return null;
  // Signed off once, on the last day of the job only (never on a packing day).
  if (isPackDay(st) || !isLastJobDay(j, st)) return null;
  if (!open) return (
    <div style={box}>
      <button type="button" data-ro-ok onClick={() => setOpen(true)} style={{ width: "100%", padding: "13px 12px", borderRadius: 12, border: "none", background: TEAL, color: "#fff", fontWeight: 800, fontSize: 15.5, cursor: "pointer" }}>✍️ Sign off job</button>
    </div>
  );
  const save = async () => {
    setMsg("");
    if (!staffName.trim() || !staffSig) { setMsg("The crew member needs to put their name and sign."); return; }
    if (!custName.trim() || !custSig) { setMsg("The customer needs to put their name and sign."); return; }
    const item = { jobId: j.id, key, data: { staffName: staffName.trim(), staffSig, custName: custName.trim(), custSig, notes: notes.trim(), at: new Date().toISOString(), date: st.date || "", by: CURRENT_USER.email || "" } };
    setBusy(true);
    try { await sendSignOff(item); setSaved(item.data); }
    catch (ex) {
      if (/not booked|not allowed|function|does not exist/i.test(ex.message || "")) { setMsg("Couldn't save: " + ex.message); setBusy(false); return; }
      writeSignQueue([...readSignQueue().filter(x => !(x.jobId === j.id && x.key === key)), item]);
      setSaved(item.data);
    }
    setBusy(false);
  };
  const lbl = { fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 4 };
  const inp = { width: "100%", boxSizing: "border-box", padding: "11px 12px", border: "1px solid #D9E2E0", borderRadius: 10, fontSize: 16, marginBottom: 10, background: "#fff", color: "#10211E" };
  // Opens on its own screen, so the customer only sees the address and the sign-off —
  // not the crew, vans, inventory or notes.
  return (
    <Modal title="Job sign-off" onClose={() => setOpen(false)}>
    <div data-ro-ok>
      <div style={{ background: "#F3FAF8", borderRadius: 10, padding: "9px 11px", marginBottom: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: "#10211E" }}>{cust.name || "Customer"}</div>
        <div style={{ fontSize: 12.5, color: "#6A7B77", fontWeight: 600 }}>{st.date ? fmtDate(st.date) : ""}</div>
        {from ? <div style={{ fontSize: 13, color: "#374151", marginTop: 4 }}><b>From:</b> {from}</div> : null}
        {to ? <div style={{ fontSize: 13, color: "#374151", marginTop: 2 }}><b>To:</b> {to}</div> : null}
      </div>
      <div style={lbl}>Crew member</div>
      {crewNames.length > 1 && !CURRENT_USER.staffName
        ? <select value={staffName} onChange={e => setStaffName(e.target.value)} style={inp}><option value="">Choose…</option>{crewNames.map(n => <option key={n}>{n}</option>)}</select>
        : <input value={staffName} onChange={e => setStaffName(e.target.value)} placeholder="Name" style={inp} />}
      <SigField label="Crew member signature" value={staffSig} onOpen={() => setSigning("staff")} />
      <div style={{ fontSize: 13, color: "#374151", background: "#F3FAF8", borderRadius: 10, padding: "9px 11px", margin: "4px 0 10px" }}>I confirm the move has been completed and my belongings have been delivered in good order.</div>
      <div style={lbl}>Comments (optional)</div>
      <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Any comments…" style={{ ...inp, resize: "vertical" }} />
      <div style={lbl}>Customer name</div>
      <input value={custName} onChange={e => setCustName(e.target.value)} placeholder="Name" style={inp} />
      <SigField label="Customer signature" value={custSig} onOpen={() => setSigning("cust")} />
      {msg ? <div style={{ fontSize: 13, color: "#B91C1C", background: "#FEF2F2", borderRadius: 8, padding: "7px 10px", marginBottom: 8 }}>{msg}</div> : null}
      <div style={{ display: "flex", gap: 8 }}>
        <Btn variant="grey" style={{ flex: 1 }} onClick={() => setOpen(false)}>Cancel</Btn>
        <Btn style={{ flex: 2 }} disabled={busy} onClick={save}>{busy ? "Saving…" : "Save sign-off"}</Btn>
      </div>
      {signing === "staff" && <SignatureModal title={`Crew signature${staffName ? " — " + staffName : ""}`} initial={staffSig} onCancel={() => setSigning(null)} onAccept={v => { setStaffSig(v); setSigning(null); }} />}
      {signing === "cust" && <SignatureModal title={`Customer signature${custName ? " — " + custName : ""}`} initial={custSig} onCancel={() => setSigning(null)} onAccept={v => { setCustSig(v); setSigning(null); }} />}
    </div>
    </Modal>
  );
}
// ── Saved sign-off (office record): just the job address and the sign-off itself ──
function signOffParts(data, j) {
  const en = (data.enquiries || []).find(e => e.id === j.enquiryId) || {};
  const cust = (data.customers || []).find(c => c.id === j.customerId) || {};
  const from = crewAddress([j.fromAddress1 || en.fromAddress1, j.fromAddress2 || en.fromAddress2, j.fromTown || en.fromTown, j.fromPostcode || en.fromPostcode]);
  const to = crewAddress([j.toAddress1 || en.toAddress1, j.toAddress2 || en.toAddress2, j.toTown || en.toTown, j.toPostcode || en.toPostcode]);
  const list = Object.values(j.signOffs || {}).filter(Boolean).sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
  return { cust, from, to, list, ref: moveRef(data, j) };
}
const signOffWhen = so => { const d = so.at ? new Date(so.at) : null; return d && !isNaN(d) ? `${fmtUK(d.toISOString().slice(0, 10))} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : (so.date ? fmtUK(so.date) : ""); };
async function buildSignOffPdf(data, j) {
  const { cust, from, to, list, ref } = signOffParts(data, j);
  const { PDFDocument, StandardFonts, rgb } = await loadPdfLib();
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = 595.28, H = 841.89, M = 44;
  const teal = rgb(0.055, 0.486, 0.451), navy = rgb(0.059, 0.18, 0.165), grey = rgb(0.42, 0.46, 0.45), white = rgb(1, 1, 1);
  const clean = t => String(t == null ? "" : t).replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2013\u2014]/g, "-").replace(/\u2026/g, "...").replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, "");
  const embedSig = async url => { if (!url || url.indexOf("data:image") !== 0) return null; try { const bin = atob(url.split(",")[1]); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); return /image\/jpe?g/.test(url) ? await pdf.embedJpg(bytes) : await pdf.embedPng(bytes); } catch { return null; } };
  const wrap = (t, size, f, maxW) => { const words = clean(t).split(/\s+/); const out = []; let ln = ""; for (const w of words) { const test = ln ? ln + " " + w : w; if (f.widthOfTextAtSize(test, size) > maxW && ln) { out.push(ln); ln = w; } else ln = test; } if (ln) out.push(ln); return out; };
  let page = pdf.addPage([W, H]); let y;
  const at = (t, x, yy, size, f = font, col = navy) => page.drawText(clean(t), { x, y: yy, size, font: f, color: col });
  page.drawRectangle({ x: 0, y: H - 66, width: W, height: 66, color: teal });
  at("R&J Removals & Storage", M, H - 34, 16, bold, white);
  at("Job sign-off", M, H - 51, 11, font, rgb(0.88, 0.96, 0.94));
  if (ref) { const w = bold.widthOfTextAtSize(clean(ref), 12); at(ref, W - M - w, H - 40, 12, bold, white); }
  y = H - 96;
  at("Customer", M, y, 9.5, bold, grey); at(cust.name || "-", M + 80, y, 9.5); y -= 15;
  [["From", from], ["To", to]].forEach(([l, a]) => { if (!a) return; at(l, M, y, 9.5, bold, grey); wrap(a, 9.5, font, W - M - (M + 80)).forEach(ln => { at(ln, M + 80, y, 9.5); y -= 13; }); y -= 2; });
  y -= 10;
  for (const so of list) {
    if (y < 260) { page = pdf.addPage([W, H]); y = H - M; }
    at(`Signed off ${signOffWhen(so)}`, M, y, 11, bold, teal); y -= 8;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1, color: teal }); y -= 16;
    wrap("I confirm the move has been completed and my belongings have been delivered in good order.", 9.5, font, W - 2 * M).forEach(ln => { at(ln, M, y, 9.5); y -= 13; });
    if (so.notes) { y -= 4; at("Comments", M, y, 9.5, bold, grey); y -= 13; wrap(so.notes, 9.5, font, W - 2 * M).forEach(ln => { at(ln, M, y, 9.5); y -= 13; }); }
    y -= 10;
    const boxW = (W - 2 * M - 20) / 2, boxH = 80;
    const sigs = [["Crew member", so.staffName, await embedSig(so.staffSig)], ["Customer", so.custName, await embedSig(so.custSig)]];
    sigs.forEach(([l, n, img], i) => {
      const x = M + i * (boxW + 20);
      page.drawRectangle({ x, y: y - boxH, width: boxW, height: boxH, borderColor: grey, borderWidth: 0.6 });
      if (img) { const s0 = Math.min((boxW - 12) / img.width, (boxH - 12) / img.height); page.drawImage(img, { x: x + 6, y: y - boxH + 6, width: img.width * s0, height: img.height * s0 }); }
      at(`${l}: ${n || "-"}`, x, y - boxH - 13, 9, bold, grey);
    });
    y -= boxH + 36;
  }
  if (!list.length) at("Not signed off yet.", M, y, 9.5);
  return await pdf.save();
}
function SignOffRecordModal({ data, job, onClose }) {
  const { cust, from, to, list, ref } = signOffParts(data, job);
  const [busy, setBusy] = useState(false);
  const pdfIt = async () => {
    setBusy(true);
    try { const bytes = await buildSignOffPdf(data, job); await showPdf(new File([bytes], `SignOff-${String(ref).replace(/[^\w-]+/g, "")}.pdf`, { type: "application/pdf" })); }
    catch (ex) { alert("Couldn't make the PDF: " + (ex.message || ex)); }
    setBusy(false);
  };
  return (
    <Modal title="Job sign-off" onClose={onClose}>
      <div style={{ background: "#F3FAF8", borderRadius: 10, padding: "9px 11px", marginBottom: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: "#10211E" }}>{cust.name || "Customer"} <span style={{ fontSize: 12.5, color: "#6A7B77" }}>· {ref}</span></div>
        {from ? <div style={{ fontSize: 13, color: "#374151", marginTop: 4 }}><b>From:</b> {from}</div> : null}
        {to ? <div style={{ fontSize: 13, color: "#374151", marginTop: 2 }}><b>To:</b> {to}</div> : null}
      </div>
      {list.map((so, i) => (
        <div key={i} style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11.5, fontWeight: 800, color: "#059669", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6 }}>✅ Signed off · {signOffWhen(so)}</div>
          {so.notes ? <div style={{ fontSize: 13, color: "#374151", background: "#F9FAFB", borderRadius: 8, padding: "6px 9px", marginBottom: 8, whiteSpace: "pre-wrap" }}>📝 {so.notes}</div> : null}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {[["Crew member", so.staffName, so.staffSig], ["Customer", so.custName, so.custSig]].map(([l, n, sg]) => (
              <div key={l}>
                <div style={{ fontSize: 11.5, color: "#6A7B77", fontWeight: 700 }}>{l}: {n || "-"}</div>
                {sg ? <img src={sg} alt={`${l} signature`} style={{ width: "100%", maxHeight: 80, objectFit: "contain", border: "1px solid #E5ECEA", borderRadius: 8, background: "#fff" }} /> : null}
              </div>
            ))}
          </div>
        </div>
      ))}
      <Btn variant="grey" style={{ width: "100%" }} disabled={busy} onClick={pdfIt}>{busy ? "Making PDF…" : "📄 PDF (if the customer asks for a copy)"}</Btn>
    </Modal>
  );
}
function CrewApp() {
  const [data, setData] = useState(loadData);
  const [, setSyncStatus] = useState("");
  const [, setTick] = useState(0);
  useEffect(() => {
    const pull = force => flushSignOffs().catch(() => {}).then(() => doPullSync(setData, setSyncStatus, force ? { force: true } : undefined));
    pull(true);
    const i = setInterval(() => { setTick(t => t + 1); pull(false); }, 60000);
    const f = () => { setTick(t => t + 1); pull(true); };
    window.addEventListener("focus", f);
    document.addEventListener("visibilitychange", f);
    return () => { clearInterval(i); window.removeEventListener("focus", f); document.removeEventListener("visibilitychange", f); };
  }, []);
  const now = new Date();
  const hm = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
  const today = todayISO();
  const me = (CURRENT_USER.staffName || "").trim().toLowerCase();
  const mine = !me ? [] : (data.jobs || [])
    .filter(j => ["Confirmed", "Completed", "Booked", "In Progress"].includes(j.status))
    .flatMap(j => jobStages(j).filter(st => st.date === today && (st.crew || []).some(c => String(c).trim().toLowerCase() === me)).map(st => ({ j, st })))
    .sort((a, b) => (a.st.time || "99").localeCompare(b.st.time || "99"));
  return (
    <div style={{ height: "100%", overflowY: "auto", WebkitOverflowScrolling: "touch", overscrollBehavior: "contain", background: "#EEF3F2" }}>
      <ResponsiveStyles device="phone" />
      <UpdateNotice />
      <header style={{ position: "sticky", top: 0, zIndex: 5, background: `linear-gradient(135deg, ${TEAL}, ${TEAL_D})`, padding: "13px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 11 }}>
        <div>
          <div style={{ fontSize: 16.5, fontWeight: 800, color: "#fff", lineHeight: 1.15 }}>Today's jobs</div>
          <div style={{ fontSize: 10, color: "#9DECDF", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".08em" }}>{fmtDate(today)} ({dow(today)}){CURRENT_USER.staffName ? ` · ${CURRENT_USER.staffName}` : ""}</div>
        </div>
        <button onClick={signOutFlow} style={{ background: "rgba(255,255,255,.16)", color: "#fff", border: "none", borderRadius: 10, padding: "8px 12px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>Sign out</button>
      </header>
      <div style={{ padding: 16, maxWidth: 640, margin: "0 auto" }}>
        {!me ? <Card><div style={{ fontWeight: 700 }}>Your login isn't linked to a staff member yet.</div><div style={{ fontSize: 13, color: "#6A7B77", marginTop: 4 }}>Ask Dave to link you in Company → Users &amp; access.</div></Card>
          : hm < CREW_OPENS_AT ? <Card style={{ textAlign: "center", padding: "30px 18px" }}><div style={{ fontSize: 34 }}>🕢</div><div style={{ fontWeight: 800, fontSize: 16, marginTop: 6 }}>Your jobs for today will appear at 7:30am</div><div style={{ fontSize: 13, color: "#6A7B77", marginTop: 4 }}>Check back then.</div></Card>
          : mine.length === 0 ? <Card style={{ textAlign: "center", padding: "30px 18px" }}><div style={{ fontWeight: 800, fontSize: 16 }}>No jobs for you today</div><div style={{ fontSize: 13, color: "#6A7B77", marginTop: 4 }}>If you think that's wrong, ring the office.</div></Card>
          : mine.map(({ j, st }, i) => <CrewJobCard key={(j.id || "") + (st.id || i)} data={data} j={j} st={st} />)}
      </div>
    </div>
  );
}

// ── The gate: login → set password (invites) → the right app for your role ──
// Logins are built but switched OFF until Dave is ready to set them up.
const LOGINS_ENABLED = true;
function AuthGate() {
  if (!LOGINS_ENABLED) return <MainApp />;
  return <AuthGateInner />;
}
function AuthGateInner() {
  const [session, setSession] = useState(undefined); // undefined = still checking
  const [needPw, setNeedPw] = useState(NEEDS_PASSWORD);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const sess = (data && data.session) || null;
      setSession(sess);
      // Pick up any role change made by an admin since this device last signed in.
      if (sess && navigator.onLine !== false) supabase.auth.refreshSession().then(r => { if (r && r.data && r.data.session) setSession(r.data.session); }).catch(() => {});
    }).catch(() => setSession(null));
    const { data: sub } = supabase.auth.onAuthStateChange((event, sess) => {
      if (event === "PASSWORD_RECOVERY") setNeedPw(true);
      setSession(sess || null);
    });
    return () => { try { sub.subscription.unsubscribe(); } catch {} };
  }, []);
  if (session === undefined) return <AuthShell><div style={{ textAlign: "center", color: "#6A7B77", marginTop: 40 }}>Loading…</div></AuthShell>;
  if (!session) return <LoginScreen />;
  if (needPw) return <SetPasswordScreen onDone={() => { setNeedPw(false); try { window.history.replaceState(null, "", window.location.pathname); } catch {} }} />;
  const user = session.user || {};
  const md = user.app_metadata || {};
  if (!ROLE_LABEL[md.role]) return <NoAccessScreen email={user.email} />;
  // Someone different on this device? Start them with a clean copy of the data.
  try {
    const owner = localStorage.getItem("removals_owner");
    if (owner && owner !== user.id) clearAppData();
    localStorage.setItem("removals_owner", user.id);
  } catch {}
  CURRENT_USER = { role: md.role, email: user.email || "", staffName: md.staff_name || "" };
  return md.role === "crew" ? <CrewApp /> : <MainApp />;
}
export default AuthGate;

function ReadOnlyStyles() { return isReadOnly() ? <style>{RO_CSS}</style> : null; }
function ReadOnlyBanner() {
  return <div style={{ background: "#F3F4F6", border: "1px solid #E5E7EB", color: "#4B5563", borderRadius: 10, padding: "8px 12px", fontSize: 12.5, fontWeight: 700, marginBottom: 12 }}>👁 Read-only access — you can look at everything but can't change anything.</div>;
}
// Imported Mover notes: keep only the survey notes (blank if there were none).
function moverSurveyNotes(notes) {
  const t = String(notes || "");
  if (!t.startsWith("Imported from Mover")) return null; // not an imported note, leave alone
  const part = t.split(/\n\n/).find(x => /^\s*Mover status:.*?Survey notes:|^\s*Survey notes:/s.test(x)) || "";
  const m = part.match(/Survey notes:\s*([\s\S]*)$/);
  return m ? m[1].trim() : "";
}
function tidyMoverNotes() {
  if (isReadOnly() || CURRENT_USER.role === "crew") return null;
  const d = loadData(); let changed = false;
  const enquiries = (d.enquiries || []).map(e => {
    let x = e;
    const n = moverSurveyNotes(x.notes);
    if (n !== null) x = { ...x, notes: n };
    // Imported Mover quotes were all chased in Mover already: no chase reminders unless you set one.
    // (Some devices got these without that flag, so the PC showed 200+ "Chase quote" jobs.)
    if (String(x.id || "").startsWith("mvr-e-") && !x.noChase && !x.quoteChasedAt && !x.quoteChaseDate && x.quoteStatus === "Sent" && String(x.quoteSentDate || "") < "2026-11-10") x = { ...x, noChase: true };
    if (x === e) return e;
    changed = true; return { ...x, updatedAt: Date.now() };
  });
  return changed ? { ...d, enquiries } : null;
}
function MainApp() {
  const [data, setData] = useState(loadData);
  const [view, setViewState] = useState(() => {
    try { const v = JSON.parse(sessionStorage.getItem("removals_view")); if (v && v.screen) { if (v.screen === "jobs" || v.screen === "jobDetail") return { screen: "enquiries", filter: "Won" }; return v; } } catch {}
    return { screen: "dashboard" };
  });
  const [syncStatus, setSyncStatus] = useState("syncing");
  const [catalog, setCatalogState] = useState(() => { const l = loadLocalCatalog(); if (l) applyCatalog(l); return l || buildDefaultCatalog(); });
  const device = useDeviceType();
  const wide = device !== "phone";
  const [layout, setLayout] = useState(getLayout);
  const fmLayout = wide && layout === "filemaker";

  // One-off tidy: imported Mover enquiries keep only their survey notes in the Notes field.
  useEffect(() => {
    const t = setTimeout(async () => {
      const d2 = tidyMoverNotes(); if (!d2) return;
      const stamped = stampData(d2); setDB(JSON.stringify(stamped)); setData(stamped);
      try { await pushChangedOnly(stamped); } catch {}
    }, 6000);
    return () => clearTimeout(t);
  }, []);

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
    try { const r = sessionStorage.getItem("importRefMsg"); if (r) { sessionStorage.removeItem("importRefMsg"); if (m) m += `\n\nThe next new customer will be #${r}.`; } } catch {}
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
        const cloud = await pullCloud();
        if (cancelled) return;
        const merged = autoCompletePastMoves(mergeAll(cloud, loadData()));
        setDB(JSON.stringify(merged));
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
  const missedCount = missedSurveys(data).length;
  const navBadge = id => id === "enquiries" && missedCount > 0
    ? <span style={{ position: "absolute", top: 4, left: "calc(50% + 6px)", minWidth: 18, height: 18, padding: "0 5px", borderRadius: 99, background: "#DC2626", color: "#fff", fontSize: 11, fontWeight: 800, lineHeight: "18px", textAlign: "center", boxShadow: "0 0 0 2px #fff" }}>{missedCount}</span>
    : null;
  const sectionKey = sectionFor(view.screen);
  const activeTab = view.screen === "reports" ? "company" : ["dashboard", "calendar", "company", "storage"].includes(view.screen) ? view.screen : (sectionKey || "dashboard");

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
    if (view.screen === "reports") return (CURRENT_USER.role === "crew" ? null : <div><Btn variant="grey" size="sm" style={{ marginBottom: 12 }} onClick={() => setView({ screen: "company" })}>‹ Company</Btn><ReportsView data={data} /></div>);
    if (view.screen === "catalogue") return <CatalogueEditor catalog={catalog} onSave={applyCatalogEdit} setView={setView} />;
    if (view.screen === "storage") return <StorageView data={data} setView={setView} />;
    if (view.screen === "storageIntake") return <StorageIntakeForm data={data} setView={setView} presetCustomerId={view.customerId} editRecId={view.editRecId} presetJobId={view.jobId} />;
    if (view.screen === "storageCollect") return <PartCollectionForm data={data} setView={setView} recId={view.recId} />;
    if (view.screen === "storageJob") return <StorageJobDetail data={data} setView={setView} customerId={view.customerId} jobId={view.jobId} />;
    return null;
  }

  function content() {
    const full = fullScreen();
    if (full) return <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}><div style={{ padding: wide ? "24px 26px 40px" : "16px 16px 90px", maxWidth: 1080, margin: "0 auto" }}>{isReadOnly() && <ReadOnlyBanner />}{full}</div></div>;
    const sec = SECTIONS[sectionKey];
    if (!sec) return null;
    const { List, Detail } = sec;
    const detailId = view.screen === sec.detail ? view.id : null;
    // FileMaker layout: an open enquiry fills the whole screen (no list beside it).
    if (fmLayout && sectionKey === "enquiries" && detailId) {
      return <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "18px 20px 40px" }}>{isReadOnly() && <ReadOnlyBanner />}<EnquiryDetail data={data} id={detailId} setView={setView} fm /></div>;
    }
    // FileMaker layout: the enquiries list uses the whole screen too (no empty pane beside it).
    if (fmLayout && sectionKey === "enquiries") {
      return <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "18px 20px 40px" }}><div style={{ maxWidth: 900, margin: "0 auto" }}><List data={data} setView={setView} initialFilter={view.filter} /></div></div>;
    }
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
        <ReadOnlyStyles />
        <UpdateNotice />
        <aside style={{ width: 244, flexShrink: 0, background: "#fff", borderRight: "1px solid #E9EEED", display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "22px 18px 18px" }}>
            <div style={{ width: 44, height: 44, borderRadius: 13, background: `linear-gradient(145deg, ${TEAL}, ${TEAL_D})`, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 6px 16px rgba(14,124,115,.32)" }}>
              <Icon name="truck" size={25} color="#fff" />
            </div>
            <div>
              <div style={{ fontSize: 15.5, fontWeight: 800, letterSpacing: "-.02em", lineHeight: 1.1 }}>Removals CRM</div>
              <div style={{ fontSize: 10, color: "#94A4A0", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".09em" }}>Enquiries &amp; moves</div>
              <div onClick={() => { if (confirm("Check for a newer version of the app?")) updateAppNow(); }} style={{ fontSize: 10, color: "#94A4A0", fontWeight: 600, letterSpacing: ".02em", marginTop: 1, cursor: "pointer" }}>{BUILD_LABEL.split(" (")[0]} ↻</div>
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
                  {n.id === "enquiries" && missedCount > 0 && <span style={{ marginLeft: "auto", minWidth: 20, height: 20, padding: "0 6px", borderRadius: 99, background: "#DC2626", color: "#fff", fontSize: 11.5, fontWeight: 800, lineHeight: "20px", textAlign: "center" }}>{missedCount}</span>}
                </button>
              );
            })}
          </nav>
          <div style={{ marginTop: "auto", padding: "12px 14px 0" }}>
            <div style={{ fontSize: 10.5, fontWeight: 800, color: "#94A4A0", textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 5 }}>Customer screen layout</div>
            <div data-ro-ok style={{ display: "flex", background: "#EEF3F2", borderRadius: 10, padding: 3, gap: 3 }}>
              {[["classic", "Classic"], ["filemaker", "FileMaker"]].map(([k, l]) => (
                <button key={k} type="button" data-ro-ok onClick={() => {
                  setLayoutPref(k); setLayout(k);
                  // Show the change straight away: FileMaker opens the enquiries screen.
                  if (k === "filemaker" && sectionFor(view.screen) !== "enquiries") setView({ screen: "enquiries" });
                }} style={{ flex: 1, height: 36, border: "none", borderRadius: 8, fontFamily: "inherit", fontSize: 13, fontWeight: layout === k ? 800 : 600, cursor: "pointer", background: layout === k ? "#fff" : "transparent", color: layout === k ? TEAL : "#6A7B77", boxShadow: layout === k ? "0 1px 3px rgba(16,33,30,.15)" : "none" }}>{l}</button>
              ))}
            </div>
          </div>
          <div style={{ marginTop: 10, padding: "14px 18px", borderTop: "1px solid #E9EEED", display: "flex", alignItems: "center", gap: 9, fontSize: 12, color: "#6A7B77", fontWeight: 600 }}>
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
      <ReadOnlyStyles />
      <UpdateNotice />
      <style>{".rm-page-title{display:none!important}"}</style>
      <header style={{ background: `linear-gradient(135deg, ${TEAL}, ${TEAL_D})`, padding: "13px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
          <div style={{ width: 40, height: 40, borderRadius: 11, background: "rgba(255,255,255,.16)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Icon name="truck" size={23} color="#fff" />
          </div>
          <div>
            <div style={{ fontSize: 16.5, fontWeight: 800, color: "#fff", letterSpacing: "-.02em", lineHeight: 1.15 }}>{PAGE_TITLES[view.screen] || "Removals CRM"}</div>
            <div style={{ fontSize: 10, color: "#9DECDF", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".08em" }}>{PAGE_TITLES[view.screen] ? "Removals CRM" : <>Enquiries &amp; moves</>}<span onClick={() => { if (confirm("Check for a newer version of the app?")) updateAppNow(); }} style={{ textTransform: "none", letterSpacing: 0, opacity: .8, fontWeight: 600, cursor: "pointer" }}> · {BUILD_LABEL.split(" (")[0]} ↻</span></div>
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
            <button key={n.id} onClick={() => setView({ screen: n.id })} style={{ position: "relative", flex: 1, padding: "11px 0 16px", background: "transparent", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
              {navBadge(n.id)}
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
