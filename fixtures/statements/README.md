# Sample bank statements

Three statements of Dana, the demo persona (`../seed-data.ts`): a student in Budapest whose parents in Kazakhstan send
money when they can. Upload them to try the statement import (the paperclip in onboarding, or `POST /api/import/file`),
one at a time or all together. Everything is fictitious: people, banks, account numbers (check digits `00`, never
valid), amounts. Period 15 Oct 2025 – 15 Oct 2026.

| File | What | What the import finds |
| --- | --- | --- |
| `kaspi-gold-kzt.csv` | Kaspi Gold-style KZT statement, UTF-8 (BOM), `;`-separated, Kazakh headers (`Күні;Сомасы;Операция;Толығырақ`), `dd.mm.yy` dates, signed `₸` amounts, purchases abroad with the shop's HUF/EUR amount in brackets. 110 rows. | Father "Нұрлан С." **irregular**: 8 of 12 months, ₸90,000–₸370,000, planned at the average ₸130,000; ₸620,000 on Aug 24 kept out of the plan (paid the tuition deposit 2 days later). Mother "Гүлнар С." occasional (3 of 12, not planned). Own transfers and the Kaspi deposit left out; one-offs: tuition deposit, flight. |
| `hu-bank-huf.csv` | Hungarian bank account history in HUF, UTF-8 (BOM), `;`-separated, Hungarian headers, `2026.10.01.` dates. 216 rows. | Rent HUF 180,000 to "Landlord in Budapest" as a monthly bill; groceries, eating out, phone, transit budgets; 12 account fees; top-ups from her KZT and USD accounts left out as own transfers; one transfer from her father arriving converted from KZT (a one-off on this file alone). |
| `usd-account.ofx` | OFX 1.02 (SGML) USD account. 50 rows. | Scholarship USD 400 **regular** (12 of 12 months); transfers to her HUF account left out; wire fees. |

All three together: the father's tenge and forint transfers are one sender, irregular, 9 of 12 months.

`generate.ts` writes the files (deterministic): edit it, run `bun fixtures/statements/generate.ts`, commit the output.
`apps/api/test/dataport/sample-statements.test.ts` checks the committed files match it and import cleanly.
