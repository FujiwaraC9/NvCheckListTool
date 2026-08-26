/**
 * 配置管理器
 *
 * 配置来源（优先级从高到低）：
 *   1. localStorage 中的本地覆盖 (localConfig) —— 用户在 UI 改的，永远不会影响云端
 *   2. 云端默认配置 (default-checklist.json) —— 管理员维护
 *   3. 内置硬编码兜底值 (FALLBACK)
 *
 * 用户点击"恢复云端默认"= 清空 localStorage + 重新拉云端。
 */
const ConfigManager = (function () {
  const LOCAL_KEY = 'nvchecklist.local_config_v1';
  // 云端默认配置地址列表（按顺序尝试，第一个成功的返回）
  // 优先使用相对路径（部署在 GitHub Pages 后同域访问，公有/私有仓库都可用）
  // 本地双击 index.html 打开时相对路径会走 file:// 协议，部分浏览器会拦截，
  // 所以同时提供绝对路径作为备用。
  const CLOUD_URLS = [
    // 相对路径（GitHub Pages / 本地 HTTP 服务器）—— 最可靠，同域不受 CORS 限制
    'config/default-checklist.json',
    // GitHub raw（公有仓库）
    'https://raw.githubusercontent.com/FujiwaraC9/NvCheckListTool/main/config/default-checklist.json',
    // jsdelivr CDN 备用（仅公有仓库）
    'https://cdn.jsdelivr.net/gh/FujiwaraC9/NvCheckListTool@main/config/default-checklist.json',
  ];

  const FALLBACK = {
    version: 1,
    updated_at: '2026-08-26',
    description: '内置兜底配置',
    defaults: {
      edch_Category: 7,
      cap_log_enable: 0,
      dsp_log_set: 0,
      gea_encryption_algo1: 0,
      gea_algo2: 0,
      sim_hot_plug_cfg: 0,
    },
    nvm_files: {
      edch_Category: 'td_nv_type.nvm',
      gea_encryption_algo1: 'td_nv_type.nvm',
      gea_algo2: 'td_nv_type.nvm',
      dsp_log_set: 'nv_type_4band.nvm',
      cap_log_enable: 'nv_type_4band.nvm',
      sim_hot_plug_cfg: 'ProductionParam.nvm',
    },
    check_items: [
      'edch_Category', 'cap_log_enable', 'dsp_log_set',
      'gea_encryption_algo1', 'gea_algo2', 'sim_hot_plug_cfg',
    ],
    serial: {
      port_keyword: 'SPRD LTE AT(WIQ)',
      baudrate: 115200,
      at_command: 'AT+QFSGVERSION?',
      response_timeout_ms: 2000,
    },
  };

  let currentConfig = null;    // 合并后的有效配置
  let cloudConfig = null;      // 云端配置（只读）
  let hasLocalOverride = false;

  /**
   * 初始化配置（页面加载时调用）
   */
  async function init() {
    cloudConfig = await fetchCloudConfig();
    loadLocalOverride();
    return currentConfig;
  }

  /**
   * 尝试从多个 URL 拉取云端配置，失败则用 FALLBACK
   */
  async function fetchCloudConfig() {
    for (const url of CLOUD_URLS) {
      try {
        const resp = await fetch(url, { cache: 'no-cache' });
        if (resp.ok) {
          const data = await resp.json();
          if (data && data.check_items) {
            return data;
          }
        }
      } catch (e) { /* 尝试下一个 */ }
    }
    console.warn('[ConfigManager] 无法拉取云端配置，使用内置兜底值');
    return JSON.parse(JSON.stringify(FALLBACK));
  }

  /**
   * 重新拉取云端配置（按钮触发）
   */
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
        if (local && typeof local === 'object') {
          hasLocalOverride = true;
          currentConfig = mergeConfig(cloudConfig, local);
          return;
        }
      }
    } catch (e) {
      console.warn('[ConfigManager] 本地配置解析失败，忽略:', e);
    }
    hasLocalOverride = false;
    currentConfig = deepClone(cloudConfig);
  }

  /**
   * 获取当前合并后的配置
   */
  function get() {
    if (!currentConfig) return deepClone(FALLBACK);
    return deepClone(currentConfig);
  }

  /**
   * 是否有本地覆盖
   */
  function hasLocal() { return hasLocalOverride; }

  /**
   * 获取云端默认配置（只读副本）
   */
  function getCloud() { return deepClone(cloudConfig || FALLBACK); }

  /**
   * 保存本地配置（覆盖到 localStorage）
   * newConfig 为完整配置对象
   */
  function saveLocal(newConfig) {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(newConfig));
    hasLocalOverride = true;
    currentConfig = deepClone(newConfig);
  }

  /**
   * 重置到云端默认（清空 localStorage，重新用 cloudConfig）
   */
  function resetToCloud() {
    localStorage.removeItem(LOCAL_KEY);
    hasLocalOverride = false;
    currentConfig = deepClone(cloudConfig);
  }

  /**
   * 深拷贝
   */
  function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

  /**
   * 合并本地覆盖到云端配置（简单深合并，本地覆盖所有相同字段；
   * 注意：如果用户删了某个 check_item，本地完全覆盖列表即可）
   */
  function mergeConfig(base, override) {
    const out = deepClone(base);
    for (const key of Object.keys(override)) {
      const v = override[key];
      if (v && typeof v === 'object' && !Array.isArray(v) && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
        out[key] = { ...out[key], ...v };
      } else {
        out[key] = v;
      }
    }
    return out;
  }

  /**
   * 添加一个检查项到当前配置
   */
  function addCheckItem(name, nvmFile, defaultValue) {
    if (!currentConfig.check_items.includes(name)) {
      currentConfig.check_items.push(name);
    }
    currentConfig.defaults[name] = defaultValue;
    currentConfig.nvm_files[name] = nvmFile;
  }

  /**
   * 删除一个检查项
   */
  function removeCheckItem(name) {
    currentConfig.check_items = currentConfig.check_items.filter(n => n !== name);
    delete currentConfig.defaults[name];
    delete currentConfig.nvm_files[name];
  }

  return {
    init, refreshCloud, get, getCloud, saveLocal, resetToCloud,
    hasLocal, addCheckItem, removeCheckItem,
  };
})();
