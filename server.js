/* =========================================================
   FOM GAS backend (version 0.2)
   ---------------------------------------------------------
   Real accounts, vendors, orders and notifications in Postgres
   for the CUSTOMER app, plus phone login and the order-claim /
   status flow for the RIDER app. Both apps share the same
   gas_orders table, which is how they are "connected": a gas
   order a customer creates and pays for here becomes a real,
   claimable job for a rider.

   NOT built yet (do not pretend otherwise in either app):
   - Real payments. Orders are saved with payment_status
     'unpaid'. Paystack will be added later.
   - Real SMS. Rider OTP codes are returned directly in the API
     response (the rider app already shows this as "demo mode"),
     not sent by text message.
   - Rider KYC, motorcycle assignment, wallet/earnings, bank
     payout and support tickets. Those stay exactly as local,
     on-device demo data in the rider app for now.
   - The customer app's own tracking screen does not yet poll
     this backend for a rider's real progress — it still shows
     its own simulated steps. Only order CREATION and the
     rider's claim/advance actions are real so far.

   Environment variables (set them on Render):
     DATABASE_URL  Postgres connection string
     JWT_SECRET    a long random string (keep it private)
     ADMIN_KEY     your own private key for the admin routes
     DEMO_MODE     "true" lets a customer move their own order
                   to the next status (for testing the app)
   ========================================================= */
'use strict';

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const { DATABASE_URL, JWT_SECRET, ADMIN_KEY, PAYSTACK_SECRET_KEY } = process.env;
// Real payments. Without this key, an order can still be created with
// demoPaid (exactly as before — clearly a demo). With it, a real Paystack
// reference is checked against Paystack's own servers before an order is
// ever marked paid — the app can say it paid, but this server never takes
// its word for it.
const DEMO_MODE = process.env.DEMO_MODE === 'true';
const PORT = process.env.PORT || 3000;

if (!DATABASE_URL || !JWT_SECRET) {
  console.error('Missing DATABASE_URL or JWT_SECRET. Set them in the Render environment settings.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false }
});

/* ---------- Prices (Naira) - same numbers as the demo app ---------- */
const CYLINDERS = {
  '3':    { price: 4200,  delivery: 1000 },
  '6':    { price: 8400,  delivery: 1200 },
  '12.5': { price: 17500, delivery: 1500 },
  '25':   { price: 35000, delivery: 2000 }
};
const SERVICE_FEE = 500;
const OTHER_PRICE_PER_KG = 1400;
const OTHER_DELIVERY_FEE = 1500;
const roundTo50 = n => Math.round(n / 50) * 50;

// The customer-facing steps. The rider's own, more detailed stages (below)
// each map onto one of these, so the customer app's simple tracker and the
// rider app's detailed delivery flow describe the same real order.
const STEP_NOTIFS = [
  'Your order has been received.',
  'A driver has been assigned to bring your gas.',
  'Your rider is on the way with a full cylinder.',
  'Your cylinder is being filled at your address.',
  'Your refill is complete.'
];
const LAST_STEP = STEP_NOTIFS.length; // 5

// The rider app's own delivery flow (unchanged from that app). A rider
// picks up a full cylinder from a vendor, then brings it to the customer.
const RIDER_STAGES = [
  'ACCEPTED', 'GOING_TO_VENDOR', 'ARRIVED_AT_VENDOR', 'GAS_COLLECTED',
  'GOING_TO_CUSTOMER', 'ARRIVED_AT_CUSTOMER', 'CUSTOMER_PIN_VERIFIED', 'DELIVERED'
];
// Which customer-facing step each rider stage counts as.
const STAGE_TO_STEP = {
  ACCEPTED: 2, GOING_TO_VENDOR: 2, ARRIVED_AT_VENDOR: 2,
  GAS_COLLECTED: 3, GOING_TO_CUSTOMER: 3,
  ARRIVED_AT_CUSTOMER: 4, CUSTOMER_PIN_VERIFIED: 4,
  DELIVERED: 5
};

