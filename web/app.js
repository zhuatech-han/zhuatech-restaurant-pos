// 知华科技（上海如静知华信息科技有限公司）｜https://www.zhuatech.cn/｜商业咨询微信：zhuatech、zhuatech2
const app = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const dialogForm = document.querySelector('#dialog-form');
const toastEl = document.querySelector('#toast');
const state = { me: null, page: 'orders', menu: null, orders: [], order: null, tickets: [], shift: null,
  report: null, users: [], audit: [], movements: [], shiftHistory: [], orderStatus: 'OPEN', category: 0, lastClosedShift: null, checkoutKeys: {} };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g,
  (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const yuan = (cents) => `¥${(Number(cents || 0) / 100).toFixed(2)}`;
const cents = (value) => Math.round(Number(value) * 100);
const datetime = (value) => value ? new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
}).format(new Date(`${value.replace(' ', 'T')}Z`)) : '—';
const label = { ADMIN: '管理员', MANAGER: '店长', CASHIER: '收银员', KITCHEN: '后厨',
  DINE_IN: '堂食', TAKEAWAY: '外带', OPEN: '未结账', PAID: '已结账', VOIDED: '已作废', REFUNDED: '已退款',
  CASH: '现金', EXTERNAL_TERMINAL: '外部终端人工记账', NEW: '待制作', PREPARING: '制作中', READY: '待出餐', DONE: '已完成', CANCEL: '退菜' };
const auditLabel = { CREATE_USER:'新增员工', UPDATE_USER:'修改员工', ADD_CATEGORY:'新增分类', UPDATE_CATEGORY:'修改分类',
  ADD_ITEM:'新增菜品', UPDATE_ITEM:'修改菜品', ADD_TABLE:'新增桌台', UPDATE_TABLE:'修改桌台',
  CREATE_ORDER:'新建订单', MOVE_TABLE:'换桌', ADD_ORDER_ITEM:'加菜', UPDATE_ORDER_ITEM:'编辑菜品', SEND_KITCHEN:'送后厨',
  VOID_ITEM:'退菜', SET_DISCOUNT:'修改折扣', SPLIT_ORDER:'拆单', CHECKOUT:'结账',
  REFUND_CASH:'现金退款', RECORD_TERMINAL_REFUND:'登记终端退款', VOID_ORDER:'作废订单',
  KITCHEN_STATUS:'后厨处理', OPEN_SHIFT:'开班', ADJUST_CASH:'现金收支', CLOSE_SHIFT:'交班', CHANGE_PASSWORD:'修改密码' };
