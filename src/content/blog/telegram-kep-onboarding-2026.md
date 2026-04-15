---
title: 'Telegram onboarding preko KEP-potpisanog PDF-a'
description: 'Novi Odoo modul automatski verifikuje KEP potpis na PDF-u koji kontakt pošalje Telegram botu, ekstrahuje podatke (ime, telefon, email, adresa, mjesto) i povezuje Telegram korisnika sa kontaktom u bazi.'
pubDate: '2026-04-16T01:00:00'
heroImage: '/kep-17-29-32.png'
---

Nakon [Bosanskog KEP verifikatora](/blog/kep-verifikator-2026), dodali smo i automatizovanu integraciju sa Telegram botom za onboarding novih kontakata — bez ručnog unosa podataka.

## Zašto

Standardni Telegram-onboarding u našoj postojećoj [integraciji sa Odoo Discuss forumom](/blog/odoo-telegram-partner-forum-2026) traži od korisnika da podijeli svoj broj telefona preko Telegram dugmeta "📱 Podijeli broj". To je dovoljno da ga vežemo za postojeći `res.partner`, ali ne donosi ostale podatke — email, adresu, poštanski broj, mjesto. Za nove kontakte i dalje se traži ručna intervencija operatera.

KEP-potpisani PDF rješava i identitet i sadržaj u jednom koraku:

- **Identitet** — potpisnik je kriptografski ovjeren (IDDEEA / UIO / BHP certifikat).
- **Sadržaj** — strukturirani tekst u PDF-u (`Ime i Prezime:`, `Telefon:`, `email:`, `Adresa:`, `Mjesto:`) može se pouzdano parsirati.

## Šta korisnik pošalje

Kontakt generiše PDF sa sadržajem tipa:

```
Ime i Prezime: Ernad Husremović

email: ernad.husremovic@gmail.com
telefon: +387 62 277 793

Adresa: Travnička cesta 64
Mjesto: 72000 Zenica
```

PDF potpiše KEP karticom (IDDEEA ili drugi priznati izdavač) i pošalje ga našem Telegram botu kao attachment. Ništa više.

## Šta radi modul

Novi Odoo modul `telegram_iddeea_pdf_processor` nasljeđuje `mail.gateway.telegram` i na svaki inbound PDF prolazi kroz lanac provjera:

1. **Verifikacija potpisa** — PDF se šalje na `POST /api/v1/verify` na [provjeri.kep.hodi.ba](https://provjeri.kep.hodi.ba) sa servisnim tokenom (`kep_...`). Vraća se `overall_kep: bool` zajedno sa metapodacima potpisnika iz certifikata (`given_name`, `surname`, `organization`, datum potpisa).
2. **Ako potpis nije kvalifikovan** — bot odgovara: `Kontaktni podaci moraju biti KEP potpisani.` i tu je kraj.
3. **Ako je potpis validan** — iz PDF-a se lokalno izvlači tekst (PyPDF2) i parsira red po red.
4. **Cross-check imena** — ime i prezime iz `Ime i Prezime:` reda u PDF-u se normalizuje (bez dijakritika, upper-case) i upoređuje sa `given_name + surname` iz certifikata. Ne poklapa se? Odgovor: `Ime i prezime u PDF-u ne odgovaraju KEP potpisniku.` — blokiramo slučaj u kojem neko potpiše PDF vlastitim certifikatom a u tijelo upiše tuđe ime.
5. **Upsert kontakta** — tražimo `res.partner` po cifrenom poklapanju telefona:
   - Ako kontakt postoji → ažuriraju se `name`, `email`, `street`, `zip`, `city`.
   - Ako ne postoji → kreira se novi `res.partner` sa svim poljima.
6. **Povezivanje Telegram korisnika** — kreira se `res.partner.gateway.channel` (Telegram ID ↔ partner), `telegram.contact.handshake` se označi kao `matched`, a DM kanal u Odoo Discussu dobija ime kontakta. Ovo eliminiše standardni "Podijeli broj" zahtjev — KEP potpis je jači dokaz od native Telegram contact share-a.
7. **Povratna informacija** — korisniku se na Telegramu šalje potvrda:

   ```
   Vaš PDF je pročitan, dodani ste u našoj kontakt listi kao:

   Ime i prezime: ERNAD HUSREMOVIĆ
   Telefon: +387 62 277 793
   Email: ernad.husremovic@gmail.com
   Adresa: Travnička cesta 64
   Mjesto: 72000 Zenica

   Možete nastaviti komunikaciju preko bring.out telegram kanala.
   ```

   Paralelno, operater u Odoo dobija **toast notifikaciju** sa imenom novog/ažuriranog kontakta.

## Sigurnost

- **Servisni token**, ne korisnički — verifikator ima odvojen sloj autentikacije (`api_keys` tabela, opaque `kep_...` tokeni, SHA-256 heš u bazi). Revokacija je trenutna: CLI komanda `scripts/api_keys.py revoke --name odoo-bringout`.
- **Ime iz certifikata je autoritativno** — što je u PDF tekstu čisto informativno za korisnika. Ako se razlikuje od potpisnika — odbijamo upsert.
- **Lokalna ekstrakcija teksta** — verifikator servis ne vraća sadržaj PDF-a, samo presudu o potpisu. Odoo modul sam čita tekst iz PDF-a (PyPDF2). Razdvajanje odgovornosti: verifikator radi kriptografiju, Odoo radi ekstrakciju poslovnih polja.
- **Telefon iz PDF-a je autoritativan** — postojeći share-phone flow se preskače kad inbound poruka ima PDF attachment. KEP potpisani broj je jači dokaz.

## Arhitektura

```
Telegram user  →  Telegram Bot  →  Odoo mail.gateway.telegram
                                         │
                                         │  (nasljeđivanje)
                                         ▼
                            telegram_iddeea_pdf_processor
                                         │
                      ┌──────────────────┼──────────────────┐
                      ▼                  ▼                  ▼
          POST /api/v1/verify    PyPDF2.extract_text    res.partner upsert
          (provjeri.kep.hodi.ba)  (lokalno)              + gateway channel
                      │                                    + handshake match
                      ▼                                    + toast + reply
              kep_... Bearer token
```

## Podešavanje (Odoo System Parameters)

| Ključ                                            | Primjer                                 |
| ------------------------------------------------ | --------------------------------------- |
| `epotpis_ba_verify.api_url`                      | `https://provjeri.kep.hodi.ba`          |
| `epotpis_ba_verify.api_token`                    | `kep_...` (generisan na serveru)        |
| `telegram_iddeea_pdf_processor.notify_user_ids`  | `2,9` (operateri koji primaju toast)    |

## Korištene tehnologije

- **Backend (Odoo)**: 16.0, `mail.gateway.telegram` (OCA), `python-telegram-bot`, PyPDF2
- **KEP verifikator**: FastAPI + pyhanko + pyhanko-certvalidator + SQLite (API keys)
- **Deployment**: NixOS + Colmena, automatska distribucija modula u Odoo nix store

## Šta dalje

- Podrška za višestruke KEP kontakte u jednoj supergrupi (trenutno radi per-gateway)
- XML-potpisani kontakt paketi (XAdES) — verifikator već podržava XML, treba povezati
- Automatsko dodavanje kontakta u odgovarajuću Odoo kategoriju/grupu na osnovu organizacije iz certifikata

---

Repositoriji:
- [epotpis_ba_verify](https://github.com/bringout/epotpis_ba_verify) — KEP verifikator servis
- Odoo modul `telegram_iddeea_pdf_processor` — bundled u `odoo-bringout` nix paketu

Generisano od strane Claude 🤖

---

Ernad Husremović, hernad@bring.out.ba
