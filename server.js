require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bcrypt = require('bcryptjs');

const app = express();
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (_req, res) => res.json({ ok: true }));

// ✅ MySQL connection
const db = mysql.createConnection({
	host: process.env.DB_HOST || 'localhost',
	user: process.env.DB_USER || 'root',
	password: process.env.DB_PASS || 'Pangetmo0099||',
	database: process.env.DB_NAME || 'tarica_pos',
	multipleStatements: true,
});

db.connect(err => {
	if (err) {
		console.error('❌ MySQL connection failed:', err);
		process.exit(1);
	}
	console.log('✅ MySQL connected.');
});

app.post('/login', (req, res) => {
  // Debug incoming body
  console.log("📥 Raw body:", req.body);

  const { username, password } = req.body || {};
  console.log("📥 Parsed username:", username);
  console.log("📥 Parsed password:", password);

  if (!username || !password) {
    return res
      .status(400)
      .json({ success: false, message: 'Missing username or password' });
  }

  const sql = 'SELECT id, username, password, role FROM users WHERE username = ? LIMIT 1';
  db.query(sql, [username], async (err, results) => {
    if (err) {
      console.error('❌ Login query error:', err);
      return res.status(500).json({ success: false, message: 'Database error' });
    }

    if (results.length === 0) {
      console.log("❌ No user found for username:", username);
      return res.json({ success: false, message: 'Invalid credentials' });
    }

    const user = results[0];
    console.log("✅ DB user found:", user);

    try {
      let isValid = false;

      if (typeof user.password === 'string' && user.password.startsWith('$2')) {
        // bcrypt hash
        isValid = await bcrypt.compare(password, user.password);
        console.log("🔑 bcrypt compare result:", isValid);
      } else {
        // plaintext
        isValid = user.password === password;
        console.log("🔑 Plain compare:", user.password, "==", password, "=>", isValid);
      }

      if (!isValid) {
        console.log("❌ Password did not match for user:", username);
        return res.json({ success: false, message: 'Invalid credentials' });
      }

      console.log("✅ Login success for user:", username, "role:", user.role);
      res.json({ success: true, role: user.role, username: user.username });
    } catch (e) {
      console.error('❌ Password compare error:', e);
      res.status(500).json({ success: false, message: 'Auth error' });
    }
  });
});


// ✅ Products route
app.get('/products', (req, res) => {
	const sql = 'SELECT id, name, price, stock FROM products';
	db.query(sql, (err, results) => {
		if (err) {
			console.error('❌ Error fetching products:', err.sqlMessage);
			return res.status(500).json({ error: 'Database error', details: err.sqlMessage });
		}
		res.json(results);
	});
});

