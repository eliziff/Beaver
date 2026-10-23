"""Reuse the complete-body baseline audit for the Atlantic/northern lane."""
from third_atlantic_sources import O, provenance
import third_prairies_audit as audit
if __name__ == '__main__':
    audit.OUT = O
    audit.provenance = provenance
    audit.main()
