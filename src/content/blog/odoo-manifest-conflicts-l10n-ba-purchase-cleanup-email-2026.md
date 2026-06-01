---
title: 'Odoo manifest - "conflicts" sekcija primjer'
description: 'Kako conflicts ključ u __manifest__.py sprečava instalaciju oba modula istovremeno — objašnjenje na primjeru preimenovanja l10n_purchase_cleanup_email u l10n_ba_purchase_cleanup_email.'
pubDate: '2026-06-01T18:00:00'
heroImage: '/odoo-manifest-conflicts-hero.svg'
---

Svaki Odoo modul ima `__manifest__.py` fajl koji opisuje modul: ime, verziju, zavisnosti i druge metapodatke. Jedan ključ koji se rjeđe koristi, a iznimno je koristan pri preimenovanju modula, jeste **`conflicts`**.

---

## Šta radi `conflicts`?

```python
"conflicts": ["l10n_purchase_cleanup_email"],
```

Ovaj ključ govori Odoo upgrade manageru:

> „Ako je modul **l10n_purchase_cleanup_email** već instaliran u bazi, **ne dozvoli** instalaciju mog modula dok se taj ne ukloni."

Radi se o međusobnoj ekskluzivnosti — dva modula koji rade istu stvar ne smiju biti aktivni u isto vrijeme. Odoo će pri pokušaju instalacije baciti grešku i odbiti nastavak.

---

## Zašto je `conflicts` dodan u `l10n_ba_purchase_cleanup_email`?

### Historijat

Modul je originalno razvijen pod imenom **`l10n_purchase_cleanup_email`**. Konvencija za bringout module je da svi bosanski lokalizacijski moduli imaju prefiks `l10n_ba_`, pa je modul preimenovan u **`l10n_ba_purchase_cleanup_email`**.

Commit koji je uveo promjenu:

```
update: odoo-bringout-l10n_ba_purchase_cleanup_email
rename: l10n_purchase_cleanup_email → l10n_ba_purchase_cleanup_email + conflicts guard
```

### Problem bez `conflicts`

Bez ovog ključa, baza koja ima instaliran stari modul `l10n_purchase_cleanup_email` mogla bi imati **oba modula** aktivna istovremeno — jer Odoo ne zna da su isti kod. Rezultat bi bio:

- dupla `write()` override logika na `purchase.order`
- dupla `action_rfq_send()` dekoracija
- nejasni chatter poruke od dva izvora
- potencijalni konflikti u `message_unsubscribe` pozivima

### Rješenje: `conflicts` kao zaštitna ograda

```python
# l10n_ba_purchase_cleanup_email/__manifest__.py
"conflicts": ["l10n_purchase_cleanup_email"],
```

Sada, ako neko pokuša instalirati novi modul na bazu gdje stari još uvijek stoji, Odoo odbija instalaciju s jasnom porukom. Administrator mora prvo deinstalirati `l10n_purchase_cleanup_email`, a tek onda instalirati `l10n_ba_purchase_cleanup_email`.

---

## Šta radi sam modul?

`l10n_ba_purchase_cleanup_email` rješava problem **cross-contamination emailova** pri promjeni dobavljača na RFQ-u (Request for Quotation).

### Problem

1. RFQ kreiran za Dobavljač A → email poslan, Dobavljač A postaje follower.
2. `partner_id` promijenjen na Dobavljač B → „Send by email" šalje **i Dobavljaču B i Dobavljaču A** (oba su i dalje u `mail.followers`).
3. Nakon 3-4 promjene dobavljača, svaki od njih dobija emailove namijenjene drugima.

### Fix u dva sloja

**Sloj A — `write()` override:**

Kada se `partner_id` promijeni na narudžbi u `draft` ili `sent` stanju, stari dobavljač se automatski uklanja iz `mail.followers`, a novi se dodaje:

```python
def write(self, vals):
    if "partner_id" not in vals:
        return super().write(vals)
    # pamti stare partnere prije write-a
    # nakon write-a: unsubscribe stari, subscribe novi
```

**Sloj B — `action_rfq_send()` override:**

Neposredno prije otvaranja wizard-a za slanje emaila, vrši se „obrambeni sweep" — svi vanjski partneri koji nisu trenutni `partner_id` uklanjaju se iz followera:

```python
def action_rfq_send(self):
    # ukloni sve external followere koji nisu trenutni vendor
    # dodaj trenutnog partnera ako već nije follower
    return super().action_rfq_send()
```

Interni korisnici (operatori) ostaju u followerima u oba sloja.

---

## Kada koristiti `conflicts`?

| Situacija | Treba `conflicts`? |
|-----------|-------------------|
| Preimenovanje modula | ✅ Da |
| Fork modula koji radi istu stvar | ✅ Da |
| Modul koji zamjenjuje community verziju | ✅ Da |
| Modul koji proširuje drugi modul | ❌ Ne (koristiti `depends`) |
| Dva nezavisna modula | ❌ Ne |

Pravilo je jednostavno: ako oba modula aktivna istovremeno mogu prouzrokovati duplikate, konflikte ili nedefinirano ponašanje — dodaj `conflicts`.

---

## Struktura finalnog manifesta

```python
{
    "name": "Purchase: cleanup previous vendor followers",
    "version": "16.0.1.1.0",
    "category": "Purchases",
    "author": "bring.out d.o.o. Sarajevo",
    "website": "https://www.bring.out.ba",
    "license": "AGPL-3",
    "depends": ["purchase"],
    "conflicts": ["l10n_purchase_cleanup_email"],
    "installable": True,
    "application": False,
    "auto_install": False,
}
```

`depends` i `conflicts` su komplementarni: `depends` kaže „trebam ovo", `conflicts` kaže „ne mogu živjeti pored ovoga".

---

## Napomena

Generisano od strane Claude 🤖

---

Ernad Husremović, hernad@bring.out.ba
