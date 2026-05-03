---
title: 'Bosanski prijevodi za Odoo v19: 17 oca-ocb-* grupa, 100% bs.po, jedan zip download'
description: 'Per-version SQLite baza prijevoda u translate_bosnian (UNIQUE key (module, msgid, variant, version) — kritičan fix za 19.0 koegzistenciju sa 16.0), git worktrees za 19.0 grane oca-ocb-* fork-ova, paralelni AI batch-evi za untranslated stringove, nix bundle koji pinuje fresh oca-ocb-* commit-e, --i18n-overwrite reload na deploy-u. Krajnji rezultat: 335 bs.po fajlova upakovanih u jedan zip, plus live verifikacija na bringout-test19.hodi.ba (Naziv, Dobavljač, Datum narudžbe).'
pubDate: '2026-05-03T18:00:00'
heroImage: '/v19-bs-translation-hero.svg'
---

> **Napomena:** Generisano od strane Claude 🤖

Odoo upstream nikad nije imao kompletan bosanski (`bs_BA`) prijevod za core module — `Settings → Translations → Languages` ti omogući aktivaciju jezika, ali većina string-ova ostaje na engleskom. Za korisnike kojima je domaći jezik radni jezik (a ne IT lingua franca), to je svakodnevna friction.

Cilj ovog rada: **dovesti `oca-ocb-*` 19.0 grane do 100% bs prijevoda**, distribuirati rezultat kao jedan zip, i imati ponovljiv pipeline za buduće verzije.

📦 **Download**: [oca-ocb-v19_translation_bs.zip](/oca-ocb-v19_translation_bs.zip) (2.96 MB, 335 bs.po fajlova, 19 oca-ocb-* grupa, layout `oca-ocb-<group>/<addon>/i18n/bs.po`).

## Skor

17 grupa direktno obrađenih u ovom radu, sve na 100% bs prijevoda za v19.0:

| Grupa                 | Stringova | Posljednji v19.0 commit |
|-----------------------|----------:|-------------------------|
| [`oca-ocb-core`](https://git.hodi.ba/oca/oca-ocb-core/commits/branch/19.0)               | 19,150 | [`37f8a5da`](https://git.hodi.ba/oca/oca-ocb-core/commit/37f8a5daa69b7f56e8834de79081fc79e3f91845) |
| [`oca-ocb-website`](https://git.hodi.ba/oca/oca-ocb-website/commits/branch/19.0)         | 8,267  | [`dbb4dff`](https://git.hodi.ba/oca/oca-ocb-website/commit/dbb4dff8ee51e7869b7b56ebb37a145506981bab) |
| [`oca-ocb-sale`](https://git.hodi.ba/oca/oca-ocb-sale/commits/branch/19.0)               | 6,937  | [`679ef98`](https://git.hodi.ba/oca/oca-ocb-sale/commit/679ef98c4ac0522d7cc70b64512e3d2785728338) |
| [`oca-ocb-hr`](https://git.hodi.ba/oca/oca-ocb-hr/commits/branch/19.0)                   | 4,582  | [`bd847ab`](https://git.hodi.ba/oca/oca-ocb-hr/commit/bd847ab51a0cefe4b794b1052f9b584132e44f81) |
| [`oca-ocb-accounting`](https://git.hodi.ba/oca/oca-ocb-accounting/commits/branch/19.0)   | 4,513  | [`a13ff6d`](https://git.hodi.ba/oca/oca-ocb-accounting/commit/a13ff6d73f7af0acbf5129cd66399d5ca2175359) |
| [`oca-ocb-warehouse`](https://git.hodi.ba/oca/oca-ocb-warehouse/commits/branch/19.0)     | 2,657  | [`aaac882`](https://git.hodi.ba/oca/oca-ocb-warehouse/commit/aaac8824954d285f892366a301e6c9d37e4e16f9) |
| [`oca-ocb-mail`](https://git.hodi.ba/oca/oca-ocb-mail/commits/branch/19.0)               | 2,463  | [`cdd26e4`](https://git.hodi.ba/oca/oca-ocb-mail/commit/cdd26e4100b97b309a5afac0fccae7c82ee3dca8) |
| [`oca-ocb-report`](https://git.hodi.ba/oca/oca-ocb-report/commits/branch/19.0)           | 2,298  | [`c905346`](https://git.hodi.ba/oca/oca-ocb-report/commit/c9053467811fc3f697893ecf6a32b2baca0d2066) |
| [`oca-ocb-mrp`](https://git.hodi.ba/oca/oca-ocb-mrp/commits/branch/19.0)                 | 1,264  | [`bd5843a`](https://git.hodi.ba/oca/oca-ocb-mrp/commit/bd5843ad82d4d27d79e9b5862f8a81c5ad7b823e) |
| [`oca-ocb-project`](https://git.hodi.ba/oca/oca-ocb-project/commits/branch/19.0)         | 941    | [`b9541a9`](https://git.hodi.ba/oca/oca-ocb-project/commit/b9541a959f5ad923a80d9c5f4ce9f44e471a4476) |
| [`oca-ocb-crm`](https://git.hodi.ba/oca/oca-ocb-crm/commits/branch/19.0)                 | 928    | [`dbead34`](https://git.hodi.ba/oca/oca-ocb-crm/commit/dbead34bb532347a0d21fac1fe3a3900631a7fc9) |
| [`oca-ocb-technical`](https://git.hodi.ba/oca/oca-ocb-technical/commits/branch/19.0)     | 718    | [`231a255`](https://git.hodi.ba/oca/oca-ocb-technical/commit/231a255deb5fbf58c4e90e5af387b54263c97f2a) |
| [`oca-ocb-pos`](https://git.hodi.ba/oca/oca-ocb-pos/commits/branch/19.0)                 | 680    | [`f72f273`](https://git.hodi.ba/oca/oca-ocb-pos/commit/f72f27396342d74b29ebe525f385fdfc522fa927) |
| [`oca-ocb-security`](https://git.hodi.ba/oca/oca-ocb-security/commits/branch/19.0)       | 606    | [`06f28cd`](https://git.hodi.ba/oca/oca-ocb-security/commit/06f28cd0520201ab14f2ceb564fd06fbe265faae) |
| [`oca-ocb-hw`](https://git.hodi.ba/oca/oca-ocb-hw/commits/branch/19.0)                   | 286    | [`5a1d404`](https://git.hodi.ba/oca/oca-ocb-hw/commit/5a1d40477ba913f7b23f6a8432a27817f840107e) |
| [`oca-ocb-web`](https://git.hodi.ba/oca/oca-ocb-web/commits/branch/19.0)                 | 85     | [`7458d7d`](https://git.hodi.ba/oca/oca-ocb-web/commit/7458d7d8ffa3119e802e289cefe107374e53fcb0) |
| [`oca-ocb-vertical-industry`](https://git.hodi.ba/oca/oca-ocb-vertical-industry/commits/branch/19.0) | (untouched) | — |

Ukupno preko **62 000** prevedenih `msgid → msgstr` parova u v19.0 sloju baze.

## Arhitektura

`translate_bosnian` repo (privatni) drži centralni SQLite koji čuva sve verzije paralelno:

```
translations(
    module, msgid, msgstr, variant, version,
    source, priority, model, flags, tcomment, ...,
    UNIQUE(module, msgid, variant, version) ON CONFLICT REPLACE
)
```

`UNIQUE` ključ uključujući `version` je **kritičan**. Stara shema je bila `UNIQUE(module, msgid, variant)` — što je značilo da `--build-from-pot --version 19.0` upsert collision-a sve postojeće v16.0 redove i čuva njihovu `version='16.0'` oznaku. U praksi: `purchase` modul `Cancel → Otkaži` postoji jednom u bazi, oznakom 16.0; pokušaš naliti za 19.0 i nema novog reda. Detect pattern: nakon `--build-from-pot --version 19.0` koji "doda 62k entries", tabela ima **manje** v19.0 redova nego očekivano.

Migracija je idempotentna i automatska — `_create_schema()` u `translation_assistant_bs_v2.py` detektuje stari UNIQUE index, kreira `translations_new` sa proširenim ključem, copy preko `INSERT INTO translations_new SELECT ... FROM translations`, drop + rename, recreate indexes.

## Pipeline po grupi

Za svaku `oca-ocb-<group>` grupu (radi se u serijama od 4-5 grupa po batch-u):

### 1. Worktree refresh

`core_0/scripts/create_ocb_branch.py --branch 19.0 --subproject packages/oca-ocb-<group> --only-refresh` orchestruje:

- Detect-uje da li `worktrees/19.0/packages/oca-ocb-<group>/` već postoji kao branch worktree (per `git worktree list --porcelain` traženje `branch refs/heads/19.0`)
- Ako da: `git fetch origin 19.0 && git reset --hard origin/19.0` u worktree-u, *ne dira master submodule* (ne pravi "branch is already used by another worktree" konflikt)
- Ako ne: classic checkout u glavnoj submodule putanji

Onda zove `refresh_packages_from_oca.py --subproject packages/oca-ocb-<group> --branch 19.0 --no-fetch-blobs --dest-root /path/to/worktrees/19.0`. Novi `--dest-root` flag prepisuje `WORKSPACE_ROOT` samo za destinaciju (`bringout_root` property u `PackageMapping`), tako da git/cache operacije i dalje koriste glavni `REPO_ROOT`, a addon kontent se sinkronizuje u worktree umjesto u glavni submodule.

Rsync iz `tmp/oca_repos/OCA__OCB_19_0/` worktree-a OCA/OCB upstream-a (sa filterima iz `source_repository_skip` u `odoo_packages_mapping.json`) overpisuje `worktrees/19.0/packages/oca-ocb-<group>/odoo-bringout-oca-ocb-<addon>/<addon>/`.

### 2. Build + import POT/bs.po

```bash
cd translate_bosnian
python3 scripts/translation_assistant_bs_v2.py \
  --source-dir /path/to/worktrees/19.0/packages \
  --db-path data/translations_bs.db \
  --build-from-pot --version 19.0

python3 scripts/translation_assistant_bs_v2.py \
  --source-dir /path/to/worktrees/19.0/packages \
  --db-path data/translations_bs.db \
  --import-bs-po --version 19.0
```

`--build-from-pot` skenira sve `.pot` fajlove i kreira jedan red po `(module, msgid, variant='default', version='19.0')`, sa `msgstr=''` i `priority=0`. `--import-bs-po` traži `bs.po` fajlove pored `.pot`-a — OCA/OCB upstream uglavnom ima ne-prazne bs.po fajlove (sinkroniziraju se sa Weblate-om kojeg održava translate.odoo.com), tako da ovaj korak puni dosta translation-a sa `priority=30 (bs.po)`.

Verifikovao sam da su upstream OCA/OCB 19.0 bs.po fajlovi byte-identični sa `odoo/odoo` 19.0 grane na 7 sample modula (base, bus, mail, purchase, sale_purchase, uom, web) — fork ne divergira na translation sloju.

### 3. Backfill iz prethodne verzije

```bash
python3 scripts/translation_assistant_bs_v2.py \
  --db-path data/translations_bs.db \
  --update-from-previous-versions --version 19.0
```

Za svaki untranslated v19.0 red traži `(module, msgid, variant)` u v16.0 sa ne-praznim `msgstr`-om i kopira ga u v19.0 red sa source `from_v16.0`. Ako modul postoji u v16.0 i v19.0 sa istim string-om — prijevod se naslijedi besplatno.

### 4. AI batch-evi za ostatak

Untranslated stringovi se grupišu u PO batch fajlove:

```bash
python3 scripts/translation_assistant_bs_v2.py \
  --db-path data/translations_bs.db \
  --generate-translate-bs-po --version 19.0 \
  --untranslated-from-modules "<lista>" \
  --number 7 --limit 500
```

Novi flag `--untranslated-from-modules` (uz postojeći `--all-from-modules`) ograničava batch na samo prazne `msgstr` redove iz datih modula — različito od `--all-from-modules` koji emituje SVE redove (translated + untranslated, korisno za pregled u Poedit-u). Generate radi dedup-iranje po `msgid` (jedan red preživi po batch-u, čak ako se `msgid` pojavljuje u više modula).

7 paralelnih Claude subagent-a (po jedan PO fajl po agentu) prevodi sa preciznim pravilima:

- Bosanski Latin (bez ćirilice), B&H business register
- Sačuvati placeholder-e (`%s`, `%(name)s`, `{name}`), HTML/QWeb tag-ove, escape-ovane navodnike, multi-line shape, novi red marker-e
- Vlastite imenice i brand-ovi ostaju (Odoo, Stripe, PayPal, GitHub, currency/country code-ovi, sample names like John Doe)
- Tehnički identifikatori netaknuti (model imena, field imena, XML id-jevi)
- Common term-ovi standardizovani: `Cancel→Otkaži, Confirm→Potvrdi, Save→Sačuvaj, Customer→Kupac, Sales→Prodaja, Order→Narudžba, Quotation→Predračun, Invoice→Faktura, Quantity→Količina, Price→Cijena, Total→Ukupno, Tax→Porez, ...`

Svaki agent na kraju validira sa `msgfmt --check` (mora exit 0).

Output se import-uje nazad sa source `translate_bs.po` i `priority=15`. Import update-a SVE redove sa istim `msgid`-om u v19.0 (cross-modul propagacija — jedan prevod `Cancel` pokriva `purchase`, `sale`, `mail`, `pos`, ...).

### 5. Export + commit + push

```bash
python3 scripts/translation_assistant_bs_v2.py \
  --source-dir /path/to/worktrees/19.0/packages \
  --db-path data/translations_bs.db \
  --export-po --version 19.0
```

`--export-po` piše `bs.po` u svaki `<addon>/i18n/` direktorij za koji baza ima v19.0 redove. Polib serijalizuje sa svojim line-wrapping-om (overpisuje raniji weblate output, ali sadržajno isto).

Commit u worktree-u (na branch 19.0), push u `bringout/oca-ocb-<group>` GitHub remote.

## Distribucijski zip

Nakon što je svih 17 grupa procesovano, `translate_bosnian/scripts/build_v19_translation_zip.py` skuplja sve bs.po-e u flat layout:

```
oca-ocb-core/odoo-bringout-oca-ocb-mail/mail/i18n/bs.po
                ↓
oca-ocb-core/mail/i18n/bs.po

oca-ocb-core/odoo-bringout-oca-ocb-base/odoo/addons/base/i18n/bs.po   (base je special)
                ↓
oca-ocb-core/base/i18n/bs.po

oca-ocb-website/odoo-bringout-oca-ocb-payment_stripe/i18n/bs.po       (flat wrapper)
                ↓
oca-ocb-website/payment_stripe/i18n/bs.po
```

Tri source layout-a se dispatch-uju u `classify(path)`:

```python
# 1. base special: oca-ocb-core/odoo-bringout-oca-ocb-base/odoo/addons/<addon>/i18n/bs.po
if (len(rel_parts) >= 7
    and rel_parts[1] == "odoo-bringout-oca-ocb-base"
    and rel_parts[2] == "odoo"
    and rel_parts[3] == "addons"):
    return group, rel_parts[4]

# 2. standard: oca-ocb-<group>/odoo-bringout-oca-ocb-<addon>/<addon>/i18n/bs.po
if len(rel_parts) == 5 and rel_parts[1].startswith("odoo-bringout-"):
    return group, rel_parts[2]

# 3. flat wrapper: oca-ocb-<group>/odoo-bringout-oca-ocb-<addon>/i18n/bs.po
if len(rel_parts) == 4 and rel_parts[1].startswith("odoo-bringout-oca-ocb-"):
    addon = rel_parts[1][len("odoo-bringout-oca-ocb-"):]
    return group, addon
```

Rezultat: **335 bs.po fajlova u 19 oca-ocb-* foldera, 2.96 MB compressed**.

→ [Download oca-ocb-v19_translation_bs.zip](/oca-ocb-v19_translation_bs.zip)

## Deploy na hodi-1 + hodi-2

Sve hodi-* hostovi hostuju Odoo iz `infra-hodi/pkgs/odoo/odoo19/default.nix` koji pinuje svaki `oca-ocb-*` repo na konkretan commit. Bumpa se cijela lista `ocbRepos`:

```nix
ocbRepos = [
  { name = "oca-ocb-core"; url = "https://github.com/bringout/oca-ocb-core.git"; rev = "37f8a5da..."; }
  { name = "oca-ocb-mail"; url = "https://github.com/bringout/oca-ocb-mail.git"; rev = "cdd26e41..."; }
  # ... 13 grupa total ...
];
```

`fetchGit` po commit-u, `mkDerivation` flatten-uje u jedan `odoo19-addons` direktorij sa simbolic linkovima na addon foldere (bez konfliktnih file-ova jer "first-wins" check `if [ ! -e "$out/$addon_name" ]`).

Deploy:

```bash
# bump nix bundle, push
cd infra-hodi && git commit -am 'odoo19: bump 13 oca-ocb-* revs' && git push

# colmena apply na oba hosta
python3 scripts/deploy_infra-hodi_on_hetzner-1.py hodi-2 switch
python3 scripts/deploy_infra-hodi_on_hetzner-1.py hodi-1 switch

# rsync per-instance addons (auth_oidc, eurooffice, ...)
python3 scripts/hodi_odoo_install_modules.py config/hodi/bringout-test19/config.yaml --rsync-only

# force-reload bs prijevode iz disk-a
ssh hodi-2 'systemctl stop hodi-odoo-bringout-test19'
ssh hodi-2 'hodi-bringout-test19-cmd \
    --update=all --i18n-overwrite \
    --load-language=bs_BA \
    --stop-after-init --workers=0 --no-http'
ssh hodi-2 'systemctl start hodi-odoo-bringout-test19'
```

Bitno: **prvi `--update=all --i18n-overwrite` neće učitati bs prijevode ako jezik nije aktivan u toj instanci**. Sequence:

1. Aktiviraj `bs_BA` jezik (`res.lang.write({'active': True})` na id 9 — Bosanski / bosanski jezik dolazi pre-loaded u Odoo res.lang tabelu, samo `active=False`).
2. Postavi `podrska` user-u `lang='bs_BA'`.
3. Zatim run `--update=all --i18n-overwrite --load-language=bs_BA`.

Ovo posljednje sad emituje `loading translation file /nix/store/.../<module>/i18n/bs.po for language bs_BA` za svaki modul (vidi se u systemd journal-u), i ovaj put translation-i stvarno landiraju u bazu (kao novi jsonb sloj na source modelima u Odoo 17+, jer `ir.translation` tabela više ne postoji).

## Live verifikacija

XMLRPC poll na `bringout-test19.hodi.ba` poslije reload-a:

```python
common.authenticate(DB, LOGIN, PASS, {})
fields = call("ir.model.fields", "search_read",
              [[("model","=","res.partner"),("name","in",["name","vat","city"])]],
              {"context": {"lang": "bs_BA"}})
```

Output:

```
res.partner:
  name         string='Naziv'
  vat          string='PDV ID / OIB'
  city         string='Grad'
  is_company   string='Je kompanija'
purchase.order:
  partner_id   string='Dobavljač'
  date_order   string='Krajnji rok narudžbe'
  state        string='Status'
  amount_total string='Ukupno'
sale.order:
  partner_id   string='Kupac'
  date_order   string='Datum narudžbe'
account.move:
  invoice_date string='Datum računa'
```

## Zašto baš ovaj layout u zip-u

OCA/OCB Odoo grane drže addon-e ugnježdene unutar *Bringout python package wrapper-a*: `odoo-bringout-oca-ocb-<addon>/<addon>/`. Dva razloga što to nije udobno za standalone download:

1. Korisnik koji samo želi nakopirati `bs.po` u svoju vanilla `odoo/addons/<addon>/i18n/` lokaciju mora napraviti dvije level-a path navigation-a.
2. `base` modul (čije bs.po je 2 MB sam) ima drugi layout — `odoo-bringout-oca-ocb-base/odoo/addons/base/i18n/bs.po` — što razbije naive scripted unzip.

Flat zip sa `oca-ocb-<group>/<addon>/i18n/bs.po` je direktno copy-paste-able u standardni Odoo addons checkout — `unzip oca-ocb-v19_translation_bs.zip; rsync -a oca-ocb-core/ /path/to/odoo/addons/` i bs.po fajlovi landiraju gdje Odoo i18n loader očekuje.

## Šta dalje

- `oca-ocb-vertical-industry` (5 modula) — preostali untouched grupa
- Bringout vlasnički l10n_ba moduli (`l10n_ba`, `l10n_ba_edi`, `l10n_ba_pdv`) — već imaju 100% bs prijevod jer su pisani lokalno, ali nije dio ovog zip-a (oni nisu `oca-ocb-*`)
- v17.0/v18.0 — isti pipeline, samo `--branch 17.0` / `--branch 18.0`. Nakon migracije sheme, baza koegzistira version-e bez problema.

Ako naletite na konkretan loš prijevod (Odoo dosta marketing string-ova ima u mass_mailing/website demo content-u — moja AI greška je propustila da "Dummies" → "pokučare" je derogatorno; ispravljeno na "početnike" preko manual override-a sa `priority=100, source='manual'`), report-ujte na [hernad@bring.out.ba](mailto:hernad@bring.out.ba).

---

📦 [oca-ocb-v19_translation_bs.zip](/oca-ocb-v19_translation_bs.zip) (2.96 MB)
🔗 git.hodi.ba mirror: [oca/oca-ocb-core @ 19.0](https://git.hodi.ba/oca/oca-ocb-core/commits/branch/19.0) (i ostale `oca-ocb-*` grupe pod [git.hodi.ba/oca](https://git.hodi.ba/oca))
