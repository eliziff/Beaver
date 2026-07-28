# CAN-RETRIEVAL-001 — Authority retrieval and ranking

Our client caused a death in Ontario while forcibly confining the victim in a
basement. There is no evidence the killing was planned or deliberate. The Crown
has charged first degree murder.

From the supplied source packet **only**, identify the authorities that govern
whether this killing is properly classified as first degree murder, rank them
by relevance, and give pinpoint support (paragraph number for cases, section
label for legislation) for the governing proposition. Exclude packet sources
that do not bear on the classification question.

## Constraints

- **Closed source packet.** Consider only the sources listed below; do not
  introduce outside authorities.
- Every entry in the ranking must give at least one pinpoint that actually
  supports the stated proposition.
- Jurisdiction: Ontario (Canadian federal criminal law), law as of 2026-06-30.
- Deliverable: a ranked list saved as `answer.json`, each entry carrying
  `source_id`, `rank`, `proposition`, and `pinpoints`.

## Source packet

- SRC-001 — Criminal Code, RSC 1985, c C-46, s 231 (excerpt)
- SRC-002 — R. v. Latimer, 2001 SCC 1
- SRC-003 — R. v. Oakes, [1986] 1 SCR 103 (SCC)
- SRC-004 — Criminal Code, RSC 1985, c C-46, s 22 (excerpt)
- SRC-005 — Criminal Code, RSC 1985, c C-46, s 83.01 (excerpt)
- SRC-006 — Occupiers' Liability Act, RSO 1990, c O.2
- SRC-007 — Food and Drug Regulations, CRC, c 870 (excerpt)
