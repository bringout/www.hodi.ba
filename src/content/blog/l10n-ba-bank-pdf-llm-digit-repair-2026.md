---
title: 'Bosanska lokalizacija "Odoo" open-source platforme: Kada LLM ignoriše instrukcije — popravak ispuštenih cifri u broju transakcijskog računa pomoću PDF teksta kao "ground truth"'
description: 'Iako je modul l10n_ba_bank_pdf u vision-modu (rasterizovana stranica + tekst), Qwen3-VL (i GPT-4o, i Claude) povremeno ispušta jednu cifru iz broja transakcijskog računa kad se u nizu ponavlja istih cifri (najčešće nula). Promptu se kaže "broji do 16, ako nije 16 vrati prazno" — LLM ignoriše instrukciju jer ne broji tokene pouzdano. Rješenje: na ulazu u parser regexom izvući svaki /16-cifreni iz tekst-sloja PDF-a kao "ground truth" set, pa nakon LLM odgovora svaki 14- ili 15-cifreni odgovor "snapnuti" na jedinstvenog kandidata kojem je LLM-ov pogrešan niz subsekvenca. Cijeli popravak se loguje u chatter izvoda — operatera odmah vidi šta je AI pogriješio i koju vrijednost je sistem deterministički vratio.'
pubDate: '2026-04-25T20:30:00'
heroImage: '/llm-digit-repair-hero.svg'
---

## Problem: LLM ne broji cifre pouzdano

`l10n_ba_bank_pdf` modul koristi `Qwen3-VL` preko OpenRouter-a — slika stranice + ekstrahovan tekst — da izvuče stavke iz bankovnih PDF izvoda. Za većinu polja (datum, opis, iznos) tačnost je >99%. Ali jedno polje uporno mu izmiče: 16-cifreni transakcijski račun.

Tipičan primjer:

> *opis: PO RACUNU IF26040033 /1610000095080090 PARTNER X DOO SARAJEVO*

LLM emituje:

```json
{
  "partner_account": "161000009580090",   ← 15 cifri (ispušten jedan 0)
  "partner_name":    "PARTNER X DOO SARAJEVO",
  "amount":          332.00
}
```

Problem je **ispuštena cifra iz niza nula u sredini broja**. `1610000095080090` ima 7 nula u nizu (`0000095080`), Qwen tokenizuje takve sekvence kao "ovo izgleda kao nula puno puta" i u rekonstrukciji ispusti tačno jednu.

## Promptiranje ne pomaže

Prvi pokušaj — pojačati prompt:

```
3. Partner extraction from OPIS:
   - Format is ALWAYS "/NNNNNNNNNNNNNNNN PARTNER NAME" — exactly 16 digits.
   - CRITICAL: count the digits before emitting partner_account.
     If the digit count is not exactly 16, set partner_account to "".
     DO NOT guess, DO NOT reconstruct, DO NOT pad.
```

Reproces istog PDF-a:

```json
{ "partner_account": "161000009580090", ...   // 15 cifri, ponovo
}
```

LLM **ignoriše instrukciju**. Razlog je arhitekturni: modeli ne broje karaktere pouzdano, naročito u sekvencama tokena kao što su digit-runs. To je poznat problem (Qwen3-VL, GPT-4o, Claude — svi ga imaju). Promptom se ne može popraviti.

## Rješenje: PDF tekst kao "ground truth"

Ključna observacija: **bankovni PDF ima tekst-sloj** (kad nije čista slika). `fitz.page.get_text()` vraća kompletan tekst stranice, gdje su transakcijski računi prisutni u svom tačnom 16-cifrenom obliku — bez gubljenja cifri.

Pa zašto onda uopšte ići preko LLM-a? Zato što `get_text()` ne razumije **kontekst** — za njega su to samo brojevi rasuti po stranici, ne zna koji broj pripada kojoj transakciji, koji je iznos pozitivan/negativan, ko je nalogodavac. LLM zna kontekst. A regex zna brojeve. Spojiti ih:

### Korak 1: izvući "ground truth" set iz PDF-a

```python
text = ""
doc = fitz.open(stream=pdf_content, filetype="pdf")
for page in doc:
    text += page.get_text()

# Svaki niz "/" + tačno 16 cifri je validan BA račun
ground_truth_accounts = set(re.findall(r"/(\d{16})", text))
```

Za naš primjer izvod sadrži, recimo, set:

```
{'1610000095080090', '1610000165000002', '1610000030250043',
 '3387202245048222', '1413575320009316', '1610000255230097'}
```

### Korak 2: provjeriti svaki LLM odgovor protiv tog seta

