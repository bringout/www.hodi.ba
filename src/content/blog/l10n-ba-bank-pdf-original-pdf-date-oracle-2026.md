---
title: 'Bosanska lokalizacija "Odoo" open-source platforme: l10n_ba_bank_pdf refactor - uklonjena cache polja, originalni PDF je opet attachment'
description: 'l10n_ba_bank_pdf 16.0.1.36.0 je refactor koji čisti posljedice ranije loše odluke: Odoo attachment više nije image-only PDF bez tekstualnog sloja, nego originalni PDF koji je banka poslala. Zbog toga se uklanjaju cache polja za ground-truth račune i salda, jer se regex orakli mogu ponovo izvršiti nad originalnim PDF tekstom pri svakom reprocess-u. Uz to je dodat hook _extract_ground_truth_date: za Sparkasse se datum izvoda deterministički čita iz headera "Izvod broj N od dd.mm.yyyy na dan dd.mm.yyyy" - koristi se prvi datum iza "od", ne as-of datum iza "na dan".'
pubDate: '2026-04-27T22:30:00'
heroImage: '/bank-pdf-original-date-oracle-hero.png'
---

## Refactor koji briše posljedice pogrešne odluke

Ovaj tekst je nastavak na prethodni zapis
[`l10n-ba-bank-pdf-cross-check-povrat-2026`](/blog/l10n-ba-bank-pdf-cross-check-povrat-2026.md/),
gdje su uvedeni per-bank ground-truth računi, `confirmed`/`suspicious`/`snap`
klasifikacija i Raiffeisen POVRAT KREDITA fix. Taj post je tačno opisao
tadašnje stanje: Odoo attachment je bio flat image-only PDF bez tekstualnog
sloja, a original je ostajao samo u mail audit trail-u. To se pokazalo kao
loša odluka. Ova iteracija mijenja baš taj dio.

U ranijoj iteraciji `l10n_ba_bank_pdf` modul je, kada je `use_vision=True`, u Odoo attachment spremao "flat" image-only PDF: svaka stranica originalnog PDF-a rasterizovana u PNG, pa ubačena nazad u PDF kontejner. To je bila pogrešna optimizacija. Imala je kratkoročnu logiku:

- LLM vidi upravo tu rasterizovanu sliku.
- ProCredit PDF-ovi nose velike font subsete, pa je flat PDF bio znatno manji.
- Operater u Odoo-u vidi isto što je AI vidio.

Ali trade-off je bio loš za dugoročni reprocess. Flat PDF više nema tekstualni sloj. A upravo taj tekstualni sloj je postao deterministički izvor istine za:

- 16-cifrene transakcijske račune koji se koriste za `confirmed`, `suspicious`, `snap` i `snap_long` provjere,
- bank-specifične salde, npr. Raiffeisen `PRETHODNI SALDO` i `NOVI SALDO`,
- novi datum izvoda pročitan regexom iz zaglavlja.

Zato je `l10n_ba_bank_pdf 16.0.1.36.0` prije svega refactor: uklanja potrebu za cache poljima tako što vraća ispravan izvor podataka. **Odoo ponovo čuva originalni PDF banke**.

## Šta se sada događa u importu

Tok import-a je sada jasniji:

1. Email stigne na bankovni intake mailbox.
2. PDF attachment se snimi na `account.bank.statement` kao originalni bankovni PDF.
3. Parser otvori originalni PDF i izvuče tekstualni sloj.
4. Ako je parser u vision modu, stranice se rasterizuju u PNG samo u memoriji i šalju LLM-u.
5. PNG render se ne sprema kao zamjena za attachment.
6. Reprocess kasnije ponovo čita isti originalni PDF, sa istim tekstualnim slojem.

Najvažniji dio je u samoj namjeri API-ja:

```python
def _extract_statement_data(self, pdf_content, journal):
    # pdf_content je originalni attachment koji je banka poslala.
    # Vision render se pravi samo za LLM upload, ne perzistira se.
```

Drugim riječima: vision ostaje način čitanja kada tekst nije dovoljan, ali storage više ne gubi original.

## Zašto su cache polja uklonjena

Prethodni workaround za image-only attachment bio je cache:

- `pdf_text_balance_start`
- `pdf_text_balance_end`
- `has_pdf_text_balance`
- `pdf_text_ground_truth_accounts`

Ta polja su postojala samo zato što smo sami sebi oduzeli izvor podataka: prvi import je imao originalni PDF, ali reprocess je kasnije imao samo flat PDF bez teksta. Ako se deterministički signal ne upiše odmah u bazu, više ga nema odakle pročitati.

Sa novim pristupom cache više nije potreban. Originalni PDF je uvijek attachment, pa se svaki `_extract_ground_truth_X(text)` hook može ponovo izvršiti. Migracija `16.0.1.36.0` zato briše ta zastarjela polja.

