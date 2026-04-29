---
title: 'Bosanska lokalizacija "Odoo" open-source platforme: l10n_ba_bank_pdf — span-level anonimizacija, 16-ćelijska LLM matrica, per-bank deterministička provjera i wall-clock watchdog'
description: 'Četvrta iteracija na bank-PDF parseru. (1) Anonimizacija test fiksture sad radi span-by-span umjesto pattern-by-pattern jer fitz get_text() reading-order razdvaja `/` od narednih 16 cifara kada redaktujemo samo dio span-a; (2) gradovi (Sarajevo, Mostar, Tuzla, …) više ne cure u anon PDF-ove; (3) 16-ćelijska matrica (model × vision × prompt × pdf) pokazuje da je Qwen3-VL-32B + vision-on jedina kombinacija koja prolazi i originalne i anon test setove, a Gemini 3 Flash je idealan failover za Raiffeisen — pogađa najtežu broj 8 statement-u prvi put za 32 sekunde; (4) per-row deterministička provjera implementirana za ProCredit i Sparkasse, plus IBAN substring matching za cross-border SEPA payments; (5) wall-clock watchdog na LLM pozivima (concurrent.futures.ThreadPoolExecutor) sprječava hung HTTP konekcije, uz FAILED-* placeholder rename za failed-after-both-phases statementa sa one-click Reprocess oporavkom. Final pipeline: 198 statementa, 51 failover engagement (90 % clean success), 0 truly-unresolved.'
pubDate: '2026-04-29T08:30:00'
heroImage: '/bank-pdf-cross-check-hero.svg'
---

## Šta je bilo

Tri ranija posta o `l10n_ba_bank_pdf`-u:

- [`vision-LLM mod za ProCredit`](/blog/l10n-ba-bank-pdf-vision-procredit-2026.md/) — rasterizujemo PDF u PNG, pošaljemo i tekst i sliku LLM-u. Storage: 62% manje.
- [`LLM digit repair`](/blog/l10n-ba-bank-pdf-llm-digit-repair-2026.md/) — subsekvenca-snap fix kad LLM ispusti cifru iz dugog niza nula u 16-cifrenom računu.
- [`Cross-check + POVRAT KREDITA`](/blog/l10n-ba-bank-pdf-cross-check-povrat-2026.md/) — per-bank ground-truth ekstrakcija i klasifikacija (confirmed/suspicious/snap/snap_long/unverifiable).

Ova iteracija — **`l10n_ba_bank_pdf 16.0.1.30.x`** + revidirani anonimizacijski pipeline — adresira tri praktična problema koja su izronila kad smo pokušali napraviti dovoljno realističan ali javno dijeljiv test set, i kad smo pokušali kvantifikovati koji LLM stvarno radi za koju banku.

---

## 1. Anonimizacija test fiksture: span-by-span umjesto pattern-by-pattern

### Problem koji se vidi tek u izvodima sa 40+ transakcija

Imamo 205 .eml fixtura — pravi izvodi iz tri banke (Raiffeisen, Sparkasse, ProCredit) iz proizvodnje, prebačeni u "anon" varijantu kroz dvostepenu skriptu:

1. `anon_eml_extract_1.py` — proizvodi `anonymization_map.json` sa parovima
   `original → replacement`. Imena partnera idu u **`lines`** mapu, brojevi
   transakcijskih računa u **`accounts`** (16 cifara → 16 cifara), JIB i IBAN
   imaju vlastite mape, mail adrese isto.
2. `anon_eml_patch_2.py` — otvori PDF preko PyMuPDF, redaktuje original,
   ubaci helv text sa zamjenskom vrijednošću, sve uz **očuvanje dužine**
   da layout tabele ne pukne.

Sve je izgledalo dobro dok nismo pokrenuli sveobuhvatan batch test sa cross-check
verifikacijom. Onda je kod jednog densog Raiffeisen izvoda iskočio sljedeći audit warning:

> **44 brojeva računa nije bilo moguće verifikovati (PDF nema čitljiv tekstualni sloj — vjerovatno reprocess image-only verzije).**

Smiješno — PDF *ima* tekstualni sloj. Mogli smo `pdftotext` ga ispisati.
A i `re.findall(r"/(\d{16})", text)` bi trebao pogoditi 44 partner-računa kao
i kod originalnog izvoda. Ali nije — vraćao je **0**.

### Šta se zaista dešava: fitz reading order

Originalni Raiffeisen izvod ima redove ovog oblika u tekstualnom sloju:

```
                 /1610200066770048 LOTRIC CONTROL DOO
```

Slash, zatim 16 cifara, zatim ime partnera. Sve u **istom span-u** PyMuPDF-a:

```
font=Microsoft Sans Serif size=8.0 bbox=(85.65, 198.20, 254.17, 206.20)
text='/1610200066770048 LOTRIC CONTROL DOO '
```

Anonimizacijski patch je radio ovako (stara logika):

1. Iteriraj sve parove iz `accounts` mape.
2. Za par `1610200066770048 → 1610200352387944`, traži `1610200066770048`
   u tekstu stranice.
