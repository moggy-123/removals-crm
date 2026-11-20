// Vercel function: receives website form submissions (Forminator webhook) and drops
// them into the CRM's "Web leads" tray. Nothing is created automatically — you
// check each lead in the app and tap "Add as enquiry".
//
// Webhook URL (set in Forminator → form → Integrations → Webhook):
//   https://removals-crm-q56x.vercel.app/api/lead?key=YOUR_SECRET
// The secret is checked by the database (add-web-leads.sql), not stored here.

const SUPABASE_URL = "https://vpcygvdjfgiwlsdyxhzs.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZwY3lndmRqZmdpd2xzZHl4aHpzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4OTU0MTQsImV4cCI6MjA5NzQ3MTQxNH0.sk4-r5vvlYuxHcaq8Ee5TXflgQ0fF62rAOP6ZABY51g";

// Forminator's own housekeeping fields — not part of the enquiry
const SKIP = /^(_wp_http_referer|_wpnonce|forminator_nonce|nonce|action|form_id|form_type|page_id|render_id|current_url|referer_url|forminator-multifile-hidden|consent.*|captcha.*|g-recaptcha-response|hcaptcha.*|entry_id|entry_time|form_title|form-title|quiz_.*|submission_id|honeypot.*|ip|user_agent)$/i;

// Forminator address fields: the 1st is where they're moving from, the 2nd where they're moving to.
// (The app reads "Moving from:" / "Moving to:" lines, so plain "Address:" twice lost the addresses.)
let ADDR_SEEN = [];
function label(key) {
  const k = String(key).toLowerCase();
  const am = k.match(/^address[-_ ]?(\d+)?/);
  if (am) {
    const id = am[1] || "1";
    if (!ADDR_SEEN.includes(id)) ADDR_SEEN.push(id);
    const n = ADDR_SEEN.indexOf(id);
    return n === 0 ? "Moving from" : n === 1 ? "Moving to" : "Address";
  }
  if (/moving[ _-]?from|current[ _-]?address|collection/.test(k)) return "Moving from";
  if (/moving[ _-]?to|new[ _-]?address|delivery/.test(k)) return "Moving to";
  if (/^(full[ _-]?)?name/.test(k)) return "Name";
  if (/^e-?mail/.test(k)) return "Email";
  if (/^(phone|mobile|tel)/.test(k)) return "Phone";
  if (/^(textarea|message|comments?|how[ _-]can[ _-]we[ _-]help)/.test(k)) return "Message";
  if (/^date/.test(k)) return "Move date";
  if (/^(url|page|referr?er|source[ _-]?url)/.test(k)) return "URL";
  // "select-1" → "Select"; "How did you hear of us" stays as typed
  return String(key).replace(/[-_]\d+$/, "").replace(/[-_]+/g, " ").replace(/^./, c => c.toUpperCase());
}
function flat(v) {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(flat).filter(Boolean).join(", ");
  if (typeof v === "object") {
    // name field with prefix / first / last parts, or an address field
    const order = ["prefix", "first-name", "first_name", "middle-name", "last-name", "last_name", "street_address", "address_line", "city", "state", "zip", "postcode", "country"];
    const keys = Object.keys(v).sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
    return keys.filter(k => !(k === "country" && /^(uk|united kingdom|great britain|gb|england|wales)$/i.test(String(v[k] || "").trim()))).map(k => flat(v[k])).filter(Boolean).join(/street|address|city|zip/.test(keys.join(" ")) ? ", " : " ");
  }
  return String(v).trim();
}
// Some Forminator payloads send an address as separate keys (address-1-street_address, address-1-zip …):
// put them back together as one address, in the order the form has them.
function groupParts(body) {
  const out = {};
  for (const [k, v] of Object.entries(body || {})) {
    const m = String(k).match(/^(address[-_]\d+)[-_](street_address|address_line|city|state|zip|postcode|country)$/i);
    if (m) { if (typeof out[m[1]] !== "object" || out[m[1]] === null) out[m[1]] = {}; out[m[1]][m[2].toLowerCase()] = v; }
    else out[k] = v;
  }
  return out;
}
function toText(body0) {
  const lines = [], msgs = [];
  ADDR_SEEN = [];
  const body = groupParts(body0);
  for (const [k, v] of Object.entries(body || {})) {
    if (SKIP.test(k)) continue;
    const val = flat(v);
    if (!val) continue;
    const L = label(k);
    if (L === "Message") msgs.push(val.replace(/\s*\n\s*/g, " "));
    else lines.push(`${L}: ${val.replace(/\s*\n\s*/g, ", ")}`);
  }
  if (msgs.length) lines.push("Message: " + msgs.join(" "));   // message last, so it reads to the end
  return lines.join("\n");
}

async function readBody(req) {
  if (req.body != null && req.body !== "") {
    if (typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
    return parseRaw(Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body));
  }
  const raw = await new Promise(resolve => {
    let d = "", done = false; const fin = () => { if (!done) { done = true; resolve(d); } };
    req.on("data", c => { d += c; }); req.on("end", fin); req.on("error", fin); setTimeout(fin, 5000);
  });
  return parseRaw(raw);
}
function parseRaw(raw) {
  const s = String(raw || "").trim();
  if (!s) return {};
  try { return JSON.parse(s); } catch {}
  try {
    const o = {};
    for (const [k, v] of new URLSearchParams(s)) {
      const m = k.match(/^([^\[]+)\[([^\]]*)\]/);   // name-1[first-name] → { "name-1": { "first-name": … } }
      if (m) { if (typeof o[m[1]] !== "object") o[m[1]] = {}; o[m[1]][m[2] || Object.keys(o[m[1]]).length] = v; }
      else o[k] = v;
    }
    if (Object.keys(o).length) return o;
  } catch {}
  return { message: s };
}

export default async function handler(req, res) {
  const send = (code, obj) => { res.statusCode = code; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); };
  try {
    if (req.method === "GET") return send(200, { ok: true, info: "R&J lead receiver is running" });
    if (req.method !== "POST") return send(405, { error: "POST only" });
    const key = new URL(req.url, "http://x").searchParams.get("key") || "";
    if (!key) return send(401, { error: "missing key" });
    const body = await readBody(req);
    const text = toText(body);
    if (!text) return send(200, { ok: true, skipped: "empty" });
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/add_web_lead`, {
      method: "POST",
      headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_key: key, p_body: body, p_text: text, p_source: "Website form" }),
    });
    if (!r.ok) { const t = await r.text(); return send(/bad key/i.test(t) ? 401 : 500, { error: /bad key/i.test(t) ? "bad key" : "could not save lead", detail: t.slice(0, 300) }); }
    return send(200, { ok: true });
  } catch (e) {
    return send(500, { error: String((e && e.message) || e) });
  }
}
