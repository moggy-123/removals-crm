import { useState, useEffect, useCallback, useMemo } from "react";
import { pullFromCloud, pushToCloud, pushOne, deleteRecord, supabase } from "./supabase";
import { FURNITURE, ROOMS, recommendVehicle } from "./furniture";

const DB_KEY = "removals_data";
const SIG_KEY = "removals_sigs";
const TOMB_KEY = "removals_deleted";
const TABLES = ["customers", "enquiries", "jobs"];
const EMPTY = { customers: [], enquiries: [], jobs: [] };

// Brand
const TEAL = "#0F766E", NAVY = "#134E4A", AMBER = "#F59E0B";

const ENQUIRY_STATUSES = ["New", "Surveyed", "Quoted", "Won", "Lost"];
const JOB_STATUSES = ["Booked", "In Progress", "Completed"];
const PROPERTY_TYPES = ["House", "Flat / Apartment", "Bungalow", "Maisonette", "Office", "Storage Unit", "Other"];
const QUOTE_STATUSES = ["Draft", "Sent", "Accepted", "Declined"];

const STATUS_META = {
  New:         { color: "#2563EB", bg: "#EFF6FF" },
  Surveyed:    { color: "#0891B2", bg: "#ECFEFF" },
  Quoted:      { color: "#D97706", bg: "#FFFBEB" },
  Won:         { color: "#059669", bg: "#ECFDF5" },
  Lost:        { color: "#DC2626", bg: "#FEF2F2" },
  Booked:      { color: "#2563EB", bg: "#EFF6FF" },
  "In Progress": { color: "#D97706", bg: "#FFFBEB" },
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

// Push only changed/new records (compared against last-synced signatures)
async function pushChangedOnly(data) {
  let sigs = {};
  try { sigs = JSON.parse(localStorage.getItem(SIG_KEY) || "{}"); } catch {}
  let failed = 0, lastError = "";
  const newSigs = {};
  for (const name of TABLES) {
    for (const rec of data[name] || []) {
      const sig = JSON.stringify(rec);
      if (sigs[rec.id] !== sig) {
        try {
          await pushOne(name, rec);
          newSigs[rec.id] = sig; // record signature ONLY after success
        } catch (e) {
          failed++; lastError = e?.message || JSON.stringify(e);
          if (sigs[rec.id]) newSigs[rec.id] = sigs[rec.id]; // keep old so we retry
        }
      } else {
        newSigs[rec.id] = sig;
      }
    }
  }
  try { localStorage.setItem(SIG_KEY, JSON.stringify(newSigs)); } catch {}
  if (failed > 0) throw new Error(`${failed} record(s) failed to sync. Last error: ${lastError}`);
}

// Replace or insert a record into the right table, return new data object
function upsertLocal(data, table, record) {
  const arr = data[table] || [];
  const idx = arr.findIndex(r => r.id === record.id);
  const next = idx >= 0 ? arr.map(r => r.id === record.id ? record : r) : [...arr, record];
  return { ...data, [table]: next };
}

function exportBackup() {
  const data = loadData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `removals-backup-${todayISO()}.json`; a.click();
  URL.revokeObjectURL(url);
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
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d={paths[name] || ""} />
    </svg>
  );
};