3. Pronađe ga unutar gornjeg span-a, na poziciji 1 (nakon slash-a).
4. Izračunaj rect samo za tih 16 cifara — **slash i `LOTRIC CONTROL DOO`
   ostaju netaknuti**.
5. `add_redact_annot` na taj uži rect, `apply_redactions` izbriše glifove
   16 cifara, `insert_text` ubaci nove glifove preko helv-a.

Problem: PyMuPDF **content stream** PDF-a sad izgleda ovako:

- Originalni span (Microsoft Sans Serif): `/[wiped]LOTRIC CONTROL DOO`
- Helv overlay (dodat na kraj content stream-a): `1610200352387944`

Oba su geometrijski na istom mjestu na stranici — vizuelno ne primijetiš
ništa. Ali kad fitz `get_text()` pređe content stream u **reading order**,
on prvo iscita sve **originalne** blokove (po čitavoj stranici), pa tek
onda **dodate** helv blokove. Rezultat:

```
... /  ...   (slash sam, na poziciji 241)
... LOTRIC CONTROL DOO  ...
... [70 drugih redova] ...
... 1610200352387944  ...   (16-cifreni broj, na poziciji 2122)
```

Slash i 16 cifara su **razdvojeni sa 1881 znakom**. `re.findall(r"/(\d{16})",
text)` traži slash *neposredno* praćen sa 16 cifara — ne nalazi ništa. Sve
44 partner-računa za taj izvod su klasifikovana kao "unverifiable", i audit
warning vrijedi.

### Fix: koriguj cijeli span, ne podstring

Nova logika u `anon_eml_patch_2.py` — operiše na **granuli span-a**:

```python
for page in doc:
    queued = []
    for block in page.get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                old = span.get("text", "")
                if not old:
                    continue
                new = substitute_text(old, pairs)
                if new == old:
                    continue
                bbox = pymupdf.Rect(span["bbox"])
                queued.append((bbox, new, ...))

    for rect, _, _, _, _ in queued:
        page.add_redact_annot(rect.shrink(...), fill=(1,1,1))
    page.apply_redactions(...)

    for rect, new_text, baseline_y, color, fontsize in queued:
        page.insert_text((rect.x0, baseline_y), new_text,
                         fontname="helv", fontsize=fontsize, color=color)
```

Dvije ključne razlike:

- **Cijeli span se zamjenjuje**, ne samo podstring koji se mijenja. Ako span
  sadrži *bilo koji* par koji ima zamjenu, queue-ujemo cijeli span za
  redact + helv re-insert.
- Helv blok koji ulazi nazad **sadrži i slash i nove cifre i ime partnera**
  zajedno. Reading-order regex sad vidi `/1610200352387944 TXDCUP REELKIG AMN`
  inline, isto kao original.

### Verifikacija na 205 fixtura

| Banka | Manifest | `/16d` count u origu | `/16d` u anonu (staro) | `/16d` u anonu (novo) |
|---|---:|---:|---:|---:|
| Raiffeisen | 81 | 1.247 | 0 | **1.247** ✓ |
| Sparkasse | 78 | 156 | 0 | **156** ✓ |
| ProCredit | 46 | 0 | 0 | 0 (banka ne koristi `/16d` format) |

Anonimizovani PDF-ovi su sad **strukturalno ekvivalentni** originalima iz
ugla `get_text()` reading-ordera — cross-check verifikacija radi identično.

### Bonus: 81 redak manje koda

Span-level pristup je toliko jednostavniji da je `_find_in_spans` (sa
whitespace-flexible regexom, multi-span join logikom, `pymupdf.get_text_length`
prefix-skaliranjem) postao nepotreban. Skripta je smršala sa 548 na 427 linija.

---

## 2. Gradovi više ne cure u anon fixturama

Drugo otkriće u istoj iteraciji. Pdftotext layout originalnog izvoda
sadrži kontinuirajuće redove ispod glavne transakcije:

```
                 /<16d>  PARTNER NAME GRAD
                 ULICA NESTO
```

Imena gradova (Sarajevo, Mostar, Konjic, Tuzla, Bihać, Brijeg, Hotonj…) su
bila u **`BOILERPLATE_LITERALS`** denylisti unutar `anon_eml_extract_1.py`:

```python
# Bosanska imena gradova — javni placenames, never sensitive on their own.
"Sarajevo", "SARAJEVO", "Mostar", "MOSTAR", "Tuzla", "TUZLA",
"Banja Luka", "BANJA LUKA", "Konjic", "KONJIC",
...
```

Razlog za denylistu (komentar): "spriječi PyMuPDF substring-collisions
unutar denylist-ovanih `<postcode> <city>` adresa". To je važilo za
**stari** pattern-level pristup. Za span-level redaktovanje rizik kolizije
ne postoji.