```python
for tx in data['transactions']:
    pa = tx['partner_account']
    if pa and len(pa) in (14, 15) and pa.isdigit():
        candidates = [
            g for g in ground_truth_accounts
            if is_subsequence(pa, g)
        ]
        if len(candidates) == 1:
            tx['partner_account'] = candidates[0]   # snap!
```

`is_subsequence(short, long_)` vraća True ako se sve cifre iz `short` pojavljuju u `long_` u istom redoslijedu — što je **tačno obrazac LLM-ovog gubljenja cifre**: cifra je ispala, ostale su zadržane u redoslijedu.

```python
@staticmethod
def is_subsequence(short, long_):
    i = 0
    for ch in long_:
        if i < len(short) and short[i] == ch:
            i += 1
    return i == len(short)
```

### Zašto subsekvenca, a ne Hamming distanca

Hamming bi rekao da `161000009580090` (15 cifri) i `1610000095080090` (16 cifri) imaju ogromnu razliku jer od momenta gdje je cifra ispala sve se pomjerilo lijevo:

```
LLM:    1 6 1 0 0 0 0 0 9 5 8 0 0 9 0
PDF:    1 6 1 0 0 0 0 0 9 5 0 8 0 0 9 0
                              ↑ ovdje LLM ispustio 0
```

Pozicija po poziciji od `9 5` nadalje sve je drugačije. Hamming = veliki broj, Levenshtein = 1. Subsekvenca = **tačno** ono što treba: pita "može li se short dobiti brisanjem 1 cifre iz long?", a to je upravo poznata greška LLM-a.

### Korak 3: ako su 0 ili ≥2 kandidati — ostaviti i prijaviti operateru

Ako u "ground truth" setu **niko** ne sadrži LLM-ov niz kao subsekvencu, ili **dva ili više** sadrže, ne snapamo (prevelika neizvjesnost). Umjesto toga statement.line se kreira sa `partner_account=""` i fallback na pretragu po imenu, a u chatter izvoda padne već postojeća poruka tipa:

```
Detektovan transakcijski račun 16100009580090 (ima 14 cifri) —
nije validan 16-cifreni BA broj. Partner: PARTNER Y DOO; iznos 332.00
```

Operater zna da treba ručno provjeriti.

## Logging u chatter — vidljivost svake popravke

Tihi popravak je opasan: ako AI pogriješi, a sistem to deterministički "ispravi", računovođa nikad ne sazna. Zato svaka uspješno snapnuta vrijednost odlazi i u chatter izvoda kao `mt_note`:

> **Automatski popravljen broj transakcijskog računa** na 1 stavka(e) — LLM je
> ispustio cifru iz niza nula, vrijednost je rekonstruirana iz teksta originalnog
> PDF-a (podudaranje kao subsekvenca, jedinstveni kandidat).
>
> - LLM pročitao `161000009580090` (15 cifri) — ispravljeno na
>   `1610000095080090` (16 cifri) prema originalu u PDF-u. Partner:
>   *PARTNER X DOO SARAJEVO*; iznos 332,00; opis: PO RACUNU IF26040033 …

Tako i AI greška i sistemska popravka su **vidljivi i revizibilni**. Ako bi neki dan repair pogrešno snapao, audit trail postoji.

## Šta naučili

1. **LLM prompt-konstrange za brojanje karaktera nisu pouzdane** — bilo koji moderni multimodalni model (Qwen3-VL, GPT-4o, Claude) ignoriše "count to N" instrukciju u dugim digit-runovima. Ne tokenizuju cifre 1-na-1.

2. **PDF tekst-sloj je free ground truth** — kad postoji, regex preko `page.get_text()` ima 100% tačnost na izoliranim brojevima. LLM treba samo za kontekst, ne za rekonstrukciju cifri.

3. **Subsekvenca kao "popravak digit-dropa"** je jeftina i obrazovna. O(N) algoritam. Zna tačan obrazac LLM-ove greške i razlikuje validnu popravku od pretjeranog snap-a.

4. **Sve tihe popravke loguju se u chatter** — operater vidi i šta je AI pogriješio i šta je sistem ispravio. Bez ovoga, automatski popravak postaje "magic" koji niko ne razumije i u koji niko ne vjeruje.

Modul `l10n_ba_bank_pdf 16.0.1.22.0` ovo ima ugrađeno za sve podržane parseje (Raiffeisen, Sparkasse, ProCredit, PBS).

## Napomena

Generisano od strane Claude 🤖

---

Ernad Husremović, hernad@bring.out.ba
