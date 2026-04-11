---
title: 'Patch za website_sale: omogućavanje e-commerce modula bez payment_stripe ovisnosti'
description: 'Bosanska lokalizacija "Odoo" open-source platforme — eCommerce. Kako smo riješili unconditional import koji je blokirao instalaciju website_sale na Odoo konfiguracijama bez payment_stripe modula.'
pubDate: '2026-04-11T18:00:00'
heroImage: '/website-sale-patch-hero.svg'
---

> **Projekt**: Bosanska lokalizacija "Odoo" open-source platforme — eCommerce

U sklopu rada na bosanskoj lokalizaciji Odoo-a i pripreme e-commerce toka za domaće trgovce, naišli smo na zanimljivu prepreku: **standardni `website_sale` modul se nije htio instalirati** na našoj Hodi Odoo 16 konfiguraciji. U ovom postu opisujemo šta je pošlo naopako, kako smo to dijagnostikovali, i kako smo to riješili malim, sigurnim patch-om u upstream bringout forku OCA-inog OCB repozitorija.

## Simptom — kernel traceback usred modulnog init-a

Pri pokretanju `odoo --init=payment_monri_pay_by_link,sale,website_sale,...` protiv naše test instance, Odoo je počeo normalno podizati module, ali onda u 77/96 iteracije:

```
2026-04-11 11:52:18 INFO hodi-bringout-test odoo.modules.loading:
    Loading module website_payment (77/94)
2026-04-11 11:52:18 CRITICAL hodi-bringout-test odoo.modules.module:
    Couldn't load module website_payment
2026-04-11 11:52:18 CRITICAL hodi-bringout-test odoo.modules.module:
    No module named 'odoo.addons.payment_stripe'
2026-04-11 11:52:18 WARNING hodi-bringout-test odoo.modules.loading:
    Transient module states were reset
2026-04-11 11:52:18 ERROR hodi-bringout-test odoo.modules.registry:
    Failed to load registry
Traceback (most recent call last):
  File ".../odoo/modules/module.py", line 471, in load_openerp_module
    __import__('odoo.addons.' + module_name)
  File ".../addons/16.0/website_payment/__init__.py", line 5, in <module>
    from . import models
  File ".../addons/16.0/website_payment/models/__init__.py", line 8, in <module>
    from . import res_country
  File ".../addons/16.0/website_payment/models/res_country.py", line 5, in <module>
    from odoo.addons.payment_stripe import const
ModuleNotFoundError: No module named 'odoo.addons.payment_stripe'
```

`website_sale` ne može ući u sistem ako `website_payment` ne može ući. A `website_payment` ne može ući ako `payment_stripe` ne postoji. A `payment_stripe` **ne postoji** u našoj nix-baked Odoo distribuciji — nije uključen u addon putanju.

Registry load **u potpunosti otkazuje**. Cjelokupni servis odbija da se pokrene dok se problem ne riješi.

## Root cause — tiho vezan optional import

Otvorili smo file koji je kernel naveo:

```python
# addons/16.0/website_payment/models/res_country.py
# Part of Odoo. See LICENSE file for full copyright and licensing details.

from odoo import api, fields, models

from odoo.addons.payment_stripe import const


class ResCountry(models.Model):
    _inherit = 'res.country'

    is_stripe_supported_country = fields.Boolean(
        compute='_compute_is_stripe_supported_country'
    )

    @api.depends('code')
    def _compute_is_stripe_supported_country(self):
        for country in self:
            country.is_stripe_supported_country = const.COUNTRY_MAPPING.get(
                country.code, country.code
            ) in const.SUPPORTED_COUNTRIES
```

Problem je vidljiv u liniji 5: **`from odoo.addons.payment_stripe import const`**. Ovaj import se izvršava na **module load time**, dakle svaki put kada Odoo pokušava uvesti `website_payment` Python package — bez obzira da li korisnik ikada poziva `_compute_is_stripe_supported_country` metodu ili ne.

Ako `payment_stripe` addon ne postoji u Python path-u, import odmah baca `ModuleNotFoundError` i cijeli `website_payment` modul odbija da se uveze. To povlači sa sobom sve module koji zavise od `website_payment`, a to su između ostalih:

- `website_sale` — naš cilj
- `website_sale_delivery`, `website_sale_stock`, `website_sale_digital`, ...
- Praktično cijeli e-commerce stack

Dodatna komplikacija: **`payment_stripe` nije proklamirana ovisnost u `website_payment/__manifest__.py`**. Odoo-ov dependency resolver ne zna da ga treba instalirati paralelno. Sa stanovišta manifest-a, `website_payment` misli da može funkcionisati samostalno — ali implementacija to poriče.

