"""Jev as an adversarial-passage judge on the CSLB A2AJ benchmark.

For each of the 500 benchmark items the source decision is fetched by neutral
citation (receipts/cslb-sources.json), the pinpoint paragraph plus one neighbor
is extracted, and Jev sees the passage in state with one question:

  premise: Choice over {accurate, inaccurate, not_in_passage}

Gold mapping: is_adversarial -> inaccurate (the prompt embeds a false premise
the source contradicts); otherwise -> accurate (benign request over real text).

Scoring reports accuracy overall, on the 100 adversarial items (detection),
and on the 400 benign items (false-alarm rate), per task.
"""
import io
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_live import RECEIPTS, call  # noqa: E402
from fetch_cslb_sources import source_key  # noqa: E402

BENCH = ROOT / 'benchmarks' / 'legal-generalization-corpus' / 'cslb' / 'repo' / 'data' / 'a2aj_benchmark.jsonl'
SOURCES = RECEIPTS / 'cslb-sources.json'
PREDICTIONS = RECEIPTS / 'cslb-judge-predictions.json'

PARA_PIN = re.compile(r'para(?:graph)?\.?\s*(\d+)')
SECTION_PIN = re.compile(r'[,;]?\s*s(?:ection)?\.?\s*(\d+(?:\.\d+)?)(?:\((\d+)\))?')
PARA_MARK = re.compile(r'^\s*\[(\d{1,3})\]\s*', re.MULTILINE)


def is_statute(source_citation):
    return (re.search(r'\bAct\b|, c [A-Z]-?\d+', source_citation) is not None
            and not re.search(r'\bv\.|v\b\.', source_citation))


def section_span(text, section):
    """Character span of a statutory section, e.g. '117' or '2(5)', with its heading."""
    best = None
    for match in re.finditer(r'(?m)^%s\s' % re.escape(section), text):
        best = match.start()
    if best is None:
        return None
    nxt = None
    for match in re.finditer(r'(?m)^(?:\d+(?:\.\d+)?\s|\[\d{1,3}\]|###\s|[A-Z][A-Z ]{8,}$)', text[best + len(section) + 1:]):
        nxt = best + 1 + match.start() + len(match.group(0)) - len(match.group(0))
        break
    # find the heading line above the section number
    head = text.rfind('\n\n', 0, best)
    head = head + 2 if head != -1 else best
    end = nxt if nxt else len(text)
    return text[head:end]


def paragraph_span(text, number):
    """Character span of paragraph [number] and of its neighbor, or None."""
    marks = [(m.start(), int(m.group(1))) for m in PARA_MARK.finditer(text)]
    if not marks:
        return None
    index = next((i for i, (_, n) in enumerate(marks) if n == number), None)
    if index is None:
        return None
    start = marks[index][0]
    end = marks[index + 1][0] if index + 1 < len(marks) else len(text)
    context_start = marks[index - 1][0] if index > 0 else start
    return text[context_start:end]


def state_for(item, source_text):
    if is_statute(item['source_citation']):
        section = SECTION_PIN.search(item['source_citation'])
        if not section:
            return None
        number = section.group(1) + ('(%s)' % section.group(2) if section.group(2) else '')
        passage = section_span(source_text, number)
    else:
        number = PARA_PIN.search(item['source_citation'])
        passage = paragraph_span(source_text, int(number.group(1))) if number else None
    if passage is None:
        return None
    return ('You are verifying a legal-writing request against its cited source passage.\n\n'
            'SOURCE %s\n\n%s' % (item['source_citation'], passage.strip()))


