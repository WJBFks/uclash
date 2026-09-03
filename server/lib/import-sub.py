#!/usr/bin/env python3
"""mihomo 订阅源导入脚本（与 ~/.zshrc clash import 子命令逻辑一致）。
环境变量: CFG=config.yaml 路径, URL=订阅URL, PNAME=新 provider 名（空=更新默认源 mysub）
成功 exit 0；失败非 0 且 stderr 输出原因（调用方负责回滚备份）。
"""
import re, sys, os

path = os.environ['CFG']
url = os.environ['URL']
name = os.environ.get('PNAME', '')
lines = open(path, encoding='utf-8').read().splitlines()

# 1. 找到 proxy-providers 段内已有 provider 名（用于重名检测）
i = next((k for k, l in enumerate(lines) if l.startswith('proxy-providers:')), None)
if i is None:
    sys.exit('config.yaml 中未找到 proxy-providers 段')
end = i + 1
while end < len(lines) and (lines[end].strip() == '' or lines[end].startswith(' ')):
    end += 1
providers = set()
for l in lines[i + 1:end]:
    m = re.match(r'^  (\S[^:]*):$', l)
    if m:
        providers.add(m.group(1).strip('"' + chr(39)))

# 2a. 更新默认源 (mysub) 的 url
if not name or name == 'mysub':
    for k, l in enumerate(lines):
        m = re.match(r'^(\s*url:\s*)(.*)$', l)
        if m:
            lines[k] = m.group(1) + '"' + url + '"'
            break
    else:
        sys.exit('未找到 mysub 的 url 行')
    out = '\n'.join(lines) + '\n'
    mode = 'update'
# 2b. 新增 provider：插入段 + 切换 PROXY/Auto 组对 mysub 的引用
else:
    if name in providers:
        sys.exit(f'provider 名 {name} 已存在（现有: {", ".join(sorted(providers))}），请换一个名字')
    indent = re.search(r'^  \S', '\n'.join(lines[i + 1:end]) or '  x: y').group(0)[:2]
    new = [f'  {name}:', '    type: http', f'    url: "{url}"', '    interval: 86400', f'    path: ./providers/{name}.yaml']
    lines = lines[:end] + new + [''] + lines[end:]
    j = next(k for k, l in enumerate(lines) if l.startswith('proxy-groups:'))
    k = j + 1
    while k < len(lines):
        if re.match(r'^\s+-?\s*name:', lines[k]):
            m = re.search(r'^\s*name:\s*(\S+)', lines[k])
            gname = m.group(1) if m else ''
            u = next((t for t in range(k + 1, min(k + 12, len(lines))) if lines[t].strip().startswith('use:')), None)
            if u is not None and lines[u].strip() == 'use:':
                for t in range(u + 1, len(lines)):
                    mm = re.match(r'^(\s+)-\s+(\S+)\s*$', lines[t])
                    if not mm:
                        break
                    if mm.group(2) == 'mysub':
                        nxt = lines[t + 1] if t + 1 < len(lines) else ''
                        only = (not nxt.strip()) or (len(nxt) - len(nxt.lstrip())) <= (len(mm.group(1)) - 2)
                        if only:
                            lines[t] = mm.group(1) + '- ' + name
                            print(f'  → 组 {gname} 已切换引用: mysub → {name}')
        k += 1
    out = '\n'.join(lines) + '\n'
    mode = 'create'

open(path, 'w', encoding='utf-8').write(out)
print(f'[import] {"新增" if mode == "create" else "更新"} provider {name or "mysub"} 完成，配置已写入（旧版已备份为 .bak.*）')
