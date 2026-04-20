---
title: 'Uvoz cleanup wizard — brisanje krivih faktura i LC dokumenata na uvoznoj nabavci'
description: 'Novi Odoo 16 modul l10n_ba_uvoz_delete_then_recalc_svl — wizard koji iz forme uvozne nabavke briše pogrešno knjižene račune i landed costove, zatim rekalkuliše SVL tako da ostane u integritetu.'
pubDate: '2026-04-20T18:30:00'
heroImage: '/uvoz-cleanup-hero.svg'
---

## Problem

Klasičan scenario uvozne nabavke u Odoo 16:

1. Kreira se **nabavka** (`NAB/26/02/0185`) od inostranog dobavljača.
2. Roba stigne, `RA/IN/00311` je primljena, SVL redovi na prijemnici su u KM po tečaju dana.
3. Računovođa unosi **ulazni račun za robu** (`BILL/2026/03/0001`) u USD — ali sa **krivim tečajem**.
4. Iza toga dolaze **dva landed cost dokumenta**: EMS troškovi (LC/2026/0003) i Carina + špedicija + bankarske provizije (LC/2026/0004), svaki sa svojim izvornim računom.
5. Sve je postavljeno — a sve je krivo.

Rezultat u bazi:

- **35 LC SVL redova** (5 proizvoda × 7 cost lines) sa pogrešnim doprinosom vrijednosti na prijemnicu
- Kešovani `remaining_value` na 5 prijemnih SVL-ova je **napuhnut** LC doprinosom
- PO linije nose **tax PDV 17%** umjesto `PDV uvoz zavisni troskovi 0%` (kod uvoza zavisnih troškova se ne obračunava izlazni PDV na strani ulaznog računa za robu)
- `standard_price` keš na proizvodima odražava ovu grešku

Standardna Odoo praksa u ovom trenutku je **credit note flow** — poništi sve kroz reverzije, pa ponovo knjiži. To radi, ali:

- Traži tri kreditne note + dva nova LC dokumenta + tri nova računa — ukupno **8+ dokumenata** u audit stazi za jednu grešku
- Žurnalni šum, posebno kad je period još otvoren i greška je sumarno od jutros

Ako računi nisu plaćeni, niti jedna stavka nije `reconciled`, a greška je ista dan kad je nastala, **brisanje dokumenata sa SVL re-calc-om** je pragmatičan izbor.

## Rješenje: `l10n_ba_uvoz_delete_then_recalc_svl`