app.post('/submit-order', async (req, res) => {
	const { items, total, paymentMode } = req.body;

	let conn;
	try {
		if (!Array.isArray(items) || items.length === 0) {
			return res.json({ success: false, message: 'No items in order' });
		}
		const normalizedPayment = typeof paymentMode === 'string' && paymentMode.length > 0 ? paymentMode : 'CASH';
		const numericTotal = Number(total);
		if (!Number.isFinite(numericTotal) || numericTotal < 0) {
			return res.status(400).json({ success: false, message: 'Invalid total amount' });
		}

		conn = db.promise();
		await conn.beginTransaction();

		const [saleResult] = await conn.query(
			'INSERT INTO sales (total_amount, payment_mode) VALUES (?, ?)',
			[numericTotal, normalizedPayment]
		);
		const saleId = saleResult.insertId;

		const orderItems = items.map(it => [saleId, Number(it.id), Number(it.quantity)]);
		if (orderItems.some(r => !Number.isInteger(r[1]) || !Number.isInteger(r[2]) || r[2] <= 0)) {
			await conn.rollback();
			return res.status(400).json({ success: false, message: 'Invalid item ids or quantities' });
		}

		await conn.query('INSERT INTO sale_items (sale_id, product_id, quantity) VALUES ?', [orderItems]);

		for (const item of items) {
			const productId = Number(item.id);
			const qty = Number(item.quantity);
			const [ingredients] = await conn.query(
				`SELECT pi.ingredient_id, pi.amount_needed, i.name, i.unit, i.stock
				 FROM product_ingredients pi
				 JOIN ingredients i ON pi.ingredient_id = i.id
				 WHERE pi.product_id = ?`,
				[productId]
			);

			for (const ing of ingredients) {
				const totalNeeded = Number(ing.amount_needed) * qty;
				await conn.query(
					'UPDATE ingredients SET stock = GREATEST(stock - ?, 0) WHERE id = ?',
					[totalNeeded, ing.ingredient_id]
				);
				await conn.query(
					`INSERT INTO ingredient_usage (sale_id, product_id, ingredient_id, amount_used, created_at)
					 VALUES (?, ?, ?, ?, NOW())`,
					[saleId, productId, ing.ingredient_id, totalNeeded]
				);
			}
		}

		await conn.commit();
		return res.json({ success: true, message: '✅ Order successfully recorded', saleId });
	} catch (err) {
		console.error('❌ submit-order error:', err && err.sqlMessage ? err.sqlMessage : err);
		try {
			if (conn) await conn.rollback();
		} catch (_) {}
		return res.status(500).json({ success: false, message: 'Order failed', error: err && (err.sqlMessage || err.message) });
	}
});







