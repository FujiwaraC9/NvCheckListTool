/**
 * NvCheckList Web v3 - 主应用逻辑
 * 多维度项目选择 + 自动读取（平台 AT+QGMR / 基线 AT+CGMR）+ 条件匹配 + 双路径检查
 */
const state = {
  port: null,
  dirHandle: null,
  dirName: '',
  cfg: null,
  selection: {},          // 当前项目选择 { dimKey: value }
  // 历史记录页面分页
  historyPage: 1,
  pageSize: 20,
  historyFiltered: [],
  // 导出页面缓存
  expFiltered: [],
};

// ===== 工具函数 =====
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return Array.from(document.querySelectorAll(sel)); }

function toast(msg, type = 'info', duration = 2500) {
  const c = $('#toast-container');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; }, duration - 300);
  setTimeout(() => el.remove(), duration);
}

function logLine(msg, type = 'info') {
  const panel = $('#log-panel');
  const line = document.createElement('div');
  line.className = 'log-line log-' + type;
  const ts = new Date();
  const hh = String(ts.getHours()).padStart(2, '0');
  const mm = String(ts.getMinutes()).padStart(2, '0');
  const ss = String(ts.getSeconds()).padStart(2, '0');
  line.innerHTML = '<span class="log-ts">[' + hh + ':' + mm + ':' + ss + ']</span>' + escapeHtml(msg);
  panel.appendChild(line);
  panel.scrollTop = panel.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatDateTime(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

// ===== 导航切换 =====
function switchPage(pageName) {
  $$('.page').forEach(p => p.classList.remove('active'));
  $$('.nav-item').forEach(n => n.classList.remove('active'));
  const page = document.getElementById('page-' + pageName);
  if (page) page.classList.add('active');
  const nav = $$('.nav-item').find(n => n.dataset.page === pageName);
  if (nav) nav.classList.add('active');
  if (pageName === 'history') refreshHistoryPage();
  if (pageName === 'config') refreshConfigPage();
  if (pageName === 'export') refreshExportPage();
}

function checkBrowserSupport() {
  const warnings = [];
  if (!Serial.isSupported()) {
    warnings.push('当前浏览器不支持 Web Serial API，串口功能不可用。请使用 Chrome/Edge 桌面版。');
  }
  if (!('showDirectoryPicker' in window)) {
    warnings.push('当前浏览器不支持 File System Access API，选择文件夹功能不可用。请使用 Chrome/Edge 桌面版。');
  }
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.protocol !== 'file:') {
    warnings.push('非 HTTPS/localhost 环境下，Web Serial 与文件夹选择 API 可能受限。');
  }
  return warnings;
}

// ===== 项目选择 =====

/**
 * 渲染维度选择区（v3）
 * - platform：下拉（自动读取 AT+QGMR，读出后自动选中；也可手动选）
 * - android_version：下拉（手动，读取方法待定）
 * - customer：下拉（选项随安卓版本联动）
 * - baseline：文本框（自动读取 AT+CGMR，读出后自动填充；可手动修改）
 */
function renderDimensions() {
  const grid = $('#dimension-grid');
  grid.innerHTML = '';
  const dims = ConfigManager.getDimensions();
  for (const d of dims) {
    const item = document.createElement('div');
    item.className = 'dimension-item';
    item.dataset.key = d.key;

    const autoTag = d.auto_read
      ? '<span class="auto-tag">自动读取 ' + escapeHtml(d.auto_read.command) + '</span>'
      : (d.auto_read_hint ? '<span class="auto-tag">' + escapeHtml(d.auto_read_hint) + '</span>' : '');

    let control;
    if (d.key === 'baseline' || (!d.options && !d.options_by)) {
      // 基线：自由文本输入（自动填充，可手改）
      control = '<input type="text" class="input dim-input" data-key="' + d.key + '" ' +
        'placeholder="连接串口后自动读取" value="' + escapeHtml(state.selection[d.key] || '') + '">';
    } else {
      // 下拉：选项固定或联动
      const opts = ConfigManager.getDimOptions(d, state.selection);
      const optHtml = (opts || []).map(o =>
        '<option value="' + escapeHtml(o) + '">' + escapeHtml(o) + '</option>').join('');
      control = '<select class="select dim-select" data-key="' + d.key + '">' +
        '<option value="">（未选择）</option>' + optHtml + '</select>';
    }
    item.innerHTML = '<label>' + escapeHtml(d.label) + autoTag + '</label>' + control;
    grid.appendChild(item);
  }
  bindDimensionEvents();
  syncDimensionUI();
  updateMatchedItems();
}

function bindDimensionEvents() {
  $$('.dim-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const key = sel.dataset.key;
      state.selection[key] = sel.value;
      if (key === 'android_version') {
        // 安卓版本变化 → 刷新分支选项并清空已选分支
        state.selection.customer = '';
        refreshCustomerOptions();
      }
      updateMatchedItems();
    });
  });
  $$('.dim-input').forEach(inp => {
    inp.addEventListener('change', () => {
      state.selection[inp.dataset.key] = inp.value.trim();
      updateMatchedItems();
    });
  });
}

