---
title: 'KEP verifikator — slojevita zaštita registracione forme od bot napada'
description: 'Kako smo na provjeri.kep.hodi.ba zaustavili spam registracije bez CAPTCHA — honeypot, heuristike sadržaja i potpisani timestamp forme.'
pubDate: '2026-05-08T16:30:00'
heroImage: '/kep-pristup-servisu.png'
---

Naš [Bosanski KEP verifikator](/blog/kep-verifikator-2026/) na [provjeri.kep.hodi.ba](https://provjeri.kep.hodi.ba) koristi **email-bazirano odobravanje pristupa**: korisnik ostavi ime, organizaciju i email, administrator ručno odobri zahtjev, a korisnik dobija pristup link.

Ovaj jednostavan tok je nedavno postao meta automatizovanog spama — bot je u kratkim razmacima slao desetke registracija sa **nasumično generisanim imenima i organizacijama** ali sa **stvarno izgledajućim email adresama**. Cilj? Najvjerovatnije probiti SMTP reputaciju, nasumice triggrati pristupne mailove, ili samo zatrpati admin notifikacije.

Per-IP rate limit (`5/h`) nije bio dovoljan jer su zahtjevi dolazili iz **rotirajućeg pula IP adresa**. Trebao nam je zaštitni sloj koji ne ovisi o IP-u.

---

## Zašto ne CAPTCHA?

CAPTCHA je očigledno rješenje, ali za interni servis koji koristi mali broj korisnika svako trenje na ulaznoj formi je trošak:

- **Cloudflare Turnstile / hCaptcha** — eksterni JS, dodatni privacy footprint, treba CSP i ključeve
- **Google reCAPTCHA** — Google praćenje korisnika, što je za KEP servis neprikladno
- **Slika sa tekstom** — frustrira ljude više nego što zaustavlja moderne botove

Umjesto toga, primijenili smo **slojevitu zaštitu** koja je nevidljiva za stvarnog korisnika i lažno transparentna za bota.

---

## Princip: tihi pad

Najvažnija odluka nije *kako* detektovati bota — nego **šta uraditi nakon detekcije**.

Većina formi vraća `400 Bad Request` ili poruku "spam detektovan". To je **najgori mogući feedback botu**: autor skripte odmah vidi koji je zahtjev odbijen i može iterirati. Naš pristup je suprotan:

> Ako forma izgleda kao spam, server vraća **isti HTTP 200 OK** i **istu success poruku** kao i kod legitimnog zahtjeva — ali bez upisa u bazu i bez slanja maila administratoru.

Iz pozicije bota, sve "radi". Iz pozicije nas, ništa se nije desilo. Bot se ne adaptira jer ne vidi razliku.

---

## Slojevi zaštite

Forma sada prolazi kroz nekoliko nezavisnih provjera. Detalje implementacije namjerno ne objavljujemo — bot autor čita blogove. Ali principi su poznati i decenijama korišteni:

### 1. Honeypot polje

Forma sadrži **dodatno polje koje pravi korisnik nikad ne vidi** (CSS pomjeranje izvan ekrana, `tabindex=-1`, `aria-hidden`). Bot koji slijepo popunjava sva input polja popuni i to. Ako server vidi popunjeno honeypot polje — tihi pad.

Ovo zaustavlja **najjeftinije botove** — generičke skripte koje samo tilkamo `POST` na svaku formu na webu.

### 2. Heuristika sadržaja

Spam koji nas je pogađao imao je vrlo karakterističnu signaturu — **nasumični nizovi malih slova bez razmaka i bez vokala** ("ivsuxnqoer", "wuekgewfpe", itd.). Stvarna ljudska imena imaju razmak (ime + prezime) i sadrže vokale. To su **dvije proste heuristike** koje skoro ne daju false positive (osim za jako kratka jednosložna imena, što ionako ne odgovara format polju "Ime i prezime").

Ovo zaustavlja **ciljane botove** koji znaju za honeypot pa ga preskaču — ali još uvijek šalju gibberish kao sadržaj.

### 3. Potpisani timestamp forme

Kad korisnik otvori `/register`, server **upisuje u skrivenu hidden vrijednost potpisani timestamp** trenutka renderovanja stranice. Pri submit-u, server provjerava:

- da li je potpis validan (signing key na server-side, bot ne može falsifikovati),
- da li je potpis **dovoljno star** (čovjek ne može popuniti formu trenutno),
- da li je potpis **dovoljno svjež** (sprečava reuse jednog tokena za 1000 zahtjeva).

Ovo zaustavlja **automatizovane botove** koji `POST`-uju direktno bez prethodnog `GET`-a stranice. Većina spam alata radi upravo to — preskaču render i šalju samo `POST` payload.

### 4. Per-IP rate limit (postojeće)

Originalnih `5/h` po IP adresi i dalje stoji kao četvrti sloj — protiv pojedinačnih napadača koji se ne maskiraju.

---

## Zašto baš ova kombinacija

Svaki sloj zaustavlja **drugu klasu napadača**:

| Sloj | Zaustavlja |
|------|------------|
| Honeypot | Generičke "popuni sve forme" botove |
| Heuristika sadržaja | Botove koji znaju strukturu forme ali generišu gibberish |
| Timestamp forme | Direktne `POST` napade bez render-a stranice |
| Rate limit | Single-source flood napade |

Da bi prošao kroz sve četiri provjere, napadač bi morao:

1. Učitati stvarnu HTML stranicu (koštaa CPU/bandwidth),
2. Izvući signed token iz forme (parsiranje DOM-a),
3. Sačekati realno vrijeme prije submit-a (gubitak throughputa),
4. Generisati uvjerljiva imena (real-name dataset, košta resurs),
5. Izbjeći honeypot polje (čitanje CSS-a),
6. Ne ponavljati iz iste IP klase.

To je **mnogo veći trošak** nego što vrijedi spam registracija na servisu sa par desetina korisnika.

---

## Rezultat

Nakon deploya:

- Stvarni korisnici ne primjećuju razliku (forma izgleda identično).
- Bot zahtjevi se **tiho odbacuju** — admin više ne dobija poplavu mailova.
- Ne koristimo eksterni CAPTCHA servis, ne tracking-uje se nijedan korisnik, nema dodatnih JS dependency-a.

Privacy first, accessibility second, sigurnost rezultat oba — pristup koji smatramo prirodnim za servis koji rukuje **kvalifikovanim elektronskim potpisima**.

---

## Pouke

1. **Tihi pad pobjeđuje glasni pad.** Bot autoru ne treba davati feedback signal.
2. **Slojevitost.** Nijedna pojedinačna heuristika ne pokriva sve napadače; lanac jeftinih provjera pokriva.
3. **CAPTCHA je trade-off.** Za male servise, smart heuristike često rade jednako dobro bez UX cijene.
4. **Eksternalije se akumuliraju.** Svaki dodatni JS, svaki tracker, svaki vendor lock-in je dug; izbjeći ako se može.

Ako vodite sličan registracioni endpoint i borite se sa spamom — preskočite reCAPTCHA refleks i razmislite šta bot zapravo *radi*. Vjerovatno postoji jeftiniji način da ga zaustavite.

---

## Napomena

Generisano od strane Claude 🤖
