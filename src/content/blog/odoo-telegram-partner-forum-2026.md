---
title: 'Odoo 16 + Telegram: Iteracija 4 — Automatski forum topici za mobilnu vidljivost tima'
description: 'Četvrta iteracija Odoo-Telegram integracije: novi modul telegram_partner_group koji automatski kreira forum topice u Telegram supergrupi za svakog partnera, prosljeđuje poruke u oba smjera i omogućava timu praćenje konverzacija na mobilnom Telegramu.'
pubDate: '2026-04-13T21:00:00'
heroImage: '/telegram-partner-group-hero.svg'
---

Nastavak rada na [prvoj](/blog/odoo-telegram-integracija-2026/), [drugoj](/blog/oca-mail-gateway-telegram-fixes-part2-2026/) i [trećoj](/blog/odoo-telegram-iteracija-3-2026/) iteraciji Odoo-Telegram integracije. Fokus ove iteracije: **mobilna vidljivost tima** — da svi članovi tima vide partnerske konverzacije na svom Telegram klijentu, bez potrebe za otvaranjem Odoo-a.

Sav kod: [bringout/odoo-bringout-telegram_partner_group](https://github.com/bringout/odoo-bringout-telegram_partner_group)

---

## Problem

Kada partner (npr. JP BH Pošta putem kontakt osobe Faruk Husremović) pošalje poruku gateway botu, poruka se pojavi samo u Odoo Discuss-u. Članovi tima koji su na terenu ili koriste mobilni telefon nemaju uvid u te konverzacije — moraju otvoriti Odoo web da bi vidjeli poruku.

## Rješenje: telegram_partner_group modul

Novi modul `telegram_partner_group` koristi **Telegram Forum Topics API** (`create_forum_topic`) za automatsko kreiranje topica u jednoj zajedničkoj Telegram supergrupi.

### Kako radi

1. Administrator kreira **jednu Telegram supergrupu** sa uključenim **Topics** modom (npr. "bring.out partneri")
2. Bot se dodaje kao **admin** grupe sa dozvolom "Manage Topics"
3. Svi članovi tima (Ernad, Jasmin...) se dodaju u grupu
4. U Odoo-u, na gateway formi, postavi se **Forum Chat ID** te grupe

Kada partner pošalje **prvu poruku** botu:
- Modul automatski kreira forum topic nazvan `bring.out podrška/JP BH Pošta`
- Poruka se prosljeđuje u taj topic
- Svi članovi grupe vide poruku na svom mobilnom Telegram klijentu

Za svaku narednu poruku, koristi se postojeći topic.

### Dvosmjerno prosljeđivanje

Modul prosljeđuje poruke u **oba smjera**:

**Partner → Bot (dolazna poruka):**
```
JP BH Pošta:
Trebamo ponudu za 50 licenci
```

**Odoo → Partner (odlazna poruka):**
```
Ernad Husremović → JP BH Pošta:
Ponuda je u prilogu, pogledajte attachment
```

---

## Tehnička implementacija

### Model: telegram.partner.group

Novi model prati mapiranje partner → forum topic:

| Polje | Opis |
|-------|------|
| `partner_id` | res.partner — partner čiji je topic |
| `gateway_id` | mail.gateway — Telegram gateway |
| `forum_chat_id` | Chat ID supergrupe |
| `topic_id` | message_thread_id forum topica |
| `topic_name` | Naziv topica |

SQL constraint osigurava jedan topic po partneru po gatewayu.

### Kreiranje topica i slanje u jednom async pozivu

Ključni izazov je bio `asyncio.run()` — Odoo koristi sinkroni ORM, a Telegram Bot API zahtijeva async pozive. Dva uzastopna `asyncio.run()` poziva (jedan za kreiranje topica, drugi za slanje poruke) uzrokuju TLS connection error.

Rješenje: **jedna async funkcija** koja objedinjuje kreiranje topica i slanje poruke:

```python
async def _async_forward(self, bot_token, forum_chat_id, topic_id,
                          topic_name, text, attachments=None):
    bot = telegram.Bot(bot_token)
    await bot.initialize()
    chat_id = int(forum_chat_id)

    # Kreiraj topic ako ne postoji
    if not topic_id:
        result = await bot.create_forum_topic(
            chat_id=chat_id, name=topic_name
        )
        topic_id = result.message_thread_id

    # Pošalji tekst
    if text:
        await bot.send_message(
            chat_id=chat_id,
            message_thread_id=topic_id,
            text=text,
        )

    # Pošalji attachmente
    if attachments:
        for name, data, _info in attachments:
            mimetype = _info.get("mimetype", "")
            if mimetype.startswith("image/"):
                await bot.send_photo(
                    chat_id=chat_id,
                    message_thread_id=topic_id,
                    photo=BytesIO(data),
                )
            else:
                await bot.send_document(
                    chat_id=chat_id,
                    message_thread_id=topic_id,
                    document=BytesIO(data),
                    filename=name,
                )

    return {"topic_id": topic_id}
```

### Hook za dolazne poruke

Override `_process_update` u `mail.gateway.telegram`:

```python
def _process_update(self, chat, update):
    result = super()._process_update(chat, update)
    if not result:
        return result

    author = self._get_author(gateway, update)
    if author._name != "res.partner":
        return result  # Samo za poznate partnere

    text = "%s:\n%s" % (author.display_name, update.message.text)
    self.env["telegram.partner.group"]._forward_to_topic(
        author, gateway, text, attachments
    )
    return result
```

### Hook za odlazne poruke

Override `_send` u `mail.gateway.telegram`:

```python
def _send(self, gateway, record, **kwargs):
    result = super()._send(gateway, record, **kwargs)

    # Pronađi partnera po gateway_channel_token
    pgc = self.env["res.partner.gateway.channel"].search([
        ("gateway_id", "=", gateway.id),
        ("gateway_token", "=", channel.gateway_channel_token),
    ], limit=1)

    text = "%s → %s:\n%s" % (sender_name, partner.display_name, body)
    self.env["telegram.partner.group"]._forward_to_topic(
        partner, gateway, text, attachments
    )
    return result
```

Ključni detalj: partner se pronalazi po `gateway_channel_token` (Telegram user ID privatnog chata) — ne po članstvu u kanalu, jer kanal sadrži i članove tima.

---

## Detect Groups wizard

Modul dodaje **Partner Forum** tab na gateway formu sa:
- **Forum Chat ID** poljem
- **Forum Group Name** (auto-detektovano iz Telegram API-ja)
- **Detect Groups** dugmetom

Detect Groups wizard:
1. Privremeno uklanja webhook
2. Dohvata `getUpdates` da pronađe grupe u kojima je bot član
3. Prikazuje listu sa chat ID, nazivom i tipom (group/supergroup/forum)
4. Korisnik selektuje grupu i potvrdi
5. Webhook se automatski vraća

---

## Postavljanje

1. Kreirajte Telegram supergrupu i uključite **Topics** mod u postavkama grupe
2. Dodajte gateway bota kao **admina** sa dozvolom "Manage Topics"
3. Dodajte članove tima u grupu
4. U Odoo-u otvorite **Discuss > Gateways > [vaš gateway]**
5. Na **Partner Forum** tabu kliknite **Detect Groups** ili ručno unesite Chat ID
6. Instalirajte modul:

```bash
python scripts/upgrade_production_nix_service.py \
    --modules telegram_partner_group --install
```

---

## Rezultat

| Prije | Poslije |
|-------|---------|
| Partnerske poruke vidljive samo u Odoo Discuss | Poruke vidljive i na mobilnom Telegramu |
| Tim mora otvarati Odoo da provjeri poruke | Push notifikacije na telefonu |
| Jedna konverzacija po partneru u Odoo-u | Organizirani forum topici po partneru |
| Samo dolazne poruke | Dvosmjerno: i odgovori iz Odoo-a se vide |

---

## Linkovi

- **telegram_partner_group:** [bringout/odoo-bringout-telegram_partner_group](https://github.com/bringout/odoo-bringout-telegram_partner_group)
- **Iteracija 1:** [Odoo 16 + Telegram integracija](/blog/odoo-telegram-integracija-2026/)
- **Iteracija 2:** [Popravke mail_gateway — Dio 2](/blog/oca-mail-gateway-telegram-fixes-part2-2026/)
- **Iteracija 3:** [Real-time UX, zvuk, voice playback](/blog/odoo-telegram-iteracija-3-2026/)

## Napomena

Generisano od strane Claude 🤖

---

Ernad Husremović, hernad@bring.out.ba
