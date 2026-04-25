---
title: 'Bosanska lokalizacija "Odoo" open-source platforme: Novi modul l10n_ba_rs_bank_data + konsolidacija na zajednički l10n_ba_bank (3-digit prefix detekcija)'
description: 'Modul l10n_ba_rs_bank_data za listu komercijalnih banaka u Republici Srpskoj sa 3-cifrenim prefiksom transakcijskog računa, te ekstrakcija dijeljene logike u novi modul l10n_ba_bank — auto-popunjavanje res.partner.bank.bank_id radi za oba entiteta bez duplikacije koda.'
pubDate: '2026-04-25T12:30:00'
heroImage: '/banke-rs-hero.svg'
---

## Kontekst

U BiH se transakcijski račun sastoji od 16 cifara, gdje **prve 3 cifre** identifikuju banku (tzv. *vodeće cifre žiro računa*, *šifra banke*). Svaka licencirana banka u CBBH/ABRS registru ima svoj jedinstveni 3-cifreni kod — npr. `161` za Raiffeisen Bank dd BiH (FBiH), `555` za Nova banka a.d. Banja Luka (RS).

Modul `l10n_ba_fbih_bank_data` već je nudio:

- listu FBiH banaka u `res.bank` sa XML id-om jednakim 3-cifrenom prefiksu;
- automatsko popunjavanje polja `bank_id` na `res.partner.bank` na osnovu prvih 3 cifre `acc_number`;
- validacijsko pravilo: 16 cifara + prefiks koji odgovara odabranoj banci.

**Šta je nedostajalo:** lista RS banaka. Pri uvozu izvoda (modul `l10n_ba_bank_pdf` + auto-kreiranje partnera) konto poput `5550000005368483` (uplata u korist budžeta RS) ostao je sa `bank_id = False` jer prefix `555` nije postojao ni u jednom modulu.

Naivno rješenje "dopiši RS banke u FBiH modul" nije bilo prihvatljivo — to bi bila konceptualna greška (entiteti su odvojeni). Rješenje je rastavljanje na **3 modula** koji čine jasnu hijerarhiju.

## Nova arhitektura

```
              l10n_ba_bank (samo kod, bez podataka)
                  ▲                           ▲
                  │                           │
   l10n_ba_fbih_bank_data           l10n_ba_rs_bank_data
   (data: res.bank.csv FBiH)        (data: res.bank.csv RS)
   (data: reconcile rules,          (data: meni "Banke RS")
    Banke FBiH meni)
```

| Modul | Verzija | Sadržaj |
|---|---|---|
| `l10n_ba_bank` | 16.0.1.0.0 | Dijeljeni kod: `bank_code` compute na `res.bank`, `_find_bank_by_account_prefix` / `_get_bank_xml_id` lookup, `create()`/`write()` overrides na `res.partner.bank` (auto-fill bez `@api.onchange` ograničenja), 16-cifreni format constraint. Bez podataka. |
| `l10n_ba_fbih_bank_data` | 16.0.1.12.0 | FBiH banke (CSV), partner zapisi (npr. *Raiffeisen bank dd Sarajevo*), reconcile rules za bankovne transfere (4240 prekoračenje, 5530 platni promet provizija), meni *Banke FBiH*. Bez modela. |
| `l10n_ba_rs_bank_data` | 16.0.1.1.0 | RS banke (CSV) i meni *Banke RS*. Bez modela. |

Ključno: **lookup zna za sve module** — `res.partner.bank._find_bank_by_account_prefix` traži xref-ove sa `module LIKE 'l10n_ba_%'`, pa automatski hvata i FBiH i RS prefikse iz iste rutine. Nema dupliciranog koda, oba data modula su čisti nosioci podataka i mogu se lako proširiti dodavanjem nove `_bank_data` familije.

### Zašto `create()`/`write()` umjesto `@api.onchange`?

`@api.onchange('acc_number')` se okida samo kroz web form pipeline — direktno `create()` (XML-RPC, CSV import, programatski tokovi kao auto-kreiranje partnera u `l10n_ba_bank_pdf`, čak i neke "inline tree" potvrde) zaobilazi ga. Pomjeranjem auto-popunjavanja u `create()`/`write()` override sve ulazne tačke daju isti rezultat:

```python
@api.model_create_multi
def create(self, vals_list):
    for vals in vals_list:
        if vals.get('bank_id') or not vals.get('acc_number'):
            continue
        bank = self._find_bank_by_account_prefix(vals['acc_number'])
        if bank:
            vals['bank_id'] = bank.id
    return super().create(vals_list)
```

## Lista banaka u Republici Srpskoj

Provjereni 3-cifreni prefiksi i komercijalne banke u RS-u (entitet BiH):

