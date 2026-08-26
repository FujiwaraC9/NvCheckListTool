/**
 * Excel 批量导出 - 基于 ExcelJS
 * 生成带样式的 xlsx 文件（pass 绿底、fail 红底，表头蓝底白字）
 * 与原 Python 脚本 openpyxl 输出风格一致。
 */
const ExcelExport = (function () {
  const FONT_NAME = 'Segoe UI Semibold';
  const FONT_SIZE = 12;
  const ROW_HEIGHT = 24;

  function colName(n) {
    let s = '';
    while (n >= 1) {
      const rem = (n - 1) % 26;
      s = String.fromCharCode(65 + rem) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  function charWidth(s) {
    let w = 0;
    for (const ch of String(s)) {
      w += ch.charCodeAt(0) > 127 ? 2 : 1;
    }
    return w;
  }

  /**
   * 导出检查记录为 Excel 文件，浏览器直接下载
   * @param {Array} records - 数据库里取出的记录数组
   * @param {object} cfg     - 当前 ConfigManager.get()（提供 check_items 顺序）
   */
  async function exportRecords(records, cfg) {
    if (!records || records.length === 0) {
      throw new Error('没有可导出的记录');
    }
    if (typeof ExcelJS === 'undefined') {
      throw new Error('ExcelJS 库未加载，请检查 lib/exceljs.min.js');
    }

    const checkItems = cfg.check_items || [];
    const headers = ['模块型号', 'AT+QFSGVERSION?', ...checkItems, '时间', 'fail信息'];

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'NvCheckList Web';
    workbook.created = new Date();

    const ws = workbook.addWorksheet('Checklist', {
      properties: { defaultRowHeight: ROW_HEIGHT },
    });

    // --- 表头 ---
    const headerRow = ws.getRow(1);
    headers.forEach((h, i) => {
      const cell = headerRow.getCell(i + 1);
      cell.value = h;
      cell.font = { name: FONT_NAME, size: FONT_SIZE, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.border = {
        left: { style: 'thin', color: { argb: 'FFB0B0B0' } },
        right: { style: 'thin', color: { argb: 'FFB0B0B0' } },
        top: { style: 'thin', color: { argb: 'FFB0B0B0' } },
        bottom: { style: 'thin', color: { argb: 'FFB0B0B0' } },
      };
    });
    headerRow.height = ROW_HEIGHT;

    // 条件格式：C:H 区域（对应 6 个检查项，第3列到第2+checkItems.length列）
    // ExcelJS 的 conditionalFormatting 用法
    const firstItemCol = 3;
    const lastItemCol = 2 + checkItems.length;
    const rangePass = colName(firstItemCol) + '2:' + colName(lastItemCol) + (records.length + 1);

    // ExcelJS addConditionalFormatting 比较底层，直接在写入单元格时给颜色即可（更可靠）

    // --- 数据行 ---
    records.forEach((rec, idx) => {
      const rowNum = idx + 2;
      const row = ws.getRow(rowNum);
      const cellBase = { name: FONT_NAME, size: FONT_SIZE };
      const center = { horizontal: 'center', vertical: 'middle', wrapText: true };
      const left = { horizontal: 'left', vertical: 'middle', wrapText: true };
      const border = {
        left: { style: 'thin', color: { argb: 'FFB0B0B0' } },
        right: { style: 'thin', color: { argb: 'FFB0B0B0' } },
        top: { style: 'thin', color: { argb: 'FFB0B0B0' } },
        bottom: { style: 'thin', color: { argb: 'FFB0B0B0' } },
      };

      // 列 1：模块型号
      const c1 = row.getCell(1);
      c1.value = rec.module || '';
      c1.font = cellBase;
      c1.alignment = center;
      c1.border = border;

      // 列 2：AT+QFSGVERSION? 全文
      const c2 = row.getCell(2);
      c2.value = rec.at_version || '';
      c2.font = cellBase;
      c2.alignment = left;
      c2.border = border;

      // 列 3..2+N：检查项
      let failLines = [];
      let maxLines = 1;
      checkItems.forEach((item, i) => {
        const col = 3 + i;
        const cell = row.getCell(col);
        const result = rec.results && rec.results[item];
        const verdict = result ? result.verdict : 'fail';
        const raw = result ? result.raw : null;
        cell.value = verdict;
        cell.font = { ...cellBase, color: { argb: verdict === 'pass' ? 'FF006100' : 'FF9C0006' } };
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: verdict === 'pass' ? 'FFC6EFCE' : 'FFFFC7CE' },
        };
        cell.alignment = center;
        cell.border = border;

        if (verdict === 'fail') {
          failLines.push(item + '=' + (raw != null ? raw : '未找到'));
        }
      });

      // 列 N+3：时间
      const timeCol = 3 + checkItems.length;
      const tc = row.getCell(timeCol);
      tc.value = formatDateTime(rec.timestamp);
      tc.font = cellBase;
      tc.alignment = center;
      tc.border = border;

      // 列 N+4：fail信息
      const failCol = 4 + checkItems.length;
      const fc = row.getCell(failCol);
      const failText = failLines.join('\n');
      fc.value = failText || null;
      fc.font = cellBase;
      fc.alignment = left;
      fc.border = border;
      if (failLines.length > 0) maxLines = failLines.length;

      // 行高：fail 多行则加高
      row.height = Math.max(ROW_HEIGHT, 15 * maxLines);
    });

    // --- 列宽自适应 ---
    for (let c = 1; c <= headers.length; c++) {
      let w = charWidth(headers[c - 1]);
      for (let r = 2; r <= records.length + 1; r++) {
        const v = ws.getCell(r, c).value;
        if (v != null) {
          const lines = String(v).split('\n');
          for (const ln of lines) {
            w = Math.max(w, charWidth(ln));
          }
        }
      }
      ws.getColumn(c).width = Math.min(Math.max(w + 3, 10), 50);
    }

    // --- 冻结首行 ---
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    // --- 下载 ---
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const ts = formatFileStamp(new Date());
    const fname = 'NvCheckList_' + ts + '.xlsx';
    triggerDownload(blob, fname);
    return fname;
  }

  function formatDateTime(ts) {
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function formatFileStamp(d) {
    const pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
      '_' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  return { exportRecords };
})();
