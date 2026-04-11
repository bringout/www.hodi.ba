---
title: 'Hetzner Robot firewall: SSH lockdown na hetzner-1 kroz reproducibilnu Python skriptu'
description: 'Kako smo zatvorili SSH na port 22 samo za četiri bastion hosta kroz edge-firewall Hetzner Robota, i napisali reusable skriptu koja radi backup + diff + apply + rollback kroz Robot web-service API.'
pubDate: '2026-04-11T18:00:00'
heroImage: '/hetzner-firewall-hero.svg'
---

Edge-firewall na `hetzner-1` do danas je bio postavljen kao "**Allow all**" — jedan input rule bez ikakvih restrikcija. Svako je mogao pokucati na port 22 sa interneta, i OS-level iptables (NixOS) je bila jedina linija odbrane. To je radilo, ali je značilo da svaki [fail2ban bruteforce pokušaj](/blog/fail2ban-ssh-http-zastita-2026.md/) troši ciklus na samom serveru prije nego što ga odbijemo.

Odlučili smo da premjestimo tu prvu liniju odbrane jedan korak uzbrdo — u Hetzner Robot firewall, koji radi na mrežnom edge-u prije nego što paket uopšte stigne do servera. Ovaj post opisuje dizajn, Python tooling koji smo napravili, i safety mehanizme koji garantuju da se ne zaključamo vani.

## Cilj

SSH pristup treba omogućiti **samo sa bastion hostova**.

(U nastavku posta bastion hostovi su prikazani kao generičke oznake `bastion 1..4`, a njihove javne IP adrese zamagljene — to su operativni detalji koji nemaju razloga biti zauvijek indeksirani u Google-u.)

Svi ostali portovi (`80`, `443`, `25`, `465`, `993`, `2222`, ...) ostaju netaknuti — kroz njih i dalje prolazi saobraćaj za web, mail i Forgejo SSH forwarding. Jedini cilj je **port 22 na samom hostu**.

## Dvije linije odbrane

Imamo sada dva nivoa firewall-a koji rade paralelno:

| Nivo | Gdje | Čime upravljamo | Šta radi |
|---|---|---|---|
| **Edge** | Hetzner Robot firewall | Robot web panel ili web-service API | Statelless packet filter ispred serverske NIC kartice. Blokira SSH sa ne-dozvoljenih IP-jeva *prije* nego što paket uopšte dođe do OS-a. |
| **Host** | NixOS `networking.firewall` | `infra-hodi/hosts/hetzner/hetzner-1/default.nix` | Klasična stateful iptables politika na samom serveru. I dalje dopušta `22/80/443/25/...` kao i ranije; kompatibilna sa edge-firewall-om koji je sada uži. |

Ključna stvar koju često zaboravimo: **Robot firewall je stateless**. Ako postaviš pravilo "dozvoli SSH samo iz X", ne postoji automatski pojam "već uspostavljena konekcija". Svaki paket se procjenjuje nezavisno. To znači da postojeće SSH sesije mogu umrijeti sekundu nakon `Apply`-a — osim ako eksplicitno ne dodaš pravilo koje dopušta već-uspostavljene TCP konekcije (`TCP flags: ack`).

## Ruleset

Konačni dizajn ima **tačno 10 input pravila** (maksimum koji Robot dozvoljava — više o tome dole):

```
 [0] established tcp            tcp flags=ack                    accept   ← v4 i v6 obje
 [1] icmp v4                    ipv4 icmp                        accept
 [2] icmp v6                    ipv6 icmp                        accept   ← Neighbor Discovery / PMTUD
 [3] ssh from bastion 1         ipv4 src=xx.xx.xxx.xxx dport=22 tcp  accept
 [4] ssh from bastion 2         ipv4 src=xx.xx.xxx.xxx dport=22 tcp  accept
 [5] ssh from bastion 3         ipv4 src=xx.xx.xxx.xxx dport=22 tcp  accept
 [6] ssh from bastion 4         ipv4 src=xx.xx.xxx.xxx dport=22 tcp  accept
 [7] drop other ssh v4          ipv4 dport=22 tcp                discard
 [8] drop other ssh v6          ipv6 dport=22 tcp                discard
 [9] allow everything else      (nothing)                        accept

output:
 [0] Allow all                                                   accept

filter_ipv6 = true
whitelist_hos = true
```

Ovako izgleda u Hetzner Robot panelu nakon apply-a (IP adrese zamagljene):

