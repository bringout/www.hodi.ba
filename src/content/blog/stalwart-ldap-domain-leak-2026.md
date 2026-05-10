---
title: 'Stalwart + LDAP: kad jedan zalutali korisnik “otme” cijeli domen'
description: 'Debug priča: Stalwart mail server je odbijao sve adrese tuđeg domena sa "5.1.2 Mailbox does not exist" jer je u LDAP-u postojao samo jedan zapis sa mail-om u tom domenu. Rješenje je u LDAP filteru.'
pubDate: '2026-05-10T17:36:00'
heroImage: '/stalwart-ldap-domain-leak-hero.svg'
---

Korisnik je pokušao da se registruje na našem registracionom servisu i dobio nazad poruku:

> *Greška pri slanju email-a za potvrdu. Pokušajte ponovo kasnije.*

Tipičan prijavljen kvar — "ne radi mi nešto, vidi šta je". Ovaj post je rekonstrukcija kako je vođena dijagnoza, šta je tačno bilo, i kako je popravljeno na razini Stalwart konfiguracije i internog Stalwart store-a.

## Postavka

Imamo internu mrežu sa nekoliko VM-ova. Za potrebe ovog posta zovimo ih:

- **nodeA** — Stalwart mail server (SMTP submission na 465, IMAPS na 993). Stalwart koristi PostgreSQL store i LDAP direktorij za korisnike.
- **nodeB** — LLDAP (lagan LDAP server) sa centralnim korisničkim zapisima koje koriste razni servisi (Forgejo, SSO, mail itd.).
- **nodeC** — registracioni servis (FastAPI / Python). Šalje email potvrde preko SMTP submission-a (port 465, autentikovano) prema nodeA.

Stalwart je konfigurisan da kao izvor istine za korisnike koristi LDAP:

```toml
[directory.ldap]
url = "ldap://nodeB:3890"
base-dn = "dc=lokalni,dc=tld"

[directory.ldap.filter]
email = "(&(objectClass=person)(mail=?))"
name  = "(&(objectClass=person)(|(uid=?)(mail=?)))"
```

Filter je elegantno minimalan — `?` je placeholder koji Stalwart u runtime-u zamijeni sa adresom koju traži.

## Simptom

Kad korisnik pošalje formu:

1. Aplikacija na **nodeC** zove `aiosmtplib` i pokušava poslati confirmation mail preko **nodeA**.
2. Stalwart vraća:

```
550 5.1.2 Mailbox does not exist.
```

3. Aplikacija to izloži kroz UI kao "Greška pri slanju emaila".

Zanimljiva stvar je da je adresa kojoj se šalje email **u potpuno drugom domenu** — ne onom koji je nodeA inače hostuje. Logički, Stalwart bi trebao da pokuša da relaja email prema vanjskom MX-u tog domena, ne da odbija kao da se radi o lokalnom mailbox-u.

## Šta logovi kažu

Na **nodeA** (Stalwart):

```
17:05:47 SMTP EHLO listenerId="submissions" remoteIp=nodeC
         domain="registracija.lokalni.tld"
17:05:47 auth.success accountName="epotpis"
17:05:47 SMTP MAIL FROM from="epotpis@local.tld"
17:05:47 smtp.mailbox-does-not-exist  to="korisnik@foreign.tld"
```

Na **nodeC** Python traceback:

```
aiosmtplib.errors.SMTPRecipientsRefused:
  [SMTPRecipientRefused(550, '5.1.2 Mailbox does not exist.',
                        'korisnik@foreign.tld')]
```

Stalwart svjesno tretira `foreign.tld` kao **lokalni** domen, i jer ne postoji mailbox za `korisnik` — odbije ga.

Bonus dokaz iz starijih logova istog dana: vanjski Gmail server je pokušavao da isporuči DSN bounceove na `podrska@foreign.tld` direktno na nodeA, i isto su završili sa `Mailbox not found`. Znači stvar je sistemska, ne specifična za jedan registracioni POST.

## Zašto Stalwart misli da je `foreign.tld` lokalni domen?

Stalwart admin REST API otkriva listu domena:

```bash
curl -u admin:*** http://nodeA:8080/api/principal?type=domain
```

```json
[
  {"name": "local.tld",          "members": 2},
  {"name": "sub1.local.tld",     "members": 5},
  ...
  {"name": "foreign.tld",        "members": 1}
]
```

`foreign.tld` zaista jeste u listi, sa **jednim** članom. Ko je taj jedan?

```bash
curl -u admin:*** "http://nodeA:8080/api/principal?filter=foreign.tld"
```

Vraća jedan zapis tipa `individual` koji je primarno korišten za neki interni alias / leftover. Bitno je: njegov `mail` atribut je `nesto@foreign.tld`.

I tu je pukla greda.

## Root cause u jednoj rečenici

> Stalwart svaki domen koji ima ijednog principala iz LDAP-a auto-registruje kao **lokalni domen**, a LDAP filter `(mail=?)` nema nikakvu zaštitu od toga koje domene smiju ući.

Praktično: čim u LLDAP-u postoji *bilo koji* zapis sa `mail` atributom u tuđem domenu, Stalwart počne da se ponaša kao da on hostuje taj domen — ali bez ostalih mailbox-a u njemu — i odbija sve ostale adrese sa `5.1.2`.

LLDAP, s druge strane, sasvim opravdano ima taj zapis: koristi se kao identitet u Forgejo / SSO-u, i logično vlasnik tog identiteta tamo ima svoj pravi mail (`@foreign.tld`). Niko nije pogriješio na strani LDAP-a — pogrešna je pretpostavka u Stalwart-u.

