---
title: 'Premještanje Odoo instance između libvirt virtualki uz djeljeni Patroni: bringout-test19 sa hodi-1 na hodi-2'
description: 'Shared-database topologija svodi VM-to-VM move na tri dijelna pomaka: filestore, hodi-odoo unit definicija, nginx upstream IP. Post pokriva 12-korakni Python skript koji automatizuje move kroz colmena apply, dvije usputne nixpkgs-unstable regresije (sphinx 9.1 ispustio Python 3.11 → ofxparse → pkgs.odoo19; npm-deps hash drift u euro-office) i njihove durable fix-ove.'
pubDate: '2026-04-30T13:00:00'
heroImage: '/odoo-vm-move-hero.svg'
---

## Postavka

`hodi-1` i `hodi-2` su libvirt KVM gosti na hetzner-fleet hostu. `hodi-1` (192.*.*.11) drži većinu Odoo instanci; `hodi-2` (192.*.*.12) je do sad nosio samo Euro-Office document server. Cilj: premjestiti `bringout-test19` (Odoo 19, port 8130) sa `hodi-1` na `hodi-2`, uz `https://bringout-test19.hodi.ba` koji ostaje 200 čim cutover završi.

Topologija pomaže: svaka `hodi-odoo.instances.<name>` evaluira `dbHost = "192.*.*.100"` po default-u — Patroni VIP. Database `hodi-bringout-test19` živi na klasteru node62/63/64/65 i **ne pomjera se**. Move se svodi na tri stvari:

1. **Filestore** (`/var/lib/hodi-bringout-test19/`) — per-host filesystem, mora se rsync-ati.
2. **Service definicija** — blok `hodi-odoo.instances.bringout-test19 = { … }` migrira iz `hosts/hetzner/hodi-1/default.nix` u `hosts/hetzner/hodi-2/default.nix`.
3. **Reverse-proxy upstream** — `virtualHosts."bringout-test19.hodi.ba"` u `services/hetzner/reverse-proxy-hetzner/default.nix` mijenja `192.*.*.11:8130` u `192.*.*.12:8130`.

Nikakve secrets ne migriraju — `dbPassword = "odoo"` je hard-coded u hive, ACME runa samo na router-7, OAuth client-secret-i ne postoje za ovu instancu.

## Skript: `hodi_odoo_move_instance.py`

12 koraka, idempotentni dry-run mode, konzervativan redoslijed da minimizira prozor 502-ica.

```text
1. extract instance block iz src default.nix (regex match po imenu)
2. inject u dst default.nix; dodaj `imports` modula ako fali
   — rewrite reverse-proxy IP za vhost <name>.hodi.ba
3. git add + commit + push (deploy script radi `git pull` na hetzner-1)
4. ssh src "systemctl stop hodi-odoo-<name>"  ← prazan filestore za rsync
5. colmena apply --on dst                      ← kreira hodi-<name> usera + service
6. ssh dst "systemctl stop hodi-odoo-<name>"   ← kratko zaustavi prije sync
7. rsync /var/lib/hodi-<name>/ src → dst preko hetzner-1 staginga
                                                (oba VM-a su iza istog hyperviser-a;
                                                 nema direktnog SSH-a src↔dst)
8. ssh dst "chown -R hodi-<name>:hodi-<name>"  ← uid/gid alociraju se po hostu,
                                                 rsync ide --no-owner --no-group
9. ssh dst "systemctl restart hodi-odoo-<name>"
10. colmena apply --on router-7                 ← nginx upstream cutover
11. remove instance iz src default.nix; commit + push; colmena apply --on src
12. curl -I https://<name>.hodi.ba/web/login
```

Tri implementacijska detalja:

**Filestore traffic preko staginga.** Oba VM-a su libvirt gosti iza `hetzner-1`; ne postoji direktni SSH path src↔dst. Rsync stage-uje na `/tmp/hodi-move-<name>-<ts>/` na hetzner-1, pa od tamo na dst.

**Ownership reset poslije rsync-a.** `hodi-<name>` system user kreira ga `hodi-odoo` modul pri activation-u — uid je dinamički, ne podudara se između hostova. Rsync ide `--no-owner --no-group`, pa eksplicitni `chown` poslije.

**Idempotentno editovanje nix-a.** Instance block extrakt-uje regex `^[ \t]*<name>\s*=\s*\{ … \1\};\s*\n` (multiline) — match-uje cijeli blok do balansiranog zatvarača. `add_instance_to_dst` hvata sintaksu `hodi-odoo.instances = { … };` i ubacuje blok prije closing `};` na lokaciji `hodi-odoo.instances`.

## Dvije nixpkgs-unstable regresije usput

`hive.nix` pin-uje različite nixpkgs verzije po hostu:

```nix
meta = {
  nixpkgs = (import ./nixpkgs-25.05);
  nodeNixpkgs = {
    node61   = (import ./nixpkgs-25.11);
    hodi-1   = (import ./nixpkgs-25.11);
    hodi-2   = (import ./nixpkgs-unstable);
  };
};
```

Prvi pokušaj `colmena apply --on hodi-2` puca u koraku 5:

```
error: sphinx-9.1.0 not supported for interpreter python3.11
… while calculating requiredPythonModules for python3.11-ofxparse-0.21
```

Sphinx je u unstable-u skočio na 9.1, koja je dropp-ala Python 3.11. `ofxparse` (Odoo dep) povlači sphinx za doc build; build pada. Na `hodi-1` se ne primjećuje jer je već-build-ani systemd unit u /nix/store i nikad nije re-evaluiran.

