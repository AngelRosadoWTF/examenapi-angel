// src/helpers/validatePurchase.js
const MAX_ITEMS = 5;
const MAX_TOTAL = 3500;

function validateBasic(purchase, isPost = true) {
  // purchase: { user_id, status, details: [{product_id,quantity,price}, ...] }
  if (isPost) {
    if (!purchase.user_id) throw new Error('user_id es obligatorio');
    if (!purchase.status) throw new Error('status es obligatorio');
    if (!Array.isArray(purchase.details)) throw new Error('details es obligatorio');
  }

  if (purchase.details) {
    if (purchase.details.length < 1) throw new Error('Debe haber al menos 1 producto en la compra');
    if (purchase.details.length > MAX_ITEMS) throw new Error(`No se pueden guardar más de ${MAX_ITEMS} productos por compra`);
  }
}

module.exports = { validateBasic, MAX_TOTAL };
