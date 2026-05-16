---
title: 'KEP verifikator v0.15.0 — hibridna CRL+OCSP provjera opoziva certifikata'
description: 'Bosanski KEP verifikator sada provjerava da li je potpisnikov certifikat opozvan: real-time OCSP upit + paralelna CRL provjera + lokalni keš za offline scenarije.'
pubDate: '2026-05-16T13:30:00'
heroImage: '/kep-crl-ocsp-hero.png'
---

Naš [Bosanski KEP verifikator](/blog/kep-verifikator-2026/) na [provjeri.kep.hodi.ba](https://provjeri.kep.hodi.ba) sa verzijom **v0.15.0** dobija ono što mu je do sada nedostajalo da pokrije punu pravnu definiciju kvalifikovanog elektronskog potpisa — **provjeru opoziva (revokacije) certifikata** kroz OCSP i CRL.

---

## Zašto je provjera opoziva obavezna

Po **Zakonu o elektronskom potpisu BiH** (Sl. glasnik 91/06, čl. 8) i pratećem **Pravilniku o mjerama i postupcima upotrebe i zaštite elektronskog potpisa** (Sl. glasnik 14/17, čl. 9 i 12), akreditovani ovjerioci u BiH (IDDEEA, Halcom, UIO, BH Pošta) **moraju**:

- voditi brz i siguran registar izdatih potvrda,
- osigurati neodgodivu uslugu opoziva,
- objaviti **liste opozvanih potvrda (CRL)** i, gdje je implementiran, **OCSP responder**, dostupne **svim zainteresovanim stranama**.

Pravilnik 14/17 čl. 9 izričito traži da provjera kvalifikovane potvrde **obavezno uključuje** provjeru da li se potvrda nalazi na listi opozvanih potvrda. Bez tog koraka, kriptografski validan potpis još uvijek **nije pravno valjan KEP** — ako je certifikat u međuvremenu opozvan (npr. zbog kompromitacije privatnog ključa ili gubitka eID kartice), potpis više ne nosi pravnu težinu.

Do v0.14 naš verifikator je provjeravao integritet, lanac povjerenja, kvalifikovani OID, nonRepudiation key usage i period važenja — sve **statički iz samog dokumenta**. Korak koji zahtijeva online kontakt sa ovjeriocem (provjera opoziva) je nedostajao.

---

## Šta donosi v0.15.0

### Hibridna provjera — OCSP primarni, CRL paralelni

Za svaki potpis verifikator sada paralelno pokreće dva nezavisna upita:

| Izvor | Šta radi | Karakteristika |
|---|---|---|
| **OCSP** (Online Certificate Status Protocol) | POST upit ovjeriocu sa serijskim brojem certifikata | **Real-time** odgovor (producedAt u sekundi); pravno jači signal |
| **CRL** (Certificate Revocation List) | GET cijele liste opozvanih, lokalna pretraga po serijskom broju | **Snapshot** (typično 24h refresh kod EU-usklađenih CA); pravno obavezan |

Ovjerioci u sam certifikat upisuju URL-ove kroz dva standardna X.509 ekstenzija:

- `AuthorityInformationAccess` (AIA, OID 1.3.6.1.5.5.7.1.1) — OCSP responder URL
- `CRLDistributionPoints` (CRLDP, OID 2.5.29.31) — CRL fajl URL

Naš kod ekstrahuje **oba iz ekstenzija dinamički** — nema hardkodiranih URL-ova, isti kod radi i za IDDEEA i za Halcom i za UIO i za BHP. Kada ovjerilac promijeni infrastrukturu, samo treba reizdati certifikat sa novim URL-om u ekstenziji — verifikator se prilagodi automatski.

```python
ocsp_urls = extract_ocsp_urls(signer)  # iz AIA
crl_urls = extract_crl_urls(signer)    # iz CRLDP

# Paralelno preko run_in_executor:
ocsp_task = loop.run_in_executor(None, check_ocsp, signer, issuer, ocsp_urls[0])
crl_task = loop.run_in_executor(None, check_crl, signer, crl_urls[0])
```

### Primjer iz produkcije — IDDEEA

Test PDF potpisan IDDEEA eID kvalifikovanim certifikatom (provjera danas, 16. maj 2026):

```
revocation: PASS
  OCSP: GOOD (producedAt 2026-05-16 11:17Z)
  CRL:  Nije na CRL (292 unosa, thisUpdate 2026-05-15 15:35Z)
```

OCSP responder je odgovorio u istoj sekundi, a IDDEEA-in CRL je svjež (objavljen prethodnog dana, sadrži 292 opozvanih certifikata, sljedeći refresh za ~4 sata). Oba izvora se slažu: certifikat nije opozvan.

### Soft-fail s upozorenjem

Šta ako je IDDEEA-in OCSP responder trenutno nedostupan? Zakon kaže da provjera opoziva mora biti izvršena, ali u praksi mreže pucaju. Naša politika (env varijabla `REVOCATION_CHECK_MODE`, default `warning`):

| OCSP | CRL | Rezultat | Status |
|---|---|---|---|
| GOOD | nije na listi | ✅ PASS | bez upozorenja |
| GREŠKA | nije na listi | ✅ PASS | ⚠️ warning — "OCSP nedostupan, validirano kroz CRL od *2026-05-15*" |
| GOOD | greška | ✅ PASS | ⚠️ warning — "CRL fetch failed, validirano kroz OCSP" |
| GREŠKA | greška | ✅ PASS (warning mode) ili ❌ FAIL (strict mode) | ⚠️ warning sa **datumom posljednje uspješne provjere iz keša** |
| **REVOKED** | * | ❌ **FAIL** | potpis nije KEP |
| * | **REVOKED** | ❌ **FAIL** | potpis nije KEP |

Za pravno najstrožije primjene (npr. ugovori sa državnim institucijama) može se postaviti `REVOCATION_CHECK_MODE=strict` — i tada se svaki mrežni kvar tretira kao "ne mogu potvrditi" → potpis nije validan KEP.

### Lokalni keš posljednjih CRL provjera

Pri svakom uspješnom CRL fetchu, verifikator zapisuje u `data/crl_cache.json`:

```json
{
  "CN=IDDEEA-IssuingCA": {
    "fetched_at": "2026-05-16T11:17:30Z",
    "this_update": "2026-05-15T15:35:52Z",
    "next_update": "2026-05-16T15:35:51Z",
    "entry_count": 292
  }
}
```

Kada **i OCSP i CRL** zakažu (npr. potpuni outage kod ovjerioca), umjesto da kažemo samo "ne znamo", poruka sadrži **datum posljednje uspješne provjere**:

> *OCSP query failed: connection timeout | CRL fetch failed: connection refused | Posljednji uspješan CRL: fetched_at 2026-05-16T11:17:30Z, thisUpdate 2026-05-15T15:35:52Z, 292 unosa*

Korisnik tako zna **koliko su podaci stari** i može sam odlučiti je li dovoljno za njegov use case.

---

## Šta vidi krajnji korisnik

Hero slika iznad pokazuje kompletan izlaz verifikatora — sedam provjera, svih sedam PASS, uključujući novu `revocation` provjeru sa detaljnim statusom OCSP-a i CRL-a u istoj liniji.

---

## Tehnički detalji za zainteresirane

- Kod: [git.hodi.ba/bringout/epotpis_ba_verify](https://git.hodi.ba/bringout/epotpis_ba_verify)[^git-access]
- Licenca: [AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.html)
- Glavni modul: `src/revocation.py` (~250 linija, bez vanjskih dependencija osim `cryptography` + `requests`)
- Cache je obični JSON fajl uz SQLite DB, pisanje pod `threading.Lock` (uvicorn radi sa više workera)
- OCSP zahtjev koristi SHA-1 kao certIDhash algoritam — tako traže svi BA ovjerioci (eIDAS dozvoljava i SHA-256 ali nije svuda implementirano)
- Standalone test skripta `scripts/check_revocation.py <signed.pdf>` za brzu lokalnu provjeru bez podizanja servera

Pravna napomena: kada vam treba pisano vještačenje o validnosti potpisa za sud ili poreznu kontrolu, *naš servis nije pravna ekspertiza* — služi kao tehnička provjera. Za pravno obavezujuće mišljenje obratite se nadležnim institucijama (Ured za nadzor i akreditaciju ovjerilaca pri Ministarstvu komunikacija i prometa BiH).

[^git-access]: Za pristup git repozitoriju na git.hodi.ba potrebno je da se registrujete prema uputama napisanim u [ovom članku](/blog/registracija-kep-hodi-v05-2026.md/).

---

## Napomena

Generisano od strane Claude 🤖

---

Ernad Husremović, hernad@bring.out.ba
