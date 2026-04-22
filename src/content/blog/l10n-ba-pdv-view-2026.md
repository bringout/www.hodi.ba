---
title: 'Bosanska lokalizacija Odoo: Modul l10n_ba_pdv_view — pregled PDV knjiga preko više mjeseci bez regenerisanja'
description: 'Novi Odoo 16 modul l10n_ba_pdv_view. Read-only pregled eNabavke / eIsporuke, podržava višemjesečne periode (npr. 01.01.2026 – 28.02.2026) i izvozi identičan XLSX format kao l10n_ba_pdv, ali ne dira postojeće zapise u tabelama.'
pubDate: '2026-04-22T19:32:28'
heroImage: '/pdv-view-hero.svg'
---

## Problem

`l10n_ba_pdv` je glavni modul za obračun PDV-a u BiH u Odoo 16. Njegov XLSX izvještaj (`KUF`, `KIF`, a inače output datoteke `218025900006_2601.xlsx`, `218025900006_2602.xlsx` itd.) radi posao, ali ima dvije inženjerske granice dizajna:

1. **Uvijek regeneriše tabele** `ba.pdv.nabavke` i `ba.pdv.isporuke` pri svakom pozivu izvještaja (`generate_enabavke`/`generate_eisporuke` sa `regenerate=True`). Ako su podaci za period već zaključani, ponovo pokretanje brise i upisuje iznova.
2. **Forsira jedan porezni period** — validator blokira bilo koji period koji pokriva više od jednog kalendarskog mjeseca. PDV obračun je uvijek mjesečni, ta provjera je korisna.

Ali nekad želiš samo **pregledati** šta je već generisano — bez dodirivanja podataka. Ili želiš vidjeti KUF+KIF za dva (ili više) perioda odjednom u jednom XLSX-u, npr. 01.01.2026 – 28.02.2026 sa oba mjeseca u istoj tabeli.

## Rješenje: `l10n_ba_pdv_view`

Novi modul koji dolazi kao **dodatak** na `l10n_ba_pdv`. Nije zamjena — koristi iste tabele:

- `ba.pdv.nabavke` — eNabavke (KUF, knjiga ulaznih faktura)
- `ba.pdv.isporuke` — eIsporuke (KIF, knjiga izlaznih faktura)

Ali **čita, a ne piše**. Nema poziva `generate_enabavke()` / `generate_eisporuke()`. Samo `search` sa `porezni_period IN (...)` domenom, pa u XLSX.

### Wizard

```
Accounting → Reporting → PDV pregled (višemjesečni)
```

Tri polja: `Pregled od`, `do`, `Preduzeće`. Jedno dugme: `Generiši xlsx`.

### Podržava višemjesečne periode

Za period 01.01.2026 – 28.02.2026 modul interno izračunava listu YYMM vrijednosti koje opsežu taj raspon (`['2601', '2602']`), pa filtrira:

```python
domain = [
    ('company_id', '=', company_id.id),
    ('porezni_period', 'in', porezni_periods),
]
records = self.env['ba.pdv.nabavke'].search(
    domain, order="porezni_period, enabavke_id"
)
```

Jedna XLSX datoteka, dva `sheet`-a (`enabavke`, `eisporuke`), redovi svih mjeseci poredani po `porezni_period` pa `enabavke_id`/`eisporuke_id`.

### Isti XLSX format

Kolone su identične onima iz `l10n_ba_pdv`:

**enabavke (20 kol.)**: `por_per, enabavke_id, tip, jci, br_fakt, dat fakt, dat prijem, dobavlj naziv, dobav sljedište, dob_pdv, dob_id, iznos bez PDV, sa PDV, polj. pausal, PDV SVE, PDV posl, PDV neposl, PDV np 32, PDV np 33, PDV np 34`

**eisporuke (22 kol.)**: `por_per, eisporuke_id, tip, jci, Dat.Fakt, Br.Fakt, kupac naziv, kupac sljedište, Kup.PDV, Kup.ID, Fakt sa PDV, Fak.sa PDV interna, Fak.sa PDV0 izvoz, Fak sa PDV0 ostalo, F.bez PDV, F.PDV, F.bez PDV NP, F.PDV NP, PDV np 32, PDV np 33, PDV np 34, Opis`

Na dnu `SUM` formule na svim numeričkim kolonama. Dodatna totalna linija na eisporuke (`O+Q`, `P+R`) je takođe prisutna, kao i u originalu.

## Verifikacija: `bring.out` baza, stvarni podaci

Modul je instaliran u produkciju (`bringout.odoo.cloud.out.ba`) i testiran protiv referentnih XLSX fajlova koji su već zakačeni za PDV prijave:

- `218025900006_2601.xlsx` → zakačen na `PDV/26/01/0001` (januar 2026)
- `218025900006_2602.xlsx` → zakačen na `PDV/26/02/0001` (februar 2026)