/** 安卓版本变化后刷新分支下拉选项 */
function refreshCustomerOptions() {
  const customerSel = $('.dim-select[data-key="customer"]');
  if (!customerSel) return;
  const dim = ConfigManager.getDimension('customer');
  const opts = ConfigManager.getDimOptions(dim, state.selection) || [];
  customerSel.innerHTML = '<option value="">（未选择）</option>' +
    opts.map(o => '<option value="' + escapeHtml(o) + '">' + escapeHtml(o) + '</option>').join('');
  customerSel.value = '';
  customerSel.disabled = opts.length === 0;
}

/** 把 state.selection 同步到 UI 控件 */
function syncDimensionUI() {
  $$('.dim-select').forEach(sel => {
    sel.value = state.selection[sel.dataset.key] || '';
  });
  $$('.dim-input').forEach(inp => {
    inp.value = state.selection[inp.dataset.key] || '';
  });
  refreshCustomerOptions();
  const customerSel = $('.dim-select[data-key="customer"]');
  if (customerSel && state.selection.customer) {
    customerSel.value = state.selection.customer;
  }
}

/**
 * 更新匹配数展示 + 注意事项（相同备注合并显示）
 * 备注输出格式（按需求文档）：
 *   检查项1、检查项2、检查项3……：（换行）备注xxx
 */
function updateMatchedItems() {
  const items = ConfigManager.getActiveItems(state.selection);
  const dims = ConfigManager.getDimensions();
  // 统计哪些维度还没选
  const missingDims = dims.filter(d => !state.selection[d.key] && (d.options || d.options_by));

  let countText;
  if (missingDims.length > 0) {
    const missingLabels = missingDims.map(d => d.label).join('、');
    countText = '等待选择：' + missingLabels;
  } else {
    countText = '匹配 ' + items.length + ' 个检查项';
  }
  $('#match-count').textContent = countText;

  // 注意事项：相同备注的检查项合并为一条
  const notesBox = $('#notes-box');
  const notesList = $('#notes-list');
  notesList.innerHTML = '';
  const noteGroups = {};
  const noteOrder = [];
  for (const item of items) {
    if (!item.note) continue;
    if (!noteGroups[item.note]) {
      noteGroups[item.note] = [];
      noteOrder.push(item.note);
    }
    noteGroups[item.note].push(item.name);
  }
  if (noteOrder.length > 0) {
    notesBox.style.display = '';
    for (const note of noteOrder) {
      const names = noteGroups[note];
      const div = document.createElement('div');
      div.className = 'note-item';
      div.innerHTML =
        '<div class="note-item-names">' + escapeHtml(names.join('、')) + '：</div>' +
        '<div class="note-item-text">' + escapeHtml(note) + '</div>';
      notesList.appendChild(div);
    }
  } else {
    notesBox.style.display = 'none';
  }

  updateRunButton();
}

function updatePortStatus(connected, name) {
  const val = $('#status-port .status-value');
  val.className = 'status-value ' + (connected ? 'connected' : 'disconnected');
  val.innerHTML = '<span class="dot"></span>' + (connected ? '已连接 ' + name : '未连接');
  $('#btn-connect-port').textContent = connected ? '重新连接' : '连接串口';
  updateRunButton();
}

function updateFolderStatus(connected, name) {
  const val = $('#status-folder .status-value');
  val.className = 'status-value ' + (connected ? 'connected' : 'disconnected');
  val.innerHTML = '<span class="dot"></span>' + (connected ? name : '未选择');
  $('#btn-select-folder').textContent = connected ? '重新选择' : '选择文件夹';
  updateRunButton();
}

function updateRunButton() {
  const activeItems = ConfigManager.getActiveItems(state.selection);
  const ok = state.port && state.dirHandle && activeItems.length > 0;
  $('#btn-run-check').disabled = !ok;
  if (state.port && state.dirHandle && activeItems.length === 0) {
    $('#btn-run-check').textContent = '无匹配检查项';
  } else {
    $('#btn-run-check').textContent = '开始检查';
  }
}

/**
 * 连接串口：选口 → 自动发 AT+QGMR / AT+CGMR 读取平台与基线
 */
