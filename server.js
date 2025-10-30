require('dotenv').config();

console.log("✅ TAX_RATE:", process.env.TAX_RATE, "TAX_INCLUSIVE:", process.env.TAX_INCLUSIVE);

// normalize env strings (remove trailing spaces) and canonicalize SMTP_SECURE
Object.keys(process.env).forEach(k => {
  if (typeof process.env[k] === 'string') process.env[k] = process.env[k].trim();
});
process.env.SMTP_SECURE = String(process.env.SMTP_SECURE || 'false').toLowerCase();

// --- ADDED: global error handlers + lightweight startup diagnostics (safe) ---
process.on('uncaughtException', (err) => {
  console.error('FATAL: uncaughtException:', err && (err.stack || err));
  // give logs a moment to flush then exit
  setTimeout(() => process.exit(1), 1000);
});
process.on('unhandledRejection', (reason) => {
  console.error('FATAL: unhandledRejection:', reason && (reason.stack || reason));
  setTimeout(() => process.exit(1), 1000);
});


// Lightweight module presence checks (do not require optional modules)
try {
  try { require.resolve('twilio'); console.log('module: twilio installed'); }
  catch (e) { console.log('module: twilio NOT installed'); }
  try { require.resolve('nodemailer'); console.log('module: nodemailer installed'); }
  catch (e { console.log('module: nodemailer NOT installed'); }
} catch (e) {
  console.error('Startup module checks failed:', e && (e.stack || e));
}

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { Pool } = require("pg");
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// create app FIRST
const app = express();

// --- LOGIN RATE LIMITER (in-memory, incremental backoff) ---
const loginAttempts = new Map();
/*
  Map value shape:
  {
    failedCount: number,        // failures since last lock
    penaltyLevel: number,       // number of times lock applied (1 => 3min, 2 => 6min, ...)
    lockUntil: number | null    // timestamp ms until unlocking
  }
*/
const LOCK_WINDOW_MINUTES = 3;
const MAX_ATTEMPTS = 5;

function loginKeyFromReq(req) {
  const body = req.body || {};
  // prefer username, then device_id (client may send), then pin, then IP fallback
  const raw = (body.username || body.device_id || body.pin || req.ip || "anon").toString();
  return raw.trim().toLowerCase();
}

function getAttemptInfo(key) {
  const info = loginAttempts.get(key);
  if (!info) return { failedCount: 0, penaltyLevel: 0, lockUntil: null };
  return info;
}

function isLocked(key) {
  const info = getAttemptInfo(key);
  if (info.lockUntil && Date.now() < info.lockUntil) {
    return { locked: true, remainingMs: info.lockUntil - Date.now(), info };
  }
  return { locked: false, remainingMs: 0, info };
}

function recordFailedAttempt(key) {
  const info = getAttemptInfo(key);
  info.failedCount = (info.failedCount || 0) + 1;
  // if exceeds limit, apply lock and increment penaltyLevel
  if (info.failedCount >= MAX_ATTEMPTS) {
    info.penaltyLevel = (info.penaltyLevel || 0) + 1;
    const minutes = LOCK_WINDOW_MINUTES * info.penaltyLevel;
    info.lockUntil = Date.now() + minutes * 60 * 1000;
    info.failedCount = 0; // reset counter after lock
    console.warn(`Login lock applied for key=${key} for ${minutes} minutes (penaltyLevel=${info.penaltyLevel})`);
  }
  loginAttempts.set(key, info);
  return info;
}

function resetAttempts(key) {
  loginAttempts.delete(key);
}

// middleware
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE"],
   allowedHeaders: [
    "Content-Type",
    "Authorization",
    "x-admin-key",
    "x-super-username",
    "x-admin-token",
    "x-user-id"
  ]
}));
// allow larger JSON bodies so clients can send base64 images
app.use(express.json({ limit: "12mb" }));
app.use(express.urlencoded({ extended: true, limit: "12mb" })); // in case form-encoded data is used

// serve uploaded files (ensure folder exists)
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

// Health check
app.get('/health', (_req, res) => res.json({ ok: true }))


const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // Render requires SSL
  },
});

// ensure PORT is defined (add this)
const PORT = process.env.PORT || 3000;

// quick connection check - prints clear success or error to server console
(async () => {
  try {
    const r = await pool.query('SELECT NOW()');
    console.log(`✅ Postgres connected (ok=${r.rows[0].now})`);
  } catch (err) {
    console.error('❌ Postgres connection failed:', err.message || err);
  }
})();

pool.on("error", (err) => {
  console.error("POSTGRES POOL ERROR:", err && err.stack ? err.stack : err);
});

async function dbQuery(text, params = []) {
  try {
    const result = await pool.query(text, params);
    return result.rows; // return rows array for callers
  } catch (err) {
    console.error("SQL ERROR:", { text, params, message: err.message, stack: err.stack });
    throw err;
  }
}

// Example: replace your existing products endpoints with versions that use dbQuery
app.get("/products-with-stock", async (req, res) => {
  try {
    // fetch all active products (basic fields)
    const prodRes = await pool.query(
      `SELECT id, name, price, category, sku, photo, color, is_active
       FROM products
       WHERE (is_active = true OR is_active IS NULL)`
    );
    const products = prodRes.rows || [];
    const out = [];

    for (const p of products) {
      // load product ingredients + ingredient inventory info
      const ingrRes = await pool.query(
        `SELECT
           pi.ingredient_id,
           pi.amount_needed,
           pi.amount_unit,
           i.unit AS ingredient_unit,
           i.stock AS ingredient_stock,
           i.piece_amount,
           i.piece_unit
         FROM product_ingredients pi
         JOIN ingredients i ON pi.ingredient_id = i.id
         WHERE pi.product_id = $1`,
        [p.id]
      );

      const counts = [];

      for (const r of ingrRes.rows) {
        const prodAmount = Number(r.amount_needed);
        if (!Number.isFinite(prodAmount) || prodAmount <= 0) {
          counts.push(0);
          continue;
        }

        const prodUnit = r.amount_unit || r.ingredient_unit;
        const invAmt = Number(r.ingredient_stock ?? 0);
        const invUnit = r.ingredient_unit;

        const invInProdUnits = convertInventoryToProductUnits(invAmt, invUnit, prodUnit, {
          piece_amount: r.piece_amount,
          piece_unit: r.piece_unit,
        });

        if (!Number.isFinite(invInProdUnits)) {
          // cannot convert -> treat as blocker (0 available)
          counts.push(0);
        } else {
          const availableCount = Math.floor(invInProdUnits / prodAmount);
          counts.push(Number.isFinite(availableCount) ? Math.max(0, availableCount) : 0);
        }
      }

      const available = counts.length > 0 ? Math.min(...counts) : 0;

      out.push({
        id: p.id,
        name: p.name,
        price: p.price !== null ? Number(p.price) : 0,
        category: p.category,
        sku: p.sku,
        photo: p.photo,
        color: p.color,
        is_active: p.is_active,
        stock: available,
      });
    }

    return res.json(out);
  } catch (err) {
    console.error("❌ /products-with-stock error:", err && (err.message || err));
    return res.status(500).json({ success: false, message: "Failed to compute product stock", error: String(err && err.message || err) });
  }
});

app.get("/products-all-admin", async (req, res) => {
  try {
    const sql = `
      SELECT
        p.id,
        p.name,
        p.price,
        p.category,
        p.is_active,
        COALESCE(
          MIN(FLOOR(i.stock / NULLIF(pi.amount_needed,0))),
          COALESCE(p.stock,0)
        )::int AS stock
      FROM products p
      LEFT JOIN product_ingredients pi ON pi.product_id = p.id
      LEFT JOIN ingredients i ON pi.ingredient_id = i.id
      GROUP BY p.id, p.name, p.price, p.category, p.stock, p.is_active
      ORDER BY p.name;
    `;
    const result = await pool.query(sql);
    return res.json(result.rows || []);
  } catch (err) {
    console.error('❌ /products-all-admin error:', err.message || err);
    return res.status(500).json({ success: false, message: 'Database error' });
  }
});

