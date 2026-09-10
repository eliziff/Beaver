# Authorities split benchmark — Beaver native splitter vs ALR gold

Run 2026-09-10T14:29:22Z · gold root `C:/Users/elias/Desktop/Martys Qote Verifier/ALR-Quote-Verifier` · lane: deterministic (native addon, no model).

## Scorecard

| gold file | cases | strict exact | tolerant exact | count | undersplit | oversplit | span P | span R | span F1 | char-neutral |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| fast_split_manual_gold.jsonl | 405 | 39.8% | 39.8% | 41.0% | 237 | 2 | 58.0% | 37.9% | 45.8% | 100.0% |
| fast_split_gold_all.jsonl | 433 | 40.2% | 40.2% | 41.3% | 252 | 2 | 58.1% | 37.9% | 45.9% | 100.0% |

`strict exact` = produced partition equals the canonical gold partition after whitespace/trailing-semicolon normalization. `tolerant exact` additionally accepts any `acceptable_partitions` entry, but only when the split is character-neutral (ALR's rule). `span P/R/F1` matches produced parts against gold parts as multisets of normalized text. `char-neutral` is ALR's `core_loss_gain_neutral`.

## Pinpoint lane (`field_gold_provisional.jsonl`)

| metric | value |
| --- | --- |
| gold parts scored | 566 |
| parts whose gold has pinpoints | 409 |
| first paragraph/section fragment matches | 96.3% |
| page pinpoints match (range endpoints) | 76.3% |
| all pinpoints match (range endpoints) | 69.8% |
| parts with gold pinpoints where Beaver found any | 74.1% |
| parts with no gold pinpoint where Beaver emitted one | 5 |

## Failure taxonomy (fast_split_manual_gold.jsonl)

| outcome | cases | share |
| --- | --- | --- |
| exact | 161 | 39.8% |
| collapsed to one part (no second anchor found) | 180 | 44.4% |
| partial undersplit (some anchors found) | 57 | 14.1% |
| oversplit | 2 | 0.5% |
| right part count, wrong boundary | 5 | 1.2% |

## Detection coverage per authority family

One gold citation in, does the native detector anchor on it at all? Families at 0% cannot be split apart from their neighbours at any boundary rule.

| kind (ALR field gold) | gold parts | citation hit | supra/ibid only | anchored |
| --- | --- | --- | --- | --- |
| case | 201 | 139 | 58 | 98.0% |
| other | 136 | 3 | 109 | 82.4% |
| journal | 108 | 32 | 17 | 45.4% |
| book | 54 | 0 | 21 | 38.9% |
| statute | 29 | 0 | 13 | 44.8% |
| essay_collection | 20 | 0 | 2 | 10.0% |
| non_parliamentary | 10 | 0 | 0 | 0.0% |
| parliamentary_paper | 8 | 0 | 4 | 50.0% |

## Worst 20 misses (fast_split_manual_gold.jsonl)

### 1. manual-0373 (Good\[CHECKED] 1_63-4_Singer-Smith_[Download-and-edit-me].xlsx)
- expected 12 part(s), produced 1 — **undersplit**; core loss 0, gain 0; tags: multi_part, signal
- footnote: `See e.g. Adams, Travis, “Cultural Competency: A Necessary Skill for the 21st Century Attorney” (2012) 4:1(2) William Mitchell L Raza J 1; Barkaskas, Patricia & Sarah Buhler, "Beyond Reconciliation: Decolonizing Clinical Legal Education" (2017) 26 J L & Soc Pol'y 1; Blackett, Adelle, "Follow the Drinking Gourd: Our Road…`
- gold[0]: `See e.g. Adams, Travis, “Cultural Competency: A Necessary Skill for the 21st Century Attorney” (2012) 4:1(2) William Mitchell L Raza J 1`
- gold[1]: `Barkaskas, Patricia & Sarah Buhler, "Beyond Reconciliation: Decolonizing Clinical Legal Education" (2017) 26 J L & Soc Pol'y 1`
- gold[2]: `Blackett, Adelle, "Follow the Drinking Gourd: Our Road to Teaching Critical Race Theory and Slavery and the Law, Contemplatively, at McGill" (2017) 62…`
- gold[3]: `Bhabha, Faisal, "Towards a Pedagogy of Diversity in Legal Education" (2015). 52:1 Osgoode Hall LJ 59`
- gold[4]: `Bouclin, Suzanne, "Marginalized Law Students and Mentorship" (2017) 48:2 Ottawa L Rev 356`
- gold[5]: `Brooks, Kimberley, "The Daily Work of Fitting in as a Marginalized Lawyer"(2019). 45:1 Queen's LJ 157`
- gold[6]: `Burell, Jacquelyn, et al. "Literacy Requirements of Court Documents: An Underexplored Barrier to Access to Justice" (2016) 33:2 Windsor YB Access Just…`
- gold[7]: `Devlin, Richard & Dianne Pothier, "Redressing the Imbalances: Rethinking the Judicial Role after R. v. R.D.S."(1999) 31:1 Ottawa L Rev 1`
- gold[8]: `Parmar, Pooja, "Reconciliation and Ethical Lawyering: Some Thoughts on Cultural Competence" (2019) 97:3 Can Bar Rev 526`
- gold[9]: `McGill, Jena & Amy Salyzyn "Queer Insights on Women in the Legal Profession" (2014) 17:2 Leg Ethics 231`
- gold[10]: `Buhler, Sarah & Sarah Marsden, "Lawyer Competencies for Access to Justice: Two Empirical Studies" (2017) 34:2 Windsor YB Access Just 186`
- gold[11]: `Singer, Samuel, "Trans Competent Lawyering" (2019) in Joanna Radbord, (ed.), LGBTQ2 + Law: Practice Issues and Analysis (Toronto: Emond Publishing, 20…`
- beaver[0]: `See e.g. Adams, Travis, “Cultural Competency: A Necessary Skill for the 21st Century Attorney” (2012) 4:1(2) William Mitchell L Raza J 1; Barkaskas, P…`

### 2. manual-0376 (Good\[CHECKED] 1_63-4_Singer-Smith_[Download-and-edit-me].xlsx)
- expected 9 part(s), produced 1 — **undersplit**; core loss 0, gain 0; tags: multi_part, signal
- footnote: `See e.g., James J, Bauer G, Peck R, Brennan D, Nussbaum N, "TRANSforming JUSTICE - Trans Legal Needs Assessment Ontario" (2018); Ashley, Florence, "Don't Be So Hateful: The Insufficiency of Anti-Discrimination and Hate Crime Laws in Improving Trans Well-Being" (2018) 68:1 UTLJ 1–36; Nora Butler Burke, "Double Punishmen…`
- gold[0]: `See e.g., James J, Bauer G, Peck R, Brennan D, Nussbaum N, "TRANSforming JUSTICE - Trans Legal Needs Assessment Ontario" (2018)`
- gold[1]: `Ashley, Florence, "Don't Be So Hateful: The Insufficiency of Anti-Discrimination and Hate Crime Laws in Improving Trans Well-Being" (2018) 68:1 UTLJ 1…`
- gold[2]: `Nora Butler Burke, "Double Punishment: Immigration Penalty and Migrant Trans Women Who Sell Sex" in Elya M Durisin, Emily van der Meulen & Chris Bruck…`
- gold[3]: `Samuel Singer, “Trans Rights Are Not Just Human Rights: Legal Strategies for Trans Justice” (2020) 35:2 Canadian Journal of Law and Society 293`
- gold[4]: `Samuel Singer, “Trans Competent Lawyering” in Joanna Radbord, (ed.), LGBTQ2 + Law: Practice Issues and Analysis, (Toronto: Emond Publishing, 2019)`
- gold[5]: `Irving, Dan & Nathan Hoo. “Doing Trans-Economic Justice: A Critique of Anti-Discrimination Laws and Inclusive Employment Policies” (2020) 35:2 Canadia…`
- gold[6]: `Baril, Alexandre et al. “Forgotten Wishes: End-of-Life Documents for Trans People with Dementia at the Margins of Legal Change” (2020) 35:2 Canadian J…`
- gold[7]: `Laidlaw, Leon. “Trans University Students’ Access to Facilities: The Limits of Accommodation” (2020) 35:2 Canadian Journal of Law and Society 269`
- gold[8]: `Hébert, William. “Trans Rights as Risks: On the Ambivalent Implementation of Canada’s Groundbreaking Trans Prison Reform” (2020) 35:2 Canadian Journal…`
- beaver[0]: `See e.g., James J, Bauer G, Peck R, Brennan D, Nussbaum N, "TRANSforming JUSTICE - Trans Legal Needs Assessment Ontario" (2018); Ashley, Florence, "Do…`

### 3. manual-0423 (Inputs\CHECKED_EDITS\_7_[CHECKED] 1_63-4_KONING-REID-BAKER_[Download_And_Edit_Me].xlsx)
- expected 8 part(s), produced 1 — **undersplit**; core loss 0, gain 0; tags: multi_part, review_marker
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

### 4. manual-0371 (Good\[CHECKED] 1_63-4_Singer-Smith_[Download-and-edit-me].xlsx)
- expected 7 part(s), produced 1 — **undersplit**; core loss 0, gain 0; tags: multi_part, review_marker, signal
- footnote: `See e.g. Alice Woolley, "Lawyer Regulation in Canada" (2017) 95:4 Can Bar Rev 893; Adam M Dodek, "Regulating Law Firms in Canada" (2012) 90:3 Cahttps://www.canlii.org/en/commentary/doc/2012CanLIIDocs106; Amy Salyzyn, "The Judicial Regulation of Lawyers in Canada" (2014) 37:2 Dal LJ 105; Richard F Devlin & Porter Heffer…`
- gold[0]: `See e.g. Alice Woolley, "Lawyer Regulation in Canada" (2017) 95:4 Can Bar Rev 893`
- gold[1]: `Adam M Dodek, "Regulating Law Firms in Canada" (2012) 90:3 Cahttps://www.canlii.org/en/commentary/doc/2012CanLIIDocs106`
- gold[2]: `Amy Salyzyn, "The Judicial Regulation of Lawyers in Canada" (2014) 37:2 Dal LJ 105`
- gold[3]: `Richard F Devlin & Porter Heffernan, “The End(s) of Self-Regulation?” (2008) 45:5 Alta L Rev 169, online: Alberta Law Review https://albertalawreview.…`
- gold[4]: `Law Society of Saskatchewan v Abrametz, 2022 SCC 29.`
- gold[5]: `See also see also Philip Slayton, Lawyers Gone Bad: Money, Sex and Madness in Canada's Legal Profession (Toronto: Viking Canada, 2007)`
- gold[6]: `Radio Canada International, "Lawyer couple accused of stealing millions from homebuyers while law society stalled" (22 April 2024), online: [perma.cc/…`
- beaver[0]: `See e.g. Alice Woolley, "Lawyer Regulation in Canada" (2017) 95:4 Can Bar Rev 893; Adam M Dodek, "Regulating Law Firms in Canada" (2012) 90:3 Cahttps:…`

### 5. manual-0045 (62-2 Dylan - FINAL (unedited) SUBMISSION.docx)
- expected 6 part(s), produced 1 — **undersplit**; core loss 0, gain 0; tags: multi_part, review_marker
- footnote: `Sonja Puzic, “Woman charged in Toronto dog attack previously deemed 'irresponsible' pet owner”ng Dogs" (2020) 21:1 Nev LJ 117 at sued a pardon to a dog, even though it was care-giving.holders if not persons, man offenders Mar 28, 2024, Canadian Press online: <https://www.thecanadianpressnews.ca/ontario/woman-charged-in…`
- gold[0]: `Sonja Puzic, “Woman charged in Toronto dog attack previously deemed 'irresponsible' pet owner”ng Dogs" (2020) 21:1 Nev LJ 117 at sued a pardon to a do…`
- gold[1]: `Kiana Ferreira, “Off-leash dog attack kills dog, injures owner in Hamilton” July 27, 2024, CHCH news online: <https://www.chch.com/off-leash-dog-attac…`
- gold[2]: `Don Mitchell “Victim of Burlington, Ont. dog attack dies in hospital: police” June 22, 2023, Global News, online: <https://globalnews.ca/news/9786475/…`
- gold[3]: `CBC News, “Boy, 14, seriously injured in off-leash dog attack in Toronto school yard” May 17, 2023, CBC online: <https://www.cbc.ca/news/canada/toront…`
- gold[4]: `Dominik Kurek, “Canada Post mail carriers, dogs, bites and unwanted interactions across Canada: What the company asks owners to keep in mind” August 2…`
- gold[5]: `Rachel Watts, “Quebec woman mauled in dog attack wins $460K civil case against small town and owner” May 17, 2024 CBC News online: <https://www.cbc.ca…`
- beaver[0]: `Sonja Puzic, “Woman charged in Toronto dog attack previously deemed 'irresponsible' pet owner”ng Dogs" (2020) 21:1 Nev LJ 117 at sued a pardon to a do…`

### 6. manual-0025 (1_64-1_Martin [Download and Edit Me].docx)
- expected 7 part(s), produced 3 — **undersplit**; core loss 0, gain 0; tags: multi_part, supra
- footnote: `Dodek, supra note 54 at 18-20; Martin, Legal Ethics and the Attorney General, supra note 2 at 65; Mark J Freiman, “Convergence of Law and Policy and the Role of the Attorney General” (2002) 16 SCLR (2d) 335 at 338; Ian G Scott, “The Role of the Attorney General and the Charter of Rights” (1986-1987) 29 Crim LQ 187 at 1…`
- gold[0]: `Dodek, supra note 54 at 18-20`
- gold[1]: `Martin, Legal Ethics and the Attorney General, supra note 2 at 65`
- gold[2]: `Mark J Freiman, “Convergence of Law and Policy and the Role of the Attorney General” (2002) 16 SCLR (2d) 335 at 338`
- gold[3]: `Ian G Scott, “The Role of the Attorney General and the Charter of Rights” (1986-1987) 29 Crim LQ 187 at 188-189 (“[T]he Attorney General has a positiv…`
- gold[4]: `John C Tait, “The Public Service Lawyer, Service to the Client and the Rule of Law” (1997) 23:1/2 Commonwealth L Bull 542 at 543 (“The federal Departm…`
- gold[5]: `Government Organization Act, RSA 2000, c G-10, Sched 9, s 2(b): “The Minister … shall ensure that public affairs are administered according to law”.`
- gold[6]: `Elizabeth Sanderson, Government Lawyering: Duties and Ethical Challenges of Government Lawyers (Toronto: LexisNexis Canada, 2018) at 217 describes thi…`
- beaver[0]: `Dodek, supra note 54 at 18-20`
- beaver[1]: `Martin, Legal Ethics and the Attorney General, supra note 2 at 65`
- beaver[2]: `Mark J Freiman, “Convergence of Law and Policy and the Role of the Attorney General” (2002) 16 SCLR (2d) 335 at 338; Ian G Scott, “The Role of the Att…`

### 7. manual-0059 (62-2 Dylan - FINAL (unedited) SUBMISSION.docx)
- expected 5 part(s), produced 1 — **undersplit**; core loss 0, gain 0; tags: multi_part, review_marker
- footnote: `See François Jaquet, “Is Speciesism Wrong by Definition?” (2019) 32 Journal of Agricultural and Environmental Ethics 447 at 448, 456 [Jaquet 1], François Jaquet, “What’s Wrong with Speciesism” (2020) The Journal of Value Inquiry at 1 [Jaquet 2]; Lucius Caviola, “The Moral Standing of Animals: Towards a Psychology of …`
- gold[0]: `See François Jaquet, “Is Speciesism Wrong by Definition?” (2019) 32 Journal of Agricultural and Environmental Ethics 447 at 448, 456 [Jaquet 1],`
- gold[1]: `François Jaquet, “What’s Wrong with Speciesism” (2020) The Journal of Value Inquiry at 1 [Jaquet 2]`
- gold[2]: `Lucius Caviola, “The Moral Standing of Animals: Towards a Psychology of Speciesism” (2019) 116:6 Journal of Personality and Social Psychology 1011 at …`
- gold[3]: `Oscar Horta “What is Speciesism?” (2010) 23 J Agric Environ Ethics 243–266 and Oscar Horta 2022, “Speciesism” (2002) Oxford Public Philosophy, online:…`
- gold[4]: `Emer O’Hagan, “Animals, Agency, and Obligation in Kantian Ethics” (2009) 35:4 Social Theory and Practice 531 at 533, 554.`
- beaver[0]: `See François Jaquet, “Is Speciesism Wrong by Definition?” (2019) 32 Journal of Agricultural and Environmental Ethics 447 at 448, 456 [Jaquet 1], Fran…`

### 8. manual-0005 (1_64-1_Martin [Download and Edit Me].docx)
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

### 9. manual-0151 (62-2 Sun - Updated Unedited Final Submission.docx)
- expected 4 part(s), produced 1 — **undersplit**; core loss 0, gain 0; tags: multi_part, signal
- footnote: `See e.g. Russell Brown, “The Constructive Taking at the Supreme Court of Canada: Once More, Without Feeling” (2007) 40:1 UBC L Rev 315 at 334, 341-42 [“Constructive Taking”]; Russell Brown, “Legal incoherence and the extra-constitutional law of regulatory takings: The Canadian experience” (2009) 1:3 Int’l JL in the Bui…`
- gold[0]: `See e.g. Russell Brown, “The Constructive Taking at the Supreme Court of Canada: Once More, Without Feeling” (2007) 40:1 UBC L Rev 315 at 334, 341-42 …`
- gold[1]: `Russell Brown, “Legal incoherence and the extra-constitutional law of regulatory takings: The Canadian experience” (2009) 1:3 Int’l JL in the Built En…`
- gold[2]: `Malcolm Lavoie, “Property Rights, Takings, and the Rule of Law: Assessing Annapolis Group v. Halifax Regional Municipality” (2024) 4 SCLR (3d) 177 at …`
- gold[3]: `Karen Horsman & Gareth Morley, eds, Government Liability: Law and Practice (Toronto: Thomson Reuters Canada, 2024) at § 5.5.`
- beaver[0]: `See e.g. Russell Brown, “The Constructive Taking at the Supreme Court of Canada: Once More, Without Feeling” (2007) 40:1 UBC L Rev 315 at 334, 341-42 …`

### 10. manual-0206 (62-2 Sun - Updated Unedited Final Submission.docx)
- expected 5 part(s), produced 2 — **undersplit**; core loss 0, gain 0; tags: multi_part, signal
- footnote: `See e.g. Lord Reid, “The Judge as Lawmaker” (1972) 12:2 Journal of the Society of Public Teachers of Law 22. But see JM Finnis, “The Fairy Tale’s Moral” (1999) 115 Law Q Rev 170; Allan Beever, “The Declaratory Theory of Law” (2013) 33:3 Oxford J Leg Stud 421 at 430-39; Lucas Clover Alcolea, “What Exactly is the Common …`
- gold[0]: `See e.g. Lord Reid, “The Judge as Lawmaker” (1972) 12:2 Journal of the Society of Public Teachers of Law 22.`
- gold[1]: `But see JM Finnis, “The Fairy Tale’s Moral” (1999) 115 Law Q Rev 170`
- gold[2]: `Allan Beever, “The Declaratory Theory of Law” (2013) 33:3 Oxford J Leg Stud 421 at 430-39`
- gold[3]: `Lucas Clover Alcolea, “What Exactly is the Common Law?” (12 September 2024), online (blog): The New Digest <https://open.substack.com/pub/thenewdigest…`
- gold[4]: `Lucas Clover Alcolea, “Why is there ‘but one common law in Australia’?” (2025) 99 Aus LJ [forthcoming in 2025].`
- beaver[0]: `See e.g. Lord Reid, “The Judge as Lawmaker” (1972) 12:2 Journal of the Society of Public Teachers of Law 22. But see JM Finnis, “The Fairy Tale’s Mora…`
- beaver[1]: `Lucas Clover Alcolea, “Why is there ‘but one common law in Australia’?” (2025) 99 Aus LJ [forthcoming in 2025].`

### 11. manual-0235 (62-2 Sun - Updated Unedited Final Submission.docx)
- expected 4 part(s), produced 1 — **undersplit**; core loss 0, gain 0; tags: multi_part
- footnote: `Wills’ position reproduces what some Australian lawyers have termed the “fusion fallacy”, which is “the view that integration (fusion) of the doctrines and remedies of the common law and equity is permitted, either because of or notwithstanding the effect of the judicature legislation of the 1870s.” Trischa Mann & Audr…`
- gold[0]: `Wills’ position reproduces what some Australian lawyers have termed the “fusion fallacy”, which is “the view that integration (fusion) of the doctrine…`
- gold[1]: `Trischa Mann & Audrey Blunden, eds, Australian Law Dictionary (Oxford: Oxford University Press, 2010), sub verbo “fusion fallacy”`
- gold[2]: `JD Heydon, MJ Leeming & PG Turner, eds, Meagher, Gummow & Lehane’s Equity: Doctrines & Remedies, 5th ed (Chatswood, NSW: LexisNexis Butterworths, 2015…`
- gold[3]: `There is in fact a robust debate between “fusionists” and “traditionalists”. Compare Andrew Burrows, “We Do This At Common Law But That In Equity” (20…`
- beaver[0]: `Wills’ position reproduces what some Australian lawyers have termed the “fusion fallacy”, which is “the view that integration (fusion) of the doctrine…`

### 12. manual-0259 (62-2 Sun - Updated Unedited Final Submission.docx)
- expected 4 part(s), produced 1 — **undersplit**; core loss 0, gain 0; tags: multi_part, signal
- footnote: `JW Neyers & Andrew Botterell, “Tate & Lyle: Pure Economic Loss and the Modern Tort of Public Nuisance” (2016) 53:4 Alta L Rev 1031 at 1045. See generally Peter Benson, “The Basis for Excluding Liability for Economic Loss in Tort Law” in David G Owen, ed, The Philosophical Foundations of Tort Law (Oxford: Oxford Univers…`
- gold[0]: `JW Neyers & Andrew Botterell, “Tate & Lyle: Pure Economic Loss and the Modern Tort of Public Nuisance” (2016) 53:4 Alta L Rev 1031 at 1045.`
- gold[1]: `See generally Peter Benson, “The Basis for Excluding Liability for Economic Loss in Tort Law” in David G Owen, ed, The Philosophical Foundations of To…`
- gold[2]: `See also Robert Stevens, Torts and Rights (Oxford: Oxford University Press, 2007) at 21, 23`
- gold[3]: `Donal Nolan, “Rights, Damage and Loss” (2017) 37:2 Oxford J Leg Stud 255 at 267.`
- beaver[0]: `JW Neyers & Andrew Botterell, “Tate & Lyle: Pure Economic Loss and the Modern Tort of Public Nuisance” (2016) 53:4 Alta L Rev 1031 at 1045. See genera…`

### 13. manual-0262 (62-2 Sun - Updated Unedited Final Submission.docx)
- expected 4 part(s), produced 1 — **undersplit**; core loss 0, gain 0; tags: multi_part, signal, supra
- footnote: `Crown Liability and Proceedings Act, RSC 1985, c C-50, s 3(b)(i). See e.g. Proceedings Against the Crown Act, RSNS 1989, c 360, s 5(1)(a); Crown Proceeding Act, RSBC 1996, c 89, s 2(c). See generally Hogg, Monahan & Wright, supra note 44 at 160-66.`
- gold[0]: `Crown Liability and Proceedings Act, RSC 1985, c C-50, s 3(b)(i).`
- gold[1]: `See e.g. Proceedings Against the Crown Act, RSNS 1989, c 360, s 5(1)(a)`
- gold[2]: `Crown Proceeding Act, RSBC 1996, c 89, s 2(c).`
- gold[3]: `See generally Hogg, Monahan & Wright, supra note 44 at 160-66.`
- beaver[0]: `Crown Liability and Proceedings Act, RSC 1985, c C-50, s 3(b)(i). See e.g. Proceedings Against the Crown Act, RSNS 1989, c 360, s 5(1)(a); Crown Proce…`

### 14. manual-0290 (Good\[CHECKED] 1_AMPLEMAN-TREMBLAY_[Download_and_edit_me].xlsx)
- expected 6 part(s), produced 3 — **undersplit**; core loss 0, gain 0; tags: multi_part, signal
- footnote: `See, e.g., Michelle S Lawrence, “Self-Induced Extreme Intoxication: Brown and Section 33.1 of the Criminal Code” (2024) The Supreme Court Law Review: Osgoode’s Annual Constitutional Cases Conference 115 [Lawrence (2024)]; Hughes Parent, “Le nouvel article 33.1 du Code criminel: analyse et critique” (2023) 57 RJTUM 487;…`
- gold[0]: `See, e.g., Michelle S Lawrence, “Self-Induced Extreme Intoxication: Brown and Section 33.1 of the Criminal Code” (2024) The Supreme Court Law Review: …`
- gold[1]: `Hughes Parent, “Le nouvel article 33.1 du Code criminel: analyse et critique” (2023) 57 RJTUM 487`
- gold[2]: `Steve Coughlan, "Closing the Door while Opening a Window: R v Brown and the Section 1 Analysis” (2022) 80 CR (7th) 74`
- gold[3]: `Florence Ashley, “Nuancing Feminist Perspectives on the Voluntary Intoxication Defence” (2020) 43:5 Manitoba Law Journal 65`
- gold[4]: `Tim Quigley, "Godot Has Arrived: S. 33.1 of the Criminal Code Struck Down” (2022) 80 C.R. (7th) 65`
- gold[5]: `Mathilde Tremblay, “Charte canadienne et intoxication volontaire: l’article 33.1 du Code criminel et ses solutions de rechange” (2020), 79 Bar Rev. 67…`
- beaver[0]: `See, e.g., Michelle S Lawrence, “Self-Induced Extreme Intoxication: Brown and Section 33.1 of the Criminal Code” (2024) The Supreme Court Law Review: …`
- beaver[1]: `Tim Quigley, "Godot Has Arrived: S. 33.1 of the Criminal Code Struck Down” (2022) 80 C.R. (7th) 65`
- beaver[2]: `Mathilde Tremblay, “Charte canadienne et intoxication volontaire: l’article 33.1 du Code criminel et ses solutions de rechange” (2020), 79 Bar Rev. 67…`

### 15. manual-0312 (CHECKED_EDITS\_34_[CHECKED] 1_AMPLEMAN-TREMBLAY_[Download_and_edit_me][testing].xlsx)
- expected 4 part(s), produced 1 — **undersplit**; core loss 0, gain 0; tags: multi_part, signal
- footnote: `R v Sullivan, 2020 ONCA 333 at para 129 (see also 88–91) [Sullivan (ONCA)]. It is interesting to note that the suicide narrative is much stronger on appeal. Justice Paciocco starts his reasons by mentioning a suicide attempt (para 1). The trial judge found inconsistencies in Sullivan’s evidence on this matter but still…`
- gold[0]: `R v Sullivan, 2020 ONCA 333 at para 129 (see also 88–91) [Sullivan (ONCA)].`
- gold[1]: `It is interesting to note that the suicide narrative is much stronger on appeal.`
- gold[2]: `Justice Paciocco starts his reasons by mentioning a suicide attempt (para 1).`
- gold[3]: `The trial judge found inconsistencies in Sullivan’s evidence on this matter but still concluded that future suicide attempts were a possibility given …`
- beaver[0]: `R v Sullivan, 2020 ONCA 333 at para 129 (see also 88–91) [Sullivan (ONCA)]. It is interesting to note that the suicide narrative is much stronger on a…`

### 16. manual-0363 (Inputs\CHECKED_EDITS\_8_[CHECKED] 1_63-4_KONING-REID-BAKER_[Download_And_Edit_Me].xlsx)
- expected 4 part(s), produced 1 — **undersplit**; core loss 0, gain 0; tags: multi_part
- footnote: `Elizabeth Shilton & Kevin Banks, “The Changing Role of Labour Relations Boards in Canada: Key Research Questions for the 21st Century" (2014) at 3. The Alberta Labour Relations Board primarily applies the Labour Relations Code. Ontario tribunals apply relevant statutes including the Labour Relations Act, the Employment…`
- gold[0]: `Elizabeth Shilton & Kevin Banks, “The Changing Role of Labour Relations Boards in Canada: Key Research Questions for the 21st Century" (2014) at 3.`
- gold[1]: `The Alberta Labour Relations Board primarily applies the Labour Relations Code.`
- gold[2]: `Ontario tribunals apply relevant statutes including the Labour Relations Act, the Employment Standards Act, 2000 [ESA], the Employment Protection for …`
- gold[3]: `For a completely unrelated article, see Kerry Wilkins, “So You Want to Implement UNDRIP... Special Issue: British Columbia's Declaration on the Rights…`
- beaver[0]: `Elizabeth Shilton & Kevin Banks, “The Changing Role of Labour Relations Boards in Canada: Key Research Questions for the 21st Century" (2014) at 3. Th…`

### 17. manual-0383 (Good\[CHECKED] 1_AMPLEMAN-TREMBLAY_[Download_and_edit_me].xlsx)
- expected 5 part(s), produced 2 — **undersplit**; core loss 0, gain 0; tags: ibid, multi_part
- footnote: `Ibid at paras 98 and 123. The toxicology report also indicated the presence of Midazolam, but in a dosage too low to produce therapeutic effects (para 95). Of note, while evidence of self-induced intoxication is complex on its own, such cases are at risk of investigative failures like any others. In Barrett, the police…`
- gold[0]: `Ibid at paras 98 and 123.`
- gold[1]: `The toxicology report also indicated the presence of Midazolam, but in a dosage too low to produce therapeutic effects (para 95).`
- gold[2]: `Of note, while evidence of self-induced intoxication is complex on its own, such cases are at risk of investigative failures like any others.`
- gold[3]: `In Barrett, the police also failed to seize any mushrooms from the accused’s residence.`
- gold[4]: `Ibid at para 92.`
- beaver[0]: `Ibid at paras 98 and 123. The toxicology report also indicated the presence of Midazolam, but in a dosage too low to produce therapeutic effects (para…`
- beaver[1]: `In Barrett, the police also failed to seize any mushrooms from the accused’s residence. Ibid at para 92.`

### 18. manual-0414 (Inputs\CHECKED_EDITS\[CHECKED] 1_AMPLEMAN-TREMBLAY_[Download_and_edit_me] (2).xlsx)
- expected 4 part(s), produced 1 — **undersplit**; core loss 0, gain 0; tags: multi_part
- footnote: `Joaquin Velez Navarro, “The Creation of Evil: The Role of the Law in Shaping Beliefs on Drug Harm and Addiction” (2022) 49(1) Ohio NU L Rev 115. The international and Canadian regime of drug control may differ. For more information compare the Schedules of the Single Convention on Narcotic Drugs, 1961 as amended by the…`
- gold[0]: `Joaquin Velez Navarro, “The Creation of Evil: The Role of the Law in Shaping Beliefs on Drug Harm and Addiction” (2022) 49(1) Ohio NU L Rev 115.`
- gold[1]: `The international and Canadian regime of drug control may differ.`
- gold[2]: `For more information compare the Schedules of the Single Convention on Narcotic Drugs, 1961 as amended by the 1972 Protocol amending the Single Conven…`
- gold[3]: `and the Canadian Controlled Drugs and Substances Act, S.C. 1996, c. 19 [CDSA].`
- beaver[0]: `Joaquin Velez Navarro, “The Creation of Evil: The Role of the Law in Shaping Beliefs on Drug Harm and Addiction” (2022) 49(1) Ohio NU L Rev 115. The i…`

### 19. manual-0006 (1_64-1_Martin [Download and Edit Me].docx)
- expected 3 part(s), produced 1 — **undersplit**; core loss 0, gain 0; tags: multi_part, review_marker, supra
- footnote: `Law Society of Alberta v Madu, 2024 ABLS 20 [Madu], discussed in Martin, Legal Ethics and the Attorney General, supra note 2 at xi-xiii, penalty at 2025 ABLS 11 [Madu penalty].`
- gold[0]: `Law Society of Alberta v Madu, 2024 ABLS 20 [Madu],`
- gold[1]: `discussed in Martin, Legal Ethics and the Attorney General, supra note 2 at xi-xiii,`
- gold[2]: `penalty at 2025 ABLS 11 [Madu penalty].`
- beaver[0]: `Law Society of Alberta v Madu, 2024 ABLS 20 [Madu], discussed in Martin, Legal Ethics and the Attorney General, supra note 2 at xi-xiii, penalty at 20…`

### 20. manual-0018 (1_64-1_Martin [Download and Edit Me].docx)
- expected 3 part(s), produced 1 — **undersplit**; core loss 0, gain 0; tags: multi_part, signal, supra
- footnote: `Third reading Hansard, supra note 39 at 926 (Naheed Nenshi). See also 928 (Irfan Sabir): “As the Leader of the Official Opposition mentioned, the Minister of Justice had more than a few opportunities to talk about this bill and at least enlighten us about why this immunity for him was necessary while he’s giving himsel…`
- gold[0]: `Third reading Hansard, supra note 39 at 926 (Naheed Nenshi).`
- gold[1]: `See also 928 (Irfan Sabir): “As the Leader of the Official Opposition mentioned, the Minister of Justice had more than a few opportunities to talk abo…`
- gold[2]: `See also 929 (Rakhi Pancholi): “The minister has yet to speak to why that’s the case.”`
- beaver[0]: `Third reading Hansard, supra note 39 at 926 (Naheed Nenshi). See also 928 (Irfan Sabir): “As the Leader of the Official Opposition mentioned, the Mini…`

