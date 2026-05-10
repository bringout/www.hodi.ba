---
title: 'Onboarding na hodi.ba preko KEP-potpisanog PDF-a'
description: 'Self-registration servis registracija.kep.hodi.ba: korisnik pošalje KEP-potpisan PDF, dobije nalog u LLDAP-u, automatski se pridruži hodi-users timovima u svim Forgejo organizacijama koje ih imaju (bringout, oca).'
pubDate: '2026-05-10T08:30:00'
heroImage: '/hodi-onboard-input-pdf.png'
---

Predstavljamo **registracija.kep.hodi.ba** — self-service onboarding na hodi.ba ekosistem. Korisnik popuni jednostavan PDF obrazac, potpiše ga svojim KEP-om (IDDEEA, UIO ili BHP), učita ga, klikne potvrdni link u emailu — i dobija pristup SSO portalu (Authelia) i git serveru (Forgejo) sa pravom da kontribuira public repozitorijima.

Servis je dostupan na: [registracija.kep.hodi.ba](https://registracija.kep.hodi.ba)

## Tok korisnika

1. **Pripremiti PDF** sa fiksnom strukturom:

```
Predmet: Registracija na hodi.ba

Ime i prezime: VAŠE IME I PREZIME
Datum prijave: dd.mm.yyyy
email: vas@email.ba
```

2. **Potpisati ga** svojim KEP-om — bilo koji od podržanih izdavača (IDDEEA, UIO, BHP) prolazi. Evo izgleda jednog konkretnog popunjenog i potpisanog primjera:

   ![Primjer potpisanog PDF-a](/hodi-onboard-input-pdf.png)

3. **Učitati PDF** na [registracija.kep.hodi.ba](https://registracija.kep.hodi.ba). Forma je intencionalno minimalna — instrukcije + jedan upload.

   ![Forma za upload PDF-a — maksimalno 100 KB](/hodi-onboard-register-form.png)

   Servis pod haubom poziva [provjeri.kep.hodi.ba](https://provjeri.kep.hodi.ba) za samu KEP validaciju i dodatno cross-checkuje:
   - ime sa certifikata (givenName + surname) protiv polja `Ime i prezime` u tijelu PDF-a (case-insensitive, dijakritike normalizovane)
   - datum potpisivanja protiv `Datum prijave` (isti kalendarski dan u Europe/Sarajevo zoni)

   Ako sve prolazi, dobijate potvrdu da je email sa linkom poslan:

   ![Potvrda da je email sa linkom poslan](/hodi-onboard-register-success.png)

4. **Stiže email sa potvrdnim linkom** (vrijedi 72 sata). Klikom se otvara `/confirm` ruta koja:
   - kreira korisnika u LLDAP-u (`uid` = sanitizovani full-email, npr. `hernad@bring.out.ba` → `hernad-bring-out-ba`)
   - postavlja nasumičnu početnu lozinku
   - dodaje korisnika u LDAP grupu `hodi-users`
   - šalje korisniku welcome email sa korisničkim imenom i lozinkom

5. **Prijava na git.hodi.ba** preko Authelia SSO. Forgejo automatski auto-registruje korisnika (jer je prvi put da se logira) i, zato što je u OIDC `groups` claim-u stigla `hodi-users`, postavlja im flag `is_restricted=true` — što znači da nemaju default vidljivost cijelog Forgejo katasloga.

## "Restricted" status — i šta dolazi poslije

Forgejo `restricted` user vidi samo repozitorije i organizacije kojima je **eksplicitno** dodat. Tako svježe samoregistrovani hodi.ba korisnik na prvi login ne vidi `bringout/` (privatna org) niti `oca/` mirrored repozitorije. Ovo je sigurnosni default — ne želimo da bilo ko ko se registrira preko PDF-a ima vidljivost svega.

![Prvi login na git.hodi.ba — 0 repozitorija, 0 organizacija](/hodi-onboard-git-before-sync.png)

Ali korisnik **treba** dobiti pristup repozitorijima na koje je org pristao da prihvata kontribucije. Za to imamo `hodi-users` tim u svakoj relevantnoj Forgejo organizaciji.

## Periodična team-membership sinkronizacija

Na `builder-6` (host gdje radi Forgejo) postoji systemd timer `forgejo-hodi-users-sync.timer` koji svake 2 minute:

1. Listanjem `/api/v1/admin/users` (admin token sa scope-om `read:admin,write:organization`) pronalazi sve Forgejo korisnike sa `restricted=true`.
2. Dinamički prolazi kroz sve Forgejo organizacije (`/api/v1/admin/orgs`).
3. Za svaku organizaciju pretražuje team imena `hodi-users` (`/api/v1/orgs/{org}/teams/search`).
4. Ako tim postoji, dodaje sve restricted korisnike koji nisu već članovi (`PUT /api/v1/teams/{id}/members/{username}` — idempotentno).

Trenutno samo `bringout` i `oca` imaju `hodi-users` tim, pa novi korisnik dobije pristup tim dvjema organizacijama. Ako sutra `cybrosys` ili neka druga organizacija odluči otvoriti vrata hodi.ba kontributorima, dovoljno je da kreiraju `hodi-users` tim sa željenim repository pristupima — sledeći tick sinkronizacije ih automatski uključi.

Evo izgleda istog korisničkog naloga 30 sekundi kasnije, nakon što je sync timer odradio svoj posao:

![Nakon team sync-a — 47 repozitorija, 2 organizacije](/hodi-onboard-git-after-sync.png)

47 repozitorija u dvije organizacije postalo vidljivo, bez ijedne ručne intervencije. Korisnik može fork-ati, klonirati, pratiti issue-e — sve preko jednog SSO logina.

## Tehnički stack

| Komponenta | Tehnologija |
|---|---|
| Web servis | FastAPI (Python 3.12) na `node67:8082` |
| KEP validacija | delegirana na `provjeri.kep.hodi.ba` API (`/api/v1/verify`) |
| PDF parsing | `pypdf` (regex per liniji forme) |
| LDAP klijent | `ldap3` (user create + RFC 3062 password) + GraphQL (group membership) |
| Email | aiosmtplib → Stalwart (port 465 + auth) |
| Token signing | itsdangerous URLSafeTimedSerializer |
| Antispam | honeypot polje + signed form-token (min 2s, max 2h) + slowapi rate-limit (5/h) |
| Forgejo team sync | Python `requests` skripta + systemd timer (svake 2 min) na builder-6 |

---

*Napomena: Generisano by Claude AI 🤖*