async function connectPort() {
  if (!Serial.isSupported()) {
    toast('当前浏览器不支持 Web Serial API，请使用 Chrome/Edge。', 'error');
    return;
  }
  try {
    const port = await Serial.requestPort(state.cfg.serial.port_keyword);
    state.port = port;
    updatePortStatus(true, '已选择');
    logLine('串口已选择，正在自动读取平台名和基线版本 ...', 'ok');
    toast('串口已选择', 'success');
    await autoReadDimensions();
  } catch (e) {
    toast('串口选择失败: ' + e.message, 'error');
    logLine('串口选择失败: ' + e.message, 'err');
  }
}

/**
 * 连接串口后自动读取：平台（AT+QGMR）、基线（AT+CGMR）
 */
async function autoReadDimensions() {
  const dims = ConfigManager.getDimensions();
  const ser = state.cfg.serial;

  for (const d of dims) {
    if (!d.auto_read || !d.auto_read.command) continue;
    const cmd = d.auto_read.command;
    try {
      logLine('发送 ' + cmd + ' ...', 'info');
      const resp = await Serial.sendAT(state.port, cmd, {
        baudrate: ser.baudrate,
        timeout_ms: ser.response_timeout_ms,
      });
      // 原始响应去掉回显和空行后打日志
      const respLines = resp.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.toUpperCase().startsWith('AT+' + cmd.slice(3)));
      if (respLines.length > 0) {
        logLine('  ' + cmd + ' 响应: ' + respLines.join(' | ').substring(0, 300), 'info');
      }
      let value = null;
      if (d.key === 'platform') {
        value = Serial.parseQgmr(resp, d.options || []);
      } else if (d.key === 'baseline') {
        value = Serial.parseCgmr(resp);
      }
      if (value) {
        state.selection[d.key] = value;
        logLine('  解析到 ' + d.label + ': ' + value, 'ok');
      } else {
        logLine('  未能从 ' + cmd + ' 响应中解析 ' + d.label + '，请手动选择/填写', 'warn');
      }
    } catch (e) {
      logLine('  ' + cmd + ' 查询失败: ' + e.message, 'err');
    }
  }
  syncDimensionUI();
  updateMatchedItems();
}

async function selectFolder() {
  if (!('showDirectoryPicker' in window)) {
    toast('当前浏览器不支持文件夹选择，请使用 Chrome/Edge。', 'error');
    return;
  }
  try {
    const handle = await window.showDirectoryPicker();
    await handle.requestPermission({ mode: 'read' });
    state.dirHandle = handle;
    state.dirName = handle.name;
    updateFolderStatus(true, handle.name);
    logLine('项目文件夹已选择: ' + handle.name, 'ok');
    toast('项目文件夹已选择', 'success');
  } catch (e) {
    if (e.name !== 'AbortError') {
      toast('选择文件夹失败: ' + e.message, 'error');
      logLine('选择文件夹失败: ' + e.message, 'err');
    }
  }
}

/**
 * 根据基线版本判断检查文件类型
 * - 基线以 FM_BASE 开头 → FM 基线（.nvm 文件）
 * - 其他（4G_MODEM_ / 5G_MODEM_ 等）→ XML 文件
 * @returns {'fm'|'xml'|null}
 */
function baselineKind(baseline) {
  if (!baseline) return null;
  if (/^FM_BASE/i.test(baseline.trim())) return 'fm';
  return 'xml';
}

/**
 * 核心检查流程（v3）
 */
