---
title: 'Odoo v20 sandbox na hodi.ba: bringout-test20 iz upstream "odoo/odoo:master", bosanski prijevodi'
description: '17 bringout/oca-ocb-* fork-ova rebuildano sa 20.0 grane (snapshot upstream master-a, internalno 19.4-alpha), pkgs.odoo20 na python313 + http_interface=0.0.0.0, 209 dodatnih modula koje refresh nije pokrio (uključujući base_report_wkhtmltox preko kojeg point_of_sale pada na install), translate_bosnian DB sa 92.7% pokrivenosti za v20 (53 207 redova naslijeđeno iz v19 + 5h-paced AI batch-evi), kontekstualna AI greška Close → Amortizovano u 40 modula i njen sweep, pluggable PDF engine architecture (`_run_pdf_engine(engine_name, …)`) kao priprema za paper-muncher.'
pubDate: '2026-05-09T09:30:00'
heroImage: '/v20-bringout-test20-hero.svg'
---

> **Napomena:** Generisano od strane Claude 🤖

Odoo `master` grana je trenutno označena kao `19.4 alpha` (vidi `odoo/release.py`: `version_info = (19, 4, 0, ALPHA, 1, '')`), ali interno ga zovemo **v20** jer je to ono što će kao stable release izaći za sljedeći major. Ovaj post pokriva komplet posla od "ne postoji" do "podrska@bringout-test20.hodi.ba se prijavi i ima 92.7% bosanskog UI-a, plus radni POS modul" — kroz pet odvojenih problema koji su se pojavili usput.

`https://bringout-test20.hodi.ba` — port 8230 na `hodi-2` VM-u, Patroni klaster za PostgreSQL, `pkgs.odoo20` Nix derivacija koja vuče iz 17 `bringout/oca-ocb-*` repozitorija sa svježom **20.0** granom.

![POS Kasa modul na bringout-test20 sa kompletnim bosanskim UI-em — 89 instaliranih modula, point_of_sale + zavisnosti uključujući novi base_report_wkhtmltox plug-in](/v20-pos-bringout-test20-hero.png)

## Odakle "20.0": OCA/OCB ne prati master, idemo direktno na odoo/odoo

Prvi kamen spoticanja: `OCA/OCB` (community fork koji bringout fleet koristi za 16.0 i 19.0) **ne prati master granu**. Najnovija grana koju OCA/OCB ima je 19.0. Da bismo dobili sandbox koji prati upstream pre-release liniju, izvor mora biti `odoo/odoo:master` direktno.

Korak po korak:

1. **Snapshot** master-a kao tarball (brže od shallow git clone — ~190 MiB tar.gz, ~1.1 GiB rasporeden):
   ```sh
   curl -sL -o tmp/odoo-master.tar.gz \
        https://github.com/odoo/odoo/archive/refs/heads/master.tar.gz
   tar -xzf tmp/odoo-master.tar.gz -C tmp/odoo_master --strip-components=1
   grep version_info tmp/odoo_master/odoo/release.py
   # → version_info = (19, 4, 0, ALPHA, 1, '')
   ```

2. **`core_0/scripts/refresh_v20_from_master.py`** rewrite-uje `20.0` granu na svakom od 17 `bringout/oca-ocb-*` repozitorija. Logika:
   - Za svaki repo, `git worktree add tmp/build_20.0/<repo> origin/19.0` — start sa 19.0 layout-om kao seed-om.
   - Za svaki `odoo-bringout-oca-ocb-<addon>/` direktorij iz 19.0 layout-a:
     - ako je `<addon>` == `base` → `rsync` upstream `odoo/` u `<dir>/odoo/` (sa `--exclude addons/test_*`),
     - inače ako master ima `addons/<addon>/` → `rsync` u `<dir>/<addon>/`,
     - inače (addon je ispustio life u master-u) → `rmtree <dir>/`.
   - `git commit -m "20.0 vanilla from upstream odoo/odoo master"` + force push.

3. Rezultat prvog prolaza: 22 repo-a procesirana, 17 sa stvarnim sadržajem, ~280 addona u svakoj `oca-ocb-<grupa>/odoo-bringout-oca-ocb-<addon>/<addon>/` rasporedu.

```
oca-ocb-core: 72 addons updated, 3 dropped (base_iban, iot_base, iot_box_image)
oca-ocb-mail: 18 addons updated, 1 dropped
oca-ocb-sale: 50 addons updated, 16 dropped
oca-ocb-pos: 8 addons updated, 7 dropped
oca-ocb-website: 37 addons updated, 11 dropped
…
Summary: 22 OK, 0 failed
```