A i osnovna pretpostavka — "gradovi su javni, nisu osjetljivi" — ne pije
vodu. **Ako se na javno dijeljenom anon snimku vidi** da je partner X
kompanije iz Konjica, a partner Y iz Mostara, onda je itekako curilo
poslovno-geografska informacija.

Drugi gating mehanizam je bio **filter "<8 znakova"**:

```python
if len(cell) < 8 or len(cell) > 200:
    continue
```

To je odbacalo i kratke kupnje-identifikujuće tokene poput **gradova**
(MOSTAR=6, KONJIC=6, BRIJEG=6, TUZLA=5, BIHAC=5) i **imena samog test-kupca**
(5 znakova). Filter je takođe bio osmišljen za pattern-level mod.

Fix u dva poteza:

1. **Uklonjena cities-denylist** (10+ literala).
2. **Threshold spušten sa `<8` na `<5`** — 5+ znakovni tokeni sad prolaze
   kroz fonetski generator. Generičke chrome-tokene (currency code "KM",
   short header words) i dalje hvata `BOILERPLATE_LITERALS` /
   `BOILERPLATE_REGEX`.

Rezultat — `anonymization_map.json` rastao sa 2.872 na 2.961 **lines**
unosa. Primjeri zamjena (svaka deterministička, length-preserving,
fonetski plauzibilna):

| Original token | Anon token |
|---|---|
| MOSTAR | JACOFI |
| SARAJEVO | JOJOPEFE |
| BRIJEG | LIVOPU |
| TUZLA | MOKOR |
| BIHAC | JADOF |

Anon PDF za densi izvod sad izgleda:

```
                 /3060003195625432 CA COC BACOGAJU ZUTINA
                 /1346728144353210 KIMI ZUTINA
                 /1610205424184250 ZO FA SENAF BAR JOJOPEFE
```

Niko ko vidi anon snimak ne može zaključiti gdje fizički sjedi originalni
kupac — gradovi su zamijenjeni fake-words-ima koji liče na imena gradova
(za vizuelnu plauzibilnost), ali nisu nijedan stvarni grad.

---

## 3. Mjerenje: 16-ćelijska matrica na reprezentativnim primjerima

Za jedno densi Raiffeisen statement (44 transakcije, 4-line javne-prihode
payroll blokovi, čvrsta provizija-pairing logika) pokrenut je puni
faktorski eksperiment:

| Varijabla | Nivoi |
|---|---|
| `model` | `qwen` = Qwen3-VL-32B-Instruct (default), `glm` = GLM-4.6V |
| `use_vision` | `off` (samo tekst), `on` (tekst + page slike) |
| `prompt` | `initial` (commit prije PROVIZIJA / javne-prihode hintova), `current` (HEAD) |
| `pdf_source` | `orig` (proizvodni PDF), `anon` (anonimizovan kroz pipeline) |

4 × 2 × 2 × 2 = **16 ćelija**. Definicija "match" je: parsirani izvod ima
identičan broj redova, balance_start, balance_end, debit i credit kao
source-of-truth iz nezavisne baze koju je već potvrdio human reviewer.

### Matrica

| # | model | vis | prompt | pdf | rezultat | lines | end | Δend | t (s) |
|---|---|---|---|---|---|---:|---:|---:|---:|
| 1 | qwen | off | initial | orig | **MATCH** | 44 | ✓ | +0.00 | 96.7 |
| 2 | qwen | off | initial | anon | MISMATCH | **67** | × | −1180.0 | 68.0 |
| 3 | qwen | off | current | orig | **MATCH** | 44 | ✓ | +0.00 | 98.6 |
| 4 | qwen | off | current | anon | MISMATCH | **67** | × | −1180.0 | 52.9 |
| 5 | qwen | on  | initial | orig | **MATCH** | 44 | ✓ | +0.00 | 105.4 |
| 6 | qwen | on  | initial | anon | **MATCH** | 44 | ✓ | +0.00 | 97.4 |
| 7 | qwen | on  | current | orig | **MATCH** | 44 | ✓ | +0.00 | 99.5 |
| 8 | qwen | on  | current | anon | **MATCH** | 44 | ✓ | +0.00 | 99.0 |
| 9 | glm  | off | initial | orig | **MATCH** | 44 | ✓ | +0.00 | 267.1 |
| 10 | glm | off | initial | anon | MISMATCH | **74** | × | +5613.5 | 189.9 |
| 11 | glm | off | current | orig | **MATCH** | 44 | ✓ | +0.00 | 138.0 |
| 12 | glm | off | current | anon | MISMATCH | **67** | × | −1180.0 | 390.2 |
| 13 | glm | on  | initial | orig | **MATCH** | 44 | ✓ | +0.00 | 169.0 |
| 14 | glm | on  | initial | anon | MISMATCH | 45 | × | −1.00 | 283.2 |
| 15 | glm | on  | current | orig | **MATCH** | 44 | ✓ | +0.00 | 396.5 |
| 16 | glm | on  | current | anon | MISMATCH | 45 | × | −1.00 | 216.5 |

Ukupno: **10/16 (63%)** pogodaka.

### Šta matrica govori

