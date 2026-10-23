"""Learn reusable word edits from eligible names and decode a bounded beam."""
from collections import defaultdict
import math
import re
import unicodedata

from mine import normalize, words
from operations import align_base, copy_alignment
import shortform as s


def anonymous_key(party):
    prefix = str(len(normalize(party.split("(", 1)[0]))) if "(" in party else "flat"
    return "anonymous:" + str(len(s.anonymous_letters(party,compact=True))) + ":" + prefix


def anonymous_orders(party):
    initials = s.anonymous_letters(party,compact=True)
    if not initials:
        return {}
    group = re.fullmatch(r"\s*([^()]*)\(([^()]*)\)\s*", party)
    if group:
        prefix, suffix = map(normalize, group.groups())
        return {"parenthetical_first": suffix + prefix} if prefix and suffix else {}
    return {"last_first": initials[-1:] + initials[:-1]}


def learn(records):
    templates, tokens, priors, substitutions, joint = {}, defaultdict(lambda: [0., 0.]), defaultdict(lambda: [0., 0.]), {}, {}
    separators, numeric_suffixes, anonymous_programs = defaultdict(lambda: defaultdict(float)), {}, {}
    for record in records:
        parties = record["left"], record["right"]
        total_votes = sum(alias["votes"] for alias in record["aliases"].values())
        for alias in record["aliases"].values():
            alignment = align_base(record, alias["text"])
            alternatives = alignment.get("alternatives", [alignment])
            weight = alias["votes"] / (total_votes * len(alternatives))
            expanded = []
            for value in alternatives:
                if value["family"] == "joint_party_edit":
                    key = ":".join(s.party_type(p) for p in parties)
                    item = joint.setdefault(key, {"weight": 0., "cases": set()})
                    item["weight"] += weight
                    item["cases"].add(record["id"])
                    separator = re.search(r"\s+(v\.?|vs\.?|c\.?)\s+", alias["text"], re.I).group(1)
                    separators[record["language"]][separator.rstrip(".").lower()] += weight
                    expanded.extend({**component, "side": side, "label": label}
                                    for side, (component, label) in enumerate(zip(value["components"], value["text_components"])))
                else:
                    expanded.append(value)
            for value in expanded:
                family = value["family"]
                if "side" not in value or family.startswith(("unresolved", "ambiguous")):
                    continue
                party = parties[value["side"]]
                source, kind = words(party), s.party_type(party)
                if value.get("anonymous_initials"):
                    source = list(s.anonymous_letters(party,compact=True))
                    target = normalize(value.get("label", alias["text"]))
                    for program, output in anonymous_orders(party).items():
                        if target == output and target != "".join(source):
                            item = anonymous_programs.setdefault(program, {"weight": 0., "cases": set()})
                            item["weight"] += weight
                            item["cases"].add(record["id"])
                positions = value.get("positions")
                mode = "copy"
                if "initialism" in family or family == "selected_word_initials":
                    selected = value["source_words"]
                    if family == "selected_word_initials":
                        selected = [selected[i] for i in positions]
                    raw = copy_alignment(" ".join(source), " ".join(selected))
                    if not raw or "positions" not in raw:
                        continue
                    positions = raw["positions"]
                    if family == "reordered_initialism":
                        if value["order_ambiguous"]:
                            continue
                        by_letter = {source[i][0]: i for i in positions}
                        positions = [by_letter[letter] for letter in normalize(value.get("label", alias["text"]))]
                    mode = "initials"
                if positions is None:
                    continue
                key = anonymous_key(party) if value.get("anonymous_initials") else kind + ":" + str(len(source))
                signature = mode + ":" + ",".join(map(str, positions))
                item = templates.setdefault(key, {}).setdefault(signature,
                    {"mode": mode, "positions": positions, "weight": 0., "cases": set()})
                item["weight"] += weight
                item["cases"].add(record["id"])
                if mode == "copy":
                    for i, word in enumerate(source):
                        position = "first" if i == 0 else "last" if i == len(source) - 1 else "middle"
                        for table, token_key in ((tokens, kind + ":" + word), (priors, kind + ":" + position)):
                            table[token_key][0] += weight * (i in positions)
                            table[token_key][1] += weight
                for original, short in value.get("substitutions", []):
                    item = substitutions.setdefault(original, {}).setdefault(short, {"weight": 0., "cases": set()})
                    item["weight"] += weight
                    item["cases"].add(record["id"])
                    if original.isdigit() and short.isdigit() and original.endswith(short):
                        item = numeric_suffixes.setdefault(str(len(short)), {"weight": 0., "cases": set()})
                        item["weight"] += weight
                        item["cases"].add(record["id"])
    def compact(value):
        return {**{k: v for k, v in value.items() if k != "cases"}, "cases": len(value["cases"])}
    return {"schema": "case-name-edits.v2", "beam": 24, "outputs_per_party": 24,
        "tokens": dict(tokens), "priors": dict(priors),
        "templates": {key: sorted((compact(v) for v in values.values() if len(v["cases"]) >= 2),
            key=lambda v: (-v["weight"], v["mode"], v["positions"])) for key, values in templates.items()},
        "substitutions": {word: {short: compact(v) for short, v in values.items() if len(v["cases"]) >= 2}
                          for word, values in substitutions.items()},
        "numeric_suffixes": {size: compact(v) for size, v in numeric_suffixes.items() if len(v["cases"]) >= 2},
        "anonymous_programs": {key: compact(v) for key, v in anonymous_programs.items() if len(v["cases"]) >= 2},
        "separators": {language: dict(values) for language, values in separators.items()},
        "joint": {key: compact(v) for key, v in joint.items() if len(v["cases"]) >= 2}}