## `pkgs.odoo20`: dvije iznenađujuće prepreke

Inicijalno sam pokušao reciklirati `pkgs.odoo19` derivaciju samo bumping rev-eve i izmjenom referenci na 20.0 grane. Master se nije slagao. Dva durable fix-a:

### 1. Python 3.13, ne 3.11

`tmp/odoo_master/requirements.txt` je puna pinova oblika `>= '3.13'`:

```
cryptography==42.0.8 ; python_version >= '3.12'
lxml==5.2.1; python_version >= '3.12'
PyPDF==5.4.0 ; python_version >= '3.13'
freezegun==1.5.1 ; python_version >= '3.13'
gevent==24.11.1 ; sys_platform != 'win32' and python_version >= '3.13'
```

`pkgs.odoo19` koristi `python311` iz pinned `nixpkgs-25.11`. Za master to ne valja — `cryptography==42.0.8` traži `>= 3.12`, a `PyPDF==5.4.0` `>= 3.13`. `pkgs.odoo20` (`infra-hodi/pkgs/odoo/odoo20/default.nix`) zato koristi `python313` iz `nixpkgs-unstable`:

```nix
python = pkgs'.python313.withPackages (ps: with ps; [
  babel chardet cbor2 python-magic asn1crypto
  cryptography pyopenssl …
]);
```

#### Per-instance Python pin, host-agnostično

Nije dovoljno samo izabrati `python313` u derivaciji — host na kojem instance radi ima *svoj* `nixpkgs` pin (hodi-1 vuče iz `nixpkgs-25.11`, hodi-2 iz `nixpkgs-unstable`), i njegov set Python paketa može biti nekompatibilan sa onim što odoo zahtijeva. Da bismo izbjegli mast od "ovo radi na hodi-2 ali pucanje pri eval-u na hodi-1", svaka `pkgs.odooNN` derivacija sama bira svoj `pkgs'`:

```nix
# infra-hodi/pkgs/odoo/odoo20/default.nix
let
  pkgs' = (import ../../../nixpkgs-unstable) {
    system = pkgs.system;
    config.allowUnfree = true;
  };
  python = pkgs'.python313.withPackages (ps: with ps; [ … ]);
```

Sve što se vidi izvana — `pkgs.odoo20` u host config-u — koristi zajednički host-level `pkgs`. Izolacija je *unutra*: tvrde zavisnosti odoo20 build-a (kompletna closure od Python interpretera, lxml, cryptography, gevent, reportlab, pa do tranzitivnih dep-ova kao numpy/pandas) dolaze iz nixpkgs-unstable bez obzira gdje se host vrti.

Što ovo praktično znači:

| Komponenta | Nixpkgs pin | Python | Zašto |
|---|---|---|---|
| `pkgs.odoo-bosnian` (v16) | `25.11` (host) | `python311` | Stable target za prod (`bringout.hodi.ba`, `multi-test`, `retail-test`, `radix*`) |
| `pkgs.odoo19` | `25.11` pinned u derivaciji | `python311` | nixpkgs-unstable je u međuvremenu bumpao sphinx 9.1 → ispustio python311 → `ofxparse` doc build pao u eval; pin na 25.11 zaustavlja drift |
| **`pkgs.odoo20`** | **`unstable` pinned u derivaciji** | **`python313`** | Master `requirements.txt` traži `>=3.13` na nekoliko paketa; `pkgs.python313Full` postoji u unstable, u 25.11 nema istih binary cache-iranih wheel-ova |
| Host system (hodi-1) | `25.11` | irelevantan za Odoo | systemd, kernel, nginx, …  |
| Host system (hodi-2) | `unstable` | irelevantan za Odoo | euro-office binary (Onlyoffice fork) traži unstable jer 25.11 nema buildable x2t |

Detalj koji je vrijedan napomene: **odoo19 se NE buildi protiv host-ovog nixpkgs-a**. Ako host bumpa unstable na `nixpkgs-unstable` koji je sutra ispustio neku Python-3.11-only zavisnost, odoo19 nastavlja raditi jer se evaluira protiv pinned 25.11. Isti princip za odoo20 — ako master pomakne na `python314` u 2027., samo bumping `nixpkgs-unstable` flake reference + možda `python314` zamjena u `pkgs.odoo20` rješava migraciju.

#### Sphinx 9.1 / ofxparse: realna regresija koja je natjerala na pin

