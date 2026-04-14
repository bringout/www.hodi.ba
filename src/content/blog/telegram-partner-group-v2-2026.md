---
title: 'Odoo + Telegram: Iteracija 4 — telegram_partner_group v2.0.0 (@svi, @reply, forum relay, auto-match telefonom)'
description: 'Četvrta iteracija bring.out Telegram podrške: @svi broadcast, @reply i @-mention rutiranje, bidirekcioni forum ↔ Discuss relay, auto-match telefonom, keyword stripping i još'
pubDate: '2026-04-14T16:20:00'
heroImage: '/telegram-forum-test-dobavljac-2026-04-14.png'
---

Nastavak rada na [prvoj](/blog/odoo-telegram-integracija-2026/), [drugoj](/blog/oca-mail-gateway-telegram-fixes-part2-2026/) i [trećoj](/blog/odoo-telegram-iteracija-3-2026/) iteraciji Odoo-Telegram integracije. Fokus ove iteracije: **preciznije rutiranje poruka** i **bidirekcioni rad kroz forum supergrupu na mobitelu**.

Modul: [bringout/odoo-bringout-telegram_partner_group](https://github.com/bringout/odoo-bringout-telegram_partner_group) v2.0.0.

---

## Polazna situacija

U iteracijama 1–3 imali smo:

- Telegram kontakt piše bot-u → poruka ulazi u **Odoo Discuss kanal**.
- Agent odgovara iz Discuss-a → poruka stiže kontaktu na Telegram.
- Paralelni mirror u **forum supergrupu** `bring.out partneri` — jedan topik po firmi ili kontaktu, da cijeli tim vidi razgovore sa mobitela.

Problemi koje smo rješavali u iteraciji 4:

1. **Rutiranje kod više kontakata iste firme.** Kad pišu i Edin i Elma iz HANO d.o.o., default `last-writer-wins` često šalje agentov odgovor pogrešnoj osobi.
2. **Jednosmjerni forum.** Agent tipka u forum topic na mobitelu → Odoo ne vidi, kupac ne dobija poruku.
3. **Ručno povezivanje novih Telegram korisnika** sa `res.partner` kartonom.
4. **Duplikati kanala** zbog race conditiona pri paralelnim webhook-ovima.
5. **Šum u porukama** — `@-mention` HTML linkovi, `@reply` prefiks koji agent koristi kao marker, sve završavalo u finalnoj poruci koju kupac vidi.

---

## 1. Ključne riječi za rutiranje

Agent sada ima četiri eksplicitna režima:

| Način pisanja | Primarni primalac | Dodatni primaoci |
|---|---|---|
| `@reply poruka…` | samo posljednji pošiljalac | — |
| `@svi poruka…` | posljednji pošiljalac | **svi ostali kontakti firme** |
| `@Edin Muminović poruka…` (iz Discuss @-picker-a) | samo Edin | — |
| `@Edin @Elma poruka…` | Edin | Elma |
| obična `poruka` | posljednji pošiljalac (default) | — |

Redoslijed odlučivanja: `@reply` > `@svi` > `@-mention` > default.

### @svi — broadcast firmi

Implementira se u `_send` kao prefix match na body tekstu. Kod pronalazi sve `res.partner.gateway.channel` linkove koji pripadaju istom top-level partneru (firmi) i fan-out-uje poruku kroz `bot.send_message` za svaki token. Primarni send ide kroz OCA `super()._send`, ostali tokeni asinhrono paralelno.

### @reply — explicit last-writer

Alias za default ponašanje, ali eksplicitan — agent zna sigurno da poruka ide samo posljednjem pošiljatelju, čak i ako je slučajno `@svi` ili neka mention data u tekstu.

### @-mention preko Odoo Discuss

Rutira se na bazi `mail_message.partner_ids` koje popunjava Odoo-ov @-picker. Prvi spomenuti partner postaje primarni primalac — privremeno zamjenjujemo `channel.gateway_channel_token` za tu operaciju, super() šalje njemu, potom restoraujemo token u `finally` bloku. Ostale mention-e fan-out kroz istu funkciju kao `@svi`.

**Važno**: `@-mention` po imenu radi **samo iz Odoo Discuss UI-a** gdje postoji @-picker. Telegram-ov @ autocomplete pokazuje Telegram usernames (ne Odoo partnere), pa ne pokušavamo parsirati imena iz slobodnog teksta — bilo bi previše fragilno sa istoimenim partnerima.

---

## 2. Forum ↔ Discuss bidirekcioni relay

Do iteracije 3 forum supergrupa je bila **samo ogledalo** (write-only iz Odoo prema Telegramu). Poruke koje agent otkuca direktno u forum topik sa mobitela su silently droppa-ne u `_receive_update`-u da se spriječi echo loop.

### Novi flow

`_receive_update` propušta supergroup poruku samo kad su sve tri ispunjene:

1. `chat.id == gateway.forum_chat_id` (naš konfigurisan forum)
2. `message_thread_id` je postavljen (poruka u topiku, ne na vrhu grupe)
3. `from_user.is_bot` je False (nije mirror našeg vlastitog bot-a)

Onda pozivamo `_process_forum_update`:

- Pronalazi `telegram.partner.group` zapis po `(gateway, forum_chat_id, topic_id)`
- Resolvira target Discuss kanal preko `mail.channel.company_partner_id`
- Identifikuje agenta — Telegram ID pošiljaoca matchiran protiv `res.partner.gateway.channel` zapisa za `gateway.member_ids`
- Posta poruku u kanal sa `author_id=agent`, kontekst `telegram_from_forum=True`

### Echo guard + outbound override

Context flag `telegram_from_forum=True` propagira kroz `message_post` → `mail.notification` → `_send`. U `_send`-u preskačemo forum mirror (poruka je već u topiku odakle je i došla), ali **još uvijek fan-out-ujemo `@svi` broadcast i `@-mention` rutiranje**, tako da keyword pravila rade identično iz oba mjesta.

Bitan detalj: OCA-ov webhook controller postavlja `no_gateway_notification=True` u request kontekstu (da inbound poruke od kupaca ne bounce-uju nazad do njih). Naš relay nasljeđuje taj flag što je onemogućavalo outbound prema kupcu. Fix — eksplicitan override:

```python
channel.with_context(
    telegram_from_forum=True,
    no_gateway_notification=False,  # force outbound send
).message_post(...)
```

### Photo + caption

Telegram sprema tekst kod medijskih poruka u `message.caption` (ne `message.text`). Proširili smo `_process_forum_update` da čita i `msg.caption` / `msg.caption_html`, tako da slika sa opisom `@reply pogledaj ovo` isporuči i sliku i tekst kupcu.

---

## 3. Auto-match telefonom (handshake)

Kad novi Telegram korisnik napiše bot-u, želimo odmah znati kom postojećem `res.partner`-u pripada umjesto da kreiramo novog "Telegram 12345" partnera.

### Protokolsko ograničenje

Telegram bot API **ne može** dobiti broj telefona korisnika bez eksplicitnog pristanka. Jedini put: `ReplyKeyboardMarkup` sa `KeyboardButton(request_contact=True)`. Kad korisnik klikne, Telegram dostavlja `message.contact` objekat sa `phone_number`.

### Implementacija

Novi model `telegram.contact.handshake` prati stanje po korisniku:
- `requested` — dugme poslano, čekamo
- `matched` — telefon pronađen u `res.partner.phone`/`.mobile`, kreiran `res.partner.gateway.channel` link
- `no_match` — telefon nije pronađen, ostaje guest ili kreira se novi partner

Normalizacija telefona — strip svih non-digit karaktera, zatim probaj varijante za bosanske brojeve: sa `+387` prefiksom, sa lokalnim `0` prefiksom, bez ikakvog prefiksa. PostgreSQL regex-strip upit traži match i na `phone` i na `mobile` polje.

Default poruka sa dugmetom (dvojezična):

> Pozdrav! Za brzu podršku molimo da podijelite svoj broj telefona klikom na dugme ispod. Tako ćemo automatski pronaći vaš karton u našem sistemu.
>
> Hello! For faster support, please share your phone number using the button below so we can link you to your customer record.

Guard: odbijamo `contact` objekte u kojima `contact.user_id != from_user.id` — spriječava slanje tuđeg kontakta.

---

## 4. Arhitekturne promjene

### `mail.channel.company_partner_id`

Prije: parent firma (npr. HANO) je bila dodana kao **član** kanala, što je kreiralo zbrku — agent vidi "HANO d.o.o Sarajevo" kao osobu pored Edina i Elme u @-mention list-i. Takođe smo koristili `channel_member_ids.partner_id = top_id` za lookup kanala firme, što je fragilno.

Sada: novo Many2one polje `company_partner_id` na `mail.channel`. Parent firma **nije** član — samo pojedinačni kontakti i tim. Lookup ide preko `company_partner_id`, bez member tablice.

### Eliminisanje orphan kanala

Race condition: paralelni webhook-ovi → OCA `super()._get_channel(force_create=False)` ipak kreira novi kanal ako `has_new_channel_security` je False. Rezultat su bili duplikati ("4x HANO d.o.o Sarajevo" u sidebar-u).

Fix: zamijenili smo side-effect `super()._get_channel` sa pure lookup preko `gateway._get_channel_id(token)`. Ako nema match-a, prvo tražimo company channel, tek na kraju sami kreiramo (ne pozivajući super). Ako ipak nađemo orphan sa istim tokenom a postoji kanonični company kanal, arhiviramo orphan na licu mjesta.

### Keyword + anchor stripping

Final poruka kupcu ne treba vidjeti `@reply`, `@svi` ni Odoo `@-mention` HTML linkove. `html2plaintext` inače pretvara `<a href=...>@Ime</a>` u `@Ime[1]\n[1] /web#...` — noise.

Dva preprocessing filtera:
- `_strip_anchor_tags` uklanja `<a>…</a>` tagove, čuva visible tekst
- `_strip_routing_keywords_html` briše prvi pojavak `@reply` / `@svi` na početku body-a

Primjenjuje se kroz override `_get_message_body` (koji OCA-ov `_send_telegram` koristi), plus na body text za fan-out i forum mirror. Kupac dobija čist tekst.

### Fan-out success tracking

Prije: `_async_broadcast` je silently progutao per-token izuzetke i vanjski log je svejedno pisao "delivered to N recipient(s)". httpx connect timeout na pojedinog primaoca je bio nevidljiv.

Sada: `_async_broadcast` vraća `[(token, ok_bool), …]`, pa vanjski helper loguje `delivered to N of M recipient(s)` + WARNING sa listom failed tokena. Timeout-i su vidljivi.

---

## 5. Primjeri iz prakse

Screenshot iznad pokazuje forum topik "Test Dobavljač" u supergrupi `bring.out partneri`. U istom topiku:

- `@reply Evo ti slika Test` — agent šalje sliku sa poruka caption iz foruma, isporučeno samo kupcu (Test Dobavljač).
- `@reply Test-4`, `@reply Test-3` — direct replies iz Discuss-a ka posljednjem pošiljatelju.
- `@reply Na usluzi` — posljednja poruka iz Odoo-a kroz forum mirror, sa atributom `Ernad Husremović → Test Dobavljač:`.

Nakon verzije 2.0.0, `@reply` prefix se **ne pojavljuje** u poruci koja stigne kupcu — agent vidi prefix samo u svojoj chat history (za audit), finalni kupac vidi čist tekst.

---

## Tehnički detalji

**Verzija modula**: `16.0.2.0.0` (deploy-ovano 14. aprila 2026).

**Ključni fajlovi**:

- `models/mail_gateway_telegram.py` — sav routing logic: `_get_channel`, `_send`, `_process_forum_update`, `_get_mention_tokens`, `_broadcast_to_company`, `_async_broadcast`
- `models/mail_channel.py` — dodato polje `company_partner_id`
- `models/telegram_contact_handshake.py` — novi model za phone handshake, normalizacija telefona, `_find_partner_by_phone`
- `models/telegram_partner_group.py` — forum topic lookup i forward logika

**Specifikacija i arhitektura**: detaljan dokument u [profile/bringout/docs/TELEGRAM_BRINGOUT_SUPPORT.md](https://github.com/bringout/odoo_profile_bringout/blob/main/docs/TELEGRAM_BRINGOUT_SUPPORT.md).

**Ovisnosti**: OCA `mail_gateway` + `mail_gateway_telegram`, `python-telegram-bot 21.9`.

---

## Šta slijedi

Nekoliko stavki iz backlog-a za iteraciju 5:

- **Per-recipient delivery log** (`telegram.delivery.log`): status, greška, vrijeme. Chatter badge "3/4 sent (Edin: timeout)" direktno na poruci. Auto-flag "telegram_blocked" na partneru nakon N uzastopnih `Forbidden`.
- **Reply-to-message iz foruma**: kad agent koristi Telegram-ov native reply feature na konkretnu poruku u topiku, automatski ekstraktovati ko je adresat — umjesto `@reply` keyword-a.
- **Rate limit handling**: `telegram.error.RetryAfter` retry sa exponential backoff.

---

## Napomena

Generisano od strane Claude 🤖

---

Ernad Husremović, hernad@bring.out.ba
