/**
 * 配置管理器 (v2)
 *
 * 配置结构 (v2):
 *   {
 *     version: 2,
 *     dimensions: [ { key, label, order, options, auto_read, default? } ],
 *     items: [ { name, default, nvm_file, conditions, note? } ],
 *     serial: { ... }
 *   }
 *
 * conditions 语义：{ dimKey: [allowed values] }，选中维度值 ∈ 数组才匹配；
 * 缺失的维度键 = 该维度不限制（匹配所有）。
 *
 * 配置来源（优先级从高到低）：
 *   1. localStorage 本地覆盖 —— 用户在 UI 改的，不影响云端
 *   2. 云端 default-checklist.json —— 管理员维护
 *   3. 内置 FALLBACK —— 兜底
 */
const ConfigManager = (function () {
  const LOCAL_KEY = 'nvchecklist.local_config_v2';

  const CLOUD_URLS = [
    'config/default-checklist.json',
    'https://raw.githubusercontent.com/FujiwaraC9/NvCheckListTool/main/config/default-checklist.json',
    'https://cdn.jsdelivr.net/gh/FujiwaraC9/NvCheckListTool@main/config/default-checklist.json',
  ];

  const FALLBACK = {
    version: 2,
    updated_at: '2026-08-26',
    description: '内置兜底配置 (v2)',
    dimensions: [
      { key: 'platform', label: '平台', order: 1, options: ['7885', '8541'], auto_read: true },
      { key: 'android_version', label: '安卓版本', order: 2, options: ['9', '10', '12'], auto_read: true },
      { key: 'nv_type', label: 'NV 类型', order: 3, options: ['release', 'debug'], default: 'release', auto_read: false },
      { key: 'customer', label: '客户/项目', order: 4, options: ['通用', '新大陆', '东集', '星云', '优博讯', '飞天'], auto_read: false },
      { key: 'baseline', label: '基线', order: 5, options: ['通用', '5G_MODEM_V2_23A_IEBU_W24.31.2'], auto_read: false },
    ],
    items: [
      { name: 'edch_Category', default: '0x7', nvm_file: '', conditions: {} },
      { name: 'gea_encryption_algo1', default: '0x0', nvm_file: '', conditions: {} },
      { name: 'gea_algo2', default: '0x0', nvm_file: '', conditions: {} },
      { name: 'sim_hot_plug_cfg', default: '0x0', nvm_file: '', conditions: { customer: ['通用', '新大陆', '飞天'] } },
    ],
    serial: {
      port_keyword: 'SPRD LTE AT(WIQ)',
      baudrate: 115200,
      at_command: 'AT+QFSGVERSION?',
      response_timeout_ms: 2000,
    },
  };

  let currentConfig = null;
  let cloudConfig = null;
  let hasLocalOverride = false;

  async function init() {
    cloudConfig = await fetchCloudConfig();
    loadLocalOverride();
    return currentConfig;
  }

  async function fetchCloudConfig() {
    for (const url of CLOUD_URLS) {
      try {
        const resp = await fetch(url, { cache: 'no-cache' });
        if (resp.ok) {
          const data = await resp.json();
          // v2 配置须有 dimensions + items
          if (data && data.items && data.dimensions) {
            return data;
          }
        }
      } catch (e) { /* 尝试下一个 */ }
    }
    console.warn('[ConfigManager] 无法拉取云端配置，使用内置兜底值');
    return deepClone(FALLBACK);
  }

  async function refreshCloud() {
    cloudConfig = await fetchCloudConfig();
    if (!hasLocalOverride) {
      currentConfig = deepClone(cloudConfig);
    }
    return { cloudConfig, currentConfig, hasLocalOverride };
  }

  function loadLocalOverride() {
    try {
      const raw = localStorage.getItem(LOCAL_KEY);
      if (raw) {
        const local = JSON.parse(raw);
        if (local && typeof local === 'object' && local.items) {
          hasLocalOverride = true;
          currentConfig = local;
          return;
        }
      }
    } catch (e) {
      console.warn('[ConfigManager] 本地配置解析失败，忽略:', e);
    }
    hasLocalOverride = false;
    currentConfig = deepClone(cloudConfig);
  }

  function get() {
    if (!currentConfig) return deepClone(FALLBACK);
    return deepClone(currentConfig);
  }

  function hasLocal() { return hasLocalOverride; }
  function getCloud() { return deepClone(cloudConfig || FALLBACK); }

  function saveLocal(newConfig) {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(newConfig));
    hasLocalOverride = true;
    currentConfig = deepClone(newConfig);
  }

  function resetToCloud() {
    localStorage.removeItem(LOCAL_KEY);
    hasLocalOverride = false;
    currentConfig = deepClone(cloudConfig);
  }

  function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

  // ===== 维度 =====

  function getDimensions() {
    const cfg = get();
    return (cfg.dimensions || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  }

  /**
   * 获取维度的默认选择（用于初始化选择状态）
   * auto_read 维度暂返回空串（等自动读取实现），非 auto_read 返回 options[0] 或 default
   */
  function getDefaultSelection() {
    const dims = getDimensions();
    const sel = {};
    for (const d of dims) {
      if (d.auto_read) {
        sel[d.key] = ''; // 等待自动读取或用户手选
      } else if (d.default) {
        sel[d.key] = d.default;
      } else if (d.options && d.options.length > 0) {
        sel[d.key] = d.options[0];
      } else {
        sel[d.key] = '';
      }
    }
    return sel;
  }

  // ===== 条件匹配 =====

  /**
   * 判断一个 item 是否匹配当前选择
   * @param item   配置项 { name, default, nvm_file, conditions }
   * @param sel    选择对象 { dimKey: selectedValue }
   * @returns boolean
   */
  function matchItem(item, sel) {
    const cond = item.conditions || {};
    for (const dimKey of Object.keys(cond)) {
      const allowed = cond[dimKey];
      if (!Array.isArray(allowed) || allowed.length === 0) continue;
      const chosen = sel[dimKey];
      // 选中值为空（auto_read 未读出）时，跳过该维度检查（不限制）
      if (!chosen) continue;
      if (!allowed.includes(chosen)) return false;
    }
    return true;
  }

  /**
   * 返回匹配当前选择的检查项数组
   */
  function getActiveItems(sel) {
    const cfg = get();
    const items = cfg.items || [];
    return items.filter(item => matchItem(item, sel));
  }

  // ===== 本地编辑（配置管理页用）=====

  function addCheckItem(name, nvmFile, defaultValue) {
    if (!currentConfig.items) currentConfig.items = [];
    if (currentConfig.items.some(i => i.name === name)) return;
    currentConfig.items.push({
      name, default: defaultValue, nvm_file: nvmFile, conditions: {},
    });
  }

  function removeCheckItem(name) {
    if (!currentConfig.items) return;
    currentConfig.items = currentConfig.items.filter(i => i.name !== name);
  }

  return {
    init, refreshCloud, get, getCloud, saveLocal, resetToCloud,
    hasLocal, getDimensions, getDefaultSelection,
    matchItem, getActiveItems,
    addCheckItem, removeCheckItem,
  };
})();
