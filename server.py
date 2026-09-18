# -*- coding: utf-8 -*-
"""
NvCheckList 本地服务（仅依赖 Python 3 标准库）
功能：
  1. 提供当前目录的静态文件服务（index.html / app.js / ...）
  2. /api/svn?url=<SVN 文件直链>  反向代理
     - 浏览器直连 SVN 会遇到 CORS 拦截，且需要账号认证；
       由本地服务转发请求，可绕过 CORS，并把页面传来的 Basic 认证头透传给 SVN。

【强制只读】
  本工具对 FSG 表格只有只读权限，绝不向 SVN 写入/提交任何内容。
  代理在服务端以方法白名单硬性限制：仅放行 GET / HEAD / OPTIONS / PROPFIND
  （PROPFIND 是 WebDAV 的“读取属性”操作），其余方法
  （PUT/POST/DELETE/MERGE/MKCOL/COPY/MOVE/LOCK/UNLOCK/CHECKIN/CHECKOUT/...）一律返回 405。

启动：python server.py 8765
"""
import sys
import os
import ssl
import json
import hashlib
import urllib.parse
import urllib.request
import urllib.error
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

# 仅放行的“读”类 WebDAV/HTTP 方法（全大写）。任何写操作都不在其中，会被 405 拒绝。
READ_ONLY_METHODS = {'GET', 'HEAD', 'OPTIONS', 'PROPFIND'}
# 仅允许代理访问的 SVN 主机白名单
ALLOWED_SVN_HOSTS = {'svn.quectel.com'}

# 公司内网 SVN 使用自签名证书；本地工具仅转发到固定的可信内网域名，
# 因此对代理请求跳过证书校验（不影响浏览器到本地服务的 http 连接）。
_SSL_CTX = ssl.create_default_context()
_SSL_CTX.check_hostname = False
_SSL_CTX.verify_mode = ssl.CERT_NONE

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PORT = 8765

# ---- 更新机制 ----
# GitHub 仓库地址（raw 文件直链基础）
GITHUB_RAW = 'https://raw.githubusercontent.com/FujiwaraC9/NvCheckListTool/main/'
REMOTE_VERSION_URL = GITHUB_RAW + 'version.json'
# 追踪的文件列表（与 generate-version.py 保持一致）
TRACKED_FILES = [
    'index.html', 'app.js', 'styles.css', 'server.py', 'launch.bat',
    'lib/db.js', 'lib/serial.js', 'lib/nvm-parser.js', 'lib/config-manager.js',
    'lib/excel-export.js', 'lib/svn-check.js', 'lib/exceljs.min.js',
    'config/default-checklist.js', 'config/default-checklist.json',
]
# 更新后需要重启服务才生效的文件
RESTART_FILES = {'server.py', 'launch.bat'}