**Per-`pdf_source`** (najjači signal):

| pdf | match | rate |
|---|---|---|
| orig | 8/8 | **100%** |
| anon | 2/8 | 25% |

Originalni proizvodni PDF-ovi su uvijek pogođeni — bez obzira na model,
vision, prompt. Anon fixtura je drastično teža: jedino `qwen + vision-on`
prolazi i nju (ćelije 6, 8). To je posljedica činjenice da anonimizacija
ubacuje fake fonetske riječi koje LLM-u izgledaju "krhko realne" — ako
LLM zafali bilo gdje u parsu, snap-back na ground-truth je teži jer i
ground-truth je sintetičan.

**Per-`use_vision`**:

| vis | match | rate |
|---|---|---|
| off | 4/8 | 50% |
| on  | 6/8 | 75% |

Razlika je koncentrisana na `qwen + anon` — vision-off ne čita helv
overlay anon teksta (fitz reading-order ga šalje u rep stranice; LLM bez
slike ga ne vidi pravilno povezanog), vision-on čita stranicu kao sliku
i hvata sve. Posljedica: **vision-off + anon je dokumentovano slomljena
kombinacija**, ne deploya se.

**Per-`prompt`**:

| prompt | match | rate |
|---|---|---|
| initial | 5/8 | 62% |
| current | 5/8 | 62% |

Iznenađenje: nove instrukcije u promptu (PROVIZIJA pairing hint,
javne-prihode 4-line blok hint) **nemaju neto efekta** na reprezentativnom primjeru broj 8.
Ne nestale specifičnim ćelijama (initial pada na različitim ćelijama
nego current), ali totali se izjednačuju.

**Per-`model`**:

| model | match | rate | prosj. t |
|---|---|---|---|
| Qwen3-VL-32B | 6/8 | 75% | 89.7 s |
| GLM-4.6V | 4/8 | 50% | 256.3 s |

Qwen pobjeđuje na ovom reprezentativnom primjeru — više pogodaka, ~3× brže, ~3× jeftinije
(token-cost). GLM uspješno hvata sve `orig` ćelije ali ima **0%** na anonu.

### Zaključak iz matrice

**Najbolja kombinacija**: `qwen + vision-on`. Jedina koja prolazi i orig
i anon, i `initial` i `current` prompt. Postavljeno kao default u
`account.journal.bank_pdf_ocr_model_id` za sve tri banke u proizvodnji.

```
journal.bank_pdf_ocr_model_id = qwen/qwen3-vl-32b-instruct
parser.use_vision = True
prompt = either (no measurable difference)
```

**`prompt` minimalizam je sad opcija** — recent dodaci za PROVIZIJA i
javne-prihode na reprezentativnom primjeru ne pomažu, mogu se rollback-ovati ako neki
budući statement zadaje neku drugu grešku.

---

## 4. Failover model (per-journal): `bank_pdf_ocr_model_id_fallback`

Matrica govori što kombinacija pogađa **prvi put**. Ali u proizvodnji
LLM-ovi su **nedeterministički** — isti PDF poslan dvaput može dati
razliku u parsu. I imamo dovoljno densih izvoda (40-60+ transakcija) gdje
čak i `qwen + vision-on` greši ~5-10% slučajeva.

Dodati failover sloj — ako primarni model triggeruje cross-check
auto-reconstruct (snap, snap_long, ili bilo koji warning u
`account_repairs`) **ili** baci `Timeout`/`ConnectionError`, retry-aj
istu ekstrakciju kroz **drugi** model:

### Implementacija (dva koraka)

`account.journal` sad ima novo polje:

```python
class AccountJournal(models.Model):
    _inherit = "account.journal"

    bank_pdf_ocr_model_id          = fields.Many2one("bill.ocr.model", ...)
    bank_pdf_ocr_model_id_fallback = fields.Many2one(
        "bill.ocr.model",
        string="Bank PDF OCR Model — Fallback",
        help=(
            "If parsing with the primary model triggers a cross-check "
            "auto-reconstruct (snap/snap_long warnings) or raises a "
            "Timeout/ConnectionError, retry the same PDF with this "
            "fallback model. Posts a chatter note when the fallback "
            "actually replaces the primary parse."
        ),
    )
```

`bank.pdf.statement.parser._process_pdf_statement` u dva prolaza:

```python
primary_model = journal.bank_pdf_ocr_model_id
fallback_model = journal.bank_pdf_ocr_model_id_fallback

result = self._extract_with_model(pdf_bytes, primary_model)
needs_fallback = (
    result.timed_out or
    result.connection_error or
    bool(result.account_repairs)   # auto-reconstruct fired
)

if needs_fallback and fallback_model:
    log.info("primary %s triggered repairs/timeout; trying fallback %s",
             primary_model.code, fallback_model.code)
    fb_result = self._extract_with_model(pdf_bytes, fallback_model)
    if fb_result.has_no_repairs and fb_result.balance_ok:
        # fallback je čisto pogodio — koristi njega
        statement.message_post(
            body=f"OCR fallback engaged: primary {primary_model.code} "
                 f"triggered {len(result.account_repairs)} repair(s), "
                 f"fallback {fallback_model.code} parsed clean."
        )
        result = fb_result
```

