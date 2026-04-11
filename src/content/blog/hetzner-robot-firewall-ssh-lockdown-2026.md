---
title: 'Hetzner Robot firewall: SSH lockdown na hetzner-1 kroz reproducibilnu Python skriptu'
description: 'Kako smo zatvorili SSH na port 22 samo za četiri bastion hosta kroz edge-firewall Hetzner Robota, i napisali reusable skriptu koja radi backup + diff + apply + rollback kroz Robot web-service API.'
pubDate: '2026-04-11T18:00:00'
heroImage: '/hetzner-firewall-hero.svg'
---

Edge-firewall na `hetzner-1` do danas je bio postavljen kao "**Allow all**" — jedan input rule bez ikakvih restrikcija. Svako je mogao pokucati na port 22 sa interneta, i OS-level iptables (NixOS) je bila jedina linija odbrane. To je radilo, ali je značilo da svaki [fail2ban bruteforce pokušaj](/blog/fail2ban-ssh-http-zastita-2026.md/) troši ciklus na samom serveru prije nego što ga odbijemo.

Odlučili smo da premjestimo tu prvu liniju odbrane jedan korak uzbrdo — u Hetzner Robot firewall, koji radi na mrežnom edge-u prije nego što paket uopšte stigne do servera. Ovaj post opisuje dizajn, Python tooling koji smo napravili, i safety mehanizme koji garantuju da se ne zaključamo vani.

## Cilj

SSH na `95.217.79.40:22` treba da bude dostupan **samo sa četiri bastion hosta**:

- `smtp-sa-1.out.ba`
- `smtp-sa-2.out.ba`
- `awslight-frankfurt-1`
- `awslight-paris-1`

(U nastavku posta javne IP adrese ovih hostova su prikazane sa prva dva okteta, na primjer `77.78.xxx.xxx` — to daje dovoljno konteksta da se razumije da se radi o različitim providerima i mrežama, ali ne pruža potencijalnom napadaču gotovu listu ulaznih tačaka.)

Svi ostali portovi (`80`, `443`, `25`, `465`, `993`, `2222`, ...) ostaju netaknuti — kroz njih i dalje prolazi saobraćaj za web, mail i Forgejo SSH forwarding. Jedini cilj je **port 22 na samom hostu**.

## Dvije linije odbrane

Imamo sada dva nivoa firewall-a koji rade paralelno:

| Nivo | Gdje | Čime upravljamo | Šta radi |
|---|---|---|---|
| **Edge** | Hetzner Robot firewall | Robot web panel ili web-service API | Statelless packet filter ispred serverske NIC kartice. Blokira SSH sa ne-dozvoljenih IP-jeva *prije* nego što paket uopšte dođe do OS-a. |
| **Host** | NixOS `networking.firewall` | `infra-hodi/hosts/hetzner/hetzner-1/default.nix` | Klasična stateful iptables politika na samom serveru. I dalje dopušta `22/80/443/25/...` kao i ranije; kompatibilna sa edge-firewall-om koji je sada uži. |

Ključna stvar koju često zaboravimo: **Robot firewall je stateless**. Ako postaviš pravilo "dozvoli SSH samo iz X", ne postoji automatski pojam "već uspostavljena konekcija". Svaki paket se procjenjuje nezavisno. To znači da postojeće SSH sesije mogu umrijeti sekundu nakon `Apply`-a — osim ako eksplicitno ne dodaš pravilo koje dopušta već-uspostavljene TCP konekcije (`TCP flags: ack`).

## Ruleset

Napisali smo tih 10 input pravila po tačno određenom redoslijedu — top-to-bottom, prvi match pobjeđuje:

```
 [0] allow established tcp     proto=tcp flags=ack              accept
 [1] allow icmp v4              ipv4 icmp                        accept
 [2] allow icmp v6              ipv6 icmp                        accept   ← Neighbor Discovery / PMTUD
 [3] ssh from smtp-sa-1         src=77.78.xxx.xxx dport=22 tcp    accept
 [4] ssh from smtp-sa-2         src=77.78.xxx.xxx dport=22 tcp    accept
 [5] ssh from awslight-fra      src=52.58.xxx.xxx dport=22 tcp    accept
 [6] ssh from awslight-par      src=13.37.xxx.xxx dport=22 tcp    accept
 [7] drop other ssh             dport=22 tcp                     discard
 [8] allow other tcp            tcp                              accept
 [9] allow udp                  udp                              accept

output:
 [0] Allow all                                                   accept

filter_ipv6 = true
whitelist_hos = true
```

Nekoliko suptilnosti koje smo naučili na nogama:

1. **Pravilo 0 (`tcp flags: ack`) mora biti prvo.** Stateless firewall ne zna šta je "established" sam po sebi — jedina vodilja je TCP flag bit. Ako ovo pravilo ne postoji, SSH sesija koja je upravo primijenila promjenu gubi se sljedećim packetom i moraš čekati da se vidjiš. Sa ovim pravilom, tekuće sesije preživljavaju apply.
2. **Pravilo 7 (`drop other ssh`) mora biti iznad pravila 8.** Ako se zamijene, `allow other tcp` će pokupiti svaki dolazni TCP uključujući SSH, i blokada nikad neće okinuti.
3. **Pravila 8 i 9 su "fall-through allow".** Bez njih bi Robot default-discard blokirao sav web i mail saobraćaj. Sa njima, sav ne-SSH saobraćaj prolazi kroz edge kao i do sada i dalje ga filtrira samo OS-level iptables — čime se edge promjena svede striktno na port 22.
4. **`filter_ipv6=true`** je zadržan namerno. Da smo ga isključili, IPv6 bi u cijelosti zaobilazio Robot firewall i IPv6 SSH bi ostao otvoren svima. Zadržavanjem filtera na pravilo 7 (`drop other ssh`) se primjenjuje i na IPv6, jer nema postavljen `ip_version`. Mrežni "back door" je zatvoren.
5. **ICMPv6 (pravilo 2) mora biti eksplicitno dopušten.** U suprotnom IPv6 Neighbor Discovery i Path MTU Discovery mogu tiho prestati raditi. Ovo je uobičajen razlog zašto ljudi koji isključe Robot firewall ostanu bez IPv6 konekcije.

## Zašto reusable skripta, a ne klikanje po browseru

Robot web panel je sasvim sposoban da se uđe u firewall stranicu i klikne kroz formu. Prvi put smo tako i htjeli. Problemi koji se brzo pojave:

- **Nema dry-run-a.** Ruleset se primjenjuje odmah kad stisneš *Apply*.
- **Nema diff-a.** Ako mijenjaš postojeći ruleset, moraš sam po glavi vratiti šta si tačno promijenio.
- **Nema rollback-a.** Ako nešto pođe krivo i izgubiš pristup, moraš ponovo ručno upisati stari ruleset — ali bez memorije šta je tačno bio stari ruleset prije tvoje promjene.
- **Nije reproducibilno.** Ruleset živi kao UI stanje u Hetzner panelu, ne kao fajl u repu koji se može code-review-ati.

Napravili smo `profile/hetzner/scripts/hetzner_setup_firewall.py` — stdlib-only Python skriptu (oko 600 linija) koja rješava sve četiri stavke.

## Skripta

Razgovara sa Robot web-service API-jem preko HTTP Basic Auth-a. Kredencijali se čitaju iz `pass` store-a:

```bash
pass show hetzner/ws-user       # na primjer: #ws+xxxxxxxx
pass show hetzner/ws-password   # generisano pri kreiranju WS usera u Robotu
```

Robot API koristi jedan URL za GET (očitavanje trenutnog stanja) i jedan za POST (primjena novog rulesetа) — oba na `https://robot-ws.your-server.de/firewall/{server_number}`. Server number smo otkrili kroz `GET /server` koji vraća sve servere u računu i izabire onaj koji se poklapa sa IP-jem `hetzner-1`-a.

Subkomande:

```bash
# 1. šta je sada na serveru
python3 scripts/hetzner_setup_firewall.py get

# 2. preview lockdown-a bez stvarnog apply-a
python3 scripts/hetzner_setup_firewall.py --dry-run ssh-lockdown

# 3. pravi apply (tražit će interaktivnu potvrdu)
python3 scripts/hetzner_setup_firewall.py ssh-lockdown

# 4. isti apply, bez prompt-a (za automatizaciju)
python3 scripts/hetzner_setup_firewall.py --yes ssh-lockdown

# 5. rollback na najnoviji backup iz /tmp/
python3 scripts/hetzner_setup_firewall.py rollback

# 6. apply proizvoljan JSON ruleset iz fajla
python3 scripts/hetzner_setup_firewall.py apply moj-ruleset.json
```

### Šta skripta radi prije apply-a

Svaki `apply` / `ssh-lockdown` poziv automatski radi sljedeće **prije** nego što skripta bilo šta pošalje na Robot API:

1. **Fetch current config** — `GET /firewall/{n}` → parsiranje JSON-a.
2. **Ispiši trenutno stanje** — human-readable tabela.
3. **Ispiši željeno stanje** — ista tabela, za novi ruleset.
4. **Ispiši diff** — lista `REMOVE` / `ADD` / skalarnih promjena.
5. **Pitaj za potvrdu** — jednostavni `input()` sa `yes/NO` default-om, osim ako nije prosljeđen `--yes`.
6. **Backup** — zapiše trenutni config kao `/tmp/hetzner_firewall_backup_YYYYMMDD_HHMMSS.json` *prije* POST-a. Ako nešto kasnije pođe krivo, rollback koristi ovaj fajl.
7. **POST novi config** — `application/x-www-form-urlencoded` sa `rules[input][N][...]` ključevima.
8. **Poll status** — Robot primjena je asinhrona, status prolazi kroz `pending` → `in process` → `active` tokom 30–90 sekundi; skripta poll-uje svakih 5s do 4 minute.
9. **Ispiši final state** — potvrda da je ruleset aktivan.