Datum kad smo donijeli odluku o per-derivation pin-u: 2026-04-30. Tada je `nixpkgs-unstable` bumpao `sphinx` na `9.1` koji je dropao Python 3.11 podršku. `ofxparse` (Python lib koji odoo treba za bank statement OFX import) ima `sphinx` kao build-time doc dependency, pa svaki host koji vuče iz unstable + python311 + ofxparse je padao u eval-u. Hodi-2 (na unstable) je počeo failoati `colmena apply` sa nečim sličnim:

```
error: Package python3.11-sphinx-9.1.0 is unsupported on python311.
```

Fix nije bio downgrade hosta — bio je **inverzija direkcije problema**: pomjerimo Odoo na *svoju* odlukov nixpkgs verziju, ne na host-ovu. Doslovni dijagram odluke:

```
host nixpkgs (može biti čime god)  ← Odoo nije ovisi od ovoga
                                       ↑
                                       │ (samo pkgs.system)
                                       │
              pkgs.odoo20  ←  pinned nixpkgs-unstable @ <rev>
                                       │
                                       └── python313, sve dep-ovi, wkhtmltopdf
```

Ova arhitektura je sada baseline za sve pkgs.odooNN — i za prošlost (16, 19) i za budućnost (21, 22 kad dođu). Sljedeći put kad master traži `python314`, mijenja se *jedna linija* u jednoj derivaciji.

### 2. `http_interface = 0.0.0.0` na master-u (default je `127.0.0.1`)

Nakon prvog deploy-a, instance se digla cleanly (`Registry loaded in 13.293s`, 12 modula auto-init), ali reverse proxy je vraćao `502 Bad Gateway`. Lokalno na `hodi-2` `curl localhost:8230/web/login` je bio `200 OK`; iz `router-7` je išao `Connection refused`.

```
ss -lntp | grep 8230
LISTEN 0  16  127.0.0.1:8230  …  python3.13
LISTEN 0  16    0.0.0.0:8130  …  python3.11    # v19, kao kontrast
```

Master je promijenio default — sada vezuje samo loopback. Override u `hodi-odoo.instances.bringout-test20.extraSettings`:

```
server_wide_modules = base,web
http_interface = 0.0.0.0
```

`pkgs.odoo19` ne treba ovaj fix; samo master / 20.0.

## 209 modula koji nisu postojali u 19.0

Onda je došao **drugi** klas iznenađenja kad sam pokušao instalirati POS:

```
Pokušavate da instalirate modul "point_of_sale" koji zavisi
od modula "base_report_wkhtmltox". Ali ovaj drugi modul nije
dostupan u vašem sistemu.
```

`refresh_v20_from_master.py` po dizajnu iterira po 19.0 layout-u — addons koji *nisu postojali* u 19.0 nikad ne dobiju `odoo-bringout-oca-ocb-<X>/` slot. Master je dodao **209 novih addona** u odnosu na 19.0:

```
master addons: 617
bringout 20.0 addons: 410
new in master, missing in bringout: 209
```

Među njima:
- `base_report_wkhtmltox` — wkhtmltopdf rendering engine kao zaseban addon (vidjet ćemo zašto kasnije),
- `account_peppol`, `account_peppol_response`, `account_qr_code_emv` — EU e-invoicing,
- `auth_passkey`, `auth_passkey_portal`, `auth_timeout` — security,
- `certificate` — base PKI helper,
- `cloud_storage`, `cloud_storage_azure`, `cloud_storage_google` — storage backendi,
- gomila `l10n_*` lokalizacija (uključujući `l10n_account_withholding_tax`).

`core_0/scripts/add_missing_master_addons.py` riješio dijagnostiku diff-a + landing-a (default lokacija je `oca-ocb-core` jer je catch-all):

```
master addons: 617
bringout 20.0 addons: 410
new in master, missing in bringout: 209
Adding to oca-ocb-core 20.0:
  + account_payment_custom
  + account_peppol
  + auth_passkey
  + base_report_wkhtmltox
  + certificate
  + cloud_storage
  + l10n_account_withholding_tax
  …
```

GitHub-ov **secret scanner** je pri push-u dva puta odbio commit zbog Twilio Account SID pattern-a (`AC` + 32 hex-like karaktera) u `sms_twilio` test fixture-ima — placeholder-skog SID-a u 49 `.po` fajlova plus dvije test fiksture sa numeričkim varijantama. To su upstream placeholder-i, ne stvarne tajne, ali GitHub-ov regex ne razlikuje. Fix: replace sa `ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` u našoj kopiji — pattern se prekida, GitHub prihvata push, UI placeholder ostaje "očito placeholder" (zapravo i čitljiviji od originalnog hex-a).

