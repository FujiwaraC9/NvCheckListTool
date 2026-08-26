/**
 * NVM 文件解析器
 * 逻辑等价于 Python 脚本的 parse_item_content + normalize_value
 *
 * nvm 文件是文本格式（类 ini/键值对），结构大致为：
 *   ITEM_NAME = edch_Category
 *   ...
 *   BEGIN_ITEM
 *     ITEM_CONTENT = 0x7
 *   END_ITEM
 * 或 ITEM_CONTENT 可能出现在 BEGIN_ITEM 之前（Python 脚本的逻辑是从 ITEM_NAME 到下一个 BEGIN_ITEM 之间找 ITEM_CONTENT）。
 */
const NvmParser = (function () {

  /**
   * 在 nvm 文本中找 ITEM_NAME = <itemName> 的块，返回 ITEM_CONTENT 原始字符串（如 '0x7'）。
   * 找不到返回 null。
   */
  function parseItemContent(nvmText, itemName) {
    const escaped = itemName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pat = new RegExp('ITEM_NAME\\s*=\\s*' + escaped + '\\s*$', 'gim');
    let m;
    while ((m = pat.exec(nvmText)) !== null) {
      const rest = nvmText.substring(m.index + m[0].length);
      const endIdx = rest.indexOf('BEGIN_ITEM');
      const block = endIdx === -1 ? rest : rest.substring(0, endIdx);
      const cm = block.match(/ITEM_CONTENT\s*=\s*(\S+)/i);
      if (cm) {
        return cm[1].trim();
      }
    }
    return null;
  }

  /**
   * 把 0x7 / 07 / 7 / 0x00 归一化为整数。失败返回 null。
   */
  function normalizeValue(s) {
    if (s == null) return null;
    let t = String(s).trim().toLowerCase();
    if (!t) return null;
    t = t.replace(/^0x/, '').replace(/^x/, '').replace(/_/g, '');
    // 如果包含非 16 进制字符则返回 null
    if (!/^[0-9a-f]+$/.test(t)) return null;
    try { return parseInt(t, 16); } catch (e) { return null; }
  }

  /**
   * 读取 File System Access API 的 File 对象为文本（自动尝试多种编码）。
   */
  async function readFileAsText(file) {
    // 先尝试 UTF-8
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    // 检测 BOM
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[0] === 0xBF) {
      return new TextDecoder('utf-8').decode(bytes.slice(3));
    }
    // 尝试 UTF-8（不抛错模式）
    try {
      const dec = new TextDecoder('utf-8', { fatal: true });
      return dec.decode(bytes);
    } catch (e) { /* fall through */ }
    // 尝试 GBK
    try {
      return new TextDecoder('gbk').decode(bytes);
    } catch (e) { /* fall through */ }
    // 最后用 latin-1 兜底
    return new TextDecoder('latin1').decode(bytes);
  }

  /**
   * 从文件夹句柄读取指定文件名，返回文本；文件不存在返回 null。
   * @param {FileSystemDirectoryHandle} dirHandle
   * @param {string} fileName
   */
  async function readFileFromDir(dirHandle, fileName) {
    try {
      const fileHandle = await dirHandle.getFileHandle(fileName);
      const file = await fileHandle.getFile();
      return await readFileAsText(file);
    } catch (e) {
      if (e.name === 'NotFoundError' || e.name === 'TypeMismatchError') return null;
      // 某些浏览器抛 DOMException.NotFoundError
      if (e.code === 8 || e.code === 1) return null;
      throw e;
    }
  }

  return { parseItemContent, normalizeValue, readFileAsText, readFileFromDir };
})();
