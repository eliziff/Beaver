"""Validate externally proposed transcript boundaries and identities."""
import unittest
from questioning import checked, store, validate


def item(**changes):
    return dict(first=1,last=300,title='Discovery session',kind='discovery',
                parties='Invented witness',date='') | changes


class QuestioningRanges(unittest.TestCase):
    def test_complete_large_volume_is_allowed(self):
        row=item()
        self.assertEqual(validate({'contracts':[row]},300),[row])

    def test_rejects_out_of_source_and_reversed_ranges(self):
        for first,last in ((0,5),(5,4),(1,301)):
            with self.subTest(first=first,last=last),self.assertRaises(ValueError):
                validate({'contracts':[item(first=first,last=last)]},300)

    def test_rejects_duplicate_sessions(self):
        with self.assertRaises(ValueError):
            validate({'contracts':[item(),item()]},300)

    def test_reviewed_exclusion_is_not_reintroduced_on_source_revisit(self):
        for status in ('excluded_duplicate_examination', 'excluded_failed_independent_preservation',
                       'excluded_continuation_of_counted_examination'):
            excluded=item(parent_sha256='invented-source',selection_status=status)
            with self.subTest(status=status):
                self.assertIsNone(store({'sha256':'invented-source'},item(),{},
                                        {'documents':[],'excluded':[excluded]}))

    def test_requires_identifiable_examination(self):
        for key in ('title','parties','kind'):
            with self.subTest(field=key),self.assertRaises(ValueError):
                validate({'contracts':[item(**{key:' '})]},300)

    def test_filed_excerpt_stays_explicitly_incomplete(self):
        value=dict(eligible_transcript=True,transcript_extent='filed_excerpt',
                   examination_identity='Invented court file / witness / date',
                   canadian_nexus='Invented Canadian proceeding',complete_agreement=False)
        self.assertIs(checked(value),value)
        with self.assertRaises(ValueError):checked(value | {'complete_agreement':True})

    def test_eligible_transcript_requires_provenance_identity(self):
        value=dict(eligible_transcript=True,transcript_extent='complete',
                   examination_identity='Invented examination',canadian_nexus='Invented Canadian court',complete_agreement=True)
        for key in ('examination_identity','canadian_nexus'):
            with self.subTest(field=key),self.assertRaises(ValueError):checked(value | {key:''})


if __name__=='__main__':unittest.main()