// ── Shared UI ───────────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const m = STATUS_META[status] || { color: "#6B7280", bg: "#F3F4F6" };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", padding: "2px 10px", borderRadius: 99, fontSize: 12, fontWeight: 600, color: m.color, background: m.bg, border: `1px solid ${m.color}33` }}>
      {status}
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
const inputStyle = { width: "100%", padding: "9px 12px", borderRadius: 8, border: "1.5px solid #E5E7EB", fontSize: 15, background: "#FAFAFA", boxSizing: "border-box", outline: "none", fontFamily: "inherit", color: "#111827" };
function Input({ value, onChange, type = "text", placeholder, required }) {
  return <input style={inputStyle} type={type} value={value ?? ""} onChange={e => onChange(e.target.value)} placeholder={placeholder} required={required} />;
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
function Btn({ children, onClick, variant = "primary", size = "md", disabled, style: extra }) {
  const base = { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, borderRadius: 8, fontWeight: 600, cursor: disabled ? "not-allowed" : "pointer", border: "none", fontFamily: "inherit", transition: "opacity .15s" };
  const v = {
    primary: { background: TEAL, color: "#fff" },
    amber: { background: AMBER, color: "#fff" },
    ghost: { background: "transparent", color: TEAL, border: `1.5px solid ${TEAL}` },
    danger: { background: "#FEE2E2", color: "#DC2626" },
    grey: { background: "#F3F4F6", color: "#374151" },
  };
  const p = size === "sm" ? { padding: "6px 12px", fontSize: 13 } : { padding: "10px 18px", fontSize: 14 };
  return <button className={size === "sm" ? "rm-btn-sm" : "rm-btn"} style={{ ...base, ...v[variant], ...p, opacity: disabled ? .5 : 1, ...extra }} onClick={onClick} disabled={disabled}>{children}</button>;
}
function Card({ children, onClick, style: extra }) {
  return <div onClick={onClick} style={{ background: "#fff", borderRadius: 12, padding: "14px 16px", boxShadow: "0 1px 3px rgba(0,0,0,.07)", marginBottom: 10, cursor: onClick ? "pointer" : "default", border: "1px solid #F3F4F6", ...extra }}>{children}</div>;
}
function Modal({ title, onClose, children, wide }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 100, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div className="rm-shell" style={{ background: "#fff", borderRadius: "20px 20px 0 0", width: "100%", maxHeight: "92vh", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "20px 20px 0", flexShrink: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#111827" }}>{title}</h3>
            <button onClick={onClose} style={{ background: "#F3F4F6", border: "none", borderRadius: 99, width: 32, height: 32, cursor: "pointer", fontSize: 18, color: "#6B7280" }}>×</button>
          </div>
        </div>
        <div style={{ overflowY: "auto", padding: "0 20px 20px", flex: 1 }}>{children}</div>
      </div>
    </div>
  );
}
function Empty({ icon, text }) {
  return (
    <div style={{ textAlign: "center", padding: "48px 20px", color: "#9CA3AF" }}>
      <div style={{ marginBottom: 10, display: "flex", justifyContent: "center" }}><Icon name={icon} size={40} color="#D1D5DB" /></div>
      <div style={{ fontSize: 14 }}>{text}</div>
    </div>
  );
}

// ── Lookups ─────────────────────────────────────────────────────────────────
function custName(data, id) {
  const c = (data.customers || []).find(x => x.id === id);
  if (!c) return "Unknown";
  return c.company ? `${c.name} (${c.company})` : c.name;
}

// ── Dashboard ───────────────────────────────────────────────────────────────
function Dashboard({ data, setView }) {
  const enquiries = data.enquiries || [];
  const jobs = data.jobs || [];
  const open = enquiries.filter(e => ["New", "Surveyed", "Quoted"].includes(e.status));
  const quotesOut = enquiries.filter(e => e.status === "Quoted");
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const thisMonthEnq = enquiries.filter(e => new Date(e.createdAt).getTime() >= monthStart);
  const wonThisMonth = thisMonthEnq.filter(e => e.status === "Won").length;
  const convRate = thisMonthEnq.length ? Math.round((wonThisMonth / thisMonthEnq.length) * 100) : 0;
  const upcoming = jobs
    .filter(j => j.status !== "Completed" && j.moveDate)
    .sort((a, b) => (a.moveDate || "").localeCompare(b.moveDate || ""))
    .slice(0, 5);
  const dueFollowUps = enquiries.filter(e => e.followUpDate && e.followUpDate <= todayISO() && !["Won", "Lost"].includes(e.status));

  const Stat = ({ label, value, sub, color, onClick }) => (
    <div onClick={onClick} style={{ flex: 1, background: "#fff", borderRadius: 12, padding: "14px 12px", boxShadow: "0 1px 3px rgba(0,0,0,.07)", cursor: onClick ? "pointer" : "default", border: "1px solid #F3F4F6", minWidth: 0 }}>
      <div style={{ fontSize: 24, fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 12, color: "#6B7280", marginTop: 5, fontWeight: 600 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: "#9CA3AF", marginTop: 2 }}>{sub}</div>}
    </div>
  );

  return (
    <div>
      <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
        <Stat label="Open enquiries" value={open.length} color={TEAL} onClick={() => setView({ screen: "enquiries", filter: "Open" })} />
        <Stat label="Quotes out" value={quotesOut.length} color={AMBER} onClick={() => setView({ screen: "enquiries", filter: "Quoted" })} />
      </div>
      <div style={{ display: "flex", gap: 10, marginBottom: 18 }}>
        <Stat label="Booked moves" value={jobs.filter(j => j.status !== "Completed").length} color="#2563EB" onClick={() => setView({ screen: "jobs" })} />
        <Stat label="Won this month" value={`${convRate}%`} sub={`${wonThisMonth}/${thisMonthEnq.length} enquiries`} color="#059669" />
      </div>

      <Btn variant="amber" style={{ width: "100%", marginBottom: 18 }} onClick={() => setView({ screen: "newEnquiry" })}>
        <Icon name="plus" size={16} /> New Enquiry
      </Btn>

      {dueFollowUps.length > 0 && (
        <>
          <SectionTitle>Follow-ups due</SectionTitle>
          {dueFollowUps.map(e => (
            <Card key={e.id} onClick={() => setView({ screen: "enquiryDetail", id: e.id })}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontWeight: 700, color: "#111827" }}>{custName(data, e.customerId)}</div>
                  <div style={{ fontSize: 13, color: "#6B7280" }}>{e.followUpNote || "Follow up"}</div>
                </div>
                <StatusBadge status={e.status} />
              </div>
            </Card>
          ))}
        </>
      )}

      <SectionTitle>Upcoming moves</SectionTitle>
      {upcoming.length === 0 && <Empty icon="truck" text="No moves booked yet" />}
      {upcoming.map(j => (
        <Card key={j.id} onClick={() => setView({ screen: "jobDetail", id: j.id })}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontWeight: 700, color: "#111827" }}>{custName(data, j.customerId)}</div>
              <div style={{ fontSize: 13, color: "#6B7280" }}>{fmtDate(j.moveDate)} · {j.fromTown || "—"} → {j.toTown || "—"}</div>
            </div>
            <StatusBadge status={j.status} />
          </div>
        </Card>
      ))}
    </div>
  );
}
function SectionTitle({ children }) {
  return <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", margin: "18px 0 8px", textTransform: "uppercase", letterSpacing: "0.05em" }}>{children}</div>;
}

// ── Enquiries list ──────────────────────────────────────────────────────────
function EnquiriesList({ data, setView, initialFilter }) {
  const [filter, setFilter] = useState(initialFilter || "Open");
  const enquiries = data.enquiries || [];
  const filters = ["Open", ...ENQUIRY_STATUSES, "All"];
  const shown = enquiries
    .filter(e => filter === "All" ? true : filter === "Open" ? ["New", "Surveyed", "Quoted"].includes(e.status) : e.status === filter)
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: "#111827" }}>Enquiries</h2>
        <Btn size="sm" onClick={() => setView({ screen: "newEnquiry" })}><Icon name="plus" size={14} /> New</Btn>
      </div>
      <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 8, marginBottom: 6 }}>
        {filters.map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{
            padding: "6px 14px", borderRadius: 99, border: "none", whiteSpace: "nowrap", cursor: "pointer",
            fontSize: 13, fontWeight: 600, background: filter === f ? TEAL : "#F3F4F6", color: filter === f ? "#fff" : "#6B7280",
          }}>{f}</button>
        ))}
      </div>
      {shown.length === 0 && <Empty icon="enquiries" text="No enquiries here" />}
      {shown.map(e => (
        <Card key={e.id} onClick={() => setView({ screen: "enquiryDetail", id: e.id })}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, color: "#111827" }}>{custName(data, e.customerId)}</div>
              <div style={{ fontSize: 13, color: "#6B7280", marginTop: 2 }}>{e.fromTown || "—"} → {e.toTown || "—"}</div>
              <div style={{ fontSize: 12, color: "#9CA3AF", marginTop: 2 }}>
                {e.preferredDate ? fmtDate(e.preferredDate) : "Date TBC"}
                {e.volumeCuFt ? ` · ${e.volumeCuFt} cu ft` : ""}
                {e.quoteTotal ? ` · ${gbp(e.quoteTotal)}` : ""}
              </div>
            </div>
            <StatusBadge status={e.status} />
          </div>
        </Card>
      ))}
    </div>
  );
}