## Rješenje

Cilj: zadržati LLDAP zapise netaknute (drugi servisi ih trebaju), ali natjerati Stalwart da **prepoznaje samo mailbox-e u dozvoljenim domenima**.

LDAP filter sintaksa to lijepo radi — dodajemo suffix guard koji zahtijeva da entry ima i bar jedan `mail` atribut sa odgovarajućim sufiksom:

```toml
[directory.ldap.filter]
email = "(&(objectClass=person)(mail=?)(|(mail=*@local.tld)(mail=*@*.local.tld)))"
name  = "(&(objectClass=person)(|(uid=?)(mail=?))(|(mail=*@local.tld)(mail=*@*.local.tld)))"
```

Šta se sad dešava kad Stalwart traži `korisnik@foreign.tld`? Substituirani filter postaje:

```
(&(objectClass=person)
   (mail=korisnik@foreign.tld)
   (|(mail=*@local.tld)(mail=*@*.local.tld)))
```

LDAP entry sa `mail=nesto@foreign.tld` (i ničim drugim u `mail`) **ne zadovoljava** drugi `OR` uslov, pa rezultat je prazan. Stalwart vidi `korisnik@foreign.tld` kao **nepoznatog primaoca** → ne smatra `foreign.tld` lokalnim → relaja prema vanjskom MX-u. To je tačno ono što hoćemo.

> **Caveat:** LDAP entry može imati više `mail` vrijednosti. Korisnik koji ima i `pera@local.tld` i `pera@foreign.tld` će *i dalje* biti pronađen kad se traži `pera@foreign.tld`, jer prvi `mail` zadovoljava prvi uslov, a drugi (drugi mail vrijednost na istom entry-ju) zadovoljava sufiks. Ako želimo strogo spriječiti to, treba ići korakom više — ali u našem slučaju sumnjivi entry ima samo jedan `mail` atribut, pa filter je dovoljan.

### LDAP filter nije sve

Kad je filter primijenjen i Stalwart restartovan, prvi test je opet vratio `5.1.2`. Razlog: Stalwart **persistira** principalova koja je jednom auto-import-ovao iz LDAP-a u svoj PostgreSQL store. Promjena LDAP filtera utiče samo na *nove* lookup-e, ali stari, već zapisani principal i njegov auto-registrovani `foreign.tld` domen još uvijek žive u DB-u.

Trebalo je počistiti i to:

```bash
# obriši leftover principala
curl -u admin:*** -X DELETE \
  http://nodeA:8080/api/principal/<uid-koji-je-bio-leftover>

# obriši i auto-registrovani domen
curl -u admin:*** -X DELETE \
  http://nodeA:8080/api/principal/foreign.tld

# restart da se isprazne in-memory cache-evi
systemctl restart stalwart-mail
```

Sa novim filterom na snazi, Stalwart **neće** pokušati ponovo da reimportuje principala iz LDAP-a kad sljedeći lookup za istu adresu dođe — jer mu LDAP više ne vraća match.

## Verifikacija

Pošaljemo test poruku iz nodeC ka neutralnoj adresi u tuđem domenu:

```bash
curl -u epotpis:*** --ssl-reqd "smtps://nodeA:465" \
  --mail-from "epotpis@local.tld" \
  --mail-rcpt "test-relay@foreign.tld" \
  -T payload.eml
```

Stalwart log na nodeA:

```
SMTP RCPT TO  to="test-relay@foreign.tld"
queue.queue-message-authenticated   queueName="submissions"
delivery.attempt-start              queueName="remote"
delivery.domain-delivery-start      domain="foreign.tld"
delivery.connect                    hostname=mx.foreign.tld
                                    remoteIp=<pravi MX iz DNS-a>
                                    remotePort=25
```

Dakle — RCPT prošao, poruka stavljena u **remote** red, MX rezolvovan, konekcija otvorena prema pravom mailserveru. Tačno ono što originalno nije radilo.

Bonus: stari Gmail bounce DSN-ovi za `podrska@foreign.tld` od istog dana su, posredno, takođe popravljeni — više neće biti odbijeni kao `Mailbox not found` i biće relajani prema pravom MX-u.

## Pouka

Kad mail server koristi LDAP kao identity store i istovremeno ima koncept "lokalnih domena" izveden iz onoga šta se nađe u LDAP-u, **filter mora biti obrambeno restriktivan**, ne maksimalno permisivan. Jedan zapis u tuđem domenu, koji je za drugi servis sasvim legitiman, dovoljan je da pretvori cijeli vanjski domen u "našu" praznu sjenu — sa rezultatom da nijedan mail tom domenu ne stigne.

Praktično pravilo:

1. U LDAP filteru za mail server uvijek **bijela lista** dozvoljenih domena (suffix guard preko `OR` izraza).
2. LDAP zapise namijenjene drugim servisima (SSO, Git, ...) **drži van mail backend-a** — ne dirati ih, samo filtrirati pri ulazu u mail.
3. Nakon promjene filtera, **ne zaboravi DB cleanup**: principalovi i domeni koje je mail server jednom autoimportovao trajno žive u njegovom store-u. REST API je tu da ih obriše.
4. Nakon svega — pošalji probu i *pročitaj log*: vidi da li poruka padne u `local` queue (pogrešno) ili u `remote` queue sa MX rezolucijom (ispravno).

Filter izmijenjen, store očišćen, restart završen, proba prošla. Originalni korisnik može ponoviti registraciju i confirmation email će stići.

## Napomena

Generisano od strane Claude 🤖

---

Ernad Husremović, hernad@bring.out.ba