async function runCheck() {
  $('#btn-run-check').disabled = true;
  $('#result-card').style.display = 'none';
  const panel = $('#log-panel');
  panel.innerHTML = '';
  logLine('开始执行检查 ...', 'step');

  // 打印当前选择
  const dims = ConfigManager.getDimensions();
  const selDesc = dims.map(d => d.label + '=' + (state.selection[d.key] || '未选')).join('，');
  logLine('项目选择: ' + selDesc, 'info');

  // 基线决定检查文件路径，必须有
  const baseline = state.selection.baseline;
  const kind = baselineKind(baseline);
  if (!kind) {
    logLine('基线版本未获取（自动读取失败且未手动填写），无法确定检查文件类型，终止', 'err');
    toast('请先获取/填写基线版本', 'error', 4000);
    updateRunButton();
    return;
  }
  logLine('基线类型: ' + (kind === 'fm' ? 'FM_BASE（.nvm 文件）' : '4G/5G_MODEM（.xml 文件）'), 'info');

  const activeItems = ConfigManager.getActiveItems(state.selection);
  logLine('匹配检查项 ' + activeItems.length + ' 个: ' + activeItems.map(i => i.name).join(', '), 'info');

  if (activeItems.length === 0) {
    logLine('无匹配检查项，终止', 'err');
    toast('无匹配检查项，请调整项目选择', 'warning');
    updateRunButton();
    return;
  }

  const cfg = state.cfg;
  try {
    // 1. AT 查询模块型号
    logLine('[1/3] 查询 AT+QFSGVERSION?  ...', 'step');
    let atFullText = '';
    let module = null;
    try {
      const resp = await Serial.sendAT(state.port, cfg.serial.at_command, {
        baudrate: cfg.serial.baudrate,
        timeout_ms: cfg.serial.response_timeout_ms,
      });
      logLine('收到响应（' + resp.length + ' 字节）', 'info');
      const parsed = Serial.parseQfsgversion(resp);
      atFullText = parsed.atFullText;
      module = parsed.module;
      if (module) {
        logLine('模块型号: ' + module, 'ok');
      } else {
        logLine('响应中未找到 Tag:', 'warn');
      }
    } catch (e) {
      logLine('串口查询失败: ' + e.message, 'err');
      throw e;
    }

    if (!module) {
      throw new Error('未获取到模块型号（Tag 不存在）');
    }

    // 2. 解析文件
    logLine('[2/3] 解析检查文件（' + activeItems.length + ' 个检查项，' + (kind === 'fm' ? '.nvm' : '.xml') + '）...', 'step');
    const results = {};
    let allPass = true;
    let hasChecked = false;
    const missingFiles = new Set();

    for (const item of activeItems) {
      const files = item.files || {};
      const fname = kind === 'fm' ? files.fm : files.xml;
      if (!fname) {
        results[item.name] = { verdict: 'skip', raw: null, value: null, default: item.default, reason: (kind === 'fm' ? 'FM基线' : '4G/5G基线') + '不关注此检查项' };
        logLine('  ' + item.name + '  ' + (kind === 'fm' ? 'FM基线' : '4G/5G基线') + '不关注 -> 跳过', 'warn');
        continue;
      }
      const text = await NvmParser.readFileFromDir(state.dirHandle, fname);
      if (text == null) {
        missingFiles.add(fname);
        results[item.name] = { verdict: 'fail', raw: null, value: null, default: item.default, reason: '文件缺失: ' + fname };
        logLine('  ' + item.name + '  文件 ' + fname + ' 缺失 -> fail', 'err');
        allPass = false;
        continue;
      }
      const raw = NvmParser.parseItemValue(fname, text, item.name);
      const val = NvmParser.normalizeValue(raw);
      const def = NvmParser.normalizeValue(item.default);
      let verdict;
      if (val == null) {
        verdict = 'fail';
        logLine('  ' + item.name + '  在 ' + fname + ' 中未找到或无法解析 -> fail', 'err');
      } else if (val === def) {
        verdict = 'pass';
        logLine('  ' + item.name + '  值=' + (raw || '') + '  默认=' + item.default + '  (' + fname + ') -> pass', 'ok');
      } else {
        verdict = 'fail';
        logLine('  ' + item.name + '  值=' + (raw || '') + '  默认=' + item.default + '  (' + fname + ') -> fail', 'err');
      }
      if (verdict === 'fail') allPass = false;
      hasChecked = true;
      results[item.name] = { verdict, raw, value: val, default: item.default, file: fname };
    }

    if (missingFiles.size > 0) {
      logLine('缺失文件: ' + Array.from(missingFiles).join(', '), 'warn');
    }
    if (!hasChecked) {
      logLine('没有任何实际执行的检查项（全部跳过）', 'warn');
    }

    // 构造 fail 信息（不含 skip）
    const failLines = [];
    for (const item of activeItems) {
      const r = results[item.name];
      if (r && r.verdict === 'fail') {
        failLines.push(item.name + '=' + (r.raw != null ? r.raw : '未找到'));
      }
    }

    // 3. 写入数据库
    logLine('[3/3] 保存到本地数据库 ...', 'step');
    const record = {
      module,
      at_version: atFullText,
      results,
      fail_text: failLines.join('\n'),
      overall: allPass ? 'pass' : 'fail',
      timestamp: Date.now(),
      project: state.dirName,
      selection: { ...state.selection },
      baseline_kind: kind,
      item_names: activeItems.map(i => i.name),
    };
    const id = await DB.addRecord(record);
    logLine('记录已保存（id=' + id + '）', 'ok');
    logLine('=================================', 'info');
    logLine('检查完成，总体结果: ' + (allPass ? 'PASS ✓' : 'FAIL ✗'), allPass ? 'ok' : 'err');

    showResultCard(record, activeItems);
    toast('检查完成: ' + (allPass ? 'PASS' : 'FAIL'), allPass ? 'success' : 'warning');
  } catch (e) {
    logLine('检查失败: ' + e.message, 'err');
    console.error(e);
    toast('检查失败: ' + e.message, 'error', 4000);
  } finally {
    updateRunButton();
  }
}