### Snippet: backup + POST

```python
def _apply_config(args, desired, source_label):
    user, password = load_creds()
    server_number = get_server_number(user, password)

    before = fw_get(user, password, server_number)
    print(">>> current:")
    print_firewall(before)

    print(">>> diff:")
    for line in diff_firewalls(before, desired):
        print(line)

    if args.dry_run:
        fw_post(user, password, server_number, desired, dry_run=True)
        return

    if not confirm("Apply these changes?", args.yes):
        print(">>> aborted")
        return

    backup_current(before)   # ← /tmp/hetzner_firewall_backup_*.json
    fw_post(user, password, server_number, desired, dry_run=False)
    fw_wait_active(user, password, server_number)
```

## Kako se u praksi radi `apply`

Tipičan tok:

```
$ python3 scripts/hetzner_setup_firewall.py ssh-lockdown

>>> fetching current firewall for ssh-lockdown preset...

>>> current:
  server_ip      95.217.79.40  (server_number=xxxxxxx)
  status         active
  filter_ipv6    True
  input rules: 1
  [ 0] Allow all                      src=- dport=- proto=- action=accept

>>> diff:
  input rules: 1 -> 10
    REMOVE [ 0] Allow all   proto=- action=accept
    ADD    [ 0] allow established tcp    tcp flags=ack action=accept
    ADD    [ 0] allow icmp v4             ipv4 icmp action=accept
    ...
    ADD    [ 0] drop other ssh            dport=22 tcp action=discard
    ADD    [ 0] allow other tcp           tcp action=accept
    ADD    [ 0] allow udp                 udp action=accept

Apply these changes? [yes/NO] yes
>>> backup written to /tmp/hetzner_firewall_backup_20260411_180215.json
>>> POSTing new config...
>>> waiting for firewall to become active [in process] [in process] [active]

>>> final state:
  input rules: 10   (...)
```

Ako nakon `active` stanja primijetimo da nešto nije u redu, rollback je jedna komanda:

```bash
python3 scripts/hetzner_setup_firewall.py rollback
```

Što će uzeti najnoviji `/tmp/hetzner_firewall_backup_*.json`, prikazati diff, tražiti potvrdu, i vratiti raniji ruleset (čime će stariji "Allow all" ponovo biti aktivan).

## Šta nije u skripti

Nekoliko svjesno ostavljenih stvari izvan skoupa:

- **Ne upravlja OS-level iptables.** To radi NixOS konfiguracija u `infra-hodi`. Robot firewall je samo edge, OS firewall je host — ta dva su namjerno razdvojena.
- **Ne gleda u Hetzner Cloud firewall.** Hetzner ima tri različita "firewall" proizvoda (Robot za dedicated, Cloud Firewall za VPS, nflabs za custom networks). Skript se bavi samo Robot-om jer `hetzner-1` je dedicated auction server.
- **Nema deklarativni Terraform/Pulumi provider.** Za ovoliko hostova i ovu veličinu tima (jedan-dva admina) to je previše overhead-a. Backup-diff-apply-rollback obrazac je dovoljan.
- **Nema automatskog CI health-check-a poslije apply-a.** Skript poll-uje dok Robot ne kaže `active`, ali ne pokušava stvarno otvoriti SSH sesiju iz dozvoljenog izvora kao finalnu verifikaciju. To možemo dodati kasnije ako se pokaže potrebnim.

## Lekcije

1. **Ne vjeruj "browser UI je dovoljan" intuiciji za firewall operacije.** Browser je OK za inspekciju; za bilo kakvu promjenu želiš diff + backup + rollback. Napisati tooling je skoro uvijek jeftinije nego čistiti posljedice jednog pogrešnog klika.
2. **Stateless firewall zahtijeva eksplicitni `established` rule.** Ovo je klasičan subtle bug: sve radi u testu, a onda primijeniš ruleset na produkciju i sjedeći SSH se smrzne. Uvijek rule #0.
3. **Pandur za drugu napravu (host-level) je koristan.** Ako neko slučajno izbriše SSH lockdown na Robot nivou, OS-level iptables i dalje drži stvari pod kontrolom (port 22 je otvoren svima, ali `fail2ban` i dalje filtrira brute force pokušaje). Dvije linije odbrane su jeftine.
4. **"Privremene" vrijednosti u javnim repoima/blog postovima obično ostaju.** Zato IP adrese izvornih bastiona u ovom postu nisu prikazane u punom obliku — to su operativni detalji koji nemaju razloga biti zauvijek indeksirani u Google-u. Isti obrazac važi i za [post o LLDAP-u](/blog/lldap-patroni-boot-race-2026.md/) koji smo anonimizirali istoga dana.

Commit sa skriptom: [`profile/hetzner@768298f`](https://github.com/bringout/).

## Napomena

Generisano od strane Claude 🤖

---

Ernad Husremović, hernad@bring.out.ba