// Example: replace your handler SQL calls with dbQuery(...) so errors are logged with the SQL.
app.post("/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res
      .status(400)
      .json({ success: false, message: "Missing credentials" });

  console.log("DEBUG /login env:", {
    DATABASE_URL: process.env.DATABASE_URL,
    DB_USER: process.env.DB_USER,
    PGUSER: process.env.PGUSER,
    USER: process.env.USER,
  });

  const key = loginKeyFromReq(req);
  const lock = isLocked(key);
  if (lock.locked) {
    const secs = Math.ceil(lock.remainingMs / 1000);
    return res
      .status(429)
      .json({
        success: false,
        message: `Too many attempts. Try again in ${secs} seconds`,
      });
  }

  try {
    const result = await pool.query(
      "SELECT id, username, password, role FROM users WHERE username = $1 LIMIT 1",
      [username]
    );

    if (!result.rows || result.rows.length === 0) {
      recordFailedAttempt(key);
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    const user = result.rows[0];
    const stored = String(user.password || "");
    let ok = false;

    if (stored.startsWith("$2")) {
      ok = bcrypt.compareSync(password, stored);
    } else {
      ok = password === stored;
    }

    if (!ok) {
      recordFailedAttempt(key);
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    // ✅ success: reset attempts
    resetAttempts(key);

    const deviceId =
      req.body && req.body.device_id ? String(req.body.device_id) : null;

    // ✅ unified single-active-session logic (for all users)
    const active = await getActiveSessionForUser(user.id);
    if (
      active &&
      active.active_session_token &&
      active.active_session_expires &&
      new Date(active.active_session_expires) > new Date()
    ) {
      // active, non-expired session exists
      if (active.active_session_device !== deviceId) {
        return res
          .status(423)
          .json({
            success: false,
            message: "User already logged in from another device",
          });
      }
      // same device → extend session
      const updated = await createOrUpdateSession(user.id, deviceId);
      return res.json({
        success: true,
        id: user.id,
        username: user.username,
        role: user.role,
        sessionToken: updated.token,
        sessionExpires: updated.expires,
      });
    } else {
      // no active session → create one
      const created = await createOrUpdateSession(user.id, deviceId);
      return res.json({
        success: true,
        id: user.id,
        username: user.username,
        role: user.role,
        sessionToken: created.token,
        sessionExpires: created.expires,
      });
    }
  } catch (err) {
    console.error("❌ Login query error:", err);
    return res.status(500).json({
      success: false,
      message: "Database error",
      error: err.message,
      detail: err.stack?.split("\n")[0],
    });
  }
});



app.get('/products', async (req, res) => {
  try {
    const sql = 'SELECT id, name, price, stock FROM products';
    const result = await pool.query(sql);

    // ✅ Return rows instead of raw result
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Error fetching products:', err.message);
    res.status(500).json({ error: 'Database error', details: err.message });
  }
});


app.post('/submit-order', async (req, res) => {
  const { items, subtotal: clientSubtotal, paymentMode } = req.body || {};

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'No items provided' });
  }

  // Normalize items: [{ id, quantity }]
  const normalizedItems = items.map((it) => ({ id: Number(it.id), quantity: Number(it.quantity || 1), unit_price: Number(it.unit_price ?? it.price ?? 0) }));

  console.warn('[SUBMIT_ORDER] normalizedItems=', normalizedItems, 'clientSubtotal=', clientSubtotal, 'paymentMode=', paymentMode);

  const client = await pool.connect();
  try {
    // tax configuration
    const TAX_RATE = Number(process.env.TAX_RATE ?? 0.12);
    const TAX_INCLUSIVE = String(process.env.TAX_INCLUSIVE || 'false').toLowerCase() === 'true';
    const round2 = (v) => Math.round(Number(v || 0) * 100) / 100;

    // Accept an explicit gross/total amount from client (preferred) so we don't
    // accidentally add VAT again. Client may send `totalAmount` | `total_with_vat` | `totalWithVat`.
    const clientGross = Number(req.body?.totalAmount ?? req.body?.total_with_vat ?? req.body?.totalWithVat ?? NaN);

    // compute subtotal (client may send inclusive price total or net)
    // `subtotal` variable should be the number passed from client (the visible/entered amount)
    let subtotalNet = 0;
    let taxAmount = 0;
    let totalAmount = 0;

    if (Number.isFinite(clientGross)) {
      // Client explicitly provided gross total (inclusive of VAT) — trust it and extract net & tax
      totalAmount = round2(clientGross);
      subtotalNet = round2(totalAmount / (1 + TAX_RATE));
      taxAmount = round2(totalAmount - subtotalNet);
    } else {
      // Fall back to the older behaviour that depended on TAX_INCLUSIVE + clientSubtotal
      subtotalNet = Number(clientSubtotal || 0);
      if (TAX_INCLUSIVE) {
        // client subtotal includes tax -> extract net and tax portion
        totalAmount = round2(subtotalNet);
        subtotalNet = round2(subtotalNet / (1 + TAX_RATE));
        taxAmount = round2(totalAmount - subtotalNet);
      } else {
        // client subtotal is net -> compute tax on top
        subtotalNet = round2(subtotalNet);
        taxAmount = round2(subtotalNet * TAX_RATE);
        totalAmount = round2(subtotalNet + taxAmount);
      }
    }

    // begin transaction and persist sale + items and record ingredient usage
    await client.query("BEGIN");
    const saleInsertSql = `
      INSERT INTO sales (subtotal_amount, tax, total_amount, payment_mode, created_at)
      VALUES ($1, $2, $3, $4, NOW())
      RETURNING id
    `;
    const saleRes = await client.query(saleInsertSql, [subtotalNet, taxAmount, totalAmount, paymentMode]);
    const saleId = saleRes.rows[0].id;

    // track which products were affected so we can recompute their product.stock
    const affectedProductIds = new Set();

    // insert sale_items and record usages per normalized item (ensures numeric fields)
    for (const it of normalizedItems) {
      const unitPrice = Number(it.unit_price ?? 0);
      await client.query(
        "INSERT INTO sale_items (product_id, quantity, unit_price, sale_id) VALUES ($1, $2, $3, $4)",
        [it.id, it.quantity, unitPrice, saleId]
      );

      // mark product as affected
      affectedProductIds.add(it.id);

      // fetch product ingredients and ingredient inventory metadata
      const ingrSql = `
        SELECT pi.ingredient_id, pi.amount_needed, COALESCE(pi.amount_unit, i.unit) AS product_unit,
               i.unit AS inventory_unit, i.piece_amount, i.piece_unit
        FROM product_ingredients pi
        JOIN ingredients i ON pi.ingredient_id = i.id
        WHERE pi.product_id = $1
      `;
      const ingrRes = await client.query(ingrSql, [it.id]);

      console.warn('[SUBMIT_ORDER] product_id=', it.id, 'foundIngredients=', ingrRes.rows.length);

      for (const r of ingrRes.rows) {
        const amountNeeded = Number(r.amount_needed || 0) * Number(it.quantity || 1);
        // convert product-unit amountNeeded -> inventory units
        const converted = convertToInventoryUnits(amountNeeded, r.product_unit, r.inventory_unit, {
          piece_amount: r.piece_amount,
          piece_unit: r.piece_unit,
        });
        const amountUsed = Number.isFinite(converted) ? converted : amountNeeded;
        console.warn('[SUBMIT_ORDER] ingredient=', r.ingredient_id, 'amountNeeded=', amountNeeded, 'amountUsed=', amountUsed);

        // decrement ingredient stock and insert usage row
        await client.query(
          "UPDATE ingredients SET stock = stock - $1 WHERE id = $2",
          [amountUsed, r.ingredient_id]
        );
        await client.query(
          `INSERT INTO ingredient_usage (sale_id, product_id, ingredient_id, amount_used, created_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [saleId, it.id, r.ingredient_id, amountUsed]
        );
      }
    }

    // recompute & persist product.stock for affected products (transactional)
    try {
      for (const pid of affectedProductIds) {
        const newStock = await computeProductStock(pid, client);
        await client.query('UPDATE products SET stock = $1 WHERE id = $2', [newStock, pid]);
      }
    } catch (e) {
      console.error('Failed to recompute product.stock after sale', e && (e.stack || e));
      // non-fatal: continue commit — product.stock can be recalculated later by endpoints
    }

    await client.query("COMMIT");

    // return clear numeric fields to client (subtotal = net, tax, total = shown-to-customer)
    res.json({
      success: true,
      message: "Order created",
      sale: {
        id: saleId,
        subtotal_amount: subtotalNet,
        tax_amount: taxAmount,
        total_amount: totalAmount,
        payment_mode: paymentMode
      }
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error('❌ submit-order error:', err && (err.stack || err));
    return res.status(500).json({ success: false, message: 'Order failed', error: String(err && err.message || err) });
  } finally {
    client.release();
  }
});

// compute product stock using unit-aware conversions (returns integer)
async function computeProductStock(productId, clientOrPool = pool) {
  const q = await clientOrPool.query(
    `SELECT
       pi.amount_needed,
       pi.amount_unit,
       i.stock AS ingredient_stock,
       i.unit AS ingredient_unit,
       i.piece_amount,
       i.piece_unit
     FROM product_ingredients pi
     JOIN ingredients i ON pi.ingredient_id = i.id
     WHERE pi.product_id = $1`,
    [productId]
  );

  const rows = q.rows || [];
  if (rows.length === 0) return 0;

  const counts = [];
  for (const r of rows) {
    const prodAmount = Number(r.amount_needed || 0);
    if (!Number.isFinite(prodAmount) || prodAmount <= 0) {
      counts.push(0);
      continue;
    }
    const prodUnit = r.amount_unit || r.ingredient_unit;
    const invAmt = Number(r.ingredient_stock ?? 0);
    const invUnit = r.ingredient_unit;

    const invInProdUnits = convertInventoryToProductUnits(invAmt, invUnit, prodUnit, {
      piece_amount: r.piece_amount,
      piece_unit: r.piece_unit,
    });

    if (!Number.isFinite(invInProdUnits)) {
      counts.push(0);
    } else {
      const availableCount = Math.floor(invInProdUnits / prodAmount);
      counts.push(Number.isFinite(availableCount) ? Math.max(0, availableCount) : 0);
    }
  }

  return counts.length > 0 ? Math.min(...counts) : 0;
}

// ---------------------- small unit conversion helpers (insert after dbQuery) ----------------------
function normUnit(u) {
  if (!u) return "";
  const s = String(u).toLowerCase().trim();
  if (["g", "gram", "grams"].includes(s)) return "g";
  if (["kg", "kilogram", "kilograms"].includes(s)) return "kg";
  if (["ml", "milliliter", "milliliters"].includes(s)) return "ml";
  if (["l", "liter", "liters"].includes(s)) return "l";
  if (["piece", "pieces", "pc", "pcs"].includes(s)) return "piece";
  if (["pack","packs"].includes(s)) return "pack";
  if (["unit", "units"].includes(s)) return "unit";
  return s;
}

function convertSimple(value, fromUnit, toUnit) {
  const f = normUnit(fromUnit);
  const t = normUnit(toUnit);
  if (!f || !t) return NaN;
  if (f === t) return Number(value);

  // mass
  if (f === "g" && t === "kg") return Number(value) / 1000;
  if (f === "kg" && t === "g") return Number(value) * 1000;
  // volume
  if (f === "ml" && t === "l") return Number(value) / 1000;
  if (f === "l" && t === "ml") return Number(value) * 1000;

  return NaN;
}

/**
 * Convert amount expressed in productUnit to inventoryUnit using ingredientRow.
 * Supports 'pack' by using ingredientRow.pieces_per_pack and piece_amount/piece_unit combos.
 */
function convertToInventoryUnits(amount, productUnit, inventoryUnit, ingredientRow = {}) {
  const prodU = normUnit(productUnit || inventoryUnit);
  const invU = normUnit(inventoryUnit);

  // try direct convert inventory -> product unit (mass/volume conversions)
  const direct = convertSimple(amount, prodU, invU);
  if (!Number.isNaN(direct)) return direct;

  const pieceAmount = ingredientRow && ingredientRow.piece_amount != null ? Number(ingredientRow.piece_amount) : null;
  const pieceUnit = ingredientRow && ingredientRow.piece_unit ? String(ingredientRow.piece_unit) : null;
  const piecesPerPack = ingredientRow && ingredientRow.pieces_per_pack != null ? Number(ingredientRow.pieces_per_pack) : null;

  // PRODUCT unit is 'pack'
  if (prodU === "pack") {
    //  pack -> piece (requires piecesPerPack)
    if (invU === "piece") {
      if (!piecesPerPack) return NaN;
      return Number(amount) * piecesPerPack;
    }
    // pack -> inventory mass/volume: require per-piece mass/volume (piece_amount + piece_unit)
    if ((invU === "g" || invU === "kg" || invU === "ml" || invU === "l") && pieceAmount && pieceUnit && piecesPerPack) {
      const perPieceInv = convertSimple(pieceAmount, pieceUnit, invU);
      if (Number.isNaN(perPieceInv)) return NaN;
      return Number(amount) * piecesPerPack * perPieceInv;
    }
  }

  // INVENTORY is 'pack' (rare) -> convert pack -> pieces or pack -> mass/volume
  if (invU === "pack") {
    if (prodU === "piece") {
      if (!piecesPerPack) return NaN;
      return Number(amount) / piecesPerPack;
    }
    if ((prodU === "g" || prodU === "kg" || prodU === "ml" || prodU === "l") && pieceAmount && pieceUnit && piecesPerPack) {
      // how much inventory in productUnit per pack
      const perPieceProdUnit = convertSimple(pieceAmount, pieceUnit, prodU);
      if (Number.isNaN(perPieceProdUnit)) return NaN;
      // inventoryAmount (packs) -> number of productUnits = packs * piecesPerPack * perPieceProdUnit
      return Number(amount) * piecesPerPack * perPieceProdUnit;
    }
  }

  // inventory stored as pieces and product expects mass/volume: each piece -> pieceAmount (pieceUnit) -> convert pieceUnit -> productUnit
  if (invU === "piece" && pieceAmount && pieceUnit) {
    const perPieceInProd = convertSimple(pieceAmount, pieceUnit, prodU);
    if (!Number.isNaN(perPieceInProd)) {
      return Number(amount) * perPieceInProd;
    }
  }

  // product unit is piece and inventory is mass/volume -> pieces * per-piece amount (converted)
  if (prodU === "piece" && pieceAmount && pieceUnit) {
    const perPieceInInv = convertSimple(pieceAmount, pieceUnit, invU);
    if (!Number.isNaN(perPieceInInv)) {
      return Number(amount) * perPieceInInv;
    }
  }

  // otherwise conversion not possible
  return NaN;
}

/**
 * Determine if a product-level unit can be converted to the ingredient inventory unit.
 * Extended to allow 'pack' conversions when pieces_per_pack present.
 */
function canConvert(productUnit, inventoryUnit, ingredientRow = {}) {
  const p = normUnit(productUnit || inventoryUnit);
  const i = normUnit(inventoryUnit);

  if (!p || !i) return false;
  if (p === i) return true;

  const massSet = new Set(["g", "kg"]);
  const volumeSet = new Set(["ml", "l"]);

  // mass <-> mass allowed
  if (massSet.has(p) && massSet.has(i)) return true;
  // volume <-> volume allowed
  if (volumeSet.has(p) && volumeSet.has(i)) return true;
  // piece <-> piece allowed
  if (p === "piece" && i === "piece") return true;
  // pack <-> piece allowed if pieces_per_pack present
  if ((p === "pack" && i === "piece") || (p === "piece" && i === "pack")) {
    const packSize = ingredientRow?.pieces_per_pack != null ? Number(ingredientRow.pieces_per_pack) : null;
    return !!packSize && Number.isFinite(packSize) && packSize > 0;
  }

  // piece <-> mass/volume only if ingredient defines piece_amount + piece_unit and that piece_unit can convert to the other unit
  if ((p === "piece" && (massSet.has(i) || volumeSet.has(i))) || (i === "piece" && (massSet.has(p) || volumeSet.has(p)))) {
    const pieceAmount = ingredientRow?.piece_amount != null ? Number(ingredientRow.piece_amount) : null;
    const pieceUnit = ingredientRow?.piece_unit || null;
    if (!pieceAmount || !pieceUnit) return false;

    // if inventory is piece and product is mass/volume: check piece_unit -> productUnit convertible (piece_unit -> p)
    if (i === "piece" && (massSet.has(p) || volumeSet.has(p))) {
      const conv = convertSimple(pieceAmount, pieceUnit, p);
      return !Number.isNaN(conv) && conv > 0;
    }
    // if product is piece and inventory is mass/volume: check piece_unit -> inventoryUnit convertible (piece_unit -> i)
    if (p === "piece" && (massSet.has(i) || volumeSet.has(i))) {
      const conv = convertSimple(pieceAmount, pieceUnit, i);
      return !Number.isNaN(conv) && conv > 0;
    }
  }

  // all other cross-dimension conversions disallowed
  return false;
}

// ---------------------- add helper: inventory -> product units ----------------------
function convertInventoryToProductUnits(inventoryAmount, inventoryUnit, productUnit, ingredientRow = {}) {
  // try direct convert inventory -> product unit
  const direct = convertSimple(inventoryAmount, inventoryUnit, productUnit);
  if (!Number.isNaN(direct)) return direct;

  const invU = normUnit(inventoryUnit);
  const prodU = normUnit(productUnit);

  const pieceAmount = ingredientRow && ingredientRow.piece_amount != null ? Number(ingredientRow.piece_amount) : null;
  const pieceUnit = ingredientRow && ingredientRow.piece_unit ? String(ingredientRow.piece_unit) : null;

  // inventory is pieces and product expects mass/volume: each piece -> pieceAmount (pieceUnit) -> convert pieceUnit -> productUnit
  if (invU === "piece" && pieceAmount && pieceUnit) {
    const perPieceInProd = convertSimple(pieceAmount, pieceUnit, productUnit);
    if (!Number.isNaN(perPieceInProd)) {
      return Number(inventoryAmount) * perPieceInProd;
    }
  }

  // inventory is mass/volume and product expects pieces: number of pieces available = inventoryAmount / (perPiece in inventoryUnit)
  if (prodU === "piece" && pieceAmount && pieceUnit) {
    const perPieceInInv = convertSimple(pieceAmount, pieceUnit, inventoryUnit);
    if (!Number.isNaN(perPieceInInv) && perPieceInInv > 0) {
      return Number(inventoryAmount) / perPieceInInv;
    }
  }

  // otherwise conversion not possible
  return NaN;
}
app.post("/add-product", async (req, res) => {
  const { name, category, price, sku, photo, color, ingredients } = req.body;

  if (!name || !category || price === undefined || price === null) {
    return res
      .status(400)
      .json({ success: false, message: "Missing required fields" });
  }

  // Normalize and generate SKU if missing
  const normalizedName = String(name).trim();
  const normalizedSku =
    sku && String(sku).trim().length > 0
      ? String(sku).trim()
      : `SKU-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

  // Validate ingredient amounts if provided
  if (Array.isArray(ingredients)) {
    for (const ing of ingredients) {
      const amt = Number(ing.amount);
      if (!Number.isFinite(amt) || amt <= 0) {
        return res.status(400).json({
          success: false,
          message: "Ingredient amounts must be positive numbers",
        });
      }
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Ensure unique product name (case-insensitive)
    const dupCheck = await client.query(
      "SELECT id FROM products WHERE LOWER(name) = LOWER($1) LIMIT 1",
      [normalizedName]
    );
    if (dupCheck.rows.length > 0) {
      await client.query("ROLLBACK");
      return res
        .status(409)
        .json({ success: false, message: "Product name already exists" });
    }

    // prepare photo value to store in DB:
    // if photo is data:uri -> decode and save file to uploads (store path), otherwise pass through
    let photoToStore = null;
    try {
      if (photo != null && String(photo).startsWith('data:')) {
        const m = String(photo).match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
        if (m) {
          const mime = m[1];
          const b64 = m[2];
          const ext = mime.split('/')[1] || 'jpg';
          const fn = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
          const outPath = path.join(uploadsDir, fn);
          fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
          photoToStore = `/uploads/${fn}`;
          console.log('Saved uploaded product image (create) ->', outPath);
        } else {
          console.warn('Invalid data URI received for product photo (create)');
          photoToStore = null;
        }
      } else if (photo != null && String(photo).length > 0) {
        photoToStore = String(photo);
      } else {
        photoToStore = null;
      }
    } catch (err) {
      console.error('Failed to save uploaded image on create:', err && (err.stack || err));
      await client.query("ROLLBACK");
      return res.status(500).json({ success: false, message: 'Failed to store uploaded image', error: String(err && err.message || err) });
    }

    // Insert product
    const productResult = await client.query(
      `INSERT INTO products (name, category, price, sku, photo, color, stock)
       VALUES ($1, $2, $3, $4, $5, $6, 0)
       RETURNING id`,
      [normalizedName, category, price, normalizedSku, photo ?? "", color ?? ""]
    );
    const productId = productResult.rows[0].id;
    // If we saved a file, update the row with the stored path
    if (photoToStore) {
      await client.query('UPDATE products SET photo = $1 WHERE id = $2', [photoToStore, productId]);
    }

    // Insert ingredients if any (store amount_unit if provided, else fallback to ingredient.unit via migration/backfill)
    if (Array.isArray(ingredients) && ingredients.length > 0) {
      for (const pi of ingredients) {
        const ingId = Number(pi.id);
        const amt = Number(pi.amount);
        const unit = String(pi.unit || "");
        const piecesPerPack = typeof pi.pack_size !== 'undefined' && pi.pack_size !== null ? Number(pi.pack_size) : null;

        // Insert into product_ingredients; include pieces_per_pack column you added via migration
        await pool.query(
          `INSERT INTO product_ingredients (product_id, ingredient_id, amount, unit, pieces_per_pack)
           VALUES ($1, $2, $3, $4, $5)`,
          [productId, ingId, amt, unit, piecesPerPack]
        );
      }
    }

    // --- NEW: compute and persist product.stock so UI shows correct available count ---
    try {
      const computedStock = await computeProductStock(productId, client);
      await client.query('UPDATE products SET stock = $1 WHERE id = $2', [computedStock, productId]);
    } catch (e) {
      // non-fatal: log but continue (stock will still be computed dynamically by endpoints)
      console.error('computeProductStock error for new product', productId, e && e.stack || e);
    }

    await client.query("COMMIT");
    // return product id AND persisted photo path when available
    return res.json({
      success: true,
      message:
        ingredients && ingredients.length > 0
          ? "Product and ingredients added successfully"
          : "Product added without ingredients",
      id: productId,
      sku: normalizedSku,
      product: { id: productId, name: normalizedName, photo: photoToStore }
    });
  } catch (err) {
    console.error("❌ Error adding product:", err.message);
    await client.query("ROLLBACK");
    return res.status(500).json({
      success: false,
      message: "Database error",
      error: err.message,
    });
  } finally {
    client.release();
  }
});


app.delete("/products/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      "DELETE FROM products WHERE id = $1",
      [id]
    );

    if (result.rowCount > 0) {
      return res.json({
        success: true,
        message: "Product deleted successfully",
      });
    } else {
      return res
        .status(404)
        .json({ success: false, message: "Product not found" });
    }
  } catch (err) {
    console.error("❌ Error deleting product:", err.message);
    return res
      .status(500)
      .json({ success: false, message: "Database error", error: err.message });
  }
});


