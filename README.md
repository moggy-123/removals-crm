# Removals CRM

A React PWA for managing removals **enquiries, surveys, quotes and booked moves** — built on the same offline-first stack as your Windscreen CRM (React + Vite + Supabase, installable on iPhone/iPad/Mac, with live cloud sync).

---

## What it does (v1)

- **Customers** — private & commercial, with contact details and history.
- **Enquiries** — the sales pipeline: New → Surveyed → Quoted → Won / Lost.
  - **Survey / inventory calculator** — tick furniture room by room; it totals **volume (cu ft + m³)**, **estimated weight**, and recommends the **right vehicle** (and how many loads). Built from your 67-item furniture list.
  - **Quote builder** — line items, one-tap extras (packing, materials, dismantling, storage, piano…), optional 20% VAT, and **email the quote** straight to the customer.
- **Mark Won** turns an enquiry into a **booked move** (Job) automatically — copying the customer, addresses, volume and quote price.
- **Booked moves** — date, time, crew, vehicle, price, deposit & balance, status (Booked → In Progress → Completed).
- **Dashboard** — open enquiries, quotes out, booked moves, this month's **conversion rate**, follow-ups due, and upcoming moves.
- **Calendar** — agenda of upcoming and past moves.

Everything saves locally first and syncs to the cloud, so it keeps working with no signal and updates live across your devices.

---

## One-time setup

### 1. Create a NEW Supabase project
Use a **separate** project from the Windscreen one so the data never mixes.

1. Go to supabase.com → **New project**. Give it a name (e.g. `removals-crm`) and a database password.
2. Once it's ready, open **Project Settings → API** and copy:
   - **Project URL** (looks like `https://abcd1234.supabase.co`)
   - **Publishable / anon key** (the long public key)
3. Open **`src/supabase.js`** and paste those two values in at the top:
   ```js
   const SUPABASE_URL = "https://YOUR-PROJECT.supabase.co";
   const SUPABASE_KEY = "YOUR-PUBLISHABLE-ANON-KEY";
   ```

### 2. Create the database tables
1. In Supabase, open **SQL Editor → New query**.
2. Open **`supabase-setup.sql`** from this project, copy the whole file, paste it in, and press **Run**.
   - If one line says a table is *already a member of the publication*, that's fine — ignore it.

### 3. Put it on GitHub
1. On GitHub (your `moggy-123` account), create a **new repository**, e.g. `removals-crm`.
2. Upload all the files from this folder (same as you do for the windscreen app — drag them into the GitHub web editor, keeping the `src/` and `public/` folders).

### 4. Connect to Vercel
1. In Vercel → **Add New → Project** → import the `removals-crm` repo.
2. Framework preset is **Vite**, build command `npm run build`, output `dist` (already set in `vercel.json`).
3. Deploy. Every time you edit a file on GitHub, Vercel rebuilds automatically — same as windscreen.

### 5. Install it on your devices
- Open the Vercel URL in **Safari** on iPhone/iPad → **Share → Add to Home Screen**.
- It then opens full-screen like an app and works offline.

---

## Project structure

```
removals-crm/
├─ index.html            app shell + fonts
├─ package.json          dependencies
├─ vite.config.js        PWA config (auto-update, offline cache)
├─ vercel.json           Vercel build settings
├─ supabase-setup.sql    run once to create the database
├─ public/
│  └─ favicon.svg
└─ src/
   ├─ main.jsx           entry point
   ├─ App.jsx            the whole app (screens + sync engine)
   ├─ supabase.js        cloud connection + field mapping  ← paste keys here
   └─ furniture.js       your 67-item furniture/volume list
```

To edit the furniture list, item volumes or van sizes later, change **`src/furniture.js`**.

---

## Roadmap (suggested next stages)
- **v2** — printable/PDF quote and a branded T&Cs document.
- **v3** — deposit invoices & receipts; crew assignment per move; richer calendar.
- **v4** — reports (revenue, conversion, busiest months) like the windscreen Reports screen.
- **Later** — multi-company SaaS version with Stripe subscriptions for other UK removal firms.

The sync engine, offline behaviour and UI are the same proven pattern as your windscreen app, so it'll feel familiar to extend.
