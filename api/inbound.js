// Vercel serverless function: receives a forwarded enquiry email and creates a
// new customer + enquiry in Supabase automatically. No manual paste needed.
//
// It accepts a POST whose body contains the email text in any of the common
// shapes used by email-forwarding services (Postmark, SendGrid, a Cloudflare
// Email Worker, or a plain { text } JSON). Protect it with a shared secret in
// the URL: https://<your-app>.vercel.app/api/inbound?key=YOUR_SECRET

const SUPABASE_URL = process.env.SUPABASE_URL || "https://vpcygvdjfgiwlsdyxhzs.supabase.co";
// Once the database is locked to logged-in users, this needs the SERVICE ROLE key
// (set SUPABASE_SERVICE_ROLE_KEY in Vercel → Settings → Environment Variables).
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZwY3lndmRqZmdpd2xzZHl4aHpzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4OTU0MTQsImV4cCI6MjA5NzQ3MTQxNH0.sk4-r5vvlYuxHcaq8Ee5TXflgQ0fF62rAOP6ZABY51g";
// CHANGE THIS to your own secret, and use the same value in the ?key= URL.
const INBOUND_SECRET = process.env.INBOUND_SECRET || "rj-enquiries-2026";

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
  const PH = /(?:\+?44\s?|0)\d[\d\s-]{8,12}\d/g;
  while ((m = PH.exec(msg))) {
    let p = m[0].replace(/[\s-]/g, ""); if (p.startsWith("+44") || p.startsWith("44")) p = "0" + p.replace(/^\+?44/, "");
    if (!mainP) { out.phone = p; continue; }
    if (p === mainP || p.length < 10) continue;
    const near = msg.slice(Math.max(0, m.index - 70), m.index + m[0].length + 90);
    const rel = (near.match(/\b(husband|wife|partner|son|daughter|mum|mother|dad|father|brother|sister|fianc[eé]e?|boyfriend|girlfriend|colleague|work)\b/i) || [])[1] || "";
    const nm = (near.match(/(?:(?:his|her|their) name is|called|ask for|speak to|contact)\s+([A-Z][a-z]+)/) || near.match(/\b(?:husband|wife|partner|son|daughter)(?:'s)?\s+([A-Z][a-z]+)\b/) || [])[1] || "";
    const pref = /call (?:him|her|them)|(?:best|easier) to (?:call|contact)|(?:difficult|hard) to get to the phone|work (?:full|long)/i.test(msg) ? " — prefers calls to this number" : "";
    lines.push(`Other contact: ${[nm, rel ? `(${rel.toLowerCase()})` : ""].filter(Boolean).join(" ") || "number"} ${p}${pref}`);
  }
  return { lines, message: msgM ? msgM[2].trim() : "" };
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
  { const lp = fieldIn(t, ["phone", "mobile", "telephone", "tel", "phone number", "contact number"]).replace(/[()\s-]/g, ""); if (/^(\+?44|0)\d{9,10}$/.test(lp)) out.phone = lp.startsWith("+44") ? "0" + lp.slice(3) : lp; }
  { const le = fieldIn(t, ["email", "email address", "e-mail"]).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i); if (le) out.email = le[0]; }
  out.email = (out.email || "").toLowerCase();
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
    labelledPC = !!(fpc || tpc);
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
  const rm = readMessage(t, out, { lockPostcodes: sectioned || labelledPC });
  out.fromPropertyType = normalizePropertyType(out.fromPropertyType); out.toPropertyType = normalizePropertyType(out.toPropertyType);
  if (!fromBeds && !sectioned) fromBeds = "";
  if (!toBeds && out.toBedrooms) toBeds = out.toBedrooms;
  delete out.toBedrooms;
  if (!out.name && out.email) out.name = out.email.split("@")[0].replace(/[._\-]+/g, " ").replace(/\b\w/g, ch => ch.toUpperCase()).trim();
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

    const now = new Date().toISOString();
    const custId = uid();
    const customer = {
      id: custId, name: p.name || "Website enquiry", company: "", phone: p.phone || "", home_phone: "", email: p.email || "",
      address1: p.fromAddress1 || "", address2: "", town: p.fromTown || "", county: "", postcode: p.fromPostcode || "",
      cust_type: "Private", notes: "", updated_at: Date.now(), created_at: now,
    };
    const enquiry = {
      id: uid(), customer_id: custId, status: "New",
      enquiry_date: now.slice(0, 10), preferred_date: p.preferredDate || null,
      survey_date: null, survey_time: "", surveyor: "",
      date_flexible: !!p.dateFlexible, move_month: p.moveMonth || null,
      from_address1: p.fromAddress1 || "", from_address2: "", from_town: p.fromTown || "", from_postcode: p.fromPostcode || "",
      from_property_type: normalizePropertyType(p.fromPropertyType), from_bedrooms: p.fromBedrooms || "", from_floor: "", from_access: p.fromAccess || "",
      to_address1: p.toAddress1 || "", to_address2: "", to_town: p.toTown || "", to_postcode: p.toPostcode || "",
      to_property_type: normalizePropertyType(p.toPropertyType), to_floor: "", to_access: p.toAccess || "",
      inventory: [], volume_cuft: 0, volume_m3: 0, weight_kg: 0,
      extras: [], quote_lines: [], stages: [], quote_vat: false, quote_total: 0, quote_extra: { _meta: p.referredBy ? { referredBy: p.referredBy } : {} },
      quote_status: "Draft", quote_sent_date: null, follow_up_date: null, follow_up_note: "",
      lost_reason: "", notes: p.notes || "", updated_at: Date.now(), created_at: now,
    };

    const cr = await sb("customers", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(customer) });
    if (!cr.ok) return send(500, { error: "customer insert failed: " + (await cr.text()) });
    const er = await sb("enquiries", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(enquiry) });
    if (!er.ok) return send(500, { error: "enquiry insert failed: " + (await er.text()) });

    return send(200, { ok: true, customer: customer.name });
  } catch (err) {
    return send(500, { error: String((err && err.stack) || err) });
  }
}