Quick fix bi bio override-ati `ofxparse` (drop sphinx), ali sutra će neki drugi paket razbiti drugu stvar u unstable-u. Trajno rješenje: `pkgs.odoo19` evaluira protiv internog pinned nixpkgs-25.11, neovisno od host-ovog izbora:

```nix
{pkgs, ...}:

let
  pkgs' = (import ../../../nixpkgs-25.11) {
    system = pkgs.system;
    config.allowUnfree = true;
  };

  python = pkgs'.python311.withPackages (ps: with ps; [
    babel chardet ... ofxparse passlib ...
  ]);
  …
in
pkgs'.symlinkJoin { … }
```

Kompletni stdenv, python set i derivation helpers idu kroz `pkgs'`. Host-ova nixpkgs ostaje autoritativna za sve ostalo (kernel, systemd, nginx, …); samo Odoo derivation je insulated. Isti tretman dobio je i `pkgs.odoo-bosnian` (Odoo 16). Sad svaki host u flotu može build-ati i v16 i v19 identično — switch instance između hostova je glatka operacija bez obzira na host-ov nixpkgs pin.

Drugi pokušaj puca na drugom mjestu, takođe na hodi-2:

```
error: hash mismatch in fixed-output derivation
       'euro-office-web-apps-npm-deps.drv':
   specified: sha256-NFkSzD094NO9gB24ZYg9OMgKzzSNipy9htnwRvHrAVc=
      got:    sha256-9Q5n3IfigT8hXgkRhpEuvIhPS/7q2zL3zEbY3zaUCJw=
```

Prevencija je ista priča (pin-aj nixpkgs internno za euro-office), ali ovo nije bio uzrok pada — uzrok je da je upstream npm bumpao, isti `package-lock.json` rezolvira u drugačiji `node_modules` tree. Refresh `outputHash`-a na novu vrijednost rješava neposredno; trajno fixanje je odvojen task.

Commit + push, pa retry colmena apply hodi-2 — prolazi.

## Cutover

Kad `colmena apply --on hodi-2` prođe, oba hosta vide isti Patroni database — hodi-1 sa starim systemd unit-om, hodi-2 sa novim. Ako oba krenu cron-ove istovremeno, dvostruko procesiranje. Prozor mora biti kratak:

```bash
ssh hodi-1 "systemctl stop hodi-odoo-bringout-test19"
ssh hodi-2 "systemctl stop hodi-odoo-bringout-test19"
ssh hetzner-1 'set -euo pipefail
  STAGING=/tmp/hodi-move-bringout-test19-$(date +%s)
  mkdir -p $STAGING
  rsync -a --delete --no-owner --no-group hodi-1:/var/lib/hodi-bringout-test19/ $STAGING/
  rsync -a --delete --no-owner --no-group $STAGING/ hodi-2:/var/lib/hodi-bringout-test19/
  rm -rf $STAGING'
ssh hodi-2 "chown -R hodi-bringout-test19:hodi-bringout-test19 /var/lib/hodi-bringout-test19/"
ssh hodi-2 "systemctl restart hodi-odoo-bringout-test19"
```

Filestore na produkciji: 432 KB stvarnog data — pisanje je minute, ne sati. Onda `colmena apply --on router-7` mijenja nginx upstream sa `http://192.*.*.11:8130` na `http://192.*.*.12:8130`. Reload nginx-a je atomski (test new config + signal old workers); klijenti dobijaju 200 nakon prve nove konekcije.

Final: ukloni blok iz `hodi-1` default.nix-a, commit + push, `colmena apply --on hodi-1`. Systemd unit nestaje sa hodi-1.

## Stanje poslije

| Provjera | Rezultat |
|----------|----------|
| `hodi-odoo-bringout-test19.service` na hodi-1 | uklonjeno (0 unit fajlova) |
| `hodi-odoo-bringout-test19.service` na hodi-2 | active |
| Filestore na hodi-2 | populiran |
| Patroni `hodi-bringout-test19` database | netaknut |
| `https://bringout-test19.hodi.ba/web/login` | HTTP 200 |

Skript je ostao kao reusable alat — sljedeći move (npr. `multi-test → hodi-2`) je jedna komanda:

```bash
python3 scripts/hodi_odoo_move_instance.py \
    --instance multi-test --from hodi-1 --to hodi-2
```

— uz `--dry-run` za preview kompletnog plana bez ijedne mutacije.

## Šta je naučeno

- Shared-database arhitektura (Patroni VIP) je multi-host konsolidaciju trivijalizovala — move je samo **filestore + nix konfig**.
- Different-nixpkgs-per-host kombinacija je legitimna, ali zahtijeva da kompleksniji custom paketi (Odoo, OnlyOffice, …) imaju **interno pinovan nixpkgs** — inače upstream regresije u unstable-u (sphinx 9.1, npm bumpovi) ruše build na svakom apply-u.
- Skripta sa explicit `--dry-run` mode-om je nepoznata vrijednost — prvi run pokaže tačno koje fajlove bi pisao, koje SSH komande bi pokrenuo, redoslijed colmena apply-ova; ručno re-igranje plana pred prvim live runom hvata 80 % potencijalnih problema.

## Napomena

Generisano od strane Claude 🤖

---

Ernad Husremović, hernad@bring.out.ba
