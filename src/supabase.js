import { createClient } from "@supabase/supabase-js";

// ⚠️ PASTE YOUR OWN NEW SUPABASE PROJECT VALUES HERE (see README, step 1).
// Use a NEW project — do NOT reuse the Windscreen one, or the data will mix.
const SUPABASE_URL = "https://vpcygvdjfgiwlsdyxhzs.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZwY3lndmRqZmdpd2xzZHl4aHpzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4OTU0MTQsImV4cCI6MjA5NzQ3MTQxNH0.sk4-r5vvlYuxHcaq8Ee5TXflgQ0fF62rAOP6ZABY51g";

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Field mapping: app (camelCase) <-> db (snake_case) ──────────────────────

const customerToDb = c => ({
  id: c.id, name: c.name, company: c.company, phone: c.phone, home_phone: c.homePhone || "", email: c.email,
  address1: c.address1, address2: c.address2, town: c.town, county: c.county,
  postcode: c.postcode, cust_type: c.custType || "Private", notes: c.notes, comms: c.comms || null,
  storage: c.storage || null, storage_jobs: c.storageJobs || null, move: c.move || null, storage_inv: c.storageInv || null,
  updated_at: c.updatedAt || Date.now(),
  created_at: c.createdAt || new Date().toISOString(),
});
const customerFromDb = r => ({
  id: r.id, name: r.name, company: r.company, phone: r.phone, homePhone: r.home_phone || "", email: r.email,
  address1: r.address1, address2: r.address2, town: r.town, county: r.county,
  postcode: r.postcode, custType: r.cust_type || "Private", ref: r.ref || null, notes: r.notes,
  storage: r.storage || null, storageJobs: r.storage_jobs || null, move: r.move || null, storageInv: r.storage_inv || null, comms: r.comms || null,
  updatedAt: r.updated_at, createdAt: r.created_at,
});

const enquiryToDb = e => ({
  id: e.id, customer_id: e.customerId, status: e.status || "New",
  enquiry_date: e.enquiryDate, preferred_date: e.preferredDate || null,
  survey_date: e.surveyDate || null, survey_time: e.surveyTime || "", surveyor: e.surveyor || "",
  date_flexible: !!e.dateFlexible, move_month: e.moveMonth || null,
  from_address1: e.fromAddress1, from_address2: e.fromAddress2 || "", from_town: e.fromTown, from_postcode: e.fromPostcode,
  from_property_type: e.fromPropertyType, from_bedrooms: e.fromBedrooms,
  from_floor: e.fromFloor, from_access: e.fromAccess,
  to_address1: e.toAddress1, to_address2: e.toAddress2 || "", to_town: e.toTown, to_postcode: e.toPostcode,
  to_property_type: e.toPropertyType, to_floor: e.toFloor, to_access: e.toAccess,
  distance_miles: e.distanceMiles || null,
  inventory: e.inventory || [],
  volume_cuft: e.volumeCuFt || 0, volume_m3: e.volumeM3 || 0, weight_kg: e.weightKg || 0,
  extras: e.extras || [],
  quote_lines: e.quoteLines || [], stages: e.stages || [],
  quote_vat: !!e.quoteVat, quote_total: e.quoteTotal || 0,
  quote_extra: e.quoteExtra || {},
  quote_status: e.quoteStatus || "Draft", quote_sent_date: e.quoteSentDate || null,
  follow_up_date: e.followUpDate || null, follow_up_note: e.followUpNote || "",
  lost_reason: e.lostReason || "", notes: e.notes || "",
  updated_at: e.updatedAt || Date.now(),
  created_at: e.createdAt || new Date().toISOString(),
});
const enquiryFromDb = r => ({
  id: r.id, customerId: r.customer_id, status: r.status || "New",
  enquiryDate: r.enquiry_date, preferredDate: r.preferred_date || "",
  surveyDate: r.survey_date || "", surveyTime: r.survey_time || "", surveyor: r.surveyor || "",
  dateFlexible: r.date_flexible, moveMonth: r.move_month || "",
  fromAddress1: r.from_address1, fromAddress2: r.from_address2 || "", fromTown: r.from_town, fromPostcode: r.from_postcode,
  fromPropertyType: r.from_property_type, fromBedrooms: r.from_bedrooms,
  fromFloor: r.from_floor, fromAccess: r.from_access,
  toAddress1: r.to_address1, toAddress2: r.to_address2 || "", toTown: r.to_town, toPostcode: r.to_postcode,
  toPropertyType: r.to_property_type, toFloor: r.to_floor, toAccess: r.to_access,
  distanceMiles: r.distance_miles || "",
  inventory: r.inventory || [],
  volumeCuFt: r.volume_cuft || 0, volumeM3: r.volume_m3 || 0, weightKg: r.weight_kg || 0,
  extras: r.extras || [],
  quoteLines: r.quote_lines || [], stages: r.stages || [],
  quoteVat: r.quote_vat, quoteTotal: r.quote_total || 0,
  quoteExtra: r.quote_extra || {},
  quoteStatus: r.quote_status || "Draft", quoteSentDate: r.quote_sent_date || "",
  followUpDate: r.follow_up_date || "", followUpNote: r.follow_up_note || "",
  lostReason: r.lost_reason || "", notes: r.notes || "",
  updatedAt: r.updated_at, createdAt: r.created_at,
});

