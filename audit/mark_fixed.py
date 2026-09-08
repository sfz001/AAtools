#!/usr/bin/env python3
"""把某条问题标记为已修复并重建报告。

    python3 audit/mark_fixed.py <编号> "实际改法"

已修复项会在报告里加删除线、置灰并移到最底部的「已修复」区。
"""
import json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, 'issues.json')

if len(sys.argv) < 3:
    sys.exit('用法: mark_fixed.py <编号> "实际改法"')

rank, note = int(sys.argv[1]), sys.argv[2]
d = json.load(open(DATA))
hit = next((i for i in d['issues'] if i['rank'] == rank), None)
if hit is None:
    sys.exit(f'找不到 #{rank}')

hit['fixed'] = True
hit['fixed_note'] = note
json.dump(d, open(DATA, 'w'), ensure_ascii=False, indent=1)
print(f'#{rank} 已标记为修复：{hit["title"][:56]}')
subprocess.run([sys.executable, os.path.join(HERE, 'build.py')], check=True)