function showResultCard(rec, activeItems) {
  const card = $('#result-card');
  card.style.display = '';
  const badge = $('#result-badge');
  badge.textContent = rec.overall.toUpperCase();
  badge.className = 'badge ' + rec.overall;
  $('#result-module').textContent = rec.module;
  $('#result-time').textContent = formatDateTime(rec.timestamp);

  const itemsBox = $('#result-items');
  itemsBox.innerHTML = '';
  (activeItems || []).forEach(item => {
    const r = rec.results[item.name] || { verdict: 'skip' };
    const chip = document.createElement('div');
    const cls = r.verdict === 'skip' ? 'pass' : r.verdict;
    chip.className = 'result-chip ' + cls;
    if (r.verdict === 'skip') {
      chip.style.opacity = '0.5';
      chip.style.background = '#f3f4f6';
      chip.style.borderColor = '#e5e7eb';
      chip.style.color = '#6b7280';
    }
    const noteHtml = item.note ? '<div class="chip-note-inline">ⓘ ' + escapeHtml(item.note) + '</div>' : '';
    const valText = r.reason
      ? escapeHtml(r.reason)
      : '实际=' + escapeHtml(r.raw != null ? r.raw : '未找到') + '  默认=' + escapeHtml(item.default) +
        (r.file ? '  [' + escapeHtml(r.file) + ']' : '');
    chip.innerHTML = '<div class="chip-name">' + escapeHtml(item.name) + ' <b>' + r.verdict.toUpperCase() + '</b></div>' +
      '<div class="chip-val">' + valText + '</div>' + noteHtml;
    itemsBox.appendChild(chip);
  });

  if (rec.at_version) {
    $('#result-at-box').style.display = '';
    $('#result-at').textContent = rec.at_version;
  } else {
    $('#result-at-box').style.display = 'none';
  }
}

// ===== 历史记录页面 =====

async function refreshHistoryPage() {
  applyHistoryFilter();
}

async function applyHistoryFilter() {
  const kw = $('#filter-module').value.trim();
  const result = $('#filter-result').value;
  const from = $('#filter-date-from').value;
  const to = $('#filter-date-to').value;
  state.historyFiltered = await DB.queryRecords({
    moduleKeyword: kw, result, dateFrom: from, dateTo: to,
  });
  state.historyPage = 1;
  renderHistoryTable();
}

function renderHistoryTable() {
  const tbody = $('#history-tbody');
  tbody.innerHTML = '';
  const total = state.historyFiltered.length;
  const pageSize = state.pageSize;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (state.historyPage > totalPages) state.historyPage = totalPages;
  const start = (state.historyPage - 1) * pageSize;
  const pageData = state.historyFiltered.slice(start, start + pageSize);

  if (pageData.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#9ca3af;padding:30px">暂无记录</td></tr>';
  } else {
    pageData.forEach(rec => {
      const tr = document.createElement('tr');
      // 展示选择信息（平台/安卓/分支/基线）
      const selText = rec.selection ? Object.entries(rec.selection).filter(([, v]) => v).map(([k, v]) => k + '=' + v).join('，') : '';
      tr.innerHTML =
        '<td><input type="checkbox" class="chk-hist" data-id="' + rec.id + '"></td>' +
        '<td>' + escapeHtml(rec.module || '-') + (selText ? '<br><span style="font-size:11px;color:#9ca3af">' + escapeHtml(selText) + '</span>' : '') + '</td>' +
        '<td><span class="cell-' + rec.overall + '">' + rec.overall.toUpperCase() + '</span></td>' +
        '<td class="cell-fail-text">' + escapeHtml(rec.fail_text || '-') + '</td>' +
        '<td>' + formatDateTime(rec.timestamp) + '</td>' +
        '<td><button class="link-btn" data-action="detail" data-id="' + rec.id + '">详情</button>' +
        '<button class="link-btn danger" data-action="delete" data-id="' + rec.id + '">删除</button></td>';
      tbody.appendChild(tr);
    });
  }

  renderPagination($('#history-pagination'), state.historyPage, totalPages, (p) => {
    state.historyPage = p;
    renderHistoryTable();
  });

  $('#chk-select-all').checked = false;
  $('#btn-delete-selected').disabled = true;
  $('#btn-export-selected').disabled = true;
}

function renderPagination(container, cur, total, onGo) {
  container.innerHTML = '';
  const btn = (label, page, disabled, active) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (disabled) b.disabled = true;
    if (active) b.classList.add('active');
    b.onclick = () => onGo(page);
    container.appendChild(b);
  };
  btn('‹', cur - 1, cur <= 1);
  let start = Math.max(1, cur - 2);
  let end = Math.min(total, start + 4);
  start = Math.max(1, end - 4);
  for (let p = start; p <= end; p++) btn(String(p), p, false, p === cur);
  btn('›', cur + 1, cur >= total);
  container.appendChild(document.createTextNode('  共 ' + state.historyFiltered.length + ' 条'));
}