// Same rider-payment formula the rider app's own demo data uses
// (ADMIN_PAYMENT_CONFIG, ruleType 'base_plus_distance').
const RIDER_PAY_BASE = 450;
const RIDER_PAY_PER_KM = 95;

function calcPrice(sizeKg, priceFactor) {
  const factor = Number(priceFactor);
  const c = CYLINDERS[String(sizeKg)];
  const gas = c ? roundTo50(c.price * factor) : roundTo50(sizeKg * OTHER_PRICE_PER_KG * factor);
  const delivery = c ? c.delivery : OTHER_DELIVERY_FEE;
  return { gas, service: SERVICE_FEE, delivery, total: gas + SERVICE_FEE + delivery };
}

// Asks Paystack's own servers whether a payment reference really succeeded,
// and for how much. Never trust a 'success' claim that only came from the
// customer's phone.
async function paystackVerify(reference) {
  const res = await fetch('https://api.paystack.co/transaction/verify/' + encodeURIComponent(reference), {
    headers: { Authorization: 'Bearer ' + PAYSTACK_SECRET_KEY }
  });
  const body = await res.json();
  if (!res.ok || !body.status) throw new Error(body.message || 'Could not reach Paystack.');
  return body.data; // { status, amount (kobo), currency, reference, customer: { email }, ... }
}

