---
title: 'Bosanska lokalizacija "Odoo" open-source platforme: Modul l10n_ba_partner_merge — pametno spajanje duplikata partnera nakon auto-importa bankovnih izvoda'
description: 'Auto-kreiranje partnera u l10n_ba_bank_pdf flow-u redovno proizvodi duplikate kada banka emituje isti pravni subjekt pod malo drugačijim imenom. Novi modul: wizard za pretragu po dijelu imena, ručna selekcija duplikata, automatski prijedlog pobjednika prema potpunosti podataka (PDV ID, JIB, adresa, broj bankovnih računa, prisutnost u žurnalima), preusmjeravanje 70+ FK referenci kroz sve module (account, purchase, stock, mail, …), arhiviranje gubitnika umjesto tvrdog brisanja.'
pubDate: '2026-04-25T15:00:00'
heroImage: '/partner-merge-hero.svg'
---

## Problem

Modul `l10n_ba_bank_pdf` od ranije ima opciju *Automatski kreiraj partnera za novi račun* — kad LLM pri uvozu bankovnog izvoda izvuče 16-cifreni transakcijski račun koji nije poznat sistemu, a partner-name iz LLM ekstrakcije postoji, kreira se nova `res.partner` zapis. Logika dedup-a je: pretraga po **tačnom imenu**; ako postoji aktivni partner sa istim imenom — pridruži novi račun na njega; inače kreiraj novog partnera.

Ali — bankarski sistemi formatiraju ista pravna lica različito kroz različite izvode. *PARTNER A d.o.o. Mostar* i *PARTNER A doo Mostar* su različiti stringovi. Kroz mjesec dana uvoza, isti pravni subjekt završi pod 2-3 res.partner zapisa, svaki sa svojim bankovnim računom, svojim setom referenci na žurnalima, svojom porukom u chatter-u.

Standardni Odoo ima `base.partner.merge.automatic.wizard` — generička SQL-introspekcija logika koja preusmjerava sve FK reference sa loser-a na winner-a. Ali nedostaje:

1. **UI za ad-hoc pretragu** — wizard auto-grupiše po e-mailu i imenu na cijeloj bazi, ali korisnik ne može unijeti substring i tražiti samo *"oni partneri koji u imenu imaju 'dent'"*.
2. **Pametan izbor pobjednika** — upstream sortira po `id` ascending; najmanji ID pobjeđuje. To je pogrešno za naš auto-import flow gdje je najstariji zapis tipično najminimalniji.
3. **Arhiviranje gubitnika** — upstream tvrdo briše loser-e nakon FK preusmjeravanja. To je gubitak audit traga.

## Rješenje: l10n_ba_partner_merge

### Komponenta 1: scorer potpunosti

Svakom kandidatu računamo ocjenu prema potpunosti podataka:

```python
PARTNER_COMPLETENESS_WEIGHTS = (
    ('vat',              10),  # PDV ID
    ('company_registry', 10),  # JIB / matični broj
    ('street',            3),
    ('city',              2),
    ('state_id',          2),
    ('country_id',        1),
    ('zip',               1),
    ('phone',             1),
    ('email',             2),
    ('website',           1),
)
# +1 po bankovnom računu
# +5 ako se partner pojavljuje u account.move.line (žurnal aktivnost)
```

Najveća ocjena pobjeđuje. Tie-break: najstariji `id` — deterministički i očuvava kontinuitet.

Override-uje upstream-ovu metodu `_get_ordered_partner` tako da pobjednik završi na kraju liste (upstream uzima `[-1]` kao odredište):

```python
def _get_ordered_partner(self, partner_ids):
    partners = self.env['res.partner'].browse(partner_ids).exists()
    return partners.sorted(
        key=lambda p: (self._l10n_ba_score_partner(p), -p.id)
    )
```

### Komponenta 2: pretraga po dijelu imena

Novi `TransientModel` `l10n_ba.partner.dedup` sa wizard formom:

1. Polje *Pretraga po imenu (dio teksta)* — bilo koji substring, case-insensitive
2. Klik na *Pretraži* → SQL `name ilike '%fragment%' AND active=True`, do 200 rezultata
3. Lista pronađenih partnera (tree) sa kolonama: ime, PDV ID, JIB, grad, e-mail, broj bankovnih računa, **score**
4. Korisnik označava (boolean toggle) one koji su zapravo isti subjekt
5. Wizard live računa predloženog pobjednika i HTML plan
6. Klik na *Spoji označene* → otvara upstream wizard sa već pre-popunjenim partner_ids i dst_partner_id

Menu: **Kontakti → Konfiguracija → Pronađi duplikate**.

