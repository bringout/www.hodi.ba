---
title: 'registracija.kep.hodi.ba v0.5.0 — KEP novi zahtjevi'
description: 'registracija-kep-hodi v0.5.0: jedan KEP-potpisan PDF, tri vrste zahtjeva — nova registracija, reset lozinke, admin-otvaranje naloga za drugog korisnika. Polje Predmet u PDF-u određuje šta će se desiti.'
pubDate: '2026-05-13T19:00:00'
heroImage: '/registracija-kep-hodi-v05-admin-pdf.png'
---

Prije par dana smo objavili [registracija.kep.hodi.ba](/blog/hodi-onboard-kep-2026.md/) — self-service onboarding gdje korisnik pošalje KEP-potpisan PDF i dobije nalog na hodi.ba. Servis je radio, ali se brzo pokazalo da nedostaju dva česta scenarija: korisnik koji je zaboravio lozinku i admin koji treba otvoriti nalog kolegi koji nema vlastiti KEP.

Umjesto da pravimo tri odvojena servisa, proširili smo postojeći **[registracija.kep.hodi.ba](https://registracija.kep.hodi.ba)** verzijom **`registracija-kep-hodi v0.5.0`**. Polje `Predmet` u PDF-u sada određuje vrstu zahtjeva — sve ostalo (KEP validacija, name + datum cross-check, rate-limit, antispam) ostaje identično. Hero slika iznad pokazuje upravo treću, najinteresantniju varijantu: admin-mediated zahtjev gdje administrator svojim KEP-om otvara nalog kolegi.

![hodi.ba — KEP zahtjevi: forma za upload PDF-a sa instrukcijama za sve tri vrste zahtjeva](/registracija-kep-hodi-v05-form.png)

## Tri vrste zahtjeva

Polje `Predmet` na prvoj liniji PDF-a određuje rutu. Sva ostala pravila su ista: ime na certifikatu se mora poklapati sa „Ime i prezime", a datum potpisa mora biti isti kalendarski dan kao „Datum prijave" (Europe/Sarajevo).

### 1. Nova registracija

```
Predmet: Registracija na hodi.ba

Ime i prezime: VAŠE IME I PREZIME
Datum prijave: dd.mm.yyyy
email: vas@email.ba
```

Identično originalnom toku — stiže potvrdni email, klikom se kreira nalog u LLDAP-u, dodaje se u grupu `hodi-users`, sledeći Forgejo team-sync ga uvodi u `hodi-users` timove `bringout` i `oca` organizacija.

**Bonus**: ako email već postoji u sistemu, ne dobijate grešku — automatski se prebacujete u tok 2 (reset lozinke). Niko ne mora pamtiti koji oblik zahtjeva mu treba ako je već registrovan.

### 2. Reset lozinke

```
Predmet: Zaboravljena šifra na hodi.ba

Ime i prezime: VAŠE IME I PREZIME
Datum prijave: dd.mm.yyyy
email: vas@email.ba
```

Bez link-potvrde — KEP potpis je sam po sebi dovoljan dokaz identiteta. Ako se ime sa certifikata poklapa sa imenom u PDF-u i email postoji u LLDAP-u, generiše se nova nasumična lozinka i odmah šalje na korisnikov email. Vrijeme od „uploadovao sam PDF" do „logirao sam se sa novom lozinkom" je manje od 30 sekundi.

### 3. Registracija novog korisnika (samo administratori)

```
Predmet: Zahtjev za registraciju novog korisnika

Ime i prezime: VAŠE IME I PREZIME
Datum prijave: dd.mm.yyyy
Novi korisnik: IME I PREZIME NOVOG KORISNIKA
email: email-novog-korisnika@example.com
```

![Admin sekcija forme — uputstvo za zahtjev kojim admin otvara nalog drugom korisniku](/registracija-kep-hodi-v05-admin-section.png)

Ovo je novi tok. Potpisnik je administrator (član LDAP grupe `hodi-admins`) koji svojim KEP potpisom garantuje za drugu osobu. Provjere koje rade:

- ime sa certifikata se poklapa sa „Ime i prezime" (potpisnika)
- datum potpisa = „Datum prijave" (isti dan, Europe/Sarajevo)
- potpisnik (po emailu iz polja `email`) postoji u LLDAP-u i član je grupe `hodi-admins`
- email novog korisnika ne postoji već u sistemu

Ako sve prolazi, nalog za novog korisnika se kreira **odmah** — bez potvrdnog linka, jer je KEP potpis admina pravni ekvivalent njegove garancije. Welcome email sa početnom lozinkom ide direktno na adresu novog korisnika. Konkretan primjer ovog toka je upravo hero slika ovog posta: Ernad Husremović (član `hodi-admins`) svojim KEP-om traži otvaranje naloga za Faruka Husremovića.

Iz pravne perspektive: KEP potpis admina je trag ko je inicirao kreiranje, kada, za koga. PDF se čuva sa metadata-om u audit logu — pa imamo trajni dokaz ko je za kojeg korisnika garantovao u trenutku otvaranja naloga.

## Šta je ostalo isto

Ne ponavljamo cijelu priču iz prošlog posta — sve što je tamo opisano i dalje vrijedi:

- KEP validacija delegirana na [provjeri.kep.hodi.ba](https://provjeri.kep.hodi.ba)
- ime + datum cross-check (case-insensitive, dijakritike normalizovane, Europe/Sarajevo timezone)
- antispam (honeypot + signed form-token sa min/max time window + slowapi 5/h rate-limit)
- max 100 KB upload
- LLDAP user create + RFC 3062 password set
- automatsko dodavanje u grupu `hodi-users` (osim kod toka 2)
- periodični `forgejo-hodi-users-sync.timer` na builder-6 svake 2 minute uvodi nove korisnike u `hodi-users` timove svih Forgejo organizacija koje ih imaju (trenutno `bringout`, `oca`)

## Šta se promijenilo u stack-u

| Komponenta | Prije | Sada |
|---|---|---|
| Verzija | `0.1.0` | `0.5.0` |
| Routing | Predmet ignorisan | Predmet → ruta (3 vrste) |
| Reset lozinke | Nema | Direktno, bez confirmation maila |
| Admin-mediated open | Nema | `hodi-admins` member → instant create |
| Email-postoji slučaj | 409 greška | Auto-fallback na reset tok |
| LDAP grupa za admine | Nema | `hodi-admins` (server-side check) |

## Napomena

Generisano od strane Claude 🤖

---

Ernad Husremović, hernad@bring.out.ba