const jobToDb = j => ({
  id: j.id, customer_id: j.customerId, enquiry_id: j.enquiryId || null,
  move_date: j.moveDate, start_time: j.startTime,
  from_address1: j.fromAddress1, from_address2: j.fromAddress2 || "", from_town: j.fromTown, from_postcode: j.fromPostcode, from_access: j.fromAccess,
  to_address1: j.toAddress1, to_address2: j.toAddress2 || "", to_town: j.toTown, to_postcode: j.toPostcode, to_access: j.toAccess,
  crew: j.crew || [], vehicle: j.vehicle || "", stages: j.stages || [], move_seq: j.moveSeq || null,
  vehicle_id: (j.vehicleIds && j.vehicleIds[0]) || j.vehicleId || null,
  vehicle_ids: j.vehicleIds || (j.vehicleId ? [j.vehicleId] : []),
  volume_cuft: j.volumeCuFt || 0, volume_m3: j.volumeM3 || 0, weight_kg: j.weightKg || 0,
  price: j.price || 0, deposit: j.deposit || 0, deposit_paid: !!j.depositPaid,
  balance_paid: !!j.balancePaid,
  status: j.status || "Booked", notes: j.notes || "",
  updated_at: j.updatedAt || Date.now(),
  created_at: j.createdAt || new Date().toISOString(),
});
const jobFromDb = r => ({
  id: r.id, customerId: r.customer_id, enquiryId: r.enquiry_id,
  moveDate: r.move_date, startTime: r.start_time,
  fromAddress1: r.from_address1, fromAddress2: r.from_address2 || "", fromTown: r.from_town, fromPostcode: r.from_postcode, fromAccess: r.from_access,
  toAddress1: r.to_address1, toAddress2: r.to_address2 || "", toTown: r.to_town, toPostcode: r.to_postcode, toAccess: r.to_access,
  crew: r.crew || [], vehicle: r.vehicle || "", stages: r.stages || [], moveSeq: r.move_seq || null,
  vehicleIds: (r.vehicle_ids && r.vehicle_ids.length) ? r.vehicle_ids : (r.vehicle_id ? [r.vehicle_id] : []),
  volumeCuFt: r.volume_cuft || 0, volumeM3: r.volume_m3 || 0, weightKg: r.weight_kg || 0,
  price: r.price || 0, deposit: r.deposit || 0, depositPaid: r.deposit_paid,
  balancePaid: r.balance_paid,
  status: r.status || "Booked", notes: r.notes || "",
  updatedAt: r.updated_at, createdAt: r.created_at,
});

const vehicleToDb = v => ({
  id: v.id, name: v.name, reg: v.reg || "", vtype: v.vtype || "",
  capacity_cuft: v.capacityCuFt || 0, maintenance: v.maint || null,
  updated_at: v.updatedAt || Date.now(), created_at: v.createdAt || new Date().toISOString(),
});
const vehicleFromDb = r => ({
  id: r.id, name: r.name, reg: r.reg || "", vtype: r.vtype || "",
  capacityCuFt: r.capacity_cuft || 0, maint: r.maintenance || null, updatedAt: r.updated_at, createdAt: r.created_at,
});
const staffToDb = s => ({
  id: s.id, name: s.name, role: s.role || "", phone: s.phone || "", active: s.active !== false,
  updated_at: s.updatedAt || Date.now(), created_at: s.createdAt || new Date().toISOString(),
});
const staffFromDb = r => ({
  id: r.id, name: r.name, role: r.role || "", phone: r.phone || "", active: r.active !== false,
  updatedAt: r.updated_at, createdAt: r.created_at,
});