def _sha1_file(path):
    h = hashlib.sha1()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(8192), b''):
            h.update(chunk)
    return h.hexdigest()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def log_message(self, fmt, *args):
        # 静态请求保持安静，只在代理出错时打印
        pass

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        # 只声明允许读类方法，写方法从不被支持
        self.send_header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS, PROPFIND')

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    # 统一入口：所有方法都先过只读白名单，再决定是否转发
    def do_GET(self):
        self._dispatch('GET')

    def do_HEAD(self):
        self._dispatch('HEAD')

    def do_PROPFIND(self):
        self._dispatch('PROPFIND')

    # 任何写/其他方法：对 /api/svn 一律 405 拒绝（绝不转发给 SVN）
    def do_PUT(self):
        self._reject_write('PUT')

    def do_POST(self):
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == '/api/update/apply':
            self.handle_update_apply()
        else:
            self._reject_write('POST')

    def do_DELETE(self):
        self._reject_write('DELETE')

    def do_MERGE(self):
        self._reject_write('MERGE')

    def do_MKCOL(self):
        self._reject_write('MKCOL')

    def do_COPY(self):
        self._reject_write('COPY')

    def do_MOVE(self):
        self._reject_write('MOVE')

    def do_LOCK(self):
        self._reject_write('LOCK')

    def do_UNLOCK(self):
        self._reject_write('UNLOCK')

    def do_CHECKIN(self):
        self._reject_write('CHECKIN')

    def do_CHECKOUT(self):
        self._reject_write('CHECKOUT')

    def do_MKACTIVITY(self):
        self._reject_write('MKACTIVITY')

    def do_PROPPATCH(self):
        self._reject_write('PROPPATCH')

    def _reject_write(self, method):
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == '/api/svn':
            # 关键防线：写操作直接在本地拒绝，请求体也不读取、不转发
            self.send_json(405, {'ok': False, 'error': '工具为只读模式，禁止对 SVN 执行 %s 操作' % method})
        else:
            self.send_error(405, 'Method Not Allowed')

    def __getattr__(self, name):
        # 兜底：为所有未显式实现的 do_XXX 方法统一拒绝（任何罕见/自定义写方法也无法转发）。
        # 注意：__getattr__ 仅在正常属性查找失败时触发，do_GET/do_PUT 等已定义项不受影响。
        if name.startswith('do_'):
            method = name[3:]
            if method not in READ_ONLY_METHODS:
                def _deny():
                    parsed = urllib.parse.urlsplit(getattr(self, 'path', '') or '')
                    if parsed.path == '/api/svn':
                        self.send_json(405, {'ok': False, 'error': '工具为只读模式，禁止对 SVN 执行 %s 操作' % method})
                    else:
                        self.send_error(405, 'Method Not Allowed')
                return _deny
        raise AttributeError(name)

    def _dispatch(self, method):
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == '/api/svn':
            self.handle_svn_proxy(parsed, method)
        elif parsed.path == '/api/update/check' and method == 'GET':
            self.handle_update_check()
        else:
            # 非代理路径只接受普通 GET/HEAD/OPTIONS 静态访问
            if method == 'GET':
                super().do_GET()
            elif method == 'HEAD':
                super().do_HEAD()
            else:
                self.send_error(405, 'Method Not Allowed')

    def handle_svn_proxy(self, parsed, method):
        # 二次兜底校验（理论上调用方已过滤）
        if method not in READ_ONLY_METHODS or method == 'OPTIONS':
            self.send_json(405, {'ok': False, 'error': '仅支持只读操作'})
            return

        qs = urllib.parse.parse_qs(parsed.query)
        target = qs.get('url', [''])[0]
        if not target:
            self.send_json(400, {'ok': False, 'error': 'missing url'})
            return

        # 取出页面传来的 Basic 认证头并透传
        auth = self.headers.get('Authorization', '')

        # 正确处理含中文/空格的 SVN 路径：对路径段做百分号编码
        t = urllib.parse.urlsplit(target)

        # 仅允许转发到公司 SVN 主机白名单，避免成为开放代理
        if t.scheme not in ('http', 'https') or t.hostname not in ALLOWED_SVN_HOSTS:
            self.send_json(403, {'ok': False, 'error': '仅允许访问公司 SVN（svn.quectel.com）'})
            return

        quoted_path = urllib.parse.quote(urllib.parse.unquote(t.path), safe="/%")
        final_url = urllib.parse.urlunsplit((t.scheme, t.netloc, quoted_path, t.query, t.fragment))

        # 构造只读请求；PROPFIND 需携带 Depth 头与请求体
        body = None
        req_headers = {'User-Agent': 'NvCheckList/3.0 (read-only)'}
        if auth:
            req_headers['Authorization'] = auth
        if method == 'PROPFIND':
            depth = self.headers.get('Depth', '0')
            req_headers['Depth'] = depth if depth in ('0', '1', 'infinity') else '0'
            req_headers['Content-Type'] = 'text/xml; charset=utf-8'
            length = int(self.headers.get('Content-Length', 0) or 0)
            if length > 0:
                body = self.rfile.read(length)
                req_headers['Content-Length'] = str(len(body))
            # 默认请求文件自身的活属性（版本/作者/时间/大小）
            if not body:
                body = (
                    b'<?xml version="1.0" encoding="utf-8"?>'
                    b'<propfind xmlns="DAV:"><prop>'
                    b'<version-name xmlns="http://subversion.tigris.org/xmlns/dav/"/>'
                    b'<creator-displayname xmlns="http://subversion.tigris.org/xmlns/dav/"/>'
                    b'<getlastmodified/><getcontentlength/>'
                    b'</prop></propfind>'
                )
                req_headers['Content-Length'] = str(len(body))

        req = urllib.request.Request(final_url, data=body, method=method, headers=req_headers)

        ctx = _SSL_CTX if t.scheme == 'https' else None
        opener = urllib.request.urlopen
        try:
            with opener(req, timeout=30, context=ctx) if ctx else opener(req, timeout=30) as resp:
                data = resp.read()
                ctype = resp.headers.get('Content-Type', 'application/octet-stream')
                self.send_response(207 if method == 'PROPFIND' else 200)
                self._cors()
                self.send_header('Content-Type', ctype)
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                # HEAD 不回传 body
                if method != 'HEAD':
                    self.wfile.write(data)
        except urllib.error.HTTPError as e:
            data = e.read() if hasattr(e, 'read') else b''
            self.send_response(e.code)
            self._cors()
            ctype = e.headers.get('Content-Type', '') if e.headers else ''
            if method == 'PROPFIND' or 'xml' in ctype:
                # PROPFIND 的错误把原始 XML 透传给前端解析/排错
                self.send_header('Content-Type', ctype or 'application/xml; charset=utf-8')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                if method != 'HEAD':
                    self.wfile.write(data)
            else:
                msg = 'SVN 认证失败（账号或密码错误）' if e.code == 401 else ('SVN 返回错误 %d' % e.code)
                payload = ('{"ok":false,"error":%s}' % _json_str(msg)).encode('utf-8')
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
        except Exception as e:
            self.send_json(502, {'ok': False, 'error': '无法访问 SVN：%s' % e})

    # ---- 更新检查 ----
    def handle_update_check(self):
        """对比本地文件 SHA1 与远程 version.json，返回哪些文件有变更。"""
        try:
            # 读取本地 version.json
            local_ver_path = os.path.join(BASE_DIR, 'version.json')
            local_version = ''
            if os.path.isfile(local_ver_path):
                with open(local_ver_path, 'r', encoding='utf-8') as f:
                    local_data = json.load(f)
                    local_version = local_data.get('version', '')
            # 计算本地追踪文件的 SHA1
            local_hashes = {}
            for rel in TRACKED_FILES:
                full = os.path.join(BASE_DIR, rel.replace('/', os.sep))
                if os.path.isfile(full):
                    local_hashes[rel] = _sha1_file(full)

            # 拉取远程 version.json
            req = urllib.request.Request(REMOTE_VERSION_URL, headers={'User-Agent': 'NvCheckList/3.0'})
            with urllib.request.urlopen(req, timeout=10) as resp:
                remote_data = json.loads(resp.read().decode('utf-8'))
            remote_version = remote_data.get('version', '')
            remote_files = remote_data.get('files', {})

            if remote_version == local_version:
                self.send_json(200, {'hasUpdate': False, 'localVersion': local_version, 'remoteVersion': remote_version, 'changedFiles': []})
                return

            # 找出变更文件
            changed = []
            for rel in TRACKED_FILES:
                rh = remote_files.get(rel, '')
                lh = local_hashes.get(rel, '')
                if rh and rh != lh:
                    changed.append(rel)
            need_restart = any(f in RESTART_FILES for f in changed)
            self.send_json(200, {
                'hasUpdate': True,
                'localVersion': local_version,
                'remoteVersion': remote_version,
                'changedFiles': changed,
                'needRestart': need_restart,
            })
        except urllib.error.URLError:
            self.send_json(200, {'hasUpdate': False, 'error': '无法连接 GitHub 检查更新（可能未联网）'})
        except Exception as e:
            self.send_json(200, {'hasUpdate': False, 'error': '检查更新失败：%s' % e})

    # ---- 执行更新 ----
    def handle_update_apply(self):
        """下载远程变更文件并覆盖本地文件。"""
        try:
            # 读取请求体（期望 JSON: {"files": ["app.js", ...]}）
            length = int(self.headers.get('Content-Length', 0) or 0)
            body = self.rfile.read(length) if length > 0 else b'{}'
            req_data = json.loads(body.decode('utf-8')) if body else {}
            files_to_update = req_data.get('files', [])

            # 如果没指定文件，从 check 接口逻辑获取完整变更列表
            if not files_to_update:
                # 重新拉远程清单对比
                req = urllib.request.Request(REMOTE_VERSION_URL, headers={'User-Agent': 'NvCheckList/3.0'})
                with urllib.request.urlopen(req, timeout=10) as resp:
                    remote_data = json.loads(resp.read().decode('utf-8'))
                remote_files = remote_data.get('files', {})
                for rel in TRACKED_FILES:
                    full = os.path.join(BASE_DIR, rel.replace('/', os.sep))
                    rh = remote_files.get(rel, '')
                    if rh and (not os.path.isfile(full) or _sha1_file(full) != rh):
                        files_to_update.append(rel)

            if not files_to_update:
                self.send_json(200, {'ok': True, 'updated': [], 'message': '没有需要更新的文件'})
                return

            updated = []
            errors = []
            for rel in files_to_update:
                # 安全校验：只允许追踪列表中的文件，防止路径穿越
                if rel not in TRACKED_FILES:
                    errors.append('%s: 不在追踪列表中，已跳过' % rel)
                    continue
                # 防路径穿越
                full = os.path.normpath(os.path.join(BASE_DIR, rel.replace('/', os.sep)))
                if not full.startswith(BASE_DIR):
                    errors.append('%s: 路径非法，已跳过' % rel)
                    continue
                try:
                    url = GITHUB_RAW + rel
                    req = urllib.request.Request(url, headers={'User-Agent': 'NvCheckList/3.0'})
                    with urllib.request.urlopen(req, timeout=30) as resp:
                        data = resp.read()
                    os.makedirs(os.path.dirname(full), exist_ok=True)
                    with open(full, 'wb') as f:
                        f.write(data)
                    updated.append(rel)
                except Exception as e:
                    errors.append('%s: 下载失败 (%s)' % (rel, e))

            # 更新本地 version.json
            try:
                req = urllib.request.Request(REMOTE_VERSION_URL, headers={'User-Agent': 'NvCheckList/3.0'})
                with urllib.request.urlopen(req, timeout=10) as resp:
                    remote_data = json.loads(resp.read().decode('utf-8'))
                with open(os.path.join(BASE_DIR, 'version.json'), 'w', encoding='utf-8') as f:
                    json.dump(remote_data, f, ensure_ascii=False, indent=2)
            except Exception:
                pass  # version.json 更新失败不影响主流程

            need_restart = any(f in RESTART_FILES for f in updated)
            self.send_json(200, {
                'ok': len(errors) == 0,
                'updated': updated,
                'errors': errors,
                'needRestart': need_restart,
                'message': '已更新 %d 个文件' % len(updated),
            })
        except Exception as e:
            self.send_json(500, {'ok': False, 'error': '更新失败：%s' % e})

    def send_json(self, code, obj):
        payload = _json_dumps(obj).encode('utf-8')
        self.send_response(code)
        self._cors()
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def _json_str(s):
    import json
    return json.dumps(str(s), ensure_ascii=False)


def _json_dumps(obj):
    import json
    return json.dumps(obj, ensure_ascii=False)


def main():
    port = DEFAULT_PORT
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            pass
    os.chdir(BASE_DIR)
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print('NvCheckList server running at http://127.0.0.1:%d/  (read-only SVN proxy, Ctrl+C to stop)' % port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nServer stopped.')
        server.shutdown()


if __name__ == '__main__':
    main()
