---
title: 'Obavještenja o plaćanjima: Email + Telegram za Monri integraciju'
description: 'Tri nova Odoo 16 modula za obavještavanje kupaca i administratora o statusu Monri plaćanja — putem emaila, Telegrama, i sa automatskom detekcijom isteklih transakcija'
pubDate: '2026-04-12T18:00:00'
heroImage: '/monri-notify-hero.svg'
---

## Problem

Korisnik plati karticom putem [Monri](https://monri.com/) hosted stranice, ali šta dalje? Nema emaila, nema SMS-a, nema Telegram poruke. Ako plaćanje ne uspije — tišina. Ako kupac zatvori browser usred plaćanja — transakcija ostane zauvijek u "draft" stanju.

Napravili smo tri Odoo 16 modula koji rješavaju sve ove scenarije.

## Arhitektura modula

```
mail_gateway + mail_gateway_telegram (OCA, instalirano)
       |
telegram_notify (bazni)     payment_monri_pay_by_link (nadograđen)
       |                         |
       ├─ telegram_notify_monri ←┘
       │
       └─ email_notify_monri ←───┘
```

## Modul 1: `telegram_notify` — generički API

Bazni modul koji pruža jednostavan Python API za slanje Telegram poruka iz bilo kojeg poslovnog događaja:

```python
# Iz bilo kojeg Odoo modela:
self.env["telegram.notify.mixin"]._telegram_notify(partner, "Vaša poruka")
```

Modul automatski:
- Pronalazi konfigurisani Telegram gateway
- Traži partnerov kanal (mail.channel sa gateway_channel_token)
- Šalje poruku putem `message_post()` → OCA mail_gateway → Telegram Bot API
- Nikada ne baca grešku — logira warning ako partner nema Telegram kanal

**Repozitorij:** [bringout/odoo-bringout-telegram_notify](https://github.com/bringout/odoo-bringout-telegram_notify) (private)

## Modul 2: `email_notify_monri` — email obavještenja

Šalje email kupcu na svaki uspješan ili neuspješan Monri payment:

### Uspješno plaćanje
Kupac dobija email sa:
- Iznosom i valutom
- Brojem narudžbe
- ID transakcije i maskiranom karticom
- Informacijom o Telegram obavještenjima (ako su aktivirana)

### Neuspješno plaćanje
Email sa:
- Razlogom neuspjeha (Monri response code preveden u čitljiv tekst)
- Savjetom da pokuša ponovo ili kontaktira banku

**Repozitorij:** [bringout/odoo-bringout-email_notify_monri](https://github.com/bringout/odoo-bringout-email_notify_monri) (private)

## Modul 3: `telegram_notify_monri` — Telegram obavještenja

Šalje Telegram notifikacije na payment događaje, ali **samo ako je kupac aktivirao Telegram obavještenja**.

### Opt-in sistem

Novo polje na kontaktu: **"Use Telegram Notification"** (default: NE)

Kupac mora:
1. Imati `use_telegram_notify = True` na svom partneru u Odoo
2. Poslati poruku Telegram botu (kliknuti link sa checkout stranice)

### Aktivacijski banner na checkout stranici

Kada kupac sa aktiviranim Telegram obavještenjima završi plaćanje, ali još nema Telegram kanal, na `/payment/status` stranici se prikazuje banner:

> **Aktivirajte Telegram obavještenja**
> Primajte obavještenja o plaćanjima putem Telegrama.
> [Otvori Telegram bot @bringout_support_bot]

Jednom kada kupac pošalje poruku botu — kanal je kreiran i sva buduća plaćanja automatski šalju Telegram notifikacije.

### Tri tipa notifikacija

| Događaj | Kupac (ako opt-in) | Admini (uvijek) |
|---------|-------------------|-----------------|
| **Uspješno plaćanje** | "Payment successful: 100.00 BAM, Order: SO123" | [DONE] ista poruka |
| **Neuspješno plaćanje** | "Payment failed for order SO123, Reason: ..." | [ERROR] ista poruka |
| **Timeout (hangup)** | "Payment timeout for order SO123, please try again" | [HANGUP] ista poruka |

### Admin obavještenja

Konfigurišite `telegram_notify_monri.admin_partner_ids` u System Parameters — lista partner ID-eva koji primaju notifikacije o **svim** payment događajima, bez obzira na kupčev opt-in status.

**Repozitorij:** [bringout/odoo-bringout-telegram_notify_monri](https://github.com/bringout/odoo-bringout-telegram_notify_monri) (private)

## Nadogradnje na `payment_monri_pay_by_link` (v1.6.0)

Pored notification modula, nadogradili smo i sami Monri payment modul:

### Hangup detekcija (cron)

Kada kupac otvori Monri stranicu za plaćanje ali zatvori browser bez završetka:
- Transakcija ostaje u `draft` stanju sa `monri_payment_id` postavljenim
- Cron svaki **15 minuta** pronalazi takve transakcije starije od 30 min
- Upita Monri API za stvarni status (`GET /v2/transactions/{id}`)
- Razriješi transakciju — obično kao `error` (expired/declined)
- Okida notification hook za Telegram/email

### Zaštita od duplih plaćanja

Ako kupac klikne "Plati" dva puta ili se vrati na checkout dok prethodna transakcija još traje:
- Sistem pronalazi postojeću neterminalnu transakciju za istu narudžbu
- Koristi postojeći `payment_url` umjesto kreiranja novog plaćanja na Monri
- Kupac završava na istoj Monri stranici — nema duplog naplaćivanja

### Extension hook

Novi metod `_monri_after_cron_resolve(old_state)` omogućava drugim modulima da reaguju kada cron razriješi transakciju — bez mijenjanja koda payment modula.

## Kompletan tok

```
Kupac klikne "Plati" na web shopu
  │
  ├─ Provjera duplikata → ako postoji → reuseaj URL
  │
  └─ Monri API → kreiraj plaćanje → redirect na hosted page
       │
       ├─ Kupac plati uspješno
       │   └─ Webhook → state=done
       │       ├─ email_notify_monri → šalje email
       │       └─ telegram_notify_monri → šalje Telegram (ako opt-in)
       │
       ├─ Kartica odbijena
       │   └─ Webhook → state=error
       │       ├─ email_notify_monri → šalje email sa razlogom
       │       └─ telegram_notify_monri → šalje Telegram (ako opt-in)
       │
       └─ Kupac zatvori browser (hangup)
           └─ Nema webhooka → state ostaje draft
               └─ Cron (15 min) → upita Monri → state=error
                   ├─ telegram_notify_monri → šalje hangup notifikaciju
                   └─ (email template za hangup — buduća nadogradnja)
```

## Konfiguracija

| Parametar | Vrijednost | Opis |
|-----------|-----------|------|
| `telegram_notify.gateway_id` | ID gateway-a | Koji Telegram gateway koristiti |
| `telegram_notify_monri.bot_username` | `bringout_support_bot` | Za link na checkout stranici |
| `telegram_notify_monri.admin_partner_ids` | `72,71` | Partner ID-evi za admin notifikacije |
| `telegram_notify_monri.notify_done` | `True` | Notifikacija na uspjeh |
| `telegram_notify_monri.notify_error` | `True` | Notifikacija na grešku |
| `telegram_notify_monri.notify_hangup` | `True` | Notifikacija na timeout |

## Napomena

Trenutna faza ovih modula je "brainstorm".

## Izvorni kod

Svi repozitoriji su private na GitHub organizaciji `bringout/`:
- [odoo-bringout-telegram_notify](https://github.com/bringout/odoo-bringout-telegram_notify)
- [odoo-bringout-telegram_notify_monri](https://github.com/bringout/odoo-bringout-telegram_notify_monri)
- [odoo-bringout-email_notify_monri](https://github.com/bringout/odoo-bringout-email_notify_monri)
- [odoo-bringout-payment_monri_pay_by_link](https://github.com/bringout/odoo-bringout-payment_monri_pay_by_link) (v16.0.1.6.0)

Dokumentacija modula: [MONRI_SPECS.md](https://github.com/bringout/odoo-bringout-payment_monri_pay_by_link/blob/main/docs/MONRI_SPECS.md)
