/**
 * IndexedDB 封装 - 存储检查记录
 * 数据库: NvCheckListDB
 * 表(store): records      - NV 一键检查记录，keyPath: id (自增)
 *           svn_records  - SVN 版本验证记录（与 NV 记录分库独立存储）
 *           prefs        - key-value（记忆项目文件夹 handle 等）
 */
const DB = (function () {
  const DB_NAME = 'NvCheckListDB';
  const DB_VERSION = 3;
  const STORE = 'records';
  const SVN_STORE = 'svn_records';
  const PREFS = 'prefs';
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          store.createIndex('module', 'module', { unique: false });
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
        // SVN 检查记录独立仓库（与 NV 记录分开存）
        if (!db.objectStoreNames.contains(SVN_STORE)) {
          const sstore = db.createObjectStore(SVN_STORE, { keyPath: 'id', autoIncrement: true });
          sstore.createIndex('module', 'module', { unique: false });
          sstore.createIndex('timestamp', 'timestamp', { unique: false });
        }
        if (!db.objectStoreNames.contains(PREFS)) {
          db.createObjectStore(PREFS); // key-value
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function setPref(key, value) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PREFS, 'readwrite');
      tx.objectStore(PREFS).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getPref(key) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PREFS, 'readonly');
      const req = tx.objectStore(PREFS).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function addRecord(record, storeName) {
    const target = storeName || STORE;
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(target, 'readwrite');
      const store = tx.objectStore(target);
      const rec = { ...record, timestamp: record.timestamp || Date.now() };
      const req = store.add(rec);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getAllRecords(storeName) {
    const target = storeName || STORE;
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(target, 'readonly');
      const store = tx.objectStore(target);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function getRecordsByIds(ids, storeName) {
    const all = await getAllRecords(storeName);
    const set = new Set(ids);
    return all.filter(r => set.has(r.id));
  }

  async function deleteRecords(ids, storeName) {
    const target = storeName || STORE;
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(target, 'readwrite');
      const store = tx.objectStore(target);
      ids.forEach(id => store.delete(id));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function clearAll(storeName) {
    const target = storeName || STORE;
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(target, 'readwrite');
      tx.objectStore(target).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * 按条件筛选记录
   * filters: { moduleKeyword, result ('pass'|'fail'|''), dateFrom (YYYY-MM-DD), dateTo (YYYY-MM-DD) }
   * storeName: 默认 NV 记录仓库 records，可传 svn_records
   */
  async function queryRecords(filters = {}, storeName) {
    let records = await getAllRecords(storeName);
    // 时间倒序
    records.sort((a, b) => b.timestamp - a.timestamp);

    if (filters.moduleKeyword) {
      const kw = filters.moduleKeyword.toLowerCase();
      records = records.filter(r => (r.module || '').toLowerCase().includes(kw));
    }
    if (filters.result === 'pass') {
      records = records.filter(r => r.overall === 'pass');
    } else if (filters.result === 'fail') {
      records = records.filter(r => r.overall === 'fail');
    }
    if (filters.dateFrom) {
      const from = new Date(filters.dateFrom + 'T00:00:00').getTime();
      records = records.filter(r => r.timestamp >= from);
    }
    if (filters.dateTo) {
      const to = new Date(filters.dateTo + 'T23:59:59').getTime();
      records = records.filter(r => r.timestamp <= to);
    }
    return records;
  }

  return {
    STORE, SVN_STORE,
    addRecord, getAllRecords, getRecordsByIds, deleteRecords, clearAll, queryRecords,
    setPref, getPref,
  };
})();