/* ---------- Database tables (created automatically) ---------- */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS gas_users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  phone_key TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS gas_vendors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT,
  sizes TEXT[] NOT NULL,
  price_factor NUMERIC(4,2) NOT NULL DEFAULT 1.00,
  is_open BOOLEAN NOT NULL DEFAULT true,
  hours TEXT,
  is_verified BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS gas_riders (
  id SERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  phone_key TEXT NOT NULL UNIQUE,
  name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE SEQUENCE IF NOT EXISTS gas_order_seq START 1043;
CREATE TABLE IF NOT EXISTS gas_orders (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES gas_users(id),
  size_label TEXT NOT NULL,
  size_kg NUMERIC NOT NULL,
  vendor_id TEXT NOT NULL REFERENCES gas_vendors(id),
  gas_charge INTEGER NOT NULL,
  service_fee INTEGER NOT NULL,
  delivery_fee INTEGER NOT NULL,
  total INTEGER NOT NULL,
  address JSONB NOT NULL,
  payment_method TEXT,
  payment_status TEXT NOT NULL DEFAULT 'unpaid',
  status_step INTEGER NOT NULL DEFAULT 1,
  status_times JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rider_id INTEGER REFERENCES gas_riders(id),
  rider_stage TEXT,
  pin TEXT,
  distance_km NUMERIC,
  eta_mins INTEGER,
  rider_earning INTEGER
);
ALTER TABLE gas_orders ADD COLUMN IF NOT EXISTS rider_id INTEGER REFERENCES gas_riders(id);
ALTER TABLE gas_orders ADD COLUMN IF NOT EXISTS rider_stage TEXT;
ALTER TABLE gas_orders ADD COLUMN IF NOT EXISTS pin TEXT;
ALTER TABLE gas_orders ADD COLUMN IF NOT EXISTS distance_km NUMERIC;
ALTER TABLE gas_orders ADD COLUMN IF NOT EXISTS eta_mins INTEGER;
ALTER TABLE gas_orders ADD COLUMN IF NOT EXISTS rider_earning INTEGER;
ALTER TABLE gas_orders ADD COLUMN IF NOT EXISTS paystack_ref TEXT;
CREATE TABLE IF NOT EXISTS gas_notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES gas_users(id),
  order_id INTEGER REFERENCES gas_orders(id),
  text TEXT NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

// Sample vendors. They are NOT verified (is_verified = false) until you check them for real.
const SAMPLE_VENDORS = [
  ['v1', 'Sunrise Gas Partner',     '4 Market Road, Demo City',     ['3', '6', '12.5', '25'], 1.00, true,  'Open until 8:00 PM'],
  ['v2', 'BlueFlame Refill Hub',    '18 Station Avenue, Demo City', ['6', '12.5', '25'],      0.97, true,  'Open until 9:00 PM'],
  ['v3', 'Greenfield Energy Depot', '2 Garden Close, Demo City',    ['3', '6', '12.5'],       1.02, false, 'Opens at 7:00 AM'],
  ['v4', 'CityGas Point',           '77 Industrial Way, Demo City', ['12.5', '25'],           0.95, true,  'Open until 6:00 PM']
];

async function initDatabase() {
  await pool.query(SCHEMA);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM gas_vendors');
  if (rows[0].n === 0) {
    for (const v of SAMPLE_VENDORS) {
      await pool.query(
        'INSERT INTO gas_vendors (id, name, address, sizes, price_factor, is_open, hours) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        v
      );
    }
  }
}

/* ---------- Small helpers ---------- */
const app = express();
app.use(cors());
app.use(express.json({ limit: '50kb' }));

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const str = v => (typeof v === 'string' ? v.trim() : '');
const phoneKey = phone => String(phone || '').replace(/\D/g, '').slice(-10);
const bad = (res, message, status) => res.status(status || 400).json({ error: message });
const fmtAddress = a => [a.house, a.street, a.area, a.city].filter(Boolean).join(', ');

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}
function userOut(u) {
  return { id: u.id, name: u.name, phone: u.phone, email: u.email };
}
function riderOut(r) {
  return { id: r.id, name: r.name, phone: r.phone };
}
function vendorOut(v) {
  return {
    id: v.id, name: v.name, address: v.address, sizes: v.sizes,
    priceFactor: Number(v.price_factor), isOpen: v.is_open, hours: v.hours,
    verified: v.is_verified // false for the sample vendors
  };
}
function orderOut(o) {
  return {
    id: o.code,
    createdAt: o.created_at,
    sizeLabel: o.size_label,
    sizeKg: Number(o.size_kg),
    gas: o.gas_charge,
    service: o.service_fee,
    delivery: o.delivery_fee,
    total: o.total,
    address: o.address,
    vendor: { id: o.vendor_id, name: o.vendor_name },
    method: o.payment_method,
    paymentStatus: o.payment_status,
    step: o.status_step,
    times: o.status_times,
    // Shown to the order's own customer (already their own info) and to
    // admin staff, who legitimately need to know who an order belongs to.
    customerName: o.customer_name,
    customerPhone: o.customer_phone,
    riderId: o.rider_id || null,
    riderStage: o.rider_stage || null
  };
}
// Shaped to match the order object the rider app's own demo data already
// uses (o.customer.*, o.vendor.*, o.stage, o.pin, o.cylinderSize, ...), so
// the rider app's existing screens can render a real order unchanged.
function riderOrderOut(o) {
  return {
    id: o.code,
    gasType: 'LPG (Cooking Gas)',
    cylinderSize: o.size_label,
    quantity: 1,
    type: 'Refill',
    vendor: { name: o.vendor_name, address: o.vendor_address },
    customer: {
      name: o.customer_name,
      phone: (o.address && o.address.phone) || o.customer_phone,
      address: fmtAddress(o.address || {}),
      instructions: 'Call on arrival'
    },
    distanceKm: Number(o.distance_km),
    etaMins: o.eta_mins,
    deliveryFee: o.delivery_fee,
    riderEarning: o.rider_earning,
    pin: o.pin,
    stage: o.rider_stage,
    createdAt: o.created_at
  };
}

const ORDER_SELECT =
  'SELECT o.*, v.name AS vendor_name, v.address AS vendor_address, u.name AS customer_name, u.phone AS customer_phone ' +
  'FROM gas_orders o JOIN gas_vendors v ON v.id = o.vendor_id JOIN gas_users u ON u.id = o.user_id';

/* ---------- Login checks (the "who is this?" step) ---------- */
function requireUser(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload.uid) throw new Error('not a customer token');
    req.uid = payload.uid;
    next();
  } catch (e) {
    bad(res, 'Please log in again.', 401);
  }
}
function requireRider(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload.rid) throw new Error('not a rider token');
    req.rid = payload.rid;
    next();
  } catch (e) {
    bad(res, 'Please log in again.', 401);
  }
}
function requireAdmin(req, res, next) {
  if (!ADMIN_KEY || req.headers['x-admin-key'] !== ADMIN_KEY) return bad(res, 'Not allowed.', 403);
  next();
}

