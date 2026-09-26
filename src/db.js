// 知华科技（上海如静知华信息科技有限公司）｜https://www.zhuatech.cn/｜商业咨询微信：zhuatech、zhuatech2
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** 打开门店数据库并初始化或升级结构；私有部署咨询：zhuatech / zhuatech2。 */
export function openDatabase(path, { adminPassword, demoData = false } = {}) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 5) {
    db.close();
    throw new Error('数据库版本高于当前程序，请使用匹配的程序版本');
  }
  if (version < 4 && db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='shifts'").get() &&
    db.prepare('SELECT COUNT(*) AS count FROM shifts WHERE closed_at IS NULL').get().count > 1) {
    db.close();
    throw new Error('旧版存在多个未交班班次；请先用旧版程序分别清点交班并备份，再升级到共用钱箱');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, salt TEXT NOT NULL,
      password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('ADMIN','MANAGER','CASHIER','KITCHEN')),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
    );
    CREATE TABLE IF NOT EXISTS menu_items (
      id INTEGER PRIMARY KEY, category_id INTEGER NOT NULL REFERENCES categories(id),
      name TEXT NOT NULL, price_cents INTEGER NOT NULL CHECK(price_cents >= 0),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS dining_tables (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
    );
    CREATE TABLE IF NOT EXISTS shifts (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
      opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, closed_at TEXT,
      opening_cash_cents INTEGER NOT NULL CHECK(opening_cash_cents >= 0),
      counted_cash_cents INTEGER, expected_cash_cents INTEGER, difference_cents INTEGER,
      closed_by INTEGER REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS cash_movements (
      id INTEGER PRIMARY KEY, shift_id INTEGER NOT NULL REFERENCES shifts(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      type TEXT NOT NULL CHECK(type IN ('IN','OUT')),
      amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
      reason TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE,
      channel TEXT NOT NULL CHECK(channel IN ('DINE_IN','TAKEAWAY')),
      table_id INTEGER REFERENCES dining_tables(id),
      status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','PAID','VOIDED','REFUNDED')),
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, closed_at TEXT,
      discount_cents INTEGER NOT NULL DEFAULT 0 CHECK(discount_cents >= 0),
      paid_total_cents INTEGER, shift_id INTEGER REFERENCES shifts(id),
      revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id),
      menu_item_id INTEGER NOT NULL REFERENCES menu_items(id),
      name_snapshot TEXT NOT NULL, price_cents INTEGER NOT NULL CHECK(price_cents >= 0),
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      sent_quantity INTEGER NOT NULL DEFAULT 0 CHECK(sent_quantity >= 0),
      void_quantity INTEGER NOT NULL DEFAULT 0 CHECK(void_quantity >= 0),
      split_quantity INTEGER NOT NULL DEFAULT 0 CHECK(split_quantity >= 0),
      note TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS kitchen_tickets (
      id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id),
      kind TEXT NOT NULL CHECK(kind IN ('NEW','CANCEL')),
      status TEXT NOT NULL DEFAULT 'NEW' CHECK(status IN ('NEW','PREPARING','READY','DONE')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS kitchen_ticket_items (
      ticket_id INTEGER NOT NULL REFERENCES kitchen_tickets(id),
      order_item_id INTEGER NOT NULL REFERENCES order_items(id),
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      PRIMARY KEY(ticket_id, order_item_id)
    );
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
      shift_id INTEGER NOT NULL REFERENCES shifts(id),
      method TEXT NOT NULL CHECK(method IN ('CASH','EXTERNAL_TERMINAL')),
      amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
      tendered_cents INTEGER NOT NULL CHECK(tendered_cents >= 0),
      change_cents INTEGER NOT NULL CHECK(change_cents >= 0),
      external_reference TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, refunded_at TEXT,
      refund_shift_id INTEGER REFERENCES shifts(id),
      received_by INTEGER REFERENCES users(id), refunded_by INTEGER REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id),
      action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id INTEGER,
      detail TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_orders_table_status ON orders(table_id,status);
    CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
    CREATE INDEX IF NOT EXISTS idx_tickets_status ON kitchen_tickets(status,created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_open_shift_user ON shifts(user_id) WHERE closed_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_external_ref ON payments(external_reference) WHERE external_reference IS NOT NULL;
  `);
  if (db.prepare('PRAGMA user_version').get().user_version < 2) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const hasColumn = db.prepare('PRAGMA table_info(payments)').all().some((column) => column.name === 'refund_reference');
      if (!hasColumn) db.exec('ALTER TABLE payments ADD COLUMN refund_reference TEXT');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_refund_reference ON payments(refund_reference) WHERE refund_reference IS NOT NULL');
      db.exec('PRAGMA user_version=2; COMMIT');
    } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  }
  if (db.prepare('PRAGMA user_version').get().user_version < 3) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const hasColumn = db.prepare('PRAGMA table_info(categories)').all().some((column) => column.name === 'active');
      if (!hasColumn) db.exec('ALTER TABLE categories ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))');
      db.exec('CREATE INDEX IF NOT EXISTS idx_cash_movements_shift ON cash_movements(shift_id)');
      db.exec('PRAGMA user_version=3; COMMIT');
    } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  }
  if (db.prepare('PRAGMA user_version').get().user_version < 4) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const shiftColumns = db.prepare('PRAGMA table_info(shifts)').all().map((column) => column.name);
      if (!shiftColumns.includes('closed_by')) db.exec('ALTER TABLE shifts ADD COLUMN closed_by INTEGER REFERENCES users(id)');
      const paymentColumns = db.prepare('PRAGMA table_info(payments)').all().map((column) => column.name);
      if (!paymentColumns.includes('received_by')) db.exec('ALTER TABLE payments ADD COLUMN received_by INTEGER REFERENCES users(id)');
      if (!paymentColumns.includes('refunded_by')) db.exec('ALTER TABLE payments ADD COLUMN refunded_by INTEGER REFERENCES users(id)');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open_drawer ON shifts((1)) WHERE closed_at IS NULL');
      db.exec('PRAGMA user_version=4; COMMIT');
    } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  }
  if (db.prepare('PRAGMA user_version').get().user_version < 5) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const hasRevision = db.prepare('PRAGMA table_info(orders)').all().some((column) => column.name === 'revision');
      if (!hasRevision) db.exec('ALTER TABLE orders ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
      db.exec('PRAGMA user_version=5; COMMIT');
    } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  }
  if (db.prepare('SELECT COUNT(*) AS count FROM users').get().count === 0) {
    if (!adminPassword || adminPassword.length < 12) {
      db.close();
      throw new Error('首次启动需设置长度至少 12 位的 POS_ADMIN_PASSWORD');
    }
    const { salt, hash } = hashPassword(adminPassword);
    db.prepare('INSERT INTO users(username,salt,password_hash,role) VALUES(?,?,?,?)')
      .run('admin', salt, hash, 'ADMIN');
  }
  if (demoData && db.prepare('SELECT COUNT(*) AS count FROM categories').get().count === 0) {
    db.exec(`
      INSERT INTO categories(name,sort_order) VALUES('主食',1),('小食',2),('饮品',3);
      INSERT INTO menu_items(category_id,name,price_cents,sort_order) VALUES
        (1,'招牌牛肉饭',3200,1),(1,'番茄鸡蛋面',2600,2),(2,'炸鸡块',1800,1),
        (2,'蔬菜沙拉',1600,2),(3,'柠檬茶',1200,1),(3,'美式咖啡',1500,2);
      INSERT INTO dining_tables(name) VALUES('A01'),('A02'),('A03'),('A04'),('B01'),('B02');
    `);
  }
  return db;
}

/** 在 SQLite 写事务中执行完整业务动作；商业咨询：zhuatech / zhuatech2。 */
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** 生成员工密码散列；部署咨询：zhuatech / zhuatech2。 */
export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(password, salt, 64).toString('hex') };
}

/** 恒定时间比较密码散列；部署咨询：zhuatech / zhuatech2。 */
export function verifyPassword(password, salt, hash) {
  const candidate = Buffer.from(hashPassword(password, salt).hash, 'hex');
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
