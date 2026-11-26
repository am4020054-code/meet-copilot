"""Offline public-package audit. Report paths/categories, never matched values."""
from pathlib import Path
import re
import os
import sys
ROOT=Path(__file__).resolve().parent
patterns={
    'machine-path':re.compile(r'/Users/|/home/[^/\s]+/|[A-Z]:\\Users\\'),
    'token-like':re.compile(r'\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|[a-f0-9]{32})\b'),
    'private-key':re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
}
for term in filter(None, os.environ.get('PUBLIC_AUDIT_FORBIDDEN', '').split(',')):
    patterns['private-content-' + str(len(patterns))] = re.compile(re.escape(term), re.I)
fail=[]
for path in ROOT.rglob('*'):
    if not path.is_file() or '.git' in path.parts or '__pycache__' in path.parts: continue
    rel=str(path.relative_to(ROOT))
    if rel=='audit_public.py': continue # detector deliberately contains secret/path signatures
    if path.suffix in ('.jsonl','.db','.sqlite','.pem','.key') or path.name in ('knowledge.json','credentials.json','local_preferences.json'):
        fail.append((rel,'private-artifact'))
    try: text=path.read_text()
    except UnicodeDecodeError:
        fail.append((rel,'unreviewed-binary'));continue
    for kind,pattern in patterns.items():
        if pattern.search(text):fail.append((rel,kind))
for path,kind in fail:print(path+': '+kind)
print('Public audit: '+('FAIL' if fail else 'PASS'))
sys.exit(bool(fail))
