// 知华科技（上海如静知华信息科技有限公司）｜https://www.zhuatech.cn/｜商业咨询微信：zhuatech、zhuatech2
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db.js';
import { createPos } from '../src/pos.js';
import { startServer } from '../src/server.js';

function fixture() {
  const db = openDatabase(':memory:', { adminPassword: 'strong-test-password', demoData: true });
  return { db, pos: createPos(db), user: 1 };
}

test('开台、价格快照、分批出厨、退菜和拆单保持金额及票据一致', () => {
  const { db, pos, user } = fixture();
  try {
    const order = pos.createOrder(user, { channel: 'DINE_IN', table_id: 1 });
    pos.addItem(user, order.id, { menu_item_id: 1, quantity: 3, note: '少辣' });
    const itemId = pos.getOrder(order.id).items[0].id;
    pos.updateMenuItem(user, 1, { category_id: 1, name: '新菜名', price_cents: 9900, active: true });
    assert.equal(pos.getOrder(order.id).subtotal_cents, 9600);
    const first = pos.sendKitchen(user, order.id);
    assert.equal(first.order.items[0].sent_quantity, 3);
    assert.throws(() => pos.sendKitchen(user, order.id), /没有待发送/);
    pos.voidItem(user, order.id, itemId, { quantity: 1, reason: '顾客取消' });
    pos.voidItem(user, order.id, itemId, { quantity: 1, reason: '顾客再次取消' });
    assert.equal(pos.getOrder(order.id).items[0].sent_quantity, 1);
    assert.equal(pos.getOrder(order.id).subtotal_cents, 3200);
    pos.addItem(user, order.id, { menu_item_id: 3, quantity: 1 });
    pos.sendKitchen(user, order.id);
    const split = pos.splitOrder(user, order.id, { item_id: itemId, quantity: 1 });
    assert.equal(split.original.subtotal_cents, 1800);
    assert.equal(split.split.subtotal_cents, 3200);
    assert.equal(split.split.items[0].sent_quantity, 1);
    assert.equal(pos.kitchenTickets().filter((ticket) => ticket.kind === 'CANCEL').length, 2);
    assert.equal(pos.menu().items[0].price_cents, 9900);
  } finally { db.close(); }
});

test('结账防重复、交班现金差额与退款跨班次核算', () => {
  const { db, pos, user } = fixture();
  try {
    const order = pos.createOrder(user, { channel: 'TAKEAWAY' });
    pos.addItem(user, order.id, { menu_item_id: 1, quantity: 1 });
    pos.sendKitchen(user, order.id);
    assert.throws(() => pos.checkout(user, order.id, { idempotency_key: 'one', method: 'CASH', tendered_cents: 3200 }), /先开班/);
    pos.openShift(user, { opening_cash_cents: 10000 });
    assert.throws(() => pos.checkout(user, order.id, { idempotency_key: 'one', method: 'CASH', tendered_cents: 3000 }), /现金不足/);
    const paid = pos.checkout(user, order.id, { idempotency_key: 'one', method: 'CASH', tendered_cents: 4000 });
    assert.equal(paid.status, 'PAID');
    assert.equal(paid.change_cents, 800);
    assert.equal(pos.checkout(user, order.id, { idempotency_key: 'one', method: 'CASH', tendered_cents: 4000 }).id, order.id);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM payments').get().count, 1);
    const closed = pos.closeShift(user, { counted_cash_cents: 13200 });
    assert.equal(closed.expected_cash_cents, 13200);
    assert.equal(closed.difference_cents, 0);
    pos.openShift(user, { opening_cash_cents: 15000 });
    pos.refund(user, order.id, { reason: '质量问题' });
    assert.equal(pos.closeShift(user, { counted_cash_cents: 11800 }).expected_cash_cents, 11800);
    assert.equal(pos.report().sales[0].refunded_cents, 3200);
  } finally { db.close(); }
});

