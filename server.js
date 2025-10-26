require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { Pool } = require("pg");
const crypto = require('crypto');

const app = express();
app.use(cors({
  origin: "*", 
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json());

// Health check
app.get('/health', (_req, res) => res.json({ ok: true }));


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
  if (!username || !password) return res.status(400).json({ success: false, message: "Missing credentials" });

  console.log("DEBUG /login env:", {
  DATABASE_URL: process.env.DATABASE_URL,
  DB_USER: process.env.DB_USER,
  PGUSER: process.env.PGUSER,
  USER: process.env.USER
});


  try {
    const result = await pool.query(
      "SELECT id, username, password, role FROM users WHERE username = $1 LIMIT 1",
      [username]
    );
    if (!result.rows || result.rows.length === 0) return res.json({ success: false, message: "Invalid credentials" });

    const user = result.rows[0];
    const stored = String(user.password || "");

    let ok = false;
    if (stored.startsWith("$2")) {
      ok = bcrypt.compareSync(password, stored);
    } else {
      ok = password === stored;
    }

    if (!ok) return res.json({ success: false, message: "Invalid credentials" });

    return res.json({ success: true, id: user.id, username: user.username, role: user.role });
  } catch (err) {
    console.error("❌ Login query error:", err);
    return res.status(500).json({ success: false, message: "Database error", error: err.message, detail: err.stack?.split("\n")[0] });
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

    // compute subtotal (client may send inclusive price total or net)
    // `subtotal` variable should be the number passed from client (the visible/entered amount)
    let subtotalNet = Number(clientSubtotal || 0);
    let taxAmount = 0;
    let totalAmount = 0;

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

    // begin transaction and persist sale + items and record ingredient usage
    await client.query("BEGIN");
    const saleInsertSql = `
      INSERT INTO sales (subtotal_amount, tax, total_amount, payment_mode, created_at)
      VALUES ($1, $2, $3, $4, NOW())
      RETURNING id
    `;
    const saleRes = await client.query(saleInsertSql, [subtotalNet, taxAmount, totalAmount, paymentMode]);
    const saleId = saleRes.rows[0].id;

    // insert sale_items and record usages per normalized item (ensures numeric fields)
    for (const it of normalizedItems) {
      const unitPrice = Number(it.unit_price ?? 0);
      await client.query(
        "INSERT INTO sale_items (product_id, quantity, unit_price, sale_id) VALUES ($1, $2, $3, $4)",
        [it.id, it.quantity, unitPrice, saleId]
      );

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

// ---------------------- small unit conversion helpers (insert after dbQuery) ----------------------
function normUnit(u) {
  if (!u) return "";
  const s = String(u).toLowerCase().trim();
  if (["g", "gram", "grams"].includes(s)) return "g";
  if (["kg", "kilogram", "kilograms"].includes(s)) return "kg";
  if (["ml", "milliliter", "milliliters"].includes(s)) return "ml";
  if (["l", "liter", "liters"].includes(s)) return "l";
  if (["piece", "pieces", "pc", "pcs"].includes(s)) return "piece";
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
 * Convert amount expressed in productUnit to inventoryUnit using ingredientRow (supports piece sizing).
 * Returns converted numeric or NaN if conversion not possible.
 */
function convertToInventoryUnits(amount, productUnit, inventoryUnit, ingredientRow = {}) {
  const prodU = normUnit(productUnit || inventoryUnit);
  const invU = normUnit(inventoryUnit);
  // direct/simple conversion (mass <-> mass, volume <-> volume)
  const direct = convertSimple(amount, prodU, invU);
  if (!Number.isNaN(direct)) return direct;

  const pieceAmount = ingredientRow && ingredientRow.piece_amount != null ? Number(ingredientRow.piece_amount) : null;
  const pieceUnit = ingredientRow && ingredientRow.piece_unit ? String(ingredientRow.piece_unit) : null;

  // inventory stored as pieces, product unit is mass/volume -> how many pieces needed?
  if (invU === "piece" && pieceAmount && pieceUnit) {
    const perPieceInProd = convertSimple(pieceAmount, pieceUnit, prodU);
    if (!Number.isNaN(perPieceInProd) && perPieceInProd > 0) {
      return Number(amount) / perPieceInProd;
    }
  }

  // product unit is piece and inventory is mass/volume -> pieces * per-piece amount (converted)
  if (prodU === "piece" && pieceAmount && pieceUnit) {
    const perPieceInInv = convertSimple(pieceAmount, pieceUnit, invU);
    if (!Number.isNaN(perPieceInInv)) {
      return Number(amount) * perPieceInInv;
    }
  }

  // conversion not possible
  return NaN;
}

/**
 * Determine if a product-level unit can be converted to the ingredient inventory unit.
 * Rules:
 * - mass <-> mass allowed (g, kg)
 * - volume <-> volume allowed (ml, l)
 * - piece <-> piece allowed
 * - piece <-> mass/volume allowed ONLY if ingredient has piece_amount + piece_unit and those units are convertible to the other side
 * - unit (generic) is non-convertible except when identical
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
// ---------------------- end helper ----------------------


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

    // Validate units for provided ingredients BEFORE insert
    if (Array.isArray(ingredients) && ingredients.length > 0) {
      for (const ing of ingredients) {
        // fetch ingredient definition
        const ingRowRes = await client.query(
          "SELECT id, unit, piece_amount, piece_unit FROM ingredients WHERE id = $1 LIMIT 1",
          [ing.id]
        );
        if (ingRowRes.rows.length === 0) {
          await client.query("ROLLBACK");
          return res.status(400).json({ success: false, message: `Ingredient id ${ing.id} not found` });
        }
        const ingRow = ingRowRes.rows[0];
        const prodUnit = ing.unit ?? ingRow.unit;
        const invUnit = ingRow.unit;
        if (!canConvert(prodUnit, invUnit, { piece_amount: ingRow.piece_amount, piece_unit: ingRow.piece_unit })) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            success: false,
            message: `Incompatible unit for ingredient '${ingRow.name || ing.id}': product unit '${prodUnit}' cannot convert to inventory unit '${invUnit}'`
          });
        }
      }
    }

    // Insert product
    const productResult = await client.query(
      `INSERT INTO products (name, category, price, sku, photo, color, stock)
       VALUES ($1, $2, $3, $4, $5, $6, 0)
       RETURNING id`,
      [normalizedName, category, price, normalizedSku, photo ?? "", color ?? ""]
    );
    const productId = productResult.rows[0].id;

    // Insert ingredients if any (store amount_unit if provided, else fallback to ingredient.unit via migration/backfill)
    if (ingredients && ingredients.length > 0) {
      for (const ing of ingredients) {
        await client.query(
          `INSERT INTO product_ingredients (product_id, ingredient_id, amount_needed, amount_unit)
           VALUES ($1, $2, $3, $4)`,
          [productId, ing.id, Number(ing.amount), ing.unit ?? null]
        );
      }
    }

    await client.query("COMMIT");
    return res.json({
      success: true,
      message:
        ingredients && ingredients.length > 0
          ? "Product and ingredients added successfully"
          : "Product added without ingredients",
      productId,
      sku: normalizedSku,
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
      "SELECT id, name, category, price, sku, is_active FROM products WHERE id = $1 LIMIT 1",
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
      is_active: row.is_active,
    });
  } catch (err) {
    console.error("❌ Error fetching product details:", err.message);
    return res.status(500).json({ success: false, message: "Database error", error: err.message });
  }
});

// ✅ Update product basic fields (name, category, price)
app.put("/products/:id", async (req, res) => {
  const { id } = req.params;
  const { name, category, price } = req.body;

  if (!name || !category || price === undefined || price === null) {
    return res.status(400).json({ success: false, message: "Missing required fields" });
  }

  const normalizedName = String(name).trim();
  const numericPrice = Number(price);
  if (!Number.isFinite(numericPrice) || numericPrice < 0) {
    return res.status(400).json({ success: false, message: "Invalid price" });
  }

  try {
    const result = await pool.query(
      "UPDATE products SET name = $1, category = $2, price = $3 WHERE id = $4",
      [normalizedName, category, numericPrice, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Error updating product:", err.message);
    return res.status(500).json({ success: false, message: "Database error", error: err.message });
  }
});

// ✅ Get a product's ingredients and required amounts
app.get("/products/:id/ingredients", async (req, res) => {
  const { id } = req.params;

  const sql = `
    SELECT i.id,
           i.name,
           COALESCE(pi.amount_unit, i.unit) AS unit,
           pi.amount_needed AS amount
    FROM product_ingredients pi
    JOIN ingredients i ON i.id = pi.ingredient_id
    WHERE pi.product_id = $1
    ORDER BY i.name ASC
  `;

  try {
    const result = await pool.query(sql, [id]);

    const items = result.rows.map(r => ({
      id: r.id,
      name: r.name,
      unit: r.unit,
      amount: Number(r.amount)
    }));

    res.json({ success: true, items });
  } catch (err) {
    console.error("❌ Error fetching product ingredients:", err.message);
    res.status(500).json({ success: false, message: "Database error", error: err.message });
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
  const { name, stock, unit } = req.body;

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

    // ✅ Insert new ingredient
    await pool.query(
      "INSERT INTO ingredients (name, stock, unit) VALUES ($1, $2, $3)",
      [name, stock, unit]
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
  const { name, stock, unit, source } = req.body;

  try {
    const getSql = 'SELECT stock FROM ingredients WHERE id = $1';
    const getResult = await pool.query(getSql, [id]);
    if (getResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Ingredient not found' });
    }
    const oldStock = getResult.rows[0].stock;
    const difference = stock - oldStock;

    const updateSql = 'UPDATE ingredients SET name=$1, stock=$2, unit=$3 WHERE id=$4';
    await pool.query(updateSql, [name, stock, unit, id]);

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
app.get("/best-sellers", async (req, res) => {
  try {
    const { month, year, category } = req.query;
    const m = month ? Number(month) : new Date().getMonth() + 1;
    const y = year ? Number(year) : new Date().getFullYear();

    const sql = `
      SELECT
        p.id,
        p.name,
        COALESCE(SUM(GREATEST(si.quantity - COALESCE(ri.refunded_qty,0),0)),0)::int AS total_sold
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      JOIN products p ON p.id = si.product_id
      LEFT JOIN (
        SELECT r.sale_id, ri.product_id, SUM(ri.quantity)::int AS refunded_qty
        FROM refund_items ri
        JOIN refunds r ON r.id = ri.refund_id
        GROUP BY r.sale_id, ri.product_id
      ) ri ON ri.sale_id = si.sale_id AND ri.product_id = si.product_id
      WHERE EXTRACT(YEAR FROM s.created_at) = $1
        AND EXTRACT(MONTH FROM s.created_at) = $2
      ${category ? "AND p.category = $3" : ""}
      GROUP BY p.id, p.name
      ORDER BY total_sold DESC
      LIMIT 20;
    `;
    const params = category ? [y, m, category] : [y, m];
    const { rows } = await pool.query(sql, params);
    res.json({ month: m, year: y, items: rows });
  } catch (err) {
    console.error("best-sellers error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch best sellers" });
  }
});

// Sales report (bucketed) subtracting refunds
app.get("/sales-report", async (req, res) => {
  try {
    const period = (req.query.period || "day").toLowerCase();
    const trunc = period === "month" ? "month" : period === "week" ? "week" : "day";

    const sql = `
      SELECT
        to_char(date_trunc($1, s.created_at), 'YYYY-MM-DD') AS bucket,
        p.name AS product,
        COALESCE(SUM(GREATEST(si.quantity - COALESCE(ri.refunded_qty,0),0)),0)::int AS total_sold
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      JOIN products p ON p.id = si.product_id
      LEFT JOIN (
        SELECT r.sale_id, ri.product_id, SUM(ri.quantity)::int AS refunded_qty
        FROM refund_items ri
        JOIN refunds r ON r.id = ri.refund_id
        GROUP BY r.sale_id, ri.product_id
      ) ri ON ri.sale_id = si.sale_id AND ri.product_id = si.product_id
      WHERE s.created_at >= (now() - interval '1 year')
      GROUP BY bucket, p.name
      ORDER BY bucket DESC, total_sold DESC;
    `;
    const { rows } = await pool.query(sql, [trunc]);
    res.json({ items: rows });
  } catch (err) {
    console.error("sales-report error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch sales report" });
  }
});
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
      if (it.quantity > available) {
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
    console.error("❌ /refund-sale error:", err && (err.message || err));
    return res.status(500).json({ success: false, message: "Refund failed", error: String(err && err.message || err) });
  } finally {
    client.release();
  }
});

// replace existing app.put('/purchase-orders/:id/receive', ...) handler with this
app.put('/purchase-orders/:id/receive', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // lock PO
    const poRes = await client.query('SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE', [id]);
    if (poRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Purchase order not found' });
    }

    // load items (schema uses po_id)
    const itemsRes = await client.query('SELECT * FROM purchase_order_items WHERE po_id = $1', [id]);
    const items = itemsRes.rows || [];

    // update stock and record additions using your schema: (ingredient_id, amount, date, source)
    for (const it of items) {
      const qty = Number(it.qty || 0);
      // update ingredient stock
      await client.query('UPDATE ingredients SET stock = COALESCE(stock,0) + $1 WHERE id = $2', [qty, it.ingredient_id]);

      // insert addition record
      await client.query(
        `INSERT INTO ingredient_additions (ingredient_id, amount, date, source)
         VALUES ($1, $2, NOW(), $3)`,
        [it.ingredient_id, qty, `PO:${id}`]
      );
    }

    // mark PO received
    // updated_at column may not exist in your schema — update only status to avoid SQL error
    await client.query('UPDATE purchase_orders SET status = $1 WHERE id = $2', ['received', id]);

    await client.query('COMMIT');
    return res.json({ success: true, message: 'PO received', id });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('receive PO error', err);
    return res.status(500).json({ success: false, message: 'Server error', error: String(err.message) });
  } finally {
    client.release();
  }
});

// Cancel a PO
app.put('/purchase-orders/:id/cancel', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ success: false, message: 'Invalid id' });
  try {
    const q = await dbQuery(`UPDATE purchase_orders SET status = 'cancelled' WHERE id = $1 RETURNING id`, [id]);
    if (!q || q.length === 0) return res.status(404).json({ success: false, message: 'Not found' });
    return res.json({ success: true });
  } catch (err) {
    console.error('cancel po', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// List purchase orders (basic fields + items)
app.get('/purchase-orders', async (req, res) => {
  try {
    const ordersRes = await pool.query(
      `SELECT id, supplier_id, created_by, status, total, notes, created_at
       FROM purchase_orders
       ORDER BY created_at DESC`
    );
    const orders = ordersRes.rows || [];

    // load items for all orders in one query
    const orderIds = orders.map(o => o.id);
    let items = [];
    if (orderIds.length > 0) {
      const itemsRes = await pool.query(
        `SELECT poi.*, i.name AS ingredient_name
         FROM purchase_order_items poi
         LEFT JOIN ingredients i ON i.id = poi.ingredient_id
         WHERE poi.po_id = ANY($1::int[])
         ORDER BY poi.id`,
        [orderIds]
      );
      items = itemsRes.rows || [];
    }

    // attach items to their orders
    const byOrder = {};
    for (const it of items) {
      const key = String(it.po_id);
      byOrder[key] = byOrder[key] || [];
      byOrder[key].push({
        id: it.id,
        ingredient_id: it.ingredient_id,
        ingredient_name: it.ingredient_name,
        qty: it.qty,
        unit: it.unit,
        unit_cost: it.unit_cost,
        created_at: it.created_at
      });
    }

    const out = orders.map(o => ({
      ...o,
      items: byOrder[String(o.id)] || []
    }));

    return res.json(out);
  } catch (err) {
    console.error('❌ /purchase-orders error:', err && (err.message || err));
    return res.status(500).json({ success: false, message: 'Failed to fetch purchase orders', error: String(err && err.message || err) });
  }
});

// Get single purchase order with items
app.get('/purchase-orders/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const poRes = await pool.query(
      `SELECT id, supplier_id, created_by, status, total, notes, created_at
       FROM purchase_orders WHERE id = $1 LIMIT 1`,
      [id]
    );
    if (poRes.rows.length === 0) return res.status(404).json({ success: false, message: 'Purchase order not found' });
    const po = poRes.rows[0];

    const itemsRes = await pool.query(
      `SELECT poi.*, i.name AS ingredient_name
       FROM purchase_order_items poi
       LEFT JOIN ingredients i ON i.id = poi.ingredient_id
       WHERE poi.po_id = $1
       ORDER BY poi.id`,
      [id]
    );

    po.items = (itemsRes.rows || []).map(it => ({
      id: it.id,
      ingredient_id: it.ingredient_id,
      ingredient_name: it.ingredient_name,
      qty: it.qty,
      unit: it.unit,
      unit_cost: it.unit_cost,
      created_at: it.created_at
    }));

    return res.json(po);
  } catch (err) {
    console.error('❌ /purchase-orders/:id error:', err && (err.message || err));
    return res.status(500).json({ success: false, message: 'Failed to fetch purchase order', error: String(err && err.message || err) });
  }
});

// Delete a purchase order (only allowed when not received)
app.delete('/purchase-orders/:id', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ensure PO exists
    const poRes = await client.query('SELECT id, status FROM purchase_orders WHERE id = $1 FOR UPDATE', [id]);
    if (poRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Purchase order not found' });
    }
    const po = poRes.rows[0];
    if (po.status === 'received') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Cannot delete a received purchase order' });
    }

    // delete items (schema uses po_id)
    await client.query('DELETE FROM purchase_order_items WHERE po_id = $1', [id]);
    // delete the purchase order
    await client.query('DELETE FROM purchase_orders WHERE id = $1', [id]);

    await client.query('COMMIT');
    return res.json({ success: true, message: 'Purchase order deleted', id });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('delete PO error', err);
    return res.status(500).json({ success: false, message: 'Server error', error: String(err.message) });
  } finally {
    client.release();
  }
});

// ✅ Create purchase order
app.post('/purchase-orders', async (req, res) => {
  const { supplier_id = null, items = [] } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'Items required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // calculate total (sum qty * unit_cost) safely
    const total = items.reduce((sum, it) => sum + (Number(it.qty || 0) * Number(it.unit_cost || 0)), 0);

    const poInsert = await client.query(
      `INSERT INTO purchase_orders (supplier_id, status, total, created_at)
       VALUES ($1, $2, $3, NOW()) RETURNING id`,
      [supplier_id, 'placed', total]
    );
    const poId = poInsert.rows[0].id;

    const insertItemText =
      `INSERT INTO purchase_order_items (po_id, ingredient_id, qty, unit, unit_cost, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`;

    for (const it of items) {
      await client.query(insertItemText, [
        poId,
        Number(it.ingredient_id),
        Number(it.qty || 0),
        it.unit ?? null,
        Number(it.unit_cost || 0),
      ]);
    }

    await client.query('COMMIT');
    return res.status(201).json({ success: true, id: poId });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('/purchase-orders POST error', err);
    return res.status(500).json({ success: false, message: 'Server error', error: String(err?.message ?? err) });
   } finally {
    client.release();
  }
});

// --- simplified PIN auth (revert to a basic "type 1" PIN flow) ---
// Note: this stores/checks a plain text PIN in users.pin for simplicity.
// It's easier for the client but less secure — consider hashing later.
app.post('/set-pin', async (req, res) => {
  const { username, pin } = req.body || {};
  if (!username || !pin) return res.status(400).json({ success: false, message: 'username and pin required' });

  try {
    // ensure users table has `pin` column. If not present, run:
    // ALTER TABLE users ADD COLUMN pin text;
    const update = await pool.query('UPDATE users SET pin = $1 WHERE username = $2 RETURNING id, username, role', [String(pin), username]);
    if (update.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    return res.json({ success: true, message: 'PIN set' , user: update.rows[0]});
  } catch (err) {
    console.error('/set-pin error', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Login with simple PIN
app.post('/login-pin', async (req, res) => {
  const { pin, device_id } = req.body || {};
  if (!pin) return res.status(400).json({ success: false, message: 'pin required' });

  const client = await pool.connect();
  try {
    // If a device allowlist exists (devices table with allowed=true entries), require device_id to match
    const allowRes = await client.query('SELECT 1 FROM devices WHERE allowed = true LIMIT 1');
    if (allowRes.rowCount > 0) {
      if (!device_id) {
        return res.status(403).json({ success: false, message: 'Device not allowed (device_id required)' });
      }
      const ok = (await client.query('SELECT 1 FROM devices WHERE device_id = $1 AND allowed = true LIMIT 1', [device_id])).rowCount > 0;
      if (!ok) return res.status(403).json({ success: false, message: 'Device not allowed' });
    }

    // Find user by PIN (simple plain-text match per your current design)
    const userRes = await client.query('SELECT id, username, role, pin FROM users WHERE pin = $1 LIMIT 1', [String(pin)]);
    if (userRes.rowCount === 0) {
      return res.status(401).json({ success: false, message: 'Invalid PIN' });
    }

    const user = userRes.rows[0];
    // Return basic user info for the client to navigate
    return res.json({ success: true, id: user.id, username: user.username, role: user.role });
  } catch (err) {
    console.error('/login-pin error', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    client.release();
  }
});

// --- device allowlist management (admin only recommended) ---
app.post('/devices', async (req, res) => {
  const { device_id, description, allowed = true } = req.body || {};
  if (!device_id) return res.status(400).json({ success: false, message: 'device_id required' });
  try {
    const r = await pool.query(
      `INSERT INTO devices (device_id, description, allowed, created_at)
       VALUES ($1, $2, $3, NOW()) RETURNING id, device_id, description, allowed`,
      [device_id, description || null, allowed]
    );
    return res.status(201).json({ success: true, device: r.rows[0] });
  } catch (err) {
    console.error('/devices POST', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/devices', async (_req, res) => {
  try {
    const r = await pool.query('SELECT id, device_id, description, allowed, created_at FROM devices ORDER BY created_at DESC');
    return res.json(r.rows || []);
  } catch (err) {
    console.error('/devices GET', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.delete('/devices/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM devices WHERE id = $1', [id]);
    return res.json({ success: true, id });
  } catch (err) {
    console.error('/devices DELETE', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ----------------- OTP helpers and endpoints -----------------
const nodemailer = require('nodemailer');
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  try { twilioClient = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN); } catch(e){ twilioClient = null; }
}

const OTP_TTL_MS = Number(process.env.OTP_TTL_MS || 5 * 60 * 1000); // default 5 min

async function sendOtpViaSms(phone, code) {
  if (!twilioClient) throw new Error('Twilio not configured');
  // TWILIO_FROM must be set
  return twilioClient.messages.create({ body: `Your OTP: ${code}`, from: process.env.TWILIO_FROM, to: phone });
}

async function sendOtpViaEmail(email, code) {
  // require nodemailer lazily so server won't crash when package isn't installed
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) throw new Error('SMTP not configured');
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (err) {
    throw new Error('nodemailer module not installed. Run: npm install nodemailer');
  }
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: email,
    subject: 'Your OTP code',
    text: `Your OTP code is: ${code}. It expires in ${Math.round(OTP_TTL_MS/60000)} minutes.`,
  });
}

async function storeOtp(client, identifier, code, ttlMs = OTP_TTL_MS) {
  const expiresAt = new Date(Date.now() + ttlMs);
  const q = await client.query(
    `INSERT INTO otps (identifier, code, expires_at, used, created_at)
     VALUES ($1, $2, $3, false, NOW()) RETURNING id`,
    [identifier, String(code), expiresAt]
  );
  return q.rows[0];
}

/*
DB: create otps table (run once)
CREATE TABLE IF NOT EXISTS otps (
  id serial PRIMARY KEY,
  identifier text NOT NULL,
  code text NOT NULL,
  expires_at timestamptz NOT NULL,
  used boolean DEFAULT false,
  created_at timestamptz DEFAULT NOW()
);
*/

// Request OTP (identifier: phone or email). provider auto chosen by format/env.
app.post('/auth/request-otp', async (req, res) => {
  const { identifier } = req.body || {};
  if (!identifier) return res.status(400).json({ success: false, message: 'identifier required (phone or email)' });

  const client = await pool.connect();
  try {
    // generate 6-digit code
    const code = (Math.floor(100000 + Math.random() * 900000)).toString();

    // store code
    await storeOtp(client, identifier, code);

    // send via appropriate channel: simple detection by @ for email
    if (String(identifier).includes('@')) {
      await sendOtpViaEmail(identifier, code);
    } else {
      if (!twilioClient) {
        console.warn('Twilio not configured, cannot SMS OTP');
        // still return success but warn client
        return res.status(500).json({ success: false, message: 'SMS provider not configured' });
      }
      await sendOtpViaSms(identifier, code);
    }

    return res.json({ success: true, message: 'OTP sent' });
  } catch (err) {
    console.error('/auth/request-otp error', err);
    return res.status(500).json({ success: false, message: 'Failed to send OTP', error: String(err.message || err) });
  } finally {
    client.release();
  }
});

// Receive PO with OTP verification and update stock + recalc total
// POST /purchase-orders/:id/receive-with-otp { identifier, code }
app.post('/purchase-orders/:id/receive-with-otp', async (req, res) => {
  const { id } = req.params;
  const { identifier, code } = req.body || {};
  if (!identifier || !code) return res.status(400).json({ success: false, message: 'identifier and code required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // verify OTP: most recent for identifier
    const otpRes = await client.query(
      `SELECT id, code, expires_at, used FROM otps WHERE identifier = $1 ORDER BY created_at DESC LIMIT 1`,
      [identifier]
    );
    const otpRow = otpRes.rows[0];
    if (!otpRow) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
    }
    if (otpRow.used) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'OTP already used' });
    }
    if (String(otpRow.code) !== String(code) || new Date(otpRow.expires_at) < new Date()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
    }

    // mark OTP used
    await client.query('UPDATE otps SET used = true WHERE id = $1', [otpRow.id]);

    // lock PO
    const poRes = await client.query('SELECT id, status FROM purchase_orders WHERE id = $1 FOR UPDATE', [id]);
    if (poRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Purchase order not found' });
    }
    const po = poRes.rows[0];
    if (po.status === 'received') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Purchase order already received' });
    }

    // compute total from items (qty * unit_cost)
    const sumRes = await client.query(`SELECT COALESCE(SUM(COALESCE(qty::numeric,0) * COALESCE(unit_cost::numeric,0)),0) AS total FROM purchase_order_items WHERE po_id = $1`, [id]);
    const computedTotal = Number(sumRes.rows[0]?.total ?? 0);

    // update purchase_orders total and status
    await client.query('UPDATE purchase_orders SET total = $1, status = $2 WHERE id = $3', [computedTotal, 'received', id]);

    // update stock and insert additions
    const itemsRes = await client.query('SELECT ingredient_id, qty FROM purchase_order_items WHERE po_id = $1', [id]);
    for (const it of itemsRes.rows) {
      const qty = Number(it.qty || 0);
      if (qty > 0) {
        await client.query('UPDATE ingredients SET stock = COALESCE(stock,0) + $1 WHERE id = $2', [qty, it.ingredient_id]);
        await client.query(
          `INSERT INTO ingredient_additions (ingredient_id, amount, date, source)
           VALUES ($1, $2, NOW(), $3)`,
          [it.ingredient_id, qty, `PO:${id}`]
        );
      }
    }

    await client.query('COMMIT');
    return res.json({ success: true, message: 'PO received', id: Number(id), total: computedTotal });
  } catch (err) {
    await client.query('ROLLBACK').catch(()=>{});
    console.error('❌ receive-with-otp error:', err && (err.message || err));
    return res.status(500).json({ success: false, message: 'Server error', error: String(err && err.message || err) });
  } finally {
    client.release();
  }
});

// simple admin auth using an env secret (safe for small internal admin UI)
function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'] || req.body?.admin_key || req.query?.admin_key;
  if (!process.env.ADMIN_KEY) return res.status(500).json({ success: false, message: 'ADMIN_KEY not configured' });
  if (!key || String(key) !== String(process.env.ADMIN_KEY)) return res.status(403).json({ success: false, message: 'Forbidden' });
  next();
}