Ovo je bolji model podataka: ne čuvamo izvedene "oracle" vrijednosti samo zato što smo ranije izgubili izvor. Čuvamo izvor i brišemo cache koji je nastao kao kompenzacija za loš storage izbor.

## Datum izvoda ne smije zavisiti od LLM-a

LLM je koristan za kontekst tabele: opis, partner, iznos, znak transakcije. Ali datum izvoda je loše polje za LLM:

- može uzeti datum transakcijskog reda umjesto datuma izvoda,
- može pročitati datum iz marketing footera,
- može pogriješiti cifru u danu, mjesecu ili godini,
- kod vision moda vidi mnogo datuma na istoj stranici i bira pogrešan.

Za datum ne treba "razumijevanje". Treba stabilan regex nad tekstualnim slojem PDF-a.

Zato core parser sada ima hook:

```python
def _extract_ground_truth_date(self, text):
    return None
```

Bankarski submoduli ga override-uju kada imaju stabilan format zaglavlja.

## Sparkasse: datum iza "od" je datum izvoda

Sparkasse header ima oblik:

```text
Izvod broj <N> od <dd.mm.yyyy> na dan <dd.mm.yyyy>
```

Prvi datum, iza `od`, je datum izvoda koji Sparkasse koristi kao statement date. Drugi datum, iza `na dan`, je balance as-of datum i može biti naredni dan. Za primjer `Izvod broj 28 od 16.02.2026 na dan 17.02.2026`, Odoo `account.bank.statement.date` treba biti `2026-02-16`, ne `2026-02-17`.

Sparkasse override zato radi usko ciljano:

```python
DATE_RE = re.compile(
    r"Izvod\s+broj\s+\d+\s+od\s+(\d{2})\.(\d{2})\.(\d{4})"
    r"\s+na\s+dan\s+\d{2}\.\d{2}\.\d{4}"
)
```

Ako regex nađe datum, parser prepisuje LLM-ov `statement_date` tom vrijednošću. Ako se LLM i regex ne slažu, u log ide audit marker:

```text
[BANK_PDF_DIAG] code=sparkasse type=date_snap raw='...' final='...'
```

Ako se slažu:

```text
[BANK_PDF_DIAG] code=sparkasse type=date_confirmed value='...'
```

Time datum dobija isti princip kao transakcijski računi: LLM daje strukturu, ali tekstualni sloj PDF-a je oracle za polje koje se može deterministički pročitati.

## Line date se pin-uje na statement date

Još jedan bitan detalj: svaka linija izvoda dobija isti datum kao statement. Bankovni izvod je dnevni dokument, a `account.bank.statement.date` u Odoo-u zna biti računat iz linija. Ako linije dobiju LLM-ove per-transaction datume, Odoo može vratiti statement na pogrešan datum čak i nakon što je parser korektno izvukao datum izvoda.

Zato update sada radi obrnuto:

- prvo se odredi `statement_date`,
- deterministic date hook može prepisati LLM datum,
- svaka `account.bank.statement.line.date` se kreira sa tim istim datumom.

Nema naknadnih "fix-up" write-ova. Datum je ispravan od trenutka kreiranja linije.

## Šta ovo znači za operatera

Praktična posljedica je jednostavna:

- klik na PDF u Odoo-u otvara originalni dokument banke,
- reprocess ne degradira kvalitet provjera,
- date greške kod Sparkasse izvoda se automatski ispravljaju iz PDF teksta,
- audit log jasno kaže kada je datum potvrđen ili snapnut,
- nema dodatnih cache kolona koje treba razumjeti, backfillovati ili čistiti.

Ovo vraća modul na čistiji princip: **originalni dokument je trajni izvor, LLM je pomoćni čitač, regex hookovi su deterministička druga linija odbrane**.

## Verzije

Relevantne verzije u ovoj iteraciji:

| Modul | Verzija | Promjena |
|---|---:|---|
| `l10n_ba_bank_pdf` | `16.0.1.36.0` | originalni PDF ostaje attachment, flat-PDF cache polja se uklanjaju, dodat je `_extract_ground_truth_date` hook |
| `l10n_ba_bank_pdf_sparkasse` | `16.0.1.7.0` | Sparkasse datum izvoda čita se kao prvi datum iz headera `Izvod broj ... od ... na dan ...` |
| `l10n_ba_bank_pdf_procredit` | `16.0.1.9.0` | prompt za pure-fee redove: naknada je jedna transakcija, ne dvije |
| `l10n_ba_bank_pdf_raiffeisen` | `16.0.1.9.0` | čišćenje starog balance-cache fallback-a nakon povratka na originalni PDF |

## Napomena

Generisano od strane Claude 🤖

---

Ernad Husremović, hernad@bring.out.ba
