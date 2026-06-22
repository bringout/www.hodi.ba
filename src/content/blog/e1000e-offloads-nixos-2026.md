---
title: 'Onemogućavanje e1000e offload-a u NixOS konfiguraciji kao workaround za Hardware Unit Hang'
description: 'Kako smo riješili Intel e1000e Hardware Unit Hang bug onemogućavanjem TSO/GSO/GRO offload funkcija kroz systemd oneshot servis u NixOS konfiguraciji'
pubDate: '2026-04-11T15:00:00'
heroImage: '/e1000e-fix-hero.svg'
---

Ovaj post je nastavak [incident reporta od 11. aprila 2026.](/blog/incident-report-nic-hang-2026/) gdje smo opisali kako je Intel e1000e NIC driver spontano otkazao na našem glavnom fizičkom serveru nakon 130 dana uptime-a. Ovdje se fokusiramo na konkretan fix — jednostavan workaround koji se može ugraditi u NixOS konfiguraciju i koji svaki sljedeći boot primjenjuje automatski.

## Problem u jednoj rečenici

Intel `e1000e` driver periodično zaglavljuje transmit queue u onboard NIC-u (chipset iz 82579/I217/I218 porodice), ulazi u `Detected Hardware Unit Hang` stanje, i nema pouzdan mehanizam oporavka osim reboota. Bug je poznat više od decenije i postoji na svim Linux kernelima koje smo probali.

## Zašto onemogućavanje offload-a pomaže

Moderni Intel NIC-ovi podržavaju hardverske offload funkcije koje rasterećuju CPU:

- **TSO** (TCP Segmentation Offload) — NIC sam dijeli velike TCP pakete na MTU-veličine segmente
- **GSO** (Generic Segmentation Offload) — kernel šalje velike pakete dolje, NIC ih dijeli
- **GRO** (Generic Receive Offload) — NIC spaja primljene pakete prije nego ih prosljeđuje kernelu

U slučaju e1000e Hardware Unit Hang bug-a, problematična putanja u driveru vezana je upravo uz TSO/GSO code path-ove. Kada se ove funkcije isključe, kernel radi segmentaciju u softveru — CPU se malo dodatno opterećuje, ali se **hang code path u driveru nikada ne aktivira**. Ovo je standardni workaround iz zajednice i pominje se u više bug report-a za e1000e na LKML i Red Hat Bugzilli.

Kompromis koji plaćamo je ~5% viši CPU pri punom gigabit throughput-u — potpuno zanemarivo na modernom serveru, pogotovo jer mi i inače ne saturiramo gigabit link.

## Runtime validacija prije nego što upadne u konfiguraciju

Prije nego što smo upisali fix u NixOS konfiguraciju, htjeli smo biti sigurni da promjena ne razbija ništa. `ethtool -K` se može primijeniti live, dok se interface ne mora spuštati:

```bash
ethtool -K eno1 tso off gso off gro off
```

Proveli smo niz testova odmah nakon primjene:

| Test | Rezultat |
|---|---|
| Existing SSH session preživio? | Da — session kroz koji smo poslali komandu ostao aktivan |
| IPv4 ping ka 8.8.8.8 | 4/4 paketa, 1.10 ms |
| IPv6 ping ka 2001:4860:4860::8888 | 4/4 paketa, 1.17 ms |
| HTTPS ka cache.nixos.org | 200 OK u 89 ms |
| Cloudflare 50 MB bulk download | 52.428.800 bytes u 0.83 s → **506 Mbps** |
| `ethtool -S eno1` error brojači prije | svi 0 osim `tx_dropped: 4` (postojeće) |
| `ethtool -S eno1` error brojači poslije | **identični** — nijedan novi error |

Ključno: `tx_timeout_count`, `tx_restart_queue`, i `tx_hang` brojači — tačno ovi brojači koje e1000e driver inkrementira kada mora reset-ovati queue zbog hang stanja — ostali su na **0** i prije i poslije 50 MB bulk download-a. Taj test dokazuje da softverska segmentacija uredno nosi real-world TCP promet pri pola gigabita per second-a, bez ijednog triggeranja hang code path-a.

## NixOS systemd oneshot servis

Nakon što smo verifikovali da runtime promjena funkcioniše, ugradili smo je u NixOS konfiguraciju kao systemd oneshot servis koji se pokreće na svaki boot čim interfejs postoji:

```nix
# Workaround for Intel e1000e "Detected Hardware Unit Hang" on eno1
# (bus 0000:00:1f.6, firmware 0.5-4).
#
# Turning off TSO/GSO/GRO makes the kernel do TCP segmentation and
# receive coalescing in software instead of offloading to the NIC,
# which avoids the well-documented hang codepath in the e1000e
# driver.
systemd.services.ethtool-eno1-offloads = {
  description = "Disable e1000e offloads on eno1 (Hardware Unit Hang workaround)";
  wantedBy = [ "multi-user.target" ];
  after = [ "sys-subsystem-net-devices-eno1.device" ];
  requires = [ "sys-subsystem-net-devices-eno1.device" ];
  serviceConfig = {
    Type = "oneshot";
    RemainAfterExit = true;
    ExecStart = "${pkgs.ethtool}/bin/ethtool -K eno1 tso off gso off gro off";
  };
};
```

Par detalja koji vrijede objašnjenja:

- `after = [ "sys-subsystem-net-devices-eno1.device" ]` — servis čeka da kernel stvori `eno1` uređaj prije nego što pokuša pozvati ethtool. Bez toga bismo imali race condition pri boot-u.
- `requires = [ ... ]` isto to — ali strože, ako uređaj ikad nestane, systemd će zaustaviti i ovaj servis.
- `Type = "oneshot"` sa `RemainAfterExit = true` — ethtool odradi svoj posao i zatvori se, ali sistem smatra jedinicu "aktivnom" dokle god se uređaj drži.
- `${pkgs.ethtool}/bin/ethtool` — NixOS-ova ljepota: referenca direktno na binary iz nix store-a, bez potrebe za globalnim PATH-om.

## Workflow deploy-a

Cijela promjena je deploy-ovana kroz test → switch workflow koji koristimo za sve izmjene kritičnih servera:

```bash
# 1. Edit konfiguracije
vim infra-hodi/hosts/hetzner/hetzner-1/default.nix

# 2. Commit + push
git add && git commit -m "fix(hetzner-1): disable e1000e offloads ..."
git push

# 3. Deploy u TEST modu — aktivira novi sistem, ali GRUB default ostaje stari
python3 scripts/deploy_infra-hodi_on_hetzner-1.py hetzner-1 test

# 4. Verifikacija
ssh hetzner-1 'systemctl status ethtool-eno1-offloads.service'
ssh hetzner-1 'ethtool -k eno1 | grep -E "tcp-segmentation|generic-"'

# 5. Ako sve OK — SWITCH mode, postavlja novi sistem kao default boot
python3 scripts/deploy_infra-hodi_on_hetzner-1.py hetzner-1 switch
```

Razlika između `test` i `switch`:

- **`test`** — novi sistem je aktivan sada, ali GRUB bootloader pokazuje na **stari** generation. Ako restart-ujete server, vraća se na staro stanje. Savršeno za validaciju promjena na živom sistemu.
- **`switch`** — novi sistem postaje default boot entry. Restart više ne vraća na staro.

Ovaj workflow je spasio nekoliko pogrešnih promjena u prošlosti — kada je nešto pošlo naopako u test modu, restart nas je vratio u poznato ispravno stanje bez ikakvih ručnih intervencija.

## Verifikacija nakon deploy-a

Odmah nakon switch-a, provjerili smo da je servis live i da postavke rade:

```
$ systemctl status ethtool-eno1-offloads.service
● ethtool-eno1-offloads.service - Disable e1000e offloads on eno1 (Hardware Unit Hang workaround)
   Loaded: loaded (/etc/systemd/system/ethtool-eno1-offloads.service; enabled)
   Active: active (exited) since Sat 2026-04-11 12:13:45 CEST
   ExecStart=/nix/store/pd20b5lz3ib30arpjs6b2xc45dablcfc-ethtool-6.14/bin/ethtool -K eno1 tso off gso off gro off (status=0/SUCCESS)

$ ethtool -k eno1 | grep -E '^(tcp|generic-)'
tcp-segmentation-offload: off
generic-segmentation-offload: off
generic-receive-offload: off

$ readlink /nix/var/nix/profiles/system
system-30-link   # novi generation je sada default boot entry
```

- Status je `active (exited)` — oneshot se završio, ali `RemainAfterExit` drži servis "up"
- Exit code 0 — ethtool je uspješno primijenio promjene
- `/nix/var/nix/profiles/system` pokazuje na novi generation — ovo je garancija da će i restart zadržati postavke

## Šta dalje

Kraći rok:
- **Monitoring** — `journalctl -k --since yesterday | grep 'Hardware Unit Hang'` jednom sedmično treba biti prazan
- **Ako se hang vrati usprkos workaround-u** — tada je problem vjerojatno u firmware-u (verzija `0.5-4` je stara, Intel je objavio novije), pa je sljedeći korak nadogradnja NIC firmware-a. To je deeper intervention koja zahtijeva Hetzner support ticket ili fizički pristup serveru.

Duži rok:
- Ako se bug ikad vrati i uprkos firmware upgrade-u, sljedeći korak je zamijena NIC-a sa Intel X550-ovim ili nekim drugim čipsetom koji ne koristi e1000e driver
- U teoretskom slučaju, mogli bismo i prebaciti disk backend-e (nbd) sa mrežnog stack-a na unix socket-e, ali to bi zahtijevalo refaktor libvirt konfiguracije koji trenutno nije opravdan

## Zaključak

Dobar NixOS fix je onaj koji:

1. **Postoji kao kod, ne kao ručna komanda** — ethtool komanda nije ostala u nečijoj shell history, nego je ugrađena u konfiguraciju i izvršava se automatski na svaki boot
2. **Je reproducibilan** — svako ko ima pristup repo-u može pogledati šta se mijenja, zašto, i kako je testirano (komentari u nix fajlu opisuju cijeli incident)
3. **Može se rollback-ovati jednim reboot-om u test modu** — prije nego postane trajan
4. **Ima merljivu validaciju** — 506 Mbps download, zero error drift, eksplicitni before/after brojači

Naš commit u `infra-hodi` repozitoriju uključuje komentar od 20+ linija koji opisuje cijeli incident, razlog za fix, kompromis, i način validacije. Budući maintainer (možda i mi sami za 6 mjeseci) će imati kompletan kontekst bez potrebe da rekonstruira šta se desilo.

## Napomena

Generisano od strane Claude 🤖

---

Ernad Husremović, hernad@bring.out.ba