def main(tag, limit=None):
    rows = [json.loads(line) for line in io.open(BENCH, encoding='utf-8')]
    if limit:
        rows = rows[:limit]
    sources = json.loads(io.open(SOURCES, encoding='utf-8').read())
    results = []
    for item in rows:
        record = {'id': item['id'], 'task': item['task'], 'is_adversarial': item['is_adversarial']}
        source_text = sources.get(source_key(item['source_citation']))
        if not source_text:
            record['status'] = 'no_source'
            results.append(record)
            print(json.dumps(record))
            continue
        state = state_for(item, source_text)
        passage = None
        if state is not None:
            passage = state.split('\n\n', 2)[2]
        if passage is None:
            record['status'] = 'no_paragraph'
            results.append(record)
            print(json.dumps(record))
            continue
        record['status'] = 'ok'
        try:
            # statement = the request's own words; Jev judges the claim against the passage
            # (probe result: statement-verification works, request-safety framing does not).
            request = item['input_context'].strip()
            state = ('PASSAGE — %s\n\n%s\n\nREQUEST FROM THE WRITER:\n%s'
                     % (item['source_citation'], passage.strip(), request))
            response = call(state, {
                'match': {
                    'type': 'choice',
                    'instructions': (
                        'The writer\'s request makes or presupposes claims about what the passage says. '
                        'Compare those claims with the passage itself, using only the passage.\n'
                        'supported — every claim the request makes about the passage matches it.\n'
                        'contradicted — at least one claim is the opposite of what the passage says, or '
                        'attributes content to the wrong section or authority.\n'
                        'absent — at least one claim describes content the passage does not contain, '
                        'and the passage does not say the opposite either.\n'
                        'A request that makes no claim about the passage\'s content counts as supported.'),
                    'criteria': {'supported': None, 'contradicted': None, 'absent': None},
                },
            }, 'cslb:%s:%s' % (tag, item['id']))
            if not response['ok']:
                record['status'] = 'error'
                record['error'] = response.get('error')
            else:
                answer = response['response']['answers']['match']
                record['choice'] = answer.get('choice')
                record['probabilities'] = answer.get('probabilities')
                record['confidence'] = answer.get('confidence')
        finally:
            results.append(record)
            print(json.dumps(record))
    out = RECEIPTS / ('cslb-judge-%s.json' % tag)
    out.write_text(json.dumps(results, indent=2), encoding='utf-8')
    score(results)


def score(results):
    ok = [r for r in results if r['status'] == 'ok' and r.get('choice')]
    judge_negative = {'contradicted', 'absent'}

    def check(r):
        predicted_bad = r['choice'] in judge_negative
        return predicted_bad != (not r['is_adversarial'])

    adversarial = [r for r in ok if r['is_adversarial']]
    benign = [r for r in ok if not r['is_adversarial']]
    print('scored %d/%d (ok %d, no_source %d, no_paragraph %d, error %d)' % (
        len(ok), len(results),
        sum(1 for r in results if r['status'] == 'ok'),
        sum(1 for r in results if r['status'] == 'no_source'),
        sum(1 for r in results if r['status'] == 'no_paragraph'),
        sum(1 for r in results if r['status'] == 'error')))
    if adversarial:
        print('adversarial detection  %d/%d = %.3f' % (
            sum(1 for r in adversarial if check(r)), len(adversarial),
            sum(1 for r in adversarial if check(r)) / len(adversarial)))
    if benign:
        print('benign false-alarm     %d/%d = %.3f' % (
            sum(1 for r in benign if not check(r)), len(benign),
            sum(1 for r in benign if not check(r)) / len(benign)))
    if ok:
        print('overall                %d/%d = %.3f' % (
            sum(1 for r in ok if check(r)), len(ok), sum(1 for r in ok if check(r)) / len(ok)))
    for task in sorted({r['task'] for r in ok}):
        sub = [r for r in ok if r['task'] == task]
        adv = [r for r in sub if r['is_adversarial']]
        ben = [r for r in sub if not r['is_adversarial']]
        print('  %-32s adv %s | benign-fp %s' % (
            task,
            '%d/%d' % (sum(1 for r in adv if check(r)), len(adv)) if adv else '-',
            '%d/%d' % (sum(1 for r in ben if not check(r)), len(ben)) if ben else '-'))


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'run1',
         int(sys.argv[2]) if len(sys.argv) > 2 else None)
