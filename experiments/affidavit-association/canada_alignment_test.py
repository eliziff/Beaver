import unittest
from canada_alignment import align

class LiteralSourceAlignment(unittest.TestCase):
    def test_repairs_only_unique_source_spans_without_erasing_word_boundaries(self):
        quote='I received the October 2041-July 2042 account report yesterday.'
        source='12. | received the October 2041-\nJuly 2042 account report yesterday.'
        self.assertEqual(align(quote,source),source[4:])
        self.assertEqual(align(quote,source+'\n'+source),quote)
        changed='I received the October 2041-July 2042 account report tomorrow.'
        self.assertEqual(align(changed,source),changed)
        boundary='The therapist attended the northern conference before the report.'
        self.assertEqual(align(boundary,boundary.replace('therapist','the rapist')),boundary)

if __name__=='__main__':unittest.main()
