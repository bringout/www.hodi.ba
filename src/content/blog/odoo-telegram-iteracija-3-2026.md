---
title: 'Odoo 16 + Telegram: Iteracija 3 — Real-time UX, zvuk, voice playback i document linkovi'
description: 'Treća iteracija Odoo-Telegram integracije: real-time bus notifikacije za gateway kanale, zvučne notifikacije, inline audio player za voice poruke, #URL# placeholder za document linkove'
pubDate: '2026-04-13T19:15:00'
heroImage: '/oca-gateway-iter3-hero.svg'
---

Nastavak rada na [prvoj](/blog/odoo-telegram-integracija-2026/) i [drugoj](/blog/oca-mail-gateway-telegram-fixes-part2-2026/) iteraciji Odoo-Telegram integracije. Fokus ove iteracije: **real-time korisničko iskustvo** — da Telegram poruke u Odoo-u rade jednako glatko kao native Odoo chat.

Sav kod: [bringout/oca-social](https://github.com/bringout/oca-social) (branch `16.0`) i [bringout/odoo-bringout-mail_preview_audio](https://github.com/bringout/odoo-bringout-mail_preview_audio).

---

## 1. Real-time sidebar update za gateway kanale

### Problem

Kada Telegram poruka stigne u Odoo, sidebar u Discuss-u se ne ažurira. Korisnik mora ručno refreshovati stranicu da vidi nove poruke.

### Uzrok

Core Odoo šalje `last_interest_dt_changed` bus notifikaciju samo za `chat` i `group` kanale. Gateway kanali (`channel_type = 'gateway'`) su preskočeni — i u `_notify_thread` (bus) i u `message_post` (pinning/ordering).

### Rješenje

Override `_notify_thread` i `message_post` na `mail.channel` za gateway kanale:

```python
def _notify_thread(self, message, msg_vals=False, **kwargs):
    rdata = super()._notify_thread(message, msg_vals=msg_vals, **kwargs)
    if self.channel_type == "gateway":
        bus_notifications = []
        for member in self.channel_member_ids.filtered("partner_id"):
            bus_notifications.append((
                member.partner_id,
                "mail.channel/last_interest_dt_changed",
                {
                    "id": self.id,
                    "isServerPinned": member.is_pinned,
                    "last_interest_dt": member.last_interest_dt,
                },
            ))
        if bus_notifications:
            self.env["bus.bus"].sudo()._sendmany(bus_notifications)
    return rdata
```

I u `message_post`, prije poziva `super()`:

```python
self.filtered(
    lambda ch: ch.channel_type == "gateway"
).mapped("channel_member_ids").sudo().write({
    "is_pinned": True,
    "last_interest_dt": fields.Datetime.now(),
})
```

Rezultat: sidebar se ažurira instant, sa ispravnim unread counterom.

---

## 2. Zvučna notifikacija za dolazne Telegram poruke

### Problem

Native Odoo chat reproducira zvuk samo kada je browser tab **van fokusa**. Za Telegram poruke nema nikakve zvučne indikacije.

### Rješenje

OWL patch na `MessagingNotificationHandler` koji reproducira `newMessage` zvuk za gateway kanale čak i kada je tab aktivan:

```javascript
registerPatch({
    name: "MessagingNotificationHandler",
    recordMethods: {
        async _handleNotificationChannelMessage(payload) {
            const result = await this._super(payload);
            const channel = this.messaging.models["Channel"]
                .findFromIdentifyingData({ id: payload.id });
            if (
                channel &&
                channel.channel_type === "gateway" &&
                this.env.services["presence"].isOdooFocused()
            ) {
                // ...provjera da autor nije trenutni korisnik...
                this.messaging.soundEffects.newMessage.play();
            }
            return result;
        },
    },
});
```

Koristi Odoo-ov ugrađeni `dm_02` zvučni efekt.

---

## 3. Live chatter update za Telegram odgovore na dokumentima

### Problem

Kada pošaljete gateway poruku sa fakture i primate odgovor putem Telegrama, odgovor se pojavi na fakturi — ali tek nakon refresha stranice.

### Uzrok

Telegram odgovor se posta na fakturi (account.move) putem `message_post`, ali `_notify_thread_by_inbox` ne šalje bus notifikaciju jer followeri imaju `notif='email'`, ne `'inbox'`.

### Rješenje

Nakon postanja reply-a na poslovni dokument, šaljemo `mail.message/inbox` bus notifikaciju svim followerima:

```python
record = self.env[related_message.gateway_message_id.model].browse(
    related_message.gateway_message_id.res_id
)
follower_pids = record.message_follower_ids.mapped("partner_id")
for partner in follower_pids:
    self.env["bus.bus"]._sendone(
        partner,
        "mail.message/inbox",
        new_related_message.message_format()[0],
    )
```

Rezultat: chatter na fakturi se ažurira u real-time-u bez refresha.

---

## 4. Document link sa #URL# placeholderom

### Problem

Kada šaljete gateway poruku sa dokumenta (npr. fakture), primalac na Telegramu ne može lako otvoriti taj dokument u Odoo-u.

### Rješenje

U tijelu gateway poruke, `#URL#` se automatski zamjenjuje linkom na dokument:

```python
if self.model and self.res_id and "#URL#" in body:
    base_url = self.env["ir.config_parameter"].sudo().get_param("web.base.url")
    doc_url = "%s/web#model=%s&id=%s" % (base_url, self.model, self.res_id)
    body = body.replace(
        "#URL#",
        '<a href="%s">%s</a>' % (doc_url, self.record_name or doc_url),
    )
```

Primjer: korisnik piše `pogledaj fakturu #URL#`, Telegram primalac dobije `pogledaj fakturu UF/26/04/0010` sa klikabilnim linkom.

---

## 5. Navigacija na dokument iz chata

### Problem

Klik na referencu dokumenta (npr. "on UF/26/04/0010") u gateway chatu otvara Discuss kanal umjesto samog dokumenta.

### Rješenje

Patch `onClickGatewayThread` handlera da koristi `action.doAction` za navigaciju na form view:

```javascript
onClickGatewayThread(ev) {
    ev.preventDefault();
    const data = this.message.gateway_thread_data;
    if (data && data.model && data.id) {
        this.env.services.action.doAction({
            type: "ir.actions.act_window",
            res_model: data.model,
            res_id: data.id,
            views: [[false, "form"]],
            target: "current",
        });
    }
},
```

---

## 6. Novi modul: mail_preview_audio — inline audio player

Odoo 16 (kao ni 17/18/19) nema ugrađen audio player u chatteru. Voice poruke sa Telegrama se mogu samo preuzeti.

Modul `mail_preview_audio` patchuje `Attachment` OWL model da prepoznaje audio MIME tipove kao "viewable":

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

Odoo 16 već koristi HTML5 `<video>` element za video pregled, a `<video>` tag podržava i audio. Modul samo dodaje audio MIME tipove u listu.

**Repozitorij:** [bringout/odoo-bringout-mail_preview_audio](https://github.com/bringout/odoo-bringout-mail_preview_audio)

---

## Linkovi

- **oca-social:** [bringout/oca-social](https://github.com/bringout/oca-social) (branch `16.0`)
- **mail_preview_audio:** [bringout/odoo-bringout-mail_preview_audio](https://github.com/bringout/odoo-bringout-mail_preview_audio)
- **Iteracija 1:** [Odoo 16 + Telegram integracija](/blog/odoo-telegram-integracija-2026/)
- **Iteracija 2:** [Popravke mail_gateway — Dio 2](/blog/oca-mail-gateway-telegram-fixes-part2-2026/)

## Napomena

Generisano od strane Claude 🤖

---

Ernad Husremović, hernad@bring.out.ba
