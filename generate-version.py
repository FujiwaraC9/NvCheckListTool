# -*- coding: utf-8 -*-
"""
生成 version.json —— 推送前运行此脚本，自动计算所有追踪文件的 SHA1 并更新清单。
用法：  py -3 generate-version.py
"""
import hashlib, json, os

BASE = os.path.dirname(os.path.abspath(__file__))

# 需要追踪更新的文件（相对 web/ 目录）
TRACKED = [
    'index.html', 'app.js', 'styles.css', 'server.py', 'launch.bat',
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

def main():
    manifest = {'version': '', 'files': {}}
    for rel in TRACKED:
        full = os.path.join(BASE, rel.replace('/', os.sep))
        if os.path.isfile(full):
            manifest['files'][rel] = sha1(full)
    # 版本号：取所有文件 hash 的组合 hash 前 8 位，保证内容变就版本变
    combined = ''.join(manifest['files'].values())
    manifest['version'] = hashlib.sha1(combined.encode()).hexdigest()[:8]
    out = os.path.join(BASE, 'version.json')
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print('version.json 已生成，版本号: %s，追踪 %d 个文件' % (manifest['version'], len(manifest['files'])))

if __name__ == '__main__':
    main()
