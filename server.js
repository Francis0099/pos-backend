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
  const sql = `
    SELECT p.id, p.name, p.category, 
           ROUND(CAST(p.price AS NUMERIC), 2) AS price,
           MIN(FLOOR(i.stock / pi.amount_needed)) AS stock
    FROM products p
    LEFT JOIN product_ingredients pi ON p.id = pi.product_id
    LEFT JOIN ingredients i ON pi.ingredient_id = i.id
    WHERE p.is_active = TRUE
    GROUP BY p.id
  `;

  try {
    const { rows } = await pool.query(sql);

    const products = rows.map((row) => ({
      ...row,
      price: row.price !== null ? Number(row.price) : 0,
      stock: row.stock !== null ? Number(row.stock) : 0,
    }));

    res.json(products);
  } catch (err) {
    console.error("❌ Error fetching products with stock:", err.message || err);
    // include details for dev debugging
    res.status(500).json({ success: false, message: "Database error", details: String(err.message || err) });
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
  const { items, total, paymentMode } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.json({ success: false, message: 'No items in order' });
  }

  const normalizedPayment =
    typeof paymentMode === "string" && paymentMode.length > 0 ? paymentMode : "CASH";

  const numericTotal = Number(total);
  if (!Number.isFinite(numericTotal) || numericTotal < 0) {
    return res.status(400).json({ success: false, message: "Invalid total amount" });
  }

  const client = await pool.connect(); // ✅ Postgres transaction client
  try {
    await client.query("BEGIN");

    // Insert into sales
    const saleResult = await client.query(
      "INSERT INTO sales (total_amount, payment_mode) VALUES ($1, $2) RETURNING id",
      [numericTotal, normalizedPayment]
    );
    const saleId = saleResult.rows[0].id;

    // Insert sale items
    const orderItems = items.map(it => [
      saleId,
      Number(it.id),
      Number(it.quantity),
    ]);

    if (
      orderItems.some(
        r => !Number.isInteger(r[1]) || !Number.isInteger(r[2]) || r[2] <= 0
      )
    ) {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({ success: false, message: "Invalid item ids or quantities" });
    }

    for (const [sale_id, product_id, quantity] of orderItems) {
      await client.query(
        "INSERT INTO sale_items (sale_id, product_id, quantity) VALUES ($1, $2, $3)",
        [sale_id, product_id, quantity]
      );

      // Fetch ingredients for each product
      const ingredientsResult = await client.query(
        `SELECT pi.ingredient_id, pi.amount_needed, i.name, i.unit, i.stock
         FROM product_ingredients pi
         JOIN ingredients i ON pi.ingredient_id = i.id
         WHERE pi.product_id = $1`,
        [product_id]
      );

      for (const ing of ingredientsResult.rows) {
        const totalNeeded = Number(ing.amount_needed) * quantity;

        // Deduct from stock
        await client.query(
          "UPDATE ingredients SET stock = GREATEST(stock - $1, 0) WHERE id = $2",
          [totalNeeded, ing.ingredient_id]
        );

        // Track usage
        await client.query(
          `INSERT INTO ingredient_usage 
             (sale_id, product_id, ingredient_id, amount_used, created_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [saleId, product_id, ing.ingredient_id, totalNeeded]
        );
      }
    }

    await client.query("COMMIT");
    return res.json({
      success: true,
      message: "✅ Order successfully recorded",
      saleId,
    });
  } catch (err) {
    console.error("❌ submit-order error:", err.message);
    await client.query("ROLLBACK");
    return res.status(500).json({
      success: false,
      message: "Order failed",
      error: err.message,
    });
  } finally {
    client.release(); // ✅ Release connection back to pool
  }
});



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

    // Insert product
    const productResult = await client.query(
      `INSERT INTO products (name, category, price, sku, photo, color, stock)
       VALUES ($1, $2, $3, $4, $5, $6, 0)
       RETURNING id`,
      [normalizedName, category, price, normalizedSku, photo ?? "", color ?? ""]
    );
    const productId = productResult.rows[0].id;

    // Insert ingredients if any
    if (ingredients && ingredients.length > 0) {
      for (const ing of ingredients) {
        await client.query(
          `INSERT INTO product_ingredients (product_id, ingredient_id, amount_needed)
           VALUES ($1, $2, $3)`,
          [productId, ing.id, Number(ing.amount)]
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
    SELECT i.id, i.name, i.unit, pi.amount_needed AS amount
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
  const { ingredients } = req.body; // [{ ingredientId, amount }]

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

    // Delete old ingredients for this product
    await client.query("DELETE FROM product_ingredients WHERE product_id = $1", [
      id,
    ]);

    // Insert new ingredients if provided
    if (ingredients.length > 0) {
      const values = [];
      const params = [];

      ingredients.forEach((ing, idx) => {
        const base = idx * 3;
        params.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
        values.push(id, ing.ingredientId, Number(ing.amount));
      });

      const sql = `
        INSERT INTO product_ingredients (product_id, ingredient_id, amount_needed)
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



// ✅ Get all active products with computed stock
app.get("/products-with-stock", async (req, res) => {
  const sql = `
    SELECT p.id, p.name, p.category, 
           ROUND(CAST(p.price AS NUMERIC), 2) AS price,
           MIN(FLOOR(i.stock / pi.amount_needed)) AS stock
    FROM products p
    LEFT JOIN product_ingredients pi ON p.id = pi.product_id
    LEFT JOIN ingredients i ON pi.ingredient_id = i.id
    WHERE p.is_active = TRUE
    GROUP BY p.id
  `;

  try {
    const { rows } = await pool.query(sql);

    const products = rows.map((row) => ({
      ...row,
      price: row.price !== null ? Number(row.price) : 0,
      stock: row.stock !== null ? Number(row.stock) : 0,
    }));

    res.json(products);
  } catch (err) {
    console.error("❌ Error fetching products with stock:", err.message || err);
    // include details for dev debugging
    res.status(500).json({ success: false, message: "Database error", details: String(err.message || err) });
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


// ...existing code...
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
      JOIN sales s ON si.sale_id = s.id
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

    let sql = `
      SELECT p.id, p.name, SUM(si.quantity) AS total_sold
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      JOIN products p ON p.id = si.product_id
      WHERE EXTRACT(YEAR FROM s.created_at) = $1 AND EXTRACT(MONTH FROM s.created_at) = $2
    `;
    const params = [y, m];

    if (category && category.trim()) {
      sql += ` AND p.category = $3`;
      params.push(category.trim());
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
  const { saleId, items = [], amount = 0, reason = "" } = req.body || {};
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

    // insert refund_items and restore ingredient stock per product
    for (const it of itemsToRefund) {
      if (!it.productId || it.quantity <= 0) continue;
      await client.query(
        "INSERT INTO refund_items (refund_id, product_id, quantity) VALUES ($1, $2, $3)",
        [refundId, it.productId, it.quantity]
      );

      // restore ingredient stock using product_ingredients mapping
      const ingrRes = await client.query(
        "SELECT ingredient_id, amount_needed FROM product_ingredients WHERE product_id = $1",
        [it.productId]
      );
      for (const row of ingrRes.rows) {
        const restore = Number(row.amount_needed) * it.quantity;
        if (restore > 0) {
          await client.query(
            "UPDATE ingredients SET stock = stock + $1 WHERE id = $2",
            [restore, row.ingredient_id]
          );
        }
      }
    }

    await client.query("COMMIT");
    return res.json({ success: true, refundId });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ /refund-sale error:", err && (err.message || err));
    return res.status(500).json({ success: false, message: "Refund failed", error: String(err.message || err) });
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

// ✅ Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
});

