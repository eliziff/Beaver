"""The records a pin file cites, as a small pack. python -I cutpack.py PINS OUT PACK[,PACK]. Run from C:/courtlistener-structure."""
import json, re, sys
pins, out, packs = sys.argv[1:4]
wanted = {json.loads(l)['cluster'] for l in open(pins, encoding='utf-8')}
mark = re.compile(r'cluster_id\\": \\"(\d+)')
n = 0
with open(out, 'w', encoding='utf-8', newline='\n') as w:
    for pack in packs.split(','):
        for line in open(pack, encoding='utf-8'):
            m = mark.search(line)
            if m and m.group(1) in wanted:
                w.write(line); n += 1
print('pins cite', len(wanted), 'opinions; records written', n)
