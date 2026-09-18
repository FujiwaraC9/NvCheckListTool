/**
 * SVN 版本验证模块
 *
 * 流程：
 *   1. 首次使用登录移远 SVN 账号（Basic 认证，token 存在本机浏览器）
 *   2. 经本地服务 /api/svn 代理拉取 SVN 上的 Auto_Smart_FSG_Check.xlsx（绕过 CORS）
 *   3. 用设备 AT+QFSGVERSION? 的 Tag 在所选 sheet 的「FSG TAG」列定位行
 *   4. 取该行「最新版本」单元格中的 SW/RF/Date，与设备读取值严格逐项比对
 *
 * 注意：本功能为手动触发，不参与一键检查的自动化流程。
 */
const SvnCheck = (function () {
  // SVN 上的 FSG 检查跟踪表（内置链接，自动读取，不走下载）
  const SVN_URL = 'https://svn.quectel.com/svn/项目管理/软件二部/release_fsg/Auto_Smart_FSG_Check.xlsx';

  const AUTH_KEY = 'svn_auth_token';   // base64(user:pass)
  const USER_KEY = 'svn_auth_user';   // 记住用户名

  // ===== 客户版本 ↔ 表格 sheet 全量映射表 =====
  // 来源：SVN 表格「客户代码」页（本地存档 客户代码.xlsx，共 51 家，已去重）。
  // name: 客户名称；abbr: 原英文缩写别名；code: 客户代码（FSG TAG 版本段 / sheet 名可能使用）。
  // 注意：本工具检查项目前仅涉及 公版/飞天/新大陆定制，其余条目为提前做好的一一对应，
  //       供解析匹配使用，不会出现在检查项选择列表中。
  const CUSTOMER_TABLE = [
    { name: '海能达', abbr: ['HND'], code: 'CZV' },
    { name: '优克联', abbr: ['YKL'], code: 'BQD' },
    { name: '科立讯', abbr: ['KLX'], code: 'BUK' },
    { name: '新大陆', abbr: ['NL'], code: 'NL' },
    { name: '索信', abbr: ['SX'], code: 'BHV' },
    { name: '商米', abbr: ['SM'], code: 'BCJ' },
    { name: '升腾', abbr: ['ST'], code: 'BHU' },
    { name: '博泰', abbr: ['PT'], code: 'BAA' },
    { name: '海康', abbr: ['HK'], code: 'HK' },
    { name: '软银', abbr: ['SBK'], code: 'SBK' },
    { name: '惠尔丰', abbr: ['VF'], code: 'BBA' },
    { name: '虹堡', abbr: ['CT'], code: 'CT' },
    { name: '定宜', abbr: ['DY'], code: 'DY' },
    { name: '鸿译', abbr: ['honglink'], code: 'EMT' },           // 原表：鸿译(honglink)
    { name: '飞天信达', abbr: ['Ftsafe'], code: 'RDU' },
    { name: '速鼎', abbr: ['SD'], code: 'SD' },
    { name: '天波', abbr: ['TP'], code: 'TP' },
    { name: '华智融', abbr: ['HZR'], code: 'BAD' },
    { name: '新国都', abbr: ['BDA'], code: 'BDA' },
    { name: '联迪', abbr: ['LD'], code: 'LD' },
    { name: '微智', abbr: ['WZ'], code: 'FPR' },
    { name: '沃特沃德', abbr: ['WOTE'], code: 'SDP' },
    { name: '禾苗', abbr: ['HM'], code: 'EFQ' },
    { name: '追觅', abbr: ['CNH'], code: 'CNH' },
    { name: 'ULW Czech, s.r.o.', abbr: [], code: 'RGR' },
    { name: 'TCI Aircraft Interiors', abbr: [], code: 'DDA' },
    { name: 'AI Matics Co., Ltd.', abbr: [], code: 'ECT' },
    { name: '中兴高达', abbr: ['ZXGD'], code: 'SFM' },
    { name: '小牛', abbr: [], code: 'DDP' },
    { name: 'ZCS', abbr: [], code: 'SCN' },
    { name: '零零科技', abbr: ['DWZ'], code: 'DWZ' },
    { name: '灵宇宙', abbr: ['LYZ'], code: 'SSX' },
    { name: '威比', abbr: ['WB'], code: 'DJM' },
    { name: '荣耀', abbr: ['FMY'], code: 'FMY' },
    { name: '易听', abbr: ['YT'], code: 'SDF' },
    { name: '玛塔', abbr: ['FTG'], code: 'FTG' },
    { name: 'NetPrisma', abbr: [], code: 'CHC' },
    { name: 'Eagle Wireless Holdings, Inc.', abbr: ['eagle'], code: 'FGN' },
    { name: '奥佳华', abbr: [], code: 'EWY' },
    { name: '汉朔', abbr: [], code: 'CCA' },
    { name: 'JCI', abbr: [], code: 'BQA' },
    { name: '邦邦', abbr: [], code: 'FPN' },
    { name: '蔚蓝', abbr: [], code: 'BVC' },
    { name: '魔方', abbr: [], code: 'BHT' },
    { name: '冠捷', abbr: [], code: 'SSA' },
    { name: 'Lantronix Inc', abbr: [], code: 'CMJ' },
    { name: '优思美地', abbr: [], code: 'DVA' },
    { name: '黑芝麻', abbr: [], code: 'ECW' },
    { name: '移远', abbr: [], code: 'Quectel' },
    { name: '英伟达', abbr: [], code: 'FGA' },
  ];

  /**
   * 把本地选择的客户版本名（如 新大陆定制 / 飞天）解析为客户表条目。
   * 匹配优先级：名称全等 > 表名⊂所选名（新大陆⊂新大陆定制）> 缩写/代码全等 > 所选名⊂表名（飞天⊂飞天信达）。
   * 「公版」等非客户项不在表中，返回 null（由调用方按所选名直接匹配 sheet）。
   */
  function resolveCustomer(selection) {
    const s = String(selection || '').trim().toLowerCase();
    if (!s) return null;
    let hit = CUSTOMER_TABLE.find(e => e.name.toLowerCase() === s);
    if (hit) return hit;
    hit = CUSTOMER_TABLE.find(e => s.includes(e.name.toLowerCase()));
    if (hit) return hit;
    // 缩写/代码全等须先于"所选名⊂表名"，避免 2 位代码被英文公司名误包含（如 TP⊂neTPrisma）
    hit = CUSTOMER_TABLE.find(e =>
      (e.abbr || []).some(a => a.toLowerCase() === s) ||
      String(e.code || '').toLowerCase() === s);
    if (hit) return hit;
    hit = CUSTOMER_TABLE.find(e => e.name.toLowerCase().includes(s));
    return hit || null;
  }

  /** 客户条目用于 sheet 名匹配的全部别名（名称 + 英文缩写 + 客户代码） */
  function customerSheetAliases(entry) {
    if (!entry) return [];
    const arr = [entry.name];
    (entry.abbr || []).forEach(a => { if (a) arr.push(a); });
    if (entry.code) arr.push(String(entry.code));
    return arr;
  }

  let workbook = null;    // ExcelJS workbook
  let sheetNames = [];    // 可用于检查的 sheet 名
  let meta = null;        // SVN 文件属性 { revision, author, date, size }
  let device = null;      // { tag, sw, rf, date, raw }

  // ===== 账号认证 =====
  function getToken() {
    try { return localStorage.getItem(AUTH_KEY) || ''; } catch (e) { return ''; }
  }
  function getUser() {
    try { return localStorage.getItem(USER_KEY) || ''; } catch (e) { return ''; }
  }
  function setAuth(user, pass) {
    const token = btoa(unescape(encodeURIComponent(user + ':' + pass)));
    localStorage.setItem(AUTH_KEY, token);
    localStorage.setItem(USER_KEY, user);
  }
  function clearAuth() {
    localStorage.removeItem(AUTH_KEY);
    localStorage.removeItem(USER_KEY);
  }
  function hasAuth() { return !!getToken(); }

  /**
   * 自绘登录弹窗，返回 {user, pass} 或 null（取消）
   */
  function loginDialog() {
    return new Promise(resolve => {
      const savedUser = getUser();
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML =
        '<div class="modal-box" style="max-width:380px">' +
        '<div class="modal-header"><span class="modal-icon info">i</span>' +
        '<span class="modal-title">登录 SVN 账号</span></div>' +
        '<div class="modal-body">' +
        '<p class="config-hint" style="margin:0 0 12px">请输入移远 SVN 账号以访问版本跟踪表，信息仅保存在本机浏览器。</p>' +
        '<div class="form-item" style="margin-bottom:10px"><label>账号</label>' +
        '<input type="text" class="input" id="svn-login-user" autocomplete="username" value=""></div>' +
        '<div class="form-item" style="margin-bottom:4px"><label>密码</label>' +
        '<input type="password" class="input" id="svn-login-pass" autocomplete="current-password"></div>' +
        '<div class="svn-login-err" id="svn-login-err" style="color:var(--danger,#e5484d);font-size:12px;min-height:16px;margin-top:4px"></div>' +
        '</div>' +
        '<div class="modal-footer">' +
        '<button class="btn" id="svn-login-cancel">取消</button>' +
        '<button class="btn btn-primary" id="svn-login-ok">登录</button>' +
        '</div></div>';
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add('show'));

      const userInput = overlay.querySelector('#svn-login-user');
      const passInput = overlay.querySelector('#svn-login-pass');
      const errBox = overlay.querySelector('#svn-login-err');
      userInput.value = savedUser || '';
      setTimeout(() => (savedUser ? passInput : userInput).focus(), 50);

      function close(val) {
        overlay.classList.remove('show');
        setTimeout(() => overlay.remove(), 200);
        document.removeEventListener('keydown', onKey);
        resolve(val);
      }
      function onKey(e) {
        if (e.key === 'Escape') close(null);
        if (e.key === 'Enter') doLogin();
      }
      async function doLogin() {
        const user = userInput.value.trim();
        const pass = passInput.value;
        if (!user || !pass) { errBox.textContent = '请输入账号和密码'; return; }
        const okBtn = overlay.querySelector('#svn-login-ok');
        okBtn.disabled = true;
        errBox.textContent = '正在验证...';
        setAuth(user, pass);
        try {
          await fetchWorkbook(true);
          close({ user, pass });
        } catch (e) {
          clearAuth();  // 验证失败不保留坏 token，避免下次进入页面处于"假已登录"状态
          errBox.textContent = /401|认证|账号/.test(e.message) ? '账号或密码错误' : ('验证失败：' + e.message);
          okBtn.disabled = false;
        }
      }
      overlay.querySelector('#svn-login-ok').addEventListener('click', doLogin);
      overlay.querySelector('#svn-login-cancel').addEventListener('click', () => close(null));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
      document.addEventListener('keydown', onKey);
    });
  }

  // ===== 拉取 Excel（经本地代理） =====
  /**
   * @param {boolean} force 是否强制重新拉取（不复用缓存）
   * @returns {Promise<ExcelJS.Workbook>}
   */
  async function fetchWorkbook(force) {
    if (workbook && !force) return workbook;
    if (!hasAuth()) throw new Error('未登录 SVN 账号');
    if (location.protocol === 'file:') {
      throw new Error('当前为 file:// 直开模式，无法使用 SVN 代理，请通过 launch.bat 启动');
    }
    const url = location.origin + '/api/svn?url=' + encodeURIComponent(SVN_URL);
    const resp = await fetch(url, {
      headers: { Authorization: 'Basic ' + getToken() },
      cache: 'no-store',
    });
    if (resp.status === 401) {
      clearAuth();
      throw new Error('SVN 认证失败（账号或密码错误）');
    }
    if (!resp.ok) {
      let msg = 'HTTP ' + resp.status;
      try { const j = await resp.json(); if (j && j.error) msg = j.error; } catch (e) { /* ignore */ }
      throw new Error(msg);
    }
    const buf = await resp.arrayBuffer();
    if (typeof ExcelJS === 'undefined') throw new Error('ExcelJS 库未加载');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    workbook = wb;
    sheetNames = buildSheetList(wb);
    // 顺带只读获取 SVN 版本属性（失败置空，不阻断版本检查主流程）
    try { meta = await fetchSvnMeta(); } catch (e) { meta = null; }
    return wb;
  }

  /** 发送一个只读 PROPFIND，返回响应 XML 文本 */
  async function propfind(targetUrl, propsXml, depth) {
    const url = location.origin + '/api/svn?url=' + encodeURIComponent(targetUrl);
    const body =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<propfind xmlns="DAV:"><prop>' + propsXml + '</prop></propfind>';
    const resp = await fetch(url, {
      method: 'PROPFIND',
      headers: {
        Authorization: 'Basic ' + getToken(),
        'Content-Type': 'text/xml; charset=utf-8',
        Depth: depth || '0',
      },
      body,
      cache: 'no-store',
    });
    if (resp.status === 401) throw new Error('SVN 认证失败（账号或密码错误）');
    if (!resp.ok) throw new Error('PROPFIND HTTP ' + resp.status);
    return resp.text();
  }

  /**
   * 以 WebDAV PROPFIND（只读，两步）读取该文件在 SVN 上的活属性：
   * 版本号 revision、最后修改者 author、最后修改时间 date、文件大小 size。
   *
   * 关键点：SVN 自定义的 version-name / creator-displayname 挂在文件的“版本资源
   * (!svn/ver/<rev>/...)”上，而非工作文件 URL；标准的 getlastmodified / getcontentlength
   * 才在文件 URL 上。因此：
   *   第 1 步：PROPFIND 文件 URL，取 checked-in（指向版本资源）+ 标准属性，从 href 解析 revision；
   *   第 2 步：PROPFIND 版本资源 URL，取 creator-displayname（author）。
   * 全程仅查询属性，绝不修改/提交。
   */
  async function fetchSvnMeta() {
    if (!hasAuth()) throw new Error('未登录 SVN 账号');
    if (location.protocol === 'file:') throw new Error('file:// 模式不可用');

    // 注意：version-name / creator-displayname / checked-in 都是标准 DeltaV 的 DAV: 命名空间
    // 活属性（不是 SVN 自定义命名空间）；只有它们在版本资源上，文件 URL 上通常返回 404。
    const svnProps =
      '<checked-in xmlns="DAV:"/>' +
      '<version-name xmlns="DAV:"/>' +
      '<creator-displayname xmlns="DAV:"/>';
    const stdProps = '<getlastmodified xmlns="DAV:"/><getcontentlength xmlns="DAV:"/>';

    // 第 1 步：文件 URL
    const xml1 = await propfind(SVN_URL, svnProps + stdProps, '0');
    const m1 = parseSvnPropfind(xml1);
    const result = {
      revision: m1.revision,
      author: m1.author,
      date: m1.date,
      dateRaw: m1.dateRaw,
      size: m1.size,
      sizeText: m1.sizeText,
      versionUrl: m1.checkedInHref ? resolveSvnUrl(m1.checkedInHref) : '',
    };

    // 第 2 步：版本资源（补 revision / author）
    if (result.versionUrl) {
      try {
        const xml2 = await propfind(result.versionUrl,
          '<version-name xmlns="DAV:"/>' +
          '<creator-displayname xmlns="DAV:"/>' +
          '<creationdate xmlns="DAV:"/>', '0');
        const m2 = parseSvnPropfind(xml2);
        if (!result.revision && m2.revision) result.revision = m2.revision;
        if (!result.author && m2.author) result.author = m2.author;
        if (!result.date && m2.date) { result.date = m2.date; result.dateRaw = m2.dateRaw; }
      } catch (e) { /* 版本资源查询失败不致命，已有标准属性兜底 */ }
    }

    meta = {
      revision: result.revision || '',
      author: result.author || '',
      date: result.date || '',
      dateRaw: result.dateRaw || '',
      size: result.size || '',
      sizeText: result.sizeText || '',
    };
    return meta;
  }

  /** 把 checked-in 返回的 href（可能是绝对/相对路径）解析为可访问的版本资源绝对 URL */
  function resolveSvnUrl(href) {
    const h = String(href || '').trim();
    if (!h) return '';
    if (/^https?:\/\//i.test(h)) return h;
    const base = new URL(SVN_URL);
    if (h.charAt(0) === '/') return base.origin + h;
    // 相对路径：相对当前文件所在目录
    return new URL(h, SVN_URL).href;
  }

  /** 解析 SVN PROPFIND 多状态响应，取出 revision/author/date/size/checkedInHref（命名空间无关） */
  function parseSvnPropfind(xmlText) {
    const vals = extractDavProps(xmlText);
    // checked-in 指向版本资源 !svn/ver/<rev>/...
    const checkedInHref = vals.checkedInHref || '';
    // 版本号：优先 version-name；否则从 checked-in href 的 !svn/ver/<数字> 提取
    let revision = vals.versionName || (checkedInHref ? getHrefRevision(checkedInHref) : '');
    const author = vals.creatorDisplayname || '';
    const dateRaw = vals.getlastmodified || vals.creationdate || '';
    const size = vals.getcontentlength || '';

    return {
      checkedInHref,
      revision: revision || '',
      author,
      date: dateRaw ? formatSvnDate(dateRaw) : '',
      dateRaw,
      size,
      sizeText: size ? formatFileSize(parseInt(size, 10)) : '',
    };
  }

  /**
   * 命名空间无关地提取 DAV 属性。
   * 浏览器用 DOMParser 遍历；无 DOMParser 时（Node 测试）退化为正则。
   * 返回 { versionName, creatorDisplayname, getlastmodified, getcontentlength, creationdate, checkedInHref }
   */
  function extractDavProps(xml) {
    const out = {
      versionName: '', creatorDisplayname: '', getlastmodified: '',
      getcontentlength: '', creationdate: '', checkedInHref: '',
    };
    if (typeof DOMParser !== 'undefined') {
      try {
        const doc = new DOMParser().parseFromString(xml, 'application/xml');
        const local = el => el.localName || el.tagName.replace(/^.*:/, '');
        doc.querySelectorAll('*').forEach(el => {
          const name = local(el).toLowerCase();
          if (name === 'version-name' && !out.versionName) out.versionName = (el.textContent || '').trim();
          else if (name === 'creator-displayname' && !out.creatorDisplayname) out.creatorDisplayname = (el.textContent || '').trim();
          else if (name === 'getlastmodified' && !out.getlastmodified) out.getlastmodified = (el.textContent || '').trim();
          else if (name === 'getcontentlength' && !out.getcontentlength) out.getcontentlength = (el.textContent || '').trim();
          else if (name === 'creationdate' && !out.creationdate) out.creationdate = (el.textContent || '').trim();
          else if (name === 'checked-in' && !out.checkedInHref) {
            const h = el.getElementsByTagName('*');
            for (let i = 0; i < h.length; i++) {
              if (local(h[i]).toLowerCase() === 'href' && h[i].textContent.trim()) {
                out.checkedInHref = h[i].textContent.trim();
                break;
              }
            }
          }
        });
        return out;
      } catch (e) { /* 落到正则兜底 */ }
    }
    // 正则兜底
    const pick = (re) => { const m = xml.match(re); return m ? decodeXmlEntities(m[1]).trim() : ''; };
    out.versionName = pick(/<[^>]*:?version-name[^>]*>\s*(\d+)\s*<\/[^>]*:?version-name>/i);
    out.creatorDisplayname = pick(/<[^>]*:?creator-displayname[^>]*>([\s\S]*?)<\/[^>]*:?creator-displayname>/i);
    out.getlastmodified = pick(/<[^>]*:?getlastmodified[^>]*>([\s\S]*?)<\/[^>]*:?getlastmodified>/i);
    out.getcontentlength = pick(/<[^>]*:?getcontentlength[^>]*>\s*(\d+)\s*<\/[^>]*:?getcontentlength>/i);
    out.creationdate = pick(/<[^>]*:?creationdate[^>]*>([\s\S]*?)<\/[^>]*:?creationdate>/i);
    out.checkedInHref = pick(/<[^>]*:?checked-in[^>]*>\s*<(?:[A-Za-z0-9]+:)?href[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9]+:)?href>/i);
    return out;
  }

  /** 从版本资源 href 中提取 revision 数字，如 /svn/r/!svn/ver/114292/path -> 114292 */
  function getHrefRevision(href) {
    const m = String(href).match(/!svn\/ver\/(\d+)/i);
    return m ? m[1] : '';
  }

  function decodeXmlEntities(s) {
    return String(s)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
      .replace(/&amp;/g, '&');
  }

  /** 把 RFC1123 / ISO8601 时间统一成本地易读格式 YYYY-MM-DD HH:mm:ss */
  function formatSvnDate(raw) {
    const t = new Date(raw.trim());
    if (isNaN(t.getTime())) return raw.trim();
    const p = n => String(n).padStart(2, '0');
    return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate()) +
      ' ' + p(t.getHours()) + ':' + p(t.getMinutes()) + ':' + p(t.getSeconds());
  }

  function formatFileSize(bytes) {
    if (!bytes && bytes !== 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  }

  function getMeta() { return meta; }

  /**
   * 提取全部 sheet 名（仅跳过明显的导航/说明页，如「客户代码」）。
   * 不做表头预筛：不同客户 sheet 表头布局不一，预筛会漏表；
   * 实际检查时由 findRowByTag/locateHeader 校验所选 sheet 结构。
   */
  function buildSheetList(wb) {
    const skipPatterns = /^(客户代码|说明|目录|index|readme)/i;
    const names = [];
    wb.eachSheet(ws => {
      const name = (ws.name || '').trim();
      if (!name) return;
      if (skipPatterns.test(name)) return;
      names.push(name);
    });
    return names;
  }

  function getSheetNames() { return sheetNames.slice(); }

  // ===== 表头与行定位 =====
  /**
   * 在工作表前 8 行定位表头，返回 { headerRow, tagCol, verCol, projCol }
   * 表头特征：某单元格含「FSG」且含「TAG」；同行有含「最新版本」的单元格。
   * 固定扫前 15 列，不依赖 cellCount（部分表该值失真）。
   */
  function locateHeader(ws) {
    const maxRow = Math.min(8, ws.rowCount || 8);
    for (let r = 1; r <= maxRow; r++) {
      const row = ws.getRow(r);
      let tagCol = -1, verCol = -1, projCol = -1;
      for (let c = 1; c <= 15; c++) {
        const t = cellText(row.getCell(c)).replace(/\s+/g, '').toUpperCase();
        if (!t) continue;
        if (t.includes('FSG') && t.includes('TAG')) tagCol = c;
        if (t.includes('最新版本')) verCol = c;
        if (t === '项目' || t.includes('项目')) projCol = c;
      }
      if (tagCol > 0 && verCol > 0) {
        return { headerRow: r, tagCol, verCol, projCol };
      }
    }
    return null;
  }

  function cellText(cell) {
    const v = cell && cell.value;
    if (v == null) return '';
    if (typeof v === 'object') {
      if (Array.isArray(v.richText)) return v.richText.map(rt => rt.text || '').join('');
      if (typeof v.text === 'string') return v.text;
      if (typeof v.result !== 'undefined') return String(v.result);
      if (v.formula && v.result == null) return '';
    }
    return String(v);
  }

  /** 判断一行中哪个单元格是「最新版本」（同时含 SW: 与 RF:） */
  function findVersionCellInRow(row, maxCol) {
    for (let c = 1; c <= maxCol; c++) {
      const t = cellText(row.getCell(c));
      if (/SW\s*[:：]/i.test(t) && /RF\s*[:：]/i.test(t)) return c;
    }
    return -1;
  }

  /**
   * 内容兜底定位：不依赖表头，直接全表搜索等于设备 FSG TAG 的单元格，
   * 再在同一行定位含 SW:/RF: 的版本单元格。用于表头文字/布局与标准模板不一致的客户 sheet。
   * @returns {{row:number,hdr:object,tag:string,prefix:boolean}|null}
   */
  function findRowByContent(sheetName, tag) {
    if (!workbook) return null;
    const ws = workbook.getWorksheet(sheetName);
    if (!ws) return null;
    const want = (tag || '').trim().toUpperCase();
    if (!want) return null;
    const maxRow = ws.rowCount || 0;
    const maxCol = Math.min(30, ws.columnCount || 30);

    // 强匹配：全等，或单元格为较短基础 TAG（设备 TAG 以其开头）
    const strongScore = text => {
      const t = (text || '').trim().toUpperCase();
      if (!t) return 0;
      if (t === want) return 3;
      if (want.indexOf(t) === 0 && t.indexOf('-') >= 0 && t.length >= 6) return 2;
      return 0;
    };
    for (let r = 1; r <= maxRow; r++) {
      const row = ws.getRow(r);
      for (let c = 1; c <= maxCol; c++) {
        const raw = cellText(row.getCell(c));
        if (strongScore(raw) >= 2) {
          const verCol = findVersionCellInRow(row, maxCol);
          if (verCol > 0) {
            return {
              row: r, byContent: true, tag: raw.trim(), prefix: strongScore(raw) === 2,
              hdr: { headerRow: -1, tagCol: c, verCol, projCol: -1 },
            };
          }
        }
      }
    }
    // 弱匹配：单元格包含完整 TAG（防止 TAG 单元格带少量前后缀）
    for (let r = 1; r <= maxRow; r++) {
      const row = ws.getRow(r);
      for (let c = 1; c <= maxCol; c++) {
        const raw = cellText(row.getCell(c));
        const t = (raw || '').trim().toUpperCase();
        if (t && t.includes(want)) {
          const verCol = findVersionCellInRow(row, maxCol);
          if (verCol > 0) {
            return {
              row: r, byContent: true, weak: true, tag: raw.trim(), prefix: false,
              hdr: { headerRow: -1, tagCol: c, verCol, projCol: -1 },
            };
          }
        }
      }
    }
    return null;
  }

  /**
   * 在指定 sheet 中按设备 FSG TAG 精确定位行。
   * @returns {{row:number, tag:string}|null}
   */
  function findRowByTag(sheetName, tag) {
    if (!workbook) return null;
    const ws = workbook.getWorksheet(sheetName);
    if (!ws) return null;
    const hdr = locateHeader(ws);
    if (!hdr) return null;
    const want = (tag || '').trim().toUpperCase();
    for (let r = hdr.headerRow + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const cellVal = cellText(row.getCell(hdr.tagCol)).trim().toUpperCase();
      if (!cellVal) continue;
      if (cellVal === want) {
        return { row: r, tag: cellText(row.getCell(hdr.tagCol)).trim(), hdr };
      }
    }
    // 精确匹配不到时，尝试「表格值为设备 TAG 前缀」（表格登记的是较短的基础 TAG）
    for (let r = hdr.headerRow + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const cellVal = cellText(row.getCell(hdr.tagCol)).trim().toUpperCase();
      if (cellVal && want.indexOf(cellVal) === 0) {
        return { row: r, tag: cellText(row.getCell(hdr.tagCol)).trim(), hdr, prefix: true };
      }
    }
    return null;
  }

  /**
   * 解析「最新版本」单元格内的多行文本：SW:xxx / RF:xxx / Date:xxx
   */
  function parseVersionCell(text) {
    const out = { SW: '', RF: '', Date: '' };
    String(text || '').split(/\r?\n/).forEach(line => {
      // 不锚定整行：允许单元格内有前导/尾随文字，只要出现 SW:/RF:/Date: 即提取
      const m = line.match(/(SW|RF|Date)\s*[:：]\s*([0-9A-Za-z._-]+)/i);
      if (!m) return;
      const key = m[1].toUpperCase();
      if (key === 'SW') out.SW = m[2].trim();
      else if (key === 'RF') out.RF = m[2].trim();
      else if (key === 'DATE') out.Date = m[2].trim();
    });
    return out;
  }

  // ===== 设备读取 =====
  /**
   * 从 AT+QFSGVERSION? 响应解析 Tag/SW/RF/Date。
   * 兼容两种来源格式：
   *   - 串口原始响应：行首直接是 Tag:/SW:/RF:/Date:
   *   - 一键检查/历史记录保存的 at_version：每行带 [时间戳] 前缀（如 [2026-09-18_13:28:24:123]Tag: xxx）
   */
  function parseDeviceResponse(respText) {
    const d = { tag: '', sw: '', rf: '', date: '', raw: respText || '' };
    String(respText || '').split(/\r?\n/).forEach(rawLine => {
      const s = rawLine.trim();
      if (!s) return;
      const m = s.match(/^(?:\[[^\]]*\]\s*)?(Tag|SW|RF|Date)\s*[:：]\s*(.+)$/i);
      if (!m) return;
      const key = m[1].toLowerCase();
      const val = m[2].trim();
      if (key === 'tag' && !d.tag) d.tag = val;
      else if (key === 'sw' && !d.sw) d.sw = val;
      else if (key === 'rf' && !d.rf) d.rf = val;
      else if (key === 'date' && !d.date) d.date = val;
    });
    return d;
  }

  /** 由外部（一键检查/历史记录）直接注入已保存的响应文本，免去重复读取设备 */
  function setDeviceFromResponse(respText) {
    device = parseDeviceResponse(respText);
    return device;
  }
  function setDevice(d) {
    device = d ? { tag: d.tag || '', sw: d.sw || '', rf: d.rf || '', date: d.date || '', raw: d.raw || '' } : null;
    return device;
  }

  async function readDevice(port, serialCfg) {
    const cfg = serialCfg || {};
    const resp = await Serial.sendAT(port, 'AT+QFSGVERSION?', {
      baudrate: cfg.baudrate || 115200,
      timeout_ms: cfg.response_timeout_ms || 2000,
    });
    device = parseDeviceResponse(resp);
    return { device, resp };
  }

  function getDevice() { return device; }
  function resetDevice() { device = null; }

  /**
   * 执行比对。
   * @returns {object} { overall:'pass'|'fail', sheet, rowInfo, items:[{key,label,device,excel,match,note}], verText }
   */
  function runCompare(sheetName) {
    if (!device || !device.tag) throw new Error('尚未读取到设备 FSG TAG');
    const ws = workbook && workbook.getWorksheet(sheetName);
    if (!ws) {
      return {
        overall: 'fail', sheet: sheetName, rowInfo: null,
        items: [],
        error: '未查询到信息，请检查客户版本是否正确，或FSG表格是否正确更新！',
      };
    }
    const hdr = locateHeader(ws);
    let found = null;
    if (hdr) {
      found = findRowByTag(sheetName, device.tag);
    } else {
      // 表头不标准：改用内容兜底定位（按 TAG 内容 + 同行 SW/RF 单元格）
      found = findRowByContent(sheetName, device.tag);
      if (found) found.byContentHeader = true;
    }
    if (!found) {
      return {
        overall: 'fail', sheet: sheetName, rowInfo: null,
        items: [],
        error: '未查询到信息，请检查客户版本是否正确，或FSG表格是否正确更新！',
      };
    }
    const verText = cellText(ws.getRow(found.row).getCell(found.hdr.verCol));
    const excel = parseVersionCell(verText);

    const checks = [
      { key: 'sw', label: '软件版本 SW', device: device.sw, excel: excel.SW },
      { key: 'rf', label: '射频版本 RF', device: device.rf, excel: excel.RF },
      { key: 'date', label: '日期 Date', device: device.date, excel: excel.Date },
    ];
    const items = checks.map(c => {
      const dev = (c.device || '').trim();
      const ex = (c.excel || '').trim();
      let match, note = '';
      if (!dev && !ex) { match = false; note = '设备和表格均无此项'; }
      else if (!dev) { match = false; note = '设备未读到该值'; }
      else if (!ex) { match = false; note = 'SVN 表格未登记该值'; }
      else { match = dev === ex; note = match ? '' : '不一致'; }
      return { label: c.label, device: dev || '（无）', excel: ex || '（无）', match, note };
    });
    const overall = items.every(i => i.match) ? 'pass' : 'fail';

    let project = '';
    if (found.hdr.projCol > 0) project = cellText(ws.getRow(found.row).getCell(found.hdr.projCol)).trim();

    return {
      overall,
      sheet: sheetName,
      rowInfo: { row: found.row, tag: found.tag, project, prefix: !!found.prefix, byContent: !!found.byContent, weak: !!found.weak },
      items,
      verText,
    };
  }

  function getSvnUrl() { return SVN_URL; }

  return {
    SVN_URL,
    CUSTOMER_TABLE, resolveCustomer, customerSheetAliases,
    hasAuth, getUser, setAuth, clearAuth, loginDialog,
    fetchWorkbook, fetchSvnMeta, getMeta, parseSvnPropfind, resolveSvnUrl,
    getSheetNames, buildSheetList, locateHeader,
    readDevice, getDevice, resetDevice, setDevice, setDeviceFromResponse, parseDeviceResponse,
    runCompare, getSvnUrl,
  };
})();
