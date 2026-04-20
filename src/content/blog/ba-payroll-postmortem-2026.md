---
title: 'Postmortem: dvije regresije u ba_payroll rename-generatoru'
description: 'Dva buga koja su se pojavila na multi-test.hodi.ba nakon što smo pokrenuli ba_payroll side-by-side sa OCA payroll-om — Owl duplicate-key na Settings stranici i ParseError za schedule_pay polje — i kako smo ih popravili u samom generatoru, ne u izlazu.'
pubDate: '2026-04-20T11:00:00'
heroImage: '/ba-payroll-hero.png'
---

## Uvod

U [prethodnom postu o ba_payroll / payroll side-by-side](/blog/payroll-i-ba-payroll-side-by-side-2026/) opisali smo rename-generator pristup: fork OCA payroll-a kroz `core_0/scripts/rename_oca_payroll.py` u paralelni `ba_payroll` modul sa `ba.` prefiksom, pa oba stacka koegzistiraju u istoj bazi. Posao je prošao na [multi-test.hodi.ba](https://multi-test.hodi.ba) — sve dok dva laten tbug-a nisu isplivala. Ovo je kratak postmortem.

## Bug 1 — OwlError: duplicate key in t-foreach

Otvaranje **Settings** stranice rušilo se sa:

```
OwlError: Got duplicate key in t-foreach: payroll
    at SettingsPage.template
```

Odoo-ova Settings stranica iterira `<div class="app_settings_block">` elemente i koristi `data-key` kao `t-key` u `t-foreach`. Obje komponente — OCA `payroll` i generisani `ba_payroll` — imale su `data-key="payroll"`. Generator nije prepoznavao ovaj atribut kao *module name reference* (nema `.xmlid` sufiks).

Fix u [`core_0@94bb56a`](https://github.com/bringout/core_0/commit/94bb56a): dodati su regex-i koji prepisuju `data-key="<module_from>"` → `data-key="<module_to>"` i `{'module': 'payroll'}` u context ekspresiji iste datoteke:

```python
pat_data_key = re.compile(
    rf'(\bdata-key\s*=\s*)(["\'])({re.escape(module_from)})(\2)'
)
pat_context_module = re.compile(
    rf"(['\"]module['\"]\s*:\s*)(['\"]){re.escape(module_from)}(\2)"
)
```

## Bug 2 — ParseError: Field "schedule_pay" does not exist in model "hr.contract"

Prvi re-install nakon rednev fix-a je pao na:

```
ParseError: while parsing ba_payroll/views/hr_contract_views.xml:3
Field "schedule_pay" does not exist in model "hr.contract"
```

Uzrok: generator se pokreće sa `--drop-extensions` koji izbacuje `models/hr_contract.py` (jer bi ekstenzija core `hr.contract` modela sudarala sa samom OCA payroll-om). Ali **XML view fileove koji su bili proste ekstenzije istog modela** nismo izbacivali — `views/hr_contract_views.xml` još xpath-ira u core hr_contract formu i referencira `schedule_pay` polje koje je drop-ovani Python model trebao dodati.

Na prvoj instalaciji je "radilo" samo slučajnošću — Odoo-ov dependency graph je processirao OCA `payroll` prije `ba_payroll`-a, pa je polje bilo u registru u trenutku učitavanja. Na re-init, redoslijed se prevrtao.

Fix u [`odoo-bringout-ba_payroll@56b8c7d`](https://github.com/bringout/odoo-bringout-ba_payroll/commit/56b8c7d) + generator: nova funkcija `discover_extension_views()` prepoznaje XML fileove čiji **svi** `<record model="ir.ui.view">` (a) ciljaju drop-ovani model, i (b) `inherit_id` pokazuje na ne-owned core view. Takvi se izbacuju, a `patch_manifest()` ih ukloni iz `data: [...]` liste. Drop-ovano je 6 fileova (3 `.py` + 3 `.xml`), manifest pročišćen, install prolazi deterministički bez obzira na load order.

## Zaključak

Oba fix-a žive isključivo u **generatoru** — izlazni modul nije hand-edit-ovan. Ova disciplina ("nikad ne uređuj izlaz") znači da svaka buduća OCA payroll verzija prolazi kroz istu obradu i oba patch-a se automatski prim enjuju.

## Napomena

Generisano od strane Claude 🤖

---

Ernad Husremović, hernad@bring.out.ba
