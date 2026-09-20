#!/usr/bin/env python3
from pathlib import Path
import re
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[2]
CURRENT=[
 'PRODUCT-CHARTER-Version-1.2.1-FINAL.txt',
 'MASTER-WBS-Version-1.2.1-FINAL.txt',
 'DATA-RELAY-UX-CHARTER-v1.2.1-FINAL.txt',
 'DATA-RELAY-STREAM-WIZARD-UX-CHARTER-v5.2-FINAL.txt',
 'GOVERNANCE-UX-CHARTER-v1.1-FINAL.txt',
 'DATA-RELAY-GOVERNANCE-WORKSPACE-UX-CHARTER-v1.1-FINAL.txt',
 'DATA-RELAY-GOVERNANCE-WORKSPACE-v1.1-FINAL.txt',
 'DATA-RELAY-GOVERNANCE-AND-TRANSFORM-POLICY-DRAFT-v1.1-FINAL.txt',
 'DATA-RELAY-UNION-SCHEMA-UX-SPEC-v1.1-FINAL.txt',
]
fail=[]
sot=ROOT/'docs/source-of-truth'
idx=(ROOT/'docs/architecture/source-of-truth-index.md').read_text(encoding='utf-8')
for name in CURRENT:
    p=sot/name
    if not p.is_file(): fail.append(f'missing current Source-of-Truth document: {p.relative_to(ROOT)}')
    if f'docs/source-of-truth/{name}' not in idx and name not in idx:
        fail.append(f'Source-of-Truth index does not reference: {name}')
tracked=subprocess.check_output(['git','-C',str(ROOT),'ls-files','docs/source-of-truth/_incoming'],text=True).splitlines()
if tracked: fail.append('tracked _incoming staging files: '+', '.join(tracked))
md=(ROOT/'docs/master-design.md').read_text(encoding='utf-8')[:1200]
if 'SUPERSEDED' not in md: fail.append('docs/master-design.md lacks SUPERSEDED banner')
for sp in (ROOT/'specs').glob('*/spec.md'):
    txt=sp.read_text(encoding='utf-8',errors='replace')
    if re.search(r'(?i)master[ -]design', txt):
        fail.append(f'current spec references superseded master design: {sp.relative_to(ROOT)}')
readme=(ROOT/'README.md').read_text(encoding='utf-8')
if 'Single source of truth for architecture: [`docs/master-design.md`' in readme:
    fail.append('README.md still declares master-design as single source of truth')
docsread=(ROOT/'docs/README.md').read_text(encoding='utf-8')
if '| [Master Design](./master-design.md) | Authoritative architecture reference |' in docsread:
    fail.append('docs/README.md still declares master-design authoritative')
constitution=(ROOT/'.specify/memory/constitution.md').read_text(encoding='utf-8')
for token in ['Data Relay Control Specification Constitution','docs/architecture/source-of-truth-index.md','One Stream → Many Routes → Many Destinations']:
    if token not in constitution: fail.append(f'constitution missing token: {token}')
specs=sorted(str(p.relative_to(ROOT)) for p in (ROOT/'specs').glob('*/spec.md'))
spec_index=(ROOT/'.specify/specs-index.md').read_text(encoding='utf-8')
refs=sorted(set(re.findall(r'\]\(\.\./(specs/[^)]+/spec\.md)\)', spec_index)))
if specs!=refs:
    missing=sorted(set(specs)-set(refs)); stale=sorted(set(refs)-set(specs))
    if missing: fail.append('spec index missing: '+', '.join(missing))
    if stale: fail.append('spec index stale: '+', '.join(stale))
if fail:
    for x in fail: print('FAIL',x)
    print('SOURCE_OF_TRUTH_VALIDATION=FAIL')
    sys.exit(1)
print(f'CURRENT_SOT_DOCUMENTS={len(CURRENT)}')
print(f'TRACKED_SPECS={len(specs)}')
print('SOURCE_OF_TRUTH_VALIDATION=PASS')
