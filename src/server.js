// 知华科技（上海如静知华信息科技有限公司）｜https://www.zhuatech.cn/｜商业咨询微信：zhuatech、zhuatech2
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { openDatabase, verifyPassword } from './db.js';
import { createPos, PosError } from './pos.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const staticFiles = {
  '/': ['web/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['web/app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['web/style.css', 'text/css; charset=utf-8'],
  '/assets/zhuatech-logo.jpg': ['assets/zhuatech-logo.jpg', 'image/jpeg'],
};
const digest = (value) => createHash('sha256').update(value).digest('hex');
const safeHtml = (value) => String(value ?? '').replace(/[&<>"']/g,
  (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const money = (cents) => `¥${(cents / 100).toFixed(2)}`;
const localTime = (value) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(`${value.replace(' ', 'T')}Z`)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
};

async function readJson(req) {
  let body = '';
  for await (const part of req) {
    body += part;
    if (body.length > 65536) throw new PosError('请求内容过大', 413);
  }
  if (!body) return {};
  try {
    const value = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    return value;
  } catch { throw new PosError('JSON 格式不正确'); }
}
function send(res, status, value, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    ...headers,
  });
  res.end(JSON.stringify(value));
}
function getSession(db, req) {
  const cookie = req.headers.cookie?.split(';').map((entry) => entry.trim())
    .find((entry) => entry.startsWith('zh_pos_session='));
  const token = cookie?.slice('zh_pos_session='.length);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const session = db.prepare(`SELECT s.*,u.username,u.role,u.active FROM sessions s
    JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`)
    .get(digest(token), Date.now());
  return session?.active ? { ...session, token } : null;
}
function printPage(title, body) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${safeHtml(title)}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1"><style>
  body{font:14px/1.5 system-ui,sans-serif;max-width:320px;margin:24px auto;color:#17282c}
  h1{text-align:center;font-size:20px}table{width:100%;border-collapse:collapse}td{padding:3px 0;border-bottom:1px dashed #bbb}
  td:last-child{text-align:right}.total{font-size:18px;font-weight:bold}.muted{color:#57676b}
  button{padding:9px 16px;margin:16px 0}@media print{button{display:none}body{margin:0}}
  </style><h1>${safeHtml(title)}</h1>${body}<button onclick="window.print()">打印</button></html>`;
}

/** 启动可独立部署的餐饮收银服务；商业授权与设备集成咨询：zhuatech / zhuatech2。 */
export function startServer(options = {}) {
  const host = options.host ?? process.env.POS_HOST ?? '127.0.0.1';
  const port = Number(options.port ?? process.env.POS_PORT ?? 8091);
  const dbPath = options.dbPath ?? process.env.POS_DB_PATH ?? join(root, 'data/pos.sqlite');
  const db = openDatabase(dbPath, {
    adminPassword: options.adminPassword ?? process.env.POS_ADMIN_PASSWORD,
    demoData: options.demoData ?? process.env.POS_DEMO_DATA === 'true',
  });
  const pos = createPos(db);
  const csrfSecret = randomBytes(32);
  const loginAttempts = new Map();
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const path = url.pathname;
      if (req.method === 'GET' && path === '/health') return send(res, 200, { status: 'ok' });
      if (req.method === 'GET' && staticFiles[path]) {
        const [file, type] = staticFiles[path];
        res.writeHead(200, {
          'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        });
        return res.end(readFileSync(join(root, file)));
      }
      if (req.method === 'POST' && path === '/api/login') {
        const ip = req.socket.remoteAddress;
        const attempt = loginAttempts.get(ip) || { count: 0, until: 0 };
        if (attempt.until < Date.now()) { attempt.count = 0; attempt.until = Date.now() + 15 * 60_000; }
        if (attempt.count >= 10) throw new PosError('登录尝试过多，请稍后再试', 429);
        const input = await readJson(req);
        const user = typeof input.username === 'string'
          ? db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(input.username.trim()) : null;
        if (!user || typeof input.password !== 'string' || !verifyPassword(input.password, user.salt, user.password_hash)) {
          attempt.count++; loginAttempts.set(ip, attempt);
          throw new PosError('用户名或密码不正确', 401);
        }
        loginAttempts.delete(ip);
        const token = randomBytes(32).toString('hex');
        db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)')
          .run(digest(token), user.id, Date.now() + 12 * 60 * 60_000);
        const secure = process.env.POS_SECURE_COOKIE === 'true' ? '; Secure' : '';
        return send(res, 200, { id: user.id, username: user.username, role: user.role }, {
          'Set-Cookie': `zh_pos_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure}`,
        });
      }
      if (!path.startsWith('/api/') && !path.startsWith('/print/')) throw new PosError('页面不存在', 404);
      const session = getSession(db, req);
      if (!session) throw new PosError('请先登录', 401);
      const csrf = createHmac('sha256', csrfSecret).update(session.token).digest('hex');
      if (!['GET','HEAD'].includes(req.method)) {
        const provided = req.headers['x-pos-csrf'];
        if (typeof provided !== 'string' || !/^[a-f0-9]{64}$/.test(provided) ||
            !timingSafeEqual(Buffer.from(provided), Buffer.from(csrf))) throw new PosError('页面已过期，请刷新后重试', 403);
      }
      const allow = (...roles) => {
        if (!roles.includes(session.role)) throw new PosError('无权执行此操作', 403);
      };
      const id = Number(/^\/api\/(?:orders|menu\/items|kitchen\/tickets)\/(\d+)/.exec(path)?.[1]);
      const orderInput = async () => {
        const input = await readJson(req);
        if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0)
          throw new PosError('请刷新订单后重试', 409);
        return input;
      };
      let result;
      if (req.method === 'GET' && path === '/api/me') result = { id: session.user_id, username: session.username, role: session.role, csrf };
      else if (req.method === 'POST' && path === '/api/me/password') result = pos.changePassword(session.user_id, await readJson(req));
      else if (req.method === 'POST' && path === '/api/logout') {
        db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(session.token));
        return send(res, 200, { ok: true }, { 'Set-Cookie': 'zh_pos_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
      }
      else if (req.method === 'GET' && path === '/api/menu') { allow('ADMIN','MANAGER','CASHIER'); result = pos.menu(); }
      else if (req.method === 'POST' && path === '/api/menu/categories') { allow('ADMIN','MANAGER'); result = pos.addCategory(session.user_id, await readJson(req)); }
      else if (req.method === 'PUT' && /^\/api\/menu\/categories\/\d+$/.test(path)) {
        allow('ADMIN','MANAGER'); result = pos.updateCategory(session.user_id, Number(path.split('/')[4]), await readJson(req));
      }
      else if (req.method === 'POST' && path === '/api/menu/items') { allow('ADMIN','MANAGER'); result = pos.addMenuItem(session.user_id, await readJson(req)); }
      else if (req.method === 'PUT' && /^\/api\/menu\/items\/\d+$/.test(path)) { allow('ADMIN','MANAGER'); result = pos.updateMenuItem(session.user_id, id, await readJson(req)); }
      else if (req.method === 'POST' && path === '/api/tables') { allow('ADMIN','MANAGER'); result = pos.addTable(session.user_id, await readJson(req)); }
      else if (req.method === 'PUT' && /^\/api\/tables\/\d+$/.test(path)) {
        allow('ADMIN','MANAGER'); result = pos.updateTable(session.user_id, Number(path.split('/')[3]), await readJson(req));
      }
      else if (req.method === 'GET' && path === '/api/users') { allow('ADMIN'); result = pos.listUsers(); }
      else if (req.method === 'POST' && path === '/api/users') { allow('ADMIN'); result = pos.createUser(session.user_id, await readJson(req)); }
      else if (req.method === 'PUT' && /^\/api\/users\/\d+$/.test(path)) {
        allow('ADMIN'); result = pos.updateUser(session.user_id, Number(path.split('/')[3]), await readJson(req));
      }
      else if (req.method === 'GET' && path === '/api/orders') { allow('ADMIN','MANAGER','CASHIER'); result = pos.listOrders(url.searchParams.get('status') || 'OPEN'); }
      else if (req.method === 'POST' && path === '/api/orders') { allow('ADMIN','MANAGER','CASHIER'); result = pos.createOrder(session.user_id, await readJson(req)); }
      else if (req.method === 'POST' && /^\/api\/orders\/\d+\/move$/.test(path)) { allow('ADMIN','MANAGER','CASHIER'); result = pos.moveTable(session.user_id, id, await orderInput()); }
      else if (req.method === 'GET' && /^\/api\/orders\/\d+$/.test(path)) { allow('ADMIN','MANAGER','CASHIER'); result = pos.getOrder(id); }
      else if (req.method === 'POST' && /^\/api\/orders\/\d+\/items$/.test(path)) { allow('ADMIN','MANAGER','CASHIER'); result = pos.addItem(session.user_id, id, await orderInput()); }
      else if (req.method === 'PUT' && /^\/api\/orders\/\d+\/items\/\d+$/.test(path)) {
        allow('ADMIN','MANAGER','CASHIER'); result = pos.updateOrderItem(session.user_id, id, Number(path.split('/')[5]), await orderInput());
      }
      else if (req.method === 'POST' && /^\/api\/orders\/\d+\/send$/.test(path)) { allow('ADMIN','MANAGER','CASHIER'); result = pos.sendKitchen(session.user_id, id, await orderInput()); }
      else if (req.method === 'POST' && /^\/api\/orders\/\d+\/discount$/.test(path)) { allow('ADMIN','MANAGER'); result = pos.setDiscount(session.user_id, id, await orderInput()); }
      else if (req.method === 'POST' && /^\/api\/orders\/\d+\/void$/.test(path)) { allow('ADMIN','MANAGER'); result = pos.voidOrder(session.user_id, id, await orderInput()); }
      else if (req.method === 'POST' && /^\/api\/orders\/\d+\/items\/\d+\/void$/.test(path)) {
        allow('ADMIN','MANAGER','CASHIER');
        const itemId = Number(path.split('/')[5]);
        result = pos.voidItem(session.user_id, id, itemId, await orderInput());
      }
      else if (req.method === 'POST' && /^\/api\/orders\/\d+\/split$/.test(path)) { allow('ADMIN','MANAGER','CASHIER'); result = pos.splitOrder(session.user_id, id, await orderInput()); }
      else if (req.method === 'POST' && /^\/api\/orders\/\d+\/checkout$/.test(path)) { allow('ADMIN','MANAGER','CASHIER'); result = pos.checkout(session.user_id, id, await orderInput()); }
      else if (req.method === 'POST' && /^\/api\/orders\/\d+\/refund$/.test(path)) { allow('ADMIN','MANAGER'); result = pos.refund(session.user_id, id, await orderInput()); }
      else if (req.method === 'GET' && path === '/api/kitchen/tickets') { allow('ADMIN','MANAGER','KITCHEN'); result = pos.kitchenTickets(); }
      else if (req.method === 'POST' && /^\/api\/kitchen\/tickets\/\d+\/status$/.test(path)) {
        allow('ADMIN','MANAGER','KITCHEN'); result = pos.updateTicket(session.user_id, id, (await readJson(req)).status);
      }
      else if (req.method === 'GET' && path === '/api/shifts/current') { allow('ADMIN','MANAGER','CASHIER'); result = pos.currentShift(session.user_id) || null; }
      else if (req.method === 'GET' && path === '/api/shifts/history') { allow('ADMIN','MANAGER','CASHIER'); result = pos.shiftHistory(session.user_id); }
      else if (req.method === 'GET' && path === '/api/shifts/movements') { allow('ADMIN','MANAGER','CASHIER'); result = pos.cashMovements(session.user_id); }
      else if (req.method === 'POST' && path === '/api/shifts/open') { allow('ADMIN','MANAGER','CASHIER'); result = pos.openShift(session.user_id, await readJson(req)); }
      else if (req.method === 'POST' && path === '/api/shifts/cash') { allow('ADMIN','MANAGER','CASHIER'); result = pos.adjustCash(session.user_id, await readJson(req)); }
      else if (req.method === 'POST' && path === '/api/shifts/close') {
        allow('ADMIN','MANAGER','CASHIER');
        const input = await readJson(req);
        if (!Number.isSafeInteger(input.expected_shift_id) || !Number.isSafeInteger(input.expected_cash_cents) || typeof input.open_order_fingerprint !== 'string')
          throw new PosError('请刷新钱箱后重试', 409);
        result = pos.closeShift(session.user_id, input);
      }
      else if (req.method === 'GET' && path === '/api/reports') { allow('ADMIN','MANAGER'); result = pos.report(); }
      else if (req.method === 'GET' && path === '/api/audit') { allow('ADMIN'); result = pos.auditEvents(); }
      else if (req.method === 'GET' && /^\/print\/orders\/\d+$/.test(path)) {
        allow('ADMIN','MANAGER','CASHIER');
        const order = pos.getOrder(Number(path.split('/')[3]));
        if (!['PAID','REFUNDED'].includes(order.status)) throw new PosError('订单未结账', 409);
        const rows = order.items.filter((item) => item.quantity - item.void_quantity - item.split_quantity > 0)
          .map((item) => `<tr><td>${safeHtml(item.name_snapshot)} × ${item.quantity - item.void_quantity - item.split_quantity}</td><td>${money(item.line_cents)}</td></tr>`).join('');
        const html = printPage('知华餐饮 · 收银小票', `<p>单号 ${safeHtml(order.number)}<br>时间 ${localTime(order.closed_at)}<br>桌台 ${safeHtml(order.table_name || '外带')}</p>
          <table>${rows}</table><p>菜品 ${money(order.subtotal_cents)}${order.discount_cents ? `　折扣 -${money(order.discount_cents)}` : ''}</p>
          <p class="total">${order.status === 'REFUNDED' ? '原收款' : '收款'} ${money(order.paid_total_cents)}</p><p>方式 ${order.payment_method === 'CASH' ? '现金' : '外部终端（人工核对）'}${order.payment_method === 'CASH' ? `　找零 ${money(order.change_cents || 0)}` : ''}</p>
          ${order.external_reference ? `<p>收款交易号 ${safeHtml(order.external_reference)}</p>` : ''}
          <p class="muted">${order.status === 'REFUNDED' ? `已全额退款${order.refund_reference ? ` · 退款交易号 ${safeHtml(order.refund_reference)}` : ''}` : '请核对票据'}</p>`);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" });
        return res.end(html);
      }
      else throw new PosError('接口不存在', 404);
      return send(res, 200, result);
    } catch (error) {
      const status = error instanceof PosError ? error.status : 500;
      if (status === 500) process.stderr.write(`POS request failed: ${error.message}\n`);
      return send(res, status, { error: status === 500 ? '服务暂时不可用' : error.message });
    }
  });
  server.on('close', () => db.close());
  return new Promise((resolve) => server.listen(port, host, () => resolve({ server, db, pos, address: server.address() })));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startServer().then(({ address }) => process.stdout.write(`ZhuaTech Restaurant POS listening on ${address.address}:${address.port}\n`))
    .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