test('外部交易号不可重复，员工停用后不可保留会话，管理员不能锁死自己', () => {
  const { db, pos, user } = fixture();
  try {
    pos.openShift(user, { opening_cash_cents: 0 });
    const paidOrder = pos.createOrder(user, { channel: 'TAKEAWAY' });
    pos.addItem(user, paidOrder.id, { menu_item_id: 1, quantity: 1 });
    pos.sendKitchen(user, paidOrder.id);
    pos.checkout(user, paidOrder.id, { idempotency_key: 'external-one', method: 'EXTERNAL_TERMINAL',
      tendered_cents: 3200, external_reference: 'terminal-reference-1' });
    const nextOrder = pos.createOrder(user, { channel: 'TAKEAWAY' });
    pos.addItem(user, nextOrder.id, { menu_item_id: 1, quantity: 1 });
    pos.sendKitchen(user, nextOrder.id);
    assert.throws(() => pos.checkout(user, nextOrder.id, { idempotency_key: 'external-two', method: 'EXTERNAL_TERMINAL',
      tendered_cents: 3200, external_reference: 'terminal-reference-1' }), /交易号已登记/);
    assert.throws(() => pos.refund(user, paidOrder.id, { reason: '外部退款' }), /终端退款交易号/);
    const refunded = pos.refund(user, paidOrder.id, { reason: '外部终端已退', refund_reference: 'refund-reference-1' });
    assert.equal(refunded.status, 'REFUNDED');
    assert.equal(refunded.refund_reference, 'refund-reference-1');
    assert.deepEqual(pos.report().methods.map(({ method, gross_cents, refunded_cents }) =>
      [method, gross_cents, refunded_cents]), [['EXTERNAL_TERMINAL', 3200, 3200]]);
    const staff = pos.createUser(user, { username: 'cashier', password: 'cashier-password-123', role: 'CASHIER' });
    db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run('fake-session', staff.id, Date.now() + 100000);
    pos.updateUser(user, staff.id, { active: 0 });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id=?').get(staff.id).count, 0);
    assert.throws(() => pos.updateUser(user, user, { active: 0 }), /不能停用自己/);
  } finally { db.close(); }
});

test('营业日报按中国标准时间跨日归集', () => {
  const { db, pos, user } = fixture();
  try {
    pos.openShift(user, { opening_cash_cents: 0 });
    const order = pos.createOrder(user, { channel: 'TAKEAWAY' });
    pos.addItem(user, order.id, { menu_item_id: 1, quantity: 1 });
    pos.sendKitchen(user, order.id);
    pos.checkout(user, order.id, { idempotency_key: 'timezone', method: 'CASH', tendered_cents: 3200 });
    db.prepare('UPDATE payments SET created_at=? WHERE order_id=?').run('2026-09-24 18:00:00', order.id);
    assert.equal(pos.report().sales[0].day, '2026-09-25');
    pos.refund(user, order.id, { reason: '隔天退单' });
    db.prepare('UPDATE payments SET refunded_at=? WHERE order_id=?').run('2026-09-25 18:00:00', order.id);
    assert.deepEqual(pos.report().sales.map((row) => [row.day, row.gross_cents, row.refunded_cents]), [
      ['2026-09-26', 0, 3200], ['2026-09-25', 3200, 0]
    ]);
  } finally { db.close(); }
});

test('门店资料可修改，使用中的桌台不可停用，重复名称有明确提示', () => {
  const { db, pos, user } = fixture();
  try {
    assert.equal(pos.updateCategory(user, 1, { name: '正餐' }).name, '正餐');
    assert.throws(() => pos.addCategory(user, { name: '正餐' }), /分类已存在/);
    assert.throws(() => pos.addTable(user, { name: 'A01' }), /桌号已存在/);
    pos.updateMenuItem(user, 1, { category_id: 2, name: '招牌饭', price_cents: 3300, active: 1 });
    assert.equal(pos.menu().items.find((item) => item.id === 1).category_id, 2);
    const order = pos.createOrder(user, { channel: 'DINE_IN', table_id: 1 });
    assert.throws(() => pos.updateTable(user, 1, { active: 0 }), /未结订单/);
    pos.voidOrder(user, order.id, { reason: '测试桌台停用' });
    assert.equal(pos.updateTable(user, 1, { active: 0 }).active, 0);
  } finally { db.close(); }
});