// ===== 配置管理页面 =====

function refreshConfigPage() {
  const cfg = ConfigManager.get();
  const hasLocal = ConfigManager.hasLocal();

  const label = $('#config-source-label');
  if (hasLocal) {
    label.textContent = '当前使用: 本地配置（已覆盖云端默认）';
    label.className = 'config-status local';
  } else {
    label.textContent = '当前使用: 云端默认配置';
    label.className = 'config-status cloud';
  }

  $('#cfg-port-keyword').value = cfg.serial.port_keyword;
  $('#cfg-baudrate').value = cfg.serial.baudrate;
  $('#cfg-at-command').value = cfg.serial.at_command;
  $('#cfg-timeout').value = cfg.serial.response_timeout_ms;

  renderItemsTable(cfg);
}

function formatConditions(cond) {
  if (!cond || Object.keys(cond).length === 0) {
    return '<span class="cond-desc">所有（无条件）</span>';
  }
  const labelMap = {};
  ConfigManager.getDimensions().forEach(d => { labelMap[d.key] = d.label; });
  const parts = Object.entries(cond).map(([k, vals]) => {
    const lbl = labelMap[k] || k;
    return '<span class="cond-key">' + escapeHtml(lbl) + '</span>=<span class="cond-val">[' + vals.map(escapeHtml).join(', ') + ']</span>';
  });
  return '<div class="cond-desc">' + parts.join('<br>') + '</div>';
}

function renderItemsTable(cfg) {
  const tbody = $('#items-tbody');
  tbody.innerHTML = '';
  const items = cfg.items || [];
  items.forEach(item => {
    const files = item.files || {};
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td><input type="text" class="inp-item-name" value="' + escapeHtml(item.name) + '"></td>' +
      '<td><input type="text" class="inp-item-def" value="' + escapeHtml(item.default) + '" style="font-family:Consolas,monospace"></td>' +
      '<td><input type="text" class="inp-item-fm" value="' + escapeHtml(files.fm || '') + '" placeholder="不关注可留空"></td>' +
      '<td><input type="text" class="inp-item-xml" value="' + escapeHtml(files.xml || '') + '" placeholder="不关注可留空"></td>' +
      '<td>' + formatConditions(item.conditions) + '</td>' +
      '<td><input type="text" class="inp-item-note" value="' + escapeHtml(item.note || '') + '" placeholder="无备注" style="font-size:11px"></td>' +
      '<td><button class="link-btn danger btn-remove-item">删除</button></td>';
    tbody.appendChild(tr);
  });
}

function collectConfigFromForm() {
  const cfg = ConfigManager.get(); // 保留 dimensions/serial 等
  const newItems = [];
  $$('#items-tbody tr').forEach(tr => {
    const name = tr.querySelector('.inp-item-name').value.trim();
    const def = tr.querySelector('.inp-item-def').value.trim();
    const fm = tr.querySelector('.inp-item-fm').value.trim();
    const xml = tr.querySelector('.inp-item-xml').value.trim();
    const noteInput = tr.querySelector('.inp-item-note');
    const note = noteInput ? noteInput.value.trim() : '';
    if (!name) return;
    // 保留原 item 的 conditions
    const orig = (cfg.items || []).find(i => i.name === name);
    newItems.push({
      name,
      default: def,
      files: { fm: fm || null, xml: xml || null },
      conditions: orig ? orig.conditions : {},
      note: note || undefined,
    });
  });
  cfg.items = newItems;
  cfg.serial = {
    port_keyword: $('#cfg-port-keyword').value.trim() || 'SPRD LTE AT(WIQ)',
    baudrate: parseInt($('#cfg-baudrate').value) || 115200,
    at_command: $('#cfg-at-command').value.trim() || 'AT+QFSGVERSION?',
    response_timeout_ms: parseInt($('#cfg-timeout').value) || 2000,
  };
  cfg.updated_at = new Date().toISOString().slice(0, 10);
  return cfg;
}

// ===== 批量导出页面 =====

async function refreshExportPage() {
  state.expFiltered = await DB.queryRecords({});
  renderExportTable();
}

async function applyExportFilter() {
  const kw = $('#exp-filter-module').value.trim();
  const from = $('#exp-date-from').value;
  const to = $('#exp-date-to').value;
  state.expFiltered = await DB.queryRecords({ moduleKeyword: kw, dateFrom: from, dateTo: to });
  renderExportTable();
}