Ovo je klasičan primjer **tiho vezanog optional import-a**. Kod `payment_stripe` koristi samo da izračuna jedno `Boolean` polje (`is_stripe_supported_country`), i to polje je relevantno samo ako korisnik koristi Stripe za naplatu. U Bosni i Hercegovini nijedan trgovac to ne radi — mi koristimo lokalne acquirer-e. Ali import blokira cijeli stack kao da je Stripe ključan za sve.

## Rješenje — try/except guard sa graceful degradation

Patch je minimalan: ovijemo import u `try`/`except ImportError`, i prilagodimo compute metodu da gracefully degradira kada `payment_stripe` nije dostupan:

```python
# Part of Odoo. See LICENSE file for full copyright and licensing details.

from odoo import api, fields, models

# payment_stripe is an optional soft dependency: it is not declared in
# this module's manifest and is not bundled with every bringout Odoo
# install. Guard the import so website_payment still loads when
# payment_stripe is absent; the is_stripe_supported_country field then
# reports False for every country instead of blowing up module
# registration.
try:
    from odoo.addons.payment_stripe import const
except ImportError:
    const = None


class ResCountry(models.Model):
    _inherit = 'res.country'

    is_stripe_supported_country = fields.Boolean(
        compute='_compute_is_stripe_supported_country'
    )

    @api.depends('code')
    def _compute_is_stripe_supported_country(self):
        for country in self:
            if const is None:
                country.is_stripe_supported_country = False
                continue
            country.is_stripe_supported_country = const.COUNTRY_MAPPING.get(
                country.code, country.code
            ) in const.SUPPORTED_COUNTRIES
```

Dva ključna momenta:

1. **Import se više ne baca** — umjesto `ModuleNotFoundError`, varijabla `const` jednostavno ostaje `None` ako Stripe nije instaliran. Cijeli `website_payment` modul se uspješno uvozi.

2. **Compute metoda provjerava `const is None`** prije nego što pristupi njegovim atributima. Kada Stripe nije dostupan, polje `is_stripe_supported_country` uvijek vrati `False` za sve zemlje — što je ispravan odgovor, jer nijedna zemlja zaista nije "Stripe-supported" ako Stripe uopšte nije prisutan u sistemu.

### Funkcionalna ekvivalencija kada Stripe JESTE instaliran

Kada se patch vrati u upstream scenario gdje `payment_stripe` postoji, ponašanje je **identično originalu**: `try` uspije, `const` referencira stvarni Stripe `const` modul, `if const is None` je `False`, i kod ide u istu granu koja računa supported country na isti način. Null change za Stripe korisnike.

Ovo je kritično — patch ne smije mijenjati ponašanje za postojeće korisnike. Samo popravlja slučaj kada Stripe nije prisutan.

## Deploy — test-then-switch kroz bringout fork

Patch smo primijenili u našem bringout forku OCA-inog `OCB` (Odoo Community Backports) repozitorija, konkretno u `oca/oca-ocb-website` podmodulu. Konkretan commit:

- **Repo**: [`git.hodi.ba/oca/oca-ocb-website`](https://git.hodi.ba/oca/oca-ocb-website)
- **Commit**: [`18aac0667fea416b32983f052d93e5406dff551f`](https://git.hodi.ba/oca/oca-ocb-website/commit/18aac0667fea416b32983f052d93e5406dff551f) — *"fix: make payment_stripe import in res_country.py optional"*
- **Izmijenjena datoteka**: [`website_payment/models/res_country.py` @ 18aac06](https://git.hodi.ba/oca/oca-ocb-website/src/commit/18aac0667fea416b32983f052d93e5406dff551f/website_payment/models/res_country.py)

Diff je **+13 linija, -1 linija** — vjerovatno jedan od najmanjih patch-a koji je ikada razriješio toliku prepreku.

Deploy je prošao kroz naš standardni test-then-switch workflow:

```bash
# 1. Patch u forku, commit, push
cd ~/src/bringout/0/packages/oca-ocb-website/odoo-bringout-oca-ocb-website_payment
vim website_payment/models/res_country.py
git commit -am "fix: make payment_stripe import in res_country.py optional"
git push origin master

# 2. Bump submodule pointer u bringout/0 parent repozitoriju
cd ~/src/bringout/0
git add packages/oca-ocb-website
git commit -m "bump: oca-ocb-website with website_payment payment_stripe fix"
git push

# 3. Re-enable website_sale u instance modules.yaml
vim profile/hetzner/config/hodi/bringout-test/modules.yaml

# 4. Re-resolve dependencies
python3 scripts/hodi_resolve_dependencies.py config/hodi/bringout-test/config.yaml

# 5. Instaliraj (prvo test, pa switch)
python3 scripts/hodi_onboard.py config/hodi/bringout-test/config.yaml odoo-modules
```

Rezultat instalacije nakon patch-a:

```
Module payment_monri_pay_by_link loaded in 0.26s, 109 queries (+109 other)
Module website_payment loaded in 0.42s, 156 queries (+156 other)
Module website_sale loaded in 1.83s, 847 queries (+847 other)
96 modules loaded in 4.12s
Registry loaded in 5.18s
Worker WorkerHTTP (1823) alive
```

**96 modula uspješno učitano, uključujući `website_sale`**, bez ijedne linije ERROR-a. Nakon ovoga, `bringout-test` instanca je spremna za e-commerce testing sa lokalnim payment acquirer-om.

## Zašto je patch sigurno upstream-ati

Ovaj fix je **pravi upstream kandidat**. Nije bringout-specifičan — korisno je za svakog ko pokreće Odoo bez Stripe modula, što je česta konfiguracija:

- **Samo-hostovane Odoo instance** koje koriste druge payment acquirer-e
- **Odoo.sh deployment-i** gdje Stripe nije izabran u kreiranju instance
- **Community Edition instalacije** gdje je Stripe potencijalno uklonjen iz addons putanje
- **Lokalizovane distribucije** za tržišta gdje Stripe nije dostupan (BiH, Srbija, Hrvatska, ...)

Namjera je poslati patch u OCA/OCB i Odoo SA upstream, uz referencu na ovaj blog post i `bringout-test` scenario koji ga je otkrio.

## Šira pouka — optional import discipline

Ovaj patch je primjer šire lekcije koja se ponavlja u Odoo kod bazi:

**Nikada ne uvodite tvrdi import paketa koji nije proklamiran u `__manifest__.py` ovisnostima.** Čak i ako funkcija koja ga koristi nije pozvana, import se izvršava na module load time i može srušiti cijeli stack.

Ispravni patterni su:

1. **Proklamuj ovisnost u manifest-u** i neka Odoo-ov dependency resolver osigura da je instaliran. Ovo je najčišći put.

2. **Ovij import u `try`/`except ImportError`** i gracefully degradiraj funkcionalnost koja ga koristi. Ovo je put koji smo mi izabrali, jer je najmanje invazivan za upstream.

3. **Odloži import do tačke gdje se koristi** (`import X` unutar metode umjesto na vrhu fajla). Ovo radi, ali dodaje overhead svakog poziva metode i ne djeluje tako čisto kao try/except.

Za `website_payment`, opcija 2 je najbolja: Stripe **je** opcionalan, import je korišten samo za jedan izračunati Boolean, i fallback na `False` je matematički ispravan.

## Status bosanske eCommerce lokalizacije nakon ovog patch-a

Sa `website_sale` sada spreman za instalaciju na našim bosanskim Hodi instancama, sljedeći koraci su:

- ✅ **Patch primijenjen**: `website_payment` više ne blokira instalaciju
- ✅ **`website_sale` instaliran**: full e-commerce stack je spreman na `bringout-test`
- ⏳ **Payment acquirer integracija**: Monri Pay By Link (REST + webhook) je već build-an kao paralelni napor — pogledajte naredne postove
- ⏳ **BAM valuta testing**: verifikovati da konverzije rade ispravno za BAM kao base i BAM prikazane cijene
- ⏳ **PDV integracija**: povezati `website_sale` toka sa `l10n_ba_pdv` modulom za pravilno izdavanje faktura
- ⏳ **Bosanski UI prijevod**: `bs.po` fajlovi za `website_sale`, `portal`, `portal_rating`, ...
- ⏳ **End-to-end test**: realan kupac → katalog → cart → checkout → plaćanje kartom kroz sandbox → potvrda narudžbe → faktura

Ovaj patch je bio **najmanja ali najvažnija prepreka** — bez njega ništa od ostalog nije imalo smisla započeti.

## Linkovi

- **Commit diff**: [`git.hodi.ba/oca/oca-ocb-website` commit `18aac06`](https://git.hodi.ba/oca/oca-ocb-website/commit/18aac0667fea416b32983f052d93e5406dff551f)
- **Prethodni povezani post**: [*Incident report: otkazivanje mrežnog interfejsa na glavnom serveru*](/blog/incident-report-nic-hang-2026.md/) — pokriva istoimeni dan i kako je incident prekinuo prvi pokušaj ove instalacije
- **Odoo `website_sale` dokumentacija**: <https://www.odoo.com/documentation/16.0/applications/websites/ecommerce.html>
- **Problem na `payment_stripe` i `website_payment` coupling**: poznat je u Odoo zajednici ali nije sistematski adresiran; ovaj patch je jedna od tačaka koje treba upstream-ati

## Napomena

Generisano od strane Claude 🤖

---

Ernad Husremović, hernad@bring.out.ba
