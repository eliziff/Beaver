"""Recognition inputs and label alignment. Gold never supplies model input lines."""
from collections import Counter
import hashlib
import math
import re
import unicodedata


def normalize_extraction(value,source_sha256):
    if any(k in value for k in ('typed','units','authoring','document_starts')):
        raise ValueError('Gold structures are labels, not recognition inputs')
    extraction=value.get('extraction',value)
    if any(k in extraction for k in ('typed','units','authoring','document_starts')):
        raise ValueError('Gold structures cannot be wrapped as raw extraction')
    bound=extraction.get('source_sha256',value.get('source_sha256'))
    if bound is not None and bound!=source_sha256:
        raise ValueError('Raw extraction belongs to another source')
    if not isinstance(extraction.get('pages'),list):
        raise ValueError('Expected raw extraction.pages')
    pages={}
    for index,page in enumerate(extraction['pages']):
        number=int(page.get('index',index))+1
        width,height=float(page['width']),float(page['height'])
        if number in pages or number<1 or not all(math.isfinite(v) and v>0 for v in (width,height)):
            raise ValueError('Invalid physical page geometry or duplicate page')
        lines=[]; seen=set()
        ordered=sorted(enumerate(page.get('lines',[])),key=lambda item:item[1].get('reading_order',item[0]))
        for ordinal,line in ordered:
            key=str(line['id']) if line.get('id') is not None else f'raw-{number}-{ordinal}'
            if key in seen: raise ValueError('Repeated raw line ID')
            seen.add(key)
            text=line.get('text')
            if text is None: text=''.join(s.get('text','') for s in line.get('spans',[]))
            if not isinstance(text,str): raise ValueError('Raw recognized text must be a string')
            box=line.get('bbox',line.get('rect'))
            normalized=None
            if box is not None:
                if len(box)!=4 or not all(isinstance(v,(float,int)) and math.isfinite(v) for v in box):
                    raise ValueError('Invalid raw recognized box')
                x0,y0,x1,y1=box
                clipped=[max(0.,min(1.,v)) for v in (x0/width,y0/height,x1/width,y1/height)]
                if clipped[2]>clipped[0] and clipped[3]>clipped[1]: normalized=clipped
            # Corrected text, regions, document starts and gold labels are not read.
            lines.append(dict(line_id=key,text=text,bbox=normalized))
        pages[number]=dict(source_sha256=source_sha256,page=number,lines=lines,
            recognition_source=str(page.get('source','unspecified')))
    return pages


def page_text(page):
    return '\n'.join(line['text'] for line in page['lines'])


def edge_windows(left,right):
    if left['source_sha256']!=right['source_sha256'] or right['page']!=left['page']+1:
        raise ValueError('Text context must be adjacent pages of the same source')
    a,b=page_text(left),page_text(right)
    return a[:384],a[-768:],b[:768],b[-384:]


def line_windows(page,line_id):
    index=next(i for i,line in enumerate(page['lines']) if line['line_id']==line_id)
    lines=page['lines']
    return ('\n'.join(l['text'] for l in lines[max(0,index-3):index])[-384:],
        lines[index]['text'][:384],'\n'.join(l['text'] for l in lines[index+1:index+4])[:384])


def raw_candidates(page):
    # Include the first recognized line: OCR may have missed earlier content.
    return [dict(line_id=line['line_id'],bbox=line['bbox']) for line in page['lines'] if line['bbox'] is not None]


def iou(a,b):
    overlap=max(0,min(a[2],b[2])-max(a[0],b[0]))*max(0,min(a[3],b[3])-max(a[1],b[1]))
    area=lambda box:(box[2]-box[0])*(box[3]-box[1])
    return overlap/(area(a)+area(b)-overlap) if overlap else 0.


def align_labels(page,anchors,unknown_line_ids=()):
    """Map annotation locations onto existing OCR proposals; never insert one.

    Unrepresentable gold cuts remain explicit misses for end-to-end evaluation.
    Ambiguous overlapping proposals are not invented negative training labels.
    """
    candidates=raw_candidates(page); assigned={}; unmatched=[]; ignored=set()
    unknown=set(unknown_line_ids)
    if unknown-{c['line_id'] for c in candidates}:
        raise ValueError('Unknown-cut mask cannot be mapped to this OCR; review this page before using it')
    ignored.update(i for i,c in enumerate(candidates) if c['line_id'] in unknown)
    for anchor in anchors:
        ranked=sorted(((iou(anchor['bbox'],c['bbox']),i) for i,c in enumerate(candidates) if i not in ignored),reverse=True)
        exact=[i for i,c in enumerate(candidates) if c['line_id']==anchor['line_id'] and iou(anchor['bbox'],c['bbox'])>=.5]
        choice=exact[0] if len(exact)==1 else None
        if choice is None and ranked and ranked[0][0]>=.5 and (len(ranked)==1 or ranked[0][0]-ranked[1][0]>.1):
            choice=ranked[0][1]
        if choice is not None and choice not in assigned:
            assigned[choice]=anchor['line_id']
        else:
            unmatched.append(dict(line_id=anchor['line_id'],bbox=anchor['bbox']))
            ignored.update(i for score,i in ranked if score>0 and i not in assigned)
    labelled=[{**candidate,'label':int(i in assigned),
        **({'gold_line_id':assigned[i]} if i in assigned else {})} for i,candidate in enumerate(candidates) if i not in ignored]
    return dict(candidates=labelled,unmatched_gold=unmatched,ignored_proposals=len(ignored))


WORDS=re.compile(r'[^\W_]+',re.UNICODE)


def hashed_features(text,buckets=32768):
    """Bounded lexical features: no vocabulary fitted to development/test text."""
    folded=unicodedata.normalize('NFKC',text).casefold()
    words=WORDS.findall(folded)
    if len(words)>96: words=words[:48]+words[-48:]
    words=[word if not word.isdigit() or len(word)<=2 else '#' for word in words]
    tokens=['w:'+word for word in words]+['b:'+a+' '+b for a,b in zip(words,words[1:])]
    chars=folded if len(folded)<=256 else folded[:128]+' '+folded[-128:]
    tokens+=['c:'+chars[i:i+4] for i in range(0,max(0,len(chars)-3),2)]
    counts=Counter(int.from_bytes(hashlib.blake2b(token.encode(),digest_size=8,person=b'split-v1').digest(),'little')%buckets for token in tokens)
    pairs=sorted((key,1+math.log(count)) for key,count in counts.items())
    norm=math.sqrt(sum(weight*weight for _,weight in pairs)) or 1.
    length=max(1,len(text)); alphabetic=sum(c.isalpha() for c in text)
    stats=[min(len(text),768)/768,alphabetic/length,sum(c.isupper() for c in text)/max(1,alphabetic),
        sum(c.isdigit() for c in text)/length,float(text.rstrip().endswith(('.',':',';','?','!'))),float(bool(text.strip()) and text.strip()[0].isupper())]
    return [key for key,_ in pairs],[weight/norm for _,weight in pairs],stats
