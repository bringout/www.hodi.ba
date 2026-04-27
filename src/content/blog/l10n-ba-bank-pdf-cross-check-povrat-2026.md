---
title: 'Bosanska lokalizacija "Odoo" open-source platforme: Modul l10n_ba_bank_pdf — AI ekstrakcija mora imati determinističku drugu liniju odbrane'
description: 'Treći post o l10n_ba_bank_pdf modulu. Prvi je opisao vision-LLM mod za ProCredit i 60% manju storage potrošnju. Drugi je dodao subsekvenca-snap popravak kad LLM ispusti cifru iz dugog niza nula u 16-cifrenom računu. Ova iteracija ide korak dalje: ground-truth ekstrakcija postaje per-bank (default `r"/(\\d{16})"` regex je tiho odbijao PBS i ProCredit izvode), cross-check se pretvara u always-on klasifikaciju (confirmed / suspicious / snap / snap_long / unverifiable) sa strukturiranim WARNING markerom za audit, a POVRAT KREDITA red — gdje je vision LLM uporno halucinirao iznos zbog gustog overdraft footera — sad se rekonstruiše čisto matematički iz PDF-text-baziranog PRETHODNOG i NOVOG SALDA. Plus: Sparkasse OUR/inostrani fee-ovi dobiju vlastiti konto 5531, batch_test scenario kroz fetchmail+OCR pipe, i odgovor na pitanje koje često pada — "da li Odoo i dalje čuva originalni PDF kako je banka poslala".'
pubDate: '2026-04-27T17:30:00'
heroImage: '/bank-pdf-cross-check-hero.svg'
---

## Šta je bilo, šta je novo

Dva ranija posta:

- [`l10n-ba-bank-pdf-vision-procredit-2026`](/blog/l10n-ba-bank-pdf-vision-procredit-2026.md/) — uveo *vision-LLM mod* (rasterizovati svaku stranicu PDF-a u PNG @ 150 DPI, poslati i tekst i sliku LLM-u) jer ProCredit tekstualni stream nosi `5DþXQEURM` umjesto `Račun broj` (CRT/iReport stari font subseti bez ToUnicode CMap-a). Plus *flat image-only PDF* koji zamjenjuje originalni attachment u Odoo — **62% storage uštede** (1.28 MB → 487 KB).
- [`l10n-ba-bank-pdf-llm-digit-repair-2026`](/blog/l10n-ba-bank-pdf-llm-digit-repair-2026.md/) — pokazao da Qwen3-VL (i Claude, GPT-4o) tihi ispustaju jednu cifru iz duge sekvence nula u 16-cifrenom transakcijskom računu. Riješeno: regex `r"/(\d{16})"` nad PDF tekstom kao "ground-truth" set, pa subsekvenca-match snapuje 14- ili 15-cifrenu LLM grešku na jedinstvenog kandidata.

Ova iteracija — **`l10n_ba_bank_pdf 16.0.1.29.0`** — gradi tri sloja iznad toga.

## 1. Ground-truth ekstrakcija je sad **per-bank**

Otkrili smo da `r"/(\d{16})"` regex iz prethodnog posta **tiho ne radi** za pola banaka. Provjereno na sample PDF-ovima:

| Banka | Format own računa | Format partner računa | `r"/(\d{16})"` daje |
|---|---|---|---|
| **PBS** | `Račun: NNNN` | `Račun: NNNN` (uz `Nalog: NNNN` koji NIJE račun!) | **0 (slomljeno)** |
| **ProCredit** | `Račun broj: NNNN` | `... PARTNER NAME NNNN` (bez prefiksa) | **0 (slomljeno)** |
| **Raiffeisen** | `TRN: NNNN` | `/NNNN PARTNER` | 35 ✓ (ali bez TRN) |
| **Sparkasse** | `Broj transakcijskog računa: NNNN` | `/NNNNPARTNER` | 2 ✓ |