const entityLabel = { USER:'员工', CATEGORY:'分类', MENU_ITEM:'菜品', TABLE:'桌台', ORDER:'订单', KITCHEN_TICKET:'后厨票据', SHIFT:'班次' };
const role = (...roles) => roles.includes(state.me?.role);
function toast(message) { toastEl.textContent = message; toastEl.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => toastEl.classList.remove('show'), 3600); }
async function api(path, method = 'GET', body) {
  const res = await fetch(path, { method, credentials: 'same-origin', headers: {
    ...(body ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' && state.me?.csrf ? { 'X-Pos-CSRF': state.me.csrf } : {})
  }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (res.status === 401 && path !== '/api/login' && path !== '/api/me') { state.me = null; renderLogin(); }
  if (!res.ok) { const error = Error(data.error || '操作失败'); error.status = res.status; throw error; }
  return data;
}
const orderApi = (order, path, method, body = {}) => api(`/api/orders/${order.id}${path}`, method,
  { ...body, expected_revision: order.revision });
function input(name, title, type = 'text', value = '', extra = '') {
  const optional = extra.includes('data-optional');
  return `<div class="field"><label for="f-${esc(name)}">${esc(title)}</label><input id="f-${esc(name)}" name="${esc(name)}" type="${type}" value="${esc(value)}" ${extra} ${optional ? '' : 'required'}></div>`;
}
function select(name, title, options, selected) {
  return `<div class="field"><label for="f-${esc(name)}">${esc(title)}</label><select id="f-${esc(name)}" name="${esc(name)}">${options.map(([value, title]) => `<option value="${esc(value)}" ${String(value) === String(selected) ? 'selected' : ''}>${esc(title)}</option>`).join('')}</select></div>`;
}
function form(title, fields, submit = '确定') {
  return new Promise((resolve) => {
    dialogForm.innerHTML = `<h2>${esc(title)}</h2>${fields}<div class="dialog-actions"><button class="small secondary" type="button" id="cancel-dialog">取消</button><button class="small" type="submit">${esc(submit)}</button></div>`;
    dialog.showModal();
    const cancel = () => { dialog.close(); dialogForm.innerHTML = ''; resolve(null); };
    dialogForm.querySelector('#cancel-dialog').onclick = cancel;
    dialog.oncancel = (event) => { event.preventDefault(); cancel(); };
    dialogForm.onsubmit = (event) => {
      event.preventDefault();
      if (!dialogForm.reportValidity()) return;
      const value = Object.fromEntries(new FormData(dialogForm));
      dialog.close(); dialogForm.innerHTML = ''; resolve(value);
    };
  });
}
async function act(callback, message = '已完成') {
  try { await callback(); toast(message); await refresh(); }
  catch (error) { if (error.status === 409) await refresh(); toast(error.message); }
}
let refreshSequence = 0;
async function refresh(ifChanged = false) {
  if (!state.me) return renderLogin();
  const sequence = ++refreshSequence;
  const page = state.page;
  const before = ifChanged ? JSON.stringify(page === 'orders' ? [state.menu,state.orders,state.shift,state.order] : page === 'shift' ? [state.shift,state.movements,state.shiftHistory,state.report] : state.tickets) : null;
  const previousRevision = state.order?.revision;
  try {
    const next = {};
    if (page === 'orders') {
      [next.menu, next.orders, next.shift, next.order] = await Promise.all([
        api('/api/menu'), api(`/api/orders?status=${state.orderStatus}`), api('/api/shifts/current'),
        state.order ? api(`/api/orders/${state.order.id}`) : Promise.resolve(null)]);
    } else if (page === 'kitchen') next.tickets = await api('/api/kitchen/tickets');
    else if (page === 'menu') next.menu = await api('/api/menu');
    else if (page === 'shift') {
      [next.shift, next.movements, next.shiftHistory] = await Promise.all([
        api('/api/shifts/current'), api('/api/shifts/movements'), api('/api/shifts/history')]);
      next.report = role('ADMIN','MANAGER') ? await api('/api/reports') : null;
    }
    else if (page === 'reports') next.report = await api('/api/reports');
    else if (page === 'users') { [next.users, next.audit] = await Promise.all([api('/api/users'), api('/api/audit')]); }
    if (!state.me || sequence !== refreshSequence || page !== state.page || (ifChanged && (dialog.open || activeActions))) return;
    Object.assign(state, next);
    if (page === 'orders' && state.category && !state.menu.categories.some((category) => category.id === state.category && category.active)) state.category = 0;
    const after = ifChanged ? JSON.stringify(page === 'orders' ? [state.menu,state.orders,state.shift,state.order] : page === 'shift' ? [state.shift,state.movements,state.shiftHistory,state.report] : state.tickets) : null;
    if (!ifChanged || before !== after) render();
    if (ifChanged && page === 'orders' && previousRevision != null && state.order && state.order.revision !== previousRevision) toast('订单已由其他员工更新，请核对账单');
  } catch (error) { toast(error.message); }
}
function renderLogin() {
  app.innerHTML = `<div class="login"><div class="card"><div class="brand"><img src="/assets/zhuatech-logo.jpg" alt="知华科技">知华餐饮收银</div><h1>登录门店</h1><form id="login-form">${input('username','用户名','text','','autocomplete="username"')}${input('password','密码','password','','autocomplete="current-password"')}<button class="button">登录</button></form><footer>知华科技 · <a href="https://www.zhuatech.cn/" target="_blank" rel="noopener">官方网站</a></footer></div></div>`;
  document.querySelector('#login-form').onsubmit = async (event) => {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(event.currentTarget));
    try { await api('/api/login', 'POST', payload); state.me = await api('/api/me'); state.page = role('KITCHEN') ? 'kitchen' : 'orders'; state.order = null; await refresh(); }
    catch (error) { toast(error.message); }
  };
}
function navButton(page, title) { return `<button data-action="page" data-page="${page}" class="${state.page === page ? 'active' : ''}">${title}</button>`; }
function render() {
  const titles = { orders: '收银台', kitchen: '后厨', menu: '菜品与桌台', shift: '交班', reports: '经营报表', users: '员工与记录' };
  const pages = role('KITCHEN') ? navButton('kitchen','后厨') : [navButton('orders','收银台'), ...(role('ADMIN','MANAGER') ? [navButton('kitchen','后厨'), navButton('menu','菜品与桌台')] : []), navButton('shift','交班'), ...(role('ADMIN','MANAGER') ? [navButton('reports','经营报表')] : []), ...(role('ADMIN') ? [navButton('users','员工与记录')] : [])].join('');
  app.innerHTML = `<div class="shell"><aside class="rail"><div class="brand"><img src="/assets/zhuatech-logo.jpg" alt="知华科技"><span>知华餐饮收银</span></div><nav>${pages}</nav><div class="bottom"><a href="https://www.zhuatech.cn/" target="_blank" rel="noopener">知华科技官网</a><br>商业咨询微信 zhuatech / zhuatech2</div></aside><main><div class="top"><h1>${titles[state.page]}</h1><div class="user">${esc(state.me.username)} · ${label[state.me.role]}<button class="small ghost" data-action="change-password">改密码</button><button class="small ghost" data-action="logout">退出</button></div></div>${({ orders: renderOrders, kitchen: renderKitchen, menu: renderMenu, shift: renderShift, reports: renderReports, users: renderUsers })[state.page]()}</main></div>`;
}
function renderOrders() {
  const statusTabs = [['OPEN','未结账'],['PAID','已结账'],['REFUNDED','已退款'],['VOIDED','已作废']].map(([key, name]) => `<button data-action="status" data-status="${key}" class="${state.orderStatus === key ? 'active' : ''}">${name}</button>`).join('');
  const tables = state.menu.tables.filter((table) => table.active && !table.occupied);
  const list = state.orders.length ? `<div class="order-list">${state.orders.map((order) => `<button class="queue-item ${state.order?.id === order.id ? 'selected' : ''}" data-action="order" data-id="${order.id}"><span class="row"><strong>${order.table_name ? esc(order.table_name) : '外带'} <small>${order.channel === 'DINE_IN' ? '堂食' : ''}</small></strong><b>${yuan(order.due_cents)}</b></span><span class="row item-note"><span>#${order.id} · ${datetime(order.created_at)}</span><span>${label[order.status]}</span></span></button>`).join('')}</div>` : '<div class="empty">暂无订单</div>';
  const chosen = state.order ? renderOrderDetail(state.order) : '<div class="empty">请先选择订单，或新建堂食、外带订单</div>';
  const activeCategories = state.menu.categories.filter((category) => category.active);
  const menuItems = state.menu.items.filter((item) => item.active && activeCategories.some((category) => category.id === item.category_id) && (!state.category || item.category_id === state.category));
  const emptyMenu = role('ADMIN','MANAGER') ? '<div class="empty">暂无在售菜品<br><button class="small secondary" data-action="page" data-page="menu">录入菜品</button></div>' : '<div class="empty">暂无在售菜品，请联系店长</div>';
  const catalog = state.orderStatus === 'OPEN' ? `<section class="catalog"><div class="panel-title">菜品</div><div class="category-tabs"><button data-action="category" data-id="0" class="${state.category === 0 ? 'active' : ''}">全部</button>${activeCategories.map((category) => `<button data-action="category" data-id="${category.id}" class="${state.category === category.id ? 'active' : ''}">${esc(category.name)}</button>`).join('')}</div><div class="catalog-grid">${menuItems.length ? menuItems.map((item) => `<button class="catalog-item" data-action="quick-add" data-id="${item.id}" ${state.order?.status !== 'OPEN' ? 'disabled' : ''}><span>${esc(item.name)}</span><strong>${yuan(item.price_cents)}</strong></button>`).join('') : emptyMenu}</div></section>` : '';
  return `<div class="workhead"><div class="actions"><button class="button" data-action="new-dine">堂食开台</button><button class="button secondary" data-action="new-takeaway">新建外带</button></div><div class="statusline">${state.shift ? `共用钱箱 #${state.shift.id} 已开班` : '<button class="text-button" data-action="page" data-page="shift">钱箱未开班，先去开班</button>'} · 空桌 ${tables.length}</div></div><div class="tabs">${statusTabs}</div><div class="pos-workspace ${state.orderStatus === 'OPEN' ? '' : 'history'}"><section class="queue"><div class="panel-title">订单 <span>${state.orders.length}</span></div>${list}</section>${catalog}<section class="bill">${chosen}</section></div>`;
}
function renderOrderDetail(order) {
  const isOpen = order.status === 'OPEN';
  const pending = order.items.reduce((sum, item) => sum + Math.max(0, item.quantity - item.sent_quantity - item.void_quantity - item.split_quantity), 0);
  const liveItems = order.items.filter((item) => item.quantity - item.void_quantity - item.split_quantity > 0);
  const rows = liveItems.length ? liveItems.map((item) => {
    const live = item.quantity - item.void_quantity - item.split_quantity;
    const unsent = item.quantity - item.sent_quantity - item.void_quantity - item.split_quantity;
    return `<div class="item-row"><div><div class="item-title">${esc(item.name_snapshot)}${isOpen && !item.sent_quantity && !item.void_quantity && !item.split_quantity ? `<button class="line-edit" data-action="edit-item" data-id="${item.id}">编辑</button>` : ''}</div><div class="item-note">${item.note ? `${esc(item.note)} · ` : ''}${yuan(item.price_cents)} / 份${unsent > 0 ? ` · 待送 ${unsent}` : ''}</div></div><div class="line-controls">${isOpen && live && (unsent > 0 || role('ADMIN','MANAGER')) ? `<button class="small ghost" data-action="decrease-item" data-id="${item.id}" title="减少一份">−</button>` : ''}<strong>${live}</strong>${isOpen && state.menu.items.some((entry) => entry.id === item.menu_item_id && entry.active && state.menu.categories.some((category) => category.id === entry.category_id && category.active)) ? `<button class="small ghost" data-action="quick-add" data-id="${item.menu_item_id}" title="增加一份">+</button>` : ''}<b class="money">${yuan(item.line_cents)}</b></div></div>`;
  }).join('') : '<div class="muted">还没有菜品</div>';
  const buttons = isOpen ? `<div class="bill-actions"><button class="small secondary" data-action="add-item">加菜（数量/备注）</button><button class="small secondary" data-action="send" ${pending ? '' : 'disabled'}>送后厨${pending ? ` (${pending})` : ''}</button><button class="small secondary" data-action="split-order" ${liveItems.length ? '' : 'disabled'}>拆单</button>${order.channel === 'DINE_IN' ? `<button class="small secondary" data-action="move-table">换桌</button>` : ''}${role('ADMIN','MANAGER') ? `<button class="small secondary" data-action="discount">折扣</button><button class="small danger ghost" data-action="void-order">作废</button>` : ''}</div><div class="bill-pay"><button class="button" data-action="checkout" ${!liveItems.length || pending || !state.shift ? 'disabled' : ''}>结账　${yuan(order.due_cents)}</button>${pending ? `<span class="item-note">先将 ${pending} 份菜品送后厨</span>` : !state.shift ? '<span class="item-note">请先到交班页开班</span>' : ''}</div>` : `<div class="bill-actions"><span>${label[order.status]}</span>${['PAID','REFUNDED'].includes(order.status) ? `<a class="small secondary" href="/print/orders/${order.id}" target="_blank" rel="noopener">打印小票</a>` : ''}${role('ADMIN','MANAGER') && order.status === 'PAID' ? `<button class="small danger ghost" data-action="refund">${order.payment_method === 'CASH' ? '现金退款' : '登记终端退款'}</button>` : ''}</div>`;
  const payment = order.payment_method ? `<div class="payment-detail"><div class="row"><span>收款方式</span><strong>${label[order.payment_method]}</strong></div>${order.payment_method === 'CASH' ? `<div class="row"><span>实收 / 找零</span><strong>${yuan(order.tendered_cents)} / ${yuan(order.change_cents)}</strong></div>` : `<div class="row"><span>终端交易号</span><strong>${esc(order.external_reference)}</strong></div>`}${order.received_by_name ? `<div class="row"><span>收款人</span><strong>${esc(order.received_by_name)}</strong></div>` : ''}${order.refunded_at ? `<div class="row"><span>退款</span><strong>${yuan(order.paid_total_cents)}</strong></div>${order.refunded_by_name ? `<div class="row"><span>退款人</span><strong>${esc(order.refunded_by_name)}</strong></div>` : ''}${order.refund_reference ? `<div class="row"><span>退款交易号</span><strong>${esc(order.refund_reference)}</strong></div>` : ''}` : ''}</div>` : '';
  return `<div class="bill-inner"><div class="row bill-head"><div><h2>${esc(order.table_name || '外带')}${order.channel === 'DINE_IN' ? ' <small>堂食</small>' : ''}</h2><div class="item-note">#${order.id} · ${datetime(order.created_at)}</div></div><span class="status-text">${label[order.status]}</span></div><div class="bill-lines">${rows}</div><div class="bill-totals"><div class="row"><span>菜品</span><span>${yuan(order.subtotal_cents)}</span></div>${order.discount_cents ? `<div class="row"><span>折扣</span><span>−${yuan(order.discount_cents)}</span></div>` : ''}<div class="row due"><strong>应收</strong><strong>${yuan(order.due_cents)}</strong></div></div>${payment}${buttons}</div>`;
}
function renderKitchen() {
  return state.tickets.length ? `<div class="grid">${state.tickets.map((ticket) => `<div class="card"><div class="row"><h2>${esc(ticket.table_name || '外带')}</h2><span class="badge ${ticket.kind === 'CANCEL' ? 'red' : 'warn'}">${ticket.kind === 'CANCEL' ? '退菜通知' : label[ticket.status]}</span></div><div class="item-note">#${ticket.order_id} · ${datetime(ticket.created_at)}</div><div class="sep"></div>${ticket.items.map((item) => `<div class="item-row"><div><div class="item-title">${esc(item.name_snapshot)} × ${item.quantity}</div>${item.note ? `<div class="item-note">${esc(item.note)}</div>` : ''}</div></div>`).join('')}<div class="actions" style="margin-top:16px">${ticket.kind === 'CANCEL' ? `<button class="small danger" data-action="ticket" data-id="${ticket.id}" data-status="DONE">确认退菜</button>` : ticket.status === 'NEW' ? `<button class="small" data-action="ticket" data-id="${ticket.id}" data-status="PREPARING">开始制作</button>` : ticket.status === 'PREPARING' ? `<button class="small" data-action="ticket" data-id="${ticket.id}" data-status="READY">待出餐</button>` : ticket.status === 'READY' ? `<button class="small" data-action="ticket" data-id="${ticket.id}" data-status="DONE">完成</button>` : ''}</div></div>`).join('')}</div>` : '<div class="empty">后厨暂无待处理单据</div>';
}
function renderMenu() {
  const categories = new Map(state.menu.categories.map((category) => [category.id, category.name]));
  const categoryRows = state.menu.categories.map((category) => `<div class="manage-row"><span>${esc(category.name)} <small>${category.active ? '启用' : '停用'}</small></span><button class="small ghost" data-action="edit-category" data-id="${category.id}">管理</button></div>`).join('');
  const tableRows = state.menu.tables.map((table) => `<div class="table-tile"><div class="row"><strong>${esc(table.name)}</strong><span class="badge ${table.occupied ? 'warn' : ''}">${!table.active ? '停用' : table.occupied ? '使用中' : '空闲'}</span></div><div class="actions"><button class="small ghost" data-action="edit-table" data-id="${table.id}">改桌号</button><button class="small ghost" data-action="toggle-table" data-id="${table.id}" data-active="${table.active ? 0 : 1}">${table.active ? '停用' : '启用'}</button></div></div>`).join('');
  return `<div class="grid two"><div class="card"><div class="row"><h2>分类与菜品</h2><div class="actions"><button class="small secondary" data-action="add-category">+ 分类</button><button class="small" data-action="add-menu-item" ${state.menu.categories.length ? '' : 'disabled'}>+ 菜品</button></div></div><div class="manage-list">${categoryRows || '<p class="muted">先新增分类，再录入菜品。</p>'}</div><div class="table-wrap"><table><thead><tr><th>名称</th><th>分类</th><th>价格</th><th>状态</th><th></th></tr></thead><tbody>${state.menu.items.map((item) => `<tr><td>${esc(item.name)}</td><td>${esc(categories.get(item.category_id))}</td><td>${yuan(item.price_cents)}</td><td>${item.active ? '在售' : '下架'}</td><td><button class="small ghost" data-action="edit-menu-item" data-id="${item.id}">编辑</button></td></tr>`).join('')}</tbody></table></div></div><div class="card"><div class="row"><h2>桌台</h2><button class="small" data-action="add-table">+ 桌台</button></div><div class="table-grid">${tableRows || '<p class="muted">暂无桌台；外带订单可以不使用桌台。</p>'}</div></div></div>`;
}
function renderShift() {
  const shift = state.shift;
  const movements = state.movements.map((item) => `<div class="manage-row"><span>${item.type === 'IN' ? '存入' : '支出'} · ${esc(item.reason)}<small>${esc(item.username)} · ${datetime(item.created_at)}</small></span><strong>${item.type === 'IN' ? '+' : '−'}${yuan(item.amount_cents)}</strong></div>`).join('');
  const openOrders = shift?.open_order_count ? `<div class="item-row"><span>未结订单（交班后保留）</span><strong>${shift.open_order_count} 笔 · ${yuan(shift.open_order_due_cents)}</strong></div>` : '';
  const own = shift ? `<div class="card"><div class="row"><h2>共用钱箱 #${shift.id}</h2><span class="badge">进行中</span></div><div class="item-row"><span>开班人 / 时间</span><strong>${esc(shift.opened_by_name)} · ${datetime(shift.opened_at)}</strong></div><div class="item-row"><span>备用金</span><strong>${yuan(shift.opening_cash_cents)}</strong></div><div class="item-row"><span>现金收款 / 退款</span><strong>${yuan(shift.cash_received_cents)} / ${shift.cash_refunded_cents ? '−' : ''}${yuan(shift.cash_refunded_cents)}</strong></div><div class="item-row"><span>现金存入 / 支出</span><strong>${shift.cash_in_cents ? '+' : ''}${yuan(shift.cash_in_cents)} / ${shift.cash_out_cents ? '−' : ''}${yuan(shift.cash_out_cents)}</strong></div><div class="item-row"><span>账面应有现金</span><strong>${yuan(shift.expected_cash_cents)}</strong></div>${openOrders}<div class="actions" style="margin-top:18px"><button class="small secondary" data-action="adjust-cash">登记现金收支</button>${shift.can_close ? '<button class="button" data-action="close-shift">核对并交班</button>' : '<span class="muted">由开班人或店长交班</span>'}</div>${movements ? `<div class="cash-history">${movements}</div>` : ''}</div>` : `<div class="card"><h2>钱箱未开班</h2><p class="muted">收款前须先登记备用金；同店员工共用此钱箱。</p><button class="button" data-action="open-shift">开班</button></div>`;
  const result = state.lastClosedShift ? `<div class="reconcile"><strong>班次 #${state.lastClosedShift.id} 已交班</strong><span>应有 ${yuan(state.lastClosedShift.expected_cash_cents)}　实点 ${yuan(state.lastClosedShift.counted_cash_cents)}　差额 ${yuan(state.lastClosedShift.difference_cents)}</span></div>` : '';
  const history = state.report?.shifts || state.shiftHistory;
  return `${result}<div class="grid two">${own}<div class="card"><h2>最近钱箱班次</h2><div class="table-wrap"><table><thead><tr><th>开班人</th><th>交班人</th><th>开班</th><th>应有现金</th><th>差额</th></tr></thead><tbody>${history.slice(0,10).map((item) => `<tr><td>${esc(item.username)}</td><td>${esc(item.closed_by_name || '—')}</td><td>${datetime(item.opened_at)}</td><td>${item.expected_cash_cents == null ? '未交班' : yuan(item.expected_cash_cents)}</td><td>${item.difference_cents == null ? '—' : yuan(item.difference_cents)}</td></tr>`).join('')}</tbody></table></div></div></div>`;
}
function renderReports() {
  const report = state.report;
  const sum = report.sales.reduce((total, row) => total + row.gross_cents - row.refunded_cents, 0);
  return `<div class="grid"><div class="card"><div class="muted">近 30 个营业日净收</div><div class="metric">${yuan(sum)}</div></div><div class="card"><div class="muted">近 30 个营业日订单</div><div class="metric">${report.sales.reduce((total, row) => total + row.order_count, 0)}</div></div><div class="card"><div class="muted">近 30 个营业日退款</div><div class="metric">${yuan(report.sales.reduce((total, row) => total + row.refunded_cents, 0))}</div></div></div><div class="grid two" style="margin-top:16px"><div class="card"><h2>每日销售</h2><div class="table-wrap"><table><thead><tr><th>日期</th><th>订单</th><th>收款</th><th>退款</th></tr></thead><tbody>${report.sales.map((row) => `<tr><td>${esc(row.day)}</td><td>${row.order_count}</td><td>${yuan(row.gross_cents)}</td><td>${yuan(row.refunded_cents)}</td></tr>`).join('')}</tbody></table></div></div><div class="card"><h2>累计收款方式</h2>${report.methods.map((row) => `<div class="item-row"><span>${label[row.method]} · ${row.count} 笔</span><strong>净收 ${yuan(row.gross_cents-row.refunded_cents)}${row.refunded_cents ? `<small class="method-refund">退款 ${yuan(row.refunded_cents)}</small>` : ''}</strong></div>`).join('')}</div></div>`;
}
function renderUsers() {
  return `<div class="grid two"><div class="card"><div class="row"><h2>员工</h2><button class="small" data-action="add-user">+ 新员工</button></div><div class="table-wrap"><table><thead><tr><th>用户名</th><th>角色</th><th>状态</th><th></th></tr></thead><tbody>${state.users.map((user) => `<tr><td>${esc(user.username)}</td><td>${label[user.role]}</td><td>${user.active ? '启用' : '停用'}</td><td><button class="small ghost" data-action="edit-user" data-id="${user.id}">管理</button></td></tr>`).join('')}</tbody></table></div></div><div class="card"><h2>最近操作</h2><div class="table-wrap"><table><thead><tr><th>时间</th><th>员工</th><th>动作</th><th>对象</th></tr></thead><tbody>${state.audit.map((event) => `<tr><td>${datetime(event.created_at)}</td><td>${esc(event.username)}</td><td>${esc(auditLabel[event.action] || event.action)}</td><td>${esc(entityLabel[event.entity_type] || event.entity_type)} #${event.entity_id}</td></tr>`).join('')}</tbody></table></div></div></div>`;
}
async function handle(action, button) {
  const order = state.order;
  const id = Number(button.dataset.id);
  if (action === 'page') { state.page = button.dataset.page; await refresh(); return; }
  if (action === 'change-password') {
    const choice = await form('修改登录密码',input('current_password','当前密码','password','','autocomplete="current-password"')+input('new_password','新密码（至少 12 位）','password','','minlength="12" autocomplete="new-password"')+input('confirm_password','确认新密码','password','','minlength="12" autocomplete="new-password"'),'修改密码');
    if (!choice) return;
    if (choice.new_password !== choice.confirm_password) { toast('两次输入的新密码不一致'); return; }
    await api('/api/me/password','POST',{current_password:choice.current_password,new_password:choice.new_password});
    state.me = null; state.order = null; renderLogin(); toast('密码已修改，请重新登录'); return;
  }
  if (action === 'logout') { await api('/api/logout','POST'); state.me = null; state.order = null; renderLogin(); return; }
  if (action === 'status') { state.orderStatus = button.dataset.status; state.order = null; await refresh(); return; }
  if (action === 'order') { const sequence = ++refreshSequence; const selected = await api(`/api/orders/${id}`); if (sequence === refreshSequence) { state.order = selected; render(); } return; }
  if (action === 'category') { state.category = id; render(); return; }
  if (action === 'new-dine') {
    const tables = state.menu.tables.filter((table) => table.active && !table.occupied);
    if (!tables.length) { toast('没有空桌，请先结清或新增桌台'); return; }
    const choice = await form('堂食开台', select('table_id','选择空桌',tables.map((table) => [table.id,table.name])));
    if (choice) await act(async () => { state.order = await api('/api/orders','POST',{channel:'DINE_IN',table_id:Number(choice.table_id)}); state.orderStatus='OPEN'; },'已开台');
  }
  if (action === 'new-takeaway') await act(async () => { state.order = await api('/api/orders','POST',{channel:'TAKEAWAY'}); state.orderStatus='OPEN'; },'已建立外带订单');
  if (action === 'quick-add') {
    if (!order || order.status !== 'OPEN') { toast('请先选择未结订单'); return; }
    await act(() => orderApi(order,'/items','POST',{menu_item_id:id,quantity:1}),'已加菜');
  }
  if (action === 'decrease-item') {
    const item = order.items.find((entry) => entry.id === id);
    const unsent = item.quantity - item.sent_quantity - item.void_quantity - item.split_quantity;
    let reason = '点单更正';
    if (unsent <= 0) { const choice = await form('退已送厨菜品',input('reason','退菜原因'),'确认退菜'); if (!choice) return; reason = choice.reason; }
    await act(() => orderApi(order,`/items/${id}/void`,'POST',{quantity:1,reason}),unsent > 0 ? '已减少一份' : '退菜已通知后厨');
  }
  if (action === 'add-item') {
    const options = state.menu.items.filter((item) => item.active && state.menu.categories.some((category) => category.id === item.category_id && category.active))
      .map((item) => [item.id,`${item.name} · ${yuan(item.price_cents)}`]);
    if (!options.length) { toast('请先在菜品与桌台中录入在售菜品'); return; }
    const choice = await form('加菜', select('menu_item_id','菜品',options) + input('quantity','数量','number','1','min="1" max="99"') + input('note','备注（无备注可留空）','text','','maxlength="120" data-optional'));
    if (choice) await act(() => orderApi(order,'/items','POST',{ menu_item_id: Number(choice.menu_item_id),quantity: Number(choice.quantity),note: choice.note }), '已加菜');
  }
  if (action === 'edit-item') {
    const item = order.items.find((entry) => entry.id === id);
    const choice = await form(`编辑 ${item.name_snapshot}`,input('quantity','数量','number',item.quantity,'min="1" max="999"')+input('note','备注（可留空）','text',item.note,'maxlength="120" data-optional'),'保存');
    if (choice) await act(() => orderApi(order,`/items/${id}`,'PUT',{quantity:Number(choice.quantity),note:choice.note}),'菜品已更新');
  }
  if (action === 'move-table') {
    const tables = state.menu.tables.filter((table) => table.active && !table.occupied);
    if (!tables.length) { toast('没有可换入的空桌'); return; }
    const choice = await form('换桌',select('table_id','换至',tables.map((table)=>[table.id,table.name])));
    if (choice) await act(() => orderApi(order,'/move','POST',{table_id:Number(choice.table_id)}),'已换桌');
  }
  if (action === 'split-order') {
    const items = order.items.filter((item) => item.quantity - item.void_quantity - item.split_quantity > 0);
    const fields = `<p class="muted">填写需要拆出的每道菜数量，未填写的留在原单。</p>${items.map((item) => input(`item_${item.id}`,`${item.name_snapshot}（最多 ${item.quantity - item.void_quantity - item.split_quantity}）`,'number','0',`min="0" max="${item.quantity - item.void_quantity - item.split_quantity}"`)).join('')}`;
    const choice = await form('拆出新账单',fields,'确认拆单');
    if (choice) {
      const selected = items.map((item)=>({item_id:item.id,quantity:Number(choice[`item_${item.id}`])})).filter((item)=>item.quantity>0);
      if (!selected.length) { toast('请至少选择一份菜品'); return; }
      await act(async () => { const result=await orderApi(order,'/split','POST',{items:selected}); state.order=result.split; },'已拆出新账单');
    }
  }
  if (action === 'send') await act(() => orderApi(order,'/send','POST'), '已发送后厨');
  if (action === 'discount') { const choice = await form('整单折扣',input('amount','减免金额（元）','number',(order.discount_cents/100).toFixed(2),'min="0" step="0.01"')); if (choice) await act(() => orderApi(order,'/discount','POST',{discount_cents:cents(choice.amount)}),'折扣已更新'); }
  if (action === 'void-order') { const choice = await form('作废订单',input('reason','作废原因'),'确认作废'); if (choice) await act(async () => { await orderApi(order,'/void','POST',choice); state.orderStatus='VOIDED'; },'订单已作废'); }
  if (action === 'checkout') {
    const pending = form(`收款 ${yuan(order.due_cents)}`,select('method','收款方式',[['CASH','现金'],['EXTERNAL_TERMINAL','外部终端已收款，人工登记']])+input('tendered','现金实收（元）','number',(order.due_cents/100).toFixed(2),'min="0" step="0.01"')+input('reference','终端交易号','text','','maxlength="100" data-optional')+'<p id="terminal-hint" class="muted" hidden>请先在独立终端确认到账，再记录交易号。本系统不发起支付。</p>','确认收款');
    const method = dialogForm.querySelector('#f-method');
    const tendered = dialogForm.querySelector('#f-tendered');
    const reference = dialogForm.querySelector('#f-reference');
    const sync = () => { const external=method.value==='EXTERNAL_TERMINAL'; tendered.parentElement.hidden=external; tendered.required=!external; reference.parentElement.hidden=!external; reference.required=external; dialogForm.querySelector('#terminal-hint').hidden=!external; };
    method.onchange=sync; sync();
    const choice = await pending;
    if (choice) await act(async () => {
      const key=state.checkoutKeys[order.id] ||= crypto.randomUUID();
      await orderApi(order,'/checkout','POST',{method:choice.method,tendered_cents:choice.method==='CASH'?cents(choice.tendered):order.due_cents,external_reference:choice.reference,idempotency_key:key});
      delete state.checkoutKeys[order.id];
      state.orderStatus='PAID';
    },'已收款');
  }
  if (action === 'refund') {
    const external=order.payment_method==='EXTERNAL_TERMINAL';
    const choice=await form(external?'登记终端退款':'现金退款',input('reason','退款原因')+(external?input('refund_reference','终端退款交易号'):'')+(external?'<p class="muted">请先在独立终端完成退款并核对交易号。</p>':''),'确认登记');
    if (choice) await act(async () => { await orderApi(order,'/refund','POST',choice); state.orderStatus='REFUNDED'; },external?'终端退款已登记':'现金退款已登记');
  }
  if (action === 'ticket') await act(() => api(`/api/kitchen/tickets/${id}/status`,'POST',{status:button.dataset.status}),'后厨状态已更新');
  if (action === 'add-category') { const choice = await form('新增分类',input('name','分类名称')); if (choice) await act(() => api('/api/menu/categories','POST',choice),'分类已添加'); }
  if (action === 'edit-category') { const category = state.menu.categories.find((entry) => entry.id === id); const choice = await form('管理分类',input('name','分类名称','text',category.name)+select('active','状态',[[1,'启用'],[0,'停用']],category.active)); if (choice) await act(() => api(`/api/menu/categories/${id}`,'PUT',{name:choice.name,active:Number(choice.active)}),'分类已更新'); }
  if (action === 'add-menu-item') { const choice = await form('新增菜品',select('category_id','分类',state.menu.categories.map((item)=>[item.id,item.name]))+input('name','菜名')+input('price','价格（元）','number','','min="0" step="0.01"')); if (choice) await act(() => api('/api/menu/items','POST',{category_id:Number(choice.category_id),name:choice.name,price_cents:cents(choice.price)}),'菜品已添加'); }
  if (action === 'edit-menu-item') { const item = state.menu.items.find((entry)=>entry.id===id); const choice = await form('编辑菜品',select('category_id','分类',state.menu.categories.map((entry)=>[entry.id,entry.name]),item.category_id)+input('name','菜名','text',item.name)+input('price','价格（元）','number',(item.price_cents/100).toFixed(2),'min="0" step="0.01"')+select('active','销售状态',[[1,'在售'],[0,'下架']],item.active)); if (choice) await act(() => api(`/api/menu/items/${id}`,'PUT',{category_id:Number(choice.category_id),name:choice.name,price_cents:cents(choice.price),active:Number(choice.active)}),'菜品已更新'); }
  if (action === 'add-table') { const choice = await form('新增桌台',input('name','桌号')); if (choice) await act(() => api('/api/tables','POST',choice),'桌台已添加'); }
  if (action === 'edit-table') { const table = state.menu.tables.find((entry) => entry.id === id); const choice = await form('修改桌号',input('name','桌号','text',table.name)); if (choice) await act(() => api(`/api/tables/${id}`,'PUT',{name:choice.name}),'桌号已更新'); }
  if (action === 'toggle-table') await act(() => api(`/api/tables/${id}`,'PUT',{active:Number(button.dataset.active)}),'桌台状态已更新');
  if (action === 'open-shift') { const choice = await form('开班',input('opening_cash','备用金（元）','number','0','min="0" step="0.01"')); if (choice) await act(async () => { await api('/api/shifts/open','POST',{opening_cash_cents:cents(choice.opening_cash)}); state.lastClosedShift=null; },'已开班'); }
  if (action === 'adjust-cash') { const choice = await form('登记现金收支',select('type','类型',[['IN','存入现金'],['OUT','取出现金']])+input('amount','金额（元）','number','','min="0.01" step="0.01"')+input('reason','原因')); if (choice) await act(() => api('/api/shifts/cash','POST',{type:choice.type,amount_cents:cents(choice.amount),reason:choice.reason}),'现金收支已登记'); }
  if (action === 'close-shift') {
    const shift = state.shift;
    const warning = shift.open_order_count ? `<p class="muted">还有 ${shift.open_order_count} 笔未结订单，合计 ${yuan(shift.open_order_due_cents)}。交班后订单保留，下一班继续处理。</p><label class="confirm-row"><input type="checkbox" name="open_orders_ack" value="true" required> 已核对未结订单</label>` : '';
    const choice = await form('交班清点',`<p class="muted">账面应有 ${yuan(shift.expected_cash_cents)}；请实际点数后填写。</p>${warning}`+input('counted_cash','实点现金（元）','number','','min="0" step="0.01"'));
    if (choice) await act(async () => { state.lastClosedShift=await api('/api/shifts/close','POST',{counted_cash_cents:cents(choice.counted_cash),expected_shift_id:shift.id,expected_cash_cents:shift.expected_cash_cents,open_order_fingerprint:shift.open_order_fingerprint,open_orders_ack:choice.open_orders_ack==='true'}); },'交班结果已显示');
  }
  if (action === 'add-user') { const choice = await form('新增员工',input('username','用户名')+input('password','初始密码（至少 12 位）','password','','minlength="12"')+select('role','角色',[['CASHIER','收银员'],['KITCHEN','后厨'],['MANAGER','店长'],['ADMIN','管理员']])); if (choice) await act(() => api('/api/users','POST',choice),'员工已添加'); }
  if (action === 'edit-user') { const user = state.users.find((entry) => entry.id === id); const choice = await form(`管理员工 ${user.username}`,select('role','角色',[['CASHIER','收银员'],['KITCHEN','后厨'],['MANAGER','店长'],['ADMIN','管理员']],user.role)+select('active','状态',[[1,'启用'],[0,'停用']],user.active)+input('password','重设密码（留空不修改）','password','','minlength="12" data-optional')); if (choice) await act(() => api(`/api/users/${id}`,'PUT',{role:choice.role,active:Number(choice.active),...(choice.password ? {password:choice.password} : {})}),'员工已更新'); }
}
let activeActions = 0;
app.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  activeActions++;
  button.disabled = true;
  try { await handle(button.dataset.action, button); } catch (error) { toast(error.message); }
  finally { button.disabled = false; activeActions--; }
});
let syncing = false;
setInterval(async () => {
  if (!state.me || dialog.open || document.hidden || syncing || activeActions || !['orders','kitchen','shift'].includes(state.page)) return;
  syncing = true;
  try { await refresh(true); } finally { syncing = false; }
}, 5000);
api('/api/me').then((me) => { state.me = me; state.page = role('KITCHEN') ? 'kitchen' : 'orders'; return refresh(); }).catch(renderLogin);
