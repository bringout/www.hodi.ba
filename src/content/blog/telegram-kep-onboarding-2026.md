---
title: 'Telegram onboarding preko KEP-potpisanog PDF-a'
description: 'Novi Odoo modul automatski verifikuje KEP potpis na PDF-u koji kontakt pošalje Telegram botu, ekstrahuje podatke (ime, telefon, email, adresa, mjesto) i povezuje Telegram korisnika sa kontaktom u bazi.'
pubDate: '2026-04-16T01:00:00'
updatedDate: '2026-04-16T03:00:00'
heroImage: '/telegram-kep-onboarding.png'
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
5. **Rezolucija mjesta** — iz `Mjesto: 72000 Zenica` reda izdvaja se ZIP i grad. ZIP se traži u `res.city` tabeli (dolazi sa l10n_ba bazom) → kad postoji poklapanje, popunjava se kompletan lanac: `city_id`, `city`, `zip`, `state_id` (npr. Zeničko-dobojski kanton FBiH) i `country_id` (BiH). Kontakti kreirani preko KEP PDF-a ovako imaju identičan oblik adrese kao i oni ručno uneseni.
6. **Upsert kontakta uz poštovanje hijerarhije** — tražimo `res.partner` po cifrenom poklapanju telefona, a onda pravilo ide po strukturi kontakta u bazi:
   - **Samostalni kontakt (nema parent_id)** → sva polja (`name`, `phone`, `email`, adresa) upisuju se u taj isti red.
   - **Kontakt unutar kompanije (parent_id pokazuje na `is_company=True`)** → polja adrese se pišu na **kompaniju**, a `name`, `phone`, `email` ostaju na kontaktu. Tako adresa ostaje na komercijalnom entitetu, kao i za ostale postojeće l10n_ba kontakte.
   - **Kompanija direktno uhvaćena po telefonu** — ako pod njom već postoji kontakt-dijete sa istim telefonom, radi se scenario iznad; inače se kompanija ignoriše i kreira se **samostalan Pojedinac** (`company_type='person'`, `is_company=False`).
   - **Nema poklapanja** → kreira se samostalan Pojedinac sa svim poljima. Modul nikada ne spaja novi kontakt pod postojeću kompaniju bez eksplicitne korisničke akcije.
   Ime iz certifikata upisuje se u velikim slovima (kao na l.k.).
7. **Povezivanje Telegram korisnika** — kreira se `res.partner.gateway.channel` (Telegram ID ↔ partner), `telegram.contact.handshake` se označi kao `matched`, a DM kanal u Odoo Discussu dobija ime kontakta. Ovo eliminiše standardni "Podijeli broj" zahtjev — KEP potpis je jači dokaz od native Telegram contact share-a.
8. **Povratna informacija** — korisniku se na Telegramu šalje potvrda. Ako je kontakt dio kompanije, dodaje se i `Preduzeće:` linija:

   ```
   Vaš PDF je pročitan, ažurirani ste u našoj kontakt listi kao:

   Preduzeće: Test kupac
   Ime i prezime: ERNAD HUSREMOVIĆ
   Telefon: +387 62 277 793
   Email: ernad.husremovic@gmail.com
   Adresa: Travnička cesta 64
   Mjesto: 72000 Zenica

   Možete nastaviti komunikaciju preko bring.out telegram kanala.
   ```

   Paralelno, operater u Odoo dobija **toast notifikaciju** (`bus.bus` `simple_notification`, plain text — Odoo 16 toast ne renderuje HTML) sa imenom novog/ažuriranog kontakta. Lista primaoca je konfigurabilna preko `ir.config_parameter` ključa `telegram_iddeea_pdf_processor.notify_user_ids` (npr. `"2,9"`).

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

## Naučene lekcije

U prvoj iteraciji smo naivno pisali `name` i adresu direktno na prvi `res.partner` čiji se telefon poklopio po ciframa — što je završilo preimenovanjem kompanije "Test kupac" u ime njenog kontakta kad su mobile polja bila ista. Iz toga su izvučena pravila koja sada važe:

- **Ne preimenuj kompaniju** — `name` kontakta ne ide na `is_company=True` red, čak i kad je telefonski match.
- **Adresa pripada komercijalnom entitetu** — ako postoji parent kompanija, adresa ide gore; ako ne postoji, ostaje na samostalnom kontaktu.
- **Novi kontakt je uvijek Pojedinac bez parent_id** — auto-linkovanje na kompaniju bi moglo slučajno pogoditi "slučajni" telefon koji se poklopio; tu akciju ostavljamo operateru.

Drugi problem je bila Python zamka: parametar naziva `fields` u metodi koja upsertuje `res.partner` zasjenio je `from odoo import fields`, pa je `fields.Datetime.now()` bacao `AttributeError: 'dict' object has no attribute 'Datetime'`. Sada je parametar preimenovan u `pdf_fields`. Gluma sa shadowingom je jedna od onih grešaka koja se ne vidi dok se ne desi u produkciji.

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
