---
title: 'Incident report: otkazivanje mrežnog interfejsa na glavnom serveru (e1000e Hardware Unit Hang)'
description: 'Detaljan forenzički izvještaj o incidentu od 11. aprila 2026. kada je Intel e1000e NIC driver spontano otkazao nakon 130 dana uptime-a'
pubDate: '2026-04-11T14:00:00'
heroImage: '/incident-report-hero.svg'
---

Danas, 11. aprila 2026. godine, naš glavni fizički server (Hetzner dedicated, kernel 6.12.63, NixOS 25.05) doživio je kompletan gubitak mrežne konektivnosti koji je završio prinudnim restartom. Ovaj post opisuje šta se tačno desilo, kako smo to dijagnostikovali iz journal logova, i šta je bio stvarni uzrok. Kasnije u istoj sedmici objavljujemo dva popratna posta — jedan o [konkretnom fix-u za NixOS konfiguraciju](/blog/e1000e-offloads-nixos-2026.md/) i jedan o [fail2ban zaštiti](/blog/fail2ban-ssh-http-zastita-2026.md/) koju smo instalirali kao posljedicu ovog incidenta.

## Ukratko

- U 10:28:34 CEST Intel e1000e driver na `eno1` interfejsu prijavio je **Hardware Unit Hang** nakon 130 dana neprekidnog rada
- Kroz narednih ~78 minuta u kernel log je upisano **2.324 identičnih hang eventa**, ali driver se nije uspio oporaviti
- U 11:46 desio se kaskadni kvar: nbd2 (virtuelni disk VM-ova) → EXT4 journal abort → libvirt guest servisi → kernel smrznut
- U 11:47 smo ručno restartovali server
- Nije bio sigurnosni incident — radi se o poznatom bugu u Intel NIC driveru, ne o napadu

## Kronologija događaja

Sve vrijeme je lokalno (CEST = UTC+2).

| Vrijeme | Događaj |
|---|---|
| 10:28:34 | Prvi `e1000e ... eno1: Detected Hardware Unit Hang` u kernel logu |
| 10:28:36 | Drugi, pa treći, pa svakih ~2 sekunde novi hang event — driver pokušava reset ali ne uspijeva |
| 11:45:52 | `libvirt-guest-hodi-1.service: Failed with result 'exit-code'` — libvirtd više ne može upravljati VM-ovima |
| 11:45:53 | `.libvirtd-wrapp: Cannot recv data: Connection reset by peer` — kontrolni kanal prema VM-ovima izgubljen |
| 11:45:54 | Hang detekcije se nastavljaju, sada kao klaster svaka 2 sekunde |
| 11:46:01 | `I/O error, dev nbd2, sector 0 op 0x1:(WRITE)` — virtuelni disk VM-ova otkazuje |
| 11:46:01 | `JBD2: I/O error when updating journal superblock for nbd2p1-8` |
| 11:46:01 | `Aborting journal on device nbd2p1-8` — EXT4 journal prekinut, filesystem u nekonzistentnom stanju |
| 11:46:01 | `EXT4-fs (nbd2p1): I/O error while writing superblock` |
| 11:46:02 | **Posljednji upis u systemd journal** — kernel više ne može pisati logove |
| 11:47:36 | Manualni hard reset servera |
| 11:47:58 | Novi boot, svi servisi se dižu uredno |

## Šta je zapravo puklo

Intel `e1000e` driver za onboard gigabit NIC (chipset iz 82579/I217/I218 porodice, firmware verzija `0.5-4`, bus `0000:00:1f.6`) je dobro poznat po bugu koji se u kernel logu zove **"Detected Hardware Unit Hang"**. Hardverska TX queue se zaglavi, driver registruje tu situaciju i pokušava reset, ali reset ne uspije jer NIC kontroler više ne odgovara na PCI registre na očekivan način.

Kada driver detektuje hang, upisuje u log strukturirani blok sa TDH/TDT/next_to_use/next_to_clean pokazivačima i MAC/PHY statusima. Evo sirovog izvoda iz našeg kernel log-a:

```
Apr 11 11:45:54 kernel: e1000e 0000:00:1f.6 eno1: Detected Hardware Unit Hang:
                          TDH                  <a2>
                          TDT                  <ad>
                          next_to_use          <ad>
                          next_to_clean        <a1>
                        buffer_info[next_to_clean]:
                          time_stamp           <3a0682ba6>
                          next_to_watch        <a2>
                          jiffies              <3a0af0300>
                          next_to_watch.status <0>
                        MAC Status             <40080083>
                        PHY Status             <796d>
                        PHY 1000BASE-T Status  <3800>
                        PHY Extended Status    <3000>
                        PCI Status             <10>
```

Vrijednosti `TDH=a2` i `TDT=ad` pokazuju da je transmit descriptor head zaostao za transmit tail-om — queue je popunjena paketima koje NIC nikada nije uspio poslati. `next_to_watch.status = 0` znači da driver čeka completion interrupt koji više nikad ne stiže.

Ovaj bug se pojavljuje sporadično na Intel čipsetima iz PCH/LPC familije i postoji u kernelu već više od decenije. Postoji niz workaround-a koje zajednica primjenjuje, od kojih je najčešći **onemogućavanje hardverskih offload funkcija** (TSO, GSO, GRO) tako da sva segmentacija i coalescing pakete radi kernel u softver-u umjesto u hardver-u. Ovaj workaround je tema [narednog blog posta](/blog/e1000e-offloads-nixos-2026.md/).

## Kaskadni kvar — zašto je zastoj NIC-a srušio cijelu mašinu

Sama činjenica da NIC driver ne odgovara ne bi trebala biti dovoljna za potpuni pad servera. Ali u našem slučaju arhitektura je takva da je `nbd2` (Network Block Device, virtuelni disk jednog od VM guest-ova) koristio mrežni stack za komunikaciju sa svojim backend-om. Kada je mreža pala, nbd2 je odmah počeo prijavljivati I/O greške:

```
Apr 11 11:46:01 kernel: I/O error, dev nbd2, sector 0 op 0x1:(WRITE)
Apr 11 11:46:01 kernel: JBD2: I/O error when updating journal superblock for nbd2p1-8
Apr 11 11:46:01 kernel: Aborting journal on device nbd2p1-8
Apr 11 11:46:01 kernel: EXT4-fs (nbd2p1): I/O error while writing superblock
```

Kada EXT4 journal otkaže na uređaju koji koristi `libvirt-guests`, sam libvirtd ostaje "zamrznut" u sync-u i njegovi guest servisi padaju. Nakon toga, sam kernel nije mogao uredno pisati ni u vlastiti journal — zadnji upis koji smo pronašli u prethodnom boot-u je od `11:46:02`. Nakon te tačke, sistem se ponaša kao smrznut — sshd ne prima nove konekcije, ping ne dolazi natrag, ali se CPU ne zaustavlja, samo kernel ne može ništa korisno raditi jer mu je filesystem state nekonzistentan.

## Kako smo to zatvorili

Jer server fizički ima pristupe preko Hetzner konzole, nismo morali čekati na automatski reset niti dodatne skripte — ručno smo poslali hard reset kroz kontrolni panel, server je podigao fsck na boot-u (EXT4 journal je replay-ovao nbd2p1 uspješno), i svi servisi su se uredno digli u 11:47:58.

Za razliku od standardnog "graceful reboot" scenarija, gdje bi libvirt uredno stopirao VM-ove i sačuvao njihovo stanje — u ovom slučaju VM-ovi su efektivno doživjeli hard power loss. Međutim, sami guest sistemi imaju vlastite journal-e, pa je recovery na njihovoj strani prošao bez problema.

## Šta je radila provjera fair-play

Kao dio forenzičke analize, provjerili smo je li incident mogao biti posljedica eksternog napada — pogotovo kroz neki od naših javnih servisa. Spojili smo timestamp-ove u iz nginx access log-a sa timestamp-ovima iz kernel log-a, i zaključili:

- U 30 minuta prije prvog hang eventa, ukupan HTTP saobraćaj ka našim javnim servisima iznosio je **oko 0,24 zahtjeva u sekundi** — dakle trivijalno opterećenje, daleko ispod kapaciteta i jedne desetine gigabitnog linka
- Nije bilo nikakvih authentication incidenta, failed login pattern-a, ili anomalnih paketa u tom periodu
- Pronašli smo scanner aktivnost (probe za `/.env`, `/.git/config`, `/wp-config.php` itd.) iz botnet /24 mreža — ali sve je vraćalo 404, nijedan scan nije uspio ništa dobiti, i scan se desio **77 minuta prije prvog hang eventa**, daleko izvan ikakve kauzalne veze
- Najvažnije: scanner traffic koji smo pronašli ni približno nije dostigao volumen potreban da bi izazvao NIC hang — radi se o ~50 zahtjeva ukupno, dok hang dolazi zbog hardverskog bug-a pri potpuno normalnom opterećenju

Zaključak: incident je **u potpunosti driver/hardware problem**, ne napad. Ali scan aktivnost koju smo zatekli u logovima je bila dovoljno indikativna da smo odlučili konfigurisati dodatnu zaštitu — i to je bio direktan razlog za [fail2ban setup](/blog/fail2ban-ssh-http-zastita-2026.md/) koji smo instalirali odmah nakon što smo zatvorili incident.

## Šta se dalje dešavalo

Odmah nakon podizanja servera, počeli smo dvije paralelne aktivnosti:

1. **Workaround za e1000e bug**: napisali smo NixOS systemd oneshot servis koji na svaki boot poziva `ethtool -K eno1 tso off gso off gro off`. Ovaj fiks je testiran u runtime-u prije nego što je commit-ovan u konfiguraciju — detalji su u [narednom postu](/blog/e1000e-offloads-nixos-2026.md/).

2. **fail2ban zaštita**: konfigurisali smo fail2ban na dva nivoa — jedan na fizičkom serveru (za SSH brute force), drugi na reverse proxy VM-u (za HTTP bot skenere). Detalji su u [trećem postu](/blog/fail2ban-ssh-http-zastita-2026.md/).

Oba fiksa su uspješno deploy-ovana istog dana, test-pa-switch workflow-om, sa break-glass SSH putem iz dvije dodatne lokacije (Frankfurt i Paris AWS Light) kao sigurnosnom mrežom za slučaj da primarni put ikada otkaže.

## Pouke

1. **Sporadični hardverski bugovi postoje i na proizvodnim sistemima** — `e1000e` je stabilan driver u 99,99% vremena, ali kada se nasumično desi hang, jedino što možemo je primijeniti workaround koji smanjuje vjerovatnoću ili isključuje uzročnu putanju.

2. **Kaskada kroz nbd2 je najopasniji dio** — samo otkazivanje mrežnog interfejsa bi bilo uobičajen incident, ali kada taj interfejs nose disk backend-ovi VM-ova, gubitak mreže znači gubitak diskova, a to znači gubitak cijele virtuelne infrastrukture. Za buduće postavke razmišljamo o tome da disk backend-ovi koriste unix sockets ili loopback interface tamo gdje je to moguće, umjesto external NIC-a.

3. **Persistentni journal je neophodan za forenziku** — na prvu provjeru kernel log za window incidenta smo dobili "No entries", što je sugerisalo da je journal volatilan. Zapravo je journal persistentan, ali kernel je zadnjih 80 sekundi prije restart-a već bio u stanju gdje sam journald nije mogao više ništa pisati jer je EXT4 superblock bio slomljen. Korisno je znati da je upravo zato forenzika kroz `journalctl -b -1` ograničena — prošli boot se završava tačno na trenutku kada je kernel izgubio sposobnost pisanja.

4. **Iako smo prijavili brute force napade, pravi uzrok je bio drugdje** — kada imaš sigurnosni incident i istovremeno mehanički kvar, lako je pomiješati dva signala. Disciplina "korelisi timestamp-ove prije nego izvlačiš zaključke" je spasila nas od cirkularnog rasuđivanja.

## Linkovi

- [Onemogućavanje e1000e offload-a u NixOS konfiguraciji](/blog/e1000e-offloads-nixos-2026.md/) — konkretan fix
- [fail2ban zaštita: SSH i HTTP na našoj infrastrukturi](/blog/fail2ban-ssh-http-zastita-2026.md/) — dodatna zaštita koju smo instalirali istog dana

## Napomena

Generisano od strane Claude 🤖

---

Ernad Husremović, hernad@bring.out.ba
