---
title: 'www.hodi.ba header — Prijava/Odjava, pametna navigacija i back dugmad'
description: 'Header sajta sada zna ko je prijavljen: pokazuje email, mijenja Prijava↔Odjava, a Webmail link se prikazuje samo @hodi.ba korisnicima. Linkovi otvaraju u istom tabu, sa back dugmetom na svakom servisu.'
pubDate: '2026-05-16T17:30:00'
heroImage: '/hodi-header-prijava-odjava-hero.png'
---

Hodi.ba je tokom dana dobila set sitnih ali primjetnih navigacijskih unaprjeđenja: header sada zna ko je prijavljen, prikazuje email, mijenja **Prijava ↔ Odjava** dugme i selektivno skriva linkove koji nemaju smisla za određene korisnike.

Hero slika iznad je upravo to: korisnik prijavljen kao `hernad@bring.out.ba` vidi sve glavne linkove, **ali ne i Webmail** — jer Stalwart mail server na hodi.ba ne hostuje @bring.out.ba mailboxove. Desno gore stoji email + **Odjava** dugme.

---

## Šta je novo

### 1. Registracija i KEP verifikator u glavnoj navigaciji

Do sada su [registracija.kep.hodi.ba](https://registracija.kep.hodi.ba) (samoposlužni nalozi) i [provjeri.kep.hodi.ba](https://provjeri.kep.hodi.ba) ([Bosanski KEP verifikator](/blog/kep-verifikator-2026/)) bili dostupni samo preko spoljnih linkova ili Google pretrage. Sada su **direktno u headeru** — uz Početna, O nama i Blog.

Bonus: oba linka **otvaraju u istom tabu** (ne više `target="_blank"`). Razlog: previše tabova razbija tok, a postoji čist put nazad...

### 2. Back dugme "← Hodi.ba" na svakom servisu

Oba KEP servisa sada imaju malo **`← Hodi.ba`** dugme gore-lijevo na svakoj stranici:

- [provjeri.kep.hodi.ba](https://provjeri.kep.hodi.ba) v0.15.1
- [registracija.kep.hodi.ba](https://registracija.kep.hodi.ba) v0.5.1

Klik vraća na www.hodi.ba u istom tabu. Tako se ne nakuplja "stranded tab" problem — uvijek znate gdje ste i kako natrag.

### 3. Prijava / Odjava desno gore

Najveća promjena. Header sada uvijek završava sa pill-button dugmetom desno:

- **Anonimni korisnik:** vidi **`Prijava`** → klik vodi na [auth.hodi.ba](https://auth.hodi.ba) portal (naš [Authelia](/blog/authelia-sso-hodi-2026/) SSO). Nakon uspješne prijave, korisnik je vraćen na www.hodi.ba.
- **Prijavljen korisnik:** dugme se mijenja u **`Odjava`**, a pored njega se prikazuje **email** prijavljenog korisnika (npr. `hernad@bring.out.ba`).

Bez prečaca, bez zaboravljanja "da li sam ulogovan ili ne".

### 4. Pametan Webmail link

[Webmail](https://webmail.hodi.ba) (Roundcube koji čita Stalwart mailbox-e) **radi samo za @hodi.ba naloge**. Korisnik prijavljen kao `hernad@bring.out.ba` ako klikne Webmail završava na "Pristup odbijen" stranici jer mu Stalwart ne pravi mailbox.

Umjesto da ih puštamo u taj cul-de-sac, header **automatski skriva Webmail link** za sve čiji email **ne završava sa `@hodi.ba`**. Manje frustracije, jasnija UX poruka: "ovo nije za tebe".

> Za sada se to odnosi na korisnike sa @bring.out.ba i drugih domena koji se prijavljuju kroz isti Authelia SSO. Ako se ikada otvori webmail i za druge domene, ovaj filter će se proširiti.

---

## Kako radi (na visokom nivou)

www.hodi.ba je **statički Astro sajt**, izgrađen unaprijed i posluživan kao HTML/CSS/JS. Statički sajt ne zna ko ga čita — sve verzije stranice su iste za sve posjetioce.

Ali browser u sebi nosi cookie za naš [Authelia](https://auth.hodi.ba) SSO (ako ste ranije ulogovani na nekom drugom hodi.ba servisu). Reverse proxy ispred sajta zna kako pitati Authelia "ko je vlasnik ovog cookie-ja". Tako:

1. **Browser** učita statičku stranicu (sa default Prijava dugmetom).
2. Mali komad **JS-a** u headeru pošalje pitanje na same-origin endpoint `/api/whoami`.
3. **Reverse proxy** dohvati email iz Authelia sesije i vrati ga kao JSON.
4. JS prilagodi header: zamijeni Prijava sa Odjava, prikaže email, skije Webmail po potrebi.
5. **Anonimni korisnici** dobijaju 401 na taj poziv → ništa se ne mijenja, vide default (Prijava + sve linkove).

Ova dvodjelna arhitektura (statički HTML + dinamička JS dekoracija) čuva brzinu Astro sajta i nudi **personalizovan header** bez ikakve server-side state mašinerije za sam blog.

---

## Zašto ovaj redoslijed promjena

Velika slika je da hodi.ba postaje **integrirana platforma** umjesto skupa nezavisnih servisa. Imamo:

- [registracija.kep.hodi.ba](https://registracija.kep.hodi.ba) — kako napraviti nalog ([detaljan opis](/blog/registracija-kep-hodi-v05-2026/))
- [provjeri.kep.hodi.ba](https://provjeri.kep.hodi.ba) — kako provjeriti KEP ([v0.15.0 sa CRL+OCSP](/blog/kep-verifikator-crl-ocsp-2026/))
- [auth.hodi.ba](https://auth.hodi.ba) — Authelia portal, jedna prijava za sve
- Webmail, Forgejo (git.hodi.ba), Odoo instance...

Svaki od ovih servisa je vrijedio sebi. Ali ako želite da neko zaista koristi platformu, **morate omogućiti da skok između njih bude trivijalan**. Ovaj redizajn headera je upravo to: jedna konzistentna traka koja te prati kroz cijelu platformu, znaš gdje si, znaš ko si, znaš kako nazad.

---

## Šta dalje

Sljedeće u redu:

- **Selektivno skrivanje drugih linkova** zavisno od grupne pripadnosti — npr. admin-only linkovi (uptime monitoring, Forgejo admin)
- **Status indikatori** — npr. badge na Odjava dugmetu ako je sesija pri kraju isteka
- **Brzi pristup** — keyboard shortcut za skok između servisa bez klikanja po headeru

Ako vam nedostaje neka funkcionalnost u headeru ili imate ideju, otvoreni smo za prijedloge — pošaljite mail na hernad@bring.out.ba ili otvorite issue na našem [git.hodi.ba/bringout/www.hodi.ba](https://git.hodi.ba/bringout/www.hodi.ba) (potrebna [registracija](/blog/registracija-kep-hodi-v05-2026/)).

---

## Napomena

Generisano od strane Claude 🤖

---

Ernad Husremović, hernad@bring.out.ba
