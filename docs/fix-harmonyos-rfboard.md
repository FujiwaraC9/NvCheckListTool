# 鸿蒙识别与 rfboard.id 检测修复方案

本文记录 `nv-check` skill 版调试中定位到的两类问题及修复方法，供 UI 版（`web/`）同步修复：

1. 鸿蒙设备无法识别（只走 adb，没有 hdc 回退）
2. 已读到 `/proc/cmdline` 却被判为「检测失败」（rfboard.id 误判）

涉及文件：`web/server.py`、`web/lib/serial.js`、`web/app.js`。

---

## 一、问题现象

### 1.1 鸿蒙设备识别不到

UI 版 `handle_device_rfboard()` 只执行 `ADB_CMDLINE_COMMANDS`。鸿蒙设备没有 adb 或 adb 无设备，导致：

```
单软多硬检测未成功：adb 报 ...
```

而系统里实际可用的是 `hdc`。

### 1.2 rfboard.id 明明读到了却报失败（关键 bug）

某设备执行链的实际结果：

| 命令 | 结果 |
| --- | --- |
| `adb shell cat /proc/cmdline` | `cat: /proc/cmdline: Permission denied` |
| `adb shell su 0 cat /proc/cmdline` | 成功，输出完整 cmdline，含 `rfboard.id=-1` |
| `adb shell su -c cat /proc/cmdline` | `su: invalid uid/gid '-c'` |

正确输出被丢弃后，脚本继续试最后一条 `su -c`，最终把 `su: invalid uid/gid '-c'` 当成失败原因上报。

**根因**：cmdline 里包含：

```
androidboot.vbmeta.invalidate_on_error=yes
```

如果「是否为有效 cmdline」的判断用了宽泛关键字 `error`，整段 cmdline 会被误判为命令报错并丢弃。

> 结论：黑名单不能用 `error` 这种到处都会出现的词；`invalidate_on_error`、`verifiedbootstate` 等参数都可能命中。

### 1.3 `int(value, 0)` 的隐患

`int('08', 0)` 在 Python 中会抛 `ValueError`（base=0 不接受前导 0）。若 rfboard.id 输出为 `08`，会被当成「未找到」。

---

## 二、服务端修复（server.py）

### 2.1 命令表：adb + hdc 双工具

保留原有 adb 命令顺序，新增 hdc 命令。`su -c` 放最后，仅作兼容尝试。

```python
# ---- 单软多硬检测（/proc/cmdline 的 rfboard.id）----
ADB_CMDLINE_COMMANDS = [
    # eng/root 设备可免 root 直读
    ['adb', 'shell', 'cat', '/proc/cmdline'],
    # 老式 su（su <uid> <命令...>），多数展锐设备 -c 不可用
    ['adb', 'shell', 'su', '0', 'cat', '/proc/cmdline'],
    ['adb', 'shell', "su 0 sh -c 'cat /proc/cmdline'"],
    # 新式 su（toybox 的 -c 语法），放最后
    ['adb', 'shell', 'su', '-c', 'cat', '/proc/cmdline'],
]

HDC_CMDLINE_COMMANDS = [
    ['hdc', 'shell', 'cat', '/proc/cmdline'],
    ['hdc', 'shell', 'su', '0', 'cat', '/proc/cmdline'],
]

ADB_TIMEOUT = 15
```

### 2.2 有效性判断（不要用 `error`）

```python
def _valid_cmdline(raw):
    """判断输出是不是真正的 /proc/cmdline，而不是 adb/hdc 的报错文本。"""
    t = (raw or '').strip()
    if not t:
        return False
    low = t.lower()
    # 注意：禁止加入宽泛的 'error'，cmdline 本身可能含 invalidate_on_error
    bad = (
        'failed', 'no devices', 'not found', '[empty]', 'connect server',
        'unauthorized', 'daemon not running', 'permission denied',
        'invalid uid/gid', 'need connect-key',
    )
    if any(x in low for x in bad):
        return False
    # cmdline 的特征：含 rfboard.id=，或整体是 key=value 空格分隔
    return 'rfboard.id=' in low or ('=' in t and ' ' in t)
```