// ✅ Add Product with Ingredients + Amount
app.post('/add-product', (req, res) => {
	const { name, category, price, sku, photo, color, ingredients } = req.body;

	if (!name || !category || price === undefined || price === null) {
		return res.status(400).json({ success: false, message: 'Missing required fields' });
	}

	// Normalize and generate SKU if missing
	const normalizedName = String(name).trim();
	const normalizedSku = sku && String(sku).trim().length > 0
		? String(sku).trim()
		: `SKU-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

	// Validate ingredient amounts if provided
	if (Array.isArray(ingredients)) {
		for (const ing of ingredients) {
			const amt = Number(ing.amount);
			if (!Number.isFinite(amt) || amt <= 0) {
				return res.status(400).json({ success: false, message: 'Ingredient amounts must be positive numbers' });
			}
		}
	}

	// Ensure unique product name (case-insensitive)
	db.query('SELECT id FROM products WHERE LOWER(name) = LOWER(?) LIMIT 1', [normalizedName], (dupErr, dupRows) => {
		if (dupErr) {
			console.error('❌ Error checking duplicate name:', dupErr);
			return res.status(500).json({ success: false, message: 'Database error' });
		}
		if (dupRows && dupRows.length > 0) {
			return res.status(409).json({ success: false, message: 'Product name already exists' });
		}

		const productQuery = `
			INSERT INTO products (name, category, price, sku, photo, color, stock)
			VALUES (?, ?, ?, ?, ?, ?, 0)
		`;

		db.query(productQuery, [normalizedName, category, price, normalizedSku, (photo ?? ''), (color ?? '')], (err, result) => {
			if (err) {
				console.error('❌ Error adding product:', err);
				return res.status(500).json({ success: false, message: 'Database error', error: err });
			}

			const productId = result.insertId;

			if (ingredients && ingredients.length > 0) {
				const values = ingredients.map(ing => [productId, ing.id, Number(ing.amount)]);
				const ingQuery = `
					INSERT INTO product_ingredients (product_id, ingredient_id, amount_needed)
					VALUES ?
				`;

				db.query(ingQuery, [values], (err2) => {
					if (err2) {
						console.error('❌ Error linking ingredients:', err2);
						return res.status(500).json({ success: false, message: 'Failed to add ingredients', error: err2 });
					}
					return res.json({ success: true, message: 'Product and ingredients added successfully', productId, sku: normalizedSku });
				});
			} else {
				return res.json({ success: true, message: 'Product added without ingredients', productId, sku: normalizedSku });
			}
		});
	});
});




// ✅ Delete Product
app.delete('/products/:id', (req, res) => {
	const { id } = req.params;

	const sql = 'DELETE FROM products WHERE id = ?';
	db.query(sql, [id], (err, result) => {
		if (err) {
			console.error('❌ Error deleting product:', err);
			return res.status(500).json({ success: false, message: 'Database error' });
		}

		if (result.affectedRows > 0) {
			res.json({ success: true, message: 'Product deleted successfully' });
		} else {
			res.status(404).json({ success: false, message: 'Product not found' });
		}
	});
});


// ✅ Get single product details (including category)
app.get('/products/:id', (req, res) => {
    const { id } = req.params;
    const sql = 'SELECT id, name, category, price, sku, is_active FROM products WHERE id = ? LIMIT 1';
    db.query(sql, [id], (err, results) => {
        if (err) {
            console.error('❌ Error fetching product details:', err);
            return res.status(500).json({ success: false, message: 'Database error' });
        }
        if (!results || results.length === 0) {
            return res.status(404).json({ success: false, message: 'Product not found' });
        }
        const row = results[0];
        res.json({
            id: row.id,
            name: row.name,
            category: row.category,
            price: Number(row.price ?? 0),
            sku: row.sku,
            is_active: row.is_active,
        });
    });
});

// ✅ Update product basic fields (name, category, price)
app.put('/products/:id', (req, res) => {
    const { id } = req.params;
    const { name, category, price } = req.body;

    if (!name || !category || price === undefined || price === null) {
        return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const normalizedName = String(name).trim();
    const numericPrice = Number(price);
    if (!Number.isFinite(numericPrice) || numericPrice < 0) {
        return res.status(400).json({ success: false, message: 'Invalid price' });
    }

    const sql = 'UPDATE products SET name = ?, category = ?, price = ? WHERE id = ?';
    db.query(sql, [normalizedName, category, numericPrice, id], (err, result) => {
        if (err) {
            console.error('❌ Error updating product:', err);
            return res.status(500).json({ success: false, message: 'Database error' });
        }
        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Product not found' });
        }
        res.json({ success: true });
    });
});

// ✅ Get a product's ingredients and required amounts
app.get('/products/:id/ingredients', (req, res) => {
    const { id } = req.params;
    const sql = `
        SELECT i.id, i.name, i.unit, pi.amount_needed AS amount
        FROM product_ingredients pi
        JOIN ingredients i ON i.id = pi.ingredient_id
        WHERE pi.product_id = ?
        ORDER BY i.name ASC
    `;
    db.query(sql, [id], (err, results) => {
        if (err) {
            console.error('❌ Error fetching product ingredients:', err);
            return res.status(500).json({ success: false, message: 'Database error' });
        }
        // Ensure numeric amounts
        const items = (results || []).map(r => ({ id: r.id, name: r.name, unit: r.unit, amount: Number(r.amount) }));
        res.json({ success: true, items });
    });
});

// ✅ Replace product ingredients and their amounts (idempotent set)
app.put('/products/:id/ingredients', async (req, res) => {
    const { id } = req.params;
    const { ingredients } = req.body; // [{ ingredientId, amount }]

    if (!Array.isArray(ingredients)) {
        return res.status(400).json({ success: false, message: 'ingredients must be an array' });
    }

    for (const ing of ingredients) {
        const amt = Number(ing.amount);
        if (!Number.isFinite(amt) || amt <= 0) {
            return res.status(400).json({ success: false, message: 'Ingredient amounts must be positive numbers' });
        }
    }

    const conn = db.promise();
    try {
        await conn.beginTransaction();

        await conn.query('DELETE FROM product_ingredients WHERE product_id = ?', [id]);

        if (ingredients.length > 0) {
            const values = ingredients.map(ing => [id, ing.ingredientId, Number(ing.amount)]);
            await conn.query(
                'INSERT INTO product_ingredients (product_id, ingredient_id, amount_needed) VALUES ?',
                [values]
            );
        }

        await conn.commit();
        res.json({ success: true });
    } catch (err) {
        try { await conn.rollback(); } catch (_) {}
        console.error('❌ Error updating product ingredients:', err && (err.sqlMessage || err.message) || err);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});


// CREATE Ingredient
app.post('/ingredients', (req, res) => {
	const { name, stock, unit } = req.body;

	// Check if ingredient already exists (case-insensitive)
	db.query(
		'SELECT * FROM ingredients WHERE LOWER(name) = LOWER(?)',
		[name],
		(err, results) => {
			if (err) return res.status(500).json({ success: false, message: 'Database error' });
			if (results.length > 0) {
				return res.status(400).json({ success: false, message: 'Ingredient already exists' });
			}

			// Insert into correct column name: stock ✅
			db.query(
				'INSERT INTO ingredients (name, stock, unit) VALUES (?, ?, ?)',
				[name, stock, unit],
				(err2) => {
					if (err2) return res.status(500).json({ success: false, message: 'Database error' });
					res.json({ success: true });
				}
			);
		}
	);
});


app.get('/products-with-stock', (req, res) => {
	const sql = `
        SELECT p.id, p.name, p.category, CAST(p.price AS DECIMAL(10,2)) AS price,
			   MIN(FLOOR(i.stock / pi.amount_needed)) AS stock
		FROM products p
		LEFT JOIN product_ingredients pi ON p.id = pi.product_id
		LEFT JOIN ingredients i ON pi.ingredient_id = i.id
		WHERE p.is_active = 1
		GROUP BY p.id
	`;

	db.query(sql, (err, results) => {
		if (err) {
			console.error('❌ Error fetching products with stock:', err);
			return res.status(500).json({ success: false, message: 'Database error' });
		}

		// 🔑 Make sure price and stock are numbers in the JSON response
		const products = results.map((row) => ({
			...row,
			price: row.price !== null ? Number(row.price) : 0,
			stock: row.stock !== null ? Number(row.stock) : 0,
		}));

		res.json(products);
	});
});


app.put("/products/:id/toggle", (req, res) => {
	const { id } = req.params;
	const { is_active } = req.body;

	const sql = "UPDATE products SET is_active = ? WHERE id = ?";
	db.query(sql, [is_active, id], (err, result) => {
		if (err) {
			console.error("❌ Toggle error:", err);
			return res.status(500).json({ success: false, message: "Database error" });
		}
		res.json({ success: true, message: `Product ${is_active ? "activated" : "deactivated"}` });
	});
});

app.put("/products/:id/toggle-active", (req, res) => {
	const { id } = req.params;
	const { is_active } = req.body;
	db.query(
		"UPDATE products SET is_active = ? WHERE id = ?",
		[is_active, id],
		(err, result) => {
			if (err) return res.status(500).json({ success: false, message: "DB error" });
			res.json({ success: true });
		}
	);
});

app.get('/products-all-admin', (req, res) => {
	const sql = `
        SELECT p.id, 
               p.name, 
               p.category,
               CAST(p.price AS DECIMAL(10,2)) AS price,  -- ✅ force numeric
               p.sku, 
               p.is_active, 
               COALESCE(MIN(FLOOR(i.stock / pi.amount_needed)), 0) AS stock
		FROM products p
		LEFT JOIN product_ingredients pi ON p.id = pi.product_id
		LEFT JOIN ingredients i ON pi.ingredient_id = i.id
		GROUP BY p.id
	`;

	db.query(sql, (err, results) => {
		if (err) {
			console.error("❌ Error fetching admin products:", err);
			return res.status(500).json({ success: false, message: "Database error" });
		}

		// ensure numbers
		const products = results.map(r => ({
			...r,
			price: r.price !== null ? Number(r.price) : 0,
			stock: r.stock !== null ? Number(r.stock) : 0,
		}));

		res.json(products);
	});
});


app.get('/products-all', (req, res) => {
	const sql = `
        SELECT p.id, p.name, p.category, p.price, p.sku, p.is_active, 
			   COALESCE(MIN(FLOOR(i.stock / pi.amount_needed)), 0) AS stock
		FROM products p
		LEFT JOIN product_ingredients pi ON p.id = pi.product_id
		LEFT JOIN ingredients i ON pi.ingredient_id = i.id
		WHERE p.is_active = 1
		GROUP BY p.id
	`;

	db.query(sql, (err, results) => {
		if (err) {
			console.error("❌ Error fetching all products:", err);
			return res.status(500).json({ success: false, message: "Database error" });
		}
		res.json(results);
	});
});


// =====================
// Categories CRUD
// =====================
// List all categories
app.get('/categories', (req, res) => {
    const sql = 'SELECT id, name FROM categories ORDER BY name ASC';
    db.query(sql, (err, results) => {
        if (err) {
            console.error('❌ Error fetching categories:', err);
            return res.status(500).json({ success: false, message: 'Database error' });
        }
        res.json({ success: true, items: results || [] });
    });
});

// Create category
app.post('/categories', (req, res) => {
    const { name } = req.body;
    const trimmed = String(name || '').trim();
    if (trimmed.length === 0) {
        return res.status(400).json({ success: false, message: 'Name is required' });
    }

    // Ensure unique by name (case-insensitive)
    db.query('SELECT id FROM categories WHERE LOWER(name) = LOWER(?) LIMIT 1', [trimmed], (dupErr, rows) => {
        if (dupErr) {
            console.error('❌ Category dup check error:', dupErr);
            return res.status(500).json({ success: false, message: 'Database error' });
        }
        if (rows && rows.length > 0) {
            return res.status(409).json({ success: false, message: 'Category already exists' });
        }
        db.query('INSERT INTO categories (name) VALUES (?)', [trimmed], (err, result) => {
            if (err) {
                console.error('❌ Category insert error:', err);
                return res.status(500).json({ success: false, message: 'Database error' });
            }
            res.json({ success: true, id: result.insertId });
        });
    });
});

// Update category
app.put('/categories/:id', (req, res) => {
    const { id } = req.params;
    const { name } = req.body;
    const trimmed = String(name || '').trim();
    if (trimmed.length === 0) {
        return res.status(400).json({ success: false, message: 'Name is required' });
    }
    db.query('UPDATE categories SET name = ? WHERE id = ?', [trimmed, id], (err, result) => {
        if (err) {
            console.error('❌ Category update error:', err);
            return res.status(500).json({ success: false, message: 'Database error' });
        }
        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Category not found' });
        }
        res.json({ success: true });
    });
});

// Delete category (block if referenced by products)
app.delete('/categories/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const conn = db.promise();
        const [rows] = await conn.query('SELECT COUNT(*) AS cnt FROM products WHERE category = (SELECT name FROM categories WHERE id = ?)', [id]);
        if (rows && rows[0] && Number(rows[0].cnt) > 0) {
            return res.status(409).json({ success: false, message: 'Category is used by products' });
        }
        await conn.query('DELETE FROM categories WHERE id = ?', [id]);
        return res.json({ success: true });
    } catch (err) {
        console.error('❌ Category delete error:', err);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

app.get('/ingredients', (req, res) => {
	const sql = 'SELECT id, name, stock, unit FROM ingredients';
	db.query(sql, (err, results) => {
		if (err) {
			console.error('DB Fetch Error:', err);
			return res.status(500).json({ success: false, message: 'Database error' });
		}
		res.json(results);
	});
});

app.get('/ingredients/:id', (req, res) => {
	const { id } = req.params;

	const sql = `
		SELECT id, name, stock, unit FROM ingredients WHERE id = ?;
		SELECT IFNULL(SUM(amount_used), 0) AS total_deductions FROM ingredient_usage WHERE ingredient_id = ?;
		SELECT IFNULL(SUM(amount), 0) AS total_additions FROM ingredient_additions WHERE ingredient_id = ?;
	`;

	db.query(sql, [id, id, id], (err, results) => {
		if (err) {
			console.error('DB Fetch Error:', err);
			return res.status(500).json({ success: false, message: 'Database error' });
		}

		if (!results[0] || results[0].length === 0) {
			return res.status(404).json({ success: false, message: 'Ingredient not found' });
		}

		const ingredient = results[0][0];
		const totalDeductions = results[1][0].total_deductions;
		const totalAdditions = results[2][0].total_additions;

		res.json({
			...ingredient,
			totalDeductions,
			totalAdditions
		});
	});
});


app.put('/ingredients/:id', (req, res) => {
	const { id } = req.params;
	const { name, stock, unit, source } = req.body;

	const getSql = 'SELECT stock FROM ingredients WHERE id = ?';
	db.query(getSql, [id], (getErr, results) => {
		if (getErr) {
			console.error('❌ DB Fetch Error:', getErr);
			return res.status(500).json({ success: false, message: 'Database error' });
		}

		if (results.length === 0) {
			return res.status(404).json({ success: false, message: 'Ingredient not found' });
		}

		const oldStock = results[0].stock;
		const difference = stock - oldStock;

		const updateSql = 'UPDATE ingredients SET name=?, stock=?, unit=? WHERE id=?';
		db.query(updateSql, [name, stock, unit, id], (updateErr) => {
			if (updateErr) {
				console.error('❌ DB Update Error:', updateErr);
				return res.status(500).json({ success: false, message: 'Database error' });
			}

			if (difference > 0) {
				// ✅ Log Restock
				const additionSql = `
					INSERT INTO ingredient_additions (ingredient_id, date, source, amount)
					VALUES (?, NOW(), ?, ?)
				`;
				db.query(additionSql, [id, source || 'Manual Update', difference], (logErr) => {
					if (logErr) console.error('❌ Addition Log Error:', logErr);
				});
			} else if (difference < 0) {
				// ✅ Log Manual Deduction into ingredient_usage
				const usageSql = `
					INSERT INTO ingredient_usage (sale_id, product_id, ingredient_id, amount_used, created_at)
					VALUES (?, ?, ?, ?, NOW())
				`;
				db.query(usageSql, [null, null, id, Math.abs(difference)], (logErr) => {
					if (logErr) console.error('❌ Manual Deduction Log Error:', logErr);
				});
			}

			res.json({ success: true, message: 'Ingredient updated successfully' });
		});
	});
});







// DELETE Ingredient
app.delete('/ingredients/:id', (req, res) => {
	const { id } = req.params;
	db.query('DELETE FROM ingredients WHERE id=?', [id], (err) => {
		if (err) {
			console.error('DB Delete Error:', err);
			return res.status(500).json({ success: false, message: 'Database error' });
		}
		res.json({ success: true });
	});
});

// ✅ Update employee credentials (admin only)
app.put('/users/:id', (req, res) => {
	const { id } = req.params;
	const { username, password } = req.body;

	if (!username || !password) {
		return res.status(400).json({ success: false, message: 'Username and password are required' });
	}

	const sql = 'UPDATE users SET username = ?, password = ? WHERE id = ?';
	db.query(sql, [username, password, id], (err, result) => {
		if (err) {
			console.error('❌ Error updating user:', err);
			return res.status(500).json({ success: false, message: 'Database error' });
		}

		if (result.affectedRows > 0) {
			res.json({ success: true, message: 'User updated successfully' });
		} else {
			res.status(404).json({ success: false, message: 'User not found' });
		}
	});
});

app.get('/users', (req, res) => {
	const sql = 'SELECT id, username, role FROM users';
	db.query(sql, (err, results) => {
		if (err) {
			console.error('❌ Error fetching users:', err);
			return res.status(500).json({ success: false, message: 'Database error' });
		}
		res.json(results);
	});
});

app.get('/sales-report', (req, res) => {
	const { period, productId, category } = req.query;
  
	let selectBucket = "";
	let groupBy = "";
	let where = "WHERE 1=1";
  
	// Time filtering
	if (period === "day") {
	  selectBucket = "HOUR(s.created_at)";
	  groupBy = "HOUR(s.created_at)";
	  where += " AND DATE(s.created_at) = CURDATE()";
	} else if (period === "week") {
	  selectBucket = "DATE(s.created_at)";
	  groupBy = "DATE(s.created_at)";
	  where += " AND YEARWEEK(s.created_at) = YEARWEEK(CURDATE())";
	} else {
	  selectBucket = "DATE(s.created_at)";
	  groupBy = "DATE(s.created_at)";
	  where += " AND YEAR(s.created_at) = YEAR(CURDATE()) AND MONTH(s.created_at) = MONTH(CURDATE())";
	}
  
	// Filters
	if (productId) where += ` AND si.product_id = ${db.escape(productId)}`;
	if (category) where += ` AND p.category = ${db.escape(category)}`;
  
	const sql = `
	  SELECT 
		p.name AS product,
		${selectBucket} AS bucket,
		SUM(si.quantity) AS total_sold
	  FROM sale_items si
	  JOIN products p ON si.product_id = p.id
	  JOIN sales s ON si.sale_id = s.id
	  ${where}
	  GROUP BY p.id, ${groupBy}
	  ORDER BY bucket ASC
	`;
  
	db.query(sql, (err, results) => {
	  if (err) {
		console.error("❌ Sales report fetch error:", err.sqlMessage);
		return res.status(500).json({ success: false, message: err.sqlMessage });
	  }
	  res.json(results);
	});
  });
  
  
  
  

app.get("/ingredient-usage-report", (req, res) => {
	const sql = `
		SELECT i.name AS ingredient, i.unit, SUM(u.amount_used) AS total_used
		FROM ingredient_usage u
		JOIN ingredients i ON u.ingredient_id = i.id
		GROUP BY u.ingredient_id
		ORDER BY total_used DESC;
	`;

	db.query(sql, (err, results) => {
		if (err) {
			console.error("❌ Error fetching ingredient usage report:", err);
			return res.status(500).json({ success: false, message: "Database error" });
		}
		res.json(results);
	});
});



app.get('/ingredients/:id/deductions', (req, res) => {
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
		WHERE u.ingredient_id = ?
		ORDER BY u.created_at DESC
	`;

	db.query(sql, [id], (err, results) => {
		if (err) {
			console.error("❌ Error fetching deductions:", err);
			return res.status(500).json({ success: false, message: "Database error" });
		}
		res.json(results);
	});
});