Drugim riječima: digit-repair mehanizam iz prošlog posta **nije nikad ni proradio** za PBS i ProCredit izvode — njihov ground-truth set je bio prazan, pa ni jedna LLM digit-drop greška nije mogla biti snapnuta.

Riješenje — extension hook na core `bank.pdf.statement.parser` modelu:

```python
def _extract_ground_truth_accounts(self, text):
    """Default: /-prefiksni 16-cifreni rezovi. Banke override-uju."""
    self.ensure_one()
    return set(re.findall(r"/(\d{16})", text))
```

Svaki bank-specifičan submodul override-uje sa svojim regex setom. Najtanji je PBS, koji **mora** isključiti `Nalog:` kandidate:

```python
# l10n_ba_bank_pdf_pbs
def _extract_ground_truth_accounts(self, text):
    if self.code == 'pbs':
        return set(re.findall(
            r"Ra[čc]un(?:\s+broj)?\s*:\s*(\d{16})", text
        ))
    return super()._extract_ground_truth_accounts(text)
```

ProCredit je naizgled najjednostavniji — bare-isolated 16-cifreni run jer u tekstu nema kompetitivnih 16-cifrenih polja:

```python
# l10n_ba_bank_pdf_procredit
return set(re.findall(r"(?<!\d)\d{16}(?!\d)", text))
```

Nakon ovih izmjena: PBS i ProCredit izvodi **sad** uspješno snapuju digit-drop greške kad ih LLM napravi.

## 2. Cross-check je sad always-on, ne samo za digit-drops

Prošli post je radio popravak **samo** kad LLM emituje 14 ili 15 cifara. Novi pristup: **svaki** partner_account (uključujući validne 16-cifrene) prolazi kroz isti deterministički gate.

Pet ishoda po stavki, snima se u `account_repairs` listu i u chatter:

| Tip | Uslov | Akcija | Audit |
|---|---|---|---|
| `confirmed` | 16 cifri **u** ground_truth | nepromijenjena | zbirna chatter linija |
| `suspicious` | 16 cifri **van** ground_truth | nepromijenjena (ali flag) | ⚠ chatter warning |
| `snap` | 14/15 cifri, jedinstven subseq match | snap | info note |
| `snap_long` | 17/18 cifri, jedinstven inverzni subseq | snap | info note |
| `unverifiable` | ground_truth prazan (reprocess flat PDF) | nepromijenjena | zbirna napomena |

Najvažniji od ovih je **`suspicious`**. To je tip greške koji *nikako* nije postojao u prošloj iteraciji modula: AI-emit-uje 16-cifreni broj sa validnom BiH bank-prefiksom (npr. `1610000537500039`), regex bi rekao "OK, 16 cifri" — i sve bi prošlo. Ali taj broj **nije nigdje u tekstualnom sloju PDF-a**. Realna pojava: računovođa otvori statement, vidi partner-account koji ne postoji u banci, pa traži šta se dogodilo.

Sad: `suspicious` zapis na chatter-u, ⚠ warning, operater zna da pogleda ručno.

Plus, strukturiran audit log marker (`_logger.warning`) koji ne pada u `ir.logging` (Odoo to ne piše iz worker-a) ali pada u `journalctl -u hodi-odoo-<instance>`:

```
[BANK_PDF_DIAG] code=raiffeisen type=snap raw='161000233580085' final='1610000233580085' (AI digit-drop repaired from PDF text ground truth) partner='PZU POLIKLINIKA …' amount=94.99
```

Test harness koji prati ingest izvode, čisto grep-uje ovaj marker iz systemd journala da bi sumirao šta se dogodilo u zadnjem batch-u — bez parsiranja chatter HTML-a.

## 3. POVRAT KREDITA: stvaran bug i pravi fix

Najinteresantnija tema. Raiffeisen daily PDF, na izvodu broj 14 (26.01.2026), saldo: **PRETHODNI 2,005.67 → NOVI 0.00**. AI je u Odoo emit-ovao `balance_end_real = 2,005.67`. **Zaglavljen.** I svi sledeći izvodi #15..#20 — kojih PDF jasno kaže `0.00 → 0.00` — Odoo prikazuje `2,005.67 / 2,005.67`. Saldo se *propagira pogrešno* kroz cijeli mjesec.

