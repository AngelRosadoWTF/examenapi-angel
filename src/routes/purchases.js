// src/routes/purchases.js
const express = require('express');
const pool = require('../db');
const router = express.Router();
const { validateBasic, MAX_TOTAL } = require('../helpers/validatePurchase');

async function getProduct(conn, productId) {
  const [rows] = await conn.query('SELECT * FROM products WHERE id = ?', [productId]);
  return rows[0];
}

// POST /api/purchases
router.post('/', async (req, res) => {
  const payload = req.body;
  try {
    validateBasic(payload, true);

    // calcular subtotales y total
    let total = 0;
    for (const d of payload.details) {
      if (!d.product_id || !d.quantity || !d.price) throw new Error('Cada detalle requiere product_id, quantity y price');
      if (d.quantity <= 0) throw new Error('quantity debe ser > 0');
      const subtotal = Number((d.quantity * d.price).toFixed(2));
      total += subtotal;
    }
    if (total > MAX_TOTAL) throw new Error(`El total de la compra no puede pasar de ${MAX_TOTAL}`);
    
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // chequear stock para cada item
      for (const d of payload.details) {
        const product = await getProduct(conn, d.product_id);
        if (!product) throw new Error(`Producto ${d.product_id} no existe`);
        if (product.stock < d.quantity) throw new Error(`Stock insuficiente para producto ${product.id} (${product.name})`);
      }

      // insertar purchase
      const [resInsert] = await conn.query(
        'INSERT INTO purchases (user_id, total, status) VALUES (?, ?, ?)',
        [payload.user_id, total, payload.status]
      );
      const purchaseId = resInsert.insertId;

      // insertar detalles y descontar stock
      for (const d of payload.details) {
        const subtotal = Number((d.quantity * d.price).toFixed(2));
        await conn.query(
          'INSERT INTO purchase_details (purchase_id, product_id, quantity, price, subtotal) VALUES (?, ?, ?, ?, ?)',
          [purchaseId, d.product_id, d.quantity, d.price, subtotal]
        );
        // descontar stock
        await conn.query('UPDATE products SET stock = stock - ? WHERE id = ?', [d.quantity, d.product_id]);
      }

      await conn.commit();
      res.status(201).json({ id: purchaseId, message: 'Purchase created' });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /api/purchases/:id
router.put('/:id', async (req, res) => {
  const id = req.params.id;
  const payload = req.body;
  try {
    validateBasic(payload, false);

    const conn = await pool.getConnection();
    try {
      // check existing purchase
      const [pRows] = await conn.query('SELECT * FROM purchases WHERE id = ?', [id]);
      const purchase = pRows[0];
      if (!purchase) return res.status(404).json({ error: 'Purchase no encontrada' });
      if (purchase.status === 'COMPLETED') return res.status(400).json({ error: 'No se puede modificar una compra COMPLETED' });

      await conn.beginTransaction();

      // si vienen detalles: validar stock teniendo en cuenta que hay que "devolver" el stock actual primero
      if (payload.details) {
        // devolver stock actual (sumar back)
        const [currentDetails] = await conn.query('SELECT * FROM purchase_details WHERE purchase_id = ?', [id]);
        for (const cd of currentDetails) {
          await conn.query('UPDATE products SET stock = stock + ? WHERE id = ?', [cd.quantity, cd.product_id]);
        }

        // chequear stock para nuevos detalles
        for (const d of payload.details) {
          const product = await getProduct(conn, d.product_id);
          if (!product) throw new Error(`Producto ${d.product_id} no existe`);
          if (product.stock < d.quantity) throw new Error(`Stock insuficiente para producto ${product.id} (${product.name})`);
        }
      }

      // calcular nuevo total (si details present) o mantener el mismo
      let total = purchase.total;
      if (payload.details) {
        total = 0;
        for (const d of payload.details) {
          const subtotal = Number((d.quantity * d.price).toFixed(2));
          total += subtotal;
        }
        if (total > MAX_TOTAL) throw new Error(`El total de la compra no puede pasar de ${MAX_TOTAL}`);
        if (payload.details.length < 1) throw new Error('Debe haber al menos 1 producto en la compra');
        if (payload.details.length > 5) throw new Error('No se pueden guardar más de 5 productos por compra');
      }

      // update purchase row (user_id/status/total/updated_at)
      const newUserId = payload.user_id ?? purchase.user_id;
      const newStatus = payload.status ?? purchase.status;
      await conn.query(
        'UPDATE purchases SET user_id = ?, status = ?, total = ?, updated_at = NOW() WHERE id = ?',
        [newUserId, newStatus, total, id]
      );

      if (payload.details) {
        // delete old details (ON DELETE CASCADE no aplica por update)
        await conn.query('DELETE FROM purchase_details WHERE purchase_id = ?', [id]);
        // insert new details and descontar stock
        for (const d of payload.details) {
          const subtotal = Number((d.quantity * d.price).toFixed(2));
          await conn.query(
            'INSERT INTO purchase_details (purchase_id, product_id, quantity, price, subtotal) VALUES (?, ?, ?, ?, ?)',
            [id, d.product_id, d.quantity, d.price, subtotal]
          );
          // descontar stock
          await conn.query('UPDATE products SET stock = stock - ? WHERE id = ?', [d.quantity, d.product_id]);
        }
      }

      await conn.commit();
      res.json({ message: 'Purchase updated' });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/purchases/:id
router.delete('/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const conn = await pool.getConnection();
    try {
      const [pRows] = await conn.query('SELECT * FROM purchases WHERE id = ?', [id]);
      const purchase = pRows[0];
      if (!purchase) return res.status(404).json({ error: 'Purchase no encontrada' });
      if (purchase.status === 'COMPLETED') return res.status(400).json({ error: 'No se puede borrar una compra COMPLETED' });

      await conn.beginTransaction();

      // devolver stock
      const [details] = await conn.query('SELECT * FROM purchase_details WHERE purchase_id = ?', [id]);
      for (const d of details) {
        await conn.query('UPDATE products SET stock = stock + ? WHERE id = ?', [d.quantity, d.product_id]);
      }

      // borrar purchase (purchase_details se borrarán por FK ON DELETE CASCADE)
      await conn.query('DELETE FROM purchases WHERE id = ?', [id]);

      await conn.commit();
      res.json({ message: 'Purchase deleted' });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/purchases  -> traer todas con joins
router.get('/', async (req, res) => {
  try {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(`
        SELECT p.id, p.user_id, u.name as user, p.total, p.status, p.purchase_date
        FROM purchases p
        JOIN users u ON u.id = p.user_id
        ORDER BY p.id DESC
      `);

      const purchaseIds = rows.map(r => r.id);
      let details = [];
      if (purchaseIds.length) {
        const [drows] = await conn.query(`
          SELECT pd.id, pd.purchase_id, pd.product_id, prod.name as product, pd.quantity, pd.price, pd.subtotal
          FROM purchase_details pd
          JOIN products prod ON prod.id = pd.product_id
          WHERE pd.purchase_id IN (?)
        `, [purchaseIds]);
        details = drows;
      }

      // map details into purchases
      const result = rows.map(r => ({
        id: r.id,
        user: r.user,
        total: Number(r.total),
        status: r.status,
        purchase_date: r.purchase_date,
        details: details.filter(d => d.purchase_id === r.id).map(d => ({
          id: d.id,
          product: d.product,
          quantity: d.quantity,
          price: Number(d.price),
          subtotal: Number(d.subtotal)
        }))
      }));

      res.json(result);
    } finally {
      conn.release();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/purchases/:id
router.get('/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(`
        SELECT p.id, p.user_id, u.name as user, p.total, p.status, p.purchase_date
        FROM purchases p
        JOIN users u ON u.id = p.user_id
        WHERE p.id = ?
      `, [id]);
      const purchase = rows[0];
      if (!purchase) return res.status(404).json({ error: 'Purchase no encontrada' });

      const [drows] = await conn.query(`
        SELECT pd.id, pd.purchase_id, pd.product_id, prod.name as product, pd.quantity, pd.price, pd.subtotal
        FROM purchase_details pd
        JOIN products prod ON prod.id = pd.product_id
        WHERE pd.purchase_id = ?
      `, [id]);

      const result = {
        id: purchase.id,
        user: purchase.user,
        total: Number(purchase.total),
        status: purchase.status,
        purchase_date: purchase.purchase_date,
        details: drows.map(d => ({
          id: d.id,
          product: d.product,
          quantity: d.quantity,
          price: Number(d.price),
          subtotal: Number(d.subtotal)
        }))
      };
      res.json(result);
    } finally {
      conn.release();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