// 🔹 Restock (additions)
app.get('/ingredients/:id/additions', (req, res) => {
	const { id } = req.params;
	const sql = `
		SELECT date, source, amount
		FROM ingredient_additions
		WHERE ingredient_id = ?
		ORDER BY date DESC
	`;
	db.query(sql, [id], (err, results) => {
		if (err) {
			console.error("❌ Error fetching additions:", err);
			return res.status(500).json({ success: false, message: "Database error" });
		}
		res.json(results);
	});
});

app.get('/best-sellers', async (req, res) => {
	try {
		const { month, year, lastMonth, category } = req.query; // optional
		const conn = db.promise();

		// Determine target month/year
		let target = new Date();
		if (String(lastMonth).toLowerCase() === 'true') {
			// go to previous month
			target.setMonth(target.getMonth() - 1);
		}
		const m = month ? Number(month) : (target.getMonth() + 1); // 1-12
		const y = year ? Number(year) : target.getFullYear();

		let sql = `
			SELECT p.id, p.name, SUM(si.quantity) AS total_sold
			FROM sale_items si
			JOIN sales s ON s.id = si.sale_id
			JOIN products p ON p.id = si.product_id
			WHERE YEAR(s.created_at) = ? AND MONTH(s.created_at) = ?
		`;
		const params = [y, m];

		// Add category filter if provided
		if (category && category.trim()) {
			sql += ` AND p.category = ?`;
			params.push(category.trim());
		}

		sql += `
			GROUP BY p.id
			ORDER BY total_sold DESC
			LIMIT 10
		`;

		const [rows] = await conn.query(sql, params);
		return res.json({ month: m, year: y, items: rows });
	} catch (err) {
		console.error('❌ best-sellers error:', err && (err.sqlMessage || err.message) || err);
		return res.status(500).json({ success: false, message: 'Failed to fetch best sellers' });
	}
});