Dijagnoza je u prošlom postu o batch-test orijentaciji ali sažeto — **AI je prihvatio jedan transakcijski iznos pogrešno**, da bi cijela suma izvoda izašla na vrijednost koju je sam rekao za `balance_end_real`:

| PDF row | Opis | PDF iznos | AI iznos | Δ |
|---|---|---|---|---|
| #11 | `POVRAT KREDITA PO TRN-U DOZ PREKORACENJA` | **−2,592.96** | **−587.29** | +2,005.67 |

`587.29` se uopće ne pojavljuje u PDF tekstu. Čista LLM halucinacija — i to upravo onolika koliko bi balansirala saldo da je "novi saldo isti kao prethodni" (što AI emit-uje kad ne može pouzdano pročitati `NOVI SALDO: 0.00` polje, jer je ono okruženo overdraft footerom: `DOZVOLJENO PREKORACENJE / Raspolozivo: 98,147.95 / Iskoristeno: −1,852.05 / Kamata: 0.00`). Vision LLM se "zbuni" u tom regionu i uzme manje istaknut broj umjesto pravog `0.00`.

**Fix u dva koraka**:

a) Raiffeisen modul (`bank_pdf_parser_raiffeisen.py`) override-uje `_extract_statement_data` da regex-om iz PDF teksta izvuče **deterministički** PRETHODNI/NOVI SALDO. Tekstualni sloj je pouzdan za ova polja iako je AI vision nepouzdan:

```python
m_o = re.search(r'PRETHODNI\s+SALDO[:\s]+([\-0-9.,]+)', text, re.I)
m_c = re.search(r'NOVI\s+SALDO[:\s]+([\-0-9.,]+)',     text, re.I)
result['pdf_text_balance_start'] = _normalize(m_o.group(1))
result['pdf_text_balance_end']   = _normalize(m_c.group(1))
```

Ti se zatim cache-uju kao polja na `account.bank.statement` (`pdf_text_balance_start`, `pdf_text_balance_end`, `has_pdf_text_balance`) — bitno jer **flat image-only PDF zamjenjuje originalni attachment** (vidi sledeću sekciju), pa reprocess preko `action_reprocess_pdf` ne bi inače mogao ponovo pročitati saldo iz PDF teksta.

b) Post-extraction hook na Raiffeisen modulu uoči POVRAT KREDITA red i forsira mu iznos kao **arithmetic invariant**:

```python
povrat = statement.line_ids.filtered(
    lambda l: l.payment_ref and self.POVRAT_MARKER in l.payment_ref.upper()
)
if povrat:
    line = povrat[0]
    other_sum = sum((statement.line_ids - line).mapped('amount'))
    expected = (pdf_close - pdf_open) - other_sum
    line.amount = expected
    line.partner_id = False  # interna bankarska operacija — nema partnera
```

Zašto baš POVRAT KREDITA red? Jer je on *uvijek* "balansirajući" red dana — bez njega saldo dana se ne sklapa. Drugim riječima, AI mora biti tačan **na svim ostalim redovima** (i jest, vidjeli smo `snap` repair i `confirmed`-e na desetinama), a POVRAT smo namjerno prepustili matematici jer je njegova vrijednost **deduktivna**. Nije halucinacija — to je realna posljedica banke koja vraća overdraft kredit na klijentov TRN. Klijent **ima** taj transfer, banka **vidi** taj transfer, a iznos je nužan komplement svemu ostalom što se desilo tog dana.

Implementirano u `l10n_ba_bank_pdf_raiffeisen 16.0.1.8.0`.

## 4. Reconciliation modeli — "iz Pythona, ne XML-a"

Ranija arhitektura `l10n_ba_fbih_bank_data` je imala matching pravila u XML-u, a `line_ids` (write-off konto) i `match_journal_ids` (per-tenant linkovi) u `__init__.py` `_setup_bank_reconcile_models`. Refactor sa 1.14.0+ ujedinjuje — sve definicije u jednoj Python listi:

```python
RECONCILE_RULES = [
    { "xmlid": "reconcile_model_raiffeisen_overdraft",
      "name":  "Raiffeisen — Dozvoljeno prekoračenje",
      "match_label_param": r"DOZVOLJEN.*PREKORAC",
      "account_code": "4240", "parser_code": "raiffeisen",
      "partner_xmlid": "l10n_ba_fbih_bank_data.res_partner_raiffeisen_bank_sa", … },
    { "xmlid": "reconcile_model_raiffeisen_povrat",
      "match_label_param": "POVRAT KREDITA PO TRN-U DOZ PREKORACENJA",
      "account_code": "4240", … },
    { "xmlid": "reconcile_model_raiffeisen_provizija",
      "match_label_param": r"^PROVIZIJA\s+PO\s+POSLU",
      "account_code": "5530", … },
    { "xmlid": "reconcile_model_sparkasse_provizija",
      "match_label_param": "PROVIZIJA- PRENOS SREDSTAVA",
      "account_code": "5530", … },
    { "xmlid": "reconcile_model_sparkasse_our_troskovi",
      "match_label_param": "OUR TROSKOVI PO PLACANJU -",
      "account_code": "5531", … },
    { "xmlid": "reconcile_model_sparkasse_provizija_nalog",
      "match_label_param": "PROVIZIJA PO NALOGU-",
      "account_code": "5531", … },
    { "xmlid": "reconcile_model_procredit_provizija",
      "match_label_param": r"(?i)provizija\s*$",
      "account_code": "5530", "parser_code": "procredit", … },
]
```

`_setup_bank_reconcile_models` jednom prolazi: pronađe ili kreira `account.reconcile.model` zapis (registruje `ir.model.data` xmlid), poveže per-company `line_ids` na pravom kontu, prikači rule na svaki bank journal čiji `bank_pdf_parser_id.code` odgovara `parser_code`-u. Idempotentno.

## 5. Novi konto 5531 — `Troškovi platnog prometa inostranstvo`

FBiH chart of accounts ranije je imao samo grupacioni `553` (Troškovi platnog prometa), koji se pri instalaciji template-a sa `code_digits=4` rendiše kao **5530**. Sve domaće provizije (`PROVIZIJA PO POSLU`, `PROVIZIJA- PRENOS SREDSTAVA`) klasifikovale su se na 5530.

Sa Sparkasse-ovih izvoda smo identifikovali distinktne fee-ove za inostrana plaćanja:

- `OUR TROSKOVI PO PLACANJU -` — naknada banaka-korespodenata na izlaznim međunarodnim transferima
- `PROVIZIJA PO NALOGU-` — domaća provizija banke na izlazni nalog za inostranstvo

Oba zaslužuju vlastiti konto. `l10n_ba_fbih_data 16.0.1.2.0` dodaje `account.account.template` `ba_fbih_5531` (4-cifreni code, expense). Post-migrate hook back-fill-uje konto na svaku company koja je već instalirala FBiH chart, sa kanoničkim `<company_id>_ba_fbih_5531` ir.model.data xmlid-om — tako da druge module (kao l10n_ba_fbih_bank_data 1.16.0) mogu da `env.ref` u njega.

## Q&A: Da li se originalni PDF i dalje čuva netaknut?

Često pitanje, jer fix iz prvog posta (flat image-only PDF u Odoo attachment-u) je trade-off između storage uštede i preserve-ovanja teksta.

**Kratak odgovor**: Original PDF se **NE** čuva u Odoo `ir.attachment`. Original PDF **JESTE** sačuvan u Stalwart eml store-u kao audit trail. Za ProCredit-class izvode (visioni mod), Odoo prilog je flat-rendered slika u PDF kontejneru.

Detaljnije:

- Email koji banka pošalje (`.eml` sa originalnim PDF-om kao MIME attachment-om) se trajno čuva u **Stalwart-u na node61** — to je primarni audit trail. Adminstrator ima pristup originalnom PDF-u svakog izvoda preko IMAP/Roundcube.
- Tokom `account.journal.message_new` flow-a, PDF se izvuče iz emaila i kreira se `ir.attachment` na novom `account.bank.statement`. **Tu** se događa flat replacement: ako je `parser.use_vision = True` (što je sada postavljeno za sve banke uključujući PBS, ProCredit, Raiffeisen, Sparkasse zbog ProCredit-class font subset problema), original PDF u attachment-u se zamjenjuje sa flat image-only PDF-om — istom slikom koju je vision LLM zaista parsirao.
- **Zašto**: ProCredit ugrađuje 4 font subseta po PDF-u (~400 KB svaki), dok flat image @ 150 DPI ima ~150 KB. Ušteda je realna, dokumentovana je u prvom postu, i original je dostupan u eml store-u.
- **Posljedica**: ako neko klikne "open PDF" na `account.bank.statement` u Odoo-u, vidi flat sliku — istu koju je AI zaista vidio. To je *namjerno* — ako AI pogriješi, operater pogleda istu sliku koju je AI gledao, ne neki drugi rendering.

Bitno je razumjeti da **ova iteracija ne mijenja ovaj mehanizam**. Ono što je dodato:

1. Pre-flat-replace-a, modul izvuče **PRETHODNI/NOVI SALDO** iz PDF tekstualnog sloja (regex) i sačuva kao polja na statement-u (`pdf_text_balance_start`, `pdf_text_balance_end`, `has_pdf_text_balance`). Tako reprocess (preko `action_reprocess_pdf`) ima i dalje pristup tom signalu, čak i kad attachment više nema tekst.

2. **Isto i za ground-truth set 16-cifrenih partner-računa** (uvedeno u 1.29.0). Polje `pdf_text_ground_truth_accounts` (Char, CSV-encoded list) se popunjava pri prvom importu iz originalnog PDF text-a kroz bank-specifičan `_extract_ground_truth_accounts`. Pri reprocess-u, kada `_extract_statement_data` dobije kao argument postojeći statement i regex nad flat-PDF-om vrati prazan set, fallback čita keširani CSV. `data` dict koji parser vraća uključuje `ground_truth_source = "pdf-text" | "cached"` da `_update_statement_from_data` ne prepiše stvarni keš degradiranim "round-trip"-om.

Sa ovom izmjenom — reprocess statementa sa novim modulom radi cross-check pravilno: 16-cifre AI brojeva se i dalje klasifikuju kao `confirmed`/`suspicious`/`snap`, a ne kao bezvrijedan `unverifiable`. Bez nje, reprocess bi bio "tihi degrade" — prošao, ali bez audit-a.

Stari statementi (importovani prije 1.29.0) nemaju keš. Postoji opciono backfill: skripta koja prošeta statemente bez keš-a, učita original eml iz Stalwart audit trail-a (ili iz `input/banke-izvodi-test/<bank>/` ako je test instanca), `pdftotext` + bank-specifičan regex, upiše polje. Trenutno nije commitovana — radi se po potrebi.

## 6. Test infrastruktura

Ovaj rad nije realno bio moguć bez automatskog test bench-a. U profilu `profile/hetzner/scripts/`:

- **`hodi_odoo_db_backup.py`** — `pg_dump --format=custom` preko SSH tunela kroz hetzner-1 ka Patroni VIP-u, plus `rsync` filestore-a sa hodi-1, plus `meta.yaml` sa snapshot-om instalisanih modula i njihovim verzijama. Output u `profile/hetzner/backup/<instance>/`. Snapshot-i se koriste za A/B poređenje kako se kod modula mijenja.
- **`hodi_odoo_db_restore.py`** — inverzno: stop service, drop/create DB preko Patroni VIP-a, `pg_restore`, rsync filestore. Sa `--force-cross-instance` flag-om može da seeduje sister instancu (npr. `radix-banke-izvodi-test`) iz `banke-izvodi-test` snapshot-a.
- **`hodi_odoo_db_fix_after_cross_restore.py`** — codifies sve domain-flips koji su potrebni nakon cross-instance restore-a: emails na `res.users`, `res.partner`, `account.journal.bank_pdf_import_email`, `fetchmail.server`, `web.base.url` (+ freeze), Authelia OIDC `client_id` na `auth.oauth.provider`. Idempotentno.
- **`hodi_odoo_banke_izvodi_batch_test.py`** — šalje email batch (10 po default-u), čeka fetchmail+OCR, walk-uje svaki kreirani statement: `pdftotext` original eml-a iz manifest-a (jer flat-PDF u Odoo nema teksta), regex PRETHODNI/NOVI SALDO + per-row "Na teret/U korist" amount-i, poredi sa `account.bank.statement.balance_*` i `account.bank.statement.line.amount`. Stane na **prvom break-u** — operater vidi PDF row koji se razilazi, zna gdje je AI promašio. Sa `--reprocess-from <SEQ>` može pozvati `action_reprocess_pdf` na statementima posle module-fix-a, bez ponovnog slanja maila. Match po `Izvod broj N` umjesto manifest-seq, pa duplikati iz dva kanala (`RADIX_…` i `inforbbh@…` isporučuju isti PDF) prolaze transparentno (Odoo ih dedupe-uje na hash, batch_test ih ne broji dva puta).
- **`hodi_odoo_banke_izvodi_send.py`** — sa retry-on-rate-limit logikom: Stalwart-ova submission relay throttle 4.4.5 ne resetuje se na istoj autentikovanoj sesiji, pa send.py zatvara konekciju, čeka 60s, otvori novu konekciju i nastavi.
- **`hodi_stalwart_throttle.py`** — admin API helper. `get` radi (read live throttle keys), `set-test`/`reset` su parking jer Stalwart 0.15.5 admin API write payload shape nije javno dokumentovan; runtime change kroz NixOS rebuild radi i to je trenutno glavni put.

## Verzije modula koje uvodi ovaj rad

| Modul | Verzija |
|---|---|
| `l10n_ba_bank_pdf` | **16.0.1.29.0** — extension hooks, cross-check, [BANK_PDF_DIAG] log, ground-truth + balance keš za reprocess |
| `l10n_ba_bank_pdf_pbs` | **16.0.1.2.0** — `Račun:` regex, ekskluzivira `Nalog:` |
| `l10n_ba_bank_pdf_procredit` | **16.0.1.6.0** — bare-isolated regex |
| `l10n_ba_bank_pdf_raiffeisen` | **16.0.1.8.0** — `/-prefix + TRN:` ground-truth, PRETHODNI/NOVI SALDO regex, POVRAT fix |
| `l10n_ba_bank_pdf_sparkasse` | **16.0.1.4.0** — `/-prefix + Broj transakcijskog računa:` |
| `l10n_ba_fbih_data` | **16.0.1.2.0** — novi 5531 konto + post-migrate backfill |
| `l10n_ba_fbih_bank_data` | **16.0.1.16.0** — pure-Python reconcile rules, POVRAT, Sparkasse OUR/nalog, ProCredit Provizija |

## Šta dalje

- One-shot backfill skripta koja popuni `pdf_text_ground_truth_accounts` na statementima importovanim prije 1.29.0 — čita original eml iz audit trail-a, `pdftotext` + bank-specifičan regex, piše u polje. Trenutno se taj keš puni samo za nove importe.
- Stalwart admin API write shape: ako neko nađe javnu dokumentaciju 0.15.x ili krene od source-a, helper skripta dobiva `set-test`/`reset` subkomande — i mašine za batch test više ne moraju kompajlirati Rust paket pri svakoj promjeni throttle-a.
- Per-bank transaction-row regex za PBS, ProCredit, Sparkasse — trenutno je samo Raiffeisen full row-by-row diff u `batch_test`-u.

## Napomena

Generisano od strane Claude 🤖

---

Ernad Husremović, hernad@bring.out.ba