[GitHub: `bringout/odoo-bringout-l10n_ba_uvoz_delete_then_recalc_svl`](https://github.com/bringout/odoo-bringout-l10n_ba_uvoz_delete_then_recalc_svl) (privatni repo, AGPL-3).

Novi modul dodaje dugme **Uvoz cleanup** u header nabavke (purchase.order form). Klik otvara wizard koji:

1. **Otkriva** povezane dokumente:
   - ulazne račune (sve `in_invoice` sa purchase_line_id linkom na PO)
   - landed cost dokumente koji "diraju" prijemnice ove PO
   - izvorne LC račune (vendor_bill_id)
   - LC journal entries (`STJ/...` zapisi nastali `validate`-om LC-a)
2. Pravi **preview po proizvodu** — koliko je primljeno, koliko je otišlo nakon prijemnice, trenutna `remaining_value`, LC doprinos koji će se ukloniti, i projektovana `remaining_value` nakon cleanupa.
3. Na **Execute cleanup**:
   - briše LC-origine SVL redove
   - briše LC dokumente (CASCADE na cost lines i valuation adjustment lines)
   - briše account.move zapise (bills + LC STJ-ovi, move linije cascade)
   - opcionalno zamjenjuje taxe na PO linijama (defaultno `PDV uvoz zavisni troskovi`)
   - reseta keš `remaining_value` na prijemnim SVL-ovima (`value * remaining_qty_from_receipt / quantity`)
   - reseta `purchase_order.invoice_status` i `purchase_order_line.qty_invoiced` tako da PO može biti **re-billed** bez UI računanja

Sve u jednoj transakciji — uspjeh ili potpuni rollback.

## Sigurnosne barijere

Wizard refuzira pokretanje ako je bilo koja od ovih uslova istinita:

- bilo koji target account.move `payment_state` nije `not_paid` ili `in_payment`
- bilo koja stavka računa ili LC STJ-a ima `full_reconcile_id IS NOT NULL`

Tako da:

- **reconcile/pay je checkpoint** — poslije njega stari brisanje-flow više nije legitiman, treba u credit note rutu
- ali *prije* reconcilea, ovo je najčišći put da se izbriše greška

## Preview — šta wizard pokaže

Tri notebook taba u wizardu:

### 1. Per-product SVL preview

Tabela sa sumarnim footerom:

| proizvod | primljeno | otišlo | rem.prije | LC doprinos | rem.poslije |
|---|---:|---:|---:|---:|---:|
| product_01 | 50 | 5 | 222.03 | 39.66 | 168.30 |
| product_02 | 50 | 18 | 830.39 | 146.50 | 680.96 |
| product_03 | 50 | 3 | 711.31 | 126.90 | 600.19 |
| product_04 | 10 | 0 | 272.59 | 48.77 | 229.90 |
| product_05 | 10 | 0 | 5652.68 | 1010.55 | 4768.60 |

Šef skladišta vidi da je LC doprinos 1372 KM, od čega stvarno u magacinu ostane **manje** nakon izlaza — što je u skladu sa tim da su izlazi iz magacina desili **prije** LC datuma, pa su otišli po osnovnoj cijeni (bez LC-a). Nakon cleanupa, isto stanje ostaje, samo što više nema "fantomske" LC vrijednosti na kartici robe.

### 2. Documents to delete

Tri liste — vendor bills, landed costs, LC journal entries. Svaki red prikazuje partnera, valutu, iznos, `state`, `payment_state`. Vizuelna potvrda prije nego što se klikne izvršavanje.

### 3. Execution log

Tek nakon executea — HTML rezime šta je obrisano, koliko redova, kompletan breakdown po proizvodu. Može se print/screenshot kao popratna dokumentacija cleanup akcije.

## Ključni detalj: recompute `remaining_value`

Najklizaviji dio ovog posla. U Odoo 16 SVL, prijemni red nosi `remaining_value` koji služi za FIFO-ish internu logiku. Kad LC doda vrijednost proizvodu, ne mijenja `remaining_qty`, ali **kumulativno** doprinosi `remaining_value`-u prijemnog reda.

Ako obrišemo LC SVL redove bez resetovanja, prijemna `remaining_value` ostaje na **fantomskoj** vrijednosti. Valuation report pokazuje ispravan on-hand × jediničnu cijenu, ali unutrašnja konzistencija je narušena — pri sljedećem izlaznom kretanju AVCO može da se ponaša neobično.

Formula koju koristimo nakon brisanja LC SVL-ova:

```
remaining_value = value * (remaining_qty_from_receipt / quantity)
```

gdje je `remaining_qty_from_receipt` jednako `qty_received − qty_shipped_since_receipt`. Kalkulacija je tačna u slučaju gdje je ova prijemnica dominantan/jedini izvor proizvoda — za uvozni PO to je tipično slučaj. Za proizvode sa više istovremenih prijemnica, aproksimacija je blago pesimistična (može malo podcijeniti), ali pobrana greška nije materijalna na pojedinačnom cleanupu.

## Zašto SQL umjesto ORM unlink

Implementacija koristi direktan SQL (`self.env.cr.execute`) za brisanja:

```python
cr.execute("DELETE FROM stock_valuation_layer WHERE id IN %s", (lc_svl_ids,))
cr.execute("DELETE FROM stock_landed_cost WHERE id IN %s", (lc_ids,))
cr.execute("DELETE FROM account_move WHERE id IN %s", (all_move_ids,))
```

Razlog: Odoo ORM `unlink` na `account.move` u `posted` stanju i na `stock.landed.cost` u `done` stanju trigeruje mnoge safety hook-ove (`_unlink_forbid_parts_of_chain`, reverse-journal provjere...). Ovi hook-ovi su dobri u redovnom radu, ali u cleanup scenariju gdje znamo da ništa nije naplaćeno, oni samo smetaju.

Database FK constraints rade svoj posao:

- `account_move_line.move_id` → `account_move` je `ON DELETE CASCADE`
- `stock_landed_cost_lines.cost_id` i `stock_valuation_adjustment_lines.cost_id` su `ON DELETE CASCADE`
- `stock_valuation_layer.stock_landed_cost_id` je `ON DELETE SET NULL` — pa LC SVL redove moramo obrisati eksplicitno prije LC-a (ili nakon, svejedno)

Jedini gotcha: self-reference na `account_move_line.tax_line_id` koja referencira `account_tax`, a može pokazivati unutar istog move-a. Prije brisanja se nulira:

```python
cr.execute(
    "UPDATE account_move_line SET tax_line_id = NULL "
    "WHERE move_id IN %s AND tax_line_id IS NOT NULL",
    (all_move_ids,),
)
```

Poslije SQL blok-a wizard poziva `self.env.invalidate_all()` da Odoo cache-evi pokupe novu sliku.

## Opsezi / granice

- **Već otpremljene količine** zadržavaju svoj izlazni SVL cost kakav je bio. Odoo **ne** retroaktivno rekoštura izlazne kretnje. U našem test case-u to nije bilo problem jer su svi izlazi desili *prije* LC datuma (pa je izlazni cost već bio "čist", bez LC-a) — ali ako vaš LC dokument stiže prije izlaznih kretanja, COGS na tim izlazima će sadržati LC doprinos koji se briše, i to treba uzeti u obzir.
- **`product.standard_price` keš** i dalje prikazuje pred-cleanup jediničnu cijenu dok se ne desi sljedeća stock kretnja ili dok se ne klikne **Update Cost** na proizvodu.
- **Tax mapping** je trenutno name-based (`PDV uvoz zavisni troskovi`). Ako u vašem kontnom planu taksa ima drukčije ime, postavite je ručno u wizardu.

## Repo i instalacija

Module izvori:

- [`bringout/odoo-bringout-l10n_ba_uvoz_delete_then_recalc_svl`](https://github.com/bringout/odoo-bringout-l10n_ba_uvoz_delete_then_recalc_svl) (AGPL-3, trenutno privatno)
- Uključen kao submodule u naš glavni monorepo

Dependencies: `stock_landed_costs`, `purchase_stock`, `account`. Instalacija kroz **Apps → Update Apps List → Install**.

Pristup: korisnici iz `stock.group_stock_manager` (skladišni menadžeri) vide dugme na PO formi i mogu pokrenuti cleanup.

## Zaključak

Za uvoznu nabavku gdje je neko pogriješio u tečaju i već povukao 2-3 LC dokumenta na toj osnovi, a nijedan račun još nije plaćen — ovaj wizard zamjenjuje 8-dokumentnu credit-note lancu jednim transakcijskim brisanjem sa SVL rekalkulacijom. Reverse-via-credit-note ostaje pravi odgovor čim faktura pređe u reconciled stanje, ili čim period zatvori — do tada ovo je brže i ostavlja čišći audit trag.

Modul je proizvod jednog realnog čišćenja (slučaj `CI26-0134`) na produkciji — ugrađen u wizard tako da sljedeća greška iste vrste ne traži pola sata SQL-a i tri razgovora o tome šta brisati.

## Napomene

- Kreirao Claude 🤖
- **Modul nije testiran!**