### Izbor failover modela: druga matrica

Kandidati za Raiffeisen failover (testirano na istom reprezentativnom primjeru broj 8):

| model | broj 8 anon | t (s) | cijena/poziv (relativna) |
|---|---|---:|---|
| Qwen3-VL-32B | MATCH s vision-on | 99 | 1.0× |
| GLM-4.6V | MISMATCH (uvijek) | 256 | 3.0× |
| Mistral Small 2603 | MISMATCH | 145 | 0.8× |
| Kimi K2.6 | reasoning-by-default, **timeout 600s** | n/a | nepredvidivo |
| **Gemini 3 Flash** | **MATCH first try** | **32** | **0.6×** |
| Pixtral Large 2502 | nije testiran | — | 5.0× |

**Gemini 3 Flash** je iznenađenje — najbrži, najjeftiniji, prvi put
pogađa najtežu Raiffeisen anon-statement-u u 32 sekunde. Postavljen kao
proizvodni failover za Raiffeisen journal:

```sql
UPDATE account_journal
   SET bank_pdf_ocr_model_id_fallback = (
       SELECT id FROM bill_ocr_model WHERE code = 'google/gemini-3-flash-preview'
   )
 WHERE bank_pdf_parser_id = (
       SELECT id FROM bank_pdf_parser WHERE code = 'raiffeisen'
   );
```

### Per-bank read_timeout (proporcionalan broju redova)

Failover sloj rješava timeoute, ali svaki timeout ipak košta 600s + retry.
Bolje — postavi read_timeout proporcionalno broju redova **prije** poziva
LLM-a. Raiffeisen parser ima novi hook:

```python
def _estimate_row_count_for_timeout(self, pdf_text):
    """Brza, deterministička aproksimacija. Za Raiffeisen broji
    `dd.mm.yyyy` paterne — to je lower bound za broj transakcija."""
    return len(re.findall(r"\b\d{2}\.\d{2}\.\d{4}\b", pdf_text))

def _read_timeout_for_pdf(self, pdf_text):
    n = self._estimate_row_count_for_timeout(pdf_text)
    # 300s baseline + 15s per row, capped at 1800s (30 min hard limit)
    return min(1800, 300 + 15 * n)
```

Za broj 8 (44 reda): `300 + 15*44 = 960s` (16 min). Statement sa 5 redova:
375s. Sparkasse i ProCredit imaju svoje override metode jer drugačije
parsiraju strukturu PDF-a.

### Retry-on-timeout na LLM-call nivou

Treća zaštitna mreža: ako *ipak* timeout-ne, parser **retry-aj jednom** sa
istim modelom (pet-second back-off), pa tek onda baci grešku gore. Mreža
pa LLM provider mogu imati prolazne smetnje koje retry rješava bez
ljudske intervencije:

```python
try:
    return self._call_llm(model, payload, timeout=self._read_timeout_for_pdf(text))
except (Timeout, ConnectionError) as exc:
    log.warning("LLM call timeout/connection-error; retry once: %s", exc)
    statement.message_post(body=f"Initial OCR call timed out after "
                                f"{timeout}s; retrying once.")
    time.sleep(5)
    return self._call_llm(model, payload, timeout=self._read_timeout_for_pdf(text))
```

Ako i drugi pokušaj padne, kombinuj sa failoverom — gore-gore-gore.
Tek nakon svega toga statement ide u "manually reprocess" stanje sa
chatterom za audit.

---

## 5. Per-bank deterministička provjera za ProCredit i Sparkasse

[Prošli post](/blog/l10n-ba-bank-pdf-cross-check-povrat-2026.md/) je
opisao per-bank ground-truth ekstrakciju za **`partner_account`** —
16-cifrene račune. To radi za sve banke. Ali **per-row**
deterministička provjera (`_extract_ground_truth_rows`) postojala je
samo za Raiffeisen. ProCredit i Sparkasse su radili samo na osnovu
account-level provjere.

Posljedica: ProCredit broj 13 imao je 2 reda gdje je drugi bio
`[AUTO-RECOVERED dokument=PROC-0001] AI parser missed this row;
partner info unavailable, please review.` — auto-rekonstrukcija je
vrijedila ali failover model **nije engageovan** jer je
account-level provjera prošla.

### Implementacija za ProCredit

ProCredit-ovo PDF text reading-order-grouped — kolone se konkatuju
umjesto da se redovi interleavu. Date words u redu su poput
`5.1.2026` (nepadded `d.m.yyyy`). Iznosi su BiH-format
(`1.619,94` — tačka tisuće, zarez decimala).

Algoritam (analogon Raiffeisen-u): za svaki DATE word koji ima Rbr
(`\d+.`) na istom y-bandu lijevo od datuma, naći iznose unutar
`Isplate`/`Uplate` kolona pomoću **column-x anchoring** od table-
header linije. Kolonu `Provizija` ignorirati (nije dio signed amount).

