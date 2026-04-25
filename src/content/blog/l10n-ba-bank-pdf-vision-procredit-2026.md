---
title: 'Bosanska lokalizacija "Odoo" open-source platforme: Modul l10n_ba_bank_pdf — vision-LLM mode za ProCredit (slika stranice umjesto teksta) i 60% manji storage'
description: 'ProCredit izvodi imaju ugrađene fontove bez ToUnicode CMap-a — fitz vraća iskrivljen tekst tipa "5DþXQEURM" umjesto "Račun broj". Rješenje: rasterizovati svaku stranicu (PNG @ 150 DPI) i poslati LLM-u uz tekst, te tu sliku spremiti kao attachment u Odoo umjesto originalnog PDF-a (originalni eml ostaje u poštanskom sandučetu kao audit trail). 60% manje bajtova u bazi.'
pubDate: '2026-04-25T14:00:00'
heroImage: '/banke-vision-hero.svg'
---

## Problem 1: iskrivljeni tekst iz ProCredit PDF-a

Modul `l10n_ba_bank_pdf` koristi `fitz` (PyMuPDF) da iz PDF-a izvuče tekst, sastavi prompt i pošalje ga LLM-u (Qwen3-VL preko OpenRouter-a) za AI ekstrakciju transakcija. Za većinu BiH banaka ovo radi dobro. Za **ProCredit Bank** ne — ekstrahirani tekst izgleda ovako:

```
5DþXQEURM
1941202302802154
Valuta:
BAM
/LPLWSUHNRUDþHQMD
0,00
3RþHWQRVWDQMH
9ODVQLNUDþXQD
PARTNER A doo
3RWYUÿXMHPRGDGHSR]LWQDVUHGVWYDQD9DãLPUDþXQLPD
```

Ono što treba pisati je `Račun broj`, `Limit prekoračenja`, `Početno stanje`, `Vlasnik računa`, `Potvrđujemo da depozitna sredstva`. Imena partnera i iznosi (`PARTNER A doo`, dio fonta sa standardnim *encoding*-om) prolaze ispravno.

### Dijagnoza

`fitz` može pročitati glyph indekse koje stranica koristi, ali **ne može ih prevesti nazad u Unicode** kada font nema `ToUnicode` CMap. ProCredit PDF ugrađuje 6 fontova:

| Font | Tip | Encoding | ToUnicode? |
|---|---|---|---|
| `ABCDEE+Arial,Bold` | Type0 | Identity-H | **No** |
| `ABCDEE+Arial` | Type0 | Identity-H | **No** |
| `ABCDEE+Tahoma` | TrueType | WinAnsiEncoding | **No** |
| `ABCDEE+Tahoma,Bold` | TrueType | WinAnsiEncoding | **No** |
| `Helvetica` | Type1 | WinAnsiEncoding | No (ali ne treba — standardni Adobe Type1) |
| `Helvetica-Bold` | Type1 | WinAnsiEncoding | No |

Offset između vidljivog karaktera i ekstrahiranog bajta je **konstantan +0x1D (+29)**:

```
'R' (0x52)  vs  '5' (0x35)   diff = +0x1d
'a' (0x61)  vs  'D' (0x44)   diff = +0x1d
'u' (0x75)  vs  'X' (0x58)   diff = +0x1d
'n' (0x6e)  vs  'Q' (0x51)   diff = +0x1d
```

Klasičan slučaj generatora PDF-a (Crystal Reports / iReport / sl. starije Windows print drajvere) koji **subset-uje fontove ali ne emituje ToUnicode CMap**. Vizuelno render je tačan jer `0x35 → glyph(R)` mapping postoji u CharStrings tabeli. Ekstrakcija je polomljena jer `0x35 → "R"` mapping nedostaje u metapodacima.

## Rješenje 1: vision-LLM mode

Dodali smo dva polja na model `bank.pdf.statement.parser`:

```python
use_vision = fields.Boolean(default=False)
vision_dpi = fields.Integer(default=150)
```

Kada je `use_vision = True`, `_extract_statement_data` rasterizuje svaku stranicu na PNG @ 150 DPI i šalje LLM-u kao multipart sadržaj uz tekstualni prompt:

```python
content = [{'type': 'text', 'text': prompt}]
for b64 in page_images_b64:
    content.append({
        'type': 'image_url',
        'image_url': {'url': f'data:image/png;base64,{b64}'},
    })
```

