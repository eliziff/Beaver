# Authorities split benchmark — Beaver native splitter vs ALR gold

Run 2026-09-10T19:53:42Z · gold root `C:/Users/elias/Desktop/Martys Qote Verifier/ALR-Quote-Verifier` · lane: deterministic (native addon, no model).

## Scorecard

| gold file | cases | strict exact | tolerant exact | count | undersplit | oversplit | span P | span R | span F1 | char-neutral |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| fast_split_manual_gold.jsonl | 405 | 57.5% | 57.5% | 59.3% | 162 | 3 | 74.4% | 59.4% | 66.1% | 100.0% |
| fast_split_gold_all.jsonl | 433 | 58.9% | 58.9% | 60.7% | 167 | 3 | 75.1% | 60.5% | 67.0% | 100.0% |

`strict exact` = produced partition equals the canonical gold partition after whitespace/trailing-semicolon normalization. `tolerant exact` additionally accepts any `acceptable_partitions` entry, but only when the split is character-neutral (ALR's rule). `span P/R/F1` matches produced parts against gold parts as multisets of normalized text. `char-neutral` is ALR's `core_loss_gain_neutral`.

## Pinpoint lane (`field_gold_provisional.jsonl`)

| metric | value |
| --- | --- |
| gold parts scored | 566 |
| parts whose gold has pinpoints | 409 |
| first paragraph/section fragment matches | 96.5% |
| page pinpoints match (range endpoints) | 84.8% |
| all pinpoints match (range endpoints) | 78.4% |
| parts with gold pinpoints where Beaver found any | 90.2% |
| parts with no gold pinpoint where Beaver emitted one | 5 |

## Failure taxonomy (fast_split_manual_gold.jsonl)

| outcome | cases | share |
| --- | --- | --- |
| exact | 233 | 57.5% |
| collapsed to one part (no second anchor found) | 112 | 27.7% |
| partial undersplit (some anchors found) | 50 | 12.3% |
| oversplit | 3 | 0.7% |
| right part count, wrong boundary | 7 | 1.7% |

## Detection coverage per authority family

One gold citation in, does the native detector anchor on it at all? Families at 0% cannot be split apart from their neighbours at any boundary rule.

| kind (ALR field gold) | gold parts | citation hit | supra/ibid only | anchored |
| --- | --- | --- | --- | --- |
| case | 201 | 140 | 58 | 98.5% |
| other | 136 | 17 | 108 | 91.9% |
| journal | 108 | 89 | 17 | 98.1% |
| book | 54 | 33 | 21 | 100.0% |
| statute | 29 | 15 | 13 | 96.6% |
| essay_collection | 20 | 18 | 2 | 100.0% |
| non_parliamentary | 10 | 10 | 0 | 100.0% |
| parliamentary_paper | 8 | 3 | 4 | 87.5% |

## Worst 20 misses (fast_split_manual_gold.jsonl)

### 1. manual-0423 (Inputs\CHECKED_EDITS\_7_[CHECKED] 1_63-4_KONING-REID-BAKER_[Download_And_Edit_Me].xlsx)
- expected 8 part(s), produced 2 — **undersplit**; core loss 0, gain 0; tags: multi_part, review_marker
- footnote: `Elizabeth Shilton & Kevin Banks, “The Changing Role of Labour Relations Boards in Canada: Key Research Questions for the 21st Century" (2014) at 3. The Alberta Labour Relations Board primarily applies the Labour Relations Code. Ontario tribunals apply relevant statutes including the Labour Relations Act, the Employment…`
- gold[0]: `Elizabeth Shilton & Kevin Banks, “The Changing Role of Labour Relations Boards in Canada: Key Research Questions for the 21st Century" (2014) at 3.`
- gold[1]: `The Alberta Labour Relations Board primarily applies the Labour Relations Code.`
- gold[2]: `Ontario tribunals apply relevant statutes including the Labour Relations Act,`
- gold[3]: `the Employment Standards Act, 2000 [ESA],`
- gold[4]: `the Employment Protection for Foreign Nationals Act, 2009 (EPFNA),`
- gold[5]: `the Workplace Safety and Insurance Act, 1997 [WSIA],`
- gold[6]: `and the Occupational Health and Safety Act, 1990 [OHSA].`
- gold[7]: `For a completely unrelated article, see Kerry Wilkins, “So You Want to Implement UNDRIP... Special Issue: British Columbia's Declaration on the Rights…`
- beaver[0]: `Elizabeth Shilton & Kevin Banks, “The Changing Role of Labour Relations Boards in Canada: Key Research Questions for the 21st Century" (2014) at 3. Th…`
- beaver[1]: `For a completely unrelated article, see Kerry Wilkins, “So You Want to Implement UNDRIP... Special Issue: British Columbia's Declaration on the Rights…`

### 2. manual-0005 (1_64-1_Martin [Download and Edit Me].docx)
- expected 6 part(s), produced 3 — **undersplit**; core loss 0, gain 0; tags: multi_part, review_marker, supra
- footnote: `Wagner (Re) (4 November 1966), (Barreau de Montréal), rev’d Wagner c Barreau de Montréal (28 November 1966), Montréal 723–178 (Qc SC), rev’d Barreau (Montréal) c Wagner (1967), [1968] BR 235 (CA). These decisions are discussed in Martin, Legal Ethics and the Attorney General, supra note 2 at 31-39, and republished alon…`
- gold[0]: `Wagner (Re) (4 November 1966), (Barreau de Montréal), rev’d Wagner c Barreau de Montréal (28 November 1966), Montréal 723–178 (Qc SC),`
- gold[1]: `rev’d Barreau (Montréal) c Wagner (1967), [1968] BR 235 (CA).`
- gold[2]: `These decisions are discussed in Martin, Legal Ethics and the Attorney General, supra note 2 at 31-39,`
- gold[3]: `and republished alongside unofficial English translations in Andrew Flavelle Martin, “The Lawyer’s Professional Duty to Encourage Respect for – And to…`
- gold[4]: `Law Society of Yukon v Kimmerly, [1988] LSDD no 1 (Yk LS),`
- gold[5]: `discussed in Martin, Legal Ethics and the Attorney General, supra note 2 at 39-41.`
- beaver[0]: `Wagner (Re) (4 November 1966), (Barreau de Montréal), rev’d Wagner c Barreau de Montréal (28 November 1966), Montréal 723–178 (Qc SC), rev’d Barreau (…`
- beaver[1]: `These decisions are discussed in Martin, Legal Ethics and the Attorney General, supra note 2 at 31-39, and republished alongside unofficial English tr…`
- beaver[2]: `Law Society of Yukon v Kimmerly, [1988] LSDD no 1 (Yk LS), discussed in Martin, Legal Ethics and the Attorney General, supra note 2 at 39-41.`

### 3. manual-0312 (CHECKED_EDITS\_34_[CHECKED] 1_AMPLEMAN-TREMBLAY_[Download_and_edit_me][testing].xlsx)
- expected 4 part(s), produced 1 — **undersplit**; core loss 0, gain 0; tags: multi_part, signal
- footnote: `R v Sullivan, 2020 ONCA 333 at para 129 (see also 88–91) [Sullivan (ONCA)]. It is interesting to note that the suicide narrative is much stronger on appeal. Justice Paciocco starts his reasons by mentioning a suicide attempt (para 1). The trial judge found inconsistencies in Sullivan’s evidence on this matter but still…`
- gold[0]: `R v Sullivan, 2020 ONCA 333 at para 129 (see also 88–91) [Sullivan (ONCA)].`
- gold[1]: `It is interesting to note that the suicide narrative is much stronger on appeal.`
- gold[2]: `Justice Paciocco starts his reasons by mentioning a suicide attempt (para 1).`
- gold[3]: `The trial judge found inconsistencies in Sullivan’s evidence on this matter but still concluded that future suicide attempts were a possibility given …`
- beaver[0]: `R v Sullivan, 2020 ONCA 333 at para 129 (see also 88–91) [Sullivan (ONCA)]. It is interesting to note that the suicide narrative is much stronger on a…`

### 4. manual-0383 (Good\[CHECKED] 1_AMPLEMAN-TREMBLAY_[Download_and_edit_me].xlsx)
- expected 5 part(s), produced 2 — **undersplit**; core loss 0, gain 0; tags: ibid, multi_part
- footnote: `Ibid at paras 98 and 123. The toxicology report also indicated the presence of Midazolam, but in a dosage too low to produce therapeutic effects (para 95). Of note, while evidence of self-induced intoxication is complex on its own, such cases are at risk of investigative failures like any others. In Barrett, the police…`
- gold[0]: `Ibid at paras 98 and 123.`
- gold[1]: `The toxicology report also indicated the presence of Midazolam, but in a dosage too low to produce therapeutic effects (para 95).`
- gold[2]: `Of note, while evidence of self-induced intoxication is complex on its own, such cases are at risk of investigative failures like any others.`
- gold[3]: `In Barrett, the police also failed to seize any mushrooms from the accused’s residence.`
- gold[4]: `Ibid at para 92.`
- beaver[0]: `Ibid at paras 98 and 123. The toxicology report also indicated the presence of Midazolam, but in a dosage too low to produce therapeutic effects (para…`
- beaver[1]: `In Barrett, the police also failed to seize any mushrooms from the accused’s residence. Ibid at para 92.`

### 5. manual-0414 (Inputs\CHECKED_EDITS\[CHECKED] 1_AMPLEMAN-TREMBLAY_[Download_and_edit_me] (2).xlsx)
- expected 4 part(s), produced 1 — **undersplit**; core loss 0, gain 0; tags: multi_part
- footnote: `Joaquin Velez Navarro, “The Creation of Evil: The Role of the Law in Shaping Beliefs on Drug Harm and Addiction” (2022) 49(1) Ohio NU L Rev 115. The international and Canadian regime of drug control may differ. For more information compare the Schedules of the Single Convention on Narcotic Drugs, 1961 as amended by the…`
- gold[0]: `Joaquin Velez Navarro, “The Creation of Evil: The Role of the Law in Shaping Beliefs on Drug Harm and Addiction” (2022) 49(1) Ohio NU L Rev 115.`
- gold[1]: `The international and Canadian regime of drug control may differ.`
- gold[2]: `For more information compare the Schedules of the Single Convention on Narcotic Drugs, 1961 as amended by the 1972 Protocol amending the Single Conven…`
- gold[3]: `and the Canadian Controlled Drugs and Substances Act, S.C. 1996, c. 19 [CDSA].`
- beaver[0]: `Joaquin Velez Navarro, “The Creation of Evil: The Role of the Law in Shaping Beliefs on Drug Harm and Addiction” (2022) 49(1) Ohio NU L Rev 115. The i…`

### 6. manual-0006 (1_64-1_Martin [Download and Edit Me].docx)
- expected 3 part(s), produced 1 — **undersplit**; core loss 0, gain 0; tags: multi_part, review_marker, supra
- footnote: `Law Society of Alberta v Madu, 2024 ABLS 20 [Madu], discussed in Martin, Legal Ethics and the Attorney General, supra note 2 at xi-xiii, penalty at 2025 ABLS 11 [Madu penalty].`
- gold[0]: `Law Society of Alberta v Madu, 2024 ABLS 20 [Madu],`
- gold[1]: `discussed in Martin, Legal Ethics and the Attorney General, supra note 2 at xi-xiii,`
- gold[2]: `penalty at 2025 ABLS 11 [Madu penalty].`
- beaver[0]: `Law Society of Alberta v Madu, 2024 ABLS 20 [Madu], discussed in Martin, Legal Ethics and the Attorney General, supra note 2 at xi-xiii, penalty at 20…`

### 7. manual-0018 (1_64-1_Martin [Download and Edit Me].docx)
- expected 3 part(s), produced 1 — **undersplit**; core loss 0, gain 0; tags: multi_part, signal, supra
- footnote: `Third reading Hansard, supra note 39 at 926 (Naheed Nenshi). See also 928 (Irfan Sabir): “As the Leader of the Official Opposition mentioned, the Minister of Justice had more than a few opportunities to talk about this bill and at least enlighten us about why this immunity for him was necessary while he’s giving himsel…`
- gold[0]: `Third reading Hansard, supra note 39 at 926 (Naheed Nenshi).`
- gold[1]: `See also 928 (Irfan Sabir): “As the Leader of the Official Opposition mentioned, the Minister of Justice had more than a few opportunities to talk abo…`
- gold[2]: `See also 929 (Rakhi Pancholi): “The minister has yet to speak to why that’s the case.”`
- beaver[0]: `Third reading Hansard, supra note 39 at 926 (Naheed Nenshi). See also 928 (Irfan Sabir): “As the Leader of the Official Opposition mentioned, the Mini…`

### 8. manual-0039 (1_64-1_Martin [Download and Edit Me].docx)
- expected 4 part(s), produced 2 — **undersplit**; core loss 0, gain 0; tags: multi_part, signal, supra
- footnote: `Thanks to a reviewer on this point. See e.g. Martin, Legal Ethics and the Attorney General, supra note 2 at Chapter 7 (“Accountability: Alternatives to Law Society Discipline”). Consider however J Ll J Edwards, “The Attorney General and the Charter of Rights” in Robert J Sharpe, Charter Litigation (Toronto: Butterworth…`
- gold[0]: `Thanks to a reviewer on this point.`
- gold[1]: `See e.g. Martin, Legal Ethics and the Attorney General, supra note 2 at Chapter 7 (“Accountability: Alternatives to Law Society Discipline”).`
- gold[2]: `Consider however J Ll J Edwards, “The Attorney General and the Charter of Rights” in Robert J Sharpe, Charter Litigation (Toronto: Butterworths, 1987)…`
- gold[3]: `See also Dodek, supra note 54 at 38: “[t]he Attorney General is accountable to the legislature for all acts taken by his or her agents, but such overs…`
- beaver[0]: `Thanks to a reviewer on this point. See e.g. Martin, Legal Ethics and the Attorney General, supra note 2 at Chapter 7 (“Accountability: Alternatives t…`
- beaver[1]: `Consider however J Ll J Edwards, “The Attorney General and the Charter of Rights” in Robert J Sharpe, Charter Litigation (Toronto: Butterworths, 1987)…`

### 9. manual-0043 (62-2 Dylan - FINAL (unedited) SUBMISSION.docx)
- expected 3 part(s), produced 1 — **undersplit**; core loss 0, gain 0; tags: multi_part
- footnote: `LLM, LLB (Canada), JD (USA), BA (Hons), Associate Professor, Bora Laskin Faculty of Law, Thunder Bay, Ontario, Canada. I am grateful for the research assistance provided by Caitlin Costello, Bora Laskin Faculty of Law JD Candidate (2025). This article was presented at the Canadian Animal Law Conference in September 202…`
- gold[0]: `LLM, LLB (Canada), JD (USA), BA (Hons), Associate Professor, Bora Laskin Faculty of Law, Thunder Bay, Ontario, Canada.`
- gold[1]: `I am grateful for the research assistance provided by Caitlin Costello, Bora Laskin Faculty of Law JD Candidate (2025).`
- gold[2]: `This article was presented at the Canadian Animal Law Conference in September 2024 and to the Canadian Animal Law Study Group in November 2024.`
- beaver[0]: `LLM, LLB (Canada), JD (USA), BA (Hons), Associate Professor, Bora Laskin Faculty of Law, Thunder Bay, Ontario, Canada. I am grateful for the research …`

### 10. manual-0045 (62-2 Dylan - FINAL (unedited) SUBMISSION.docx)
- expected 6 part(s), produced 4 — **undersplit**; core loss 0, gain 0; tags: multi_part, review_marker
- footnote: `Sonja Puzic, “Woman charged in Toronto dog attack previously deemed 'irresponsible' pet owner”ng Dogs" (2020) 21:1 Nev LJ 117 at sued a pardon to a dog, even though it was care-giving.holders if not persons, man offenders Mar 28, 2024, Canadian Press online: <https://www.thecanadianpressnews.ca/ontario/woman-charged-in…`
- gold[0]: `Sonja Puzic, “Woman charged in Toronto dog attack previously deemed 'irresponsible' pet owner”ng Dogs" (2020) 21:1 Nev LJ 117 at sued a pardon to a do…`
- gold[1]: `Kiana Ferreira, “Off-leash dog attack kills dog, injures owner in Hamilton” July 27, 2024, CHCH news online: <https://www.chch.com/off-leash-dog-attac…`
- gold[2]: `Don Mitchell “Victim of Burlington, Ont. dog attack dies in hospital: police” June 22, 2023, Global News, online: <https://globalnews.ca/news/9786475/…`
- gold[3]: `CBC News, “Boy, 14, seriously injured in off-leash dog attack in Toronto school yard” May 17, 2023, CBC online: <https://www.cbc.ca/news/canada/toront…`
- gold[4]: `Dominik Kurek, “Canada Post mail carriers, dogs, bites and unwanted interactions across Canada: What the company asks owners to keep in mind” August 2…`
- gold[5]: `Rachel Watts, “Quebec woman mauled in dog attack wins $460K civil case against small town and owner” May 17, 2024 CBC News online: <https://www.cbc.ca…`
- beaver[0]: `Sonja Puzic, “Woman charged in Toronto dog attack previously deemed 'irresponsible' pet owner”ng Dogs" (2020) 21:1 Nev LJ 117 at sued a pardon to a do…`
- beaver[1]: `Don Mitchell “Victim of Burlington, Ont. dog attack dies in hospital: police” June 22, 2023, Global News, online: <https://globalnews.ca/news/9786475/…`
- beaver[2]: `CBC News, “Boy, 14, seriously injured in off-leash dog attack in Toronto school yard” May 17, 2023, CBC online: <https://www.cbc.ca/news/canada/toront…`
- beaver[3]: `Rachel Watts, “Quebec woman mauled in dog attack wins $460K civil case against small town and owner” May 17, 2024 CBC News online: <https://www.cbc.ca…`

### 11. manual-0173 (62-2 Sun - Updated Unedited Final Submission.docx)
- expected 5 part(s), produced 3 — **undersplit**; core loss 0, gain 0; tags: ibid, multi_part, supra
- footnote: `Ibid at 105 [emphasis added]. On this point, Ritchie J adopted as “accurate” the trial judge’s statement that “any claim [the plaintiffs] may have must be made against the Defendant, not the Government of Manitoba. It was a statute of the Parliament of Canada that took away their business and prohibited them from engag…`
- gold[0]: `Ibid at 105 [emphasis added].`
- gold[1]: `On this point, Ritchie J adopted as “accurate” the trial judge’s statement that “any claim [the plaintiffs] may have must be made against the Defendan…`
- gold[2]: `Ibid at 117.`
- gold[3]: `Wills argues that the plaintiff’s business might not have lost its total value had a provincial statute not also extended the inter-provincial prohibi…`
- gold[4]: `Wills, supra note 2 at 810, 813. However, he neglects the fact that it was the refusal of the Crown corporation, a federal entity, to grant a license …`
- beaver[0]: `Ibid at 105 [emphasis added]. On this point, Ritchie J adopted as “accurate” the trial judge’s statement that “any claim [the plaintiffs] may have mus…`
- beaver[1]: `It was a statute of the Parliament of Canada that took away their business and prohibited them from engaging in the fish exporting business.” Ibid at …`
- beaver[2]: `Wills, supra note 2 at 810, 813. However, he neglects the fact that it was the refusal of the Crown corporation, a federal entity, to grant a license …`

### 12. manual-0174 (62-2 Sun - Updated Unedited Final Submission.docx)
- expected 5 part(s), produced 3 — **undersplit**; core loss 0, gain 0; tags: multi_part, review_marker, signal, supra
- footnote: `See Harrison v Carswell, [1976] 2 SCR 200 at 219; Toronto Area Transit Operating Authority v Dell Holdings Ltd, [1997] 1 SCR 32 at para 20; Manitoba Fisheries, supra note 20 at 118, citing Attorney-General v De Keyser’s Royal Hotel, [1920] AC 508 at 542 [emphasis added]. See also Sir William Blackstone, Commentaries on…`
- gold[0]: `See Harrison v Carswell, [1976] 2 SCR 200 at 219`
- gold[1]: `Toronto Area Transit Operating Authority v Dell Holdings Ltd, [1997] 1 SCR 32 at para 20`
- gold[2]: `Manitoba Fisheries, supra note 20 at 118,`
- gold[3]: `citing Attorney-General v De Keyser’s Royal Hotel, [1920] AC 508 at 542 [emphasis added].`
- gold[4]: `See also Sir William Blackstone, Commentaries on the Laws of England: Book I: Of the Rights of Persons, ed by David Lemmings (Oxford: Oxford Universit…`
- beaver[0]: `See Harrison v Carswell, [1976] 2 SCR 200 at 219`
- beaver[1]: `Toronto Area Transit Operating Authority v Dell Holdings Ltd, [1997] 1 SCR 32 at para 20`
- beaver[2]: `Manitoba Fisheries, supra note 20 at 118, citing Attorney-General v De Keyser’s Royal Hotel, [1920] AC 508 at 542 [emphasis added]. See also Sir Willi…`

### 13. manual-0218 (62-2 Sun - Updated Unedited Final Submission.docx)
- expected 4 part(s), produced 2 — **undersplit**; core loss 0, gain 0; tags: ibid, multi_part, review_marker, signal, supra
- footnote: `Ibid at para 43. See also para 71. The majority’s respectful treatment of precedent may be usefully contrasted with Wills’ own approach, which favours unceremoniously consigning Manitoba Fisheries and Tener “to the wastebasket of judgments that failed to survive the modern rule of statutory interpretation pronounced in…`
- gold[0]: `Ibid at para 43.`
- gold[1]: `See also para 71. The majority’s respectful treatment of precedent may be usefully contrasted with Wills’ own approach, which favours unceremoniously …`
- gold[2]: `“to the wastebasket of judgments that failed to survive the modern rule of statutory interpretation pronounced in Rizzo & Rizzo.”`
- gold[3]: `Wills, supra note 2 at 822.`
- beaver[0]: `Ibid at para 43. See also para 71.`
- beaver[1]: `The majority’s respectful treatment of precedent may be usefully contrasted with Wills’ own approach, which favours unceremoniously consigning Manitob…`

### 14. manual-0290 (Good\[CHECKED] 1_AMPLEMAN-TREMBLAY_[Download_and_edit_me].xlsx)
- expected 6 part(s), produced 4 — **undersplit**; core loss 0, gain 0; tags: multi_part, signal
- footnote: `See, e.g., Michelle S Lawrence, “Self-Induced Extreme Intoxication: Brown and Section 33.1 of the Criminal Code” (2024) The Supreme Court Law Review: Osgoode’s Annual Constitutional Cases Conference 115 [Lawrence (2024)]; Hughes Parent, “Le nouvel article 33.1 du Code criminel: analyse et critique” (2023) 57 RJTUM 487;…`
- gold[0]: `See, e.g., Michelle S Lawrence, “Self-Induced Extreme Intoxication: Brown and Section 33.1 of the Criminal Code” (2024) The Supreme Court Law Review: …`
- gold[1]: `Hughes Parent, “Le nouvel article 33.1 du Code criminel: analyse et critique” (2023) 57 RJTUM 487`
- gold[2]: `Steve Coughlan, "Closing the Door while Opening a Window: R v Brown and the Section 1 Analysis” (2022) 80 CR (7th) 74`
- gold[3]: `Florence Ashley, “Nuancing Feminist Perspectives on the Voluntary Intoxication Defence” (2020) 43:5 Manitoba Law Journal 65`
- gold[4]: `Tim Quigley, "Godot Has Arrived: S. 33.1 of the Criminal Code Struck Down” (2022) 80 C.R. (7th) 65`
- gold[5]: `Mathilde Tremblay, “Charte canadienne et intoxication volontaire: l’article 33.1 du Code criminel et ses solutions de rechange” (2020), 79 Bar Rev. 67…`
- beaver[0]: `See, e.g., Michelle S Lawrence, “Self-Induced Extreme Intoxication: Brown and Section 33.1 of the Criminal Code” (2024) The Supreme Court Law Review: …`
- beaver[1]: `Florence Ashley, “Nuancing Feminist Perspectives on the Voluntary Intoxication Defence” (2020) 43:5 Manitoba Law Journal 65`
- beaver[2]: `Tim Quigley, "Godot Has Arrived: S. 33.1 of the Criminal Code Struck Down” (2022) 80 C.R. (7th) 65`
- beaver[3]: `Mathilde Tremblay, “Charte canadienne et intoxication volontaire: l’article 33.1 du Code criminel et ses solutions de rechange” (2020), 79 Bar Rev. 67…`

### 15. manual-0297 (CHECKED_EDITS\_48_[CHECKED] 1_AMPLEMAN-TREMBLAY_[Download_and_edit_me][testing].xlsx)
- expected 3 part(s), produced 1 — **undersplit**; core loss 0, gain 0; tags: multi_part, review_marker, signal
- footnote: `R v Sullivan, 2020 ONCA 333 at para 129 (see also 88–91) [Sullivan (ONCA)]. It is interesting to note that the suicide narrative is much stronger on appeal. Justice Paciocco starts his reasons by mentioning a suicide attempt (para 1). The trial judge found inconsistencies in Sullivan’s evidence on this matter but still…`
- gold[0]: `R v Sullivan, 2020 ONCA 333 at para 129 (see also 88–91) [Sullivan (ONCA)].`
- gold[1]: `It is interesting to note that the suicide narrative is much stronger on appeal. Justice Paciocco starts his reasons by mentioning a suicide attempt (…`
- gold[2]: `The trial judge found inconsistencies in Sullivan’s evidence on this matter but still concluded that future suicide attempts were a possibility given …`
- beaver[0]: `R v Sullivan, 2020 ONCA 333 at para 129 (see also 88–91) [Sullivan (ONCA)]. It is interesting to note that the suicide narrative is much stronger on a…`

### 16. manual-0302 (Good\[CHECKED] 1_Quirouette_Batista_[Download-and-edit-me].xlsx)
- expected 3 part(s), produced 1 — **undersplit**; core loss 0, gain 0; tags: multi_part, supra
- footnote: `Supra Ulmer and Johnson note 13 Ulmer and Kramer note 47 Eisenstein et al note 13.`
- gold[0]: `Supra Ulmer and Johnson note 13`
- gold[1]: `Ulmer and Kramer note 47`
- gold[2]: `Eisenstein et al note 13.`
- beaver[0]: `Supra Ulmer and Johnson note 13 Ulmer and Kramer note 47 Eisenstein et al note 13.`

### 17. manual-0311 (Inputs\CHECKED_EDITS\[CHECKED] 1_Quirouette_Batista_[Download-and-edit-me].xlsx)
- expected 3 part(s), produced 1 — **undersplit**; core loss 0, gain 0; tags: multi_part
- footnote: `The “politics of waiting” act as a form of social control, with their disadvantaged clients learning to be “patients of the state” to access justice, since there is nothing else they can do. See: Javier Auyero, Patients of the State: The Politics of Waiting in Argentina (Durham: Duke University Press, 2012). As we disc…`
- gold[0]: `The “politics of waiting” act as a form of social control, with their disadvantaged clients learning to be “patients of the state” to access justice, …`
- gold[1]: `See: Javier Auyero, Patients of the State: The Politics of Waiting in Argentina (Durham: Duke University Press, 2012).`
- gold[2]: `As we discuss later, this also evokes notions of how the process is the punishment (Feeley 1979), and how this is a core component of managerial justi…`
- beaver[0]: `The “politics of waiting” act as a form of social control, with their disadvantaged clients learning to be “patients of the state” to access justice, …`

### 18. manual-0315 (Inputs\CHECKED_EDITS\[CHECKED] 1_63-4_KONING-REID-BAKER_[Download_And_Edit_Me].xlsx)
- expected 3 part(s), produced 1 — **undersplit**; core loss 0, gain 0; tags: multi_part
- footnote: `Elizabeth Shilton & Kevin Banks, “The Changing Role of Labour Relations Boards in Canada: Key Research Questions for the 21st Century" (2014) at 3. The Alberta Labour Relations Board primarily applies the Labour Relations Code. Ontario tribunals apply relevant statutes including the Labour Relations Act, the Employment…`
- gold[0]: `Elizabeth Shilton & Kevin Banks, “The Changing Role of Labour Relations Boards in Canada: Key Research Questions for the 21st Century" (2014) at 3.`
- gold[1]: `The Alberta Labour Relations Board primarily applies the Labour Relations Code.`
- gold[2]: `Ontario tribunals apply relevant statutes including the Labour Relations Act, the Employment Standards Act, 2000 [ESA], the Employment Protection for …`
- beaver[0]: `Elizabeth Shilton & Kevin Banks, “The Changing Role of Labour Relations Boards in Canada: Key Research Questions for the 21st Century" (2014) at 3. Th…`

### 19. manual-0327 (Good\[CHECKED] 1_AMPLEMAN-TREMBLAY_[Download_and_edit_me].xlsx)
- expected 5 part(s), produced 3 — **undersplit**; core loss 0, gain 0; tags: ibid, multi_part, supra
- footnote: `Ibid at 2. This assertion stemmed from Sheehy’s research, see Froc & Sheehy, supra note 5 at 277–278. Ashley indicated that their research showed significantly fewer cases of sexual assault between 1995 and 2020, but remarked that cases reported do not take into account the underreporting of this offence. Ashley, supra…`
- gold[0]: `Ibid at 2.`
- gold[1]: `This assertion stemmed from Sheehy’s research, see Froc & Sheehy, supra note 5 at 277–278.`
- gold[2]: `Ashley indicated that their research showed significantly fewer cases of sexual assault between 1995 and 2020, but remarked that cases reported do not…`
- gold[3]: `Ashley, supra note 3, at 75–78.`
- gold[4]: `The rarity of the defence’s success, as highlighted by Ashley, is relied on in other academic studies (Tremblay, supra note 3 at 94) but contested in …`
- beaver[0]: `Ibid at 2.`
- beaver[1]: `This assertion stemmed from Sheehy’s research, see Froc & Sheehy, supra note 5 at 277–278. Ashley indicated that their research showed significantly f…`
- beaver[2]: `Ashley, supra note 3, at 75–78. The rarity of the defence’s success, as highlighted by Ashley, is relied on in other academic studies (Tremblay, supra…`

### 20. manual-0363 (Inputs\CHECKED_EDITS\_8_[CHECKED] 1_63-4_KONING-REID-BAKER_[Download_And_Edit_Me].xlsx)
- expected 4 part(s), produced 2 — **undersplit**; core loss 0, gain 0; tags: multi_part
- footnote: `Elizabeth Shilton & Kevin Banks, “The Changing Role of Labour Relations Boards in Canada: Key Research Questions for the 21st Century" (2014) at 3. The Alberta Labour Relations Board primarily applies the Labour Relations Code. Ontario tribunals apply relevant statutes including the Labour Relations Act, the Employment…`
- gold[0]: `Elizabeth Shilton & Kevin Banks, “The Changing Role of Labour Relations Boards in Canada: Key Research Questions for the 21st Century" (2014) at 3.`
- gold[1]: `The Alberta Labour Relations Board primarily applies the Labour Relations Code.`
- gold[2]: `Ontario tribunals apply relevant statutes including the Labour Relations Act, the Employment Standards Act, 2000 [ESA], the Employment Protection for …`
- gold[3]: `For a completely unrelated article, see Kerry Wilkins, “So You Want to Implement UNDRIP... Special Issue: British Columbia's Declaration on the Rights…`
- beaver[0]: `Elizabeth Shilton & Kevin Banks, “The Changing Role of Labour Relations Boards in Canada: Key Research Questions for the 21st Century" (2014) at 3. Th…`
- beaver[1]: `For a completely unrelated article, see Kerry Wilkins, “So You Want to Implement UNDRIP... Special Issue: British Columbia's Declaration on the Rights…`