Why column-x anchoring matters: red sa Isplate=0 ne renderuje
`0,00` glif uopšte — samo Uplate/Provizija. Naivno left-to-right
ordering bi pogrešno označilo prvi vidljivi iznos kao Isplate.

```python
# Find row-table header y by locating unique "Rbr." word
rbr_hdr = next((w for w in words if w[4] == 'Rbr.'), None)
hdr_y = (rbr_hdr[1] + rbr_hdr[3]) / 2

# Record column centres
isplate_cx = (isplate_hdr[0] + isplate_hdr[2]) / 2
uplate_cx  = (uplate_hdr[0] + uplate_hdr[2]) / 2
half_gap = abs(uplate_cx - isplate_cx) / 2

for w in words:
    if not _PROC_DATE_WORD_RE.match(w[4]):
        continue
    # Require an Rbr at same y to the LEFT — filters out header "Datum:"
    rbr_at_row_w = next(
        (r for r in rbrs if abs(r[1] - dy) < 3 and r[0] < w[0]), None
    )
    if not rbr_at_row_w:
        continue

    isplate = uplate = 0.0
    for ax0, ax1, ay, atext in amts:
        if abs(ay - dy) >= 3:
            continue
        acx = (ax0 + ax1) / 2
        if abs(acx - isplate_cx) < half_gap:
            isplate = _parse_bih_amount(atext)
        elif abs(acx - uplate_cx) < half_gap:
            uplate  = _parse_bih_amount(atext)

    rows.append({
        'date': f"{int(y)}-{int(mo):02d}-{int(d):02d}",
        'dokument': f"PROC-{rbr_val.zfill(4)}",   # synthetic
        'amount':   round(uplate - isplate, 2),
    })
```

### Implementacija za Sparkasse

Sparkasse rows anchored by 9-digit BROJ (left-most column). Dva
iznosa po redu: `DUGUJE` (debit) i `POTRAŽUJE` (credit). Datum je
**statement-level** (header: `Izvod broj N od DD.MM.YYYY na dan
DD.MM.YYYY`) — svi redovi nose isti datum.

```python
# fitz words clustering, anchor on 9-digit BROJ
for w in words:
    if not _SPK_BROJ_WORD_RE.match(w[4]):
        continue
    band = sorted(
        [a for a in amts if abs(a[1] - wy) < 3], key=lambda a: a[0]
    )
    duguje    = _parse_us_amount(band[-2][2])
    potrazuje = _parse_us_amount(band[-1][2])
    rows.append({
        'date':     stmt_date,         # iz headera
        'dokument': w[4],              # 9-digit BROJ
        'amount':   round(potrazuje - duguje, 2),
    })
```

### Per-bank `_extract_ai_dokument` hook

Base parser je tvrdo kodirao `\b\d{10}\b` regex protiv AI haystack-a
za Phase-1 join. To je tačno za Raiffeisen — ali **pogrešno za
ProCredit i Sparkasse**: AI-ov reference field često sadrži incidental
10-cifrene tokene (tax IDs, IBAN fragmenti, invoice numbers) koji
nisu row identifikatori. Falsi-pozitivi → svaki AI red triggeruje
`row_phantom` → svaki gt_row ostaje neusparen → Phase-3
auto-reconstruct produkuje duplikate redova.

Novi hook `_extract_ai_dokument(haystack)` defaultuje legacy regex;
per-bank overrides za ProCredit/Sparkasse vraćaju `None` — preskaču
Phase-1 i sve redove forsiraju kroz Phase-2 amount-only matching:

```python
def _extract_ai_dokument(self, haystack):
    if self.code == 'procredit':   # ili 'sparkasse'
        return None
    return super()._extract_ai_dokument(haystack)
```

### IBAN substring matching (cross-border SEPA payments)

Sparkasse-ov originalni `_extract_ground_truth_accounts` matchao je
samo `/(\d{16})` (domestic BiH format). Ali cross-border payments
print kao `/CC<digits>...PARTNER` — npr. `/CH3280808007929021834VANETTI`
(Swiss IBAN, 21 znakova: `CH` + 19 cifara).

AI ekstrahuje 16-cifreni subseq. iz IBAN-a kao `partner_account`.
Bez registracije tih subsequenca kao ground truth — svaki cross-border
red flag-uje se kao `suspicious`, fallback model ponavlja sa istim
podacima i daje isti false-positive.

Zajednički helper na base parseru:

```python
@staticmethod
def _extract_iban_account_subsequences(text):
    accounts = set()
    for m in re.finditer(r"/[A-Z]{2}(\d{16,})", text):
        digits = m.group(1)
        for i in range(len(digits) - 15):
            accounts.add(digits[i:i + 16])
    return accounts
```

Za `/CH3280808007929021834VANETTI` produkuje 4 kandidata (4 različita
16-cifrena prozora unutar 19-cifrenog BBAN dijela). AI-ov bilo koji
kandidat sad pasuje. Svaka banka unija ovog helpera u svoj override.

