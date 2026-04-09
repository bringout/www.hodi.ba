---
title: 'Bosanski KEP verifikator — provjera kvalifikovanog elektronskog potpisa'
description: 'Online servis za provjeru kvalifikovanog elektronskog potpisa (KEP) na PDF dokumentima — podrška za IDDEEA, UIO i BHP certifikate'
pubDate: '2026-04-09T18:02:00'
heroImage: '/kep-verifikator-hero.png'
---

Predstavljamo **Bosanski KEP verifikator** — online servis za provjeru kvalifikovanih elektronskih potpisa na PDF dokumentima.

Servis je dostupan na: [provjeri.kep.hodi.ba](https://provjeri.kep.hodi.ba)

## Šta je KEP?

Kvalifikovani elektronski potpis (KEP) je elektronski potpis koji ima pravnu snagu jednaku svojeručnom potpisu. Da bi potpis bio kvalifikovan, mora ispunjavati nekoliko uslova:

- **Integritet** — dokument nije mijenjan nakon potpisivanja
- **Kriptografska validnost** — potpis je matematički ispravan
- **Lanac povjerenja** — certifikat je izdat od ovlaštenog certifikacionog tijela
- **Kvalificirani OID** — certifikat sadrži ETSI kvalificirane identifikatore
- **NonRepudiation** — certifikat ima key usage za neporecivost potpisa
- **Period važenja** — certifikat je validan u trenutku provjere

## Podržani izdavači certifikata

Verifikator trenutno podržava tri bosanskohercegovačka certifikaciona tijela:

### IDDEEA
Agencija za identifikaciona dokumenta, evidenciju i razmjenu podataka BiH — izdaje kvalificirane certifikate za elektronski potpis građanima i pravnim licima.

### UIO (UINO)
Uprava za indirektno-neizravno oporezivanje BiH — izdaje certifikate za elektronsko potpisivanje dokumenata u sistemu indirektnog oporezivanja.

### BHP (BH Pošta)
JP BH Pošta d.o.o. — certifikaciono tijelo koje izdaje elektronske certifikate za potpisivanje dokumenata.

## Kako koristiti servis

1. Otvorite [provjeri.kep.hodi.ba](https://provjeri.kep.hodi.ba)
2. Registrujte se sa imenom, emailom i organizacijom
3. Nakon odobrenja, dobićete link za pristup na email
4. Učitajte PDF dokument i kliknite "Verificiraj potpis"

## Šta servis provjerava

Za svaki potpis u dokumentu, servis provjerava:

| Provjera | Opis |
|----------|------|
| integrity | Da li je dokument mijenjan nakon potpisivanja |
| crypto_valid | Da li je kriptografski potpis ispravan |
| trusted_chain | Da li je certifikat izdat od poznatog CA |
| qualified_policy | Da li certifikat ima kvalificirani OID |
| non_repudiation | Da li certifikat ima nonRepudiation key usage |
| validity_period | Da li je certifikat važeći |

## Dodatne informacije iz certifikata

Pored osnovnih podataka o potpisniku, servis prikazuje i:

- **JIB / ID organizacije** — identifikacioni broj firme (npr. 4303070620003)
- **Mjesto** — lokacija potpisnika
- **Organizacija** — naziv firme ili institucije

## Napomena

Generisano od strane Claude 🤖

---

Ernad Husremović, hernad@bring.out.ba