/* ---------- Routes ---------- */
app.get('/', (req, res) => res.json({ app: 'FOM GAS backend', ok: true }));
app.get('/health', wrap(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, demoMode: DEMO_MODE });
}));

/* ===================== CUSTOMER ACCOUNTS ===================== */

// Create account
app.post('/auth/register', wrap(async (req, res) => {
  const name = str(req.body.name);
  const phone = str(req.body.phone);
  const email = str(req.body.email).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (name.length < 2) return bad(res, 'Please enter your full name.');
  if (phoneKey(phone).length < 10) return bad(res, 'Please enter a valid phone number.');
  if (!/^\S+@\S+\.\S+$/.test(email)) return bad(res, 'Please enter a valid email address.');
  if (password.length < 6) return bad(res, 'Password must be at least 6 characters.');

  const hash = await bcrypt.hash(password, 10);
  try {
    const { rows } = await pool.query(
      'INSERT INTO gas_users (name, phone, phone_key, email, password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, phone, email',
      [name, phone, phoneKey(phone), email, hash]
    );
    res.status(201).json({ token: signToken({ uid: rows[0].id }), user: userOut(rows[0]) });
  } catch (e) {
    if (e.code === '23505') return bad(res, 'An account with this phone number or email already exists.', 409);
    throw e;
  }
}));

// Login with phone or email
app.post('/auth/login', wrap(async (req, res) => {
  const id = str(req.body.identifier);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!id || !password) return bad(res, 'Enter your phone or email and your password.');
  const { rows } = await pool.query(
    'SELECT * FROM gas_users WHERE email = $1 OR phone_key = $2 LIMIT 1',
    [id.toLowerCase(), phoneKey(id)]
  );
  const user = rows[0];
  const ok = user && (await bcrypt.compare(password, user.password_hash));
  if (!ok) return bad(res, 'Wrong phone/email or password.', 401);
  res.json({ token: signToken({ uid: user.id }), user: userOut(user) });
}));

app.get('/me', requireUser, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT id, name, phone, email FROM gas_users WHERE id = $1', [req.uid]);
  if (!rows[0]) return bad(res, 'Please log in again.', 401);
  res.json({ user: userOut(rows[0]) });
}));

// Vendors (public list)
app.get('/vendors', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM gas_vendors ORDER BY id');
  res.json({ vendors: rows.map(vendorOut) });
}));

/* ===================== CUSTOMER ORDERS ===================== */

