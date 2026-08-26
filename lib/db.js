/**
 * IndexedDB 封装 - 存储检查记录
 * 数据库: NvCheckListDB
 * 表(store): records - keyPath: id (自增)
 */
const DB = (function () {
  const DB_NAME = 'NvCheckListDB';
  const DB_VERSION = 1;
  const STORE = 'records';
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
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function addRecord(record) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const rec = { ...record, timestamp: record.timestamp || Date.now() };
      const req = store.add(rec);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getAllRecords() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function getRecordsByIds(ids) {
    const all = await getAllRecords();
    const set = new Set(ids);
    return all.filter(r => set.has(r.id));
  }

  async function deleteRecords(ids) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      ids.forEach(id => store.delete(id));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function clearAll() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * 按条件筛选记录
   * filters: { moduleKeyword, result ('pass'|'fail'|''), dateFrom (YYYY-MM-DD), dateTo (YYYY-MM-DD) }
   */
  async function queryRecords(filters = {}) {
    let records = await getAllRecords();
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

  return { addRecord, getAllRecords, getRecordsByIds, deleteRecords, clearAll, queryRecords };
})();
