"""Token-budgeted windows covering original text, with source character offsets."""


class ChunkPlan:
    def __init__(self, tokenizer, prompts, max_length=512, overlap=64):
        self.tokenizer, self.prompts = tokenizer, prompts
        self.max_length, self.overlap = max_length, overlap
        self.cache = {}

    def parts(self, text, prompt):
        key = (prompt, text)
        if key in self.cache:
            return self.cache[key]
        prefix = self.prompts[prompt]
        encoded = self.tokenizer(text, add_special_tokens=False, return_offsets_mapping=True, truncation=False, verbose=False)
        offsets = encoded['offset_mapping']
        prefix_size = len(self.tokenizer.encode(prefix, add_special_tokens=True, truncation=False, verbose=False))
        budget = self.max_length - prefix_size
        if budget <= self.overlap:
            raise ValueError('Task prefix leaves no usable overlapping token window')
        parts, start = [], 0
        while start < len(offsets) or not parts:
            end = min(start + budget, len(offsets))
            while True:
                lo = offsets[start][0] if start else 0
                hi = offsets[end - 1][1] if end < len(offsets) else len(text)
                chunk = text[lo:hi]
                count = len(self.tokenizer.encode(prefix + chunk, add_special_tokens=True, truncation=False, verbose=False))
                if count <= self.max_length:
                    break
                end -= max(1, count - self.max_length)
                if end <= start:
                    raise ValueError('Tokenizer cannot fit a source token in its window')
            parts.append({'text': chunk, 'characters': [lo, hi], 'tokens': [start, end], 'encoded_tokens': count})
            if end == len(offsets):
                break
            start = max(start + 1, end - self.overlap)
        if parts[0]['characters'][0] != 0 or parts[-1]['characters'][1] != len(text):
            raise ValueError('Chunk plan omitted a source boundary')
        if any(a['characters'][1] < b['characters'][0] for a, b in zip(parts, parts[1:])):
            raise ValueError('Chunk plan omitted source text between windows')
        self.cache[key] = parts
        return parts

    def summary(self):
        return {'max_encoded_tokens': self.max_length, 'overlap_tokens': self.overlap,
                'source_texts': len(self.cache),
                'chunks_by_prompt': {prompt: sum(len(parts) for (p, _), parts in self.cache.items() if p == prompt)
                                     for prompt in set(p for p, _ in self.cache)},
                'largest_document_chunks': max((len(parts) for (p, _), parts in self.cache.items() if p == 'Document'), default=0),
                'complete_character_coverage': True}