// ── Customer picker (existing or add new inline) ────────────────────────────
function CustomerPicker({ data, customerId, onPick, newCust, setNewCust }) {
  const [mode, setMode] = useState(customerId ? "existing" : (data.customers || []).length ? "existing" : "new");
  const customers = [...(data.customers || [])].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  return (
    <div style={{ background: "#F9FAFB", borderRadius: 10, padding: 12, marginBottom: 14, border: "1px solid #F3F4F6" }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <Btn size="sm" variant={mode === "existing" ? "primary" : "grey"} onClick={() => setMode("existing")}>Existing customer</Btn>
        <Btn size="sm" variant={mode === "new" ? "primary" : "grey"} onClick={() => { setMode("new"); onPick(""); }}>New customer</Btn>
      </div>
      {mode === "existing" ? (
        <select style={{ ...inputStyle, appearance: "none", cursor: "pointer" }} value={customerId || ""} onChange={e => onPick(e.target.value)}>
          <option value="">Select customer…</option>
          {customers.map(c => <option key={c.id} value={c.id}>{c.company ? `${c.name} — ${c.company}` : c.name}</option>)}
        </select>
      ) : (
        <div>
          <Input value={newCust.name} onChange={v => setNewCust({ ...newCust, name: v })} placeholder="Full name *" />
          <div style={{ height: 8 }} />
          <Input value={newCust.phone} onChange={v => setNewCust({ ...newCust, phone: v })} placeholder="Phone" />
          <div style={{ height: 8 }} />
          <Input value={newCust.email} onChange={v => setNewCust({ ...newCust, email: v })} placeholder="Email" type="email" />
        </div>
      )}
    </div>
  );
}

// ── Enquiry form (create / edit) ────────────────────────────────────────────
function EnquiryForm({ data, onClose, editEnquiry }) {
  const e = editEnquiry || {};
  const [customerId, setCustomerId] = useState(e.customerId || "");
  const [newCust, setNewCust] = useState({ name: "", phone: "", email: "" });
  const [f, setF] = useState({
    preferredDate: e.preferredDate || "", dateFlexible: e.dateFlexible || false,
    fromAddress1: e.fromAddress1 || "", fromTown: e.fromTown || "", fromPostcode: e.fromPostcode || "",
    fromPropertyType: e.fromPropertyType || "", fromBedrooms: e.fromBedrooms || "", fromFloor: e.fromFloor || "", fromAccess: e.fromAccess || "",
    toAddress1: e.toAddress1 || "", toTown: e.toTown || "", toPostcode: e.toPostcode || "",
    toPropertyType: e.toPropertyType || "", toFloor: e.toFloor || "", toAccess: e.toAccess || "",
    distanceMiles: e.distanceMiles || "", notes: e.notes || "",
  });
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));

  async function save() {
    let data2 = data;
    let cid = customerId;
    if (!cid) {
      if (!newCust.name.trim()) { alert("Enter a customer name (or pick an existing customer)."); return; }
      cid = uid();
      const customer = { id: cid, name: newCust.name.trim(), company: "", phone: newCust.phone, email: newCust.email, custType: "Private", createdAt: new Date().toISOString() };
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
    await saveAndReload(data2);
  }

  return (
    <Modal title={e.id ? "Edit Enquiry" : "New Enquiry"} onClose={onClose}>
      {!e.id && (
        <Field label="Customer" required>
          <CustomerPicker data={data} customerId={customerId} onPick={setCustomerId} newCust={newCust} setNewCust={setNewCust} />
        </Field>
      )}

      <SectionTitle>Move details</SectionTitle>
      <Field label="Preferred move date"><Input type="date" value={f.preferredDate} onChange={v => set("preferredDate", v)} /></Field>
      <Field label="Dates flexible?">
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "#374151", cursor: "pointer" }}>
          <input type="checkbox" checked={f.dateFlexible} onChange={ev => set("dateFlexible", ev.target.checked)} style={{ width: 18, height: 18 }} /> Flexible on dates
        </label>
      </Field>
      <Field label="Distance (miles)" hint="Used to help price the quote"><Input type="number" value={f.distanceMiles} onChange={v => set("distanceMiles", v)} placeholder="e.g. 12" /></Field>

      <SectionTitle>Moving from</SectionTitle>
      <Field label="Address"><Input value={f.fromAddress1} onChange={v => set("fromAddress1", v)} placeholder="House/flat & street" /></Field>
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

      <SectionTitle>Moving to</SectionTitle>
      <Field label="Address"><Input value={f.toAddress1} onChange={v => set("toAddress1", v)} placeholder="House/flat & street" /></Field>
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}><Field label="Town"><Input value={f.toTown} onChange={v => set("toTown", v)} /></Field></div>
        <div style={{ width: 120 }}><Field label="Postcode"><Input value={f.toPostcode} onChange={v => set("toPostcode", v)} /></Field></div>
      </div>
      <Field label="Property type"><Select value={f.toPropertyType} onChange={v => set("toPropertyType", v)} options={PROPERTY_TYPES} placeholder="Select…" /></Field>
      <Field label="Floor / level"><Input value={f.toFloor} onChange={v => set("toFloor", v)} placeholder="e.g. Ground, 2nd" /></Field>
      <Field label="Access notes" hint="Stairs, lift, parking, long carry"><Textarea value={f.toAccess} onChange={v => set("toAccess", v)} rows={2} /></Field>

      <Field label="General notes"><Textarea value={f.notes} onChange={v => set("notes", v)} /></Field>

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
        out[it.slot] = { catalogId: it.catalogId ?? null, room: it.room, name: it.name, cuFt: it.cuFt, m3: it.m3, kg: it.kg, qty: it.qty };
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
  const [search, setSearch] = useState("");
  const [openSection, setOpenSection] = useState(ROOMS[0]);

  const matches = txt => !search || (txt || "").toLowerCase().includes(search.toLowerCase());

  function bump(slot, meta, d) {
    setLines(p => {
      const cur = p[slot]?.qty || 0;
      const n = Math.max(0, cur + d);
      const next = { ...p };
      if (n === 0) delete next[slot];
      else next[slot] = { ...(p[slot] || meta), qty: n };
      return next;
    });
  }
  function addCustom(label) {
    const name = (prompt("Item name?") || "").trim();
    if (!name) return;
    const cuFt = parseFloat(prompt("Approx volume in cubic feet? (e.g. 20)") || "");
    if (!cuFt || cuFt <= 0) { alert("Please enter a number for cubic feet."); return; }
    const kg = parseFloat(prompt("Approx weight in kg? (optional, e.g. 30)") || "") || 0;
    const slot = "c_" + uid();
    setLines(p => ({ ...p, [slot]: { catalogId: null, room: label, name, cuFt: Math.round(cuFt * 100) / 100, m3: Math.round(cuFt * 0.0283168 * 1000) / 1000, kg: Math.round(kg), qty: 1 } }));
    setOpenSection(label);
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

  const totals = inventoryTotals(Object.values(lines).map(v => ({ cuFt: v.cuFt, m3: v.m3, kg: v.kg, qty: v.qty })));
  const rec = recommendVehicle(totals.cuFt);

  async function save() {
    const inventory = Object.entries(lines).filter(([, v]) => v.qty > 0)
      .map(([slot, v]) => ({ slot, catalogId: v.catalogId ?? null, room: v.room, name: v.name, cuFt: v.cuFt, m3: v.m3, kg: v.kg, qty: v.qty }));
    const rec2 = {
      ...enquiry, inventory,
      volumeCuFt: totals.cuFt, volumeM3: totals.m3, weightKg: totals.kg,
      status: enquiry.status === "New" ? "Surveyed" : enquiry.status,
    };
    await saveAndReload(upsertLocal(data, "enquiries", rec2));
  }

  // Build ordered section list, expanding Bedroom into Bedroom 1..N
  const sections = [];
  ROOMS.forEach(room => {
    if (room === "Bedroom") {
      beds.forEach(lbl => sections.push({ label: lbl, catalogRoom: "Bedroom", isBedroom: true }));
      sections.push({ addBedroom: true });
    } else {
      sections.push({ label: room, catalogRoom: room });
    }
  });

  function Section({ label, catalogRoom, isBedroom }) {
    const catItems = FURNITURE.filter(it => it.room === catalogRoom && matches(it.name));
    const customSlots = Object.entries(lines).filter(([, v]) => v.catalogId == null && v.room === label && matches(v.name));
    if (search && catItems.length === 0 && customSlots.length === 0) return null;
    const sectionQty = Object.values(lines).filter(v => v.room === label).reduce((s, v) => s + v.qty, 0);
    const isOpen = search ? true : openSection === label;
    const Stepper = ({ slot, meta }) => {
      const q = lines[slot]?.qty || 0;
      return (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button onClick={() => bump(slot, meta, -1)} style={stepBtn(q > 0)}>−</button>
          <span style={{ minWidth: 18, textAlign: "center", fontWeight: 700, color: q ? "#111827" : "#D1D5DB" }}>{q}</span>
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
            {sectionQty > 0 && <span style={{ background: TEAL, color: "#fff", borderRadius: 99, fontSize: 12, padding: "1px 8px", fontWeight: 700 }}>{sectionQty}</span>}
            <span style={{ color: "#9CA3AF" }}>{isOpen ? "▾" : "▸"}</span>
          </span>
        </button>
        {isOpen && (
          <div style={{ padding: "4px 0" }}>
            {catItems.map(it => {
              const slot = `${label}::${it.id}`;
              return (
                <div key={slot} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 14px", borderTop: "1px solid #F9FAFB" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, color: "#111827", fontWeight: 500 }}>{it.name}</div>
                    <div style={{ fontSize: 11, color: "#9CA3AF" }}>{it.cuFt} cu ft · {it.kg} kg</div>
                  </div>
                  <Stepper slot={slot} meta={{ catalogId: it.id, room: label, name: it.name, cuFt: it.cuFt, m3: it.m3, kg: it.kg }} />
                </div>
              );
            })}
            {customSlots.map(([slot, v]) => (
              <div key={slot} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 14px", borderTop: "1px solid #F9FAFB" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, color: "#111827", fontWeight: 500 }}>{v.name} <span style={{ fontSize: 10, color: TEAL, fontWeight: 700 }}>· custom</span></div>
                  <div style={{ fontSize: 11, color: "#9CA3AF" }}>{v.cuFt} cu ft · {v.kg} kg</div>
                </div>
                <Stepper slot={slot} meta={v} />
              </div>
            ))}
            <div style={{ padding: "8px 14px", borderTop: "1px solid #F9FAFB" }}>
              <button onClick={() => addCustom(label)} style={{ background: "transparent", border: "none", color: TEAL, fontWeight: 600, fontSize: 13, cursor: "pointer", padding: 0 }}>+ Add custom item</button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <Modal title="Survey / Inventory" onClose={onClose}>
      <div style={{ marginBottom: 12 }}><Input value={search} onChange={setSearch} placeholder="🔍 Search items…" /></div>

      {sections.map((s, i) => s.addBedroom
        ? (!search && <button key="addbed" onClick={addBedroom} style={{ width: "100%", marginBottom: 8, padding: "10px", borderRadius: 10, border: `1.5px dashed ${TEAL}`, background: "#F0FDFA", color: TEAL, fontWeight: 700, fontSize: 13, cursor: "pointer" }}>+ Add another bedroom</button>)
        : <Section key={s.label} {...s} />
      )}

      {/* sticky totals */}
      <div style={{ position: "sticky", bottom: 0, background: "#fff", paddingTop: 12, marginTop: 8, borderTop: "2px solid #F3F4F6" }}>
        <div style={{ background: NAVY, color: "#fff", borderRadius: 12, padding: "12px 14px", marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
            <span style={{ fontSize: 13, opacity: .85 }}>Total volume</span>
            <span style={{ fontWeight: 800 }}>{totals.cuFt} cu ft · {totals.m3} m³</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
            <span style={{ fontSize: 13, opacity: .85 }}>Est. weight</span>
            <span style={{ fontWeight: 700 }}>{totals.kg} kg</span>
          </div>
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
    if (enquiry.quoteLines && enquiry.quoteLines.length) return enquiry.quoteLines;
    return [{ desc: "Removal service", amount: "" }];
  });
  const [vat, setVat] = useState(enquiry.quoteVat || false);
  const total = quoteTotal(lines, vat);
  const customer = (data.customers || []).find(c => c.id === enquiry.customerId);

  const setLine = (i, k, v) => setLines(p => p.map((l, idx) => idx === i ? { ...l, [k]: v } : l));
  const addLine = (desc = "") => setLines(p => [...p, { desc, amount: "" }]);
  const removeLine = i => setLines(p => p.filter((_, idx) => idx !== i));

  function buildRecord(status, sentDate) {
    return {
      ...enquiry,
      quoteLines: lines.filter(l => l.desc || l.amount),
      quoteVat: vat, quoteTotal: total,
      quoteStatus: status, quoteSentDate: sentDate ?? enquiry.quoteSentDate,
      status: status === "Sent" ? "Quoted" : status === "Accepted" ? enquiry.status : enquiry.status,
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
      `From: ${[enquiry.fromAddress1, enquiry.fromTown, enquiry.fromPostcode].filter(Boolean).join(", ")}\n` +
      `To: ${[enquiry.toAddress1, enquiry.toTown, enquiry.toPostcode].filter(Boolean).join(", ")}\n\n` +
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
          {enquiry.distanceMiles ? ` · ${enquiry.distanceMiles} miles` : ""}
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

function EnquiryDetail({ data, id, setView }) {
  const e = (data.enquiries || []).find(x => x.id === id);
  const [showEdit, setShowEdit] = useState(false);
  const [showInv, setShowInv] = useState(false);
  const [showQuote, setShowQuote] = useState(false);
  const customer = (data.customers || []).find(c => c.id === e?.customerId);
  if (!e) return <div style={{ padding: 20 }}>Enquiry not found.</div>;

  async function setStatus(status, extra = {}) {
    await saveAndReload(upsertLocal(data, "enquiries", { ...e, status, ...extra }));
  }
  async function markWon() {
    const jid = uid();
    const job = {
      id: jid, customerId: e.customerId, enquiryId: e.id,
      moveDate: e.preferredDate || "", startTime: "",
      fromAddress1: e.fromAddress1, fromTown: e.fromTown, fromPostcode: e.fromPostcode, fromAccess: e.fromAccess,
      toAddress1: e.toAddress1, toTown: e.toTown, toPostcode: e.toPostcode, toAccess: e.toAccess,
      crew: [], vehicle: recommendVehicle(e.volumeCuFt).vehicle,
      volumeCuFt: e.volumeCuFt, volumeM3: e.volumeM3, weightKg: e.weightKg,
      price: e.quoteTotal || 0, deposit: 0, depositPaid: false, balancePaid: false,
      status: "Booked", notes: "", createdAt: new Date().toISOString(),
    };
    let d2 = upsertLocal(data, "jobs", job);
    d2 = upsertLocal(d2, "enquiries", { ...e, status: "Won", quoteStatus: "Accepted" });
    showSavingOverlay(); SAVING_IN_PROGRESS = true;
    const stamped = stampData(d2);
    localStorage.setItem(DB_KEY, JSON.stringify(stamped));
    try { await pushChangedOnly(stamped); } catch {}
    SAVING_IN_PROGRESS = false;
    window.location.reload();
  }
  async function markLost() {
    const reason = prompt("Reason lost? (optional)") || "";
    await setStatus("Lost", { lostReason: reason });
  }
  async function setFollowUp() {
    const date = prompt("Follow-up date (YYYY-MM-DD):", e.followUpDate || todayISO());
    if (date === null) return;
    const note = prompt("Follow-up note:", e.followUpNote || "") || "";
    await saveAndReload(upsertLocal(data, "enquiries", { ...e, followUpDate: date, followUpNote: note }));
  }
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
      <Btn variant="ghost" size="sm" onClick={() => setView({ screen: "enquiries" })}><Icon name="back" size={14} /> Back</Btn>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "14px 0 4px" }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: "#111827" }}>{custName(data, e.customerId)}</h2>
        <StatusBadge status={e.status} />
      </div>
      {customer && (
        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          {customer.phone && <Btn size="sm" variant="grey" onClick={() => window.location.href = `tel:${customer.phone}`}>📞 Call</Btn>}
          {customer.email && <Btn size="sm" variant="grey" onClick={() => window.location.href = `mailto:${customer.email}`}>✉️ Email</Btn>}
        </div>
      )}

      <Card>
        <Row label="Move date" value={e.preferredDate ? fmtDate(e.preferredDate) + (e.dateFlexible ? " (flexible)" : "") : "TBC"} />
        <Row label="Distance" value={e.distanceMiles ? `${e.distanceMiles} miles` : ""} />
        <Row label="From" value={[e.fromAddress1, e.fromTown, e.fromPostcode].filter(Boolean).join(", ")} />
        <Row label="From property" value={[e.fromPropertyType, e.fromBedrooms && `${e.fromBedrooms} bed`, e.fromFloor].filter(Boolean).join(" · ")} />
        {e.fromAccess && <Row label="From access" value={e.fromAccess} />}
        <Row label="To" value={[e.toAddress1, e.toTown, e.toPostcode].filter(Boolean).join(", ")} />
        <Row label="To property" value={[e.toPropertyType, e.toFloor].filter(Boolean).join(" · ")} />
        {e.toAccess && <Row label="To access" value={e.toAccess} />}
        {e.notes && <Row label="Notes" value={e.notes} />}
      </Card>

      {/* Survey */}
      <Card style={{ background: e.volumeCuFt ? "#F0FDFA" : "#fff" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 700, color: "#111827" }}>Survey / Inventory</div>
            <div style={{ fontSize: 13, color: "#6B7280", marginTop: 2 }}>
              {e.volumeCuFt ? `${e.volumeCuFt} cu ft · ${e.volumeM3} m³ · ${e.weightKg} kg` : "Not surveyed yet"}
            </div>
            {e.volumeCuFt > 0 && <div style={{ fontSize: 13, color: TEAL, fontWeight: 600, marginTop: 2 }}>{rec.vehicle}{rec.loads > 1 ? ` × ${rec.loads}` : ""}</div>}
          </div>
          <Btn size="sm" onClick={() => setShowInv(true)}><Icon name="box" size={14} /> {e.volumeCuFt ? "Edit" : "Start"}</Btn>
        </div>
      </Card>

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
      </Card>

      {e.followUpDate && (
        <Card style={{ background: "#FFFBEB" }}>
          <div style={{ fontSize: 13, color: "#92400E" }}><b>Follow-up {fmtDate(e.followUpDate)}:</b> {e.followUpNote || "—"}</div>
        </Card>
      )}

      {/* Actions */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14 }}>
        {!["Won", "Lost"].includes(e.status) && <Btn onClick={markWon} style={{ flex: 1 }}><Icon name="check" size={16} /> Mark Won → Book move</Btn>}
        {e.status === "Won" && e.enquiryId !== false && <Btn variant="grey" style={{ flex: 1 }} onClick={() => { const j = (data.jobs || []).find(x => x.enquiryId === e.id); if (j) setView({ screen: "jobDetail", id: j.id }); }}>View booked move</Btn>}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
        <Btn variant="grey" size="sm" onClick={() => setShowEdit(true)}><Icon name="edit" size={14} /> Edit</Btn>
        <Btn variant="grey" size="sm" onClick={setFollowUp}>⏰ Follow-up</Btn>
        {!["Won", "Lost"].includes(e.status) && <Btn variant="grey" size="sm" onClick={markLost}>Mark Lost</Btn>}
        <Btn variant="danger" size="sm" onClick={del}><Icon name="trash" size={14} /> Delete</Btn>
      </div>

      {showEdit && <EnquiryForm data={data} editEnquiry={e} onClose={() => setShowEdit(false)} />}
      {showInv && <InventoryModal data={data} enquiry={e} onClose={() => setShowInv(false)} />}
      {showQuote && <QuoteModal data={data} enquiry={e} onClose={() => setShowQuote(false)} />}
    </div>
  );
}

// ── Customers ───────────────────────────────────────────────────────────────
function CustomersList({ data, setView }) {
  const [q, setQ] = useState("");
  const [showForm, setShowForm] = useState(false);
  const customers = [...(data.customers || [])]
    .filter(c => !q || `${c.name} ${c.company} ${c.phone} ${c.town}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: "#111827" }}>Customers</h2>
        <Btn size="sm" onClick={() => setShowForm(true)}><Icon name="plus" size={14} /> New</Btn>
      </div>
      <div style={{ marginBottom: 12 }}><Input value={q} onChange={setQ} placeholder="🔍 Search customers…" /></div>
      {customers.length === 0 && <Empty icon="customers" text="No customers yet" />}
      {customers.map(c => {
        const jobs = (data.jobs || []).filter(j => j.customerId === c.id).length;
        return (
          <Card key={c.id} onClick={() => setView({ screen: "customerDetail", id: c.id })}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontWeight: 700, color: "#111827" }}>{c.name}{c.company ? ` · ${c.company}` : ""}</div>
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
    name: c.name || "", company: c.company || "", phone: c.phone || "", email: c.email || "",
    address1: c.address1 || "", town: c.town || "", county: c.county || "", postcode: c.postcode || "",
    custType: c.custType || "Private", notes: c.notes || "",
  });
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  async function save() {
    if (!f.name.trim()) { alert("Name is required."); return; }
    const rec = { id: c.id || uid(), ...f, createdAt: c.createdAt || new Date().toISOString() };
    await saveAndReload(upsertLocal(data, "customers", rec));
  }
  return (
    <Modal title={c.id ? "Edit Customer" : "New Customer"} onClose={onClose}>
      <Field label="Full name" required><Input value={f.name} onChange={v => set("name", v)} /></Field>
      <Field label="Type"><Select value={f.custType} onChange={v => set("custType", v)} options={["Private", "Commercial"]} /></Field>
      {f.custType === "Commercial" && <Field label="Company"><Input value={f.company} onChange={v => set("company", v)} /></Field>}
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}><Field label="Phone"><Input value={f.phone} onChange={v => set("phone", v)} /></Field></div>
        <div style={{ flex: 1 }}><Field label="Email"><Input type="email" value={f.email} onChange={v => set("email", v)} /></Field></div>
      </div>
      <Field label="Address"><Input value={f.address1} onChange={v => set("address1", v)} /></Field>
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

function CustomerDetail({ data, id, setView }) {
  const c = (data.customers || []).find(x => x.id === id);
  const [showEdit, setShowEdit] = useState(false);
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
      <Btn variant="ghost" size="sm" onClick={() => setView({ screen: "customers" })}><Icon name="back" size={14} /> Back</Btn>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "14px 0" }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: "#111827" }}>{c.name}</h2>
        <StatusBadge status={c.custType} />
      </div>
      <Card>
        <Row label="Phone" value={c.phone} />
        <Row label="Email" value={c.email} />
        {c.company && <Row label="Company" value={c.company} />}
        <Row label="Address" value={[c.address1, c.town, c.postcode].filter(Boolean).join(", ")} />
        {c.notes && <Row label="Notes" value={c.notes} />}
      </Card>
      <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
        {c.phone && <Btn size="sm" variant="grey" onClick={() => window.location.href = `tel:${c.phone}`}>📞 Call</Btn>}
        {c.email && <Btn size="sm" variant="grey" onClick={() => window.location.href = `mailto:${c.email}`}>✉️ Email</Btn>}
        <Btn size="sm" variant="grey" onClick={() => setShowEdit(true)}><Icon name="edit" size={14} /> Edit</Btn>
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
      {jobs.length === 0 && <div style={{ fontSize: 13, color: "#9CA3AF" }}>None yet.</div>}
      {jobs.map(j => (
        <Card key={j.id} onClick={() => setView({ screen: "jobDetail", id: j.id })}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 14, color: "#111827" }}>{fmtDate(j.moveDate)} · {gbp(j.price)}</div>
            <StatusBadge status={j.status} />
          </div>
        </Card>
      ))}
      {showEdit && <CustomerForm data={data} editCustomer={c} onClose={() => setShowEdit(false)} />}
    </div>
  );
}

// ── Jobs (booked moves) ─────────────────────────────────────────────────────
function JobsList({ data, setView }) {
  const [filter, setFilter] = useState("Active");
  const jobs = (data.jobs || [])
    .filter(j => filter === "All" ? true : filter === "Active" ? j.status !== "Completed" : j.status === filter)
    .sort((a, b) => (a.moveDate || "").localeCompare(b.moveDate || ""));
  const filters = ["Active", ...JOB_STATUSES, "All"];
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
        <Card key={j.id} onClick={() => setView({ screen: "jobDetail", id: j.id })}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div style={{ fontWeight: 700, color: "#111827" }}>{custName(data, j.customerId)}</div>
              <div style={{ fontSize: 13, color: "#6B7280", marginTop: 2 }}>{fmtDate(j.moveDate)} · {j.fromTown || "—"} → {j.toTown || "—"}</div>
              <div style={{ fontSize: 12, color: "#9CA3AF", marginTop: 2 }}>{j.vehicle || "—"} · {gbp(j.price)}{j.deposit ? ` · dep ${gbp(j.deposit)}${j.depositPaid ? " ✓" : ""}` : ""}</div>
            </div>
            <StatusBadge status={j.status} />
          </div>
        </Card>
      ))}
    </div>
  );
}

function JobDetail({ data, id, setView }) {
  const j = (data.jobs || []).find(x => x.id === id);
  const customer = (data.customers || []).find(c => c.id === j?.customerId);
  if (!j) return <div style={{ padding: 20 }}>Move not found.</div>;
  const [f, setF] = useState({
    moveDate: j.moveDate || "", startTime: j.startTime || "", vehicle: j.vehicle || "",
    crew: (j.crew || []).join(", "), price: j.price || 0, deposit: j.deposit || 0,
    depositPaid: j.depositPaid || false, balancePaid: j.balancePaid || false,
    status: j.status || "Booked", notes: j.notes || "",
  });
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  async function save() {
    const rec = { ...j, ...f, crew: f.crew.split(",").map(s => s.trim()).filter(Boolean), price: Number(f.price) || 0, deposit: Number(f.deposit) || 0 };
    await saveAndReload(upsertLocal(data, "jobs", rec));
  }
  async function del() {
    if (!confirm("Delete this booked move?")) return;
    addTombstone(j.id);
    SAVING_IN_PROGRESS = true; showSavingOverlay();
    try { await deleteRecord("jobs", j.id); } catch {}
    const d2 = { ...data, jobs: (data.jobs || []).filter(x => x.id !== j.id) };
    localStorage.setItem(DB_KEY, JSON.stringify(d2));
    SAVING_IN_PROGRESS = false; setView({ screen: "jobs" }); window.location.reload();
  }
  const balance = (Number(f.price) || 0) - (Number(f.deposit) || 0);
  return (
    <div>
      <Btn variant="ghost" size="sm" onClick={() => setView({ screen: "jobs" })}><Icon name="back" size={14} /> Back</Btn>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "14px 0 8px" }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: "#111827" }}>{custName(data, j.customerId)}</h2>
        <StatusBadge status={f.status} />
      </div>
      {customer && (
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          {customer.phone && <Btn size="sm" variant="grey" onClick={() => window.location.href = `tel:${customer.phone}`}>📞 Call</Btn>}
          {customer.email && <Btn size="sm" variant="grey" onClick={() => window.location.href = `mailto:${customer.email}`}>✉️ Email</Btn>}
          {j.enquiryId && <Btn size="sm" variant="grey" onClick={() => setView({ screen: "enquiryDetail", id: j.enquiryId })}>View enquiry</Btn>}
        </div>
      )}

      <Card>
        <Row label="From" value={[j.fromAddress1, j.fromTown, j.fromPostcode].filter(Boolean).join(", ")} />
        {j.fromAccess && <Row label="From access" value={j.fromAccess} />}
        <Row label="To" value={[j.toAddress1, j.toTown, j.toPostcode].filter(Boolean).join(", ")} />
        {j.toAccess && <Row label="To access" value={j.toAccess} />}
        <Row label="Volume" value={j.volumeCuFt ? `${j.volumeCuFt} cu ft · ${j.volumeM3} m³` : ""} />
      </Card>

      <SectionTitle>Booking</SectionTitle>
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}><Field label="Move date"><Input type="date" value={f.moveDate} onChange={v => set("moveDate", v)} /></Field></div>
        <div style={{ width: 130 }}><Field label="Start time"><Input type="time" value={f.startTime} onChange={v => set("startTime", v)} /></Field></div>
      </div>
      <Field label="Vehicle"><Input value={f.vehicle} onChange={v => set("vehicle", v)} /></Field>
      <Field label="Crew" hint="Comma-separated names"><Input value={f.crew} onChange={v => set("crew", v)} placeholder="e.g. Dave, Sam" /></Field>
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
        <input type="checkbox" checked={f.balancePaid} onChange={ev => set("balancePaid", ev.target.checked)} style={{ width: 18, height: 18 }} /> Balance paid (move complete)
      </label>

      <Field label="Notes"><Textarea value={f.notes} onChange={v => set("notes", v)} /></Field>

      <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
        <Btn variant="danger" onClick={del}><Icon name="trash" size={14} /></Btn>
        <Btn style={{ flex: 1 }} onClick={save}><Icon name="check" size={16} /> Save move</Btn>
      </div>
    </div>
  );
}

// ── Calendar (agenda of booked moves) ───────────────────────────────────────
function CalendarView({ data, setView }) {
  const jobs = (data.jobs || []).filter(j => j.moveDate).sort((a, b) => (a.moveDate || "").localeCompare(b.moveDate || ""));
  const today = todayISO();
  const upcoming = jobs.filter(j => j.moveDate >= today);
  const past = jobs.filter(j => j.moveDate < today).reverse();
  const Group = ({ title, list }) => (
    <>
      <SectionTitle>{title}</SectionTitle>
      {list.length === 0 && <div style={{ fontSize: 13, color: "#9CA3AF", marginBottom: 10 }}>None.</div>}
      {list.map(j => (
        <Card key={j.id} onClick={() => setView({ screen: "jobDetail", id: j.id })}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontWeight: 700, color: "#111827" }}>{fmtDate(j.moveDate)}{j.startTime ? ` · ${j.startTime}` : ""}</div>
              <div style={{ fontSize: 13, color: "#6B7280", marginTop: 2 }}>{custName(data, j.customerId)} · {j.fromTown || "—"} → {j.toTown || "—"}</div>
            </div>
            <StatusBadge status={j.status} />
          </div>
        </Card>
      ))}
    </>
  );
  return (
    <div>
      <h2 style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 800, color: "#111827" }}>Calendar</h2>
      <Group title="Upcoming" list={upcoming} />
      <Group title="Past" list={past} />
    </div>
  );
}

// ── Device responsiveness ───────────────────────────────────────────────────
function useDeviceType() {
  const get = () => {
    const w = typeof window !== "undefined" ? window.innerWidth : 520;
    if (w >= 1024) return "desktop";
    if (w >= 700) return "tablet";
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
  const css = {
    phone: `.rm-shell{max-width:100%}input,select,textarea{font-size:16px!important;padding:14px 14px!important}.rm-btn{padding:14px 20px!important;font-size:16px!important}.rm-btn-sm{padding:10px 14px!important;font-size:14px!important}`,
    tablet: `.rm-shell{max-width:720px}input,select,textarea{font-size:15px!important;padding:12px 14px!important}`,
    desktop: `.rm-shell{max-width:880px}input,select,textarea{font-size:15px!important;padding:11px 14px!important}`,
  };
  return <style>{css[device] || ""}</style>;
}

// ── Merge helper (newest-wins, tombstone-aware) ─────────────────────────────
function mergeArrays(cloudArr, localArr, deleted) {
  const byId = {};
  (cloudArr || []).forEach(x => { if (!deleted.includes(x.id)) byId[x.id] = x; });
  (localArr || []).forEach(x => {
    if (deleted.includes(x.id)) return;
    if (byId[x.id]) byId[x.id] = (x.updatedAt || 0) >= (byId[x.id].updatedAt || 0) ? x : byId[x.id];
    else byId[x.id] = x; // local-only: keep (genuine deletes use tombstones)
  });
  return Object.values(byId);
}
function mergeAll(cloud, local) {
  const deleted = getTombstones();
  return {
    customers: mergeArrays(cloud.customers, local.customers || [], deleted),
    enquiries: mergeArrays(cloud.enquiries, local.enquiries || [], deleted),
    jobs: mergeArrays(cloud.jobs, local.jobs || [], deleted),
  };
}

// ── App ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [data, setData] = useState(loadData);
  const [view, setViewState] = useState({ screen: "dashboard" });
  const [tab, setTab] = useState("dashboard");
  const [syncStatus, setSyncStatus] = useState("syncing");
  const device = useDeviceType();

  // Initial load: pull cloud, merge with local, push back
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cloud = await pullFromCloud();
        if (cancelled) return;
        const merged = mergeAll(cloud, loadData());
        localStorage.setItem(DB_KEY, JSON.stringify(merged));
        setData(merged);
        pushChangedOnly(merged).catch(() => {});
        setSyncStatus("synced");
      } catch {
        if (!cancelled) setSyncStatus("offline");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Realtime: refresh on any change from another device
  useEffect(() => {
    const channel = supabase
      .channel("removals-changes")
      .on("postgres_changes", { event: "*", schema: "public" }, async (payload) => {
        if (SAVING_IN_PROGRESS) return;
        try {
          if (payload?.eventType === "DELETE" && payload?.old?.id) addTombstone(payload.old.id);
          const merged = mergeAll(await pullFromCloud(), loadData());
          localStorage.setItem(DB_KEY, JSON.stringify(merged));
          setData(merged);
        } catch {}
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, []);

  // Reconnect: push any pending records the moment we're back online
  useEffect(() => {
    const onOnline = () => pushChangedOnly(loadData()).catch(() => {});
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, []);

  // Poll every 20s as a backup for realtime
  useEffect(() => {
    const iv = setInterval(async () => {
      if (SAVING_IN_PROGRESS) return;
      try {
        const merged = mergeAll(await pullFromCloud(), loadData());
        localStorage.setItem(DB_KEY, JSON.stringify(merged));
        pushChangedOnly(merged).catch(() => {});
        setData(prev => {
          const count = a => (a.customers?.length || 0) + (a.enquiries?.length || 0) + (a.jobs?.length || 0);
          return count(prev) !== count(merged) ? merged : prev;
        });
        setSyncStatus("synced");
      } catch { setSyncStatus("offline"); }
    }, 20000);
    return () => clearInterval(iv);
  }, []);

  const setView = useCallback((v) => {
    setViewState(v);
    if (["dashboard", "enquiries", "jobs", "customers", "calendar"].includes(v.screen)) setTab(v.screen);
    setData(loadData());
  }, []);
  useEffect(() => { setData(loadData()); }, [tab]);

  const tabs = [
    { id: "dashboard", icon: "dashboard", label: "Home" },
    { id: "enquiries", icon: "enquiries", label: "Enquiries" },
    { id: "calendar", icon: "calendar", label: "Calendar" },
    { id: "jobs", icon: "jobs", label: "Moves" },
    { id: "customers", icon: "customers", label: "Customers" },
  ];
  const isTab = ["dashboard", "enquiries", "jobs", "customers", "calendar"].includes(view.screen);

  return (
    <div className="rm-shell" style={{ fontFamily: "'Inter',system-ui,sans-serif", background: "#F8FAFC", minHeight: "100vh", margin: "0 auto" }}>
      <ResponsiveStyles device={device} />
      {/* Header */}
      <div style={{ background: TEAL, padding: device === "phone" ? "14px 18px" : "12px 18px", position: "sticky", top: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {!isTab && <button onClick={() => setView({ screen: tab })} style={{ background: "rgba(255,255,255,.15)", border: "none", borderRadius: 8, padding: "8px 12px", color: "#fff", cursor: "pointer", fontSize: 22, lineHeight: 1 }}>‹</button>}
          <div style={{ width: 44, height: 44, borderRadius: 10, background: "rgba(255,255,255,.15)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Icon name="truck" size={26} color="#fff" />
          </div>
          <div>
            <div style={{ fontSize: device === "phone" ? 17 : 16, fontWeight: 800, color: "#fff", letterSpacing: "-0.02em", lineHeight: 1.2 }}>Removals CRM</div>
            <div style={{ fontSize: 11, color: "#99F6E4", fontWeight: 500, letterSpacing: "0.06em", textTransform: "uppercase" }}>Enquiries &amp; Moves</div>
          </div>
        </div>
        <div title={syncStatus === "synced" ? "Synced" : syncStatus === "syncing" ? "Syncing…" : "Offline — saved locally"}
          style={{ width: 10, height: 10, borderRadius: "50%", background: syncStatus === "synced" ? "#22C55E" : syncStatus === "syncing" ? "#FBBF24" : "#9CA3AF", boxShadow: syncStatus === "synced" ? "0 0 6px #22C55E" : "none" }} />
      </div>

      {/* Content */}
      <div style={{ padding: "16px 16px 110px" }}>
        {view.screen === "dashboard" && <Dashboard data={data} setView={setView} />}
        {view.screen === "enquiries" && <EnquiriesList data={data} setView={setView} initialFilter={view.filter} />}
        {view.screen === "enquiryDetail" && <EnquiryDetail data={data} id={view.id} setView={setView} />}
        {view.screen === "jobs" && <JobsList data={data} setView={setView} />}
        {view.screen === "jobDetail" && <JobDetail data={data} id={view.id} setView={setView} />}
        {view.screen === "customers" && <CustomersList data={data} setView={setView} />}
        {view.screen === "customerDetail" && <CustomerDetail data={data} id={view.id} setView={setView} />}
        {view.screen === "calendar" && <CalendarView data={data} setView={setView} />}
      </div>

      {view.screen === "newEnquiry" && <EnquiryForm data={data} onClose={() => setView({ screen: "enquiries" })} />}

      {/* Bottom nav */}
      <div className="rm-shell" style={{ position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)", width: "100%", background: "#fff", borderTop: "1px solid #E5E7EB", display: "flex", zIndex: 50 }}>
        {tabs.map(t => {
          const active = tab === t.id;
          return (
            <button key={t.id} onClick={() => { setTab(t.id); setView({ screen: t.id }); }} style={{ flex: 1, padding: device === "phone" ? "14px 0 18px" : "12px 0 14px", background: "transparent", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <Icon name={t.icon} size={device === "phone" ? 25 : 22} color={active ? TEAL : "#9CA3AF"} />
              <span style={{ fontSize: device === "phone" ? 11 : 10.5, fontWeight: 600, color: active ? TEAL : "#9CA3AF", letterSpacing: "0.02em" }}>{t.label}</span>
              {active && <div style={{ width: 18, height: 2.5, borderRadius: 99, background: AMBER, marginTop: 2 }} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
