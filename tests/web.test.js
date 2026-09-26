// 知华科技（上海如静知华信息科技有限公司）｜https://www.zhuatech.cn/｜商业咨询微信：zhuatech、zhuatech2
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// 只验证请求竞态与刷新逻辑；实际浏览器布局须另外验收。
function fixture() {
  const orders = new Map([1,2].map((id) => [id, { id,revision:0,channel:'TAKEAWAY',status:'OPEN',
    created_at:'2026-09-26 02:00:00',items:[],subtotal_cents:0,due_cents:0,discount_cents:0 }]));
  const menu = { categories:[],items:[],tables:[] };
  let click; let poll;
  const app = { addEventListener: (event, callback) => { if (event === 'click') click=callback; } };
  let renders = 0;
  Object.defineProperty(app, 'innerHTML', { set() { renders++; } });
  const dialog = { open:false };
  const toast = { textContent:'',classList:{ add() {},remove() {} } };
  let delayOrders = null;
  let lastBody;
  const context = {
    document: { querySelector: (selector) => ({ '#app':app,'#dialog':dialog,'#dialog-form':{},'#toast':toast })[selector] },
    setInterval: (callback) => { poll=callback; },setTimeout() {},clearTimeout() {},
    fetch: async (path, options = {}) => {
      if (path === '/api/me') return new Promise(() => {});
      if (options.body) lastBody = JSON.parse(options.body);
      const value = path === '/api/menu' ? menu : path === '/api/shifts/current' ? null :
        path.startsWith('/api/orders?') ? [...orders.values()] : orders.get(Number(path.split('/')[3]));
      const snapshot = JSON.parse(JSON.stringify(value));
      if (path.startsWith('/api/orders?') && delayOrders) await delayOrders;
      return { ok:true,status:200,json:async () => snapshot };
    }
  };
  const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  runInNewContext(`${source}\nglobalThis.testUi = { state,refresh,handle,orderApi };`, context);
  const ui = context.testUi;
  ui.state.me = { username:'cashier',role:'CASHIER',csrf:'test-csrf' };
  ui.state.order = orders.get(1);
  return { ui,orders,dialog,toast,renders:() => renders,body:() => lastBody,poll:() => poll(),click:(button) => click({ target:{ closest:() => button } }),
    delay:() => { let release; delayOrders = new Promise((resolve) => { release=resolve; }); return () => { delayOrders=null;release(); }; } };
}

test('收银轮询仅在内容变化时重绘，并提示别人修改过的账单', async () => {
  const f = fixture();
  await f.ui.refresh();
  assert.equal(f.renders(), 1);
  await f.ui.refresh(true);
  assert.equal(f.renders(), 1);
  f.orders.set(1, { ...f.orders.get(1),revision:1 });
  await f.ui.refresh(true);
  assert.equal(f.renders(), 2);
  assert.equal(f.ui.state.order.revision, 1);
  assert.match(f.toast.textContent, /其他员工更新/);
});

test('延迟轮询不会把收银员新选择的订单切回旧订单', async () => {
  const f = fixture();
  await f.ui.refresh();
  const release = f.delay();
  const polling = f.ui.refresh(true);
  await f.ui.handle('order', { dataset:{ id:'2' } });
  release();
  await polling;
  assert.equal(f.ui.state.order.id, 2);
  assert.equal(f.renders(), 2);
});

test('正在选择订单时不会启动新的轮询抢走选择结果', async () => {
  const f = fixture();
  await f.ui.refresh();
  const choosing = f.click({ dataset:{ action:'order',id:'2' },disabled:false });
  await f.poll();
  await choosing;
  assert.equal(f.ui.state.order.id, 2);
});

test('确认窗口阻止轮询替换账单，提交携带打开窗口时的版本', async () => {
  const f = fixture();
  await f.ui.refresh();
  const captured = f.ui.state.order;
  f.orders.set(1, { ...f.orders.get(1),revision:1 });
  const release = f.delay();
  const polling = f.ui.refresh(true);
  f.dialog.open = true;
  release();
  await polling;
  assert.equal(f.ui.state.order.revision, 0);
  await f.ui.orderApi(captured, '/items', 'POST', { menu_item_id:1,quantity:1 });
  assert.equal(f.body().expected_revision, 0);
  f.dialog.open = false;
  await f.ui.refresh(true);
  assert.equal(f.ui.state.order.revision, 1);
});