// Place an order. The SERVER works out the price, never the phone.
app.post('/orders', requireUser, wrap(async (req, res) => {
  const sizeKg = Number(req.body.sizeKg);
  const vendorId = str(req.body.vendorId) || 'v1';
  const a = req.body.address || {};
  const address = {
    house: str(a.house), street: str(a.street), area: str(a.area), city: str(a.city), phone: str(a.phone)
  };
  const method = str(req.body.paymentMethod).slice(0, 40) || null;
  // Two ways an order can arrive already paid:
  //  - demoPaid: the app's own demo payment (card/transfer demo, or the
  //    in-app wallet) says it succeeded. Still exactly what it was before —
  //    a claim the phone makes, nothing more.
  //  - paystackRef: a REAL Paystack transaction reference. This server
  //    checks that reference with Paystack itself below; the phone's word
  //    is never enough on its own for this one.
  const demoPaid = req.body.demoPaid === true;
  const paystackRef = str(req.body.paystackRef);

  if (!(sizeKg >= 1 && sizeKg <= 50)) return bad(res, 'Cylinder size must be between 1kg and 50kg.');
  if (!address.house || !address.street || !address.area || !address.city) return bad(res, 'Please fill in the full address.');
  if (phoneKey(address.phone).length < 10) return bad(res, 'Please enter a phone number the driver can call.');

  const v = (await pool.query('SELECT * FROM gas_vendors WHERE id = $1', [vendorId])).rows[0];
  if (!v) return bad(res, 'That vendor was not found.', 404);

  const price = calcPrice(sizeKg, v.price_factor);

  let paymentStatus = 'unpaid';
  if (paystackRef) {
    if (!PAYSTACK_SECRET_KEY) return bad(res, 'Real payments are not turned on for this server yet.', 503);
    let tx;
    try { tx = await paystackVerify(paystackRef); }
    catch (e) { return bad(res, 'Could not confirm that payment with Paystack. Please try again.', 502); }
    if (tx.status !== 'success') return bad(res, 'That payment was not successful.', 402);
    if (tx.currency !== 'NGN' || tx.amount !== price.total * 100) return bad(res, 'That payment does not match this order.', 402);
    paymentStatus = 'paid';
  } else if (demoPaid) {
    paymentStatus = 'paid';
  }

  const sizeLabel = sizeKg + ' kg';
  const now = new Date().toISOString();
  const pin = String(Math.floor(1000 + Math.random() * 8999));
  const distanceKm = Number((1 + Math.random() * 6).toFixed(1));
  const etaMins = Math.round(distanceKm * 4 + 6);
  const riderEarning = Math.round(RIDER_PAY_BASE + distanceKm * RIDER_PAY_PER_KM);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO gas_orders
        (code, user_id, size_label, size_kg, vendor_id, gas_charge, service_fee, delivery_fee, total, address,
         payment_method, payment_status, status_times, pin, distance_km, eta_mins, rider_earning, paystack_ref)
       VALUES ('FG-' || nextval('gas_order_seq'), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING *`,
      [req.uid, sizeLabel, sizeKg, v.id, price.gas, price.service, price.delivery, price.total,
        JSON.stringify(address), method, paymentStatus, JSON.stringify([now]), pin, distanceKm, etaMins, riderEarning,
        paystackRef || null]
    );
    await client.query('INSERT INTO gas_notifications (user_id, order_id, text) VALUES ($1,$2,$3)',
      [req.uid, ins.rows[0].id, STEP_NOTIFS[0]]);
    await client.query('COMMIT');
    res.status(201).json({ order: orderOut({ ...ins.rows[0], vendor_name: v.name }) });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// My orders (newest first)
app.get('/orders', requireUser, wrap(async (req, res) => {
  const { rows } = await pool.query(ORDER_SELECT + ' WHERE o.user_id = $1 ORDER BY o.id DESC', [req.uid]);
  res.json({ orders: rows.map(orderOut) });
}));

app.get('/orders/:code', requireUser, wrap(async (req, res) => {
  const { rows } = await pool.query(ORDER_SELECT + ' WHERE o.code = $1 AND o.user_id = $2', [req.params.code, req.uid]);
  if (!rows[0]) return bad(res, 'Order not found.', 404);
  res.json({ order: orderOut(rows[0]) });
}));

// Move an order to its next customer-facing step (used for admin/demo testing
// without a rider — the rider app instead uses /rider/orders/:code/advance).
async function advanceOrder(code, userId) {
  const params = [code, new Date().toISOString()];
  let where = 'code = $1 AND status_step < ' + LAST_STEP;
  if (userId) { params.push(userId); where += ' AND user_id = $3'; }
  const up = await pool.query(
    `UPDATE gas_orders SET status_step = status_step + 1, status_times = status_times || to_jsonb($2::text)
     WHERE ${where} RETURNING id, user_id, status_step`,
    params
  );
  if (!up.rows[0]) return null;
  const row = up.rows[0];
  await pool.query('INSERT INTO gas_notifications (user_id, order_id, text) VALUES ($1,$2,$3)',
    [row.user_id, row.id, STEP_NOTIFS[row.status_step - 1]]);
  const full = await pool.query(ORDER_SELECT + ' WHERE o.id = $1', [row.id]);
  return orderOut(full.rows[0]);
}

// Testing only: the customer moves their own order forward (needs DEMO_MODE=true)
app.post('/orders/:code/demo-advance', requireUser, wrap(async (req, res) => {
  if (!DEMO_MODE) return bad(res, 'Demo mode is off.', 403);
  const order = await advanceOrder(req.params.code, req.uid);
  if (!order) return bad(res, 'That order is already delivered, or was not found.', 400);
  res.json({ order });
}));

// Notifications
app.get('/notifications', requireUser, wrap(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, text, is_read, created_at FROM gas_notifications WHERE user_id = $1 ORDER BY id DESC LIMIT 50',
    [req.uid]
  );
  res.json({ notifications: rows.map(n => ({ id: n.id, text: n.text, read: n.is_read, createdAt: n.created_at })) });
}));
app.post('/notifications/read', requireUser, wrap(async (req, res) => {
  await pool.query('UPDATE gas_notifications SET is_read = true WHERE user_id = $1', [req.uid]);
  res.json({ ok: true });
}));

/* ===================== RIDER ACCOUNTS ===================== */
// Demo phone login: no real SMS is sent. The code is returned directly in
// the response, exactly like the rider app's own "demo mode" banner already
// says — this just makes the SAME phone number work as the SAME rider from
// any device, instead of a new demo rider being invented per browser.
const riderOtps = new Map(); // phoneKey -> { code, expires }

app.post('/rider/auth/send-otp', wrap(async (req, res) => {
  const phone = str(req.body.phone);
  const key = phoneKey(phone);
  if (key.length < 10) return bad(res, 'Please enter a valid phone number.');
  const code = String(Math.floor(1000 + Math.random() * 8999));
  riderOtps.set(key, { code, expires: Date.now() + 5 * 60 * 1000 });
  res.json({ phone, code }); // demo: code sent back directly, not by SMS
}));

app.post('/rider/auth/verify-otp', wrap(async (req, res) => {
  const phone = str(req.body.phone);
  const code = str(req.body.code);
  const key = phoneKey(phone);
  const entry = riderOtps.get(key);
  if (!entry || entry.code !== code || entry.expires < Date.now()) {
    return bad(res, 'That code is wrong or has expired. Request a new one.', 401);
  }
  riderOtps.delete(key);
  const { rows } = await pool.query(
    `INSERT INTO gas_riders (phone, phone_key) VALUES ($1,$2)
     ON CONFLICT (phone_key) DO UPDATE SET phone = EXCLUDED.phone
     RETURNING *`,
    [phone, key]
  );
  res.json({ token: signToken({ rid: rows[0].id }), rider: riderOut(rows[0]) });
}));

app.get('/rider/me', requireRider, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM gas_riders WHERE id = $1', [req.rid]);
  if (!rows[0]) return bad(res, 'Please log in again.', 401);
  res.json({ rider: riderOut(rows[0]) });
}));
app.post('/rider/me', requireRider, wrap(async (req, res) => {
  const name = str(req.body.name);
  if (name.length < 2) return bad(res, 'Enter a name.');
  const { rows } = await pool.query('UPDATE gas_riders SET name = $1 WHERE id = $2 RETURNING *', [name, req.rid]);
  res.json({ rider: riderOut(rows[0]) });
}));

/* ===================== RIDER ORDERS ===================== */
// This is the actual "connection" between the two apps: both read and
// write the same gas_orders rows the customer app created.

// The next unclaimed order, if any (the rider app asks for one at a time,
// the same way its own "Find an order" demo button already works).
app.get('/rider/orders/next', requireRider, wrap(async (req, res) => {
  const { rows } = await pool.query(
    ORDER_SELECT + " WHERE o.rider_id IS NULL AND o.payment_status = 'paid' ORDER BY o.id ASC LIMIT 1"
  );
  res.json({ order: rows[0] ? riderOrderOut(rows[0]) : null });
}));

app.post('/rider/orders/:code/claim', requireRider, wrap(async (req, res) => {
  const up = await pool.query(
    `UPDATE gas_orders SET rider_id = $1, rider_stage = 'ACCEPTED', status_step = GREATEST(status_step, 2)
     WHERE code = $2 AND rider_id IS NULL RETURNING id, user_id`,
    [req.rid, req.params.code]
  );
  if (!up.rows[0]) return bad(res, 'Someone else already picked up this order.', 409);
  await pool.query('INSERT INTO gas_notifications (user_id, order_id, text) VALUES ($1,$2,$3)',
    [up.rows[0].user_id, up.rows[0].id, STEP_NOTIFS[1]]);
  const full = await pool.query(ORDER_SELECT + ' WHERE o.code = $1', [req.params.code]);
  res.json({ order: riderOrderOut(full.rows[0]) });
}));

app.post('/rider/orders/:code/advance', requireRider, wrap(async (req, res) => {
  const stage = str(req.body.stage);
  if (RIDER_STAGES.indexOf(stage) === -1) return bad(res, 'That is not a real delivery stage.');
  const current = await pool.query('SELECT * FROM gas_orders WHERE code = $1 AND rider_id = $2', [req.params.code, req.rid]);
  if (!current.rows[0]) return bad(res, 'Order not found, or it is not assigned to you.', 404);
  const o = current.rows[0];
  const from = RIDER_STAGES.indexOf(o.rider_stage);
  const to = RIDER_STAGES.indexOf(stage);
  if (to !== from + 1) return bad(res, 'Delivery stages must be completed in order.');

  const newStep = STAGE_TO_STEP[stage];
  const bumpStep = newStep > o.status_step;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const up = await client.query(
      `UPDATE gas_orders SET rider_stage = $1, status_step = $2,
         status_times = status_times || to_jsonb($3::text)
       WHERE code = $4 RETURNING id, user_id`,
      [stage, Math.max(newStep, o.status_step), new Date().toISOString(), req.params.code]
    );
    if (bumpStep) {
      await client.query('INSERT INTO gas_notifications (user_id, order_id, text) VALUES ($1,$2,$3)',
        [up.rows[0].user_id, up.rows[0].id, STEP_NOTIFS[newStep - 1]]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  const full = await pool.query(ORDER_SELECT + ' WHERE o.code = $1', [req.params.code]);
  res.json({ order: riderOrderOut(full.rows[0]) });
}));

// The rider's own active order + delivery history.
app.get('/rider/orders/mine', requireRider, wrap(async (req, res) => {
  const { rows } = await pool.query(ORDER_SELECT + ' WHERE o.rider_id = $1 ORDER BY o.id DESC LIMIT 100', [req.rid]);
  const all = rows.map(riderOrderOut);
  res.json({
    active: all.find(o => o.stage !== 'DELIVERED') || null,
    history: all.filter(o => o.stage === 'DELIVERED')
  });
}));

/* ===================== ADMIN ===================== */
// send the header  x-admin-key: YOUR_ADMIN_KEY
app.get('/admin/orders', requireAdmin, wrap(async (req, res) => {
  const { rows } = await pool.query(ORDER_SELECT + ' ORDER BY o.id DESC LIMIT 200');
  res.json({ orders: rows.map(orderOut) });
}));
app.post('/admin/orders/:code/advance', requireAdmin, wrap(async (req, res) => {
  const order = await advanceOrder(req.params.code, null);
  if (!order) return bad(res, 'That order is already delivered, or was not found.', 400);
  res.json({ order });
}));
// Testing only: mark an order paid without a real payment, so it appears
// for riders to claim (until Paystack is wired up, real orders never
// reach payment_status = 'paid' any other way).
app.post('/admin/orders/:code/mark-paid', requireAdmin, wrap(async (req, res) => {
  const up = await pool.query("UPDATE gas_orders SET payment_status = 'paid' WHERE code = $1 RETURNING id", [req.params.code]);
  if (!up.rows[0]) return bad(res, 'Order not found.', 404);
  res.json({ ok: true });
}));

/* ---------- Errors ---------- */
app.use((req, res) => bad(res, 'Not found.', 404));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.type === 'entity.parse.failed') return bad(res, 'Bad request data.');
  console.error(err);
  bad(res, 'Something went wrong on the server.', 500);
});

/* ---------- Start ---------- */
initDatabase()
  .then(() => app.listen(PORT, () => console.log('FOM GAS backend running on port ' + PORT)))
  .catch(err => { console.error('Could not start:', err); process.exit(1); });
