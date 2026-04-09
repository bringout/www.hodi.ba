---
title: 'Bosanski KEP verifikator — provjera kvalifikovanog elektronskog potpisa'
description: 'Online servis za provjeru kvalifikovanog elektronskog potpisa (KEP) na PDF dokumentima — podrška za IDDEEA, UIO i BHP certifikate'
pubDate: '2026-04-09T18:02:00'
heroImage: '/kep-17-29-32.png'
---

Predstavljamo **Bosanski KEP verifikator** — online servis za provjeru kvalifikovanih elektronskih potpisa na PDF i XML dokumentima.

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

### 1. Registracija

Popunite formu sa imenom, organizacijom i email adresom.

![Registracija](/kep-16-04-24.png)

### 2. Odobrenje pristupa od strane administratora hodi.ba

Administrator prima obavijest o zahtjevu i odobrava ili odbija pristup.

![Odobrenje](/kep-17-22-28.png)

### 3. Pristupni link

Nakon odobrenja, korisnik dobija email sa linkom za pristup (važi 30 dana). Klikom na pristupni link korisnik može početi koristiti servis.

![Email sa linkom](/kep-17-25-40.png)

### 4. Pristup servisu

Kliknite na područje "Odaberi fajl — niste još odabrali fajl za verifikaciju":

![Odaberi fajl](/kep-pristup-servisu.png)

Nakon odabira fajla, naziv fajla se prikazuje u polju:

![Fajl odabran](/kep-fajl-odabran.png)

Kliknite dugme "Verifikuj potpis" za pokretanje verifikacije.

### 5. Rezultati verifikacije

Servis prikazuje detaljne rezultate za svaki potpis u dokumentu.

#### Primjer: IDDEEA potpis

![IDDEEA verifikacija](/kep-iddeea-success.png)

#### Primjer: UIO XML potpis

Servis podržava i XML dokumente sa XAdES potpisima, kao što su PDV prijave iz UIO sistema.

![UIO XML verifikacija](/kep-uio-xml-success.png)

#### Primjer: BHP potpis

![BHP verifikacija](/kep-bhp-success.png)

Kod BHP potpisa, provjera `non_repudiation` ima status **WARN** (upozorenje, narandžasta boja) umjesto PASS. To znači da BHP certifikat nema `nonRepudiation` (content commitment) atribut u Key Usage ekstenziji. Ovaj atribut označava da potpisnik ne može naknadno poricati da je potpisao dokument. Bez njega, potpis ima kriptografsku validnost, ali u strožijem tumačenju Zakona o elektronskom potpisu BiH, mogao bi se osporiti pred sudom. Trenutno je ova provjera konfigurisana kao upozorenje — dokument se i dalje smatra validnim KEP-om, ali korisnik treba biti svjestan ovog ograničenja BHP certifikata.

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

- **JIB / ID organizacije** — identifikacioni broj firme
- **Mjesto** — lokacija potpisnika
- **Organizacija** — naziv firme ili institucije

## Odbijeni zahtjevi

Ukoliko administrator odbije zahtjev, korisnik dobija obavijest i ne može se ponovo registrovati sa istim emailom.

![Odbijeni zahtjev](/kep-17-20-32.png)

## Napomena

Generisano od strane Claude 🤖

---

Ernad Husremović, hernad@bring.out.ba
