---
title: 'Popravke OCA mail_gateway i mail_gateway_telegram za Odoo 16 — Dio 2'
description: 'Nastavak popravki OCA mail_gateway modula: eliminacija lažnih email grešaka za Telegram partnere, crash fix za webhook, prikaz "via Telegram" identiteta i restrukturiranje oca-social repozitorija'
pubDate: '2026-04-13T15:10:00'
heroImage: '/oca-gateway-fixes-part2-hero.svg'
---

Nastavak rada na [prvim popravkama OCA mail_gateway modula](/blog/oca-mail-gateway-odoo16-bugfix-2026/). Nakon što smo riješili Werkzeug charset kompatibilnost i OWL selection field validaciju, u produkcijskom korištenju Telegram integracije pojavili su se novi problemi.

Sve popravke su u repozitoriju: [bringout/oca-social](https://github.com/bringout/oca-social) (branch `16.0`).

---

## Bug 3: "Invalid email address" za Telegram partnere

### Simptom

Slanje poruke putem "Gateway message" taba na ulaznoj fakturi prikazuje crvenu ikonicu pošte i grešku:

```
Ignoring invalid recipients for mail.mail: ['"BH Telecom Sarajevo" <@False>']
```

Poruka se uspješno isporuči na Telegram, ali Odoo prikazuje grešku kao da slanje nije uspjelo.

### Uzrok

Tri odvojena puta u kodu pokreću email notifikacije za Telegram partnere:

1. **Gateway channel path** — `mail.channel.message_post()` na gateway kanalu poziva `_notify_thread_by_email` za članove kanala
2. **Gateway recipients path** — `mail.thread._notify_thread_by_email()` prima gateway primaoce (sa `notif='gateway'`) i prosljeđuje ih na `super()` koji pokušava poslati email
3. **Follower path** — partneri sa `res.partner.gateway.channel` zapisom su followeri na poslovnim dokumentima, pa im Odoo šalje email notifikacije

### Popravke

**`mail_gateway/models/mail_channel.py`** — preskočiti email notifikacije za gateway kanale:

```python
def _notify_thread_by_email(self, message, recipients_data, **kwargs):
    if self.channel_type == "gateway":
        return True
    return super()._notify_thread_by_email(message, recipients_data, **kwargs)
```

**`mail_gateway/models/mail_thread.py`** — filtrirati gateway primaoce i partnere sa gateway kanalom:

```python
def _notify_thread_by_email(self, message, recipients_data, **kwargs):
    partners_data = [r for r in recipients_data if r["notif"] == "gateway"]
    if partners_data:
        self._notify_thread_by_gateway(message, partners_data, **kwargs)
    non_gateway_data = [r for r in recipients_data if r["notif"] != "gateway"]
    # Preskoči email za partnere koji imaju konfigurisan gateway kanal
    if non_gateway_data:
        gateway_partner_ids = set(
            self.env["res.partner.gateway.channel"]
            .sudo()
            .search([
                ("partner_id", "in", [r["id"] for r in non_gateway_data]),
            ])
            .mapped("partner_id.id")
        )
        if gateway_partner_ids:
            non_gateway_data = [
                r for r in non_gateway_data
                if r["id"] not in gateway_partner_ids
            ]
    return super()._notify_thread_by_email(message, non_gateway_data, **kwargs)
```

Logika: partner koji komunicira putem Telegrama ne treba email — gateway kanal je njihov komunikacijski kanal.

---

## Bug 4: Telegram webhook crash na non-message update

### Simptom

Telegram webhook vraća HTTP 500 sa tracom:

```
AttributeError: 'NoneType' object has no attribute 'entities'
File ".../mail_gateway_telegram.py", line 80, in _preprocess_update
```

### Uzrok

Telegram šalje razne tipove update-a (edited messages, callback queries, channel posts) kod kojih `update.message` je `None`. Modul pretpostavlja da `message` uvijek postoji.

### Popravka

**`mail_gateway_telegram/models/mail_gateway_telegram.py`** — guard clause za null message:

```python
def _preprocess_update(self, gateway, update):
    if not update.message or not update.message.entities:
        return False
    # ... ostatak metode

def _receive_update(self, gateway, update):
    # ... de_json ...
    if self._preprocess_update(gateway, telegram_update):
        return
    if not telegram_update.message:
        _logger.debug("Ignoring Telegram update without message: %s",
                       telegram_update.update_id)
        return
    # ... ostatak metode
```

Dodatno, popravljen crash na `telegram.Contact` bez vcard podataka (`attachment.vcard` može biti `None`).

---

## Poboljšanje: "via Telegram" identitet

### Problem

Kada partner komunicira putem Telegrama, u Odoo chatteru se prikazuje isto ime kao kada komunicira kao Odoo korisnik. Nemoguće je razlikovati Telegram poruke od internih Odoo poruka.

### Rješenje

Na dolaznim Telegram porukama postavljamo `email_from` polje sa sufiksom "via Telegram":

```python
if author_id:
    email_from = '"%s via Telegram" <telegram@gateway>' % author.name
new_message = chat.message_post(
    body=body,
    author_id=author_id,
    email_from=email_from,
    gateway_type="telegram",
    ...
)
```

Polje `email_from` se postavlja na `"{ime} via Telegram"` za buduću upotrebu (npr. log, email headers). Vizualni prikaz u chatteru i dalje koristi ime partnera iz `author_id`.

Jedan partner — više komunikacijskih identiteta. Nema potrebe za kreiranjem dupliciranih partnera za Telegram. Razlikovanje se vrši putem Telegram ikone pored imena poruke.

---

## Restrukturiranje oca-social repozitorija

Repozitorij je preimenovan sa `odoo-bringout-oca-social` na `oca-social` i svi moduli su restrukturirani u standardnu package strukturu:

```
oca-social/
  odoo-bringout-oca-social-mail_gateway/
    mail_gateway/
  odoo-bringout-oca-social-mail_gateway_telegram/
    mail_gateway_telegram/
  odoo-bringout-oca-social-mail_tracking/
    mail_tracking/
  ...
```

Prethodno su moduli bili u flat strukturi (naslijeđenoj od OCA upstream-a) sa duplikatima za zip building. Sada je jedna kopija, jedan izvor istine.

---

## Bug 5: Voice poruke prikazane kao `.bin` fajlovi

### Simptom

Telegram voice poruke se u Odoo chatteru prikazuju sa dugačkim `file_id` imenom i `.bin` ekstenzijom umjesto kao `voice.oga`.

### Uzrok

`_get_telegram_attachment_name()` ne prepoznaje `telegram.Voice` i `telegram.VideoNote` tipove, pa koristi sirovi `file_id` kao ime. Također, `guess_mimetype()` ne prepoznaje OGG/Opus format, a Telegram pruža `mime_type` atribut koji se ne koristi.

### Popravka

```python
# Prepoznavanje voice/video tipova
if isinstance(attachment, telegram.Voice):
    return "voice"
if isinstance(attachment, telegram.VideoNote):
    return "video_note"

# Korištenje Telegram mime_type kada je dostupan
mimetype = getattr(attachment, "mime_type", None) or guess_mimetype(data)
```

---

## Novi modul: mail_preview_audio — inline audio player

### Problem

Odoo 16 chatter nema ugrađen audio player. Voice poruke se mogu samo preuzeti, ne mogu se reproducirati direktno u browseru. Ni Odoo 17/18/19 nemaju ovu funkcionalnost — dostupna je samo putem third-party modula.

### Rješenje

Kreiran modul `mail_preview_audio` koji proširuje `Attachment` OWL model da prepoznaje audio MIME tipove kao "viewable":

```javascript
registerPatch({
    name: "Attachment",
    fields: {
        isVideo: {
            compute() {
                const mimeTypes = [
                    "audio/mpeg", "audio/ogg", "audio/wav",
                    "audio/webm", "audio/aac", "audio/x-opus+ogg",
                    "video/x-matroska", "video/mp4", "video/webm",
                ];
                return mimeTypes.includes(this.mimetype);
            },
        },
    },
});
```

Odoo 16 već koristi HTML5 `<video>` element za pregled video attachmenta, a `<video>` tag podržava i audio reprodukciju. Modul samo dodaje audio MIME tipove (`audio/ogg`, `audio/wav`, `audio/webm`, `audio/aac`) u listu prepoznatih formata.

Rezultat: klik na voice poruku otvara ugrađeni player umjesto pokretanja download-a.

**Repozitorij:** [bringout/odoo-bringout-mail_preview_audio](https://github.com/bringout/odoo-bringout-mail_preview_audio)

---

## Commit linkovi

- **oca-social:** [bringout/oca-social](https://github.com/bringout/oca-social) (branch `16.0`)
- **mail_preview_audio:** [bringout/odoo-bringout-mail_preview_audio](https://github.com/bringout/odoo-bringout-mail_preview_audio)
- **Upgrade lib:** [bringout/core_0](https://github.com/bringout/core_0) — `scripts/odoo_upgrade_lib.py`
- **Prvi dio popravki:** [Popravke OCA mail_gateway modula za Odoo 16](/blog/oca-mail-gateway-odoo16-bugfix-2026/)

## Napomena

Generisano od strane Claude 🤖

---

Ernad Husremović, hernad@bring.out.ba