Tri perioda, tri XLSX-a iz `l10n_ba_pdv_view`, poređenje kolona sa referentnim fajlovima:

| Period | KUF redova | KIF redova | ∑ iznos bez PDV (KUF) | ∑ PDV (KUF) |
|---|---|---|---|---|
| 2026-01-01 .. 01-31 | **32** | **35** | 2.695,72 | 297,91 |
| Referenca 2601 | 32 | 35 | 2.695,72 | 297,91 |
| 2026-02-01 .. 02-28 | **22** | **48** | 1.698,98 | 247,67 |
| Referenca 2602 | 22 | 48 | 1.698,98 | 247,67 |
| **2026-01-01 .. 02-28** | **54** | **83** | **4.394,70** | **545,58** |

Redovi i sume su **identični** referentnim vrijednostima do posljednje feninge. Višemjesečni period daje tačno zbir pojedinačnih mjeseci: `32 + 22 = 54` KUF redova i `35 + 48 = 83` KIF reda.

## Šta ne radi

- **Ne generiše PDV knjige.** Za to i dalje koristi `l10n_ba_pdv` (`Accounting → Reporting → PDV obračun Bosna i Hercegovina`).
- **Ne mijenja ništa u bazi.** Nema `write`, nema `create`, nema `unlink`. Samo `search` + `read` + XLSX output.
- **Ne generiše eNabavke/eIsporuke CSV** za upload u UINO portal — za to je predviđen postojeći modul; ovaj je samo pregled.

## Gdje živi kod

- GitHub: [`bringout/odoo-bringout-l10n_ba_pdv_view`](https://github.com/bringout/odoo-bringout-l10n_ba_pdv_view) (privatno)
- Submodul u glavnom mono-repou `bringout/0`: `packages/bringout/odoo-bringout-l10n_ba_pdv_view`
- Zavisi od: `l10n_ba_pdv`, `report_xlsx`
- Licenca: **AGPL-3**

## Instalacija u produkciju

Standardni produkcijski workflow (Nix + Colmena + `odoo-bosnian` servis na `node41`):

```bash
python scripts/upgrade_production_nix_service.py --modules l10n_ba_pdv_view --install
```

Script sinhronizuje modul na odoonix, pakuje zip, uploada na download server, ažurira Nix konfiguraciju, deploya kroz Colmena, i instalira modul u bazu. Verzija se bumpuje sa semantičkim redoslijedom koji prati `__manifest__.py`.

## Implementacioni detalji

Za tehničke ljude koji vole vidjeti kostur:

```python
# ba_pdv_view_wizard.py
class BaPDVViewWizard(models.TransientModel):
    _name = 'ba.pdv.view.wizard'

    date_from = fields.Date(required=True)
    date_to = fields.Date(required=True)
    company_id = fields.Many2one("res.company", required=True)

    def _get_porezni_periods(self):
        """Lista YYMM stringova koji pokrivaju date_from..date_to."""
        periods = []
        current = self.date_from.replace(day=1)
        last = self.date_to.replace(day=1)
        while current <= last:
            periods.append(current.strftime("%y%m"))
            current = (current.replace(year=current.year + 1, month=1)
                       if current.month == 12
                       else current.replace(month=current.month + 1))
        return periods

    def action_generate_xlsx(self):
        data, report_name = self._build_report_data()
        report = self.env.ref('l10n_ba_pdv_view.pdv_view_xlsx_report')
        return report.with_context(report_name=report_name)\
                     .report_action(self, data=data)
```

XLSX generator (u `report_xlsx.py`) je jednostavna petlja kroz `search`:

```python
domain = [
    ('company_id', '=', company_id.id),
    ('porezni_period', 'in', porezni_periods),
]
records = self.env['ba.pdv.nabavke'].search(
    domain, order="porezni_period, enabavke_id"
)
for rec in records:
    sh.write(row, 0, rec.porezni_period)
    sh.write(row, 1, str(rec.enabavke_id).rjust(10, '0'))
    # ...
    row += 1
```

Nema magije, nema overrida `generate_*` metoda, samo pregled.

## Zaključak

Ako ti treba sumarni KUF+KIF pregled preko više mjeseci bez dodirivanja podataka — `l10n_ba_pdv_view` je tu. Sve što postojeći `l10n_ba_pdv` već zna da generiše, ovaj modul zna da **pokaže** u jednoj tabeli koliko god mjeseci želiš u isti XLSX.

Dobar alat za računovođu koji želi vidjeti kontinuitet KUF/KIF-a preko kvartala ili polugodišta, a da ne riskira regeneraciju tabela koje su zaključane nakon predaje PDV prijave.

## Napomena

Generisano od strane Claude 🤖

---

Ernad Husremović, hernad@bring.out.ba
