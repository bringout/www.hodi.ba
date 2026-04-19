---
title: 'Dva payroll modula u jednoj Odoo bazi — OCA payroll i ba_payroll side-by-side'
description: 'Kako smo napravili rename-generator skriptu koja forkuje OCA payroll u ba_payroll sa prefiksiranim modelima, tako da oba stacka koegzistiraju u istoj bazi bez MRO, XML-id, M2M i unique-constraint kolizija.'
pubDate: '2026-04-19T23:10:00'
heroImage: '/ba-payroll-bosnia-menu.png'
---

## Uvod

U [prethodnom postu o multi-company zaštiti](/blog/multi-company-protect-psql-payroll-2026.md/) i u [analizi Odoo licenci](https://www.bring.out.ba/blog/odoo-licence-analiza-2026/) razmatrali smo scenarij gdje se u jednoj Odoo bazi mora obračunati plata po **različitim pravilima po kompaniji** — npr. Bosna po lokalnim propisima (OCA payroll-style), Hrvatska i Slovenija po Odoo EE payroll-u. Odoo-ov moduli sistem učitava sav kôd na **nivou baze**, a ne po kompaniji — zbog toga dva payroll modula koji oba definišu iste modele (`hr.payslip`, `hr.contract`, `hr.salary.rule`) ne mogu istovremeno biti instalirana. MRO konflikt pri prvom `odoo -u` i sve puca.

Ovaj post pokazuje konkretan pristup koji **mi je proradio**: forkanje OCA payroll-a kroz **rename-generator** — skriptu koja na ulazu uzima upstream OCA `payroll` i na izlazu generiše paralelni `ba_payroll` modul u kome je svaki OCA-owned model preimenovan sa `ba.` prefiksom. Oba stacka onda rade side-by-side u istoj bazi, svaki sa svojim tabelama, menijima, sekvencama i decimalnim preciznostima.

> **Napomena:** Generisano od strane Claude 🤖

## Zašto ne funkcionišu zajedno — u jednoj rečenici

Odoo gradi model registar tako što **spaja sve klase koje imaju `_name = 'X'` ili `_inherit = 'X'`** kroz MRO u jednu konačnu Python klasu. Ako OCA `payroll` definiše klasu sa `_name = 'hr.payslip'` i Odoo EE `hr_payroll` takođe definiše klasu sa `_name = 'hr.payslip'`, Odoo vidi dvije definicije istog modela — obe moraju biti spojene. XML ID-evi se sudaraju, metode se gaze, polja se dupliraju. Prvi `odoo -u` ne prolazi.

## Rješenje: rename-generator

Napisali smo [`core_0/scripts/rename_oca_payroll.py`](https://github.com/bringout/core_0/blob/main/scripts/rename_oca_payroll.py) — pojednostavljen, Python-u, oko 750 linija. Radi ovo:

1. **Discovery:** prolazi kroz cijeli OCA payroll izvor, AST-om skida svaku `_name = 'X'` deklaraciju — **samo** modeli koje OCA direktno definiše završe u rename mapi. Modeli koji se samo extenduju (`_inherit = 'hr.employee'` bez vlastitog `_name`) ostaju netaknuti, ali se zabilježe za ručni pregled.
2. **Transform Python:** `_name = 'hr.payslip'` → `_name = 'ba.hr.payslip'`, `_inherit = 'hr.payslip'` → `_inherit = 'ba.hr.payslip'` (samo kad je u rename mapi), `self.env['hr.payslip']` → `self.env['ba.hr.payslip']`, `fields.Many2one('hr.payslip', ...)` i analogno One2many/Many2many.
3. **Transform XML:** `<record model="hr.payslip">`, `<field name="model">`, `<field name="res_model">`, ref atributi, menuitem labeli, web_icon prefiksi, `groups="module.xxx"` atributi (komad po komad).
4. **Transform CSV:** `ir.model.access.csv` kolone `model_id:id` — `model_hr_payslip` → `model_ba_hr_payslip`.
5. **Specijalni slučajevi:** M2M relation tabele (eksplicitna imena poput `hr_structure_salary_rule_rel` se prefiksiraju u `ba_payroll_...`), `decimal.precision` imena koja su unique na DB nivou (`Payroll` → `BA Payroll`), auto-generisani `ir.model` XML-ID-evi u short (`model_hr_payslip`) i long formi (`payroll.model_hr_payslip`).
6. **`--drop-extensions`:** opcioni flag koji izbacuje klase koje samo extenduju core modele (`hr.contract`, `hr.employee`, `hr.leave.type`). Potrebno kada BA stack treba koegzistirati sa OCA payroll-om u istoj bazi — inače bi dvaput dodali iste field-ove na `hr.contract`.

Za obnavljanje iz upstream OCA izvora dovoljno je ponoviti komandu:

```bash
python3 core_0/scripts/rename_oca_payroll.py \
  --input  packages/oca-payroll/odoo-bringout-oca-payroll-payroll/payroll \
  --output packages/bringout/odoo-bringout-ba_payroll/ba_payroll \
  --drop-extensions \
  --menu-prefix BA
```

Ključno pravilo: **nikada se ne uređuje output ručno.** Bosna-specifična logika (npr. domaći doprinosi, MIP/GIP obrasci, lokalne kategorije plata) ide u **odvojen overlay modul** koji dependuje na `ba_payroll` i extenduje `ba.hr.payslip`. Tako regeneracija iz svake nove OCA verzije ostaje jednostavna — `git diff` review, commit.

## Side-by-side demo

Instalirano oba modula na [multi-test.hodi.ba](https://multi-test.hodi.ba) i dodali tri payroll operatera — po jedan po zemlji (BA, HR, SI), svaki zaključan na svoju kompaniju pomoću `psql_company_lock_id` polja iz [RLS modula](/blog/multi-company-protect-psql-payroll-2026.md/).

**Bosanski payroll clerk** (`demo.payroll.ba@hodi.ba`) vidi **BA Payroll** menije — kompletan ba_payroll stack, prefiksiran sa "BA " za vizuelnu distinkciju:

![BA Payroll meni prikazan bosanskom payroll clerku — BA Payroll / BA Employee Payslips / BA Payslips Batches / BA Configuration](/ba-payroll-bosnia-menu.png)

**Hrvatski payroll clerk** (`demo.payroll.hr@hodi.ba`), ista baza, ista Odoo instanca, istim browserom nakon logout/login — vidi **Payroll** menije (klasičan OCA payroll, bez BA prefiksa):

![Payroll meni prikazan hrvatskoj payroll clerkici — standardni OCA payroll menu sa listom payslip-a](/payroll-croatia-menu.png)

Isti Odoo proces, ista PostgreSQL baza. U DB-u se nalaze **oba** payroll stack-a paralelno — zasebne tabele, zasebni modeli, zasebni mail template-i, zasebne sekvence:

```sql
SELECT tablename FROM pg_tables
WHERE tablename LIKE '%payslip%'
ORDER BY 1;
--  ba_hr_payslip              <- BA stack, fizička tabela
--  ba_hr_payslip_input
--  ba_hr_payslip_line
--  ba_hr_payslip_run
--  ba_hr_payslip_worked_days
--  hr_payslip                 <- OCA stack, fizička tabela
--  hr_payslip_input
--  hr_payslip_line
--  hr_payslip_run
--  hr_payslip_worked_days
```

```sql
SELECT name, state, latest_version
FROM ir_module_module
WHERE name IN ('payroll', 'ba_payroll');
--  ba_payroll | installed | 16.0.1.6.0
--  payroll    | installed | 16.0.1.6.0
```

## Kontrola vidljivosti menija — stack marker grupe

Sami `ir.ui.menu.groups_id` su "**bilo koji od**" — dodavanje grupe na root meni **ne sakriva** meni od korisnika koji imaju druge pristupne grupe. Odoo ima, međutim, drugu gate: ako su **sva djeca** root menija sakrivena za korisnika (zbog svojih `groups_id` restrikcija), onda i **parent** postaje nevidljiv. To iskorištavamo:

1. Definišemo dvije marker grupe: `group_payroll_stack_oca` i `group_payroll_stack_ba`.
2. Na `payroll.payroll_menu_root` i `ba_payroll.payroll_menu_root` dodamo odgovarajuću marker grupu kao `groups_id` (preko XML record inheritance — **ne** diramo izvorni modul).
3. Dodjeljujemo grupe korisnicima automatski u post-init hooku našeg demo data modula: BA clerk → BA marker + `ba_payroll.group_payroll_user`; HR/SI clerk → OCA marker + `payroll.group_payroll_user`; admin → obe grupe.

Korisnik koji nema marker grupu ne prolazi provjeru na root meniju — ali mora takođe imati i pravu **access** grupu za tu granu kako bi djeca postala vidljiva. Upravo ta kombinacija marker + access određuje koju granu vidi:

<table style="border-collapse: collapse; width: 100%;">
  <thead>
    <tr style="background: #f5f5f5;">
      <th style="border: 1px solid #999; padding: 0.5em 0.8em; text-align: left;">Korisnik</th>
      <th style="border: 1px solid #999; padding: 0.5em 0.8em; text-align: left;">Stack marker</th>
      <th style="border: 1px solid #999; padding: 0.5em 0.8em; text-align: left;">Access grupa</th>
      <th style="border: 1px solid #999; padding: 0.5em 0.8em; text-align: left;">Vidi</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td style="border: 1px solid #ccc; padding: 0.5em 0.8em;">BA payroll clerk</td>
      <td style="border: 1px solid #ccc; padding: 0.5em 0.8em;"><code>group_payroll_stack_ba</code></td>
      <td style="border: 1px solid #ccc; padding: 0.5em 0.8em;"><code>ba_payroll.group_payroll_user</code></td>
      <td style="border: 1px solid #ccc; padding: 0.5em 0.8em;">BA Payroll meni</td>
    </tr>
    <tr>
      <td style="border: 1px solid #ccc; padding: 0.5em 0.8em;">HR / SI payroll clerk</td>
      <td style="border: 1px solid #ccc; padding: 0.5em 0.8em;"><code>group_payroll_stack_oca</code></td>
      <td style="border: 1px solid #ccc; padding: 0.5em 0.8em;"><code>payroll.group_payroll_user</code></td>
      <td style="border: 1px solid #ccc; padding: 0.5em 0.8em;">Payroll meni</td>
    </tr>
    <tr>
      <td style="border: 1px solid #ccc; padding: 0.5em 0.8em;">Admin / HR manager</td>
      <td style="border: 1px solid #ccc; padding: 0.5em 0.8em;">obe</td>
      <td style="border: 1px solid #ccc; padding: 0.5em 0.8em;">obe</td>
      <td style="border: 1px solid #ccc; padding: 0.5em 0.8em;">oba menija</td>
    </tr>
  </tbody>
</table>

## Šta ovaj pristup rješava, a šta ne

**Rješava:**
- Dva open-source payroll modula u jednoj bazi bez MRO kolizija
- Automatska regeneracija iz upstream-a (svaka nova OCA verzija → `rename_oca_payroll.py` → `git diff` → commit)
- Razdvajanje korisnika po stack-u kroz grupe, bez modifikacije izvora originalnog OCA payroll-a
- Osnova za Bosanski payroll overlay modul (koji extenduje `ba.hr.payslip` sa lokalnim pravilima)

**Ne rješava direktno, ali je arhitektonski izvedivo:**
- **EE `hr_payroll` + ba_payroll u istoj bazi** — rename-generator i ovo pokriva, **bez ikakve modifikacije EE-a**. Razlog: EE ostaje u `hr.*` namespace-u (`hr.payslip`, `hr.salary.rule`), a ba_payroll je već preimenovan u `ba.*` (`ba.hr.payslip` itd.). Model-imena se ne sudaraju, što je jedina fundamentalna prepreka. Gore opisani **OCA + ba_payroll** eksperiment na multi-test-u dokazuje isti mehanizam — jedina razlika je što partner stack dolazi iz zatvorenog EE izvora umjesto iz OCA-e. Nismo fizički testirali EE kombinaciju (nemamo EE licencu na sandboxu), ali arhitektura je ista.

#### Šta tačno znači "tanak overlay modul"

Rename-generator je pokrenut sa `--drop-extensions`, što znači da ba_payroll **ne dodaje** polja poput `schedule_pay` ili `struct_id` na `hr.contract`. Fileove koji su to radili smo izbacili — inače bi se dvaput definisali isti field-ovi pošto OCA payroll ih već dodaje. Ali **ba_payroll-ov vlastiti Python kôd i dalje čita ta polja** sa `hr.contract`:

```python
# ba_payroll/models/hr_payslip.py (renamed iz OCA hr_payslip.py)
def compute_sheet(self):
    for slip in self:
        contract = slip.contract_id          # hr.contract record
        schedule = contract.schedule_pay     # <-- očekuje ovo polje
        struct = contract.struct_id          # <-- i ovo
```

Na trenutnom multi-test-u ovo radi jer je **OCA `payroll` instaliran** i njegov `models/hr_contract.py` dodaje `schedule_pay` + `struct_id` na shared `hr.contract` tabelu. ba_payroll samo pročita ta polja — nema konflikta jer postoji samo jedan writer (OCA).

U scenariju gdje umjesto OCA-e imamo EE `hr_payroll`, pitanje postaje: **da li EE dodaje polje tačno imenovano `schedule_pay`? I tačno `struct_id`?**

- **Najvjerovatnije da za većinu polja.** I OCA `payroll` i Odoo EE `hr_payroll` potiču iz istog Odoo 14 CE pretka — ista kodna baza prije OCA forka u v15. Uobičajena imena poput `schedule_pay`, `struct_id`, `resource_calendar_id` su stabilna kroz verzije.
- **Moguće ne za poneko.** EE se razvijao u svojim smjerovima od v15. Polje koje OCA zove `struct_id` u aktuelnom EE-u može biti `salary_structure_id`, ili tip može da se razlikuje.

Ako se neki nesklad pojavi, rješava se tankim overlay modulom koji mapira ili preimenuje nedostajuća polja:

```python
# bringout_payroll_ee_adapter/models/hr_contract.py — ~15 linija
from odoo import fields, models

class HrContract(models.Model):
    _inherit = 'hr.contract'

    # ba_payroll očekuje .struct_id — alias za EE-ovo .salary_structure_id
    struct_id = fields.Many2one(
        'hr.payroll.structure',
        related='salary_structure_id',
        store=True, readonly=False,
    )
    # ba_payroll očekuje .schedule_pay — EE već ima isto ime (nema šta da radimo)
```

Manifest + 3–5 takvih aliasa × ~10 LOC svaki = **~50 LOC ukupno**. To je **kompletan dodatni trošak** puštanja ba_payroll-a protiv EE umjesto protiv OCA-e. Ne prepisujemo EE-ov `compute_sheet`, ne dupliramo salary-rule engine, ne implementiramo ništa EE-specifično — samo **prevodimo imena polja** tako da ba_payroll-ov postojeći kôd (koji je naslijeđen iz OCA-e) može da čita EE-ove kontrakte.

Ako se ispostavi da treba 200 LOC (desetak nesklada) — i dalje je "overlay teritorija", ne rekonstrukcija. Stvarni broj se može izmjeriti tek kad neko provjeri protiv EE licence; naša procjena bazirana je na zajedničkom porijeklu OCA/EE.

**Stvarno ne rješava:**
- Renaming EE `hr_payroll`-a samog po sebi (ako bi se pojavila potreba da se EE-ove modele preimenuje u `ee.*` paralelno sa ba_payroll-om) — to nije moguće jer je EE closed-source. Ali to nije ni scenarij koji se traži: EE ostaje takav kakav je, sa svojim `hr.payslip`.
- Core model ekstenzije (`hr.contract`, `hr.employee`, `hr.leave.type`) koje OCA payroll dodaje i dalje idu kroz core tabelu. Sa `--drop-extensions` ih izbacimo iz ba_payroll-a, ali onda ba_payroll **ima meku zavisnost** na neko treće mjesto koje te field-ove pruža — u trenutnom setup-u to je OCA `payroll`. U EE + ba_payroll setupu, to bi bila EE-ova ekstenzija ili prethodno spomenuti overlay modul.

## Izvorni kod

Sve javno dostupno. Licenca prati upstream izvor:

- Rename-generator skripta (AGPL-3): [github.com/bringout/core_0](https://github.com/bringout/core_0) — `scripts/rename_oca_payroll.py`
- Generisani **ba_payroll** modul (**LGPL-3** — nasljeđuje licencu od OCA payroll-a, koja je LGPL-3 na nivou `payroll/__manifest__.py` kao i originalni Odoo 14 CE `hr_payroll` iz kog je OCA forkan): [github.com/bringout/odoo-bringout-ba_payroll](https://github.com/bringout/odoo-bringout-ba_payroll)
- Demo orkestrator (4 kompanije + demo korisnici + stack grupe, AGPL-3): [github.com/bringout/odoo-bringout-multi_company_example_ba_hr_si_data](https://github.com/bringout/odoo-bringout-multi_company_example_ba_hr_si_data)
- Upstream OCA payroll (submodul, LGPL-3 na modul-nivou): [github.com/OCA/payroll](https://github.com/OCA/payroll)

## Napomena

Generisano od strane Claude 🤖
