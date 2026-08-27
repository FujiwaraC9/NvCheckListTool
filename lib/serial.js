/**
 * Web Serial API 封装
 *
 * 注意：Web Serial API 仅在 Chrome/Edge 桌面版（HTTPS 或 localhost）可用。
 *
 * 使用方式：
 *   const port = await Serial.requestPort(keyword); // 请求用户选择串口
 *   const resp = await Serial.sendAT(port, "AT+QFSGVERSION?", { baudrate, timeout_ms });
 */
const Serial = (function () {
  let cachedPort = null;
  let portInfoCache = null;

  function textDecoder() { return new TextDecoder('utf-8', { fatal: false }); }
  function textEncoder() { return new TextEncoder(); }

  /**
   * 列出所有串口（需用户已授权过）
   * 返回 SerialPort 数组（可能为空，未授权时需要 requestPort 触发弹窗）
   */
  async function listPorts() {
    if (!navigator.serial) return [];
    try {
      return await navigator.serial.getPorts();
    } catch (e) {
      return [];
    }
  }

  /**
   * 触发串口选择弹窗（必须由用户手势触发，如点击按钮）
   * keyword 参数仅用于在多串口场景提示用户选择包含关键字的那个；
   * 但浏览器 API 无法按关键字筛选，只能让用户自己选。
   * 返回选中的 SerialPort。
   */
  async function requestPort(keyword) {
    if (!navigator.serial) {
      throw new Error('当前浏览器不支持 Web Serial API，请使用 Chrome/Edge 桌面版。');
    }
    try {
      const port = await navigator.serial.requestPort({
        // 不过滤 VID/PID，用户自己选择正确的 AT 口
      });
      cachedPort = port;
      return port;
    } catch (e) {
      if (e.name === 'NotFoundError') {
        throw new Error('未选择串口（用户取消或未找到设备）。');
      }
      throw e;
    }
  }

  /**
   * 尝试在已授权的串口中找设备名包含 keyword 的。
   * Web Serial API 本身拿不到友好名（getInfo 只返 VID/PID），
   * 因此这个函数只能在用户之前选过且已记住的端口里返回任意一个，
   * 真正的"按关键字选口"必须在请求弹窗里由用户选。
   */
  async function getOrRequestPort(keyword) {
    // 优先用缓存的端口
    if (cachedPort) return cachedPort;
    const ports = await listPorts();
    if (ports.length > 0) {
      // 已授权过的端口，直接用第一个（用户之前选过应该就是它）
      cachedPort = ports[0];
      return ports[0];
    }
    // 没有已授权的，弹窗让用户选
    return await requestPort(keyword);
  }

  /**
   * 连接串口，打开读写流
   */
  async function open(port, options = {}) {
    const baudrate = options.baudrate || 115200;
    if (port.readable || port.writable) {
      // 已经打开了
      return;
    }
    await port.open({
      baudRate: baudrate,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
    });
  }

  function close(port) {
    if (port && (port.readable || port.writable)) {
      try { return port.close(); } catch (e) { /* ignore */ }
    }
    return Promise.resolve();
  }

  /**
   * 向串口发送命令并读取响应
   * @param {SerialPort} port
   * @param {string} cmd  AT 命令（会自动加 \r\n）
   * @param {object} opts { baudrate, timeout_ms, wait_ms_after_write }
   * @returns {string}   响应文本
   */
  async function sendAT(port, cmd, opts = {}) {
    const baudrate = opts.baudrate || 115200;
    const timeout = opts.timeout_ms || 2000;
    const waitAfter = opts.wait_ms_after_write || 1500;

    await open(port, { baudrate });

    // 清空输入缓冲
    try {
      if (port.readable) {
        const reader = port.readable.getReader();
        try {
          // 尝试非阻塞读一下，丢弃遗留数据
          const { value } = await Promise.race([
            reader.read(),
            new Promise((_, rj) => setTimeout(() => rj(new Error('drain_timeout')), 300)),
          ]);
          reader.releaseLock();
        } catch (e) {
          try { reader.releaseLock(); } catch (_) {}
        }
      }
    } catch (e) { /* ignore drain errors */ }

    // 发送命令
    const writer = port.writable.getWriter();
    try {
      await writer.write(textEncoder().encode(cmd + '\r\n'));
    } finally {
      writer.releaseLock();
    }

    // 等待响应
    await sleep(waitAfter);

    // 读取所有可读数据（加总超时）
    let chunks = [];
    const deadline = Date.now() + timeout;
    try {
      while (Date.now() < deadline) {
        if (!port.readable) break;
        const reader = port.readable.getReader();
        try {
          const { value, done } = await Promise.race([
            reader.read(),
            new Promise((_, rj) => setTimeout(() => rj(new Error('read_timeout')), Math.min(500, deadline - Date.now()))),
          ]);
          if (done) break;
          if (value) chunks.push(value);
        } catch (e) {
          reader.releaseLock();
          break;
        } finally {
          try { reader.releaseLock(); } catch (_) {}
        }
      }
    } catch (e) { /* ignore */ }

    // 拼接解码
    let total = 0;
    chunks.forEach(c => total += c.length);
    const all = new Uint8Array(total);
    let offset = 0;
    chunks.forEach(c => { all.set(c, offset); offset += c.length; });
    let text = '';
    try { text = textDecoder().decode(all); }
    catch (e) { text = new TextDecoder('latin1').decode(all); }
    return text;
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /**
   * 从 AT+QFSGVERSION? 响应中提取有意义的内容行（SW:/RF:/Tag:/Date: 等），
   * 每行加时间戳前缀，与 Python 脚本 build_info_lines 行为一致。
   * 同时返回 { lines: [...], module: 'SC200L-AUPD', atFullText: '...' }
   */
  function parseQfsgversion(respText) {
    const lines = [];
    const now = new Date();
    const ts = formatTimestamp(now);
    const contentLines = [];

    for (const rawLine of respText.split(/\r?\n/)) {
      const s = rawLine.trim();
      if (!s) continue;
      const upper = s.toUpperCase();
      // 去命令回显和 OK/ERROR
      if (upper.startsWith('AT+QFSGVERSION')) continue;
      if (['OK', 'ERROR', 'ERR', 'CME ERROR'].includes(upper)) continue;
      // 字段:值 形式
      if (/^[A-Za-z_]+:/.test(s)) {
        lines.push('[' + ts + ']' + s);
        contentLines.push(s);
      }
    }

    // 提取模块型号 (Tag: 开头)
    let module = null;
    for (const s of contentLines) {
      const m = s.match(/^Tag\s*[:：]\s*(.+)/i);
      if (m) {
        const raw = m[1].trim();
        const parts = raw.split('-');
        module = parts.length >= 2 ? parts.slice(0, 2).join('-') : parts[0];
        break;
      }
    }

    return {
      lines,
      module,
      atFullText: lines.join('\n'),
    };
  }

  function formatTimestamp(d) {
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      '_' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) +
      ':' + pad(d.getMilliseconds(), 3);
  }

  /**
   * 从 AT+QGMR 响应中提取平台名。
   * @param {string} respText  响应全文
   * @param {string[]} platformOptions  平台名列表（来自配置 dimensions.platform.options）
   * @returns {string|null}  匹配到的平台名，如 'UIS7885'；未匹配返回 null
   */
  function parseQgmr(respText, platformOptions) {
    if (!respText) return null;
    const upper = respText.toUpperCase();
    for (const opt of (platformOptions || [])) {
      if (upper.includes(String(opt).toUpperCase())) {
        return opt;
      }
    }
    return null;
  }

  /**
   * 从 AT+CGMR 响应中提取 modem 基线版本。
   * 响应格式：BASE  Version:    4G_MODEM_22A_W25.13.5
   * 除去 "BASE  Version:" 剩下的就是基线版本号。
   * @returns {string|null}
   */
  function parseCgmr(respText) {
    if (!respText) return null;
    // 逐行找 BASE Version: 前缀（冒号后空格数不定）
    for (const rawLine of respText.split(/\r?\n/)) {
      const m = rawLine.match(/^\s*BASE\s+Version\s*:\s*(.+)$/i);
      if (m) {
        const v = m[1].trim();
        if (v) return v;
      }
    }
    return null;
  }

  /**
   * 从 AT+QGMR 响应中提取安卓版本（Android 后面的数字主版本号，9/10/12 等）。
   * QGMR 输出通常含 Android10、ANDROID12 等字样，正则忽略大小写匹配。
   * @returns {string|null}  '9'/'10'/'12'/...
   */
  function parseAndroidVersion(respText, versionOptions) {
    if (!respText) return null;
    const m = respText.match(/Android\s*(\d+)/i);
    if (m) {
      const v = m[1];
      if (versionOptions && versionOptions.includes(v)) return v;
      return v;
    }
    return null;
  }

  /**
   * 判断 Web Serial 是否可用
   */
  function isSupported() {
    return !!navigator.serial;
  }

  return { listPorts, requestPort, getOrRequestPort, open, close, sendAT, parseQfsgversion, parseQgmr, parseCgmr, parseAndroidVersion, isSupported };
})();
