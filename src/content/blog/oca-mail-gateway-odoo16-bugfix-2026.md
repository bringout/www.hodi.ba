---
title: 'Popravke OCA mail_gateway modula za Odoo 16'
description: 'Dva buga koja smo pronašli i popravili u OCA mail_gateway modulu: Werkzeug 3.x charset kompatibilnost i Odoo 16 OWL selection field validacija'
pubDate: '2026-04-12T16:00:00'
heroImage: '/oca-bugfix-hero.svg'
---

Prilikom integracije [Telegram bota sa Odoo 16](/blog/odoo-telegram-integracija-2026/) koristeći OCA `mail_gateway` modul, naišli smo na dva buga koji sprečavaju normalan rad. Oba su popravljena u našem forku: [bringout/odoo-bringout-oca-social](https://github.com/bringout/odoo-bringout-oca-social/commit/0a14b48362f16f3820c0bdaf9b2a6648e362ef15).

## Bug 1: Werkzeug 3.x — `request.charset` ne postoji

### Simptom

Telegram šalje poruku botu, webhook stiže do Odoo servera, ali odgovor je **HTTP 500**. U logovima:

```
AttributeError: 'Request' object has no attribute 'charset'
File ".../mail_gateway/controllers/gateway.py", line 52, in post_update
```

### Uzrok

OCA modul koristi `request.httprequest.charset` za dekodiranje tijela zahtjeva:

```python
jsonrequest = json.loads(
    request.httprequest.get_data().decode(request.httprequest.charset)
)
```

U Werkzeug 3.x, atribut `charset` je [uklonjen](https://werkzeug.palletsprojects.com/en/3.0.x/changes/#version-3-0-0) jer Werkzeug sada interno koristi UTF-8. Naš Odoo 16 build koristi Werkzeug 3.0.6 koji više nema ovaj atribut.

### Popravka

Jednostavan `getattr` fallback na `"utf-8"`:

```python
jsonrequest = json.loads(
    request.httprequest.get_data().decode(
        getattr(request.httprequest, "charset", "utf-8")
    )
)
```

Ovo radi sa svim verzijama Werkzeug-a — ako `charset` postoji koristi ga, inače defaultira na UTF-8 (što je ionako jedini charset koji Telegram koristi).

**Fajl:** [`mail_gateway/controllers/gateway.py`](https://github.com/bringout/odoo-bringout-oca-social/blob/0a14b48362f16f3820c0bdaf9b2a6648e362ef15/mail_gateway/controllers/gateway.py#L51-L54)

---

## Bug 2: Odoo 16 OWL — "Invalid fields: Gateway Type"

### Simptom

Kreiranje novog Gateway zapisa u Odoo UI-u. Popunite sva polja, odaberete "Telegram" kao Gateway Type, kliknete Save — toaster notifikacija:

> **Invalid fields: Gateway Type**

Zapis se ne može snimiti. Server ne prijavljuje grešku — validacija pada na klijentskoj strani (u browseru).

### Uzrok

Ovo je poznati Odoo 16 bug: [odoo/odoo#184664](https://github.com/odoo/odoo/issues/184664).

Problem je u OWL komponenti `SelectionField`. Kada je selection polje **required** i ima samo jednu opciju (u našem slučaju samo "Telegram"), HTML `<select>` element vizualno prikazuje tu opciju kao odabranu, ali `onChange` event se **nikada ne okine**. Interno, vrijednost polja ostaje `False`.

Konkretno, u `selection_field.xml`:

```xml
<option
    t-if="!isRequired"
    t-att-selected="false === value"
    t-att-value="stringify(false)"
    t-esc="this.props.placeholder || ''"
/>
```

Kada je polje required (`isRequired = true`), prazna opcija se uklanja iz DOM-a. Browser automatski "selektuje" prvu preostalu opciju vizualno, ali bez `onChange` eventa — Odoo form model nikad ne dobije vrijednost.

### Popravka

QWeb template override koji vraća praznu opciju kada polje nema vrijednost, čak i ako je required:

```xml
<t t-name="web.SelectionField" t-inherit="web.SelectionField" owl="1">
    <xpath expr="//option[1]" position="attributes">
        <attribute name="t-if">!isRequired or !value and value !== 0</attribute>
    </xpath>
</t>
```

Logika: prikaži praznu opciju ako polje **nije required** ILI ako **nema vrijednost** (a nije nula). Korisnik mora eksplicitno kliknuti na opciju, što okida `onChange` i ispravno postavlja vrijednost.

Ovaj fix je implementiran kao Odoo modul override (QWeb template inheritance), ne kao patch na Odoo izvorni kod — čistije rješenje koje preživljava Odoo nadogradnje.

**Fajl:** [`mail_gateway/static/src/views/fields/selection/selection_field.xml`](https://github.com/bringout/odoo-bringout-oca-social/blob/0a14b48362f16f3820c0bdaf9b2a6648e362ef15/mail_gateway/static/src/views/fields/selection/selection_field.xml)

---

## Commit i linkovi

- **Commit:** [0a14b48](https://github.com/bringout/odoo-bringout-oca-social/commit/0a14b48362f16f3820c0bdaf9b2a6648e362ef15) — Fix Werkzeug charset compat and Odoo 16 selection field validation bug
- **Repozitorij:** [bringout/odoo-bringout-oca-social](https://github.com/bringout/odoo-bringout-oca-social) (branch `16.0`)
- **Upstream issue:** [odoo/odoo#184664](https://github.com/odoo/odoo/issues/184664)
- **Upstream OCA:** [OCA/social](https://github.com/OCA/social) (branch `16.0`)

## Kako primijeniti popravke

Ako koristite OCA `mail_gateway` na Odoo 16 sa Werkzeug 3.x, možete preuzeti naš fork ili primijeniti promjene ručno — radi se o ukupno 3 fajla i manje od 30 linija koda.

## Napomena

Generisano od strane Claude 🤖

--
hernad@bring.out.ba