def party_proposals(party, side, grammar):
    if not party:
        return []
    text = unicodedata.normalize("NFKC", party)
    spans = list(re.finditer(r"[^\W_]+", text))
    source = [normalize(m.group()) for m in spans]
    if not source or source != words(party):
        return []
    if s.anonymous(party):
        result = [{"text": party, "side": side, "kind": "edit_copy", "score": 0.,
                   "covered": source, "span": [0, len(text)]}]
        initials = s.anonymous_letters(party)
        for template in grammar["templates"].get(anonymous_key(party), []) if initials else []:
            positions = template["positions"]
            if template["mode"] == "initials" and sorted(positions) == list(range(len(initials))):
                result.append({"text": ".".join(initials[i].upper() for i in positions) + ".",
                    "side": side, "kind": "edit_initials", "score": math.log1p(template["weight"]),
                    "covered": source, "span": [0, len(text)]})
        for program, output in anonymous_orders(party).items():
            learned = grammar.get("anonymous_programs", {}).get(program)
            if learned:
                result.append({"text": ".".join(output.upper()) + ".", "side": side,
                    "kind": "edit_initials", "score": math.log1p(learned["weight"]),
                    "covered": source, "span": [0, len(text)]})
        return result
    reordered = []
    compact = s.anonymous_letters(party,compact=True)
    if compact and grammar.get("anonymous_programs"):
        dotted=re.sub(r"[^\W\d_]+",lambda match:".".join(match.group())+".",text)
        for proposal in party_proposals(dotted,side,grammar):
            if proposal["kind"]=="edit_initials":
                reordered.append({**proposal,"covered":source,"span":[0,len(text)]})
    kind, probabilities = s.party_type(party), []
    for i, word in enumerate(source):
        position = "first" if i == 0 else "last" if i == len(source) - 1 else "middle"
        kept, total = grammar["priors"].get(kind + ":" + position, (1., 2.))
        prior = kept / max(1e-9, total)
        kept, total = grammar["tokens"].get(kind + ":" + word, (0., 0.))
        probabilities.append(min(.995, max(.005, (kept + 5 * prior) / (total + 5))))
    beam = [(0., ())]
    for i, probability in enumerate(probabilities):
        beam = sorted([(score + math.log(probability), selected + (i,)) for score, selected in beam]
            + [(score + math.log1p(-probability), selected) for score, selected in beam],
            key=lambda v: (-v[0], v[1]))[:grammar["beam"]]
    paths = [(score, list(selected), "copy") for score, selected in beam if selected]
    for template in grammar["templates"].get(kind + ":" + str(len(source)), []):
        positions = template["positions"]
        fit = sum(math.log(p if i in positions else 1-p) for i, p in enumerate(probabilities))
        paths.append((fit + math.log1p(template["weight"]), positions, template["mode"]))
    proposed = []
    initials = []
    for excluded in (s.CONNECTORS, s.CONNECTORS | s.LEGAL_ENDINGS):
        positions = [i for i, word in enumerate(source) if word not in excluded and word.isalpha()]
        for count in range(2, min(10, len(positions)) + 1):
            selected = positions[:count]
            surface = "".join(spans[i].group()[0] for i in selected).upper()
            if count == 2 and "&" in text[spans[selected[0]].end():spans[selected[1]].start()]:
                surface = surface[0] + "&" + surface[1]
            initials.append({"text": surface, "side": side, "kind": "edit_initials", "score": 0.,
                "covered": [source[i] for i in selected], "span": [spans[selected[0]].start(), spans[selected[-1]].end()]})
    def render(positions, parts):
        value = parts[0]
        for previous, current, word in zip(positions, positions[1:], parts[1:]):
            value += (text[spans[previous].end():spans[current].start()] if current == previous + 1 else " ") + word
        if positions == list(range(len(source))):
            return text[:spans[0].start()] + value + text[spans[-1].end():]
        return value.replace("(", "").replace(")", "")

    joins = []
    for first in range(len(source)):
        for last in range(first + 2, len(source)):
            positions = [first, last]
            surface = render(positions, [spans[i].group() for i in positions])
            if s.complete_fragment(surface, party):
                score = sum(math.log(p if i in positions else 1-p) for i, p in enumerate(probabilities))
                joins.append({"text": surface, "side": side, "kind": "edit_join", "score": score,
                    "covered": [source[i] for i in positions], "span": [spans[first].start(), spans[last].end()]})

    for score, positions, mode in paths:
        if not positions:
            continue
        selected = [spans[i].group() for i in positions]
        if mode == "initials":
            surface = "".join(word[0] for word in selected).upper()
            if not 2 <= len(surface) <= 10:
                continue
            variants = [(score, surface, "edit_initials")]
        else:
            contiguous = positions == list(range(positions[0], positions[-1] + 1))
            surface = render(positions, selected)
            variants = [(score, surface, "edit_copy" if contiguous else "edit_join")]
            alternatives = [(0., [])]
            for word in selected:
                replacements = grammar["substitutions"].get(normalize(word), {})
                if word.isdigit():
                    replacements = {**replacements, **{word[-int(size):]: value
                        for size, value in grammar["numeric_suffixes"].items() if int(size) < len(word)}}
                options = [(word, 0.)] + [(
                    replacement.upper() if word.isupper() else replacement.capitalize() if word[0].isupper() else replacement,
                    math.log1p(value["weight"])) for replacement, value in replacements.items()]
                alternatives = sorted([(cost + extra, prefix + [replacement])
                    for cost, prefix in alternatives for replacement, extra in options],
                    key=lambda v: (-v[0], v[1]))[:3]
            variants.extend((score + cost, render(positions, parts), "edit_abbreviation")
                            for cost, parts in alternatives if normalize(render(positions, parts)) != normalize(surface))
        for cost, surface, method in variants:
            if s.complete_fragment(surface, party):
                proposed.append({"text": surface, "side": side, "kind": method, "score": cost,
                    "covered": [source[i] for i in positions],
                    "span": [min(spans[i].start() for i in positions), max(spans[i].end() for i in positions)]})
    result, seen = [], set()
    ordered = sorted(proposed, key=lambda v: (-v["score"], len(v["text"]), v["text"]))
    first_by_kind = {}
    for proposal in ordered:
        first_by_kind.setdefault(proposal["kind"], proposal)
    for proposal in [*first_by_kind.values(), *ordered]:
        norm = normalize(proposal["text"])
        if norm and norm not in seen:
            seen.add(norm)
            result.append(proposal)
            if len(result) == grammar["outputs_per_party"]:
                break
    for proposal in reordered + initials + joins:
        norm = normalize(proposal["text"])
        if norm not in seen:
            seen.add(norm)
            result.append(proposal)
    return result