Qwen3-VL (i Claude vision, GPT-4o) prihvataju ovaj OpenAI-style format. Model čita rendiranu sliku gdje su zaglavlja **ispravno vidljiva** kao `Račun broj`, `Početno stanje` itd. — ignoriše iskrivljeni tekstualni stream.

ProCredit parser u `l10n_ba_bank_pdf_procredit/data/procredit_parser.xml` je `use_vision=True`. Ostale banke (Raiffeisen, Sparkasse, PBS) ostaju na text-only modu — njihov tekst se ekstrahuje čisto.

### A/B test: tekst-only vs vision

Test slučaj — ProCredit izvod sa 4 transakcije, mješovite +/- (uplate i isplate):

| | Vision (PNG @ 150) | Tekst-only |
|---|---|---|
| OCR confidence | 0.980 | 0.950 |
| Linije ekstrahovane | 4 ✓ | 4 ✓ |
| Sume amount-a | -777.04 ✓ | -777.04 ✓ |
| Znakovi (sign) | svi tačni | svi tačni |

Za ovaj jednostavan slučaj oba moda rade. Vision pokazuje malo višu samopouzdanost (0.98 vs 0.95). Ali — za slučajeve gdje se popunjava `Provizija` kolona (kompleksno pravilo o znaku amount-a po kolonama Isplate/Uplate), vision je značajno pouzdaniji jer LLM **vidi grid tabele** umjesto da ga rekonstruiše iz pozicije teksta.

### Što vision NE rješava

JPEG umjesto PNG je **lošija** ideja:

| | PNG @ 150 | JPEG @ 85 @ 150 |
|---|---|---|
| Bajti | 194 KB | 200 KB *(veće!)* |
| Znakovi (sign) | tačni | **2 transakcije sa pogrešnim znakom (+ umjesto -)** |

Razlog: bank-statement stranica je uglavnom bijelo + crn tekst + tanke grid linije. PNG `deflate` kompresuje ravne regije odlično; JPEG-ov DCT troši bitove na pozadinu. JPEG kompresija blago zamuti tanke vertikalne grid linije i model zna pomjeriti broj iz `Isplate` u `Uplate` kolonu (znak se okrene).

**Zaključak: PNG @ 150 DPI ostaje hard-coded format.** Polje `vision_format` smo planirali ali revertali nakon ovog testa.

## Problem 2: storage bloat

Sada kada vision radi, otkrili smo drugu zanimljivost. Veličine PDF attachment-a u Odoo bazi:

```
ProCredit izvod 1:  423,198 bajtova
Raiffeisen izvod 1:  87,035 bajtova (i k tome 2 stranice!)
```

ProCredit je **5x veći za jednu stranicu**. Razlog — svaki PDF nosi svoje fontove:

### ProCredit (423 KB):
| xref | bytes | sadržaj |
|---|---|---|
| 21 | 122,705 | TTF subset (Tahoma) |
| 14 | 109,460 | TTF subset (Arial) |
| 16 | 88,024 | TTF subset (Arial Bold) |
| 18 | 77,732 | TTF subset (Tahoma Bold) |
| 9 | 14,717 | logo PNG |
| 10 | 3,791 | sadržaj stranice |
| **397,921** | | **94% fajla = 4 font subseta** |

### Raiffeisen (87 KB):
| xref | bytes | sadržaj |
|---|---|---|
| 13 | 69,581 | TTF subset (Microsoft Sans Serif) |
| 8 | 5,399 | sadržaj stranice |
| 11 | 3,418 | sadržaj stranice |
| 6 | 2,666 | logo |

Raiffeisen koristi **jedan font** (Microsoft Sans Serif, sintetički bold preko PDF graphics state-a). ProCredit koristi **četiri** (Arial regular, Arial bold, Tahoma regular, Tahoma bold). Svaki TTF subset, čak i sa 50 glifova, nosi ~60-150 KB obaveznih TrueType tabela.

## Rješenje 2: spremaj u Odoo isto što LLM vidi

Kada je `use_vision=True`, sada gradimo i spremamo flat image-only PDF (jedna PNG slika po stranici) i **mijenjamo `ir.attachment.datas` na statement-u**:

```python
# u bank_pdf_statement_parser._extract_statement_data
flat_doc = fitz.open() if self.use_vision else None
for page in doc:
    text += page.get_text()
    if self.use_vision:
        pix = page.get_pixmap(dpi=self.vision_dpi or 150, alpha=False)
        page_images_b64.append(base64.b64encode(pix.tobytes("png")).decode("ascii"))
        new_page = flat_doc.new_page(width=page.rect.width, height=page.rect.height)
        new_page.insert_image(page.rect, pixmap=pix)
flat_pdf_bytes = flat_doc.tobytes(garbage=4, deflate=True)

# u account_journal._update_statement_from_data
if data.get('flat_pdf_bytes') and statement.pdf_attachment_id:
    statement.pdf_attachment_id.write({
        'datas': base64.b64encode(data['flat_pdf_bytes']).decode('utf-8'),
        'mimetype': 'application/pdf',
    })
```

Originalni eml ostaje netaknut u Stalwart-u (audit trail). Odoo drži samo verziju koju je LLM zaista pročitao — što je ujedno i ono što operater vidi kada klikne "open PDF" na izvodu, i što reprocess ponovo koristi.

### Live rezultat na test instanci

Tri ProCredit izvoda nakon `action_reprocess_pdf`:

| Izvod | Prije (originalni PDF) | Poslije (vision PDF) | Ušteda |
|---|---|---|---|
| 20260105 | 423,198 B | 143,117 B | 66% |
| 20260127 | 423,295 B | 148,805 B | 65% |
| 20260306 | 434,122 B | 195,236 B | 55% |
| **Ukupno** | **1,280,615 B** | **487,158 B** | **62%** |

OCR confidence i ekstrahovani podaci ostaju nepromijenjeni (0.98–1.00).

Za banke bez vision-a (Raiffeisen, Sparkasse, PBS), `flat_pdf_bytes` je `None` i originalni PDF ostaje na attachment-u — njihovi PDF-ovi su već mali i ekstrakcija teksta radi čisto.

### Šta se NE optimizuje ovom izmjenom: AI trošak

Bitno razgraničenje, jer je intuicija varljiva. Originalni 423 KB PDF nikad nije ni išao LLM-u — `fitz` ga lokalno rasterizuje na PNG i šalje samo PNG (~194 KB) plus tekstualni prompt. Ugrađeni TTF subset-ovi su lokalno potrošeni od strane `fitz`-a da nacrta glifove na pixmap. Kada `get_pixmap()` završi, font program više ne postoji — ostaje samo njegov vizualni output kao pikseli.

Tako da *broj tokena* poslat LLM-u zavisi od **rezolucije slike**, ne od veličine izvornog PDF-a:

| Mode | Input ka LLM-u | ~tokeni | AI cijena |
|---|---|---|---|
| Pre-vision (text-only) | ~1.3 KB iskrivljenog teksta | ~900 | 1.0× |
| Vision (PNG @ 150 DPI) | tekst + 1× PNG | ~3,700 | **~4×** |
| Vision sa storage-fix (ova izmjena) | tekst + 1× PNG (isto!) | ~3,700 | ~4× (nepromijenjeno) |

Ova izmjena ušteda **ide u Odoo bazu, ne u OpenRouter račun**. Vision mode je 4× skuplji od text-only mode-a — i to je opravdan trošak za ProCredit-class slučajeve gdje iskrivljen tekst + Provizija sign rule znači realan rizik od pogrešnog znaka transakcije. Ovaj fix samo razrješava da Odoo storage **ne plaća dvaput** — niti pišemo AI input duplo.

## Naredne moguće optimizacije

- **Translacija prompta na bosanski**: trenutni base prompt je na engleskom; LLM ipak razumije jer su instrukcije jasne, ali striktno bosanski prompt mogao bi smanjiti broj tokena za 10-15%.
- **Caching prompta**: Anthropic / OpenRouter podržavaju prompt caching. Statički dio prompta (~80% sadržaja) bi se kešovao i smanjio cijenu za reprocess pozive.
- **Multi-page hint** u base prompt-u: za izvode koji se protežu kroz više stranica (Raiffeisen tipično 1-3 stranice), eksplicitno reći LLM-u "treat sequential pages as one statement" mogao bi marginalno poboljšati tačnost preko granica stranica.

## Napomena

Generisano od strane Claude 🤖

---

Ernad Husremović, hernad@bring.out.ba