![Hetzner Robot firewall panel sa 10 aktivnih pravila nakon apply-a](/hetzner-robot-panel.png)

Nekoliko suptilnosti koje smo naučili na nogama:

1. **Pravilo 0 (`tcp flags: ack`) mora biti prvo.** Stateless firewall ne zna šta je "established" sam po sebi — jedina vodilja je TCP flag bit. Ako ovo pravilo ne postoji, SSH sesija koja je upravo primijenila promjenu gubi se sljedećim paketom. Sa ovim pravilom, tekuće sesije preživljavaju apply. Ovo pravilo **namjerno nema `ip_version`** jer želimo da pokrije i IPv4 i IPv6 istovremeno — bez toga bismo trošili dva slota od 10.
2. **Pravila 7 i 8 (`drop other ssh v4/v6`) moraju biti iznad pravila 9.** Ako se zamijene, `allow everything else` će pokupiti svaki dolazni TCP uključujući SSH, i blokada nikad neće okinuti.
3. **Pravilo 9 je "fall-through allow".** Bez njega bi Robot default-discard blokirao sav web i mail saobraćaj. Sa njim, sav ne-SSH saobraćaj prolazi kroz edge i dalje ga filtrira samo OS-level iptables — čime se edge promjena svede striktno na port 22.
4. **`filter_ipv6=true`** je zadržan namjerno. Da smo ga isključili, IPv6 bi u cijelosti zaobilazio Robot firewall i IPv6 SSH bi ostao otvoren svima. Sa filterom, pravilo 8 (`drop other ssh v6`) zatvara IPv6 back door.
5. **ICMPv6 (pravilo 2) mora biti eksplicitno dopušten.** U suprotnom IPv6 Neighbor Discovery i Path MTU Discovery mogu tiho prestati raditi. Ovo je uobičajen razlog zašto ljudi koji uključe Robot firewall ostanu bez IPv6 konekcije.

## Dvije nepisane konstante koje su nas koštale sat vremena

Hetzner Robot docs opisuju POST `/firewall/{server-number}` na visokom nivou, ali dvije konstante *nisu* dokumentovane, a obje smo otkrili na bolan način:

### 1. Hard cap: **maksimalno 10 input pravila**

Prvi put smo dizajnirali ruleset od 14 pravila (posebno `allow tcp v4`, `allow tcp v6`, `allow udp v4`, `allow udp v6` na dnu). API ga je odbio sa `HTTP 400 INVALID_INPUT` na polje `rules`. Ista greška sa 11 pravila. Sa 10 — prolazi. Limit je tvrd i ne zavisi od sadržaja. Taj cap nismo našli ni u jednom dokumentu — znalo se samo u starim forum thread-ovima.

Ovo je razlog zašto pravilo 0 (`established tcp`) nema postavljen `ip_version` — merge-anje v4 i v6 u jedno pravilo oslobađa slot.

### 2. `protocol` **zahtijeva** `ip_version`

Ako pravilo ima postavljen `protocol` (`tcp`, `udp`, `icmp`), onda **mora** imati i `ip_version` (`ipv4` ili `ipv6`). Bez toga Robot API vraća isti `HTTP 400 INVALID_INPUT`, i to za sve vrijednosti protokola. Mi smo u prvom pokušaju imali pravila kao:

```
rules[input][0][name]=allow tcp
rules[input][0][protocol]=tcp
rules[input][0][action]=accept
```

i debilno dugo probavali drugi `protocol=` string, pa numerički broj (`6`), pa različite kombinacije — sve je padalo na istu grešku. Rješenje:

```
rules[input][0][name]=allow tcp v4
rules[input][0][ip_version]=ipv4        ← bez ovoga POST ne prolazi
rules[input][0][protocol]=tcp
rules[input][0][action]=accept
```

Izuzetak: pravila koja imaju samo `tcp_flags` bez `protocol` (poput našeg `established tcp`) **mogu** izostaviti `ip_version`, i onda se primjenjuju na oba IP familije. To je jedini način da se spaja v4/v6 obrada u jedno pravilo pri ovom 10-slot limitu.

**Ako Hetzner bude ikada vratio jasnu validaciju s nazivima polja koja im trebaju — velika hvala. Do tad, ovaj blog post je dokumentacija.**

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

## Napomena

Generisano od strane Claude 🤖

---

Ernad Husremović, hernad@bring.out.ba