test('收银员可更正未送厨菜品，已送厨退菜受限，换桌与多菜拆单保持账目', () => {
  const { db, pos, user } = fixture();
  try {
    const cashier = pos.createUser(user, { username: 'cashier2', password: 'cashier-password-234', role: 'CASHIER' });
    const order = pos.createOrder(cashier.id, { channel: 'DINE_IN', table_id: 1 });
    pos.addItem(cashier.id, order.id, { menu_item_id: 1, quantity: 1 });
    pos.addItem(cashier.id, order.id, { menu_item_id: 1, quantity: 1 });
    pos.addItem(cashier.id, order.id, { menu_item_id: 2, quantity: 2 });
    assert.equal(pos.getOrder(order.id).items.length, 2);
    const [first, second] = pos.getOrder(order.id).items;
    pos.voidItem(cashier.id, order.id, first.id, { quantity: 1, reason: '点单更正' });
    assert.equal(pos.getOrder(order.id).subtotal_cents, 8400);
    pos.moveTable(cashier.id, order.id, { table_id: 2 });
    assert.equal(pos.getOrder(order.id).table_name, 'A02');
    const blocker = pos.createOrder(user, { channel: 'DINE_IN', table_id: 1 });
    assert.throws(() => pos.moveTable(cashier.id, order.id, { table_id: 1 }), /已有未结订单/);
    pos.voidOrder(user, blocker.id, { reason: '释放桌台' });
    pos.sendKitchen(cashier.id, order.id);
    assert.throws(() => pos.voidItem(cashier.id, order.id, first.id, { quantity: 1, reason: '已送厨' }), /店长退菜/);
    const split = pos.splitOrder(cashier.id, order.id, { items: [
      { item_id: first.id, quantity: 1 }, { item_id: second.id, quantity: 1 }
    ] });
    assert.equal(split.original.subtotal_cents, 2600);
    assert.equal(split.split.subtotal_cents, 5800);
    assert.equal(split.split.items.length, 2);
  } finally { db.close(); }
});

test('已送厨菜品拆单后，作废原单不会清掉新单的后厨任务', () => {
  const { db, pos, user } = fixture();
  try {
    const order = pos.createOrder(user, { channel: 'DINE_IN', table_id: 1 });
    pos.addItem(user, order.id, { menu_item_id: 1, quantity: 2 });
    pos.addItem(user, order.id, { menu_item_id: 3, quantity: 1 });
    pos.sendKitchen(user, order.id);
    const beef = pos.getOrder(order.id).items.find((item) => item.menu_item_id === 1);
    const { split } = pos.splitOrder(user, order.id, { item_id: beef.id, quantity: 1 });
    assert.equal(pos.kitchenTickets().filter((ticket) => ticket.kind === 'NEW').length, 2);
    assert.deepEqual(pos.kitchenTickets().find((ticket) => ticket.order_id === split.id).items
      .map((item) => [item.name_snapshot, item.quantity]), [['招牌牛肉饭', 1]]);
    pos.voidOrder(user, order.id, { reason: '原单取消' });
    const tickets = pos.kitchenTickets();
    assert.equal(tickets.some((ticket) => ticket.kind === 'NEW' && ticket.order_id === order.id), false);
    assert.equal(tickets.find((ticket) => ticket.kind === 'NEW').order_id, split.id);
    assert.equal(tickets.find((ticket) => ticket.kind === 'CANCEL').order_id, order.id);
  } finally { db.close(); }
});