### Komponenta 3: arhiviranje gubitnika

Upstream završava svoju `_merge` metodu sa `src_partners.unlink()`. Override-uje se preko context flaga:

```python
# u wizard-u, prije poziva super:
return super(...)._merge(
    self.with_context(l10n_ba_archive_on_merge=True), ...)

# u res.partner:
def unlink(self):
    if self.env.context.get('l10n_ba_archive_on_merge'):
        return self.write({'active': False})
    return super().unlink()
```

Tako da `unlink` na loser-ima postaje `active=False`. Zapisi ostaju u bazi, neaktivni; `active=True` query-ji ih preskaču ali su dostupni za forenziku i reaktivaciju.

### Komponenta 4: cross-modulna FK preusmjeravanja (već u upstream-u)

Ovo NIŠTA mi ne pišemo — upstream `_update_foreign_keys` to već radi savršeno. Mehanizam je SQL introspekcija:

```sql
SELECT conrelid::regclass::text, attname
  FROM pg_constraint c
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
 WHERE contype = 'f' AND confrelid = 'res_partner'::regclass;
```

Vraća sve FK kolone u svim instaliranim modulima koje pokazuju na `res.partner`. Onda izda `UPDATE <table> SET <col> = <winner_id> WHERE <col> IN <loser_ids>` za svaku.

U test instanci `banke-izvodi-test.hodi.ba` to je 70+ FK kolona — uključujući:

- **Računovodstvo**: `account_move.partner_id`, `account_move_line.partner_id`, `account_payment.partner_id`, `account_bank_statement_line.partner_id`, `account_analytic_line.partner_id`
- **Nabavka**: `purchase_order.partner_id`, `purchase_order_line.partner_id`, `product_supplierinfo.partner_id`
- **Skladište**: `stock_picking.partner_id`, `stock_move.partner_id`, `stock_warehouse.partner_id`, `stock_warehouse_orderpoint.vendor_id`
- **Mail**: `mail_followers.partner_id`, `mail_message.author_id`, `mail_activity.request_partner_id`
- **Plaćanje**: `payment_token.partner_id`, `payment_transaction.partner_id`
- **Naši custom moduli**: `account_reconcile_model.bank_pdf_partner_id`, `bill_ocr_log.partner_id`

Svaki novi modul koji se instalira (mrp, hr, sale, project, expense — bilo šta sa `Many2one('res.partner')`) **automatski** ulazi u sweep bez izmjene koda.

## Live test

Tri partnera istog imena različite potpunosti:

| Partner | VAT | JIB | Adresa | Banke | Žurnal | Score |
|---|---|---|---|---|---|---|
| poor | — | — | — | 0 | ne | **0** |
| medium | — | — | grad + telefon | 0 | ne | **3** |
| rich | ✓ | ✓ | puna BiH adresa | 1 | ne | **31** |

Plant cross-modulne reference samo na `poor`:

| FK | Prije | Poslije |
|---|---|---|
| `res.partner.bank.partner_id` | poor=1, rich=0 | **0 / 1** ✓ |
| `purchase.order.partner_id` | poor=1, rich=0 | **0 / 1** ✓ |
| `account.move.partner_id` | poor=1, rich=0 | **0 / 1** ✓ |

Stanje gubitnika u bazi:

```
poor.active = False  ✓ (arhiviran, ne obrisan)
rich.active = True   ✓
```

Sve reference koje su prije pokazivale na `poor` sada pokazuju na `rich`. `poor` je arhiviran ali postoji u DB-u za audit.

## Workflow u praksi

1. Nakon fetchmail batch-a koji je auto-kreirao više kopija istog dobavljača, otvoriti **Kontakti → Konfiguracija → Pronađi duplikate**.
2. Unijeti dio imena (`dent`, `sarajevo`, `gradilište` — bilo šta).
3. Klik *Pretraži* → lista do 200 partnera koji u imenu sadrže taj substring.
4. Označiti one koji su isti pravni subjekt (boolean toggle u tree-u).
5. Live se računa predloženi pobjednik (najveća ocjena potpunosti).
6. Klik *Spoji označene* → otvara upstream wizard pre-popunjen.
7. Provjeriti odredište (može se ručno mijenjati), klik *Merge*.
8. Sve reference se preusmjeravaju, gubitnici se arhiviraju.

Alternativno: na bilo kom partner formu koji ima duplikate (smart-button *Spoji duplikate* sa brojačem) — klik direktno otvara wizard sa svim partnerima istog imena.

## Napomena

Generisano od strane Claude 🤖

---

Ernad Husremović, hernad@bring.out.ba