const MAP_TO_DB = { customers: customerToDb, enquiries: enquiryToDb, jobs: jobToDb, vehicles: vehicleToDb, staff: staffToDb };

// ── Pull all data from Supabase ─────────────────────────────────────────────
export async function pullFromCloud() {
  const [c, e, j, v, s] = await Promise.all([
    supabase.from("customers").select("*"),
    supabase.from("enquiries").select("*"),
    supabase.from("jobs").select("*"),
    supabase.from("vehicles").select("*"),
    supabase.from("staff").select("*"),
  ]);
  if (c.error || e.error || j.error || v.error || s.error) throw new Error("Pull failed");
  return {
    customers: (c.data || []).map(customerFromDb),
    enquiries: (e.data || []).map(enquiryFromDb),
    jobs:      (j.data || []).map(jobFromDb),
    vehicles:  (v.data || []).map(vehicleFromDb),
    staff:     (s.data || []).map(staffFromDb),
  };
}

// ── Push entire local dataset (one row at a time — small requests on mobile) ──
export async function pushToCloud(data) {
  const tables = [
    { name: "customers", rows: (data.customers || []).map(customerToDb) },
    { name: "enquiries", rows: (data.enquiries || []).map(enquiryToDb) },
    { name: "jobs",      rows: (data.jobs      || []).map(jobToDb)      },
    { name: "vehicles",  rows: (data.vehicles  || []).map(vehicleToDb)  },
    { name: "staff",     rows: (data.staff     || []).map(staffToDb)    },
  ];
  for (const t of tables) {
    for (const row of t.rows) {
      const { error } = await supabase.from(t.name).upsert(row);
      if (error) throw new Error(error.message || error.details || JSON.stringify(error));
    }
  }
}

// Push ONE record (fast single saves)
export async function pushOne(table, record) {
  const { error } = await supabase.from(table).upsert(MAP_TO_DB[table](record));
  if (error) throw new Error(error.message || error.details || error.hint || JSON.stringify(error));
}

export async function deleteRecord(table, id) {
  const { error } = await supabase.from(table).delete().eq("id", id);
  if (error) throw error;
}

export async function isOnline() {
  try {
    const { error } = await supabase.from("customers").select("id").limit(1);
    return !error;
  } catch { return false; }
}

// ── Photo storage (survey / condition photos) ───────────────────────────────
const PHOTO_BUCKET = "move-photos";
export async function uploadPhoto(dataUrl, refId) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const filename = `${refId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  const { error } = await supabase.storage.from(PHOTO_BUCKET).upload(filename, blob, {
    contentType: "image/jpeg", upsert: false,
  });
  if (error) throw error;
  const { data } = supabase.storage.from(PHOTO_BUCKET).getPublicUrl(filename);
  return { url: data.publicUrl, path: filename };
}
export async function deletePhoto(path) {
  if (!path) return;
  await supabase.storage.from(PHOTO_BUCKET).remove([path]);
}

// ── Item catalogue (rooms + furniture volumes/weights), synced across devices ─
// Stored as a single JSON document in the app_config table (key = 'catalog').
export async function loadCatalog() {
  try {
    const { data, error } = await supabase.from("app_config").select("value, updated_at").eq("key", "catalog").maybeSingle();
    if (error) return null;
    if (!data) return null;
    return { value: data.value, updatedAt: Number(data.updated_at) || 0 };
  } catch { return null; }
}
export async function saveCatalog(value, updatedAt) {
  const { error } = await supabase.from("app_config").upsert({ key: "catalog", value, updated_at: updatedAt }, { onConflict: "key" });
  if (error) throw error;
}

// ── Upload a generated PDF to Supabase Storage, return its public URL ────────
export async function uploadStorageSheet(path, bytes) {
  const blob = new Blob([bytes], { type: "application/pdf" });
  const { error } = await supabase.storage.from("storage-sheets").upload(path, blob, { upsert: true, contentType: "application/pdf" });
  if (error) throw error;
  const { data } = supabase.storage.from("storage-sheets").getPublicUrl(path);
  return data.publicUrl;
}