def propose(record, grammar):
    parties = record["left"], record["right"]
    output = {side: party_proposals(party, side, grammar) for side, party in enumerate(parties)}
    for side, party in enumerate(parties):
        if s.anonymous(party or "") and s.party_type(party or "") != "crown":
            continue
        for match in re.finditer(r"\(([^()]*)\)", party or ""):
            for proposal in party_proposals(match.group(1), side, grammar):
                proposal["span"] = [offset + match.start(1) for offset in proposal["span"]]
                output[side].append(proposal)
    pair = ":".join(s.party_type(p or "") for p in parties)
    if pair in grammar["joint"]:
        components = []
        for side, party in enumerate(parties):
            options = output[side][:6] + [value for value in output[side][6:] if value["kind"] == "edit_initials"]
            if party:
                if grammar.get("anonymous_programs") and s.anonymous(party) and "(" in party:
                    text = party.split("(", 1)[0].strip()
                    if text and normalize(text) not in {normalize(value["text"]) for value in options}:
                        options.append({"text": text, "side": side, "covered": words(text), "span": [0, len(text)]})
                text = s.core(party)
                if text and normalize(text) not in {normalize(value["text"]) for value in options}:
                    options.append({"text": text, "side": side, "covered": words(text), "span": [0, len(party)]})
            components.append(options)
        separators = grammar["separators"].get(record.get("language", "en"), {"v": 1.})
        total = sum(separators.values())
        side = 1 if s.party_type(parties[0] or "") == "crown" else 0
        for left in components[0]:
            for right in components[1]:
                for separator, weight in separators.items():
                    text = left["text"] + " " + separator + " " + right["text"]
                    own = (left, right)[side]
                    output[side].append({"text": text, "side": side, "kind": "edit_joint",
                        "score": math.log(weight / total), "covered": own["covered"], "span": own["span"]})
    return output


def choices(record, model, party_aliases=None):
    return s.model_candidates(record["left"], record["right"], model, party_aliases,
                              style=record.get("style") or "", language=record["language"])


def generate(record, model, party_aliases=None):
    return s.generate(record["left"], record["right"], model, party_aliases=party_aliases,
                      style=record.get("style") or "", language=record["language"])
