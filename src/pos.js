// 知华科技（上海如静知华信息科技有限公司）｜https://www.zhuatech.cn/｜商业咨询微信：zhuatech、zhuatech2
import { randomBytes, createHash } from 'node:crypto';
import { hashPassword, verifyPassword, transaction } from './db.js';

/** 可向门店界面返回的业务错误；商业咨询：zhuatech / zhuatech2。 */
export class PosError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const fail = (message, status) => { throw new PosError(message, status); };
const integer = (value, name, min = 0) => {
  if (!Number.isSafeInteger(value) || value < min) fail(`${name}必须是大于等于${min}的整数`);
  return value;
};
const text = (value, name, max = 120) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(`${name}长度不正确`);
  return value.trim();
};
const audit = (db, userId, action, entityType, entityId, detail = '') => db.prepare(
  'INSERT INTO audit_events(user_id,action,entity_type,entity_id,detail) VALUES(?,?,?,?,?)'
).run(userId, action, entityType, entityId, detail);

/** 餐饮收银业务入口；私有部署和商业授权咨询：zhuatech / zhuatech2。 */
export function createPos(db) {
  const getOrder = (id) => {
    const order = db.prepare(`SELECT o.*, t.name AS table_name, p.method AS payment_method,
      p.tendered_cents, p.change_cents, p.external_reference, p.refunded_at, p.refund_reference,
      receiver.username AS received_by_name, refunder.username AS refunded_by_name
      FROM orders o LEFT JOIN dining_tables t ON t.id=o.table_id
      LEFT JOIN payments p ON p.order_id=o.id
      LEFT JOIN users receiver ON receiver.id=p.received_by
      LEFT JOIN users refunder ON refunder.id=p.refunded_by WHERE o.id=?`).get(id);
    if (!order) fail('订单不存在', 404);
    const items = db.prepare(`SELECT *, (quantity-void_quantity-split_quantity)*price_cents AS line_cents
      FROM order_items WHERE order_id=? ORDER BY id`).all(id);
    const subtotal = items.reduce((sum, item) => sum + item.line_cents, 0);
    return { ...order, items, subtotal_cents: subtotal, due_cents: Math.max(0, subtotal - order.discount_cents) };
  };
  const checkRevision = (order, expected) => {
    if (expected !== undefined && order.revision !== expected)
      fail('订单已由其他员工更新，请核对最新账单后重试', 409);
    return order;
  };
  const openOrder = (id, expected) => {
    const order = getOrder(id);
    if (order.status !== 'OPEN') fail('订单已结账或作废，不能继续修改', 409);
    return checkRevision(order, expected);
  };
  const bumpOrder = (id) => db.prepare('UPDATE orders SET revision=revision+1 WHERE id=?').run(id);
  const openOrdersSummary = () => {
    const rows = db.prepare(`SELECT o.id,o.revision,o.discount_cents,
      COALESCE(SUM((i.quantity-i.void_quantity-i.split_quantity)*i.price_cents),0) AS subtotal_cents
      FROM orders o LEFT JOIN order_items i ON i.order_id=o.id
      WHERE o.status='OPEN' GROUP BY o.id ORDER BY o.id`).all();
    return { open_order_count: rows.length,
      open_order_due_cents: rows.reduce((sum, row) => sum + Math.max(0, row.subtotal_cents - row.discount_cents), 0),
      open_order_fingerprint: createHash('sha256').update(rows.map((row) => `${row.id}:${row.revision}`).join('|')).digest('hex') };
  };
  const currentShift = (userId) => {
    const shift = db.prepare(`SELECT s.*,u.username AS opened_by_name FROM shifts s
      JOIN users u ON u.id=s.user_id WHERE s.closed_at IS NULL`).get();
    if (!shift) return null;
    const received = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) AS total FROM payments
      WHERE shift_id=? AND method='CASH'`).get(shift.id).total;
    const refunded = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) AS total FROM payments
      WHERE refund_shift_id=? AND method='CASH'`).get(shift.id).total;
    const movements = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN type='IN' THEN amount_cents ELSE 0 END),0) AS in_cents,
      COALESCE(SUM(CASE WHEN type='OUT' THEN amount_cents ELSE 0 END),0) AS out_cents
      FROM cash_movements WHERE shift_id=?`).get(shift.id);
    const role = db.prepare('SELECT role FROM users WHERE id=?').get(userId)?.role;
    return { ...shift, ...openOrdersSummary(), can_close: shift.user_id === userId || ['ADMIN','MANAGER'].includes(role),
      cash_received_cents: received, cash_refunded_cents: refunded,
      cash_in_cents: movements.in_cents, cash_out_cents: movements.out_cents,
      expected_cash_cents: shift.opening_cash_cents + received - refunded + movements.in_cents - movements.out_cents };
  };
  const requireShift = (userId) => currentShift(userId) || fail('请先开班', 409);
  const menu = () => ({
    categories: db.prepare('SELECT * FROM categories ORDER BY sort_order,id').all(),
    items: db.prepare('SELECT * FROM menu_items ORDER BY sort_order,id').all(),
    tables: db.prepare(`SELECT t.*, EXISTS(SELECT 1 FROM orders o WHERE o.table_id=t.id AND o.status='OPEN') AS occupied
      FROM dining_tables t ORDER BY t.name`).all(),
  });
  return {
    menu,
    listUsers: () => db.prepare('SELECT id,username,role,active,created_at FROM users ORDER BY id').all(),
    changePassword(userId, input) {
      return transaction(db, () => {
        const user = db.prepare('SELECT salt,password_hash FROM users WHERE id=?').get(userId);
        if (!user || typeof input.current_password !== 'string' ||
          !verifyPassword(input.current_password, user.salt, user.password_hash)) fail('当前密码不正确', 403);
        const password = text(input.new_password, '新密码', 200);
        if (password.length < 12) fail('新密码至少 12 位');
        if (verifyPassword(password, user.salt, user.password_hash)) fail('新密码不能与当前密码相同');
        const { salt, hash } = hashPassword(password);
        db.prepare('UPDATE users SET salt=?,password_hash=? WHERE id=?').run(salt, hash, userId);
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
        audit(db, userId, 'CHANGE_PASSWORD', 'USER', userId);
        return { ok: true };
      });
    },
    createUser(userId, input) {
      const username = text(input.username, '用户名', 40);
      const password = text(input.password, '密码', 200);
      if (password.length < 12) fail('密码至少 12 位');
      if (!['ADMIN','MANAGER','CASHIER','KITCHEN'].includes(input.role)) fail('角色不正确');
      const { salt, hash } = hashPassword(password);
      try {
        const id = db.prepare('INSERT INTO users(username,salt,password_hash,role) VALUES(?,?,?,?)')
          .run(username, salt, hash, input.role).lastInsertRowid;
        audit(db, userId, 'CREATE_USER', 'USER', id);
        return { id: Number(id), username, role: input.role };
      } catch (error) {
        if (String(error).includes('UNIQUE')) fail('用户名已存在', 409);
        throw error;
      }
    },
    updateUser(userId, targetId, input) {
      return transaction(db, () => {
        const user = db.prepare('SELECT id,username,role,active FROM users WHERE id=?').get(integer(targetId, '员工', 1));
        if (!user) fail('员工不存在', 404);
        const role = input.role ?? user.role;
        const active = input.active === undefined ? user.active : (input.active === true || input.active === 1 ? 1 : 0);
        if (!['ADMIN','MANAGER','CASHIER','KITCHEN'].includes(role)) fail('角色不正确');
        if (targetId === userId && (!active || role !== 'ADMIN')) fail('不能停用自己或移除自己的管理员角色', 409);
        if (user.role === 'ADMIN' && (role !== 'ADMIN' || !active) &&
          db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='ADMIN' AND active=1").get().count <= 1) fail('必须保留一名启用的管理员', 409);
        if (input.password !== undefined) {
          const password = text(input.password, '新密码', 200);
          if (password.length < 12) fail('密码至少 12 位');
          const { salt, hash } = hashPassword(password);
          db.prepare('UPDATE users SET salt=?,password_hash=? WHERE id=?').run(salt, hash, targetId);
        }
        db.prepare('UPDATE users SET role=?,active=? WHERE id=?').run(role, active, targetId);
        if (!active || input.password !== undefined || role !== user.role) db.prepare('DELETE FROM sessions WHERE user_id=?').run(targetId);
        audit(db, userId, 'UPDATE_USER', 'USER', targetId);
        return db.prepare('SELECT id,username,role,active FROM users WHERE id=?').get(targetId);
      });
    },
    addCategory(userId, input) {
      const name = text(input.name, '分类', 50);
      try {
        const id = db.prepare('INSERT INTO categories(name) VALUES(?)').run(name).lastInsertRowid;
        audit(db, userId, 'ADD_CATEGORY', 'CATEGORY', id);
        return { id: Number(id), name };
      } catch (error) {
        if (String(error).includes('UNIQUE')) fail('分类已存在', 409);
        throw error;
      }
    },
    updateCategory(userId, id, input) {
      integer(id, '分类', 1);
      const category = db.prepare('SELECT * FROM categories WHERE id=?').get(id);
      if (!category) fail('分类不存在', 404);
      const name = text(input.name, '分类', 50);
      if (input.active !== undefined && ![0, 1, true, false].includes(input.active)) fail('分类状态不正确');
      const active = input.active === undefined ? category.active : (input.active === true || input.active === 1 ? 1 : 0);
      try {
        db.prepare('UPDATE categories SET name=?,active=? WHERE id=?').run(name, active, id);
        audit(db, userId, 'UPDATE_CATEGORY', 'CATEGORY', id);
        return db.prepare('SELECT * FROM categories WHERE id=?').get(id);
      } catch (error) {
        if (String(error).includes('UNIQUE')) fail('分类已存在', 409);
        throw error;
      }
    },
    addMenuItem(userId, input) {
      const categoryId = integer(input.category_id, '分类', 1);
      const name = text(input.name, '菜名', 80);
      const price = integer(input.price_cents, '价格');
      if (!db.prepare('SELECT id FROM categories WHERE id=?').get(categoryId)) fail('分类不存在');
      const id = db.prepare('INSERT INTO menu_items(category_id,name,price_cents) VALUES(?,?,?)')
        .run(categoryId, name, price).lastInsertRowid;
      audit(db, userId, 'ADD_ITEM', 'MENU_ITEM', id);
      return { id: Number(id), category_id: categoryId, name, price_cents: price };
    },
    updateMenuItem(userId, id, input) {
      integer(id, '菜品', 1);
      if (!db.prepare('SELECT id FROM menu_items WHERE id=?').get(id)) fail('菜品不存在', 404);
      const categoryId = integer(input.category_id, '分类', 1);
      if (!db.prepare('SELECT id FROM categories WHERE id=?').get(categoryId)) fail('分类不存在');
      const name = text(input.name, '菜名', 80);
      const price = integer(input.price_cents, '价格');
      if (![0, 1, true, false].includes(input.active)) fail('销售状态不正确');
      const active = input.active === true || input.active === 1 ? 1 : 0;
      db.prepare('UPDATE menu_items SET category_id=?,name=?,price_cents=?,active=? WHERE id=?')
        .run(categoryId, name, price, active, id);
      audit(db, userId, 'UPDATE_ITEM', 'MENU_ITEM', id);
      return db.prepare('SELECT * FROM menu_items WHERE id=?').get(id);
    },
    addTable(userId, input) {
      const name = text(input.name, '桌号', 30);
      try {
        const id = db.prepare('INSERT INTO dining_tables(name) VALUES(?)').run(name).lastInsertRowid;
        audit(db, userId, 'ADD_TABLE', 'TABLE', id);
        return { id: Number(id), name };
      } catch (error) {
        if (String(error).includes('UNIQUE')) fail('桌号已存在', 409);
        throw error;
      }
    },
    updateTable(userId, id, input) {
      try {
        return transaction(db, () => {
          const table = db.prepare('SELECT * FROM dining_tables WHERE id=?').get(integer(id, '桌台', 1));
          if (!table) fail('桌台不存在', 404);
          if (input.active !== undefined && ![0, 1, true, false].includes(input.active)) fail('桌台状态不正确');
          const active = input.active === undefined ? table.active : (input.active === true || input.active === 1 ? 1 : 0);
          const name = input.name === undefined ? table.name : text(input.name, '桌号', 30);
          if (!active && db.prepare("SELECT id FROM orders WHERE table_id=? AND status='OPEN'").get(id)) fail('有未结订单，不能停用桌台', 409);
          db.prepare('UPDATE dining_tables SET name=?,active=? WHERE id=?').run(name, active, id);
          audit(db, userId, 'UPDATE_TABLE', 'TABLE', id, `${name}:${active ? '启用' : '停用'}`);
          return db.prepare('SELECT * FROM dining_tables WHERE id=?').get(id);
        });
      } catch (error) {
        if (String(error).includes('UNIQUE')) fail('桌号已存在', 409);
        throw error;
      }
    },
    getOrder,
    listOrders(status = 'OPEN') {
      if (!['OPEN','PAID','VOIDED','REFUNDED','ALL'].includes(status)) fail('订单状态不正确');
      const rows = status === 'ALL'
        ? db.prepare('SELECT id FROM orders ORDER BY id DESC LIMIT 100').all()
        : db.prepare('SELECT id FROM orders WHERE status=? ORDER BY id DESC LIMIT 100').all(status);
      return rows.map((row) => getOrder(row.id));
    },
    createOrder(userId, input) {
      const channel = input.channel;
      if (!['DINE_IN','TAKEAWAY'].includes(channel)) fail('订单类型不正确');
      return transaction(db, () => {
        let tableId = null;
        if (channel === 'DINE_IN') {
          tableId = integer(input.table_id, '桌台', 1);
          if (!db.prepare('SELECT id FROM dining_tables WHERE id=? AND active=1').get(tableId)) fail('桌台不存在');
          if (db.prepare("SELECT id FROM orders WHERE table_id=? AND status='OPEN'").get(tableId)) fail('桌台已有未结订单', 409);
        }
        const number = `POS-${Date.now()}-${randomBytes(3).toString('hex').toUpperCase()}`;
        const id = db.prepare('INSERT INTO orders(number,channel,table_id,created_by) VALUES(?,?,?,?)')
          .run(number, channel, tableId, userId).lastInsertRowid;
        audit(db, userId, 'CREATE_ORDER', 'ORDER', id);
        return getOrder(Number(id));
      });
    },
    moveTable(userId, orderId, input) {
      return transaction(db, () => {
        const order = openOrder(orderId, input.expected_revision);
        if (order.channel !== 'DINE_IN') fail('只有堂食订单可以换桌', 409);
        const tableId = integer(input.table_id, '桌台', 1);
        if (tableId === order.table_id) return order;
        if (!db.prepare('SELECT id FROM dining_tables WHERE id=? AND active=1').get(tableId)) fail('目标桌台不存在');
        if (db.prepare("SELECT id FROM orders WHERE table_id=? AND status='OPEN'").get(tableId)) fail('目标桌台已有未结订单', 409);
        db.prepare('UPDATE orders SET table_id=? WHERE id=?').run(tableId, orderId);
        bumpOrder(orderId);
        audit(db, userId, 'MOVE_TABLE', 'ORDER', orderId, `${order.table_id}→${tableId}`);
        return getOrder(orderId);
      });
    },
    addItem(userId, orderId, input) {
      return transaction(db, () => {
        openOrder(orderId, input.expected_revision);
        const menuItem = db.prepare(`SELECT m.* FROM menu_items m JOIN categories c ON c.id=m.category_id
          WHERE m.id=? AND m.active=1 AND c.active=1`)
          .get(integer(input.menu_item_id, '菜品', 1));
        if (!menuItem) fail('菜品不存在或已下架');
        const quantity = integer(input.quantity, '数量', 1);
        if (quantity > 99) fail('单次加菜不能超过 99 份');
        const note = input.note == null ? '' : String(input.note).trim();
        if (note.length > 120) fail('备注过长');
        const existing = db.prepare(`SELECT id,quantity FROM order_items WHERE order_id=? AND menu_item_id=?
          AND name_snapshot=? AND price_cents=? AND note=? AND sent_quantity=0 AND void_quantity=0 AND split_quantity=0
          ORDER BY id DESC LIMIT 1`).get(orderId, menuItem.id, menuItem.name, menuItem.price_cents, note);
        let id;
        if (existing && existing.quantity + quantity <= 999) {
          db.prepare('UPDATE order_items SET quantity=quantity+? WHERE id=?').run(quantity, existing.id);
          id = existing.id;
        } else {
          id = db.prepare(`INSERT INTO order_items(order_id,menu_item_id,name_snapshot,price_cents,quantity,note)
            VALUES(?,?,?,?,?,?)`).run(orderId, menuItem.id, menuItem.name, menuItem.price_cents, quantity, note).lastInsertRowid;
        }
        audit(db, userId, 'ADD_ORDER_ITEM', 'ORDER', orderId, String(id));
        bumpOrder(orderId);
        return getOrder(orderId);
      });
    },
    sendKitchen(userId, orderId, input = {}) {
      return transaction(db, () => {
        const order = openOrder(orderId, input.expected_revision);
        const pending = order.items.map((item) => ({ ...item,
          unsent: item.quantity - item.sent_quantity - item.void_quantity - item.split_quantity
        })).filter((item) => item.unsent > 0);
        if (pending.length === 0) fail('没有待发送的菜品', 409);
        const ticketId = db.prepare("INSERT INTO kitchen_tickets(order_id,kind) VALUES(?,'NEW')")
          .run(orderId).lastInsertRowid;
        for (const item of pending) {
          db.prepare('INSERT INTO kitchen_ticket_items(ticket_id,order_item_id,quantity) VALUES(?,?,?)')
            .run(ticketId, item.id, item.unsent);
          db.prepare('UPDATE order_items SET sent_quantity=sent_quantity+? WHERE id=?').run(item.unsent, item.id);
        }
        audit(db, userId, 'SEND_KITCHEN', 'ORDER', orderId, String(ticketId));
        bumpOrder(orderId);
        return { ticket_id: Number(ticketId), order: getOrder(orderId) };
      });
    },
    updateOrderItem(userId, orderId, itemId, input) {
      return transaction(db, () => {
        const order = openOrder(orderId, input.expected_revision);
        const item = db.prepare('SELECT * FROM order_items WHERE id=? AND order_id=?').get(
          integer(itemId, '菜品行', 1), orderId);
        if (!item) fail('订单菜品不存在', 404);
        if (item.sent_quantity || item.void_quantity || item.split_quantity) fail('已送厨或已处理的菜品不能直接编辑', 409);
        const quantity = integer(input.quantity, '数量', 1);
        if (quantity > 999) fail('数量不能超过 999');
        if (typeof input.note !== 'string' || input.note.trim().length > 120) fail('备注不正确');
        if (order.subtotal_cents + (quantity - item.quantity) * item.price_cents < order.discount_cents)
          fail('请先调低整单折扣，再减少菜品', 409);
        db.prepare('UPDATE order_items SET quantity=?,note=? WHERE id=?').run(quantity, input.note.trim(), itemId);
        audit(db, userId, 'UPDATE_ORDER_ITEM', 'ORDER', orderId, String(itemId));
        bumpOrder(orderId);
        return getOrder(orderId);
      });
    },
    voidItem(userId, orderId, itemId, input) {
      return transaction(db, () => {
        openOrder(orderId, input.expected_revision);
        const item = db.prepare('SELECT * FROM order_items WHERE id=? AND order_id=?').get(itemId, orderId);
        if (!item) fail('订单菜品不存在', 404);
        const quantity = integer(input.quantity, '退菜数量', 1);
        if (quantity > item.quantity - item.void_quantity - item.split_quantity) fail('退菜数量超过剩余数量');
        const reason = text(input.reason, '退菜原因', 120);
        const unsent = item.quantity - item.sent_quantity - item.void_quantity - item.split_quantity;
        const cancelSent = Math.max(0, quantity - unsent);
        if (cancelSent && db.prepare('SELECT role FROM users WHERE id=?').get(userId)?.role === 'CASHIER') fail('已送厨菜品须由店长退菜', 403);
        db.prepare('UPDATE order_items SET void_quantity=void_quantity+?,sent_quantity=sent_quantity-? WHERE id=?')
          .run(quantity, cancelSent, itemId);
        if (getOrder(orderId).subtotal_cents < openOrder(orderId).discount_cents) fail('请先调低整单折扣，再退菜', 409);
        if (cancelSent) {
          const ticketId = db.prepare("INSERT INTO kitchen_tickets(order_id,kind) VALUES(?,'CANCEL')")
            .run(orderId).lastInsertRowid;
          db.prepare('INSERT INTO kitchen_ticket_items(ticket_id,order_item_id,quantity) VALUES(?,?,?)')
            .run(ticketId, itemId, cancelSent);
        }
        audit(db, userId, 'VOID_ITEM', 'ORDER', orderId, `${itemId}×${quantity}: ${reason}`);
        bumpOrder(orderId);
        return getOrder(orderId);
      });
    },
    setDiscount(userId, orderId, input) {
      return transaction(db, () => {
        const order = openOrder(orderId, input.expected_revision);
        const amount = integer(input.discount_cents, '折扣金额');
        if (amount > order.subtotal_cents) fail('折扣不能超过菜品金额');
        db.prepare('UPDATE orders SET discount_cents=? WHERE id=?').run(amount, orderId);
        bumpOrder(orderId);
        audit(db, userId, 'SET_DISCOUNT', 'ORDER', orderId, String(amount));
        return getOrder(orderId);
      });
    },
    splitOrder(userId, orderId, input) {
      return transaction(db, () => {
        const order = openOrder(orderId, input.expected_revision);
        const entries = Array.isArray(input.items) ? input.items : [{ item_id: input.item_id, quantity: input.quantity }];
        if (entries.length === 0 || entries.length > 50) fail('请选择要拆出的菜品');
        if (order.discount_cents !== 0) fail('请先清除原单折扣，再拆单', 409);
        const selected = new Set();
        const moves = entries.map((entry) => {
          const itemId = integer(entry.item_id, '菜品行', 1);
          if (selected.has(itemId)) fail('同一道菜不能重复选择');
          selected.add(itemId);
          const item = db.prepare('SELECT * FROM order_items WHERE id=? AND order_id=?').get(itemId, orderId);
          if (!item) fail('菜品行不存在', 404);
          const quantity = integer(entry.quantity, '拆单数量', 1);
          if (quantity > item.quantity - item.void_quantity - item.split_quantity) fail('拆单数量超过剩余数量');
          return { item, quantity };
        });
        if (moves.reduce((sum, move) => sum + move.quantity * move.item.price_cents, 0) >= order.subtotal_cents) fail('拆单后原单不能为空', 409);
        const newNumber = `POS-${Date.now()}-${randomBytes(3).toString('hex').toUpperCase()}`;
        const newId = db.prepare('INSERT INTO orders(number,channel,table_id,created_by) VALUES(?,?,?,?)')
          .run(newNumber, order.channel, order.table_id, userId).lastInsertRowid;
        const transferredTickets = new Map();
        for (const { item, quantity } of moves) {
          const sentMove = Math.min(item.sent_quantity, quantity);
          const newItemId = db.prepare(`INSERT INTO order_items(order_id,menu_item_id,name_snapshot,price_cents,quantity,sent_quantity,note)
            VALUES(?,?,?,?,?,?,?)`).run(newId, item.menu_item_id, item.name_snapshot,
            item.price_cents, quantity, sentMove, item.note).lastInsertRowid;
          // 已送厨菜品仍须留在后厨队列，拆单只迁移未完成票据中的对应数量。
          let remaining = sentMove;
          const activeLines = db.prepare(`SELECT k.id AS ticket_id,k.status,kti.quantity
            FROM kitchen_ticket_items kti JOIN kitchen_tickets k ON k.id=kti.ticket_id
            WHERE kti.order_item_id=? AND k.kind='NEW' AND k.status!='DONE'
            ORDER BY k.id DESC`).all(item.id);
          for (const line of activeLines) {
            if (!remaining) break;
            const moved = Math.min(remaining, line.quantity);
            let newTicketId = transferredTickets.get(line.ticket_id);
            if (!newTicketId) {
              newTicketId = db.prepare("INSERT INTO kitchen_tickets(order_id,kind,status) VALUES(?,'NEW',?)")
                .run(newId, line.status).lastInsertRowid;
              transferredTickets.set(line.ticket_id, newTicketId);
            }
            db.prepare('INSERT INTO kitchen_ticket_items(ticket_id,order_item_id,quantity) VALUES(?,?,?)')
              .run(newTicketId, newItemId, moved);
            if (moved === line.quantity) db.prepare('DELETE FROM kitchen_ticket_items WHERE ticket_id=? AND order_item_id=?')
              .run(line.ticket_id, item.id);
            else db.prepare('UPDATE kitchen_ticket_items SET quantity=quantity-? WHERE ticket_id=? AND order_item_id=?')
              .run(moved, line.ticket_id, item.id);
            remaining -= moved;
          }
          db.prepare('UPDATE order_items SET split_quantity=split_quantity+?,sent_quantity=sent_quantity-? WHERE id=?')
            .run(quantity, sentMove, item.id);
        }
        db.prepare(`UPDATE kitchen_tickets SET status='DONE',updated_at=CURRENT_TIMESTAMP
          WHERE kind='NEW' AND status!='DONE' AND id NOT IN
          (SELECT ticket_id FROM kitchen_ticket_items)`).run();
        audit(db, userId, 'SPLIT_ORDER', 'ORDER', orderId, `${moves.length}行→${newId}`);
        bumpOrder(orderId);
        return { original: getOrder(orderId), split: getOrder(Number(newId)) };
      });
    },
    checkout(userId, orderId, input) {
      return transaction(db, () => {
        const key = text(input.idempotency_key, '防重复收款标识', 100);
        const existing = db.prepare('SELECT order_id FROM payments WHERE idempotency_key=?').get(key);
        if (existing) {
          if (existing.order_id !== orderId) fail('收款标识已被其他订单使用', 409);
          return getOrder(orderId);
        }
        const order = openOrder(orderId, input.expected_revision);
        const shift = requireShift(userId);
        if (order.due_cents <= 0 && order.subtotal_cents <= 0) fail('空订单不能结账');
        const pending = order.items.some((item) => item.quantity - item.sent_quantity - item.void_quantity - item.split_quantity > 0);
        if (pending) fail('请先将未退菜品发送后厨', 409);
        const method = input.method;
        if (!['CASH','EXTERNAL_TERMINAL'].includes(method)) fail('收款方式不正确');
        const amount = order.due_cents;
        const tendered = integer(input.tendered_cents, '实收金额');
        const reference = method === 'EXTERNAL_TERMINAL'
          ? text(input.external_reference, '外部终端交易号', 100) : null;
        if (reference && db.prepare('SELECT id FROM payments WHERE external_reference=?').get(reference)) fail('外部终端交易号已登记', 409);
        if (method === 'CASH' && tendered < amount) fail('实收现金不足');
        if (method === 'EXTERNAL_TERMINAL' && tendered !== amount) fail('外部终端金额必须与应收一致');
        const change = method === 'CASH' ? tendered - amount : 0;
        db.prepare(`INSERT INTO payments(order_id,shift_id,method,amount_cents,tendered_cents,change_cents,external_reference,idempotency_key,received_by)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(orderId, shift.id, method, amount, tendered, change, reference, key, userId);
        db.prepare("UPDATE orders SET status='PAID',paid_total_cents=?,shift_id=?,closed_at=CURRENT_TIMESTAMP,revision=revision+1 WHERE id=?")
          .run(amount, shift.id, orderId);
        audit(db, userId, 'CHECKOUT', 'ORDER', orderId, `${method}:${amount}`);
        return getOrder(orderId);
      });
    },
    refund(userId, orderId, input) {
      return transaction(db, () => {
        const order = checkRevision(getOrder(orderId), input.expected_revision);
        if (order.status !== 'PAID') fail('只能退已结账订单', 409);
        const payment = db.prepare('SELECT * FROM payments WHERE order_id=?').get(orderId);
        const reason = text(input.reason, '退款原因', 120);
        if (payment.method === 'CASH') {
          const shift = requireShift(userId);
          db.prepare('UPDATE payments SET refunded_at=CURRENT_TIMESTAMP,refund_shift_id=?,refunded_by=? WHERE id=?')
            .run(shift.id, userId, payment.id);
        } else {
          const reference = text(input.refund_reference, '终端退款交易号', 100);
          if (db.prepare('SELECT id FROM payments WHERE refund_reference=?').get(reference)) fail('终端退款交易号已登记', 409);
          db.prepare('UPDATE payments SET refunded_at=CURRENT_TIMESTAMP,refund_reference=?,refunded_by=? WHERE id=?')
            .run(reference, userId, payment.id);
        }
        db.prepare("UPDATE orders SET status='REFUNDED',revision=revision+1 WHERE id=?").run(orderId);
        audit(db, userId, payment.method === 'CASH' ? 'REFUND_CASH' : 'RECORD_TERMINAL_REFUND', 'ORDER', orderId, reason);
        return getOrder(orderId);
      });
    },
    voidOrder(userId, orderId, input) {
      return transaction(db, () => {
        const order = openOrder(orderId, input.expected_revision);
        const reason = text(input.reason, '作废原因', 120);
        let ticketId = null;
        for (const item of order.items) {
          const remaining = item.quantity - item.void_quantity - item.split_quantity;
          const sent = Math.min(item.sent_quantity, remaining);
          if (sent > 0) {
            if (!ticketId) ticketId = db.prepare("INSERT INTO kitchen_tickets(order_id,kind) VALUES(?,'CANCEL')")
              .run(orderId).lastInsertRowid;
            db.prepare('INSERT INTO kitchen_ticket_items(ticket_id,order_item_id,quantity) VALUES(?,?,?)')
              .run(ticketId, item.id, sent);
          }
        }
        db.prepare("UPDATE kitchen_tickets SET status='DONE',updated_at=CURRENT_TIMESTAMP WHERE order_id=? AND kind='NEW' AND status!='DONE'").run(orderId);
        db.prepare("UPDATE orders SET status='VOIDED',closed_at=CURRENT_TIMESTAMP,revision=revision+1 WHERE id=?").run(orderId);
        audit(db, userId, 'VOID_ORDER', 'ORDER', orderId, reason);
        return getOrder(orderId);
      });
    },
    kitchenTickets() {
      return db.prepare(`SELECT k.*,o.number,o.channel,t.name AS table_name
        FROM kitchen_tickets k JOIN orders o ON o.id=k.order_id
        LEFT JOIN dining_tables t ON t.id=o.table_id
        WHERE k.status!='DONE' ORDER BY k.id`).all().map((ticket) => ({ ...ticket,
          items: db.prepare(`SELECT oi.name_snapshot,oi.note,kti.quantity FROM kitchen_ticket_items kti
            JOIN order_items oi ON oi.id=kti.order_item_id WHERE kti.ticket_id=?`).all(ticket.id)
        }));
    },
    updateTicket(userId, ticketId, status) {
      if (!['PREPARING','READY','DONE'].includes(status)) fail('后厨状态不正确');
      const ticket = db.prepare('SELECT * FROM kitchen_tickets WHERE id=?').get(ticketId);
      if (!ticket) fail('后厨票据不存在', 404);
      const rank = { NEW: 0, PREPARING: 1, READY: 2, DONE: 3 };
      if (rank[status] <= rank[ticket.status]) fail('后厨状态不能倒退', 409);
      db.prepare('UPDATE kitchen_tickets SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .run(status, ticketId);
      audit(db, userId, 'KITCHEN_STATUS', 'KITCHEN_TICKET', ticketId, status);
      return { ...ticket, status };
    },
    currentShift,
    shiftHistory() {
      return db.prepare(`SELECT s.*,opener.username,closer.username AS closed_by_name FROM shifts s
        JOIN users opener ON opener.id=s.user_id LEFT JOIN users closer ON closer.id=s.closed_by
        ORDER BY s.id DESC LIMIT 30`).all();
    },
    cashMovements(userId) {
      const shift = currentShift(userId);
      return shift ? db.prepare(`SELECT m.*,u.username FROM cash_movements m
        JOIN users u ON u.id=m.user_id WHERE m.shift_id=? ORDER BY m.id DESC`).all(shift.id) : [];
    },
    adjustCash(userId, input) {
      return transaction(db, () => {
        const shift = requireShift(userId);
        if (!['IN','OUT'].includes(input.type)) fail('现金收支类型不正确');
        const amount = integer(input.amount_cents, '现金金额', 1);
        const reason = text(input.reason, '收支原因', 120);
        if (input.type === 'OUT' && amount > shift.expected_cash_cents) fail('取现金额超过账面现金', 409);
        const id = db.prepare('INSERT INTO cash_movements(shift_id,user_id,type,amount_cents,reason) VALUES(?,?,?,?,?)')
          .run(shift.id, userId, input.type, amount, reason).lastInsertRowid;
        audit(db, userId, 'ADJUST_CASH', 'SHIFT', shift.id, `${input.type}:${amount}:${reason}`);
        return db.prepare('SELECT * FROM cash_movements WHERE id=?').get(id);
      });
    },
    openShift(userId, input) {
      return transaction(db, () => {
        const opening = integer(input.opening_cash_cents, '备用金');
        if (currentShift(userId)) fail('共用钱箱已有未关闭班次', 409);
        const id = db.prepare('INSERT INTO shifts(user_id,opening_cash_cents) VALUES(?,?)')
          .run(userId, opening).lastInsertRowid;
        audit(db, userId, 'OPEN_SHIFT', 'SHIFT', id);
        return currentShift(userId);
      });
    },
    closeShift(userId, input) {
      return transaction(db, () => {
        const shift = requireShift(userId);
        if (!shift.can_close) fail('只有开班人或店长可以交班', 403);
        if (input.expected_shift_id !== undefined && input.expected_shift_id !== shift.id)
          fail('钱箱已更换班次，请重新核对', 409);
        if (input.expected_cash_cents !== undefined && input.expected_cash_cents !== shift.expected_cash_cents)
          fail('钱箱余额已变化，请重新清点', 409);
        if (input.open_order_fingerprint !== undefined && input.open_order_fingerprint !== shift.open_order_fingerprint)
          fail('未结订单已变化，请重新核对', 409);
        if (shift.open_order_count && input.open_orders_ack !== true)
          fail(`仍有 ${shift.open_order_count} 笔未结订单，请确认跨班保留`, 409);
        const counted = integer(input.counted_cash_cents, '实点现金');
        const expected = shift.expected_cash_cents;
        db.prepare(`UPDATE shifts SET closed_at=CURRENT_TIMESTAMP,counted_cash_cents=?,expected_cash_cents=?,difference_cents=?,closed_by=?
          WHERE id=?`).run(counted, expected, counted - expected, userId, shift.id);
        audit(db, userId, 'CLOSE_SHIFT', 'SHIFT', shift.id, String(counted - expected));
        return db.prepare(`SELECT s.*,u.username AS closed_by_name FROM shifts s
          LEFT JOIN users u ON u.id=s.closed_by WHERE s.id=?`).get(shift.id);
      });
    },
    report() {
      const sales = db.prepare(`SELECT day,SUM(order_count) AS order_count,
        SUM(gross_cents) AS gross_cents,SUM(refunded_cents) AS refunded_cents FROM (
          SELECT date(created_at,'+8 hours') AS day,1 AS order_count,
            amount_cents AS gross_cents,0 AS refunded_cents FROM payments
          UNION ALL
          SELECT date(refunded_at,'+8 hours') AS day,0 AS order_count,
            0 AS gross_cents,amount_cents AS refunded_cents FROM payments WHERE refunded_at IS NOT NULL
        ) GROUP BY day ORDER BY day DESC LIMIT 30`).all();
      const methods = db.prepare(`SELECT method,COUNT(*) AS count,COALESCE(SUM(amount_cents),0) AS gross_cents,
        COALESCE(SUM(CASE WHEN refunded_at IS NOT NULL THEN amount_cents ELSE 0 END),0) AS refunded_cents
        FROM payments GROUP BY method`).all();
      const shifts = db.prepare(`SELECT s.*,u.username,closer.username AS closed_by_name FROM shifts s
        JOIN users u ON u.id=s.user_id LEFT JOIN users closer ON closer.id=s.closed_by
        ORDER BY s.id DESC LIMIT 30`).all();
      return { sales, methods, shifts };
    },
    auditEvents() {
      return db.prepare(`SELECT a.*,u.username FROM audit_events a LEFT JOIN users u ON u.id=a.user_id
        ORDER BY a.id DESC LIMIT 100`).all();
    }
  };
}