app.get("/products/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      "SELECT id, name, category, price, sku, photo, is_active FROM products WHERE id = $1 LIMIT 1",
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    const row = result.rows[0];
    res.json({
      id: row.id,
      name: row.name,
      category: row.category,
      price: Number(row.price ?? 0),
      sku: row.sku,
      photo: row.photo || null,
      is_active: row.is_active,
    });
  } catch (err) {
    console.error("❌ Error fetching product details:", err.message);
    return res.status(500).json({ success: false, message: "Database error", error: err.message });
  }
});

// replace existing PUT /products/:id handler with this
app.put("/products/:id", async (req, res) => {
  const { id } = req.params;
  const { name, category, price, photo } = req.body; // accept optional photo

  // debug: log incoming sizes to help diagnose failures
  try {
    console.log(`PUT /products/${id} payload: name=${String(name)?.slice(0,80)}, category=${String(category)?.slice(0,80)}, price=${price}`);
    if (photo != null) {
      console.log(` -> photo present, type=${typeof photo}, approx length=${String(photo).length}`);
    } else {
      console.log(" -> no photo provided");
    }
  } catch (logErr) {
    console.warn("Failed printing debug info for PUT /products/:id", logErr);
  }

  if (!name || !category || price === undefined || price === null) {
    return res.status(400).json({ success: false, message: "Missing required fields" });
  }

  const normalizedName = String(name).trim();
  const numericPrice = Number(price);
  if (!Number.isFinite(numericPrice) || numericPrice < 0) {
    return res.status(400).json({ success: false, message: "Invalid price" });
  }

  // prepare photo value to store in DB:
  // - if photo is a data:uri -> decode and save file, store /uploads/<file>
  // - otherwise pass through (null or remote URL) so DB receives short value
  let photoToStore = null;
  try {
    if (photo != null && String(photo).startsWith('data:')) {
      const m = String(photo).match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (m) {
        const mime = m[1];
        const b64 = m[2];
        const ext = mime.split('/')[1] || 'jpg';
        const fn = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
        const outPath = path.join(uploadsDir, fn);
        fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
        // store a public URL path
        photoToStore = `/uploads/${fn}`;
        console.log('Saved uploaded product image ->', outPath);
      } else {
        console.warn('Invalid data URI received for product photo');
        photoToStore = null;
      }
    } else if (photo != null) {
      // accept string URL or short path
      photoToStore = String(photo);
    } else {
      photoToStore = null;
    }
  } catch (err) {
    console.error('Failed to save uploaded image:', err && (err.stack || err));
    // fail early rather than writing weird DB values
    return res.status(500).json({ success: false, message: 'Failed to store uploaded image', error: String(err && err.message || err) });
  }

  try {
    const sql = `
      UPDATE products
      SET name = $1,
          category = $2,
          price = $3,
          photo = COALESCE($4::text, photo)
      WHERE id = $5
      RETURNING id, name, category, price, sku, photo, is_active
    `;
    // debug: log SQL and params to help diagnose DB errors
    console.log("Executing UPDATE products SQL, params:", {
      sql: sql.replace(/\s+/g, " ").trim().slice(0, 200) + "...",
      paramsPreview: [String(normalizedName).slice(0, 60), String(category).slice(0, 60), numericPrice, String(photoToStore).slice(0,80), id],
    });
    const result = await pool.query(sql, [normalizedName, category, numericPrice, (photoToStore ?? null), id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    return res.json({ success: true, product: result.rows[0] });
  } catch (err) {
    console.error("❌ Error updating product:", err && (err.stack || err));
    return res.status(500).json({ success: false, message: "Database error", error: String(err && err.message || err) });
  }
});

// ✅ Get a product's ingredients and required amounts
app.get('/ingredients', async (req, res) => {
  const sql = `
    SELECT 
      i.id, i.name, i.stock, i.unit,
      i.pieces_per_pack,
      i.piece_amount,
      i.piece_unit,
      COALESCE((SELECT SUM(amount_used) FROM ingredient_usage WHERE ingredient_id = i.id), 0) AS total_deductions,
      COALESCE((SELECT SUM(amount) FROM ingredient_additions WHERE ingredient_id = i.id), 0) AS total_additions
    FROM ingredients i;
  `;
  try {
    const result = await pool.query(sql);
    res.json(result.rows);
  } catch (err) {
    console.error('DB Fetch Error:', err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

// ✅ Replace product ingredients and their amounts (idempotent set)
app.put("/products/:id/ingredients", async (req, res) => {
  const { id } = req.params;
  const { ingredients } = req.body; // [{ ingredientId, amount, unit }]

  if (!Array.isArray(ingredients)) {
    return res
      .status(400)
      .json({ success: false, message: "ingredients must be an array" });
  }

  for (const ing of ingredients) {
    const amt = Number(ing.amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({
        success: false,
        message: "Ingredient amounts must be positive numbers",
      });
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Validate all ingredient units against ingredient definitions
    if (ingredients.length > 0) {
      const ids = ingredients.map((x) => Number(x.ingredientId));
      const ingrRes = await client.query(
        `SELECT id, name, unit, piece_amount, piece_unit FROM ingredients WHERE id = ANY($1)`,
        [ids]
      );
      const byId = {};
      for (const r of ingrRes.rows) byId[r.id] = r;

      for (const ing of ingredients) {
        const row = byId[Number(ing.ingredientId)];
        if (!row) {
          await client.query("ROLLBACK");
          return res.status(400).json({ success: false, message: `Ingredient id ${ing.ingredientId} not found` });
        }
        const prodUnit = ing.unit ?? row.unit;
        const invUnit = row.unit;
        if (!canConvert(prodUnit, invUnit, { piece_amount: row.piece_amount, piece_unit: row.piece_unit })) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            success: false,
            message: `Incompatible unit for ingredient '${row.name}': product unit '${prodUnit}' cannot convert to inventory unit '${invUnit}'`
          });
        }
      }
    }

    // Delete old ingredients for this product
    await client.query("DELETE FROM product_ingredients WHERE product_id = $1", [
      id,
    ]);

    // Insert new ingredients if provided - include amount_unit (product-specific UOM)
    if (ingredients.length > 0) {
      const params = [];
      const values = [];
      ingredients.forEach((ing, idx) => {
        const base = idx * 4;
        params.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
        // product_id, ingredient_id, amount_needed, amount_unit
        values.push(id, ing.ingredientId, Number(ing.amount), ing.unit ?? null);
      });

      const sql = `
        INSERT INTO product_ingredients (product_id, ingredient_id, amount_needed, amount_unit)
        VALUES ${params.join(",")}
      `;

      await client.query(sql, values);
    }

    // --- NEW: recompute product stock for this product and persist ---
    try {
      const computedStock = await computeProductStock(id, client);
      await client.query('UPDATE products SET stock = $1 WHERE id = $2', [computedStock, id]);
    } catch (e) {
      console.error('computeProductStock error for product', id, e && e.stack || e);
    }

    await client.query("COMMIT");
    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(
      "❌ Error updating product ingredients:",
      err.message || err
    );
    res.status(500).json({ success: false, message: "Database error" });
  } finally {
    client.release();
  }
});

// CREATE Ingredient
app.post("/ingredients", async (req, res) => {
  const { name, stock, unit, pieces_per_pack, piece_amount, piece_unit } = req.body;

  try {
    // ✅ Case-insensitive check using ILIKE
    const check = await pool.query(
      "SELECT * FROM ingredients WHERE name ILIKE $1",
      [name]
    );

    if (check.rows.length > 0) {
      return res
        .status(400)
        .json({ success: false, message: "Ingredient already exists" });
    }

    // ✅ Insert new ingredient (pieces_per_pack optional)
    await pool.query(
      "INSERT INTO ingredients (name, stock, unit, pieces_per_pack, piece_amount, piece_unit) VALUES ($1, $2, $3, $4, $5, $6)",
      [name, stock, unit, pieces_per_pack ?? null, piece_amount ?? null, piece_unit ?? null]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Error inserting ingredient:", err.message || err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// ✅ Toggle product active/inactive (with message)
app.put("/products/:id/toggle", async (req, res) => {
  const { id } = req.params;
  const { is_active } = req.body;

  const sql = "UPDATE products SET is_active = $1 WHERE id = $2";

  try {
    const result = await pool.query(sql, [is_active, id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    res.json({ success: true, message: `Product ${is_active ? "activated" : "deactivated"}` });
  } catch (err) {
    console.error("❌ Toggle error:", err.message || err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// ✅ Toggle product active/inactive (simple response)
app.put("/products/:id/toggle-active", async (req, res) => {
  const { id } = req.params;
  const { is_active } = req.body;

  const sql = "UPDATE products SET is_active = $1 WHERE id = $2";

  try {
    const result = await pool.query(sql, [is_active, id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("❌ DB error:", err.message || err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// ✅ Admin: Get all products (active + inactive, with stock calculation)
app.get('/products-all-admin', async (req, res) => {
  try {
    const sql = `
      SELECT
        p.id,
        p.name,
        p.price,
        p.category,
        p.is_active,
        COALESCE(
          MIN(FLOOR(i.stock / NULLIF(pi.amount_needed,0))),
          COALESCE(p.stock,0)
        )::int AS stock
      FROM products p
      LEFT JOIN product_ingredients pi ON pi.product_id = p.id
      LEFT JOIN ingredients i ON pi.ingredient_id = i.id
      GROUP BY p.id, p.name, p.price, p.category, p.stock, p.is_active
      ORDER BY p.name;
    `;
    const result = await pool.query(sql);
    return res.json(result.rows || []);
  } catch (err) {
    console.error('❌ /products-all-admin error:', err.message || err);
    return res.status(500).json({ success: false, message: 'Database error' });
  }
});

// ✅ Public: Get only active products
app.get('/products-all', async (req, res) => {
  const sql = `
    SELECT p.id,
           p.name,
           p.category,
           p.price,
           p.sku,
           p.is_active,
           COALESCE(MIN(FLOOR(i.stock / pi.amount_needed)), 0) AS stock
    FROM products p
    LEFT JOIN product_ingredients pi ON p.id = pi.product_id
    LEFT JOIN ingredients i ON pi.ingredient_id = i.id
    WHERE p.is_active = TRUE
    GROUP BY p.id
  `;

  try {
    const result = await pool.query(sql);

    // ensure numbers
    const products = result.rows.map(r => ({
      ...r,
      price: r.price !== null ? Number(r.price) : 0,
      stock: r.stock !== null ? Number(r.stock) : 0,
    }));

    res.json(products);
  } catch (err) {
    console.error("❌ Error fetching all products:", err.message || err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});


app.get('/categories', async (req, res) => {
  const sql = 'SELECT id, name FROM categories ORDER BY name ASC';

  try {
    const result = await pool.query(sql);
    res.json({ success: true, items: result.rows || [] });
  } catch (err) {
    console.error('❌ Error fetching categories:', err.message || err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

// ✅ Create category
app.post('/categories', async (req, res) => {
  const { name } = req.body;
  const trimmed = String(name || '').trim();

  if (trimmed.length === 0) {
    return res.status(400).json({ success: false, message: 'Name is required' });
  }

  try {
    // Check duplicate (case-insensitive in Postgres)
    const dupCheck = await pool.query(
      'SELECT id FROM categories WHERE LOWER(name) = LOWER($1) LIMIT 1',
      [trimmed]
    );

    if (dupCheck.rows.length > 0) {
      return res.status(409).json({ success: false, message: 'Category already exists' });
    }

    // Insert new category
    const result = await pool.query(
      'INSERT INTO categories (name) VALUES ($1) RETURNING id',
      [trimmed]
    );

    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    console.error('❌ Category insert error:', err.message || err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

// ✅ Update category
app.put('/categories/:id', async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  const trimmed = String(name || '').trim();

  if (trimmed.length === 0) {
    return res.status(400).json({ success: false, message: 'Name is required' });
  }

  try {
    const result = await pool.query(
      'UPDATE categories SET name = $1 WHERE id = $2',
      [trimmed, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Category not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('❌ Category update error:', err.message || err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

// ✅ Delete category (block if referenced by products)
app.delete('/categories/:id', async (req, res) => {
  const { id } = req.params;

  try {
    // Check if category is used by products
    const refCheck = await pool.query(
      `SELECT COUNT(*) AS cnt 
       FROM products 
       WHERE category = (SELECT name FROM categories WHERE id = $1)`,
      [id]
    );

    if (refCheck.rows.length > 0 && Number(refCheck.rows[0].cnt) > 0) {
      return res.status(409).json({ success: false, message: 'Category is used by products' });
    }

    const result = await pool.query('DELETE FROM categories WHERE id = $1', [id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Category not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('❌ Category delete error:', err.message || err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});


app.get('/ingredients', async (req, res) => {
  const sql = `
    SELECT 
      i.id, i.name, i.stock, i.unit,
      COALESCE((SELECT SUM(amount_used) FROM ingredient_usage WHERE ingredient_id = i.id), 0) AS total_deductions,
      COALESCE((SELECT SUM(amount) FROM ingredient_additions WHERE ingredient_id = i.id), 0) AS total_additions
    FROM ingredients i;
  `;
  try {
    const result = await pool.query(sql);
    res.json(result.rows);
  } catch (err) {
    console.error('DB Fetch Error:', err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});


app.get('/ingredients/:id', async (req, res) => {
  const { id } = req.params;
  const sql = `
    SELECT 
      i.id, i.name, i.stock, i.unit,
      COALESCE((SELECT SUM(amount_used) FROM ingredient_usage WHERE ingredient_id = i.id), 0) AS total_deductions,
      COALESCE((SELECT SUM(amount) FROM ingredient_additions WHERE ingredient_id = i.id), 0) AS total_additions
    FROM ingredients i
    WHERE i.id = $1;
  `;
  try {
    const result = await pool.query(sql, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Ingredient not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('DB Fetch Error:', err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});


app.put('/ingredients/:id', async (req, res) => {
  const { id } = req.params;
  // accept optional pieces_per_pack (integer), piece_amount (number) and piece_unit (string)
  const { name, stock, unit, source, pieces_per_pack, piece_amount, piece_unit } = req.body;

  try {
    const getSql = 'SELECT stock FROM ingredients WHERE id = $1';
    const getResult = await pool.query(getSql, [id]);
    if (getResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Ingredient not found' });
    }
    const oldStock = getResult.rows[0].stock;
    const difference = stock - oldStock;

    // validate pieces_per_pack when unit is 'pack'
    if (String(unit).toLowerCase() === 'pack') {
      const p = pieces_per_pack == null ? null : Number(pieces_per_pack);
      if (!Number.isFinite(p) || p <= 0) {
        return res.status(400).json({ success: false, message: 'pieces_per_pack must be a positive integer when unit is pack' });
      }
    }

    const updateSql = `
      UPDATE ingredients
      SET name = $1,
          stock = $2,
          unit = $3,
          pieces_per_pack = $4,
          piece_amount = $5,
          piece_unit = $6
      WHERE id = $7
    `;
    await pool.query(updateSql, [
      name,
      stock,
      unit,
      pieces_per_pack ?? null,
      typeof piece_amount !== 'undefined' ? (piece_amount === null ? null : Number(piece_amount)) : null,
      piece_unit ?? null,
      id,
    ]);

    if (difference > 0) {
      // Log Restock
      const additionSql = `
        INSERT INTO ingredient_additions (ingredient_id, date, source, amount)
        VALUES ($1, NOW(), $2, $3)
      `;
      await pool.query(additionSql, [id, source || 'Manual Update', difference]);
    } else if (difference < 0) {
      // Log Manual Deduction into ingredient_usage
      const usageSql = `
        INSERT INTO ingredient_usage (sale_id, product_id, ingredient_id, amount_used, created_at)
        VALUES ($1, $2, $3, $4, NOW())
      `;
      await pool.query(usageSql, [null, null, id, Math.abs(difference)]);
    }

    res.json({ success: true, message: 'Ingredient updated successfully' });
  } catch (err) {
    console.error('❌ DB Update Error:', err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

app.delete('/ingredients/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM ingredients WHERE id = $1', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Ingredient not found' });
    }
    res.json({ success: true, message: 'Ingredient deleted successfully' });
  } catch (err) {
    console.error('❌ DB Delete Error:', err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});


app.put('/users/:id', async (req, res) => {
  const { id } = req.params;
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username and password are required' });
  }

  try {
    const sql = 'UPDATE users SET username = $1, password = $2 WHERE id = $3';
    const result = await pool.query(sql, [username, password, id]);
    if (result.rowCount > 0) {
      res.json({ success: true, message: 'User updated successfully' });
    } else {
      res.status(404).json({ success: false, message: 'User not found' });
    }
  } catch (err) {
    console.error('❌ Error updating user:', err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});


app.get('/users', async (req, res) => {
  try {
    const sql = 'SELECT id, username, role FROM users';
    const result = await pool.query(sql);
    res.json(result.rows || []);
  } catch (err) {
    console.error('❌ Error fetching users:', err);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

// Best sellers (subtract refunded quantities)
app.get('/best-sellers', async (req, res) => {
  try {
    const { month, year, category, lastMonth } = req.query;
    let target = new Date();
    if (String(lastMonth).toLowerCase() === 'true') target.setMonth(target.getMonth() - 1);
    const m = month ? Number(month) : (target.getMonth() + 1);
    const y = year ? Number(year) : target.getFullYear();

    let sql = `
      SELECT
        p.id,
        p.name,
        p.photo,
        SUM( GREATEST(si.quantity - COALESCE(ri.refunded_qty,0), 0) )::int AS total_sold
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      JOIN products p ON p.id = si.product_id
      LEFT JOIN (
        SELECT r.sale_id, ri.product_id, SUM(ri.quantity)::int AS refunded_qty
        FROM refund_items ri
        JOIN refunds r ON r.id = ri.refund_id
        GROUP BY r.sale_id, ri.product_id
      ) ri ON ri.sale_id = si.sale_id AND ri.product_id = si.product_id
      WHERE EXTRACT(YEAR FROM s.created_at) = $1 AND EXTRACT(MONTH FROM s.created_at) = $2
    `;
    const params = [y, m];

    if (category && String(category).trim()) {
      sql += ` AND p.category = $3`;
      params.push(String(category).trim());
    }

    sql += `
      GROUP BY p.id, p.name, p.photo
      ORDER BY total_sold DESC
      LIMIT 20
    `;

    const result = await pool.query(sql, params);
    const items = (result.rows || []).map(r => ({ id: r.id, name: r.name, total_sold: Number(r.total_sold||0), photo: r.photo || null }));
    return res.json({ month: m, year: y, items });
  } catch (err) {
    console.error('❌ best-sellers (override) error:', err && (err.stack || err));
    return res.status(500).json({ success: false, message: 'Failed to fetch best sellers' });
  }
});

// 📊 Sales report endpoint
app.get("/sales-report", async (req, res) => {
  const period = String(req.query.period || "day");

  try {
    // choose bucket expression (Manila time)
    let bucketExpr;
    if (period === "day") {
      bucketExpr = "to_char(timezone('Asia/Manila', s.created_at), 'YYYY-MM-DD')";
    } else if (period === "week") {
      bucketExpr = "to_char(timezone('Asia/Manila', date_trunc('week', s.created_at)), 'YYYY-MM-DD')";
    } else {
      bucketExpr = "to_char(timezone('Asia/Manila', s.created_at), 'YYYY-MM')";
    }

    // return rows for recent window (avoid empty results caused by strict same-day filters)
    const whereRecent = "WHERE timezone('Asia/Manila', s.created_at) >= (now() AT TIME ZONE 'Asia/Manila') - INTERVAL '90 days'";

    const sql = `
      SELECT
        ${bucketExpr} AS bucket,
        p.name AS product,
        SUM(si.quantity)::int AS total_sold
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.id
      JOIN products p ON si.product_id = p.id
      ${whereRecent}
      GROUP BY bucket, p.name
      ORDER BY bucket ASC, total_sold DESC
    `;

    const { rows } = await pool.query(sql);
    res.json(rows);
  } catch (err) {
    console.error('❌ /sales-report error:', err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

  app.get("/sales-report/category-summary", async (req, res) => {
  const { period } = req.query;

  // build time filter similar to /sales-report
  let whereTime = "WHERE 1=1";
  if (period === "day") {
    whereTime += " AND DATE(s.created_at) = CURRENT_DATE";
  } else if (period === "week") {
    whereTime += " AND DATE_TRUNC('week', s.created_at) = DATE_TRUNC('week', CURRENT_DATE)";
  } else if (period === "month") {
    whereTime += " AND DATE_TRUNC('month', s.created_at) = DATE_TRUNC('month', CURRENT_DATE)";
  }

  try {
    // per-product within category
    const sql = `
      SELECT
        COALESCE(p.category, 'Uncategorized') AS category,
        p.id AS product_id,
        p.name AS product,
        SUM(si.quantity)::int AS total_sold
      FROM sale_items si
      JOIN products p ON si.product_id = p.id
      JOIN sales s ON s.id = si.sale_id
      ${whereTime}
      GROUP BY p.category, p.id, p.name
      ORDER BY category ASC, total_sold DESC
    `;
    const { rows } = await pool.query(sql);
    // also produce per-category totals (optional)
    const catTotals = rows.reduce((acc, r) => {
      const cat = r.category || "Uncategorized";
      acc[cat] = (acc[cat] || 0) + Number(r.total_sold || 0);
      return acc;
    }, {});
    res.json({ items: rows, categoryTotals: catTotals });
  } catch (err) {
    console.error("❌ category-summary error:", err.message || err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// 📊 Ingredient usage summary report
app.get("/ingredient-usage-report", async (req, res) => {
  const sql = `
    SELECT i.name AS ingredient, i.unit, SUM(u.amount_used) AS total_used
    FROM ingredient_usage u
    JOIN ingredients i ON u.ingredient_id = i.id
    GROUP BY u.ingredient_id, i.name, i.unit
    ORDER BY total_used DESC;
  `;
  try {
    const result = await pool.query(sql);
    res.json(result.rows || []);
  } catch (err) {
    console.error("❌ Error fetching ingredient usage report:", err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});


app.get('/ingredients/:id/deductions', async (req, res) => {
  const { id } = req.params;
  const sql = `
    SELECT 
      u.created_at AS date,
      CASE 
        WHEN u.product_id IS NULL THEN 'Manual Deduction'
        ELSE COALESCE(p.name, 'Unknown Product')
      END AS product_name,
      u.amount_used AS amount
    FROM ingredient_usage u
    LEFT JOIN products p ON u.product_id = p.id
    WHERE u.ingredient_id = $1
    ORDER BY u.created_at DESC
  `;
  try {
    const result = await pool.query(sql, [id]);
    res.json(result.rows || []);
  } catch (err) {
    console.error("❌ Error fetching deductions:", err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

app.get('/ingredients/:id/additions', async (req, res) => {
  const { id } = req.params;
  const sql = `
    SELECT date, source, amount
    FROM ingredient_additions
    WHERE ingredient_id = $1
    ORDER BY date DESC
  `;
  try {
    const result = await pool.query(sql, [id]);
    res.json(result.rows || []);
  } catch (err) {
    console.error("❌ Error fetching additions:", err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

app.get('/best-sellers', async (req, res) => {
  try {
    const { month, year, lastMonth, category } = req.query;
    let target = new Date();
    if (String(lastMonth).toLowerCase() === 'true') {
      target.setMonth(target.getMonth() - 1);
    }
    const m = month ? Number(month) : (target.getMonth() + 1);
    const y = year ? Number(year) : target.getFullYear();

    // Sum sale_items minus already refunded quantities (refund_items)
    // refunded_qty is summed per sale + product, then subtracted from sold quantity
    let sql = `
      SELECT
        p.id,
        p.name,
        SUM( GREATEST(si.quantity - COALESCE(ri.refunded_qty,0), 0) )::int AS total_sold
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      JOIN products p ON p.id = si.product_id
      LEFT JOIN (
        SELECT r.sale_id, ri.product_id, SUM(ri.quantity)::int AS refunded_qty
        FROM refund_items ri
        JOIN refunds r ON r.id = ri.refund_id
        GROUP BY r.sale_id, ri.product_id
      ) ri ON ri.sale_id = si.sale_id AND ri.product_id = si.product_id
      WHERE EXTRACT(YEAR FROM s.created_at) = $1 AND EXTRACT(MONTH FROM s.created_at) = $2
    `;
    const params = [y, m];

    if (category && String(category).trim()) {
      sql += ` AND p.category = $3`;
      params.push(String(category).trim());
    }

    sql += `
      GROUP BY p.id, p.name
      ORDER BY total_sold DESC
      LIMIT 10
    `;

    const result = await pool.query(sql, params);
    return res.json({ month: m, year: y, items: result.rows });
  } catch (err) {
    console.error('❌ best-sellers error:', err && (err.message) || err);
    return res.status(500).json({ success: false, message: 'Failed to fetch best sellers' });
  }
});


app.get('/dashboard-summary', async (req, res) => {
  try {
    // Total sales amount today
    const salesResult = await pool.query(
      'SELECT COALESCE(SUM(total_amount), 0) AS total FROM sales WHERE DATE(created_at) = CURRENT_DATE'
    );
    const totalSalesToday = Number(salesResult.rows[0]?.total || 0);

    // Low stock products (computed stock <= 5)
    const lowResult = await pool.query(`
      SELECT COUNT(*) AS cnt FROM (
        SELECT p.id,
               COALESCE(MIN(FLOOR(i.stock / pi.amount_needed)), 0) AS stock
        FROM products p
        LEFT JOIN product_ingredients pi ON p.id = pi.product_id
        LEFT JOIN ingredients i ON pi.ingredient_id = i.id
        GROUP BY p.id
      ) t
      WHERE t.stock <= 5
    `);
    const lowStockCount = Number(lowResult.rows[0]?.cnt || 0);

    // Best seller today
    const bestResult = await pool.query(`
      SELECT p.id, p.name, SUM(si.quantity) AS total_sold
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      JOIN products p ON p.id = si.product_id
      WHERE DATE(s.created_at) = CURRENT_DATE
      GROUP BY p.id, p.name
      ORDER BY total_sold DESC
      LIMIT 1
    `);
    const bestSeller = bestResult.rows && bestResult.rows.length > 0 ? {
      id: bestResult.rows[0].id,
      name: bestResult.rows[0].name,
      total_sold: Number(bestResult.rows[0].total_sold || 0),
    } : null;

    return res.json({
      totalSalesToday,
      lowStockCount,
      bestSeller,
    });
  } catch (err) {
    console.error('❌ dashboard-summary error:', err && (err.message) || err);
    return res.status(500).json({ success: false, message: 'Failed to fetch dashboard summary' });
  }
});


app.get('/sales-trend', async (req, res) => {
  const { period, productId } = req.query;
  try {
    let where = '';
    let selectTime = '';
    let groupBy = '';
    let orderBy = '';
    const params = [];

    if (period === 'day') {
      where = 'WHERE DATE(s.created_at) = CURRENT_DATE';
      selectTime = 'EXTRACT(HOUR FROM s.created_at) AS bucket';
      groupBy = 'GROUP BY EXTRACT(HOUR FROM s.created_at)';
      orderBy = 'ORDER BY EXTRACT(HOUR FROM s.created_at) ASC';
    } else if (period === 'week') {
      where = "WHERE s.created_at >= CURRENT_DATE - INTERVAL '6 days'";
      selectTime = 'DATE(s.created_at) AS bucket';
      groupBy = 'GROUP BY DATE(s.created_at)';
      orderBy = 'ORDER BY DATE(s.created_at) ASC';
    } else {
      where = "WHERE s.created_at >= CURRENT_DATE - INTERVAL '29 days'";
      selectTime = 'DATE(s.created_at) AS bucket';
      groupBy = 'GROUP BY DATE(s.created_at)';
      orderBy = 'ORDER BY DATE(s.created_at) ASC';
    }

    let productFilter = '';
    if (productId) {
      productFilter = ` AND si.product_id = $1`;
      params.push(Number(productId));
    }

    const sql = `
      SELECT ${selectTime}, SUM(si.quantity) AS total
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.id
      ${where}${productFilter}
      ${groupBy}
      ${orderBy}
    `;

    const result = await pool.query(sql, params);

    const rows = result.rows;
    const labels = rows.map(r => {
      if (period === 'day') {
        const h = String(r.bucket).padStart(2, '0');
        return `${h}:00`;
      }
      const d = new Date(r.bucket);
      return `${d.getMonth() + 1}/${d.getDate()}`;
    });
    const values = rows.map(r => Number(r.total) || 0);

    return res.json({ labels, values });
  } catch (err) {
    console.error('❌ sales-trend error:', err && (err.message) || err);
    return res.status(500).json({ success: false, message: 'Trend fetch failed' });
  }
});


app.post("/refund-sale", async (req, res) => {
  const { saleId, items = [], amount = 0, reason = "", restock = true } = req.body || {};
  if (!saleId) return res.status(400).json({ success: false, message: "saleId required" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ensure sale exists
    const saleCheck = await client.query("SELECT id FROM sales WHERE id = $1 LIMIT 1", [saleId]);
    if (saleCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Sale not found" });
    }

    // if items not provided, build from sale_items (full-sale refund)
    let itemsToRefund = Array.isArray(items) && items.length ? items.map(i => ({ productId: Number(i.productId || i.id), quantity: Number(i.quantity || i.qty || 0) })) : [];
    if (itemsToRefund.length === 0) {
      const saleItemsRes = await client.query("SELECT product_id, quantity FROM sale_items WHERE sale_id = $1", [saleId]);
      itemsToRefund = saleItemsRes.rows.map(r => ({ productId: Number(r.product_id), quantity: Number(r.quantity) }));
    }

    // validate requested refund quantities against sold minus already refunded
    for (const it of itemsToRefund) {
      if (!it.productId || it.quantity <= 0) continue;
      const soldRes = await client.query(
        "SELECT SUM(quantity) AS sold FROM sale_items WHERE sale_id = $1 AND product_id = $2",
        [saleId, it.productId]
      );
      const sold = Number(soldRes.rows[0]?.sold ?? 0);

      const refundedRes = await client.query(
        `SELECT COALESCE(SUM(ri.quantity),0) AS refunded
         FROM refund_items ri
         JOIN refunds r ON r.id = ri.refund_id
         WHERE r.sale_id = $1 AND ri.product_id = $2`,
        [saleId, it.productId]
      );
      const alreadyRefunded = Number(refundedRes.rows[0]?.refunded ?? 0);

      const available = sold - alreadyRefunded;
           if ( it.quantity > available) {

        await client.query("ROLLBACK");
        return res.status(400).json({
          success: false,
          message: `Refund quantity for product ${it.productId} exceeds available (${available})`,
        });
      }
    }

    // insert refund record
    const refundRes = await client.query(
      "INSERT INTO refunds (sale_id, amount, reason) VALUES ($1, $2, $3) RETURNING id, created_at",
      [saleId, amount, reason]
    );
    const refundId = refundRes.rows[0].id;

    // insert refund_items and optionally restore ingredient stock per product
    for (const it of itemsToRefund) {
      if (!it.productId || it.quantity <= 0) continue;
      await client.query(
        "INSERT INTO refund_items (refund_id, product_id, quantity) VALUES ($1, $2, $3)",
        [refundId, it.productId, it.quantity]
      );

      // restore ingredient stock only when restock is truthy
      if (restock) {
        const ingrRes = await client.query(
          `SELECT pi.ingredient_id, pi.amount_needed, pi.amount_unit, i.unit AS ingredient_unit, i.piece_amount, i.piece_unit
           FROM product_ingredients pi
           JOIN ingredients i ON pi.ingredient_id = i.id
           WHERE pi.product_id = $1`,
          [it.productId]
        );

        for (const row of ingrRes.rows) {
          const prodAmount = Number(row.amount_needed);
          const prodUnit = row.amount_unit || row.ingredient_unit;
          const invUnit = row.ingredient_unit;

          const perItemInventory = convertToInventoryUnits(prodAmount, prodUnit, invUnit, {
            piece_amount: row.piece_amount,
            piece_unit: row.piece_unit,
          });

          const restore = Number.isFinite(perItemInventory) ? perItemInventory * it.quantity : prodAmount * it.quantity;
          if (restore > 0) {
            await client.query(
              "UPDATE ingredients SET stock = stock + $1::numeric WHERE id = $2",
              [restore, row.ingredient_id]
            );
          }
        }
      }
    }

    await client.query("COMMIT");
    return res.json({ success: true, refundId, restocked: !!restock });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error('❌ /refund-sale error:', err && (err.stack || err));
    return res.status(500).json({ success: false, message: "Refund failed", error: String(err && err.message || err) });
  } finally {
    client.release();
  }
});

// helper: accept admin key from header or body
function adminKeyFromReq(req) {
  const bodyKey = (req.body && req.body.adminKey) ? String(req.body.adminKey) : null;
  const headerKey = req.headers['x-admin-key'] ? String(req.headers['x-admin-key']) : null;
  return headerKey || bodyKey || null;
}

// unified force-logout handler (used by two routes)
async function handleAdminForceLogout(req, res) {
  try {
    const userId = Number(req.body?.userId ?? req.body?.id ?? req.query?.userId);
    const providedKey = adminKeyFromReq(req);
    if (!process.env.ADMIN_KEY) return res.status(500).json({ success: false, message: "ADMIN_KEY not configured" });
    if (String(providedKey || "") !== String(process.env.ADMIN_KEY)) return res.status(401).json({ success: false, message: "Forbidden" });
    if (!userId) return res.status(400).json({ success: false, message: "userId required" });

    await clearSessionForUser(userId);
    try { adminNotifier.emit(`force-logout:${userId}`, { userId }); } catch (e) {}
    console.log(`ADMIN_FORCE_LOGOUT: cleared session for user ${userId} via admin key/header`);
    return res.json({ success: true, message: "Session cleared" });
  } catch (err) {
    console.error("/admin/force-logout error:", err && (err.stack || err));
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

// replace existing single route with two endpoints that share the handler
app.post("/admin/force-logout", handleAdminForceLogout);
app.post("/superadmin/force-logout", handleAdminForceLogout);

// --- DISABLE OTP: do not initialize providers (safe) ---
let twilioClient = null;
let mailer = null;
console.log('OTP functionality disabled: twilio and smtp not initialized.')

// --- DISABLE OTP ROUTES ---
// reply immediately that OTP is disabled instead of trying to send
app.post('/admin/send-test-otp', (req, res) => {
  return res.status(410).json({
    ok: false,
    error: 'otp_disabled',
    message: 'OTP functionality has been disabled by admin. Use admin credentials/pin flows instead.'
  });
});

// If you had other OTP endpoints, disable them too (example)
app.post('/auth/request-otp', (req, res) => {
  return res.status(410).json({
    ok: false,
    error: 'otp_disabled',
    message: 'OTP functionality has been disabled by admin.'
  });
});

app.post("/set-pin", async (req, res) => {
  try {
    const { username, pin } = req.body || {};
    if (!username || !pin) return res.status(400).json({ success: false, message: "username and pin required" });
    if (!/^\d{4,6}$/.test(String(pin))) return res.status(400).json({ success: false, message: "PIN must be 4-6 digits" });
    const result = await pool.query("UPDATE users SET pin = $1 WHERE username = $2 RETURNING id, username", [String(pin), String(username)]);
    if (!result.rows || result.rows.length === 0) return res.status(404).json({ success: false, message: "User not found" });
    return res.json({ success: true, message: "PIN set" });
  } catch (err) {
    console.error("/set-pin error:", err && (err.stack || err));
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

app.get("/purchase-orders", async (req, res) => {
  try {
    const sql = `
      SELECT id, supplier_id, status, COALESCE(total,0)::numeric AS total, created_at
      FROM purchase_orders
      ORDER BY created_at DESC
    `;
    const result = await pool.query(sql);
    return res.json(Array.isArray(result.rows) ? result.rows : []);
  } catch (err) {
    console.error("❌ /purchase-orders error:", err && (err.stack || err));
    return res.status(500).json({ success: false, message: "Failed to fetch purchase orders" });
  }
});

// Purchase order detail (with items)
app.get("/purchase-orders/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const poRes = await pool.query("SELECT id, supplier_id, status, COALESCE(total,0)::numeric AS total, created_at FROM purchase_orders WHERE id = $1 LIMIT 1", [id]);
    if (!poRes.rows || poRes.rows.length === 0) return res.status(404).json({ success: false, message: "Purchase order not found" });

    const itemsRes = await pool.query(
      `SELECT id, ingredient_id, qty, unit, unit_cost
       FROM purchase_order_items
       WHERE po_id = $1
       ORDER BY id ASC`,
      [id]
    );

    const po = poRes.rows[0];
    po.items = itemsRes.rows || [];
    return res.json(po);
  } catch (err) {
    console.error("❌ /purchase-orders/:id error:", err && (err.stack || err));
    return res.status(500).json({ success: false, message: "Failed to fetch purchase order detail" });
  }
});

app.post('/purchase-orders/:id/receive-with-admin', async (req, res) => {
  const { id } = req.params;
  const { admin_password, admin_pin } = req.body || {};
  try {
    const admin = await authenticateAdmin({ admin_password, admin_pin });
    if (!admin) return res.status(401).json({ success: false, message: 'Unauthorized: admin password and PIN required and must match the same admin' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const poRes = await client.query('SELECT id, status FROM purchase_orders WHERE id = $1 FOR UPDATE', [id]);
      if (poRes.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'Purchase order not found' }); }
      if (poRes.rows[0].status === 'received') { await client.query('ROLLBACK'); return res.status(400).json({ success: false, message: 'Purchase order already received' }); }

      const itemsRes = await client.query('SELECT * FROM purchase_order_items WHERE po_id = $1', [id]);
      for (const it of (itemsRes.rows || [])) {
        const qty = Number(it.qty || 0);
        if (qty === 0) continue;
        await client.query('UPDATE ingredients SET stock = COALESCE(stock,0) + $1 WHERE id = $2', [qty, it.ingredient_id]);
        await client.query(`INSERT INTO ingredient_additions (ingredient_id, amount, date, source) VALUES ($1, $2, NOW(), $3)`, [it.ingredient_id, qty, `PO:${id}`]);
      }

      await client.query('UPDATE purchase_orders SET status = $1 WHERE id = $2', ['received', id]);
      await client.query('COMMIT');
      return res.json({ success: true, message: 'PO received', id, processedBy: admin.username });
    } catch (err) {
      await client.query('ROLLBACK').catch(()=>{});
      console.error('receive-with-admin error', err && (err.stack || err));
      return res.status(500).json({ success: false, message: 'Server error', error: String(err?.message || err) });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('/purchase-orders/:id/receive-with-admin error:', err && (err.stack || err));
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});


app.post("/login-pin", async (req, res) => {
  try {
    const { pin, password } = req.body || {};
    if (!pin) return res.status(400).json({ success: false, message: "PIN required" });

    const key = loginKeyFromReq(req);
    const lock = isLocked(key);
    if (lock.locked) {
      const secs = Math.ceil(lock.remainingMs / 1000);
      return res.status(429).json({ success: false, message: `Too many attempts. Try again in ${secs} seconds`});
    }

    try {
      const q = await pool.query("SELECT id, username, role, password FROM users WHERE COALESCE(pin,'') = $1 LIMIT 1", [String(pin)]);
      if (!q.rows || q.rows.length === 0) {
        recordFailedAttempt(key);
        return res.status(401).json({ success: false, message: "Invalid PIN" });
      }

      const user = q.rows[0];
      const role = String(user.role || "").toLowerCase();

      // require password for admin / superadmin PINs
      if (role === "admin" || role === "superadmin") {
        if (!password) {
          return res.status(401).json({ success: false, message: "Password required for admin PIN" });
        }
        const stored = String(user.password || "");
        let ok = false;
        try {
          if (stored.startsWith("$2")) ok = bcrypt.compareSync(String(password), stored);
          else ok = String(password) === stored;
        } catch (e) { ok = false; }
        if (!ok) {
          recordFailedAttempt(key);
          return res.status(401).json({ success: false, message: "Invalid credentials" });
        }
        // ok -> fallthrough to session creation
      }

      // success for admin or non-admin: reset attempts and create/update a session (persist active_session_device)
      resetAttempts(key);

      const deviceId = req.body && req.body.device_id ? String(req.body.device_id) : null;
      const session = await createOrUpdateSession(user.id, deviceId);

      // respond with user + session info so client can persist token and device
      return res.json({
        success: true,
        id: user.id,
        username: user.username,
        role: user.role,
        sessionToken: session.token,
        sessionExpires: session.expires,
        active_session_device: deviceId ?? null
      });
    } catch (err) {
      console.error("/login-pin error:", err && (err.stack || err));
      return res.status(500).json({ success: false, message: "Server error" });
    }
  } catch (err) {
    console.error('/login-pin error:', err && (err.stack || err));
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// --- SINGLE-ADMIN-SESSION HELPERS ---
const SESSION_TTL_MINUTES = Number(process.env.ADMIN_SESSION_TTL_MINUTES || 15);

async function getActiveSessionForUser(userId) {
  const r = await pool.query(
    "SELECT active_session_token, active_session_device, active_session_expires FROM users WHERE id = $1 LIMIT 1",
    [userId]
  );
  return r.rows && r.rows[0] ? r.rows[0] : null;
}

async function createOrUpdateSession(userId, deviceId) {
  const token = crypto.randomBytes(24).toString("hex");
  const expires = new Date(Date.now() + SESSION_TTL_MINUTES * 60_000).toISOString();
  await pool.query(
    `UPDATE users SET active_session_token = $1, active_session_device = $2, active_session_expires = $3 WHERE id = $4`,
    [token, deviceId ?? null, expires, userId]
  );
  return { token, expires };
}

async function clearSessionForUser(userId) {
  await pool.query(
    `UPDATE users SET active_session_token = NULL, active_session_device = NULL, active_session_expires = NULL WHERE id = $1`,
    [userId]
  );
}

// --- Add: admin session verification middleware + optional notifier ---
const EventEmitter = require('events');
const adminNotifier = new EventEmitter();
// keep weak map of in-memory listeners if you have WebSocket/SSE connections:
// const adminWsClients = new Map(); // key: userId -> Set(ws)

async function verifyAdminSession(req, res, next) {
  try {
    // accept token/userId from header first (safer for single-page/app usage), then body/query
    const token = (req.headers['x-admin-token'] || req.body?.token || req.query?.token) ? String(req.headers['x-admin-token'] || req.body?.token || req.query?.token) : null;
    const userIdRaw = req.headers['x-user-id'] || req.body?.userId || req.query?.userId;
    const userId = Number(userIdRaw);
    if (!userId || !token) return res.status(401).json({ success: false, message: 'userId and token required' });

    const sess = await getActiveSessionForUser(userId);
    if (!sess || !sess.active_session_token || sess.active_session_token !== token) {
      return res.status(401).json({ success: false, message: 'Invalid session' });
    }
    if (sess.active_session_expires && new Date(sess.active_session_expires) <= new Date()) {
      return res.status(401).json({ success: false, message: 'Session expired' });
    }

    // attach session info for handlers
    req.adminSession = { userId, token, expires: sess.active_session_expires };
    return next();
  } catch (err) {
    console.error('verifyAdminSession error:', err && (err.stack || err));
    return res.status(500).json({ success: false, message: 'Server error' });
  }
}

// Insert verifySuperAdmin here
function verifySuperAdmin(req, res, next) {
  try {
    // Prefer header credentials so client can send the target username in the body
    // (some client requests include a `username` for the target user).
    const name = req.headers['x-super-username'] || req.body?.username;
    const key = req.headers['x-admin-key'] || req.body?.adminKey;
    if (String(name) !== 'superadmin') return res.status(401).json({ success: false, message: 'Forbidden' });
    if (!process.env.ADMIN_KEY) return res.status(500).json({ success: false, message: 'ADMIN_KEY not configured' });
    if (String(key) !== String(process.env.ADMIN_KEY)) return res.status(401).json({ success: false, message: 'Forbidden' });
    return next();
  } catch (err) {
    console.error('verifySuperAdmin error:', err && (err.stack || err));
    return res.status(500).json({ success: false, message: 'Server error' });
  }
}

// optional simple request logger to diagnose 404s
app.use((req, _res, next) => {
  console.log(`REQ ${req.method} ${req.path}`);
  next();
});

// authenticateAdmin helper (checks admin password AND PIN must match same user)
async function authenticateAdmin({ admin_password, admin_pin } = {}) {
  try {
    if (!admin_password || !admin_pin) return null; // require both

    const q = await pool.query(
      "SELECT id, username, password, COALESCE(pin,'') AS pin, role FROM users WHERE role IN ('admin','superadmin')"
    );
    if (!q.rows || q.rows.length === 0) return null;

    for (const u of q.rows) {
      // require both pin AND password for same user
      if (String(u.pin || "") === String(admin_pin)) {
        // verify password (bcrypt or plain)
        if (typeof u.password === "string") {
          try {
            if (u.password.startsWith("$2")) {
              if (bcrypt.compareSync(admin_password, u.password)) return { id: u.id, username: u.username, role: u.role };
            } else {
              if (admin_password === u.password) return { id: u.id, username: u.username, role: u.role };
            }
          } catch (e) {
            // continue
          }
        }
      }
    }
    return null;
  } catch (err) {
    console.error('authenticateAdmin error:', err && (err.stack || err));
    return null;
  }
}

app.get('/products-split-stock', async (req, res) => {
  try {
    // load active products
    const prodRes = await pool.query(`SELECT id, name, price, category, sku, photo, color, is_active FROM products WHERE (is_active = true OR is_active IS NULL)`);
    const products = prodRes.rows || [];

    // precompute how many products reference each ingredient
    const countsRes = await pool.query(`SELECT ingredient_id, COUNT(DISTINCT product_id) AS cnt FROM product_ingredients GROUP BY ingredient_id`);
    const usingCount = {};
    for (const r of countsRes.rows) usingCount[r.ingredient_id] = Number(r.cnt || 1);

    const out = [];
    for (const p of products) {
      const ingrRes = await pool.query(`
        SELECT pi.ingredient_id, pi.amount_needed, pi.amount_unit,
               i.unit AS ingredient_unit, i.stock AS ingredient_stock, i.piece_amount, i.piece_unit
        FROM product_ingredients pi
        JOIN ingredients i ON pi.ingredient_id = i.id
        WHERE pi.product_id = $1
      `, [p.id]);

      const counts = [];
      for (const r of (ingrRes.rows || [])) {
        const prodAmount = Number(r.amount_needed || 0);
        if (!Number.isFinite(prodAmount) || prodAmount <= 0) { counts.push(0); continue; }

        // divide ingredient stock equally among all products that use it
        const totalInv = Number(r.ingredient_stock ?? 0);
        const allocatedInv = totalInv / (usingCount[r.ingredient_id] || 1);

        const invInProdUnits = convertInventoryToProductUnits(allocatedInv, r.ingredient_unit, (r.amount_unit || r.ingredient_unit), {
          piece_amount: r.piece_amount,
          piece_unit: r.piece_unit,
        });

        if (!Number.isFinite(invInProdUnits)) counts.push(0);
        else counts.push(Math.max(0, Math.floor(invInProdUnits / prodAmount)));
      }

      const available = counts.length > 0 ? Math.min(...counts) : 0;
      out.push({
        id: p.id, name: p.name, price: p.price !== null ? Number(p.price) : 0,
        category: p.category, sku: p.sku, photo: p.photo, color: p.color,
        is_active: p.is_active, stock: available
      });
    }

    return res.json(out);
  } catch (err) {
    console.error('❌ /products-split-stock error:', err && (err.message || err));
    return res.status(500).json({ success: false, message: 'Failed to compute split stock' });
  }
});

app.post('/admin/logout', verifyAdminSession, async (req, res) => {
  try {
    const uid = req.adminSession.userId;
    await clearSessionForUser(uid);
    try { adminNotifier.emit(`force-logout:${uid}`, { userId: uid }); } catch (e) {}
    return res.json({ success: true });
  } catch (err) {
    console.error('/admin/logout error:', err && (err.stack || err));
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/admin/session-keepalive', verifyAdminSession, async (req, res) => {
  try {
    const uid = req.adminSession.userId;
    const newExpires = new Date(Date.now() + SESSION_TTL_MINUTES * 60_000).toISOString();
    await pool.query('UPDATE users SET active_session_expires = $1 WHERE id = $2', [newExpires, uid]);
    return res.json({ success: true, expires: newExpires });
  } catch (err) {
    console.error('/admin/session-keepalive error:', err && (err.stack || err));
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/sse/admin', (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).end('userId required');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  res.write('\n');

  const evName = `force-logout:${userId}`;
  const listener = (payload) => {
    try {
      res.write(`event: force-logout\n`);
      res.write(`data: ${JSON.stringify(payload ?? {})}\n\n`);
    } catch (e) {
      // ignore write errors
    }
  };

  adminNotifier.on(evName, listener);

  // heartbeat to keep connection alive through proxies
  const hb = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (e) {}
  }, 25_000);

  req.on('close', () => {
    clearInterval(hb);
    adminNotifier.removeListener(evName, listener);
  });
});

// Get product ingredients (used by AdminProductScreen)
app.get('/products/:id/ingredients', async (req, res) => {
  const { id } = req.params;
  try {
    const sql = `
      SELECT
        pi.ingredient_id AS id,
        i.name AS name,
        pi.amount_needed AS amount,
        COALESCE(pi.amount_unit, i.unit) AS unit,
        pi.pieces_per_pack
      FROM product_ingredients pi
      JOIN ingredients i ON pi.ingredient_id = i.id
      WHERE pi.product_id = $1
      ORDER BY pi.id
    `;
    const result = await pool.query(sql, [id]);
    return res.json({ items: result.rows || [] });
  } catch (err) {
    console.error('/products/:id/ingredients error:', err && (err.stack || err));
    return res.status(500).json({ success: false, message: 'Failed to fetch product ingredients' });
  }
});

app.post("/admin/force-logout", handleAdminForceLogout);
app.post("/superadmin/force-logout", handleAdminForceLogout);

app.post('/superadmin/create', verifySuperAdmin, async (req, res) => {
  try {
    const { username, password, pin = null, role = 'admin' } = req.body || {};
    if (!username || !password) return res.status(400).json({ success: false, message: 'username and password required' });
    const hash = bcrypt.hashSync(String(password), 10);
    const r = await pool.query(
      'INSERT INTO users (username, password, role, pin) VALUES ($1, $2, $3, $4) RETURNING id',
      [username, hash, role, pin]
    );
    return res.json({ success: true, id: r.rows[0].id });
  } catch (err) {
    console.error('/superadmin/create error:', err && (err.stack || err));
    return res.status(500).json({ success: false, message: 'DB error' });
  }
});

// delete user by id (superadmin credential required)
app.post('/superadmin/delete', verifySuperAdmin, async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ success: false, message: 'userId required' });
    await pool.query('DELETE FROM users WHERE id = $1', [Number(userId)]);
    return res.json({ success: true });
  } catch (err) {
    console.error('/superadmin/delete error:', err && (err.stack || err));
    return res.status(500).json({ success: false, message: 'DB error' });
  }
});

// update user (password and/or pin) (superadmin credential required)
app.post('/superadmin/update', verifySuperAdmin, async (req, res) => {
  try {
    const { userId, password, pin } = req.body || {};
    if (!userId) return res.status(400).json({ success: false, message: 'userId required' });

    const updates = [];
    const params = [];
    let idx = 1;
    if (password) {
      updates.push(`password = $${idx++}`);
      params.push(bcrypt.hashSync(String(password), 10));
    }
    if (typeof pin !== 'undefined') {
      updates.push(`pin = $${idx++}`);
      params.push(pin);
    }
    if (updates.length === 0) return res.status(400).json({ success: false, message: 'nothing to update' });

    params.push(Number(userId));
    const sql = `UPDATE users SET ${updates.join(', ')} WHERE id = $${idx}`;
    await pool.query(sql, params);
    return res.json({ success: true });
  } catch (err) {
    console.error('/superadmin/update error:', err && (err.stack || err));
    return res.status(500).json({ success: false, message: 'DB error' });
  }
});

app.post('/superadmin/auth', verifySuperAdmin, async (req, res) => {
  try {
    return res.json({ success: true });
  } catch (err) {
    console.error('/superadmin/auth error:', err && (err.stack || err));
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/superadmin/list', verifySuperAdmin, async (req, res) => {
  try {
    // include active session device + expires so the admin UI can show which device (if any) holds the session
    const r = await pool.query(
      `SELECT id, username, role, pin, active_session_device, active_session_expires, created_at
       FROM users
       ORDER BY id DESC`
    );
    return res.json({ success: true, items: r.rows });
  } catch (err) {
    console.error('/superadmin/list error:', err && (err.stack || err));
    return res.status(500).json({ success: false, message: 'DB error' });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server listening on http://0.0.0.0:${PORT}`);
  console.log('Provider availability:', {
    twilio: !!twilioClient,
    smtp: !!(process.env.SMTP_USER && process.env.SMTP_PASS && process.env.SMTP_HOST),
    admin_key: !!process.env.ADMIN_KEY
  });
});
