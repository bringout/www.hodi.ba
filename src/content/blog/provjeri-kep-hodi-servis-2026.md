---
title: 'provjeri.kep.hodi.ba v0.17.1 — besplatna provjera kvalifikovanog elektronskog potpisa'
description: 'Online servis koji provjerava da li PDF ili XML dokument nosi validan kvalifikovani elektronski potpis (KEP) — podrška za IDDEEA, UIO i BHP certifikate.'
pubDate: '2026-06-22T10:52:00'
heroImage: '/provjeri-kep-hodi-hero.png'
---

Objavili smo novu verziju **[provjeri.kep.hodi.ba](https://provjeri.kep.hodi.ba)** v0.17.1 — besplatan online servis za provjeru kvalifikovanog elektronskog potpisa (KEP) na dokumentima. Učitate potpisani **PDF** ili **XML**, a servis vam odmah kaže da li dokument nosi **validan kvalifikovani elektronski potpis**, ko ga je potpisao i da li su svi uslovi za pravnu valjanost ispunjeni.

## Šta servis radi

Kada primite dokument sa elektronskim potpisom, sami teško možete provjeriti da li je taj potpis stvarno valjan — da li je dokument mijenjan, da li certifikat dolazi od ovlaštenog izdavača i da li je potpis u trenutku potpisivanja bio važeći. `provjeri.kep.hodi.ba` taj posao radi umjesto vas:

- prima **PDF** dokumente sa ugrađenim potpisom (PAdES), i
- **XML** dokumente sa XAdES potpisom (npr. PDV prijave iz UIO sistema),
- za svaki potpis u dokumentu daje jasan rezultat: **validan KEP** ili ne, uz detalje.

## Šta je KEP?

Kvalifikovani elektronski potpis je elektronski potpis koji po Zakonu o elektronskom potpisu BiH ima **pravnu snagu jednaku svojeručnom potpisu**. Da bi se potpis smatrao kvalifikovanim, mora zadovoljiti više uslova:

- **Integritet** — dokument nije mijenjan nakon potpisivanja
- **Kriptografska validnost** — potpis je matematički ispravan
- **Lanac povjerenja** — certifikat je izdat od ovlaštenog certifikacionog tijela
- **Kvalificirani policy (OID)** — certifikat nosi ETSI kvalificirane identifikatore
- **NonRepudiation** — certifikat ima namjenu za neporecivost potpisa
- **Period važenja** — certifikat je bio važeći u trenutku provjere

## Podržani izdavači certifikata u BiH

Nova verzija prepoznaje i provjerava certifikate **sva četiri** certifikaciona tijela koja se koriste u BiH:

- **IDDEEA** — Agencija za identifikaciona dokumenta, evidenciju i razmjenu podataka BiH; izdaje kvalificirane certifikate građanima i pravnim licima.
- **UIO (UINO)** — Uprava za indirektno-neizravno oporezivanje BiH; certifikati za potpisivanje dokumenata u sistemu indirektnog oporezivanja (npr. PDV prijave).
- **BHP (BH Pošta)** — JP BH Pošta d.o.o.; certifikati za elektronsko potpisivanje dokumenata.
- **Halcom** — Halcom CA; kvalificirani certifikati koji se u BiH koriste za elektronsko potpisivanje dokumenata.

## Šta sve servis provjeri za svaki potpis

| Provjera | Šta znači |
|----------|-----------|
| Integritet | Da li je dokument mijenjan nakon potpisivanja |
| Kriptografska validnost | Da li je sam potpis matematički ispravan |
| Lanac povjerenja | Da li certifikat potiče od poznatog, ovlaštenog izdavača |
| Kvalificirani policy | Da li certifikat nosi kvalificirani OID |
| NonRepudiation | Da li certifikat ima namjenu neporecivosti potpisa |
| Period važenja | Da li je certifikat bio važeći u trenutku potpisa |

Pored same ocjene, za svaki potpis se prikažu i podaci o potpisniku — ime, organizacija, JIB/ID organizacije i mjesto — onako kako su upisani u certifikatu.

## Kako se koristi

1. Otvorite **[provjeri.kep.hodi.ba](https://provjeri.kep.hodi.ba)** i registrujte se sa imenom i email adresom.
2. Nakon što administrator odobri pristup, na email dobijete pristupni link.
3. Učitate potpisani PDF ili XML i kliknete **Verifikuj potpis**.
4. Servis prikaže rezultat za svaki potpis — zelena oznaka za validan KEP, uz sve detalje provjere.

Pošto se pristupni link šalje na email, forma za registraciju provjerava da li email domena uopšte može primati poštu (ima li MX zapis). Ako unesete adresu sa nepostojećom domenom, zahtjev se odmah odbija:

![Registracija: provjera MX zapisa email domene](/provjeri-kep-registracija-mx.png)

Servis je besplatan i namijenjen svima koji u BiH primaju ili šalju elektronski potpisane dokumente i žele brzu, pouzdanu potvrdu da je potpis zaista valjan.

## Napomena

Generisano od strane Claude 🤖

---

Ernad Husremović, hernad@bring.out.ba