test('旧版数据库升级后保留订单并增加共用钱箱与操作人字段', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zh-pos-migration-'));
  const path = join(dir, 'pos.sqlite');
  let db;
  try {
    db = openDatabase(path, { adminPassword: 'strong-test-password', demoData: true });
    const order = createPos(db).createOrder(1, { channel: 'TAKEAWAY' });
    db.exec(`DROP INDEX idx_payments_refund_reference;
      DROP INDEX idx_one_open_drawer;
      ALTER TABLE payments DROP COLUMN refund_reference;
      ALTER TABLE payments DROP COLUMN received_by;
      ALTER TABLE payments DROP COLUMN refunded_by;
      ALTER TABLE shifts DROP COLUMN closed_by;
      ALTER TABLE categories DROP COLUMN active;
      ALTER TABLE orders DROP COLUMN revision;
      PRAGMA user_version=1`);
    db.close();
    db = openDatabase(path);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5);
    assert.equal(createPos(db).getOrder(order.id).id, order.id);
    assert.equal(db.prepare('PRAGMA table_info(payments)').all().some((column) => column.name === 'refund_reference'), true);
    assert.equal(db.prepare('SELECT active FROM categories WHERE id=1').get().active, 1);
    assert.equal(db.prepare('PRAGMA table_info(payments)').all().some((column) => column.name === 'received_by'), true);
    assert.equal(db.prepare('PRAGMA table_info(shifts)').all().some((column) => column.name === 'closed_by'), true);
    assert.equal(createPos(db).getOrder(order.id).revision, 0);
  } finally { db?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('两个收银员共用钱箱并保留收退款人，只有开班人或店长能交班', () => {
  const { db, pos, user } = fixture();
  try {
    const first = pos.createUser(user, { username: 'cashier-a', password: 'cashier-password-a', role: 'CASHIER' });
    const second = pos.createUser(user, { username: 'cashier-b', password: 'cashier-password-b', role: 'CASHIER' });
    const shift = pos.openShift(first.id, { opening_cash_cents: 10000 });
    assert.equal(pos.currentShift(second.id).id, shift.id);
    assert.equal(pos.currentShift(second.id).can_close, false);
    assert.throws(() => pos.openShift(second.id, { opening_cash_cents: 10000 }), /已有未关闭班次/);
    const sale = (cashier, itemId, key, tendered) => {
      const order = pos.createOrder(cashier.id, { channel: 'TAKEAWAY' });
      pos.addItem(cashier.id, order.id, { menu_item_id: itemId, quantity: 1 });
      pos.sendKitchen(cashier.id, order.id);
      return pos.checkout(cashier.id, order.id, { method: 'CASH', tendered_cents: tendered, idempotency_key: key });
    };
    const orderA = sale(first, 1, 'shared-a', 4000);
    const orderB = sale(second, 3, 'shared-b', 2000);
    assert.equal(orderA.received_by_name, 'cashier-a');
    assert.equal(orderB.received_by_name, 'cashier-b');
    pos.adjustCash(second.id, { type: 'IN', amount_cents: 500, reason: '补充零钱' });
    pos.adjustCash(first.id, { type: 'OUT', amount_cents: 300, reason: '取出现金' });
    assert.deepEqual(pos.cashMovements(first.id).map((item) => item.username), ['cashier-a', 'cashier-b']);
    assert.equal(pos.currentShift(second.id).expected_cash_cents, 15200);
    assert.throws(() => pos.closeShift(second.id, { counted_cash_cents: 15200 }), /开班人或店长/);
    const closed = pos.closeShift(user, { counted_cash_cents: 15200 });
    assert.equal(closed.closed_by_name, 'admin');
    assert.equal(closed.difference_cents, 0);
    assert.equal(pos.currentShift(first.id), null);
    pos.openShift(second.id, { opening_cash_cents: 16000 });
    const refunded = pos.refund(user, orderA.id, { reason: '门店退款' });
    assert.equal(refunded.refunded_by_name, 'admin');
    assert.equal(pos.currentShift(first.id).expected_cash_cents, 12800);
    assert.equal(pos.shiftHistory(first.id)[0].username, 'cashier-b');
  } finally { db.close(); }
});

test('旧版并行个人班次须先清点，升级不会自动合并钱箱余额', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zh-pos-open-shifts-'));
  const path = join(dir, 'pos.sqlite');
  let db;
  try {
    db = openDatabase(path, { adminPassword: 'strong-test-password' });
    const cashier = createPos(db).createUser(1, { username: 'second-cashier', password: 'cashier-password-123', role: 'CASHIER' });
    db.exec('DROP INDEX idx_one_open_drawer; PRAGMA user_version=3');
    db.prepare('INSERT INTO shifts(user_id,opening_cash_cents) VALUES(?,?)').run(1, 10000);
    db.prepare('INSERT INTO shifts(user_id,opening_cash_cents) VALUES(?,?)').run(cashier.id, 20000);
    db.close(); db = null;
    assert.throws(() => openDatabase(path), /多个未交班班次/);
    db = new DatabaseSync(path);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM shifts WHERE closed_at IS NULL').get().count, 2);
    db.prepare('UPDATE shifts SET closed_at=CURRENT_TIMESTAMP,counted_cash_cents=10000,expected_cash_cents=10000,difference_cents=0 WHERE user_id=1').run();
    db.close(); db = null;
    db = openDatabase(path);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM shifts WHERE closed_at IS NULL').get().count, 1);
  } finally { db?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('空白门店完成配置、上架、开台、出厨、现金收支与交班', () => {
  const db = openDatabase(':memory:', { adminPassword: 'strong-test-password' });
  const pos = createPos(db);
  try {
    assert.deepEqual(pos.menu().categories, []);
    const cashier = pos.createUser(1, { username: 'cashier-empty', password: 'cashier-initial-123', role: 'CASHIER' });
    const category = pos.addCategory(1, { name: '热菜' });
    const item = pos.addMenuItem(1, { category_id: category.id, name: '家常炒饭', price_cents: 2800 });
    const table = pos.addTable(1, { name: 'T01' });
    pos.updateTable(1, table.id, { name: '大厅01' });
    assert.equal(pos.menu().tables[0].name, '大厅01');
    pos.updateCategory(1, category.id, { name: '热菜', active: 0 });
    const order = pos.createOrder(cashier.id, { channel: 'DINE_IN', table_id: table.id });
    assert.throws(() => pos.addItem(cashier.id, order.id, { menu_item_id: item.id, quantity: 1 }), /已下架/);
    pos.updateCategory(1, category.id, { name: '主食', active: 1 });
    pos.addItem(cashier.id, order.id, { menu_item_id: item.id, quantity: 1 });
    const lineId = pos.getOrder(order.id).items[0].id;
    pos.updateOrderItem(cashier.id, order.id, lineId, { quantity: 2, note: '不要辣' });
    pos.sendKitchen(cashier.id, order.id);
    assert.throws(() => pos.updateOrderItem(cashier.id, order.id, lineId, { quantity: 1, note: '' }), /不能直接编辑/);
    assert.equal(pos.kitchenTickets()[0].items[0].note, '不要辣');
    pos.openShift(cashier.id, { opening_cash_cents: 10000 });
    pos.adjustCash(cashier.id, { type: 'IN', amount_cents: 2000, reason: '补充备用金' });
    pos.adjustCash(cashier.id, { type: 'OUT', amount_cents: 1000, reason: '交付店长' });
    assert.throws(() => pos.adjustCash(cashier.id, { type: 'OUT', amount_cents: 20000, reason: '超额' }), /超过账面现金/);
    pos.checkout(cashier.id, order.id, { idempotency_key: 'empty-store-sale', method: 'CASH', tendered_cents: 6000 });
    assert.equal(pos.currentShift(cashier.id).expected_cash_cents, 16600);
    assert.equal(pos.cashMovements(cashier.id).length, 2);
    assert.equal(pos.closeShift(cashier.id, { counted_cash_cents: 16600 }).difference_cents, 0);
    assert.equal(pos.shiftHistory(cashier.id)[0].expected_cash_cents, 16600);
    assert.equal(pos.menu().tables[0].occupied, 0);
  } finally { db.close(); }
});

test('交班核对未结订单，订单或钱箱变化后须重新确认', () => {
  const { db, pos, user } = fixture();
  try {
    pos.openShift(user, { opening_cash_cents: 10000 });
    const order = pos.createOrder(user, { channel: 'DINE_IN', table_id: 1 });
    assert.equal(order.revision, 0);
    const first = pos.addItem(user, order.id, { menu_item_id: 1, quantity: 1 });
    assert.equal(first.revision, 1);
    const snapshot = pos.currentShift(user);
    assert.equal(snapshot.open_order_count, 1);
    assert.equal(snapshot.open_order_due_cents, 3200);
    assert.throws(() => pos.closeShift(user, { counted_cash_cents: 10000,
      expected_cash_cents: snapshot.expected_cash_cents, open_order_fingerprint: snapshot.open_order_fingerprint }), /未结订单/);
    pos.addItem(user, order.id, { menu_item_id: 3, quantity: 1 });
    assert.throws(() => pos.closeShift(user, { counted_cash_cents: 10000,open_orders_ack: true,
      expected_cash_cents: snapshot.expected_cash_cents, open_order_fingerprint: snapshot.open_order_fingerprint }), /未结订单已变化/);
    const updated = pos.currentShift(user);
    pos.adjustCash(user, { type: 'IN', amount_cents: 500, reason: '补充零钱' });
    assert.throws(() => pos.closeShift(user, { counted_cash_cents: 10500,open_orders_ack: true,
      expected_cash_cents: updated.expected_cash_cents, open_order_fingerprint: updated.open_order_fingerprint }), /钱箱余额已变化/);
    const final = pos.currentShift(user);
    const closed = pos.closeShift(user, { counted_cash_cents: 10500,open_orders_ack: true,
      expected_cash_cents: final.expected_cash_cents, open_order_fingerprint: final.open_order_fingerprint });
    assert.equal(closed.difference_cents, 0);
    assert.equal(pos.getOrder(order.id).status, 'OPEN');
    pos.openShift(user, { opening_cash_cents: 10500 });
    assert.throws(() => pos.closeShift(user, { counted_cash_cents:10500,open_orders_ack:true,
      expected_shift_id:final.id,expected_cash_cents:10500,open_order_fingerprint:final.open_order_fingerprint }), /已更换班次/);
    pos.sendKitchen(user, order.id);
    pos.checkout(user, order.id, { method: 'CASH', tendered_cents: 5000, idempotency_key: 'next-shift-order' });
    assert.equal(pos.currentShift(user).expected_cash_cents, 15500);
  } finally { db.close(); }
});

test('营业中备份可恢复订单、钱箱及员工，并继续营业', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zh-pos-recovery-'));
  const source = join(dir, 'live.sqlite');
  const backup = join(dir, 'snapshot.sqlite');
  const restored = join(dir, 'restored.sqlite');
  let db; let recovery;
  try {
    db = openDatabase(source, { adminPassword: 'strong-test-password', demoData: true });
    const pos = createPos(db);
    pos.createUser(1, { username: 'backup-cashier', password: 'cashier-backup-password', role: 'CASHIER' });
    pos.openShift(1, { opening_cash_cents: 10000 });
    const paid = pos.createOrder(1, { channel: 'TAKEAWAY' });
    pos.addItem(1, paid.id, { menu_item_id: 1, quantity: 1 });
    pos.sendKitchen(1, paid.id);
    pos.checkout(1, paid.id, { method: 'CASH', tendered_cents: 3200, idempotency_key: 'backup-paid' });
    const pending = pos.createOrder(1, { channel: 'TAKEAWAY' });
    pos.addItem(1, pending.id, { menu_item_id: 3, quantity: 1 });
    execFileSync(process.execPath, ['scripts/backup.js', backup], {
      cwd: join(import.meta.dirname, '..'), env: { ...process.env, POS_DB_PATH: source } });
    copyFileSync(backup, restored);
    recovery = openDatabase(restored);
    const resumed = createPos(recovery);
    assert.equal(recovery.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(resumed.getOrder(paid.id).status, 'PAID');
    assert.equal(resumed.getOrder(pending.id).due_cents, 1800);
    assert.equal(resumed.currentShift(1).expected_cash_cents, 13200);
    assert.equal(resumed.listUsers().some((user) => user.username === 'backup-cashier'), true);
    resumed.sendKitchen(1, pending.id);
    resumed.checkout(1, pending.id, { method: 'CASH', tendered_cents: 1800, idempotency_key: 'restored-sale' });
    assert.equal(resumed.currentShift(1).expected_cash_cents, 15000);
  } finally { recovery?.close(); db?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('两个收银会话同时修改订单时拒绝旧账单，结账重试不会重复收款', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zh-pos-concurrency-'));
  let instance;
  try {
    instance = await startServer({ port: 0, dbPath: join(dir, 'pos.sqlite'), adminPassword: 'strong-test-password', demoData: true });
    const base = `http://127.0.0.1:${instance.address.port}`;
    instance.pos.createUser(1, { username: 'cashier-two', password: 'cashier-two-password', role: 'CASHIER' });
    const session = async (username, password) => {
      const response = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({ username, password }) });
      assert.equal(response.status, 200);
      const cookie = response.headers.get('set-cookie').split(';')[0];
      const me = await (await fetch(`${base}/api/me`, { headers: { Cookie:cookie } })).json();
      return { cookie, csrf:me.csrf };
    };
    const first = await session('admin', 'strong-test-password');
    const second = await session('cashier-two', 'cashier-two-password');
    const request = (actor, path, payload) => fetch(`${base}${path}`, { method:'POST',
      headers: { Cookie:actor.cookie, 'Content-Type':'application/json', 'X-Pos-CSRF':actor.csrf }, body: JSON.stringify(payload) });
    const order = await (await request(first, '/api/orders', { channel:'TAKEAWAY' })).json();
    const path = `/api/orders/${order.id}`;
    assert.equal((await request(first, `${path}/items`, { menu_item_id:1, quantity:1 })).status, 409);
    const addFirst = await request(first, `${path}/items`, { menu_item_id:1, quantity:1, expected_revision:0 });
    assert.equal(addFirst.status, 200);
    assert.equal((await addFirst.json()).revision, 1);
    assert.equal((await request(second, `${path}/items`, { menu_item_id:3, quantity:1, expected_revision:0 })).status, 409);
    assert.equal(instance.pos.getOrder(order.id).subtotal_cents, 3200);
    assert.equal((await request(second, `${path}/items`, { menu_item_id:3, quantity:1, expected_revision:1 })).status, 200);
    assert.equal((await request(first, `${path}/send`, { expected_revision:2 })).status, 200);
    instance.pos.openShift(1, { opening_cash_cents: 0 });
    const payment = { method:'CASH', tendered_cents:5000, idempotency_key:'concurrent-pay', expected_revision:2 };
    assert.equal((await request(second, `${path}/checkout`, payment)).status, 409);
    assert.equal(instance.pos.getOrder(order.id).status, 'OPEN');
    const paid = await request(second, `${path}/checkout`, { ...payment, expected_revision:3 });
    assert.equal(paid.status, 200);
    assert.equal((await paid.json()).revision, 4);
    assert.equal((await request(second, `${path}/checkout`, { ...payment, expected_revision:3 })).status, 200);
    assert.equal(instance.db.prepare('SELECT COUNT(*) AS count FROM payments').get().count, 1);
    const drawer = await (await fetch(`${base}/api/shifts/current`, { headers: { Cookie:first.cookie } })).json();
    assert.equal((await request(first, '/api/shifts/close', { counted_cash_cents:5000 })).status, 409);
    const close = { counted_cash_cents:5000,expected_shift_id:drawer.id,
      expected_cash_cents:drawer.expected_cash_cents,open_order_fingerprint:drawer.open_order_fingerprint };
    assert.equal((await request(first, '/api/shifts/close', close)).status, 200);
    instance.pos.openShift(1, { opening_cash_cents:5000 });
    assert.equal((await request(first, '/api/shifts/close', close)).status, 409);
    assert.notEqual(instance.pos.currentShift(1).id, drawer.id);
  } finally {
    if (instance?.server.listening) await new Promise((resolve) => instance.server.close(resolve));
    rmSync(dir, { recursive:true, force:true });
  }
});

test('登录权限、CSRF 与持久化重启', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zh-pos-test-'));
  const dbPath = join(dir, 'pos.sqlite');
  let instance;
  try {
    instance = await startServer({ port: 0, dbPath, adminPassword: 'strong-test-password', demoData: true });
    const base = `http://127.0.0.1:${instance.address.port}`;
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'strong-test-password' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const me = await (await fetch(`${base}/api/me`, { headers: { Cookie: cookie } })).json();
    assert.equal(me.role, 'ADMIN');
    const noCsrf = await fetch(`${base}/api/orders`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'TAKEAWAY' }) });
    assert.equal(noCsrf.status, 403);
    const create = await fetch(`${base}/api/orders`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Pos-CSRF': me.csrf }, body: JSON.stringify({ channel: 'TAKEAWAY' }) });
    assert.equal(create.status, 200);
    const created = await create.json();
    const user = instance.pos.createUser(1, { username: 'kitchen', password: 'kitchen-password-123', role: 'KITCHEN' });
    assert.equal(user.role, 'KITCHEN');
    const kitchenLogin = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'kitchen', password: 'kitchen-password-123' }) });
    const kitchenCookie = kitchenLogin.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(`${base}/api/orders`, { headers: { Cookie: kitchenCookie } })).status, 403);
    assert.equal((await fetch(`${base}/api/menu`, { headers: { Cookie: kitchenCookie } })).status, 403);
    assert.equal((await fetch(`${base}/api/reports`, { headers: { Cookie: kitchenCookie } })).status, 403);
    const cashier = instance.pos.createUser(1, { username: 'cashier-api', password: 'cashier-test-password', role: 'CASHIER' });
    assert.equal(cashier.role, 'CASHIER');
    const cashierLogin = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'cashier-api', password: 'cashier-test-password' }) });
    const cashierCookie = cashierLogin.headers.get('set-cookie').split(';')[0];
    const cashierMe = await (await fetch(`${base}/api/me`, { headers: { Cookie: cashierCookie } })).json();
    assert.equal((await fetch(`${base}/api/reports`, { headers: { Cookie: cashierCookie } })).status, 403);
    assert.equal((await fetch(`${base}/api/kitchen/tickets`, { headers: { Cookie: cashierCookie } })).status, 403);
    assert.equal((await fetch(`${base}/api/orders/${created.id}/discount`, { method: 'POST',
      headers: { Cookie: cashierCookie, 'Content-Type': 'application/json', 'X-Pos-CSRF': cashierMe.csrf },
      body: JSON.stringify({ discount_cents: 100 }) })).status, 403);
    assert.equal((await fetch(`${base}/api/orders/${created.id}/items`, { method: 'POST',
      headers: { Cookie: cashierCookie, 'Content-Type': 'application/json', 'X-Pos-CSRF': cashierMe.csrf },
      body: JSON.stringify({ menu_item_id: 1, quantity: 1, expected_revision: created.revision }) })).status, 200);
    assert.equal((await fetch(`${base}/api/me/password`, { method: 'POST',
      headers: { Cookie: cashierCookie, 'Content-Type': 'application/json', 'X-Pos-CSRF': cashierMe.csrf },
      body: JSON.stringify({ current_password: 'wrong-password', new_password: 'cashier-new-password' }) })).status, 403);
    assert.equal((await fetch(`${base}/api/me/password`, { method: 'POST',
      headers: { Cookie: cashierCookie, 'Content-Type': 'application/json', 'X-Pos-CSRF': cashierMe.csrf },
      body: JSON.stringify({ current_password: 'cashier-test-password', new_password: 'cashier-new-password' }) })).status, 200);
    assert.equal((await fetch(`${base}/api/me`, { headers: { Cookie: cashierCookie } })).status, 401);
    assert.equal((await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'cashier-api', password: 'cashier-new-password' }) })).status, 200);
    await new Promise((resolve) => instance.server.close(resolve));
    instance = await startServer({ port: 0, dbPath });
    assert.equal(instance.pos.getOrder(created.id).number, created.number);
  } finally {
    if (instance?.server.listening) await new Promise((resolve) => instance.server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