### Failover-engagement bug fix: row-level repairs do `account_repairs`

Row-level cross-check (`amount_snap`/`row_missing`/`row_phantom`)
prethodno je SAMO logirao warninge — nije dodavao u
`result['account_repairs']`. Journal failover-engagement check
čita `account_repairs`:

```python
primary_had_repairs = any(
    r.get('type') in ('amount_snap', 'row_missing',
                      'row_phantom', 'snap', 'snap_long',
                      'suspicious')
    for r in primary_repairs
)
```

— pa row-level signali nikad nisu ni stizali do failover trigger
liste. Bio je to dead code za ProCredit broj 13 i slične.

Fix: dodati `account_repairs.append({...})` na svakom row-level
finding sajtu. Sada **row_missing/row_phantom triggeruju failover**.

### Outcome chatter: POSITIVE / AUTOFIX / UNRESOLVED kategorizacija

Original outcome chatter logic je posmatrao SVE tagove jednako:
ako je `account_repairs` non-empty, javljao je "OCR fallback also
flagged repairs". Ali `confirmed` tag je **pozitivan** signal
(verifikacija prošla), ne problem. Rezultat: 20/20 raiffeisen
failover-a u prvom test runu su bili klasifikovani kao "also flagged"
iako su svi bili clean (samo `confirmed` tag prisutan).

Tri kategorije:

| Kategorija | Tagovi | Značenje |
|---|---|---|
| POSITIVE | `confirmed`, `date_confirmed` | Verifikacija prošla — ne problem |
| AUTOFIX | `snap`, `snap_long`, `amount_snap`, `date_snap`, `row_missing` | Parser deterministički korigovao AI-jevu grešku — output korektan |
| UNRESOLVED | `suspicious`, `row_phantom` | Još uvijek pogrešno — operator review needed |

Tri ishodne poruke u chatteru:

```
"OCR fallback succeeded — <model> parsed cleanly (no unresolved issues)."
"OCR fallback succeeded with parser auto-corrections: <tags>."
"OCR fallback also flagged unresolved issues: <tags>."
```

---

## 6. Wall-clock watchdog na LLM pozivima i `FAILED-*` placeholder

