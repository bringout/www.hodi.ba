---
title: 'Monri Pay By Link iz prodajne narudžbe: payment_monri_pay_by_link 16.0.1.7.0 → 16.0.2.5.1'
description: 'Novi tok plaćanja karticom u Odoo 16 — bez website_sale-a. RFQ dobije Monri payment term, Odoo automatski generiše link, email kupcu sadrži zeleno dugme "Plati karticom", portal osvježava notu kada Monri potvrdi transakciju.'
pubDate: '2026-04-18T15:37:50'
heroImage: '/monri-pay-by-link-hero.svg'
---

## Problem

[Monri Pay By Link](https://ipg.monri.com/en/documentation/pay_by_link) u našem Odoo 16 modulu `payment_monri_pay_by_link` do sada je radio samo kroz **e-commerce** scenario — kupac je morao biti na `website_sale` checkoutu sa aktivnom Odoo sesijom. A tipičan poslovni tok je drugačiji:

> Prodavac kreira ponudu (RFQ) u Odoou. Klijent treba platiti karticom, ali nikad se neće prijaviti na Odoo portal. Želim da **pošaljem ponudu emailom sa dugmetom "Plati karticom"** i da se nota na narudžbi automatski ažurira kad Monri potvrdi uplatu.

Ovaj blog pokriva cjelokupan rad na `payment_monri_pay_by_link` modulu danas — od **16.0.1.7.0** do **16.0.2.5.1** (jučerašnja baza bila je 16.0.1.6.0) — koji je dodao taj drugi scenario (iz prodajne narudžbe) uz očuvanje postojećeg e-commerce toka.

## Pregled scenarija

| | eCommerce (postojeći) | Prodajna narudžba (novi) |
|---|---|---|
| **Pokretač** | Kupac klikne *Pay* u `website_sale` checkoutu | SO dobije `Monri Pay By Link` payment term |
| **Kontekst** | Aktivna Odoo sesija | Nema sesije — email / portal access_token |
| **Kreiranje tx-a** | `PaymentPortal.transaction` (Odoo core) | `sale.order._monri_create_transaction` |
| **Landing route** | `/payment/confirmation` | `/my/orders/<id>?access_token=…` |
| **Povratna stranica** | `/payment/status` (polls session) | SO portal view + polling banner |

## Payment term kao okidač

Dodali smo boolean polje `is_monri_pay_by_link` na `account.payment.term` i seed zapis:

```xml
<record id="payment_term_monri_pay_by_link" model="account.payment.term">
    <field name="name">Monri Pay By Link</field>
    <field name="is_monri_pay_by_link" eval="True" />
    <field name="note">Plaćanje karticom preko Monri Pay By Link.</field>
</record>
```

Kad `sale.order` ima payment term sa tim flagom, `write()` hook (`_monri_autocreate_safe`) automatski pokušava:

1. **Ako već postoji aktivna tx koja odgovara narudžbi** → ponovo ispisuje notu (za slučaj da je ručno obrisana) i vraća istu.
2. **Ako tx postoji ali je zastarjela** (iznos / valuta / partner se promijenio) → otkazuje staru i pravi novu.
3. **Ako tx ne postoji** → kreira novu i dobavlja URL od Monri-ja REST API-em.

Hookovi okidača: `payment_term_id`, `order_line`, `amount_total`, `partner_id`, `partner_invoice_id`.

## Wizard za nedostajući email / telefon

Monri zahtijeva `ch_email` i `ch_phone` u svakom zahtjevu. Ako partner nema oba, dugme *Generate Monri Link* otvara `monri.contact.wizard`:

```python
class MonriContactWizard(models.TransientModel):
    _name = "monri.contact.wizard"
    email = fields.Char("Email", required=True)
    phone = fields.Char("Phone", required=True)

    def action_save_and_generate(self):
        vals = {}
        if self.email != (self.partner_id.email or ""):
            vals["email"] = self.email
        if self.phone != (self.partner_id.phone or self.partner_id.mobile or ""):
            vals["phone"] = self.phone
        if vals:
            self.partner_id.sudo().write(vals)
        self.sale_order_id.action_monri_create_payment_link()
        return {"type": "ir.actions.act_window_close"}
```

Wizard **upisuje podatke nazad u `res.partner`** (ne samo u tx), tako da sljedeća narudžba istog klijenta neće tražiti ponovo. Vraća `act_window_close` da modal nestane čim link bude spreman.

Automatski trigger (na `write`) ne otvara wizard — samo tiho preskače i loguje *"Monri auto-link: skipping SO S00042 — customer X missing email, phone"*. Operater vidi link tek kad klikne *Generate* i popuni wizard.

## Nota u dokumentu — sa linkom

Kad je link kreiran, nota na prodajnoj narudžbi se odmah ispuni:

```
Plaćanje karticom preko Monri Pay By Link.
Čeka se plaćanje.
Link za plaćanje: https://ipgtest.monri.com/v2/order/a1b2c3…
Iznos: 149,00 BAM
```

Boilerplate markeri (`Čeka se plaćanje`, `Link za plaćanje`) su dodani u `_monri_sale_note_boilerplate`. Kada webhook potvrdi uplatu, postojeći handler `_monri_update_sale_orders_payment_note` **prepiše** pending notu finalnim detaljima (transaction id, autorizacija, maskirani PAN, iznos). Ručno dopisani tekst (npr. dodatne napomene o isporuci) ostaje — detekcija markera razlikuje boilerplate od originalnog sadržaja.

## Drugačiji landing route (ne `/payment/status`)

U e-commerce toku Odoo piše `tx.landing_route = '/payment/confirmation'`, pa sync redirect iz Monri-ja vodi na `/payment/status`, koja čita `__payment_monitored_tx_ids__` iz sesije. Naš kupac nema sesiju — `/payment/status` prikazuje fallback:

> **Nismo u mogućnosti da dodamo vaš metod plaćanja trenutno. Možete kliknuti ovde da budete preusmereni na stranicu potvrde.**

Rješenje: u `_monri_create_transaction` upisujemo custom landing route:

```python
access_token = self.sudo()._portal_ensure_token()
landing_route = "/my/orders/%s?access_token=%s&monri_pending=1" % (
    self.id, access_token,
)
tx = tx_model.create({
    ...,
    "landing_route": landing_route,
})
```

A u kontroleru `/payment/monri/return`:

```python
if tx and tx.landing_route and tx.landing_route.startswith("/my/"):
    return request.redirect(tx.landing_route)
return request.redirect("/payment/status")  # ecommerce fallback
```

Samo SO-driven flow koristi `/my/...` prefiks — e-commerce tok je netaknut.

## Pending-payment banner sa polling-om

Kad kupac završi na Monri-ju i vrati se na `/my/orders/<id>?...&monri_pending=1`, webhook koji flipuje tx u *done* još možda nije stigao. Prvi učitavanje portala pokaže pending notu — kupac bi morao ručno refresh-ovati da vidi zeleno stanje.

Dodali smo mali JS u `sale_portal_templates.xml`:

```xml
<template id="sale_order_portal_content_monri_pending"
          inherit_id="sale.sale_order_portal_content">
    <xpath expr="//div[@id='introduction']" position="before">
        <t t-if="request.params.get('monri_pending')">
            <div id="monri_pending_banner" class="alert alert-info">
                <span class="spinner-border spinner-border-sm me-2"/>
                <span>Čeka se potvrda plaćanja. Stranica će se
                      automatski osvježiti čim Monri potvrdi transakciju.</span>
            </div>
            <script><![CDATA[
              // Poll /payment/monri/so_status/<id> every 2s up to 60s.
              // When tx_state === "done" → reload without ?monri_pending=1.
            ]]></script>
        </t>
    </xpath>
</template>
```

Sa JSON endpoint-om autentifikovanim kroz `sale_order.access_token` (verifikacija kroz `odoo.tools.consteq` — bez otvaranja timing attack-a):

```python
@http.route("/payment/monri/so_status/<int:so_id>",
            type="json", auth="public", csrf=False, methods=["POST"])
def monri_so_status(self, so_id, access_token=None, **kw):
    order = request.env["sale.order"].sudo().browse(so_id).exists()
    if not order or not consteq(order.access_token or "", access_token or ""):
        return {"error": "forbidden"}
    tx = order.transaction_ids.filtered(
        lambda t: t.provider_code == "monri"
    ).sorted("id", reverse=True)[:1]
    return {"tx_state": tx.state if tx else "none"}
```

### Gotcha: Odoo `type='json'` i query-string

Prvi pokušaj proslijeđivao je `access_token` kao URL parametar (`?access_token=…`). Svaki poll je vraćao `{"error": "forbidden"}` — Odoo 16 JSON rute **ne čitaju URL query params kao kwargs**, samo `params` dict iz JSON tijela. Fix: staviti token u body:

```js
fetch("/payment/monri/so_status/" + soId, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
        jsonrpc: "2.0", method: "call",
        params: {access_token: token},
    }),
});
```

Potvrđeno curl-om protiv poznate plaćene narudžbe — vraća `{"tx_state":"done"}`.

## `ch_full_name` sanitizer — Monri odbija tačke

Nakon prvog pravog testa Monri je odbio zahtjev za partnera pod nazivom *"Domaća firma TEST d.o.o."* — `ch_full_name` validator ne prihvata tačke, zareze i slične znakove. `"Domaća firma TEST"` prolazi, `"Domaća firma TEST d.o.o."` ne.

Rješenje u `_monri_sanitize_name`:

```python
def _monri_sanitize_name(self, name):
    """Keep letters (incl. Bosnian diacritics), digits, spaces,
    hyphens, apostrophes; drop punctuation that Monri rejects."""
    cleaned = []
    for ch in str(name or ""):
        if ch in "-'" or ch.isspace() or ch.isalnum():
            cleaned.append(ch)
    return " ".join("".join(cleaned).split())
```

Testovi:

| Ulaz | Izlaz |
|---|---|
| `Domaća firma TEST d.o.o.` | `Domaća firma TEST doo` |
| `Firma, Sarajevo` | `Firma Sarajevo` |
| `Marie-Claire O'Brien` | `Marie-Claire O'Brien` (netaknuto) |

## SMTP — zašto reporti nisu slali email

Posljedični problem: "Send by Email" bi završio sa:

```
Mail delivery failed via SMTP server 'None'.
SMTPSenderRefused: (501, b'5.5.4 You are not allowed to send from this address.',
                    'bounce@bringout-test.hodi.ba')
```

### Korijen: instanca nije imala konfigurisan `ir.mail_server`

Na `hodi-bringout-test` bazi, `ir_mail_server` tabela je bila prazna. Odoo ne zna kuda da šalje — greška *"Connection failed (outgoing mail server problem)"*.

### Automatizacija kroz hodi_onboard

Dodali smo novi step u orchestration skriptu `hodi_odoo_set_smtp.py`:

```
hodi-onboard steps:
  prerequisites → credentials → ldap-users → stalwart-domain →
  stalwart-users → public-dns → odoo-modules → odoo-admin-pw →
  ⭐ odoo-smtp ⭐ → odoo-users → odoo-oidc → odoo-company
```

Skripta:

1. Upsert-a `ir.mail_server` koji pokazuje na lokalni Stalwart (`192.168.122.4:465 SSL`) sa SMTP AUTH-om kroz Administrator korisnika iz `credentials.yaml`.
2. Postavlja `mail.catchall.domain` na instance mail domen.
3. Postavlja `mail.default.from` na lokalni dio autentifikovanog korisnika.

Idempotentno — ponovo pokretanje updatuje postojeći red umjesto duplikata.

### Gotcha 1: `mail.bounce.alias` mora se poklapati sa auth userom

Stalwart auth relay strogo zahtijeva da `MAIL FROM` envelope bude jednak autentifikovanom korisniku. Odoo default `mail.bounce.alias = bounce` → envelope `bounce@bringout-test.hodi.ba`, Stalwart odbija sa **501 5.5.4**. Fix: postaviti `mail.bounce.alias = podrska` (poklapa se sa auth user-om podrska@bringout-test.hodi.ba).

### Gotcha 2: `mail.catchall.alias` se ne smije podudarati

Probao sam postaviti oba aliasa na `podrska` — Odoo konstraint odbija sa:

> *E-mail alias podrska@bringout-test.hodi.ba se već koristi kao odskok alias.*

`mail.catchall.alias` je za incoming (bounces koji se vraćaju) — ne utiče na outgoing, pa je ostavljen na default-u.

## Dugme u email-u — "Plati karticom"

Standardni Odoo "Send by Email" iz RFQ-a šalje šablon `sale.email_template_edi_sale` sa dugmetom "View Quotation". Za Pay By Link, hoćemo **prominentno zeleno dugme direktno u emailu** — kupac može platiti bez posjete portalu.

Željena HTML sekcija u emailu:

```html
<t t-if="object.monri_payment_url">
    <div style="text-align: center; padding: 16px; background: #eef7ee;">
        <p style="font-weight: 600; color: #2c662d;">
            Plaćanje karticom preko Monri Pay By Link
        </p>
        <a t-att-href="object.monri_payment_url"
           style="background: #0b5fb5; color: white; padding: 10px 22px;">
            Plati odmah karticom
        </a>
    </div>
</t>
```

Qweb sintaksa (`t-if`, `t-att-href`) jer `sale.email_template_edi_sale.body_html` koristi Qweb render engine.

### Gotcha 3: `ORM.write()` HTML-encoduje Qweb tagove

Prvi pokušaj (**16.0.2.5.0**) radio je kroz `tmpl.sudo().write({"body_html": new_body})`. Email se pojavio sa stiliziranim ali **mrtvim** dugmetom — klik ne vodi nigdje.

Provjera u bazi:

```
&lt;a t-att-href=&#34;object.monri_payment_url&#34; style=...&gt;
    Plati odmah karticom
&lt;/a&gt;
```

Sve Qweb oznake su HTML-entity-encoded. Razlog: `mail.template.body_html` je deklarisan sa `translate=True`, a translated-Html writer ekstraktuje "translation terms" i encodira non-whitelist tagove. `<t t-if>` i `t-att-href` nisu standardni HTML → escape-ovani.

### Fix (**16.0.2.5.1**): direktan SQL, zaobilazi ORM

```python
def inject_monri_block_into_sale_template(env):
    tmpl = env.ref("sale.email_template_edi_sale")
    env.cr.execute("SELECT body_html FROM mail_template WHERE id=%s", (tmpl.id,))
    body_by_lang = env.cr.fetchone()[0]  # jsonb {lang: html}
    new_body_by_lang = {}
    for lang, body in body_by_lang.items():
        body = _strip_existing_block(body or "")
        body = _insert_block(body)
        new_body_by_lang[lang] = body
    env.cr.execute(
        "UPDATE mail_template SET body_html = %s::jsonb WHERE id = %s",
        (json.dumps(new_body_by_lang), tmpl.id),
    )
    tmpl.invalidate_recordset(["body_html"])
```

Plus regex koji striping-uje i **korumpiranu entity-encoded** verziju prije ponovnog ubacivanja — tako upgrade automatski izliječi već pokvarene baze:

```python
_STRIP_PATTERNS = [
    re.compile(r"<!--\s*MONRI_LINK_BLOCK\s*-->.*?</t>\s*", flags=re.DOTALL),
    re.compile(r"&lt;!--\s*MONRI_LINK_BLOCK\s*--&gt;.*?&lt;/t&gt;\s*",
               flags=re.DOTALL),
]
```

Injekcija se pokreće iz:
- `post_init_hook` — kad se modul prvi put instalira
- `migrations/16.0.2.5.1/post-migrate.py` — pri upgrade-u

Provjerili u DB-u da `<t t-if="object.monri_payment_url">` i `t-att-href="..."` sad stoje kao literalni tagovi umjesto `&lt;` varijante. Email sada ima klikibilno dugme koje vodi na hosted Monri stranicu.

## Šta je sve nastalo danas

| Verzija | Promjena |
|---|---|
| **16.0.1.7.0** | SO-driven Pay By Link flow — `is_monri_pay_by_link` payment term, auto-create na save, Generate/Refresh button, URL polje na SO form-i |
| **16.0.1.7.1** | Fix: `Field 'sale.order.monri_payment_transaction_id' in dependency … should be searchable` warning (compute sva tri polja u jednom methodu bez `related=`) |
| **16.0.2.0.0** | Pending-note sa URL-om upisuje se u SO `note` polje kad je link kreiran |
| **16.0.2.1.0** | Stale-tx detekcija — regeneracija na SO update |
| **16.0.2.2.0** | `monri.contact.wizard` za nedostajući email/telefon |
| **16.0.2.2.1** | Wizard zatvara modal sa `act_window_close` |
| **16.0.2.3.0** | Custom landing route `/my/orders/<id>?access_token=…` (zaobilazi `/payment/status`) |
| **16.0.2.3.1** | `ch_full_name` sanitizer (Monri odbija tačke) |
| **16.0.2.4.0** | Pending-payment banner sa JS polling-om |
| **16.0.2.4.1** | Polling `access_token` u JSON body-ju umjesto query string-a |
| **16.0.2.5.0** | "Plati karticom" dugme u sale email šablonu (sa skrivenim bug-om) |
| **16.0.2.5.1** | Direct SQL injection — fix entity-encoded Qweb tagova |

Plus u `profile/hetzner`:

- Novi orchestration korak `hodi_odoo_set_smtp.py` (auth SMTP relay + `mail.bounce.alias` fix).
- Detaljna dokumentacija `docs/MONRI_PAYMENT_SCENARIOS.md` (u `odoo-bringout-payment_monri/docs/`) koja side-by-side uspoređuje dva scenarija.

## Kompletan tok — vizuelno

```
operater           sale.order                    Monri            kupac
   │                  │                             │                │
   │ create RFQ + Monri Pay By Link payment term    │                │
   │─────────────────>│                             │                │
   │                  │ write() → _monri_auto…      │                │
   │                  │ → _monri_create_transaction │                │
   │                  │   (REST, POST /v2/...)      │                │
   │                  │────────────────────────────>│                │
   │                  │<────────────────────────────│                │
   │                  │    {payment_url, id}        │                │
   │                  │                             │                │
   │                  │ tx.write(monri_payment_url, landing_route)   │
   │                  │ _monri_write_pending_sale_order_note()       │
   │                  │                             │                │
   │ Send by Email    │                             │                │
   │─────────────────>│ render email sa             │                │
   │                  │   <t t-if="object.monri_payment_url">        │
   │                  │     [Plati karticom]        │                │
   │                  │ → envelope MAIL FROM = podrska@…             │
   │                  │ → Stalwart 465 SSL auth relay ──────────────>│ (email)
   │                  │                             │                │
   │                  │                             │  click "Plati karticom"
   │                  │                             │<───────────────│
   │                  │                             │ pay card       │
   │                  │                             │<───────────────│
   │                  │                             │                │
   │                  │ async webhook POST          │                │
   │                  │   /payment/monri/callback   │                │
   │                  │<────────────────────────────│                │
   │                  │ _process_notification_data  │                │
   │                  │ tx.state = done             │                │
   │                  │ _monri_update_sale_orders_payment_note       │
   │                  │                             │ sync redirect  │
   │                  │                             │───────────────>│ /payment/monri/return
   │                  │                             │                │   ↓ custom landing_route
   │                  │                             │                │ /my/orders/42?access_token=…
   │                  │                             │                │   &monri_pending=1
   │                  │                             │                │   ↓ JS polling
   │                  │                             │                │ tx_state === "done"
   │                  │                             │                │   ↓ reload
   │                  │                             │                │ zelena nota sa finalnim
   │                  │                             │                │ transakcijskim detaljima
```

Sve to bez ijedne Odoo sesije na strani kupca — cijela autentifikacija ide preko `sale.order.access_token` i `consteq` provjere.

## Reference

- Modul: [odoo-bringout-payment_monri_pay_by_link](https://github.com/bringout/odoo-bringout-payment_monri_pay_by_link)
- Dokumentacija scenarija: `packages/bringout/odoo-bringout-payment_monri/docs/MONRI_PAYMENT_SCENARIOS.md`
- Monri Pay By Link: <https://ipg.monri.com/en/documentation/pay_by_link>
- Transaction Management: <https://docs.monri.com/docs/transaction-management>
- Deployment: `bringout-test.hodi.ba` (Hetzner, node61 Stalwart + Patroni PostgreSQL)

## Napomena

Generisano od strane Claude 🤖

---

Ernad Husremović, hernad@bring.out.ba
