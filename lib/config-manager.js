/**
 * 配置管理器 (v3)
 *
 * 配置结构 (v3):
 *   {
 *     version: 3,
 *     dimensions: [
 *       { key, label, order,
 *         auto_read: { command: "AT+QGMR", strip_prefix?: "BASE  Version:" } | null,
 *         options?: [...],              // 固定选项
 *         options_by?: { "9": [...] }   // 联动选项（key 为 android_version 值）
 *       }
 *     ],
 *     items: [ { name, default, conditions, files: { fm, xml }, note? } ],
 *     serial: { ... }
 *   }
 *
 * conditions 语义：{ dimKey: [allowed values] }，选中维度值 ∈ 数组才匹配；
 * 缺失的维度键 = 该维度不限制；空值（未选择/未读取）= 不匹配。
 *
 * 配置来源（优先级从高到低）：
 *   1. localStorage 本地覆盖 —— 用户在 UI 改的，不影响云端
 *   2. 云端 default-checklist.json —— 管理员维护
 *   3. 内置 FALLBACK —— 兜底
 */
const ConfigManager = (function () {
  const LOCAL_KEY = 'nvchecklist.local_config_v3';

  const CLOUD_URLS = [
    'config/default-checklist.json',
    'https://raw.githubusercontent.com/FujiwaraC9/NvCheckListTool/main/config/default-checklist.json',
    'https://cdn.jsdelivr.net/gh/FujiwaraC9/NvCheckListTool@main/config/default-checklist.json',
  ];

  const FALLBACK = {
    version: 3,
    updated_at: '2026-08-26',
    description: '内置兜底配置 (v3)',
    dimensions: [
      { key: 'platform', label: '平台', order: 1, auto_read: { command: 'AT+QGMR' }, options: ['UIS7885', 'UIS7863', 'UIS7861', 'SL8541E', 'SL8521E', 'SL8581A', 'SL8581E'] },
      { key: 'android_version', label: '安卓版本', order: 2, auto_read: { command: 'AT+QGMR' }, options: ['9', '10', '12'] },
      { key: 'customer', label: '分支', order: 3, auto_read: null, options_by: { '9': ['公版'], '10': ['公版', '飞天'], '12': ['公版', '新大陆定制'] } },
      { key: 'baseline', label: 'modem基线版本', order: 4, auto_read: { command: 'AT+CGMR', strip_prefix: 'BASE  Version:' } },
    ],
    items: [
      { name: 'edch_Category', default: '0x7', conditions: {}, files: { fm: 'td_nv_type.nvm', xml: 'CustNV/NV_PARAM_TYPE_EXPORT_WAS_CUSTOMER_SETTINGS.xml' } },
      { name: 'gea_encryption_algo1', default: '0x0', conditions: {}, files: { fm: 'td_nv_type.nvm', xml: 'RDNV/NV_PARAM_TYPE_PREV_UMTS_MS_NW_CAP.xml' }, note: '需要从设备中load，客户分支未关闭，待有客户需求在导入' },
      { name: 'gea_algo2', default: '0x0', conditions: {}, files: { fm: 'td_nv_type.nvm', xml: 'RDNV/NV_PARAM_TYPE_PREV_UMTS_MS_NW_CAP.xml' }, note: '需要从设备中load，客户分支未关闭，待有客户需求在导入' },
      { name: 'sim_hot_plug_cfg', default: '0x0', conditions: {}, files: { fm: 'ProductionParam.nvm', xml: 'CustNV/SIM_HOT_PLUG_CFG.xml' }, note: '默认关闭，有特殊需求请提前确认' },
    ],
    serial: {
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
          if (data && data.items && data.dimensions) {
            return data;
          }
        }
      } catch (e) { /* 尝试下一个 */ }
    }
    console.warn('[ConfigManager] 无法拉取云端配置，使用本地快照/内置兜底');
    return getFallback();
  }

  /**
   * 兜底配置：优先用 script 标签加载的本地快照（config/default-checklist.js，
   * file:// 直开与断网时也有完整检查项），快照缺失时退到极简内置值。
   */
  function getFallback() {
    try {
      if (typeof window !== 'undefined' && window.DEFAULT_CHECKLIST &&
          window.DEFAULT_CHECKLIST.items && window.DEFAULT_CHECKLIST.dimensions) {
        return deepClone(window.DEFAULT_CHECKLIST);
      }
    } catch (e) { /* ignore */ }
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
    if (!currentConfig) return getFallback();
    return deepClone(currentConfig);
  }

  function hasLocal() { return hasLocalOverride; }
  function getCloud() { return deepClone(cloudConfig || getFallback()); }

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

  function getDimension(key) {
    return getDimensions().find(d => d.key === key) || null;
  }

  /**
   * 获取维度的当前可选选项。
   * - 固定 options 的直接返回
   * - options_by 联动的根据 selection 里 android_version 的值返回
   * - baseline 等无 options 的返回 null（自由输入/自动读取）
   */
  function getDimOptions(dim, selection) {
    if (!dim) return null;
    if (dim.options) return dim.options;
    if (dim.options_by) {
      const av = selection && selection.android_version;
      if (av && dim.options_by[av]) return dim.options_by[av];
      return [];
    }
    return null;
  }

  /**
   * 获取维度的默认选择（用于初始化选择状态）
   * auto_read 维度返回空串（等自动读取或用户手选），其他返回首个选项
   */
  function getDefaultSelection() {
    const dims = getDimensions();
    const sel = {};
    for (const d of dims) {
      sel[d.key] = '';
    }
    return sel;
  }

  // ===== 条件匹配 =====

  /**
   * 判断一个 item 是否匹配当前选择
   * 规则：
   * - conditions 中的键 = 该维度必须匹配
   * - 选中值为空（未选/未读取）时，若该维度在 conditions 里有限制 → 不匹配
   * - 选中值 ∈ conditions[dimKey] 数组才匹配
   */
  function matchItem(item, sel) {
    const cond = item.conditions || {};
    for (const dimKey of Object.keys(cond)) {
      const allowed = cond[dimKey];
      if (!Array.isArray(allowed) || allowed.length === 0) continue;
      const chosen = sel[dimKey];
      if (!chosen) return false;
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

  return {
    init, refreshCloud, get, getCloud, saveLocal, resetToCloud,
    hasLocal, getDimensions, getDimension, getDimOptions, getDefaultSelection,
    matchItem, getActiveItems,
  };
})();
