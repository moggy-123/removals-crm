// Vercel serverless function: receives a forwarded enquiry email and creates a
// new customer + enquiry in Supabase automatically. No manual paste needed.
//
// It accepts a POST whose body contains the email text in any of the common
// shapes used by email-forwarding services (Postmark, SendGrid, a Cloudflare
// Email Worker, or a plain { text } JSON). Protect it with a shared secret in
// the URL: https://<your-app>.vercel.app/api/inbound?key=YOUR_SECRET

const SUPABASE_URL = process.env.SUPABASE_URL || "https://vpcygvdjfgiwlsdyxhzs.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZwY3lndmRqZmdpd2xzZHl4aHpzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4OTU0MTQsImV4cCI6MjA5NzQ3MTQxNH0.sk4-r5vvlYuxHcaq8Ee5TXflgQ0fF62rAOP6ZABY51g";
// CHANGE THIS to your own secret, and use the same value in the ?key= URL.
const INBOUND_SECRET = process.env.INBOUND_SECRET || "Dave-1966";

const EMAIL_MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
function monthNameToYM(name) {
  const idx = EMAIL_MONTHS.indexOf((name || "").toLowerCase());
  if (idx < 0) return "";
  const now = new Date();
  let y = now.getFullYear();
  if (idx < now.getMonth()) y += 1;
  return `${y}-${String(idx + 1).padStart(2, "0")}`;
}
function parseEnquiryEmail(text) {
  const t = (text || "").replace(/\r/g, "");
  const out = { name: "", email: "", phone: "", fromAddress1: "", fromTown: "", fromPostcode: "", fromAccess: "", fromPropertyType: "", fromBedrooms: "", toAddress1: "", toTown: "", toPostcode: "", toAccess: "", toPropertyType: "", preferredDate: "", moveMonth: "", dateFlexible: false, notes: "" };
  const PC = /[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}/i;
  const PCG = /[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}/gi;
  const em = t.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i); if (em) out.email = em[0];
  const ph = t.match(/(\+?44|0)[\d\s()-]{8,13}\d/); if (ph) { let p = ph[0].replace(/[()\s-]/g, ""); if (p.startsWith("+44")) p = "0" + p.slice(3); out.phone = p; }
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fieldIn = (block, labels) => { for (const L of labels) { const m = block.match(new RegExp("^[ \\t]*" + esc(L) + "[ \\t]*:[ \\t]*(.+?)[ \\t]*$", "im")); if (m && m[1].trim()) return m[1].trim(); } return ""; };
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
  const moveVal = fieldIn(topBlock, ["exact move date", "move date", "moving date", "preferred date", "preferred move date", "date"]);
  const dm = (moveVal || t).match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (dm) { let y = dm[3]; if (y.length === 2) y = "20" + y; out.preferredDate = `${y.padStart(4, "0")}-${dm[2].padStart(2, "0")}-${dm[1].padStart(2, "0")}`; }
  if (!out.preferredDate) { const mm = (moveVal || "").match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i); if (mm) out.moveMonth = monthNameToYM(mm[1]); }
  if (!out.preferredDate && /\bno\b/i.test(moveVal)) out.dateFlexible = true;
  if (!out.name && out.email) out.name = out.email.split("@")[0].replace(/[._\-]+/g, " ").replace(/\b\w/g, ch => ch.toUpperCase()).trim();
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

function stripHtml(html) {
  return (html || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

async function sb(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
}

export default async function handler(req, res) {
  const send = (code, obj) => { try { res.statusCode = code; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); } catch {} };
  try {
    if (req.method !== "POST") return send(405, { error: "POST only" });
    let key = "";
    try { key = new URL(req.url, "http://x").searchParams.get("key") || ""; } catch { key = (req.query && req.query.key) || ""; }
    if (key !== INBOUND_SECRET) return send(401, { error: "bad key" });

    // Read the body whether Vercel pre-parsed it or not
    let raw = "";
    if (req.body != null && req.body !== "") {
      raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      if (typeof req.body === "object") raw = req.body;
    } else {
      raw = await new Promise(resolve => {
        let d = "", done = false;
        const fin = v => { if (!done) { done = true; resolve(v); } };
        const t = setTimeout(() => fin(d), 4000);
        req.on("data", c => d += c);
        req.on("end", () => { clearTimeout(t); fin(d); });
        req.on("error", () => { clearTimeout(t); fin(d); });
      });
    }
    let b = raw;
    if (typeof b === "string") { const s = b.trim(); if (s.startsWith("{")) { try { b = JSON.parse(s); } catch { b = { text: b }; } } else { b = { text: b }; } }
    b = b || {};
    const text = b.text || b.TextBody || b.plain || b.body || (b.html ? stripHtml(b.html) : "") || (b.HtmlBody ? stripHtml(b.HtmlBody) : "") || (typeof raw === "string" ? raw : "");
    if (!text || !String(text).trim()) return send(400, { error: "no email text found" });

    const p = parseEnquiryEmail(String(text));

    // next customer ref (#1000+)
    let nextRef = 1000;
    try {
      const r = await sb("customers?select=ref&order=ref.desc.nullslast&limit=1");
      const rows = await r.json();
      if (Array.isArray(rows) && rows[0] && Number(rows[0].ref) >= 1000) nextRef = Number(rows[0].ref) + 1;
    } catch {}

    const now = new Date().toISOString();
    const custId = uid();
    const customer = {
      id: custId, name: p.name || "Website enquiry", company: "", phone: p.phone || "", home_phone: "", email: p.email || "",
      address1: p.fromAddress1 || "", address2: "", town: p.fromTown || "", county: "", postcode: p.fromPostcode || "",
      cust_type: "Private", ref: nextRef, notes: "", updated_at: Date.now(), created_at: now,
    };
    const enquiry = {
      id: uid(), customer_id: custId, status: "New",
      enquiry_date: now.slice(0, 10), preferred_date: p.preferredDate || null,
      survey_date: null, survey_time: "", surveyor: "",
      date_flexible: !!p.dateFlexible, move_month: p.moveMonth || null,
      from_address1: p.fromAddress1 || "", from_address2: "", from_town: p.fromTown || "", from_postcode: p.fromPostcode || "",
      from_property_type: p.fromPropertyType || "", from_bedrooms: p.fromBedrooms || "", from_floor: "", from_access: p.fromAccess || "",
      to_address1: p.toAddress1 || "", to_address2: "", to_town: p.toTown || "", to_postcode: p.toPostcode || "",
      to_property_type: p.toPropertyType || "", to_floor: "", to_access: p.toAccess || "",
      inventory: [], volume_cuft: 0, volume_m3: 0, weight_kg: 0,
      extras: [], quote_lines: [], stages: [], quote_vat: false, quote_total: 0, quote_extra: {},
      quote_status: "Draft", quote_sent_date: null, follow_up_date: null, follow_up_note: "",
      lost_reason: "", notes: p.notes || "", updated_at: Date.now(), created_at: now,
    };

    const cr = await sb("customers", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(customer) });
    if (!cr.ok) return send(500, { error: "customer insert failed: " + (await cr.text()) });
    const er = await sb("enquiries", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(enquiry) });
    if (!er.ok) return send(500, { error: "enquiry insert failed: " + (await er.text()) });

    return send(200, { ok: true, customer: customer.name, ref: nextRef });
  } catch (err) {
    return send(500, { error: String((err && err.stack) || err) });
  }
}
