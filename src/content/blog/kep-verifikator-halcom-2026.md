---
title: 'KEP verifikator v0.16.1 — Halcom kao 4. podržani izdavač + tvrđa provjera opoziva'
description: 'Bosanski KEP verifikator sada podržava i Halcom kvalifikovane certifikate. Uz to: preskakanje ldap:// CRL endpointa, DER/PEM auto-detekcija i pravilo "svjež OCSP poništava CRL upozorenje".'
pubDate: '2026-05-20T16:56:45'
heroImage: '/kep-verifikator-hero.png'
---

Sa verzijom **v0.16.1** naš [Bosanski KEP verifikator](/blog/kep-verifikator-2026/) na [provjeri.kep.hodi.ba](https://provjeri.kep.hodi.ba) pokriva sva četiri kvalifikovana ovjerioca čije certifikate susrećemo u praksi u BiH:

- **IDDEEA** — Agencija za identifikaciona dokumenta, evidenciju i razmjenu podataka BiH (eID lična karta)
- **UIO** — Uprava za indirektno-neizravno oporezivanje BiH (PDV certifikati)
- **BHP** — JP BH Pošta d.o.o. (kvalifikovani potpisi za pravne i fizičke osobe)
- **Halcom d.d. (SI)** — slovenski kvalifikovani trust service provider; **NOVO u v0.16.1**

---

## Zašto Halcom

Halcom d.d. iz Slovenije je akreditovani EU trust service provider i njegovi certifikati se aktivno koriste i u BiH — između ostalog za potpisivanje dokumenata koje objavljuju **Službene novine Federacije BiH**, što smo i vidjeli u nedavnoj publikaciji *Odluke o osnovicama za 2026. godinu*.

Do v0.16 verifikator je takav potpis dočekivao sa porukom *"Nepoznat izdavač certifikata: Halcom CA FO e-signature 2"* — kriptografski jeste validan, ali bez konfigurisanog **trust anchora** verifikator ne može tvrditi da je to kvalifikovani potpis u pravnom smislu. Sada može.

---

## Šta je dodato za Halcom podršku

### Trust anchori i intermediate CA-ovi

Halcom-ovu hijerarhiju smo upisali u `certs/halcom/`:

| Sloj | Certifikat | Period važenja |
|---|---|---|
| Root CA | Halcom Root Certificate Authority (G1) | 2016 – 2036 |
| Root CA | Halcom Root CA G2 | 2025 – 2045 |
| Intermediate | Halcom CA FO e-signature 2 (fizičke osobe, G1) | 2023 – 2033 |
| Intermediate | Halcom CA PO e-signature 2 (pravne osobe, G1) | 2023 – 2033 |
| Intermediate | Halcom CA FO e-sig 1 G2 (fizičke osobe, G2) | 2025 – 2035 |
| Intermediate | Halcom CA PO e-sig 1 G2 (pravne osobe, G2) | 2025 – 2035 |

To pokriva i **postojeću generaciju (G1)**, koja je još uvijek dominantna u izdatim eID karticama, i **novu G2** koja je počela izlaziti 2025. Verifikator automatski matchuje potpisnikov certifikat sa odgovarajućim intermediate CA-om iz `provider.json` deklaracije — nema potrebe za code change-om kad se izda novi certifikat na već poznatoj hijerarhiji.

Konfiguracija je dataset-driven:

```json
{
  "name": "HALCOM",
  "full_name": "Halcom d.d. - Qualified Trust Service Provider",
  "country": "SI",
  "qualified_oids": [
    "0.4.0.194112.1.2",
    "0.4.0.2042.1.2"
  ],
  "trust_anchors": ["root_ca_g1.pem", "root_ca_g2.pem"],
  "intermediate_cas": [
    "ca_fo_e_signature_2.pem",
    "ca_po_e_signature_2.pem",
    "ca_fo_e_signature_1_g2.pem",
    "ca_po_e_signature_1_g2.pem"
  ]
}
```

Isti obrazac koji koriste i IDDEEA, UIO i BHP — dodavanje sljedećeg ovjerioca (ako se ukaže potreba, npr. neki sektorski CA) sada je čisto pitanje **konfiguracije, ne koda**.

---

## Šta je popravljeno u provjeri opoziva (revocation)

Halcom certifikat nam je usput ogolio tri slabosti u dosadašnjoj implementaciji `revocation.py`. Sve tri su riješene u v0.16.1.

### 1. `ldap://` CRL URL-ovi se sada preskaču

Halcom u ekstenziji `CRLDistributionPoints` upisuje **dva URL-a** za istu CRL listu — prvo LDAP, pa HTTP:

```
ldap://ldap.halcom.si/cn=Halcom%20CA%20FO%20e-signature%202,o=Halcom,c=SI?certificaterevocationlist;binary
http://domina.halcom.si/crls/halcom_ca_fo_e-signature_2.crl
```

Stara logika je uzimala prvi URL iz liste i probavala mu pristupiti preko `requests` biblioteke. Ali `requests` nema LDAP adapter — svaki LDAP URL je rezultovao greškom *"No connection adapters were found for 'ldap://...'"* iako je HTTP varijanta dostupna odmah u sljedećoj liniji.

Novi kod prvo filtrira liste:

```python
http_crl_urls = [u for u in crl_urls if u.lower().startswith(("http://", "https://"))]
```

LDAP URL-ovi se odmah preskaču. Ako ovjerilac uopće **ne objavi HTTP CRL** (što nije slučaj kod ijednog od četiri trenutno podržana ovjerioca, ali za svaki slučaj), korisnik dobija eksplicitnu poruku da CRL endpoint koristi neoperativan protokol — umjesto generičke "fetch failed" greške.

> **Da li podržavamo LDAP direktno?** Ne. LDAP CRL je relikt iz ranih 2000-tih i dodavanje punog LDAP klijenta donosi 50+ KB tranzitivnih zavisnosti za scenarij koji je u praksi mrtav — sve ozbiljne CA infrastrukture odavno objavljuju i HTTP varijantu. Ako se ovo ikad promijeni, na red dolazi `python-ldap` ili `ldap3`.

### 2. CRL fajl može biti DER **ili** PEM

Sljedeći problem: kad smo preskočili LDAP i uspjeli povući HTTP CRL od Halcom-a, parser je pucao:

```
CRL fetch failed: error parsing asn1 value: ParseError { kind: UnexpectedTag { ... } }
```

Razlog: Halcom serveriraju CRL kao **PEM-encoded** (`-----BEGIN X509 CRL-----` plus base64). Naš stari kod je tvrdo zvao `x509.load_der_x509_crl`, koji očekuje sirovi ASN.1 DER blob.

Standardi (RFC 5280) dozvoljavaju oba formata; u praksi:

| Ovjerilac | Format CRL-a |
|---|---|
| IDDEEA | DER |
| BHP | DER |
| UIO | DER |
| **Halcom** | **PEM** |

Novi `check_crl` njuška početak tijela odgovora:

```python
if body.lstrip().startswith(b"-----BEGIN"):
    crl = x509.load_pem_x509_crl(body)
else:
    crl = x509.load_der_x509_crl(body)
```

Rezultat: Halcom CRL (oko 9.7 KB, ~299 unosa u trenutku objave ovog posta, refresh svaka 24h) sada uredno parsira i pretražuje.

### 3. Svjež OCSP poništava CRL upozorenje

Treća izmjena nije bug-fix nego namjerno popuštanje politike koje je dosad bilo prestrogо.

Pravilo do v0.16: ako *jedan* od dva izvora opoziva (OCSP ili CRL) zakaže, korisnik je dobijao **soft warning**, čak i kada se drugi izvor svježe i jasno složio sa rezultatom. To je značilo nepotrebnu žutu zastavicu za potpuno valjane potpise.

Nova logika: **ako je OCSP odgovor GOOD i njegov `producedAt` nije stariji od 8 sati**, smatramo da imamo svjež real-time signal i CRL ispad **ne** povlači upozorenje.

```python
def ocsp_is_fresh(self, max_age_hours: int = 8) -> bool:
    if not self.ocsp or self.ocsp.state != "good" or self.ocsp.produced_at is None:
        return False
    age = datetime.now(timezone.utc) - self.ocsp.produced_at
    return age.total_seconds() <= max_age_hours * 3600
```

Zašto baš 8 sati? OCSP `producedAt` je vremenski žig koji ovjerilac upisuje pri formiranju odgovora; većina CA-ova ima i `nextUpdate` polje koje pokazuje koliko taj odgovor smije biti "keširan". 8 sati pokriva uobičajeni radni dan jednog korisnika a daleko je kraće od tipičnog 24h CRL refresh ciklusa — ako je OCSP danas u podne rekao **GOOD**, ne treba nam dodatno upozorenje samo zato što je negdje na mrežnoj putanji do CRL-a desila se kratka smetnja.

#### Matrica novog ponašanja

| OCSP | producedAt | CRL | Rezultat | Upozorenje? |
|---|---|---|---|---|
| GOOD | ≤ 8h | GOOD | ✅ PASS | ne |
| GOOD | ≤ 8h | greška | ✅ PASS | **ne** (novo!) |
| GOOD | > 8h | greška | ✅ PASS | da |
| greška | — | GOOD | ✅ PASS | da |
| REVOKED | * | * | ❌ FAIL | — |
| * | * | REVOKED | ❌ FAIL | — |

Sve REVOKED scenarije, kao i ranije, vode ka kategoričkom **FAIL** — bez kompromisa.

---

## Primjer rezultata

Verifikator na novom buildu na PDF-u sa Halcom potpisom (npr. potpisana *Odluka o osnovicama za 2026. godinu* iz Službenih novina FBiH) vraća:

```
provider: HALCOM
  [OK]  integrity:        Integritet dokumenta je očuvan
  [OK]  crypto_valid:     Kriptografski potpis je validan
  [OK]  trusted_chain:    Lanac povjerenja potvrđen (HALCOM)
  [OK]  qualified_policy: Kvalificirani OID: 0.4.0.194112.1.2
  [OK]  validity_period:  Certifikat važi od 17.12.2025 do 17.12.2028
  [OK]  revocation:       OCSP: GOOD (producedAt 2026-05-20 14:46Z)
                        | CRL: Nije na CRL (299 unosa, thisUpdate 2026-05-20 11:23Z)
```

Sve provjere prolaze, oba izvora opoziva potvrđuju da certifikat nije opozvan, nema nepotrebnih upozorenja.

---

## Tehnički sažetak

| Promjena | Fajl |
|---|---|
| Halcom trust anchori + intermediate CA-ovi + `provider.json` | `certs/halcom/` |
| `ldap://` filter + HTTP CRL prioritet | `src/revocation.py::check_revocation` |
| DER/PEM CRL sniffing | `src/revocation.py::check_crl` |
| `RevocationStatus.produced_at` + `CombinedRevocation.ocsp_is_fresh()` | `src/revocation.py` |
| Soft warning suppression kad je OCSP svjež | `src/verifier.py::_check_revocation_result` |
| Halcom u footer-u | `src/templates/index.html`, `register.html` |

Kod: [git.hodi.ba/bringout/epotpis_ba_verify](https://git.hodi.ba/bringout/epotpis_ba_verify) (tag `v0.16.1`), licenca [AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.html).

Servis: [provjeri.kep.hodi.ba](https://provjeri.kep.hodi.ba).

---

## Napomena

Generisano od strane Claude 🤖

---

Ernad Husremović, hernad@bring.out.ba
