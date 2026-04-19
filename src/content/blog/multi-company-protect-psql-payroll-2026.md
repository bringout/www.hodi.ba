---
title: 'PostgreSQL Row-Level Security za zaštitu plata u Odoo multi-company instalaciji'
description: 'Kako smo napravili odbrambeni sloj na PostgreSQL nivou koji garantuje da operator obračuna plata ne može čitati ni upisivati redove drugih kompanija — čak i kad Odoo record rules zakažu.'
pubDate: '2026-04-19T18:30:00'
heroImage: '/rls-payroll-hero.svg'
---

Multi-company Odoo setup izgleda jednostavno dok ne postavite ozbiljno pitanje: **šta ako operator obračuna plata u Bosni slučajno (ili ciljano) vidi plate slovenačkih ili hrvatskih zaposlenika?** Odoo-ve record rules su primarna zaštita — ali to je **samo jedan sloj**, i otkazuje tiho kad neki custom modul, loša konfiguracija ili direktni SQL zaobiđu ORM.

Napravili smo [`multi_company_protect_psql_payroll`](https://github.com/bringout/odoo-bringout-multi_company_protect_psql_payroll) — Odoo 16 modul koji dodaje **PostgreSQL Row-Level Security** kao drugu liniju odbrane, ali **samo za korisnike koji su eksplicitno zaključani na jednu kompaniju**. Live demo radi na [multi-test.hodi.ba](https://multi-test.hodi.ba) sa 4 kompanije u 3 zemlje.

## Zašto ORM-only zaštita nije dovoljna

Odoo multi-company odvaja poslovne podatke po kompaniji preko `company_id` kolone + record rules + `check_company` ORM helpera. Sve to **radi dobro** u najviše slučajeva. Ali:

- Record rule može biti **pogrešno napisana** (npr. domena bez `company_id`) — i to se ne primijeti dok neko slučajno ne vidi tuđi red.
- Custom modul može pisati **raw SQL** preko `self.env.cr.execute(...)` koji u potpunosti zaobilazi record rules.
- Novi modul može **dodati novi model** bez ispravne multi-company domene — pa je sve share-ovano prema default-u.
- Pri migracijama i `odoo -u` prolaze se code paths koji normalne rules privremeno ignorišu.

Za običnog korisnika iz prodaje to je rijetko problem — ionako treba unakrsni pregled preko kompanija. Za **operatora obračuna plata** u jednoj zemlji, svaka mogućnost da vidi plate drugih zemalja je **neprihvatljiva**. Plate su politički, pravno i ljudski osjetljive.

## "Light" model — samo zaključani korisnici idu kroz RLS

Odlučili smo se za **selektivni model** (interno ga zovemo "Model B"):

1. **Default ponašanje baze:** RLS je "uključen" na zaštićenim tabelama, ali policy propušta **sve redove** dok je session varijabla `app.rls_bypass = 'on'`. To je database-wide default, tako da `odoo -u`, admin, cron, sale users i svi ostali rade kao i inače.
2. **Zaključani korisnici:** `res.users.psql_company_lock_id` je novi many2one polje koje admin postavlja na jednu kompaniju. Kad se takav korisnik loguje, `ir.http` hook na početku svakog request-a izvršava:

   ```sql
   SET LOCAL ROLE odoo_rls_user;
   SET LOCAL app.rls_bypass = 'off';
   SET LOCAL app.allowed_company_ids = '<id zaključane kompanije>';
   ```

3. Policy tada stupa na snagu **samo za tu transakciju** i propušta redove samo iz dozvoljene kompanije.

Ostatak instalacije — deljeni proizvodi, deljeni partneri, Odoo record rules za ostale korisnike — radi **nepromijenjeno**.

## Šta se konkretno štiti

Allowlist od 9 tabela koje su **stvarno** vlasništvo jedne kompanije:

| Tabela | Link na kompaniju |
| --- | --- |
| `hr_employee` | direktni `company_id` |
| `hr_contract` | direktni `company_id` |
| `hr_leave` | `employee_company_id` |
| `hr_leave_allocation` | `employee_company_id` |
| `hr_payslip` | direktni `company_id` |
| `hr_payslip_run` | direktni `company_id` |
| `hr_payslip_line` | preko `slip_id → hr_payslip` |
| `hr_payslip_input` | preko `payslip_id → hr_payslip` |
| `hr_payslip_worked_days` | preko `payslip_id → hr_payslip` |

**Izričito nije pod RLS:**

- `res.partner` — koristi `company_dependent` polja u JSONB-u, što znači da je **jedan** red ponekad namjenski podijeljen između više kompanija. RLS na nivou reda tu nije primjenjiv.
- `product.template`, `product.product` — deljeni master-data koji se namjenski koristi između kompanija.
- Računovodstvene transakcije (`account.move`, `account.move.line`) — zasad ne; potencijalna iduća iteracija za lokalne knjigovođe.

## PostgreSQL SUPERUSER gotcha

Jedan zanimljiv detalj koji smo morali riješiti: na našem NixOS + Patroni setupu Odoo se konektuje kao **SUPERUSER**. A PostgreSQL SUPERUSER **uvijek zaobilazi RLS** — čak i kad je `FORCE ROW LEVEL SECURITY` uključen. Policy je bila ispravno instalirana, funkcije su vraćale ispravne boolean vrijednosti, ali enforcement se nije događao.

Rješenje: modul na `post_init_hook`-u kreira dedicirani `odoo_rls_user` role (`NOLOGIN NOSUPERUSER NOBYPASSRLS`) i `GRANT`-uje ga Odoo-vom korisniku. Kad se zaključani korisnik loguje, `ir.http` hook izvršava `SET LOCAL ROLE odoo_rls_user` **prije** session varijabli. Taj role ima iste table-level privilegije kao matični Odoo korisnik (pristup svim tabelama u `public` schemi, uključujući buduće tabele preko `ALTER DEFAULT PRIVILEGES`), ali **nije SUPERUSER**, pa RLS konačno stupa na snagu.

`SET LOCAL ROLE` je scoped na transakciju — resetuje se na `COMMIT`/`ROLLBACK`. Zato se svaki request vraća u neutralno stanje.

## Live demo

[multi-test.hodi.ba](https://multi-test.hodi.ba) je dedicirani Odoo 16 test bed za ovu priču, sa 4 kompanije koje simuliraju realističnu multi-entity postavku u regiji:

| Kompanija | Zemlja | Valuta | Chart of accounts |
| --- | --- | --- | --- |
| CompanySL-1 | Slovenija | EUR | minimalni SI demo (DDV 22/9.5/5/0) |
| CompanyHR-1 | Hrvatska | EUR | minimalni HR demo (PDV 25/13/5/0) |
| CompanyHR-2 | Hrvatska | EUR | minimalni HR demo |
| CompanyBA-1 | BiH | BAM | `l10n_ba_fbih_data` |

Demo korisnici pokazuju različite scenarije:

**Zaključani (RLS enforced) — jedan payroll clerk po zemlji:**

- **`demo.payroll.ba@hodi.ba`** — bosanski operator obračuna plata, `psql_company_lock_id = CompanyBA-1`.
- **`demo.payroll.hr@hodi.ba`** — hrvatski operator obračuna plata, `psql_company_lock_id = CompanyHR-1`.
- **`demo.payroll.si@hodi.ba`** — slovenački operator obračuna plata, `psql_company_lock_id = CompanySL-1`.

**Nezaključani (normalan multi-company pristup):**

- **`demo.manager.hr@hodi.ba`** — hrvatski HR manager sa pristupom obje hrvatske kompanije (CompanyHR-1 i CompanyHR-2), **bez** PSQL lock-a.
- **`demo.group.admin@hodi.ba`** — grupni admin preko sve 4 kompanije.

Svi sa passwordom `demo1234` (sandbox, dev-only — ne koristiti nigdje drugdje).

Ulogujte li se kao `demo.payroll.si@hodi.ba` i odete na HR → Employees, vidite **samo** 2 slovenačka zaposlenika (Janez Novak, Ana Kovač). Slovenski clerk nikada ne vidi bosanske, hrvatske, niti podatke default kompanije — čak i ako neko pokuša forsirati `company_id` kroz URL ili RPC, PostgreSQL odbija red prije nego što stigne do ORM-a. Isto vrijedi za HR i BA payroll clerke na svojim kompanijama.

### Provjera enforcement-a

Direktno iz PostgreSQL-a:

```sql
-- Bosanski payroll clerk (zaključan na kompaniju 5)
BEGIN;
SET LOCAL ROLE odoo_rls_user;
SET LOCAL app.rls_bypass = 'off';
SET LOCAL app.allowed_company_ids = '5';
SELECT company_id, count(*) FROM hr_employee GROUP BY company_id;
-- rezultat: 5 | 3   (samo bosanski zaposlenici, ostali nevidljivi)
SELECT count(*) FROM product_template;
-- rezultat: 18      (svi dijeljeni proizvodi, RLS ih ne dira)
ROLLBACK;
```

Za usporedbu, default admin session (bez `SET ROLE`):

```sql
SELECT company_id, count(*) FROM hr_employee GROUP BY company_id;
-- 1 | 1
-- 2 | 2   (Slovenija)
-- 3 | 2   (Hrvatska 1)
-- 4 | 2   (Hrvatska 2)
-- 5 | 3   (Bosna)
```

Isti ORM, ista tabela, ista baza — ali **različit PostgreSQL role** i **različita session konfiguracija**. Fizička separacija na nivou reda, ne samo na nivou filtera upita.

## Demo uživo — reprodukcija multi-company bugova

Da bi se zaštita vidjela i **bez otvaranja PostgreSQL konzole**, napravili smo prateći modul [`bringout_payroll_timesheet_bug_test`](https://github.com/bringout/odoo-bringout-payroll_timesheet_bug_test). Riječ je o **namjerno pogrešnom** wizardu koji reprodukuje dva klasična multi-company bug-a:

- **Bug A (čitanje):** `env['hr.employee'].sudo().search([])` bez filtera po kompaniji — neko pravi dashboard koji broji zaposlene, ali zaboravi `company_id` filter.
- **Bug B (pisanje):** `env['account.analytic.line'].sudo().search([]).write({'name': tag})` — "označi sve timesheete kao pregledane" rutina bez company filtera.

Oba bug-a koriste `sudo()` — što je legitiman Odoo mehanizam koji **zaobilazi record rules**. Aplikacijski sloj zaštite tu otkazuje. Samo PostgreSQL RLS preostaje kao odbrana.

### Bug A — ista ruta, dva rezultata

Kad **admin** (bez `psql_company_lock_id`) pokrene Bug A wizard, dobija ukupan broj zaposlenih preko **svih** kompanija. Bug se manifestuje — dashboard "nehotice" otkriva podatke iz svih entiteta:

![Bug A pokrenut kao Demo Group Admin — broji 10 zaposlenih preko svih kompanija](/rls-bug-a-admin.png)

Isti kod, ista linija, pokrenuta kao **zaključani hrvatski payroll clerk** (`demo.payroll.hr@hodi.ba`, `psql_company_lock_id = CompanyHR-1`) vraća **samo 2** — zaposlene svoje kompanije. RLS je presreo `SELECT` na SQL nivou i filtrirao ga na jednu kompaniju, bez ikakvog signala aplikacijskom kodu da se nešto dogodilo:

![Bug A pokrenut kao zaključani hrvatski clerk — vidi samo 2 svoja zaposlena](/rls-bug-a-locked-hr.png)

Isti bug, ista `.sudo().search([])` linija, isti Odoo ORM — **različit ishod** jer PostgreSQL RLS stoji pred bazom. Bug A je "dobar" bug za prikaz jer je **neinvazivan** — ništa se ne mijenja, samo se broje redovi.

### Bug B — vidljivi trag u Timesheets listi

Bug B piše tekst `BUG-B run by <user name>` u `name` polje svake timesheet zapisa. To je polje koje Odoo prikazuje kao **Description** u Timesheets listi, pa je efekat bug-a odmah vidljiv u UI-u.

Kad admin (koji vidi sve 4 kompanije) pokrene Bug B, **svi** timesheet zapisi u bazi dobiju svoj description prepisan. Pollution prelazi granice kompanija:

![Bug B pokrenut kao Demo Group Admin — timesheet u CompanyBA-1 sa admin-ovim tagom](/rls-bug-b-admin-timesheets.png)

Kad zaključani hrvatski clerk pokrene **isti** wizard, samo **njegovi** (CompanyHR-1) timesheeti dobiju tag. Ostale kompanije ostaju netaknute — RLS ih je zaštitio prije nego što je `UPDATE` statement imao šansu da dohvati te redove:

![Bug B pokrenut kao hrvatski clerk — samo 2 hrvatska timesheeta označena sa njegovim tagom](/rls-bug-b-locked-hr-timesheets.png)

Broj "Lines affected" koji wizard prikazuje je direktan indikator koliko je bug probio. Kod admina — dosta. Kod zaključanog clerka — tačno onoliko koliko treba.

## Šta ovim modelom dobijate

- **Operator plata ne može vidjeti plate u drugoj zemlji.** Garancija dolazi sa PostgreSQL-ovog nivoa, ne sa aplikacijske domene.
- **Ostali korisnici rade nepromijenjeno.** Sales, purchase, warehouse — nemaju `psql_company_lock_id` postavljen, pa hook ne pokreće `SET ROLE`, baza im je bypass-on, RLS spava. Dijeljeni proizvodi i partneri su i dalje dijeljeni.
- **Upgrade-ovi su sigurni.** `odoo -u` prolazi kao Odoo superuser sa bypass-on; migracije ne ulaze u RLS tok.
- **Audit** — `pg_policies`, `pg_class.relrowsecurity` i `pg_class.relforcerowsecurity` daju jasan DBA view protekcije. Nema "skrivene" zaštite u aplikacijskoj logici.

Šta **ne dobijate**: ovo **nije** zamjena za Odoo record rules i `check_company`. RLS je drugi sloj za specifičnu klasu korisnika, ne prvi. Multi-company bugovi koji utiču na administratore ili user types bez `psql_company_lock_id`-a i dalje su problem aplikacijske domene.

## Izvorni kod i licenca

- Glavni modul: [github.com/bringout/odoo-bringout-multi_company_protect_psql_payroll](https://github.com/bringout/odoo-bringout-multi_company_protect_psql_payroll)
- Test bed orkestrator (4 kompanije + demo korisnici): [github.com/bringout/odoo-bringout-multi_company_example_ba_hr_si_data](https://github.com/bringout/odoo-bringout-multi_company_example_ba_hr_si_data)
- Demo bugova (reprodukuje Bug A i Bug B): [github.com/bringout/odoo-bringout-payroll_timesheet_bug_test](https://github.com/bringout/odoo-bringout-payroll_timesheet_bug_test)
- Minimalne demo lokalizacije: [l10n_si_demo](https://github.com/bringout/odoo-bringout-l10n_si_demo), [l10n_hr_demo](https://github.com/bringout/odoo-bringout-l10n_hr_demo)

## Naredni koraci

- **Proširenje allowlist-a** na računovodstvene transakcije (`account.move_line`) za zaključane lokalne knjigovođe — sa testovima za `property_account_*` polja koja u Odoo-u koriste `company_dependent` JSONB.
- **Audit tabela** — opcioni log svakog pokušaja pristupa redu koji je RLS odbio, za forenziku.
- **Per-installation opt-in u "strict mode"** (Model A iz naše interne dokumentacije) za klijente koji žele RLS kao primarni sloj, ne samo kao backstop.

Ako imate multi-company Odoo instalaciju i osjetljive payroll scenarije, slobodno kontaktirajte. Modul je napravljen tako da se može primijeniti na postojeće baze bez prekida rada — migration script na upgrade-u stvara role, policy-je i DB default-e idempotentno.

## Napomena

Generisano od strane Claude 🤖