function renderExportTable() {
  const tbody = $('#export-tbody');
  tbody.innerHTML = '';
  const list = state.expFiltered;
  $('#exp-count').textContent = '共 ' + list.length + ' 条';
  $('#btn-export-all').disabled = list.length === 0;
  $('#exp-chk-all').checked = false;
  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#9ca3af;padding:30px">暂无记录</td></tr>';
    return;
  }
  list.forEach(rec => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td><input type="checkbox" class="chk-exp" data-id="' + rec.id + '"></td>' +
      '<td>' + escapeHtml(rec.module || '-') + '</td>' +
      '<td><span class="cell-' + rec.overall + '">' + rec.overall.toUpperCase() + '</span></td>' +
      '<td class="cell-fail-text">' + escapeHtml(rec.fail_text || '-') + '</td>' +
      '<td>' + formatDateTime(rec.timestamp) + '</td>';
    tbody.appendChild(tr);
  });
}

function getCheckedIds(cls) {
  return $$('.' + cls + ':checked').map(c => parseInt(c.dataset.id));
}

// ===== 事件绑定 =====
function bindEvents() {
  $$('.nav-item').forEach(n => {
    n.addEventListener('click', () => switchPage(n.dataset.page));
  });

  $('#btn-connect-port').addEventListener('click', connectPort);
  $('#btn-select-folder').addEventListener('click', selectFolder);
  $('#btn-run-check').addEventListener('click', runCheck);

  $('#btn-filter-apply').addEventListener('click', applyHistoryFilter);
  $('#btn-filter-reset').addEventListener('click', () => {
    $('#filter-module').value = '';
    $('#filter-result').value = '';
    $('#filter-date-from').value = '';
    $('#filter-date-to').value = '';
    applyHistoryFilter();
  });
  $('#chk-select-all').addEventListener('change', (e) => {
    $$('.chk-hist').forEach(c => c.checked = e.target.checked);
    updateHistActionButtons();
  });
  $('#history-tbody').addEventListener('change', (e) => {
    if (e.target.classList.contains('chk-hist')) updateHistActionButtons();
  });
  $('#history-tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = parseInt(btn.dataset.id);
    if (btn.dataset.action === 'delete') {
      if (confirm('确定删除这条记录吗？')) {
        await DB.deleteRecords([id]);
        toast('已删除', 'success');
        applyHistoryFilter();
      }
    } else if (btn.dataset.action === 'detail') {
      const recs = await DB.getRecordsByIds([id]);
      if (recs[0]) showRecordDetail(recs[0]);
    }
  });
  $('#btn-delete-selected').addEventListener('click', async () => {
    const ids = getCheckedIds('chk-hist');
    if (ids.length === 0) return;
    if (confirm('确定删除选中的 ' + ids.length + ' 条记录吗？')) {
      await DB.deleteRecords(ids);
      toast('已删除 ' + ids.length + ' 条', 'success');
      applyHistoryFilter();
    }
  });
  $('#btn-export-selected').addEventListener('click', async () => {
    const ids = getCheckedIds('chk-hist');
    if (ids.length === 0) return;
    try {
      const recs = await DB.getRecordsByIds(ids);
      const fname = await ExcelExport.exportRecords(recs, state.cfg);
      toast('已导出: ' + fname, 'success');
    } catch (e) {
      toast('导出失败: ' + e.message, 'error');
    }
  });

  $('#btn-refresh-default').addEventListener('click', async () => {
    await ConfigManager.refreshCloud();
    state.cfg = ConfigManager.get();
    refreshConfigPage();
    renderDimensions();
    toast('已刷新云端默认配置', 'success');
  });
  $('#btn-reset-default').addEventListener('click', () => {
    if (confirm('确定恢复云端默认配置吗？本地修改将全部丢失。')) {
      ConfigManager.resetToCloud();
      state.cfg = ConfigManager.get();
      refreshConfigPage();
      renderDimensions();
      toast('已恢复云端默认', 'success');
    }
  });
  $('#btn-add-item').addEventListener('click', () => {
    const tbody = $('#items-tbody');
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td><input type="text" class="inp-item-name" value="" placeholder="item_name"></td>' +
      '<td><input type="text" class="inp-item-def" value="0x0" style="font-family:Consolas,monospace"></td>' +
      '<td><input type="text" class="inp-item-fm" value="" placeholder="不关注可留空"></td>' +
      '<td><input type="text" class="inp-item-xml" value="" placeholder="不关注可留空"></td>' +
      '<td><span class="cond-desc">所有（无条件）</span></td>' +
      '<td><input type="text" class="inp-item-note" value="" placeholder="无备注" style="font-size:11px"></td>' +
      '<td><button class="link-btn danger btn-remove-item">删除</button></td>';
    tbody.appendChild(tr);
    tr.querySelector('.inp-item-name').focus();
  });
  $('#items-tbody').addEventListener('click', (e) => {
    if (e.target.classList.contains('btn-remove-item')) {
      if (confirm('确定删除这个检查项吗？')) {
        e.target.closest('tr').remove();
      }
    }
  });
  $('#btn-save-config').addEventListener('click', () => {
    const newCfg = collectConfigFromForm();
    if (newCfg.items.length === 0) {
      toast('至少保留一个检查项', 'error');
      return;
    }
    ConfigManager.saveLocal(newCfg);
    state.cfg = ConfigManager.get();
    toast('配置已保存到本地', 'success');
    refreshConfigPage();
    renderDimensions();
  });

  $('#btn-exp-search').addEventListener('click', applyExportFilter);
  $('#exp-chk-all').addEventListener('change', (e) => {
    $$('.chk-exp').forEach(c => c.checked = e.target.checked);
  });
  $('#btn-export-all').addEventListener('click', async () => {
    if (state.expFiltered.length === 0) return;
    try {
      const fname = await ExcelExport.exportRecords(state.expFiltered, state.cfg);
      toast('已导出 ' + state.expFiltered.length + ' 条: ' + fname, 'success');
    } catch (e) {
      toast('导出失败: ' + e.message, 'error');
    }
  });
}

