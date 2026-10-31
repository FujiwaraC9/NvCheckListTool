# modem 版本与 NV 工程匹配检查（已下线，保留实现方案）

> 状态：**功能已移除**，仅保留设计文档与参考实现，日后如需复用可按本文加回。
> 遗留原因：实际检查读取的是 NV 工程里的值，与设备无关，该匹配检查对现场流程没有实际收益；
> 且「强力匹配」还需额外指定 researchdownload 解压路径，操作成本偏高。

## 1. 功能目的

防止「用错 NV 工程」：设备当前运行的 modem 基线，必须能在所选 NV 工程中找到对应痕迹，
否则「开始检查」按钮保持禁用，并提示 **modem版本与所选NV工程不匹配**。

## 2. 匹配规则

以 `AT+CGMR` 读到的基线为例：`BASE Version: 4G_MODEM_22A_W23.35.2`

| 步骤 | 规则 |
| --- | --- |
| 1. 截取 modem 版本 | 正则 `/^(?:\dG[_-])?MODEM[_-](.+)$/i` 取捕获组 → `22A_W23.35.2`；`FM_BASE_xxx` 等非 MODEM 基线返回 `null`，判定为「不适用」并放行 |
| 2. 找工程侧 nvitem.bin | 在项目文件夹**根目录 + 第一级子目录**找文件名以 `nvitem.bin` 结尾的文件（不递归更深层） |
| 3. 内容搜索 | 在该文件**二进制内容**中搜索 modem 版本串；同时兼容 ASCII 与 UTF-16LE 两种存储编码 |
| 4. 强力匹配（可选） | 勾选后：先比对「厂包解压目录」与「工程目录」两侧 nvitem.bin 的**文件名完全一致**，通过后才做第 3 步；两次检查任一失败即失败 |
| 5. 强制选择 | 勾选强力匹配但未选厂包路径时，不允许开始检查 |

失败一律提示「modem版本与所选NV工程不匹配」，可附括号原因（未找到 nvitem.bin / 文件名不一致 / 厂包路径下未找到）。

## 3. 状态机与按钮联动

```
modemMatch: 'idle' | 'na' | 'running' | 'ok' | 'fail'
```

- 徽章文案：`idle`=待检查 / `na`=不适用 / `running`=检查中… / `ok`=匹配成功 / `fail`=匹配失败
- 放行规则：`ok` 与 `na` 放行「开始检查」，其余一律禁用
- 防竞态：每次运行自增 `state._modemMatchToken`，回调里比对序号，过期结果直接丢弃
- 防抖：基线输入 / 文件夹变化后 300ms 再执行（`scheduleModemMatch`）

## 4. 触发点

| 时机 | 位置 |
| --- | --- |
| 基线输入框变化 | `bindDimensionEvents` 内 baseline 的 change 回调 |
| 选择/切换项目文件夹完成 | `selectFolder()` 末尾 |
| 串口自动读取维度完成 | `autoReadDimensions()` 末尾 |
| 页面初始化恢复上次文件夹后 | `init()` 内 |
| 强力匹配勾选切换 / 厂包路径选择完成 | `bindModemMatchEvents` |

## 5. 参考实现

### 5.1 版本截取与放行判定

```javascript
/** 从基线版本截取 modem 版本：4G_MODEM_22A_W23.35.2 → 22A_W23.35.2 */
function extractModemVer(baseline) {
  if (!baseline) return null;
  const m = String(baseline).trim().match(/^(?:\dG[_-])?MODEM[_-](.+)$/i);
  return m ? m[1] : null;
}

/** modem 匹配是否放行「开始检查」：匹配成功/不适用 放行，其余禁用 */
function modemMatchAllowsRun() {
  return state.modemMatch === 'ok' || state.modemMatch === 'na';
}
```

### 5.2 二进制搜索（兼容 ASCII / UTF-16LE）

```javascript
/** 朴素字节搜索：hay 中是否包含 needle */
function searchBytes(hay, needle) {
  if (!needle.length || needle.length > hay.length) return false;
  outer:
  for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/** 在 ArrayBuffer 中搜索文本：ASCII 与 UTF-16LE 两种编码都试 */
function binContains(buf, text) {
  const bytes = new Uint8Array(buf);
  if (searchBytes(bytes, new TextEncoder().encode(text))) return true;
  const u16 = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    u16[i * 2] = c & 0xff;
    u16[i * 2 + 1] = c >> 8;
  }
  return searchBytes(bytes, u16);
}
```

### 5.3 查找 nvitem.bin（根目录 + 第一级子目录）

