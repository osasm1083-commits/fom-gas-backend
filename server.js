/* =========================================================
   FOM GAS backend (version 0.1)
   ---------------------------------------------------------
   Real accounts, vendors, orders and notifications in Postgres.

   NOT built yet (do not pretend otherwise in the app):
   - Real payments. Orders are saved with payment_status
     'unpaid'. Paystack will be added later.
   - Real drivers, GPS or vendor verification. Sample vendors
     are saved with is_verified = false.
   - SMS / email sending (no password reset yet).

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

const { DATABASE_URL, JWT_SECRET, ADMIN_KEY } = process.env;
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

const STEP_NOTIFS = [
  'Your refill request has been received.',
  'Your driver has been assigned.',
  'Your cylinder has been picked up.',
  'Your cylinder has arrived at the gas vendor.',
  'Your cylinder has been refilled.',
  'Your cylinder is on its way back to you.',
  'Your cylinder has been delivered.'
];
const LAST_STEP = STEP_NOTIFS.length; // 7

function calcPrice(sizeKg, priceFactor) {
  const factor = Number(priceFactor);
  const c = CYLINDERS[String(sizeKg)];
  const gas = c ? roundTo50(c.price * factor) : roundTo50(sizeKg * OTHER_PRICE_PER_KG * factor);
  const delivery = c ? c.delivery : OTHER_DELIVERY_FEE;
  return { gas, service: SERVICE_FEE, delivery, total: gas + SERVICE_FEE + delivery };
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
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

function signToken(user) {
  return jwt.sign({ uid: user.id }, JWT_SECRET, { expiresIn: '30d' });
}
function userOut(u) {
  return { id: u.id, name: u.name, phone: u.phone, email: u.email };
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
    times: o.status_times
  };
}

const ORDER_SELECT =
  'SELECT o.*, v.name AS vendor_name FROM gas_orders o JOIN gas_vendors v ON v.id = o.vendor_id';

/* ---------- Login check (the "who is this?" step) ---------- */
function requireUser(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  try {
    req.uid = jwt.verify(token, JWT_SECRET).uid;
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
    res.status(201).json({ token: signToken(rows[0]), user: userOut(rows[0]) });
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
  res.json({ token: signToken(user), user: userOut(user) });
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

// Place an order. The SERVER works out the price, never the phone.
app.post('/orders', requireUser, wrap(async (req, res) => {
  const sizeKg = Number(req.body.sizeKg);
  const vendorId = str(req.body.vendorId) || 'v1';
  const a = req.body.address || {};
  const address = {
    house: str(a.house), street: str(a.street), area: str(a.area), city: str(a.city), phone: str(a.phone)
  };
  const method = str(req.body.paymentMethod).slice(0, 40) || null;

  if (!(sizeKg >= 1 && sizeKg <= 50)) return bad(res, 'Cylinder size must be between 1kg and 50kg.');
  if (!address.house || !address.street || !address.area || !address.city) return bad(res, 'Please fill in the full address.');
  if (phoneKey(address.phone).length < 10) return bad(res, 'Please enter a phone number the driver can call.');

  const v = (await pool.query('SELECT * FROM gas_vendors WHERE id = $1', [vendorId])).rows[0];
  if (!v) return bad(res, 'That vendor was not found.', 404);

  const price = calcPrice(sizeKg, v.price_factor);
  const sizeLabel = sizeKg + ' kg';
  const now = new Date().toISOString();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO gas_orders
        (code, user_id, size_label, size_kg, vendor_id, gas_charge, service_fee, delivery_fee, total, address, payment_method, status_times)
       VALUES ('FG-' || nextval('gas_order_seq'), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [req.uid, sizeLabel, sizeKg, v.id, price.gas, price.service, price.delivery, price.total,
        JSON.stringify(address), method, JSON.stringify([now])]
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

// Move an order to its next status. Returns the updated order or null if it is already delivered.
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

// Admin (send the header  x-admin-key: YOUR_ADMIN_KEY)
app.get('/admin/orders', requireAdmin, wrap(async (req, res) => {
  const { rows } = await pool.query(ORDER_SELECT + ' ORDER BY o.id DESC LIMIT 200');
  res.json({ orders: rows.map(orderOut) });
}));
app.post('/admin/orders/:code/advance', requireAdmin, wrap(async (req, res) => {
  const order = await advanceOrder(req.params.code, null);
  if (!order) return bad(res, 'That order is already delivered, or was not found.', 400);
  res.json({ order });
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