function updateHistActionButtons() {
  const cnt = getCheckedIds('chk-hist').length;
  $('#btn-delete-selected').disabled = cnt === 0;
  $('#btn-export-selected').disabled = cnt === 0;
}

function showRecordDetail(rec) {
  const lines = [];
  lines.push('模块型号: ' + rec.module);
  lines.push('检查时间: ' + formatDateTime(rec.timestamp));
  lines.push('总体结果: ' + rec.overall.toUpperCase());
  if (rec.selection) {
    const labelMap = {};
    ConfigManager.getDimensions().forEach(d => { labelMap[d.key] = d.label; });
    lines.push('');
    lines.push('项目选择:');
    for (const [k, v] of Object.entries(rec.selection)) {
      if (v) lines.push('  ' + (labelMap[k] || k) + ' = ' + v);
    }
  }
  lines.push('');
  if (rec.item_names) {
    const cfgItems = (state.cfg && state.cfg.items) || [];
    lines.push('检查项 (' + rec.item_names.length + ' 个):');
    for (const name of rec.item_names) {
      const r = rec.results ? rec.results[name] : null;
      const item = cfgItems.find(i => i.name === name);
      if (r) {
        lines.push('  ' + name + ': ' + r.verdict.toUpperCase() +
          ' (实际=' + (r.raw != null ? r.raw : '未找到') + ', 默认=' + r.default +
          (r.file ? ', 文件=' + r.file : '') + ')');
        if (item && item.note) {
          lines.push('    备注: ' + item.note);
        }
      } else {
        lines.push('  ' + name + ': (无结果)');
      }
    }
  }
  if (rec.fail_text) {
    lines.push('');
    lines.push('fail信息:');
    lines.push(rec.fail_text);
  }
  if (rec.at_version) {
    lines.push('');
    lines.push('AT+QFSGVERSION? 响应:');
    lines.push(rec.at_version);
  }
  alert(lines.join('\n'));
}

// ===== 初始化 =====
async function init() {
  bindEvents();

  const warnings = checkBrowserSupport();
  if (warnings.length > 0) {
    warnings.forEach(w => toast(w, 'warning', 6000));
  }

  logLine('正在加载配置 ...', 'info');
  try {
    state.cfg = await ConfigManager.init();
    logLine('配置加载完成（v' + state.cfg.version + '，' + (state.cfg.items || []).length + ' 个检查项，' + (state.cfg.dimensions || []).length + ' 个维度）', 'ok');
    if (ConfigManager.hasLocal()) {
      logLine('使用本地配置覆盖', 'warn');
    } else {
      logLine('使用云端默认配置', 'info');
    }
  } catch (e) {
    logLine('配置加载失败: ' + e.message, 'err');
    state.cfg = ConfigManager.get();
  }

  // 初始化项目选择
  Object.assign(state.selection, ConfigManager.getDefaultSelection());
  renderDimensions();

  try {
    const ports = await Serial.listPorts();
    if (ports.length > 0) {
      state.port = ports[0];
      updatePortStatus(true, '已记住');
      logLine('检测到上次已授权的串口，可点击"重新连接"读取平台/基线', 'ok');
    }
  } catch (e) { /* ignore */ }

  updateRunButton();
  logLine('就绪。请连接串口（自动读取平台/基线）、选择安卓版本和分支、选择文件夹后点击"开始检查"。', 'info');
}

document.addEventListener('DOMContentLoaded', init);