```javascript
/** 返回 [{ name, handle, dir }]；dir 为所在子目录名，根目录为空串 */
async function findNvitemBins(dirHandle) {
  const found = [];
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === 'file' && /nvitem\.bin$/i.test(name)) {
      found.push({ name, handle, dir: '' });
    }
  }
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind !== 'directory') continue;
    try {
      for await (const [sub, subHandle] of handle.entries()) {
        if (subHandle.kind === 'file' && /nvitem\.bin$/i.test(sub)) {
          found.push({ name: sub, handle: subHandle, dir: name });
        }
      }
    } catch (e) { /* 无权限的子目录跳过 */ }
  }
  return found;
}
```

### 5.4 主流程

```javascript
async function runModemMatch() {
  const token = ++state._modemMatchToken;
  const baseline = state.selection.baseline;
  if (!baseline) { setModemMatchState('idle', '等待基线版本（连接串口自动读取或手动填写）'); return; }

  const ver = extractModemVer(baseline);
  state.modemVer = ver || '';
  // 非 MODEM 基线 → 不适用（基线自身属性，与是否已选文件夹无关）
  if (!ver) { setModemMatchState('na', '当前基线 ' + baseline + ' 非 MODEM 基线，跳过匹配检查'); return; }
  if (!state.dirHandle) { setModemMatchState('idle', '等待项目文件夹'); return; }
  if (state.forceMatch && !state.factoryDirHandle) {
    setModemMatchState('idle', '已勾选强力匹配，请选择厂包解压路径'); return;
  }

  setModemMatchState('running', '正在检查 modem 与 NV 工程匹配 ...');
  const finish = (st, msg, log, level) => {
    if (token !== state._modemMatchToken) return;   // 过期结果丢弃
    if (log) logLine(log, level || 'info');
    setModemMatchState(st, msg);
  };

  try {
    // ① 工程侧 nvitem.bin
    const projFiles = await findNvitemBins(state.dirHandle);
    if (!projFiles.length) {
      return finish('fail', 'modem版本与所选NV工程不匹配（未找到 nvitem.bin）',
        '[modem匹配] 项目文件夹（含第一级子目录）下未找到 nvitem.bin', 'err');
    }

    // ② 强力匹配：文件名必须完全一致
    let hitName = projFiles[0].name;
    if (state.forceMatch) {
      const factoryFiles = await findNvitemBins(state.factoryDirHandle);
      if (!factoryFiles.length) {
        return finish('fail', 'modem版本与所选NV工程不匹配（厂包路径下未找到 nvitem.bin）', '', 'err');
      }
      if (factoryFiles[0].name !== projFiles[0].name) {
        return finish('fail', 'modem版本与所选NV工程不匹配（nvitem.bin 文件名不一致）',
          '[modem匹配] 文件名比对不一致：厂包 ' + factoryFiles[0].name + ' ≠ 工程 ' + projFiles[0].name, 'err');
      }
      hitName = factoryFiles[0].name;
    }

    // ③ 内容搜索
    for (const f of projFiles) {
      const file = await f.handle.getFile();
      const buf = await file.arrayBuffer();
      if (binContains(buf, ver)) {
        return finish('ok', '匹配成功（' + ver + '）', '[modem匹配] 内容中搜索到 ' + ver + '，匹配成功', 'ok');
      }
    }
    return finish('fail', 'modem版本与所选NV工程不匹配',
      '[modem匹配] nvitem.bin 内容中未搜索到 ' + ver + '，判定不匹配', 'err');
  } catch (e) {
    finish('fail', '匹配检查出错: ' + e.message, '[modem匹配] 检查出错: ' + e.message, 'err');
  }
}
```

### 5.5 状态 UI 与防抖

```javascript
/** 更新匹配状态 UI（st: idle|na|running|ok|fail），并联动开始检查按钮 */
function setModemMatchState(st, text) {
  state.modemMatch = st;
  const map = {
    idle: ['待检查', 'idle'], na: ['不适用', 'na'], running: ['检查中...', 'running'],
    ok: ['匹配成功', 'ok'], fail: ['匹配失败', 'fail'],
  };
  const badge = $('#modem-match-state');
  const detail = $('#modem-match-detail');
  if (badge) { badge.textContent = map[st][0]; badge.className = 'modem-match-state ' + map[st][1]; }
  if (detail) detail.textContent = text;
  updateRunButton();
}

let _modemMatchTimer = null;
function scheduleModemMatch() {
  if (_modemMatchTimer) clearTimeout(_modemMatchTimer);
  _modemMatchTimer = setTimeout(() => { runModemMatch(); }, 300);
}
```