// helper: store OTP row
async function storeOtpRow(client, identifier, code, ttlMs = Number(process.env.OTP_TTL_MS || 300000)) {
  const expiresAt = new Date(Date.now() + ttlMs);
  const q = await client.query(
    `INSERT INTO otps (identifier, code, expires_at, used, created_at)
     VALUES ($1, $2, $3, false, NOW()) RETURNING id`,
    [identifier, String(code), expiresAt]
  );
  return q.rows[0];
}

// admin: register/update device (creates or updates by device_id)
app.post('/admin/devices', adminAuth, async (req, res) => {
  const { device_id, description = null, allowed = true } = req.body || {};
  if (!device_id) return res.status(400).json({ success: false, message: 'device_id required' });

  try {
    // upsert on device_id
    const q = await pool.query(
      `INSERT INTO devices (device_id, description, allowed, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (device_id) DO UPDATE
         SET description = EXCLUDED.description, allowed = EXCLUDED.allowed
       RETURNING id, device_id, description, allowed, created_at`,
      [device_id, description, allowed]
    );
    return res.status(201).json({ success: true, device: q.rows[0] });
  } catch (err) {
    console.error('/admin/devices error', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// admin: list devices
app.get('/admin/devices', adminAuth, async (req, res) => {
  try {
    const q = await pool.query('SELECT id, device_id, description, allowed, created_at FROM devices ORDER BY created_at DESC');
    return res.json({ success: true, devices: q.rows });
  } catch (err) {
    console.error('/admin/devices GET error', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// admin: send a test OTP to an identifier (phone or email)
// body: { identifier: "alice@example.com" } or { identifier: "+15551234567" }
app.post('/admin/send-test-otp', adminAuth, async (req, res) => {
  const { identifier } = req.body || {};
  if (!identifier) return res.status(400).json({ success: false, message: 'identifier required' });

  const client = await pool.connect();
  try {
    // generate 6-digit code
    const code = (Math.floor(100000 + Math.random() * 900000)).toString();

    // store OTP row
    await storeOtpRow(client, identifier, code);

    // send via email or SMS depending on identifier format
    if (String(identifier).includes('@')) {
      // email
      if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
        return res.status(500).json({ success: false, message: 'SMTP not configured' });
      }
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: Number(process.env.SMTP_PORT || 587),
        secure: String(process.env.SMTP_SECURE || 'false') === 'true',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
      await transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: identifier,
        subject: 'Test OTP',
        text: `Your test OTP is: ${code} (expires in ${Math.round((Number(process.env.OTP_TTL_MS||300000)/60000))} minutes)`,
      });
      return res.json({ success: true, method: 'email', message: 'OTP sent by email' });
    } else {
      // SMS
      if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_FROM) {
        return res.status(500).json({ success: false, message: 'Twilio not configured' });
      }
      const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      await twilio.messages.create({
        body: `Your test OTP is: ${code}`,
        from: process.env.TWILIO_FROM,
        to: identifier,
      });
      return res.json({ success: true, method: 'sms', message: 'OTP sent by SMS' });
    }
  } catch (err) {
    console.error('/admin/send-test-otp error', err);
    return res.status(500).json({ success: false, message: 'Failed to send OTP', error: String(err?.message || err) });
  } finally {
    client.release();
  }
});

