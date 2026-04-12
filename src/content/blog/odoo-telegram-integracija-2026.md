---
title: 'Odoo 16 + Telegram: besplatna integracija za korisničku podršku'
description: 'Kako smo spojili Telegram Bot API sa Odoo 16 koristeći OCA mail_gateway modul — bez troškova, bez Meta verifikacije, s potpunom dvosmjernom komunikacijom'
pubDate: '2026-04-12T15:00:00'
heroImage: '/telegram-odoo-hero.svg'
---

## Zašto Telegram, a ne WhatsApp?

Kada je u pitanju integracija poslovnog messaging-a sa ERP sistemom, WhatsApp Business API je najočigledniji izbor. Ali za mala preduzeća, troškovi i birokratija su značajni:

| | **Telegram Bot API** | **WhatsApp Business API** |
|---|---|---|
| **Cijena** | Besplatno | ~50-100 $/mj za 500 razgovora |
| **Postavljanje** | 2 minute sa @BotFather | 1-3 sedmice, Meta verifikacija |
| **Odobrenje** | Nije potrebno | Obavezna verifikacija firme |
| **Predlošci poruka** | Bez ograničenja | Obavezni za izlazne poruke |
| **Rizik od bana** | Minimalan | Mogu ograničiti nalog |

Telegram je API napravljen za botove od prvog dana — automatizacija je ugrađena funkcionalnost, ne naknadni dodatak.

## OCA moduli: mail_gateway + mail_gateway_telegram

[OCA (Odoo Community Association)](https://github.com/OCA/social) održava repozitorij `social` koji sadrži dva ključna modula:

- **mail_gateway** (16.0.1.3.3) — bazni framework za sve messaging integracije
- **mail_gateway_telegram** (16.0.1.1.0) — Telegram implementacija

Arhitektura je čista: `mail_gateway` definiše apstraktni interfejs (`_receive_update`, `_send`, `_get_channel`, `_get_author`), a svaki kanal (Telegram, WhatsApp) ga implementira nezavisno.

### Stablo zavisnosti

```
mail_gateway_telegram
└── mail_gateway
    └── mail (Odoo standard)

Python zavisnosti:
├── python-telegram-bot
├── lottie (animirani stikeri)
└── cairosvg (SVG konverzija)
```

## Korak 1: Kreiranje Telegram bota

Otvorite Telegram i pokrenite razgovor sa [@BotFather](https://t.me/BotFather):

1. Pošaljite `/newbot`
2. Unesite ime bota (npr. "bring.out podrška")
3. Unesite korisničko ime koje završava sa "bot"
4. BotFather vam daje **API token**

![Kreiranje bota sa BotFather](/telegram-botfather.png)

## Korak 2: Konfiguracija u Odoo

U Odoo navigirajte na **Postavke → Tehnički detalji → Gateway** i kreirajte novi zapis:

- **Gateway Type**: Telegram
- **Token**: API token od BotFather
- **Webhook Key**: jedinstveni identifikator (npr. `bringout-telegram-1`)
- **Webhook Secret**: nasumični string za sigurnost
- **Members**: dodajte korisnike koji ce odgovarati na poruke

![Konfiguracija gateway-a u Odoo](/telegram-gateway-config.png)

Nakon snimanja, kliknite **"Integrate Webhook"** — Odoo automatski registruje webhook URL kod Telegram API-ja.

## Korak 3: Testiranje komunikacije

Odoo korisnici mogu direktno odgovoriti iz Discuss-a, a odgovor se šalje nazad korisniku na Telegram:

![Dvosmjerna komunikacija Telegram ↔ Odoo](/telegram-discuss-chat.png)

## NixOS deployment

Za naš NixOS-bazirani infrastructure setup, deployment uključuje:

**1. Python zavisnosti** u `odoo-bosnian` Nix paketu:

```nix
propagatedBuildInputs = with mypython.pkgs; [
  # ... postojeće zavisnosti ...
  python-telegram-bot
  cairosvg
  lottie
];
```

**2. OCA moduli** u `odoo_16_OCA` zip arhivi, deployani putem Colmena na node41.

**3. Bugfix za Werkzeug kompatibilnost** — OCA modul koristi `request.httprequest.charset` koji je uklonjen u Werkzeug 3.x:

```python
# Originalno (pada):
request.httprequest.get_data().decode(request.httprequest.charset)

# Popravka:
request.httprequest.get_data().decode(
    getattr(request.httprequest, "charset", "utf-8")
)
```

## Funkcionalnosti

Modul podržava:

- **Dvosmjerna komunikacija** — poruke iz Telegrama u Odoo i nazad
- **Rich media** — slike, dokumenti, kontakti, animirani stikeri
- **Automatsko kreiranje kanala** — svaki Telegram chat postaje Odoo kanal
- **Timski rad** — više Odoo korisnika može odgovarati istom korisniku
- **Sigurnost** — webhook verifikacija, opcionalni sigurnosni ključ za `/start`

## Izvorni kod

Naš fork OCA/social repozitorija sa primijenjenim popravkama:

- GitHub: [bringout/odoo-bringout-oca-social](https://github.com/bringout/odoo-bringout-oca-social) (branch `16.0`)
- Upstream: [OCA/social](https://github.com/OCA/social)

## Zaključak

Za mala preduzeća koja traže besplatnu messaging integraciju sa Odoo-om, Telegram Bot API + OCA mail_gateway je odlično rješenje. Nema troškova API-ja, nema Meta verifikacije, postavljanje traje par minuta, a dvosmjerna komunikacija radi odmah.