Nakon ovoga POS install kroz `config/hodi/bringout-test20/modules.yaml` prošao je clean — 89 instaliranih modula:

```yaml
modules:
  - point_of_sale
```

```
Resolving dependencies for: point_of_sale
  Requested modules:  1
  Extra dependencies: 21       # uključujući base_report_wkhtmltox
  Total packages:     22
```

![Website builder configurator izabira product page template — bringout-test20 ima i website + sale stack uz POS](/v20-website-configurator-templates.png)

## Bosanski prijevodi za v20

`translate_bosnian` repo i njegova `data/translations_bs.db` SQLite baza su per-version (`UNIQUE(module, msgid, variant, version)`). v19 je već postao 96.8% pokriven (61 964 reda, 59 967 prevedeno). Pipeline za v20:

1. **`build-from-pot`** uvuče `.pot` fajlove iz `worktrees/20.0/packages/`. Master ships pre-built POT-ove → 291 fajl, 61 497 unosa, sve sa praznim `msgstr`.

2. **`backfill_v20_from_v19.py`** je novi helper koji per-modul radi `UPDATE … FROM` join sa v19 redovima istog `(module, msgid, variant)` koji imaju neprazan `msgstr`. Ne pulla iz v16 — v19 je tokom svog onboarding-a već prevukao 14 538 v16 redova (`from_v16.0` source), pa je `v19 → v20` transitivno već "v19 + v16 koji je još relevantan u v19".

   ```
   Backfilling 182 modules: v19.0 -> v20.0
   ----------------------------------------------------------------------
   base                       6529      5818
   web                        4458      4314
   account                    3336      3030
   …
   TOTAL                     59738     53207
   Coverage from v19.0: 89.1%
   ```

3. **AI batch-evi za preostalih ~6 500** — generišemo PO file sa do 1000 untranslated unosa, predamo Claude-u headless-no, importujemo nazad. Zbog usage limit-a, batch-evi su **scheduled na 5h interval** kroz `systemd --user` timer:

   ```ini
   # ~/.config/systemd/user/v20-bs-translate.timer
   [Timer]
   OnActiveSec=15s
   OnUnitActiveSec=5h
   Persistent=true
   ```

   Wrapper script (`scheduled_v20_batch.sh`):

   ```sh
   # 1. flock + git pull
   # 2. count v20 untranslated; ako 0 → systemctl --user disable timer + exit
   # 3. enumerate top-30 modula sa gap-om
   # 4. generate translate_bs_1.po (≤1000 entries)
   # 5. claude -p (headless) --allowedTools "Bash Read Write Edit"
   # 6. import-translate-bs-po
   # 7. git commit + push
   ```

   Trenutno stanje (poslije dva fired batch-a):

   | Verzija | Redova | Prevedeno | Pokrivenost |
   |---|---:|---:|---:|
   | 16.0 | 98 977 | 74 830 | 75.6% |
   | 19.0 | 61 964 | 59 967 | **96.8%** |
   | **20.0** | **59 738** | **55 402** | **92.7%** |

## Kontekstualna AI greška: `Close → Amortizovano` u 40 modula

Prva *zanimljiva* greška u AI batch-u nije bila gramatička, nego **kontekstualna**. Engleski msgid `"Close"` u UI smislu (zatvori dijalog/prozor/zapis) je preveden kao `"Amortizovano"` (računovodstveni "close-out / write-off / amortizacija") — **u 40 različitih modula**.

![Ups dialog na bringout-test20 — dugme za zatvaranje dijaloga je etiketirano "Amortizovano" umjesto "Zatvori". Past participle iz računovodstvenog konteksta procurio u UI verb](/v20-amortizovano-bug.png)

Ono što je seed-ovalo grešku: **jedan jedini stari v16 red** sa istim mistranslate-om je AI batch agentov DB-lookup pass našao kao "već postojeći prijevod" i propagirao ga u 40 v20 modula. Tehnički trans-version DB lookup je odlična optimizacija (gdje se isti msgid prevodi konzistentno u proces flow-u), ali na seed-noise je krhka.

Detection je bio jednostavan jednom kad je na ekranu — "Amortizovano" kao label za dugme za zatvaranje dijaloga je **immediately visible jako kao greška**. Verifikacija u DB-u:

```sql
SELECT version, msgstr, COUNT(*)
FROM translations WHERE msgid='Close' AND msgstr != ''
GROUP BY version, msgstr ORDER BY version, COUNT(*) DESC;
--  16.0 | Zatvori     | 70
--  16.0 | Amortizovano | 1   ← original seed
--  19.0 | Zatvori     | 43
--  20.0 | Amortizovano | 40  ← ovaj smo upravo dobili
```

Sweep:

```sql
UPDATE translations
   SET msgstr='Zatvori', source='manual_fix',
       updated_at=CURRENT_TIMESTAMP, translated_at=CURRENT_TIMESTAMP
 WHERE msgid='Close' AND msgstr='Amortizovano'
   AND version IN ('16.0','19.0','20.0');
-- 41 rows fixed (40 v20 + 1 v16 seed)
```

Onda standardni put: `export_v20_bs_po.py` (version-scoped — stock `--export-po` ignoriše version, što bi za v20 sandbox potencijalno povuklo v16 prijevod) → `bs.po` ide u 9 `oca-ocb-*` repo-a → `git push origin 20.0` po repo-u → bump `pkgs.odoo20` rev-ove + `version = "20.0.20260509-2"` (drugi rebuild istog datuma) → `colmena apply switch --on hodi-2` → `odoo --update=<89 modula> --stop-after-init` (registry reload **87.989s**) → bs.po reload kroz JSONB `field_description->bs_BA` kolone.

Pouka: **trans-version DB lookup je ok kao seed, ali batch završetka treba reverse-spot-check** — uzeti N najučestalijih msgstr-ova, mapirati na njihov msgid, i provjeriti je li par koherentan u UI kontekstu. Ova greška bi se uhvatila *prije* push-a kroz "100 najfrekventnijih msgstr-ova: msgid → msgstr — eyeball 30 sekundi".

![Website configurator step 5 — "Gradimo vašu web stranicu" / "Primjenjuju se vaše boje i dizajn..." / "Searching your images..." (treća stavka još engleska — gap koji čeka batch koji procesira `web_editor` / `website` modul)](/v20-website-configurator-building.png)

## v20 reporting infrastruktura: pluggable engine, čekamo paper-muncher

Master je doneo **major refactor** PDF rendering pipe-a koji nije bio prisutan u 19.0. U `odoo/addons/base/models/ir_actions_report.py` se sada nalazi pluggable engine API:

```python
def _run_pdf_engine(self, engine_name: str, html: str, …) -> tuple[bytes, list[int]]:
    raise NotImplementedError(f"Unknown PDF engine: {engine_name}")

def _run_image_engine(self, engine_name: str, bodies, …):
    raise NotImplementedError("No image rendering engine installed")

def _get_pdf_engine(self, report=None, default_engine='wkhtmltopdf') -> str:
    # čita ir.config_parameter 'report.pdf_engine_default'
```

Za poređenje, v19 base addon ima `_run_wkhtmltopdf`, `_run_wkhtmltoimage` *direktno hardkodirane* u `ir_actions_report.py`. Master je inverzio uloge: base zna samo o **konceptu** engine-a i dispatch-uje po imenu.

Konkretni wkhtmltopdf je sada **odvojeni addon** `base_report_wkhtmltox` (onaj koji je point_of_sale install zahtijevao). On override-uje `_run_pdf_engine` *samo kad* je `engine_name == 'wkhtmltopdf'`, inače `super()`. Na install postavi `ir.config_parameter report.pdf_engine_default = 'wkhtmltopdf'`. Ovo je **canonical strategy/plug-in pattern**.

### Gdje je [paper-muncher](https://github.com/odoo/paper-muncher)?

Paper-muncher je Odoo-ov side projekt — Rust binar koji renderuje HTML/CSS u PDF, sa **eksplicitnim ciljem da zamijeni wkhtmltopdf**. Trenutno stanje (per upstream):

- **Latest tag** `v0.2.2` (juni 2025), README kaže _"in early alpha … not yet ready for use"_
- **Odoo Experience 2025 najava (sept 2025)**: _"first deployment of Paper-Muncher targets Odoo 19.1. Paper-Muncher is expected to be fully mature within two years."_
- **Recentnije**: tim je potvrdio da neće biti u Odoo 19; release je sada planiran za "Odoo 20 ili 21"

`grep -r paper.?muncher tmp/odoo_master/` vraća **0 hitova**. Dakle:

| Faza | Stanje danas (v20 master = 19.4-alpha) |
|---|---|
| Pluggable engine arhitektura | ✅ landed (vidi gore) |
| `base_report_wkhtmltox` plug-in | ✅ landed, default |
| `base_report_paper_muncher` (ili sl.) addon | ❌ nije u master-u |
| paper-muncher kao **default**, wkhtml uklonjen | ❌ ~late 2027 (per Odoo) |

Operacionalno za bringout: **wkhtmltopdf ostaje render engine na bringout-test20**. Kada paper-muncher addon stigne u upstream `addons/`, sljedeći ciklus `refresh_v20_from_master.py` + `add_missing_master_addons.py` će ga automatski povući. Onda flip per-instance kroz:

```python
env['ir.config_parameter'].sudo().set_str(
    'report.pdf_engine_default', 'paper-muncher')
```

Trenutni v20 stack je dakle "between" — **plumbing refactor je obavljen, sam novi engine još nije isporučen**, ali pripreme su tu.

## Stanje na 2026-05-09

`https://bringout-test20.hodi.ba` (Odoo `19.4a1`):

- **89 instaliranih modula** uključujući `base`, `web`, `mail`, `bus`, `account`, `product`, `sale`, `point_of_sale`, `pos_restaurant`, `pos_sale`, `website`, `website_sale`, `auth_signup`, `auth_totp`, `digest`, `iap`, `microsoft_outlook`, `spreadsheet*`, `base_report_wkhtmltox`.
- **17 `bringout/oca-ocb-*` 20.0 grana** — sve bumping `pkgs.odoo20` rev-eve nakon svakog refresh-a.
- **89.1% pokrivenosti bosanskog za v20** odmah iz v19 backfill-a, **92.7% nakon prva dva AI batch-a**, ostalih 4 336 redova ide kroz 5h timer.
- **Kontekstualnu grešku Close→Amortizovano fixed** u 40 modula plus seed.
- `podrska@bringout-test20.hodi.ba` ima `lang=bs_BA` postavljeno kroz `base.language.install` wizard, login je u Bosanskom, "Aplikacije / Postavke / Prodaja / POS Kasa".
- Authelia OIDC client `odoo-bringout-test20` registrovan, redirect na `https://bringout-test20.hodi.ba/auth_oauth/signin`.
- Ostalo: `eurooffice` document server reuse-uje postojeći `office.hodi.ba` od `bringout-test19` instance, ne treba paralelni deploy.

## Vrijednost over time

Pristup koji se kristalizovao za sandbox-iranje pre-release Odoo verzija:

1. **`odoo/odoo:master` direktno**, ne čekati OCA da prati. OCA prati release-ove; mi želimo *masu* za pre-release feedback.
2. **Bringout `oca-ocb-*` repo-i kao landing zone** za split-by-domain layout. Pluggable po `_run_pdf_engine`-style pattern-u — sve što pripada bringout fork-u, ili sve što sam napravio kao dodatak (`auth_oidc`, `eurooffice_*`, `l10n_ba_*`), ima slot. Refresh script propagira upstream kod, ali ne dira bringout-specific kod.
3. **`refresh_v20_from_master.py` + `add_missing_master_addons.py`** kao par. Prvi handluje "već postojeći addons", drugi "novo-dodani u master-u".
4. **Per-version translations DB**, ne global. Backfill iz prethodne verzije kao default. AI batch samo gdje *nema* prethodnog izvora.
5. **Scheduled batch-eve sa flock-om i self-disable na 0**, ne single-shot manual run. Budget je predvidiv, runaway nemoguć.
6. **Spot-check msgstr → msgid mapping nakon svakog batch-a** (učenje iz Amortizovano slučaja — dodaću u sljedeći iteration plan-a).

Sve skripte i config-uri su na `bringout/profile-hetzner` (`config/hodi/bringout-test20/`, `docs/ODOO_MASTER_V20_UPDATE_INSTRUCTIONS.md`), `bringout/core_0` (`scripts/refresh_v20_from_master.py`, `scripts/add_missing_master_addons.py`), `bringout/translate_bosnian` (`scripts/backfill_v20_from_v19.py`, `scripts/scheduled_v20_batch.sh`, `scripts/export_v20_bs_po.py`) i `bringout/infra-hodi` (`pkgs/odoo/odoo20/default.nix`, `hosts/hetzner/hodi-2/default.nix`). Sljedeći post će vjerovatno biti onaj kad paper-muncher addon stigne u master, plus migracija default report engine-a.
