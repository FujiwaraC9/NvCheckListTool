# -*- coding: utf-8 -*-
"""
生成 version.json —— 推送前运行此脚本，自动计算所有追踪文件的 SHA1 并更新清单。

用法：
  py -3 generate-version.py          # 版本号自动递增最后一位：v1.0.1 -> v1.0.2
  py -3 generate-version.py v2.0.0   # 手动指定版本号（大改动时用）

说明：version 是明文版本号；files 记录每个文件的 SHA1 指纹，
更新机制据此做增量对比（只下载有变化的文件）。
"""
import hashlib
import json
import os
import re
import sys

BASE = os.path.dirname(os.path.abspath(__file__))

# 需要追踪更新的文件（相对本目录，与 server.py 的 TRACKED_FILES 保持一致）
TRACKED = [
    'index.html', 'app.js', 'styles.css', 'server.py', '启动启动通通启动.bat',
    'lib/db.js', 'lib/serial.js', 'lib/nvm-parser.js', 'lib/config-manager.js',
    'lib/excel-export.js', 'lib/svn-check.js', 'lib/exceljs.min.js',
    'config/default-checklist.js', 'config/default-checklist.json',
]


def sha1(path):
    h = hashlib.sha1()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(8192), b''):
            h.update(chunk)
    return h.hexdigest()


def next_version(old):
    """旧版本号最后一位自动加 1；无法识别的格式（如早期内容哈希）从 v1.0.1 起步。"""
    m = re.match(r'^v?(\d+)\.(\d+)\.(\d+)$', str(old).strip())
    if not m:
        return 'v1.0.1'
    a, b, c = (int(x) for x in m.groups())
    return 'v%d.%d.%d' % (a, b, c + 1)


def main():
    old_version = ''
    vpath = os.path.join(BASE, 'version.json')
    if os.path.isfile(vpath):
        try:
            with open(vpath, 'r', encoding='utf-8') as f:
                old_version = json.load(f).get('version', '')
        except Exception:
            pass

    if len(sys.argv) > 1:
        version = 'v' + sys.argv[1].lstrip('v')
    else:
        version = next_version(old_version)

    manifest = {'version': version, 'files': {}}
    for rel in TRACKED:
        full = os.path.join(BASE, rel.replace('/', os.sep))
        if os.path.isfile(full):
            manifest['files'][rel] = sha1(full)
        else:
            print('[warn] 文件不存在，已跳过: %s' % rel)

    with open(vpath, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print('version.json 已生成：版本号 %s（上一次 %s），追踪 %d 个文件'
          % (version, old_version or '无', len(manifest['files'])))


if __name__ == '__main__':
    main()
