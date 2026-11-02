"""Where Detect-Order-Construct's errors on development come from, the model's heads apart from the decoding of them
(`doc.rs`): read by the fitted checkpoint over the line dump, each head's choices against the gold's, by kind of case.
- line links: each gold link (a line's successor in its region) and each gold end (a region's last line): whether the
  successor head chose it, whether the predecessor head chose it back, and whether the decoding kept it (both heads,
  or the successor's over a half); a link kept across a gold opening (a merge) by whether that line's role opens;
- regions: each gold region's lines in one decoded group, split, or merged with another region's;
- continuations: each gold continuation (a unit going on in a later region) by the page distance and how many regions
  stand between, chosen right, chosen none (itself), or chosen elsewhere;
- note links: each note's gold region (the mark's) on the note's page or not, chosen right or not; whether the region
  chosen holds a mark of the note's number;
- heading parents: by the gold parent's distance (how many headings back) and the step of levels.
python doc_diagnose.py LINE_DUMP GOLD_STORE CHECKPOINT"""
import os, sys
from collections import Counter
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np, torch
import docparse as d

dump, store, checkpoint = sys.argv[1:4]
saved = torch.load(checkpoint, map_location="cpu", weights_only=False)
state = saved["model"]
model = d.DocParser(state["detect.look.0.weight"].shape[1], state["detect.text.0.weight"].shape[1], saved["width"]).to(d.DEVICE)
model.load_state_dict(state)
model.eval()
docs = [x for x in d.load(dump, store) if x.split == "development"]
tag = saved["text"].replace("/", "_")
key = None
for doc in docs:
    emb = np.load(os.path.join(dump, f"{doc.sha}.{tag}.npy"))
    doc.ready = d.Ready(doc, saved["mean"], saved["std"], lambda _: emb)
c = Counter()


def softmax(f):
    return torch.softmax(f.float(), dim=-1)


