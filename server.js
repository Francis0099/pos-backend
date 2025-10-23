require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { Pool } = require("pg");

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
    return await pool.query(text, params);
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
    console.error("❌ /sales-report error:", err);
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


app.get('/test-db', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send('Database error');
  }
});

// debug: print env + DB connection info at startup
console.warn('[startup] DATABASE_URL=', process.env.DATABASE_URL);

(async () => {
  try {
    const r = await pool.query("SELECT current_database() AS db, current_user AS user, inet_server_addr() AS host, inet_server_port() AS port");
    console.warn('[startup] connected db=', r.rows[0]);
  } catch (e) {
    console.warn('[startup] db check failed', e.message || e);
  }
})();

// debug endpoint to inspect which DB the running server sees
app.get('/debug-sales-columns', async (req, res) => {
  try {
    const infoRes = await pool.query("SELECT current_database() AS db, current_user AS user");
    const cols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'sales' ORDER BY column_name");
    res.json({
      database: infoRes.rows[0]?.db || null,
      user: infoRes.rows[0]?.user || null,
      host: infoRes.rows[0]?.host || null,
      port: infoRes.rows[0]?.port || null,
      sales_columns: cols.rows.map(r => r.column_name)
    });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});
app.get("/ingredient-usage-rows", async (req, res) => {
  try {
    const onlyToday = String(req.query.today || "").toLowerCase() === "true";
    const where = onlyToday ? "WHERE DATE(u.created_at) = CURRENT_DATE" : "";
    const sql = `
      SELECT
        u.created_at AS date,
        i.id AS ingredient_id,
        i.name AS ingredient,
        u.product_id,
        COALESCE(p.name, 'Manual Deduction') AS product_name,
        u.amount_used AS amount
      FROM ingredient_usage u
      JOIN ingredients i ON u.ingredient_id = i.id
      LEFT JOIN products p ON u.product_id = p.id
      ${where}
      ORDER BY u.created_at DESC
      LIMIT 1000
    `;
    const { rows } = await pool.query(sql);
    res.json(rows || []);
  } catch (err) {
    console.error("❌ Error fetching ingredient usage rows:", err);
    res.status(500).json({ success: false, message: "Database error" });
  }
});

// ✅ Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
});

