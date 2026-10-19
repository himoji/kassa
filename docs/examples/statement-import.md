# Import a bank statement

Kassa learns money from home from the user's own statements. The parsing is plain code (ruled tables, statement lines, column names in any language); an AI fallback reads only redacted text, and every row it returns must be found in the statement. The design is in [Statement import design](../architecture/statement-import.md).

The sample files in [`fixtures/statements/`](https://github.com/himoji/kassa/tree/main/fixtures/statements) are one fictitious year of Dana's money: a Kaspi-style KZT statement in Kazakh, a Hungarian bank's HUF history and a USD account in OFX.

## In the app

In onboarding, tap the paperclip and upload one or all three files. The onboarding agent prefills the draft from what it finds; you still review and sign it.

## Through the API

`POST /api/import/file` takes one or more files as `multipart/form-data` (field `file`) and returns a preview. Nothing is saved until `POST /api/import/commit`.

```bash
curl -s "${auth[@]}" -H 'origin: http://localhost:8081' \
  -F file=@fixtures/statements/kaspi-gold-kzt.csv \
  localhost:4000/api/import/file > preview.json
```

The file starts with the bank's own header in Kazakh:

```text
«Kaspi Bank» АҚ;Kaspi Gold бойынша үзінді көшірме
…
15.10.25ж. бастап 15.10.26ж. дейінгі кезеңге
```

### Which columns it found

```bash
jq '.files[0], .mappings[0]' preview.json
```

```json
{ "name": "kaspi-gold-kzt.csv", "format": "csv", "via": "records", "bank": "Kaspi",
  "accountCurrency": "KZT", "cardLast4": "4821", "rows": 110,
  "from": "2025-10-15", "to": "2026-10-15", "rejected": 0 }
{ "path": "kaspi-gold-kzt.csv", "kind": "transactions",
  "fields": { "date": "Күні", "amount": "Сомасы", "operation": "Операция", "merchant": "Толығырақ" },
  "rows": 110, "imported": 110 }
```

### What it learned

```bash
jq '.history.notes' preview.json
```

```json
[
  "Statements: Kaspi Oct 15, 2025 – Oct 15, 2026 (12 months).",
  "Spending: about ₸33,715 a month with bills, without transfers and one-off payments. Biggest: groceries ₸8,975, eating out ₸8,013, entertainment ₸4,433, phone ₸2,982.",
  "Spending has risen: ₸47,710 a month in the last 3 months, ₸30,334 before.",
  "One-off payments, kept out of budgets: UNIVERSITY IN BUDAPEST €1,000 (Aug 26); AIR TICKETS ONLINE ₸186,450 (Jun 20).",
  "Money in. Нұрлан С.: money came in 8 of 12 months, ₸90,000–₸370,000 a month, so I plan with the average, ₸130,000 a month; ₸620,000 on Aug 24 paid for UNIVERSITY IN BUDAPEST, kept out of the plan.",
  "Money in. Гүлнар С.: only 3 of 12 months (₸20,000–₸30,000), not planned as monthly income.",
  "In 6 of 12 months more went out than came in.",
  "Regular payments: MOBILE OPERATOR KZ ₸2,990 (next 2026-11-12); ONLINE MUSIC SUBSCRIPTION ₸1,990 (next 2026-11-18).",
  "Bank and conversion fees: ₸181 over the period; foreign purchases cost about 2.8% over the mid rate.",
  "14 transfers between your own accounts were left out, so nothing is counted twice."
]
```

The same facts are structured for the planner, for example the father's transfers:

```bash
jq '.history.incomes[0]' preview.json
```

```json
{
  "source": "Нұрлан С.", "cadence": "MONTHLY", "regularity": "irregular",
  "monthsReceived": 8, "monthsCovered": 12,
  "minMonthlyMinor": 9000000, "maxMonthlyMinor": 37000000,
  "amount": { "amountMinor": 13000000, "currency": "KZT" },
  "largest": { "date": "2026-08-24", "amountMinor": 62000000, "paidFor": "UNIVERSITY IN BUDAPEST" },
  "stopped": false
}
```

This is the point of the feature: money from home is irregular, so Kassa plans with the ₸130,000 average, not the best month, and keeps the one-off tuition transfer out of the plan. Later, the agent reads this history through its `get_money_history` tool.

## Formats

PDF, CSV, Excel, OFX and JSON, in Russian, Kazakh and English. A Kassa export (`GET /api/export`) imports back exactly. `POST /api/import/preview` takes pasted text instead of a file.