// Dashboard summary: total sales today, low-stock count, best seller today
app.get('/dashboard-summary', async (req, res) => {
    try {
        const conn = db.promise();

        // Total sales amount today
        const [salesRows] = await conn.query(
            'SELECT IFNULL(SUM(total_amount), 0) AS total FROM sales WHERE DATE(created_at) = CURDATE()'
        );
        const totalSalesToday = Number(salesRows[0]?.total || 0);

        // Low stock products (computed stock <= 5)
        const [lowRows] = await conn.query(`
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
        const lowStockCount = Number(lowRows[0]?.cnt || 0);

        // Best seller today
        const [bestRows] = await conn.query(`
            SELECT p.id, p.name, SUM(si.quantity) AS total_sold
            FROM sale_items si
            JOIN sales s ON s.id = si.sale_id
            JOIN products p ON p.id = si.product_id
            WHERE DATE(s.created_at) = CURDATE()
            GROUP BY p.id
            ORDER BY total_sold DESC
            LIMIT 1
        `);
        const bestSeller = bestRows && bestRows.length > 0 ? {
            id: bestRows[0].id,
            name: bestRows[0].name,
            total_sold: Number(bestRows[0].total_sold || 0),
        } : null;

        return res.json({
            totalSalesToday,
            lowStockCount,
            bestSeller,
        });
    } catch (err) {
        console.error('❌ dashboard-summary error:', err && (err.sqlMessage || err.message) || err);
        return res.status(500).json({ success: false, message: 'Failed to fetch dashboard summary' });
    }
});

app.get('/sales-trend', async (req, res) => {
	const { period, productId } = req.query; // period: day|week|month, optional productId
	try {
		const conn = db.promise();

		let where = '';
		let selectTime = '';
		let groupBy = '';
		let orderBy = '';
		const params = [];

		if (period === 'day') {
			// Today grouped by hour
			where = 'WHERE DATE(s.created_at) = CURDATE()';
			selectTime = 'HOUR(s.created_at) AS bucket';
			groupBy = 'GROUP BY HOUR(s.created_at)';
			orderBy = 'ORDER BY HOUR(s.created_at) ASC';
		} else if (period === 'week') {
			// Last 7 days grouped by date
			where = 'WHERE s.created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)';
			selectTime = 'DATE(s.created_at) AS bucket';
			groupBy = 'GROUP BY DATE(s.created_at)';
			orderBy = 'ORDER BY DATE(s.created_at) ASC';
		} else {
			// month (default): last 30 days grouped by date
			where = 'WHERE s.created_at >= DATE_SUB(CURDATE(), INTERVAL 29 DAY)';
			selectTime = 'DATE(s.created_at) AS bucket';
			groupBy = 'GROUP BY DATE(s.created_at)';
			orderBy = 'ORDER BY DATE(s.created_at) ASC';
		}

		let productFilter = '';
		if (productId) {
			productFilter = ' AND si.product_id = ?';
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

		const [rows] = await conn.query(sql, params);

		// Map rows to labels and values
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
		console.error('❌ sales-trend error:', err && (err.sqlMessage || err.message) || err);
		return res.status(500).json({ success: false, message: 'Trend fetch failed' });
	}
});









// ✅ Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
});