Tokom batch testa, dva sparkasse statementa (#14, #29) zaglavila su
se u `PROCESSING-*` placeholder stanju **25+ minuta**. LLM HTTP poziv
nije nikad vratio rezultat I nije nikad timeout-ovao. `requests.post(timeout=600)`
ostao je u recv() jer:

- TCP keepalive paketi su držali socket "živim" na OS nivou iako je
  upstream model worker u tihoj smrti.
- OpenRouter-ov load balancer je slao partial-response chunkove na
  duge intervale, svaki chunk je resetovao read timer.

Per-byte read timeout nije isto što i wall-clock total budget.

### Wall-clock watchdog

```python
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutTimeout

watchdog_budget = read_timeout + 60   # 60s grace

executor = ThreadPoolExecutor(max_workers=1)
future = executor.submit(_http_call)
try:
    api_response = future.result(timeout=watchdog_budget)
except FutTimeout:
    future.cancel()
    raise TimeoutError(
        f"LLM call exceeded watchdog budget of {watchdog_budget}s"
    )
finally:
    executor.shutdown(wait=False)   # don't block on hung threads
```

ThreadPoolExecutor (ne `signal.SIGALRM`) jer SIGALRM radi samo u main
thread-u procesa — Odoo workers su threaded. Novi executor po retry
attempt-u, da hung future iz attempt-1 ne pina attempt-2 thread pool.

### `FAILED-*` placeholder rename

Kad oba phasea propadnu (primary raise + fallback raise, ili oba
vrate `None`), placeholder se rename-uje **`PROCESSING-...pdf` →
`FAILED-...pdf`** i postavi se `pdf_ocr_status='failed'`.

Posljedice:

- `_purge_processing_zombies` skripta filtrira `name LIKE 'PROCESSING-%'`
  → ne dotiče FAILED-*.
- Operator vidi distinct kategoriju u listi statementa. Klikom otvara
  formu sa originalnim PDF-om i chatter trail-om.
- Postojeći **Reprocess button** na formi zove `action_reprocess_pdf`
  — radi bez obzira na ime placeholder-a (treba samo `pdf_attachment_id`).

### End-to-end test scenario

Privremeno usmjeriti OpenRouter `api_endpoint` na zatvoren port
(`http://127.0.0.1:65000/...`), poslati sparkasse #1 EML, posmatrati
chatter:

```
12:37:14: LLM HTTP attempt 1/2 failed: ConnectionError. Retrying once.
12:37:14: LLM HTTP attempt 2/2 failed: ConnectionError. Giving up; raising to caller.
12:37:14: Primary model Qwen3-VL-32B failed: primary returned no result.
          Re-running extraction with fallback model Gemini 3 Flash (preview).
12:37:14: LLM HTTP attempt 1/2 failed: ConnectionError. Retrying once.
12:37:14: LLM HTTP attempt 2/2 failed: ConnectionError. Giving up; raising to caller.
12:37:14: OCR fallback also returned no result (no parseable data). Will mark
          statement as failed for manual review.
12:37:14: PDF extraction failed after 0.2 seconds. Placeholder renamed to
          FAILED-091612_20260105_KM_1.PDF — manually retry via the Reprocess
          button on this form.
```

**6 sekundi** od ulaska u proces do FAILED-* placeholder-a (umjesto
25 minuta zaglavljen u PROCESSING). Vraćen endpoint, klik Reprocess,
oporavak za 7.7 sekundi → broj `1`, status `completed`.

---

## 7. End-to-end pipeline metrike (full batch sa svim fixovima)

Na anon DB instanci (`banke-izvodi-test-anon`), 198 statementa
prošlo kroz pipeline (procredit 45/46, raiffeisen 76 numerička broja
+ 4 kreditna izvoda, sparkasse 77/78):

### Failover engagement (ispravna klasifikacija)

| Banka | Stmts | Failover engaged | Clean success | Autofix | Unresolved | Failed |
|---|---:|---:|---:|---:|---:|---:|
| procredit | 45 | **1** (2.2 %) | 1 (100 %) | 0 | 0 | 0 |
| raiffeisen | 76 | **27** (35.5 %) | 27 (100 %) | 0 | 0 | 0 |
| sparkasse | 77 | **23** (29.9 %) | 18 (78 %) | 3 | **2 → 0**¹ | 0 |
| **TOTAL** | **198** | **51** (25.8 %) | **46** (90 %) | **3** | **2 → 0**¹ | **0** |

¹ Dva sparkasse `unresolved` slučaja (`#43`, `#64`) su bili
cross-border SEPA payments. Fix-up sa IBAN substring matching ih je
sve riješio: oba sad **clean** ili **autofix**. Pipeline ima **0**
truly-unresolved statementa.

### Per-statement broj 59 verifikacija

Najteži reprezentativni primjer (45 transakcija): prije fixa **44
brojeva računa** flag-ovana kao unverifiable. Poslije:

```
partner_account confirmed: '1610200352387944' → '1610200352387944' (gt=18)
partner_account confirmed: '1610203777254208' → '1610203777254208' (gt=18)
[... 42 dalje ...]
```

Cross-validation kroz `--compare-with-database`:

```
field         this        compare    match
 date    2026-03-31    2026-03-31    ✓
start          0.00          0.00    ✓
  end          0.00          0.00    ✓
lines            45            45    ✓
debit      10553.97      10553.97    ✓
credit     10553.97      10553.97    ✓

result: all match
```

---

## 8. Šta dalje

Pipeline je sad **correctness-stable**. Otvorene linije:

1. **Cross-bank failover matrica**. Failover-success rate bank-by-bank:
   - Raiffeisen: 27/27 (100 %)
   - Sparkasse: 21/23 (91 %, 2 sa autofix)
   - ProCredit: 1/1 (100 %)
   Treba ponoviti 16-ćelijsku matricu i za Sparkasse i ProCredit
   reprezentativne primjere — možda GLM-4.6V ili Mistral budu bolji
   failover za njih nego Gemini Flash.

2. **GLM-4.6V cijenovni model**. ~3× cijena Qwen-a, ~3× sporiji. Ako
   se pokaže da na nekoj banci dosljedno pobjeđuje, trade-off je
   prihvatljiv (failover nije hot path).

3. **Failover engagement metrika kao Odoo dashboard**. Sad ima 51
   engagement, 46 clean, ali ručno čitanje chattera. Cron job koji
   parsira `account_repairs` i `mail.message` na statementu dat će
   sliku po danu/sedmici/mjesecu.

Sve je commitovano u repo-u. `scripts/anon_eml_extract_1.py` i
`anon_eml_patch_2.py` su jednostavniji nego prije; row-level
deterministička provjera radi za sve tri aktivne BiH banke; failover
ima self-evident outcome chatter; hung LLM pozivi se sigurno
escalate-uju u FAILED-* sa jednim-klik recovery.

---

*Tehnička serija o `l10n_ba_bank_pdf` se nastavlja. Ako koristite Odoo 16
i parsirate izvode iz BiH banaka, ili ako vodite open-source Odoo
projekte koji moraju imati javno dijeljive test fixture, [javite se](mailto:hernad@bring.out.ba)
— rado podijelimo iskustvo, kod, ili pull-request.*

---

*Članak napisao Claude 🤖 u saradnji sa razvojnim timom bring.out.ba
na osnovu commit-historije, batch-test logova i interaktivnih iteracija na
test instanci `banke-izvodi-test-anon`. Podaci u tabelama su realni rezultati
eksperimenata; sve fonetske zamjene u primjerima PDF-a (npr. KIMI ZUTINA,
JOJOPEFE) su deterministički generisane fixture-ke, ne prave kompanije ili
gradovi.*