### 2.3 统一读取函数（工具回退 + 只报最后一个有效错误）

```python
def _read_cmdline(tool, commands):
    """依次尝试命令，返回 (cmdline, 错误信息, 实际工具, 工具是否存在)。

    读到有效 cmdline 立即返回；全部失败时返回最后一次错误。
    """
    raw, err, tool_found = '', '', False
    for cmd in commands:
        try:
            proc = subprocess.run(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=ADB_TIMEOUT,
            )
        except FileNotFoundError:
            continue
        except subprocess.TimeoutExpired:
            tool_found = True
            err = '%s 命令超时' % tool
            continue
        except OSError as e:
            tool_found = True
            err = '%s 执行失败: %s' % (tool, e)
            continue

        tool_found = True
        out = proc.stdout.decode('utf-8', 'replace').strip()
        errout = proc.stderr.decode('utf-8', 'replace').strip()

        if out and _valid_cmdline(out):
            return out, '', tool, True
        if out:
            errout = out[:120]
        err = errout.splitlines()[0][:200] if errout else err

    return raw, err, tool, tool_found
```

### 2.4 替换 `handle_device_rfboard()`

```python
def handle_device_rfboard(self):
    """判断设备是否单软多硬项目。

    规则：rfboard.id 为 -1 或找不到 → 非单软多硬；非负值 → 单软多硬。
    Android 优先 adb，鸿蒙自动回退 hdc。
    """
    raw, err, tool = '', '', ''
    notes = []

    for name, commands in (('adb', ADB_CMDLINE_COMMANDS),
                           ('hdc', HDC_CMDLINE_COMMANDS)):
        raw, e, t, found = _read_cmdline(name, commands)
        if raw:
            tool, err = t, ''
            break
        if found:
            notes.append('%s：%s' % (name, e or '未读到 /proc/cmdline'))
        else:
            notes.append('%s：命令不可用（未安装或不在 PATH 中）' % name)

    if not raw:
        self.send_json(200, {
            'ok': False, 'multi_hw': None, 'rfboard_id': None,
            'raw': '', 'tool': '', 'error': '；'.join(notes),
        })
        return

    matches = re.findall(r'rfboard\.id=(-?[0-9]+)', raw)
    board_id = None
    if matches:
        try:
            board_id = int(matches[-1], 10)   # 用十进制，避免 int('08', 0) 报错
        except ValueError:
            board_id = None

    multi = board_id is not None and board_id >= 0
    self.send_json(200, {
        'ok': True,
        'multi_hw': multi,
        'rfboard_id': board_id,
        'raw': raw[:4000],
        'tool': tool,                          # 'adb' / 'hdc'，前端可展示
        'error': '' if matches else '未找到 rfboard.id，按非单软多硬处理',
    })
```

### 2.5 关键点

- adb 失败（无设备、无权限、命令不存在）后必须继续尝试 hdc，不能提前 `return`。
- `hdc` 未连接时常见输出：`[Fail]ExecuteCommand need connect-key? please confirm a device by help info`，已被 `_valid_cmdline` 过滤，不会当成 cmdline。
- 只有 adb/hdc 都拿不到有效内容时才返回 `ok=false`，错误信息里带各自原因。

---

## 三、前端修复（app.js）

`detectMultiHw()`（约 757 行）读取 `/api/device/rfboard` 后：

1. 日志里把写死的 `adb` 改为接口返回的 `tool`，鸿蒙时显示 hdc：

```js
const via = data.tool === 'hdc' ? 'hdc' : 'adb';
logLine('检测单软多硬（' + via + ' 读 rfboard.id）...', 'info');
```

2. 读取结果展示同样用 `data.tool`：

```js
logLine('  ' + via + ' /proc/cmdline rfboard.id=' +
  (data.rfboard_id == null ? '未找到' : data.rfboard_id) +
  ' → ' + (data.multi_hw ? '单软多硬' : '非单软多硬'), 'info');
```