with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16, enabled=d.DEVICE == "cuda"):
    for doc in docs:
        r = d.on_device(doc)
        states = model.detect(r.f, r.t, r.b, r.lines)
        role = model.detect.role(states).float().argmax(1).cpu().numpy()
        n = doc.n
        succ_choice, succ_sure, pred_choice = np.arange(n), np.zeros(n), np.arange(n)
        for head, out in ((model.detect.successor, "s"), (model.detect.predecessor, "p")):
            for batch, (logits, _) in zip(r.lines.batches, d.page_links(head, states, r.b, r.lines, r.successor)):
                nodes = batch.nodes.cpu().numpy()
                width = batch.rows.shape[1]
                rows = batch.rows.cpu().numpy()
                page_of = batch.valid_at.cpu().numpy() // width
                local = logits.argmax(1).cpu().numpy()
                chosen = rows[page_of, local]
                if out == "s":
                    succ_choice[nodes] = chosen
                    succ_sure[nodes] = softmax(logits).max(1).values.cpu().numpy()
                else:
                    pred_choice[nodes] = chosen
        kept = np.array([succ_choice[k] != k and (pred_choice[succ_choice[k]] == k or succ_sure[k] > 0.5) for k in range(n)])
        opens = role % 2 == 1
        for k in range(n):
            g = doc.successor[k]
            if g < 0:
                continue
            if g != k:  # a gold link
                c["link"] += 1
                c["link: successor right"] += succ_choice[k] == g
                c["link: predecessor right"] += pred_choice[g] == k
                c["link: kept right"] += kept[k] and succ_choice[k] == g
                c["link: broken (decoded end)"] += not kept[k]
                alone = kept[k] and pred_choice[succ_choice[k]] != k
                c["link: kept by the successor's sureness alone"] += alone
                c["link: kept by the successor's sureness alone, right"] += alone and succ_choice[k] == g
                c["link: kept into a line whose role opens"] += kept[k] and opens[succ_choice[k]]
                c["link: kept into a line whose role opens, right"] += kept[k] and opens[succ_choice[k]] and succ_choice[k] == g
            else:  # a gold end
                c["end"] += 1
                c["end: successor right"] += succ_choice[k] == k
                if kept[k]:
                    c["end: merged by a kept link"] += 1
                    c["end: merged, the linked line's role opens"] += opens[succ_choice[k]]
                    c["end: merged, by the successor's sureness alone"] += pred_choice[succ_choice[k]] != k
        # Regions: gold regions against the decoded groups (union-find over kept links, as doc.rs).
        group = list(range(n))

        def find(k):
            while group[k] != k:
                group[k] = group[group[k]]
                k = group[k]
            return k
        for k in range(n):
            if kept[k]:
                a, b = find(k), find(int(succ_choice[k]))
                group[max(a, b)] = min(a, b)
        decoded = np.array([find(k) for k in range(n)])
        for region in set(doc.region[doc.region >= 0].tolist()):
            lines = np.flatnonzero(doc.region == region)
            groups = set(decoded[lines].tolist())
            c["region"] += 1
            outside = np.isin(decoded, list(groups)) & (doc.region != region)
            if len(groups) > 1:
                c["region: split"] += 1
            if outside.any():
                c["region: merged with another"] += 1
            if len(groups) == 1 and not outside.any():
                c["region: exact"] += 1
                votes = Counter((role[lines] // 2).tolist())
                guess, want = votes.most_common(1)[0][0], d.region_of(int(doc.role[lines[0]] // 2)) if doc.role[lines[0]] >= 0 else -1
                if want >= 0 and guess != want:
                    c[f"region role: {d.REGIONS[want]} read as {d.REGIONS[guess]}"] += 1
        if not doc.regions:
            continue
        regions = model.order(states, r.region_lines, r.line_region, r.region_role)
        goes = model.order.goes_on(regions).float().argmax(1).cpu().numpy()
        notes = model.order.note_of(regions).float().argmax(1).cpu().numpy()
        firsts = np.asarray(doc.regions)
        pages = doc.pages[firsts]
        for i, g in enumerate(doc.goes_on):
            if g < 0:
                continue
            if g == i:
                c["no continuation"] += 1
                c["no continuation: chosen none"] += goes[i] == i
                continue
            gap = int(pages[g] - pages[i])
            between = g - i - 1
            kind = f"continuation: {'same page' if gap == 0 else 'next page' if gap == 1 else 'later page'}, {'adjacent' if between == 0 else 'regions between'}"
            c[kind] += 1
            c[kind + " / right"] += goes[i] == g
            c[kind + " / chose none"] += goes[i] == i
        refs = d.json.load(open(os.path.join(dump, f"{doc.sha}.json"), encoding="utf-8")).get("references") or []
        for i, g in enumerate(doc.note_of):
            if g < 0:
                continue
            label = "".join(ch for ch in doc.texts[firsts[i]].strip()[:4] if ch.isdigit())
            same = pages[g] == pages[i]
            kind = "note: " + ("no mark found (itself)" if g == i else "mark on its page" if same else "mark on another page")
            c[kind] += 1
            c[kind + " / right"] += notes[i] == g
            chosen = notes[i]
            lines = np.flatnonzero(doc.region_of_line == chosen)
            c[kind + " / chosen holds its number"] += any(str(ref[0]) == label for k in lines for ref in (refs[k] if k < len(refs) else []))
        if len(doc.headings) >= 2:
            p, _ = model.headings(regions[torch.as_tensor(doc.headings, device=d.DEVICE)])
            chosen = d.earlier(p.float()).argmax(1).cpu().numpy()
            for i, g in enumerate(doc.heading_parent):
                back = "root" if g == i else "previous" if g == i - 1 else "further back"
                c[f"heading parent: {back}"] += 1
                c[f"heading parent: {back} / right"] += chosen[i] == g

for name in sorted(c):
    base = name.split(" / ")[0].split(": ")[0] if ": " in name else name
    whole = c[name.split(" / ")[0]] if " / " in name else c[base]
    print(f"{name:62} {c[name]:7}  {c[name] / max(whole, 1):.3f}")