<table style="border-collapse: collapse; width: 100%; margin: 1.5em 0;">
  <thead>
    <tr style="background-color: #f4f4f4;">
      <th style="border: 1px solid #888; padding: 8px 12px; text-align: left;">Šifra</th>
      <th style="border: 1px solid #888; padding: 8px 12px; text-align: left;">Banka</th>
      <th style="border: 1px solid #888; padding: 8px 12px; text-align: left;">Adresa</th>
      <th style="border: 1px solid #888; padding: 8px 12px; text-align: left;">Web</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td style="border: 1px solid #888; padding: 8px 12px;"><code>551</code></td>
      <td style="border: 1px solid #888; padding: 8px 12px;">UniCredit Bank a.d. Banja Luka</td>
      <td style="border: 1px solid #888; padding: 8px 12px;">Marije Bursać 7, 78000 Banja Luka</td>
      <td style="border: 1px solid #888; padding: 8px 12px;"><a href="https://www.unicreditbank-bl.ba">unicreditbank-bl.ba</a></td>
    </tr>
    <tr>
      <td style="border: 1px solid #888; padding: 8px 12px;"><code>552</code></td>
      <td style="border: 1px solid #888; padding: 8px 12px;">Addiko Bank a.d. Banja Luka</td>
      <td style="border: 1px solid #888; padding: 8px 12px;">Aleja Svetog Save 13, 78000 Banja Luka</td>
      <td style="border: 1px solid #888; padding: 8px 12px;"><a href="https://www.addiko-rs.ba">addiko-rs.ba</a></td>
    </tr>
    <tr>
      <td style="border: 1px solid #888; padding: 8px 12px;"><code>554</code></td>
      <td style="border: 1px solid #888; padding: 8px 12px;">Naša banka a.d. Bijeljina</td>
      <td style="border: 1px solid #888; padding: 8px 12px;">Franje Jukića 1, Banja Luka (poslovnica)</td>
      <td style="border: 1px solid #888; padding: 8px 12px;"><a href="https://www.nasa-banka.com">nasa-banka.com</a></td>
    </tr>
    <tr>
      <td style="border: 1px solid #888; padding: 8px 12px;"><code>555</code></td>
      <td style="border: 1px solid #888; padding: 8px 12px;">Nova banka a.d. Banja Luka</td>
      <td style="border: 1px solid #888; padding: 8px 12px;">Kralja Alfonsa XIII 37a, 78000 Banja Luka</td>
      <td style="border: 1px solid #888; padding: 8px 12px;"><a href="https://www.novabanka.com">novabanka.com</a></td>
    </tr>
    <tr>
      <td style="border: 1px solid #888; padding: 8px 12px;"><code>562</code></td>
      <td style="border: 1px solid #888; padding: 8px 12px;">NLB Banka a.d. Banja Luka</td>
      <td style="border: 1px solid #888; padding: 8px 12px;">Milana Tepića 4, 78000 Banja Luka</td>
      <td style="border: 1px solid #888; padding: 8px 12px;"><a href="https://www.nlb-rs.ba">nlb-rs.ba</a></td>
    </tr>
    <tr>
      <td style="border: 1px solid #888; padding: 8px 12px;"><code>567</code></td>
      <td style="border: 1px solid #888; padding: 8px 12px;">ATOS Bank a.d. Banja Luka</td>
      <td style="border: 1px solid #888; padding: 8px 12px;">Jevrejska 71, 78000 Banja Luka</td>
      <td style="border: 1px solid #888; padding: 8px 12px;"><a href="https://www.atosbank.ba">atosbank.ba</a></td>
    </tr>
    <tr>
      <td style="border: 1px solid #888; padding: 8px 12px;"><code>571</code></td>
      <td style="border: 1px solid #888; padding: 8px 12px;">Banka poštanska štedionica a.d. Banja Luka</td>
      <td style="border: 1px solid #888; padding: 8px 12px;">Jevrejska 69, 78000 Banja Luka</td>
      <td style="border: 1px solid #888; padding: 8px 12px;"><a href="https://www.bpsbl.com">bpsbl.com</a></td>
    </tr>
    <tr>
      <td style="border: 1px solid #888; padding: 8px 12px;"><code>572</code></td>
      <td style="border: 1px solid #888; padding: 8px 12px;">MF banka a.d. Banja Luka</td>
      <td style="border: 1px solid #888; padding: 8px 12px;">Aleja Svetog Save 61, 78000 Banja Luka</td>
      <td style="border: 1px solid #888; padding: 8px 12px;"><a href="https://www.mfbanka.com">mfbanka.com</a></td>
    </tr>
  </tbody>
</table>

## Verifikacija na živom okruženju

Test instance `banke-izvodi-test.hodi.ba` već je imala uvedeni izvod sa transakcijom u korist budžeta RS — broj računa `5550000005368483`. Prije instalacije RS modula:

```
res.partner.bank id=11
  acc_number = '5550000005368483'
  bank_id    = False
  partner_id = MINISTARSTVO FINANSIJA REPUBLIKE SRPSKE
```

Nakon instalacije `l10n_ba_rs_bank_data` (verzija 16.0.1.1.0) i `post_init_hook` backfilla:

```
res.partner.bank id=11
  acc_number = '5550000005368483'
  bank_id    = Nova banka a.d. Banja Luka   ← prefix 555 razriješen
  partner_id = MINISTARSTVO FINANSIJA REPUBLIKE SRPSKE
```

## Migracija postojećih instalacija

Instance koje već imaju `l10n_ba_fbih_bank_data` instaliran:

```bash
# rsync svih izmijenjenih addona, zatim:
hodi-<instance>-cmd \
  --init=l10n_ba_bank,l10n_ba_rs_bank_data \
  --update=l10n_ba_fbih_bank_data \
  --stop-after-init
```

Pre-migrate skripta u verziji 16.0.1.1.0 RS modula čisti spekulativne unose iz prve verzije (`565` Sberbank, `573` MF banka sa pogrešnim prefiksom) — idempotentno, sigurno za ponovno pokretanje.

## Napomena

Generisano od strane Claude 🤖

---

Ernad Husremović, hernad@bring.out.ba