3. `rfboard_id` 为 `null` 但 `raw` 非空时，说明 cmdline 读到了、只是没有该字段，应按「非单软多硬」继续，不要中断检查。
4. `ok=false` 时保留手动下拉选择，不阻断 NV 检查。

---

## 四、鸿蒙 AT+QGMR 识别

样例响应（红线段为用户测试写入，解析时忽略）：

```
AT+QGMR
Quectel
UIS7885
Revision: QSC530CPBSGROH03A01_BOH02BP01K0M01_OHP6.1.0.01.050
OK
```

### 4.1 平台

现有 `parseQgmr()` 已按平台选项做包含匹配，只要配置里含 `UIS7885` 即可识别，无需改动。

### 4.2 安卓版本

鸿蒙 QGMR 没有 `Android`/`AP` 字样，`parseAndroidVersion()` 返回 `null`。调用方应把 `null` 视为「通用」，不要当识别失败：

- 规则：9 / 10 / 12 以外，一律归为「通用」。
- 鸿蒙、Android 14 等非标准版本都落到「通用」。

### 4.3 系统版本（如 OH6）

从 Revision 中提取 `OH` + 主版本号：

```js
function parseOhVersion(respText) {
  if (!respText) return null;
  const m = respText.match(/(?:^|_)OH[A-Z]*(\d+)(?=[._]|$)/im);
  return m ? ('OH' + m[1]) : null;   // OHP6.1.0.01.050 → OH6
}
```

仅在识别到 `OH` 版本时展示「系统版本」，不影响安卓维度。

### 4.4 modem 基线

- 优先 `parseCgmr()` 读 `BASE Version:`。
- 鸿蒙设备读不到 `BASE Version:` 时，可回退用 QGMR `Revision:` 整段作为基线展示，并在界面标注「来源：QGMR」，避免被误认为标准基线号。

---

## 五、验证方法

### 5.1 手工确认读取链路

```powershell
adb shell cat /proc/cmdline          # 预期：Permission denied（非 root）
adb shell su 0 cat /proc/cmdline     # 预期：输出含 rfboard.id=-1
hdc shell cat /proc/cmdline          # 鸿蒙设备执行，预期输出 cmdline
```

### 5.2 接口验证

Android：

```powershell
curl http://localhost:8765/api/device/rfboard
```

预期：

```json
{"ok":true,"tool":"adb","rfboard_id":-1,"multi_hw":false,"error":""}
```

鸿蒙预期 `tool` 为 `hdc`。

### 5.3 回归清单

- [ ] Android 非 root 设备：`cat` 被拒后，`su 0` 仍能读到 rfboard.id
- [ ] cmdline 含 `androidboot.vbmeta.invalidate_on_error=yes`：不再误判失败
- [ ] 鸿蒙设备：自动使用 hdc，`tool=hdc`
- [ ] adb 与 hdc 都不可用：返回明确原因，页面不崩溃、不阻断检查
- [ ] `rfboard.id=08`：解析为 8，不报 ValueError
- [ ] `rfboard.id=-1`：判定「非单软多硬」
- [ ] 鸿蒙 QGMR 样例：平台 UIS7885、安卓「通用」、系统版本 OH6
- [ ] NV 检查与 SVN 校验流程不受影响

---

## 六、skill 版对应实现

供对照：

- `d:\Workspace\NvCheckListTool\.trae\skills\nv-check\scripts\nv_check.py`
  - 命令表：`ADB_CMDLINE_COMMANDS` / `HDC_CMDLINE_COMMANDS`
  - 有效性判断：`_valid_cmdline`
  - 读取与回退：`_read_cmdline`、`detect_rfboard`
  - 结果解析：`rfboard\.id=(-?[0-9a-zA-Z]+)` + `int(..., 10)`
- 修复后实测输出：`单软多硬：否（adb /proc/cmdline rfboard.id=-1）`
