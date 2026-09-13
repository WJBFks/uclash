#!/usr/bin/env python3
"""mihomo 订阅源导入脚本（与 ~/.zshrc clash import 子命令逻辑一致）。
环境变量: CFG=config.yaml 路径, URL=订阅URL, PNAME=新 provider 名（空=更新默认源 mysub）
         PDEL=1      删除模式：从 proxy-providers 段移除 PNAME 的声明块
         PCREATE=1   仅声明模式：向 proxy-providers 段插入 PNAME（不切换 use 引用）
         PSWITCH=1   切换模式：把注入块之外所有 use: 列表指向 PNAME（独占激活语义）
成功 exit 0；失败非 0 且 stderr 输出原因（调用方负责回滚备份）。
"""
import re, sys, os

path = os.environ['CFG']
url = os.environ['URL']
name = os.environ.get('PNAME', '')
delete = os.environ.get('PDEL', '') == '1'
lines = open(path, encoding='utf-8').read().splitlines()

# 1. 找到 proxy-providers 段内已有 provider 名（用于重名检测）
i = next((k for k, l in enumerate(lines) if l.startswith('proxy-providers:')), None)
if i is None:
    sys.exit('config.yaml 中未找到 proxy-providers 段')
end = i + 1
while end < len(lines) and (lines[end].strip() == '' or lines[end].startswith(' ')):
    end += 1

# 0. 删除模式：移除 PNAME 的声明块
if delete:
    if not name:
        sys.exit('删除模式需要 PNAME')
    j = None
    for k in range(i + 1, end):
        m = re.match(r'^  (\S[^:]*):\s*$', lines[k])
        if m and m.group(1).strip('"\'') == name:
            j = k
            break
    if j is None:
        sys.exit(f'provider {name} 未找到')
    k = j + 1
    while k < end and not re.match(r'^  \S[^:]*:\s*$', lines[k]):
        k += 1
    del lines[j:k]
    # 段空了要写成 {}（否则 mihomo 热加载会拒掉 null 段）
    new_end = end - (k - j)
    remaining = [l for l in lines[i + 1:new_end] if re.match(r'^  \S[^:]*:\s*$', l)]
    if not remaining:
        while i + 1 < new_end and lines[i + 1].strip() == '':
            del lines[i + 1]
            new_end -= 1
        lines[i] = 'proxy-providers: {}'
    out = '\n'.join(lines) + '\n'
    open(path, 'w', encoding='utf-8').write(out)
    print(f'[import] 已删除 provider {name}，配置已写入（旧版已备份为 .bak.*）')
    sys.exit(0)

providers = set()
for l in lines[i + 1:end]:
    m = re.match(r'^  (\S[^:]*):$', l)
    if m:
        providers.add(m.group(1).strip('"' + chr(39)))

create_only = os.environ.get('PCREATE', '') == '1'
switch_only = os.environ.get('PSWITCH', '') == '1'

# 注入模式：PCREATE 补声明（未声明的源）+ PSWITCH 把 use 引用切到目标源
if create_only or switch_only:
    if not name:
        sys.exit('PCREATE/PSWITCH 模式需要 PNAME')
    found_ref = False
    if create_only:
        if name in providers:
            sys.exit(f'provider 名 {name} 已存在')
        if not url:
            sys.exit('PCREATE 模式需要 URL')
        new = [f'  {name}:', '    type: http', f'    url: "{url}"', '    interval: 86400', f'    path: ./providers/{name}.yaml']
        lines = lines[:end] + new + [''] + lines[end:]
    if switch_only:
        # 注入块（# >>> ... # <<<）由 clash-web 管理，跳过；其余 use: 列表独占指向 name
        switched = 0
        k = 0
        in_block = False
        while k < len(lines):
            l = lines[k]
            t = l.strip()
            if t.startswith('# >>>'):
                in_block = True
                k += 1
                continue
            if in_block and t.startswith('# <<<'):
                in_block = False
            if not in_block:
                m2 = re.match(r'^\s+use:\s*$', l)
                if m2:
                    idx = k + 1
                    items = []
                    while idx < len(lines):
                        mm = re.match(r'^(\s+)-\s*(.+?)\s*$', lines[idx])
                        if not mm:
                            break
                        items.append([idx, len(mm.group(1)), mm.group(2).strip("\'\"")])
                        idx += 1
                    prov_items = [it for it in items if it[2] in providers or it[2] == name]
                    if prov_items:
                        found_ref = True
                        if any(it[2] != name for it in prov_items):
                            base = prov_items[0][1]
                            lines[prov_items[0][0]] = ' ' * base + '- ' + name
                            for it in prov_items[1:]:
                                if it[2] != name:
                                    lines[it[0]] = None
                            switched += 1
                    k = idx
                    continue
            k += 1
        lines = [l for l in lines if l is not None]
        if not found_ref:
            sys.exit('未找到可切换的 use: 引用（主配置需有引用订阅源的组，如 PROXY/Auto）')
        if switched == 0:
            print(f'[import] use 引用已全部指向 {name}，主配置无需修改')
    out = '\n'.join(lines) + '\n'
    open(path, 'w', encoding='utf-8').write(out)
    print(f'[import] 订阅源 {name} 注入主配置，配置已写入（旧版已备份为 .bak.*）')
    sys.exit(0)

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
        # 合并模式：更新已存在 provider 的 url（clash-web「检测到已导入相同链接 → 合并」路径）
        j = None
        for k in range(i + 1, end):
            m = re.match(r'^  (\S[^:]*):\s*$', lines[k])
            if m and m.group(1).strip('"\'') == name:
                j = k
                break
        if j is None:
            sys.exit(f'provider {name} 声明块未找到')
        k = j + 1
        updated_url = False
        while k < end and not re.match(r'^  \S[^:]*:\s*$', lines[k]):
            m = re.match(r'^(\s*url:\s*)(.*)$', lines[k])
            if m:
                lines[k] = m.group(1) + '"' + url + '"'
                updated_url = True
                break
            k += 1
        if not updated_url:
            sys.exit(f'provider {name} 声明块中未找到 url 行')
        out = '\n'.join(lines) + '\n'
        open(path, 'w', encoding='utf-8').write(out)
        print(f'[import] 合并完成：已更新 provider {name} 的 url，配置已写入（旧版已备份为 .bak.*）')
        sys.exit(0)
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