### 5.6 强力匹配：厂包路径选择与事件绑定

```javascript
async function selectFactoryDir() {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'read' });
    state.factoryDirHandle = handle;
    state.factoryDirName = handle.name;
    $('#factory-dir-name').textContent = handle.name;
    $('#btn-select-factory-dir').textContent = '重新选择厂包解压路径';
    logLine('[modem匹配] 厂包解压路径: ' + handle.name, 'info');
    scheduleModemMatch();
  } catch (e) {
    if (e.name !== 'AbortError') await modalAlert('选择厂包解压路径失败: ' + e.message, '错误', 'error');
  }
}

/** 绑定 modem 匹配区事件（强力匹配勾选 / 厂包路径选择） */
function bindModemMatchEvents() {
  const chk = $('#chk-force-match');
  chk.addEventListener('change', () => {
    state.forceMatch = chk.checked;
    // 切换勾选时重置厂包路径，避免残留旧选择造成状态不一致
    state.factoryDirHandle = null;
    state.factoryDirName = '';
    $('#factory-dir-name').textContent = '';
    $('#btn-select-factory-dir').textContent = '选择厂包解压路径';
    $('#factory-dir-row').style.display = chk.checked ? '' : 'none';
    scheduleModemMatch();
  });
  $('#btn-select-factory-dir').addEventListener('click', selectFactoryDir);
}
```

## 6. 需要一并加回的 UI

插在 `.status-card` 内、`.status-grid` 之前：

```html
<!-- modem 与 NV 工程匹配检查 -->
<div class="modem-match-box" id="modem-match-box">
  <div class="modem-match-head">
    <span class="modem-match-title">modem 匹配检查</span>
    <span class="modem-match-state idle" id="modem-match-state">待检查</span>
  </div>
  <div class="modem-match-detail" id="modem-match-detail">连接串口（自动读取基线）并选择项目文件夹后自动检查</div>
  <div class="force-match-row">
    <label class="force-match-label" title="强力匹配会同时检查nvitem.bin的文件名是否匹配，勾选后请同步选择researchdownload的解压路径">
      <input type="checkbox" id="chk-force-match">强力匹配
    </label>
  </div>
  <div class="factory-dir-row" id="factory-dir-row" style="display:none">
    <button class="btn btn-folder" id="btn-select-factory-dir">选择厂包解压路径</button>
    <span class="factory-dir-name" id="factory-dir-name"></span>
  </div>
</div>
```

样式类（放在 `.status-value` 之后、`/* ===== 输入框 ===== */` 之前）：
`.modem-match-box`、`.modem-match-head`、`.modem-match-title`、`.modem-match-state`（含 `.idle/.na/.running/.ok/.fail` 五态配色，
分别用 `--text-secondary/--warn-*/--accent-*/--pass-badge-*/--fail-badge-*` 变量）、`.modem-match-detail`、
`.force-match-row`、`.force-match-label`、`.factory-dir-row`、`.factory-dir-name`。
`.status-card` 需加 `flex-wrap: wrap`，`.modem-match-box` 用 `flex-basis: 100%` 独占一行。

## 7. 加回步骤清单

1. 恢复上述 `state` 字段：`modemMatch` / `modemVer` / `forceMatch` / `factoryDirHandle` / `factoryDirName` / `_modemMatchToken`
2. 按第 5 节恢复函数，并 `bindModemMatchEvents()` 注册进 `bindEvents()`
3. 按第 6 节恢复 HTML 与 CSS
4. 在 `updateRunButton()` 的 ready 条件中追加 `&& modemMatchAllowsRun()`，禁用文案加回 `getRunTipMessage()` 的 modem 分支
5. 在 `runCheck()` 开头加前置校验：不满足则弹窗提示并 return
6. 在 4 个触发点（基线输入、选文件夹、自动读取完成、init 恢复文件夹）调用 `scheduleModemMatch()`
7. 注意：File System Access API 需要 `showDirectoryPicker`，仅 Chrome/Edge 桌面版可用

## 8. 已知限制

- nvitem.bin 体积较大（MB 级）时，二进制搜索会读入整个文件到内存，页面会有短暂卡顿
- 只查根目录与第一级子目录，更深的层级找不到 nvitem.bin；若工程结构调整需同步放宽
- 强力匹配只取两侧**第一个** nvitem.bin 做文件名比对，多 nvitem.bin 的工程存在不确定性
