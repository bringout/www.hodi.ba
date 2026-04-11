---
title: 'fail2ban zaštita: SSH i HTTP na našoj infrastrukturi'
description: 'Kako smo konfigurisali fail2ban na dva nivoa — SSH brute force na fizičkom serveru, HTTP bot skeneri na reverse proxy VM-u, sa custom filterom za "secret file hunter" napade'
pubDate: '2026-04-11T16:00:00'
---

Ovaj post je treći u seriji nastaloj nakon [incident reporta od 11. aprila 2026.](/blog/incident-report-nic-hang-2026.md/). Prva dva posta objašnjavaju sami incident i [network fix](/blog/e1000e-offloads-nixos-2026.md/) koji smo primijenili. Ovdje opisujemo drugu polovinu odgovora na incident — fail2ban zaštitu koju smo istog dana instalirali na perimetru naše infrastrukture.

## Zašto fail2ban, i zašto baš sada

Kao što smo opisali u incident reportu, forenzička analiza je pokazala da mrežni incident **nije** bio posljedica napada. Ali tokom pregleda logova, pronašli smo nešto što je bilo dovoljno indikativno da smo odlučili zatvoriti rupe odmah:

- Na našem javnom SSH portu (22) bilo je **kontinuirano brute force traffic-a** iz desetak botnet `/24` mreža. Adresa tipa `195.178.110.0/24`, `45.148.10.0/24`, `2.57.122.0/24`, `80.94.92.0/24`, `92.118.39.0/24`, `186.96.145.0/24` pokušavala je dictionary napade sa korisničkim imenima kao što su `root`, `test`, `cpanel`, `solana`, `cmu`, `mos`, `sol`, `node`, `solv`, `cpcloud`.
- Na našem HTTP reverse proxy-ju bilo je **bot skenera koji traže "tajne" fajlove** — `/.env`, `/.env.bak`, `/.git/config`, `/wp-config.php`, `/phpinfo.php`, `/.aws/credentials`, `/_debugbar/` i slično. Sve ove rute vraćaju 404 na našim servisima, ali svaki uspješan leak `.env` fajla drugdje na internetu znači kompromitovane credentials.

Nijedan od ovih napada nije uspio, ali činjenica da se dešavaju kontinuirano znači da čekaju da admin napravi grešku — postavi novi servis sa default passwordom, zaboravi da rotira ključeve, instalira WordPress "samo na tren da testira nešto". fail2ban eliminiše tu rupu postavljanjem automatskog ban-a za IP-ove koji pokazuju obrazac napada.

## Dvije nivoe zaštite

Naša javna infrastruktura je raspoređena kao dva nivoa:

```
                   External internet
                         │
                         ▼
              fizički server (hetzner-1)
                  port 22 — SSH
                  port 80/443 — DNAT → router-7 VM
                         │
                         ▼
                  router-7 VM (192.168.122.2)
                  nginx reverse proxy
                         │
                         ▼
           interne usluge u VM-ovima
           (www, mail, git, KEP verifikator, ...)
```

fail2ban smo instalirali **na oba nivoa**, sa specifičnim jail-ovima za ono što svaki nivo vidi:

| Nivo | Host | Jail-ovi | Prijeti ga |
|---|---|---|---|
| 1 | hetzner-1 (fizički) | `sshd` | SSH brute force na port 22 |
| 2 | router-7 (VM) | `nginx-botsearch`, `nginx-secrets-hunter`, `sshd` (internal) | HTTP bot skeneri na port 80/443 |

**Zašto oba nivoa a ne samo jedan?** SSH saobraćaj završava na hetzner-1 pa tamo i ima smisla blokirati ga. HTTP saobraćaj prolazi kroz DNAT i završava na router-7 — nginx je tu, pa je to i logična tačka da vidimo URL pattern-e i blokiramo napadače. Blokiranje HTTP napada na hetzner-1 bi značilo analizu paketa na transport sloju, što je dramatično manje precizno nego na aplikacijskom sloju.

**Važan detalj**: hetzner-1 DNAT-uje pakete prema router-7 bez izmjene source adrese, tako da nginx na router-7 vidi **pravu eksternu IP adresu napadača**. Ban koji fail2ban postavi u iptables na router-7 zato radi tačno ono što treba — blokira daljnji saobraćaj od te IP adrese.

## Osnovne postavke — progressive bans

Oba fail2ban deployment-a koriste istu "meta" konfiguraciju — progresivno povećavanje ban vremena za IP-ove koji se vraćaju:

```nix
services.fail2ban = {
  enable = true;
  maxretry = 5;
  bantime = "1h";
  bantime-increment = {
    enable = true;
    multipliers = "1 2 4 8 16 32 64";
    maxtime = "168h";
    overalljails = true;
  };
  ignoreIP = [
    "127.0.0.0/8"
    "::1"
    "192.168.122.0/24"  # internal libvirt VM bridge
    "77.78.203.115"      # operator client IP
  ];
  # ... jails ...
};
```

Progresivni bans znače:

- Prvi ban: **1 h**
- Drugi ban za isti IP: **2 h**
- Treći: **4 h**
- Četvrti: **8 h**
- Peti: **16 h**
- Šesti: **32 h**
- Sedmi: **64 h**
- Osmi i dalje: **168 h (1 sedmica)** — cap

`overalljails = true` znači da se ban multiplier računa **preko svih jail-ova zajedno**. Ako napadač prvo SSH brute force napravi, pa kasnije HTTP scan, obje runde se broje zajedno pa mu sljedeći ban postaje duži. Ovo je efektivno protiv botnet-ova koji pokušavaju više vektora iz iste IP adrese.

`ignoreIP` whitelist je **kritičan** — izgubiti SSH pristup vlastitom serveru zbog fail2ban misconfiguration-a je najčešći self-foot-gun kod ovakvih setup-a. Naš whitelist uključuje loopback, internu libvirt mrežu (da VM-ovi nikada ne budu banned), i operator client IP. Pored ovoga, za fizički server smo pripremili break-glass put iz dvije AWS lokacije (Frankfurt i Paris) tako da čak i potpuni gubitak primarnog klijenta ne znači gubitak pristupa.

## Nivo 1: fail2ban na hetzner-1 za SSH

Konfiguracija je jednostavna:

```nix
services.fail2ban = {
  # ... osnovne postavke iznad ...
  jails.sshd.settings = {
    enabled = true;
    backend = "systemd";
    filter = "sshd";
    findtime = 600;
    maxretry = 5;
  };
};
```

Ključni detalj: **`backend = "systemd"`** — NixOS ne piše sshd logove u `/var/log/auth.log` nego direktno u journald. Bez ove postavke fail2ban pokušava čitati fajl koji ne postoji i jail prijavljuje grešku.

`maxretry = 5` u 10-minutnom `findtime` prozoru znači da pet failed auth pokušaja iz iste IP adrese triggeraje ban. Botnet scanner-i tipično pogode 50+ username-a u sekundi, pa se ban desi u prvih par sekundi njihovog napada.

## Real-time validacija

Na naše zadovoljstvo, fail2ban je počeo raditi istu sekundu kada smo ga deploy-ovali. Izvod iz log-a nekoliko sekundi nakon pokretanja:

```
Apr 11 12:20:51 fail2ban.filter [sshd] Found 186.96.145.241 - 2026-04-11 12:14:12
Apr 11 12:20:51 fail2ban.filter [sshd] Found 186.96.145.241 - 2026-04-11 12:14:14
Apr 11 12:20:51 fail2ban.filter [sshd] Found 186.96.145.241 - 2026-04-11 12:18:19
Apr 11 12:20:51 fail2ban.filter [sshd] Found 186.96.145.241 - 2026-04-11 12:18:21
Apr 11 12:22:33 fail2ban.actions [sshd] Ban 186.96.145.241
```

Od trenutka startup-a, fail2ban je skenirao zadnjih 10 minuta journal-a (svoju `findtime` retention), pronašao 4 failed auth pokušaja iz `186.96.145.241`, pratio da li se peti desi, i prvi stvarni ban se desio u 12:22:33 — kada je isti napadač pokušao peti put.

Nakon par minuta, jail je imao dva ban-a:

```
Status for the jail: sshd
|- Filter
|  |- Currently failed:  1
|  |- Total failed:      7
`- Actions
   |- Currently banned:  2
   |- Total banned:      2
   `- Banned IP list:    186.96.145.241 195.178.110.30
```

`195.178.110.30` je iz istog `/24` kao i scanner `195.178.110.223` kojeg smo vidjeli u nginx logu — botnet infrastruktura iza iste ASN-ove, pogađajući i SSH i HTTP. Sada obje adrese iz te mreže imaju začetak ban multiplier-a.

## Nivo 2: fail2ban na router-7 za nginx

Na reverse proxy VM-u smo inicijalno konfigurisali standardni `nginx-botsearch` jail:

```nix
jails.nginx-botsearch.settings = {
  enabled = true;
  backend = "auto";
  filter = "nginx-botsearch";
  logpath = "/var/log/nginx/access.log";
  maxretry = 2;
  findtime = 600;
};
```

`backend = "auto"` pusti fail2ban da sam izabere pyinotify ili polling za praćenje log fajla. Na NixOS-u pyinotify je dostupan pa ga bira automatski — efikasnije nego stalno polling-ovanje.

`maxretry = 2` je agresivnije od SSH jail-a (5) jer built-in `nginx-botsearch` filter matchuje **samo poznate scanner rute** — `/wp-login.php`, `/phpmyadmin`, `/roundcube`, `/(ext)?mail`, i slično. Legitimni korisnik nikada neće hititi ove URL-ove, pa je dva hita dovoljno za konfiguraciju ban-a.

### Problem: nginx-botsearch ne pokriva "secret file" napade

Kada smo testirali built-in filter protiv našeg stvarnog access.log-a, dobili smo neugodno otkrovenje: filter je pronašao **58 matcha** u 64.789 linija log-a. To je dobro za postojeće pattern-e, ali ne pokriva cijelu klasu napada koje smo zapravo vidjeli od `195.178.110.223`:

```
195.178.110.223 [11/Apr/2026:09:11:35] "GET /.env" 404
195.178.110.223 [11/Apr/2026:09:11:35] "GET /.env.bak" 404
195.178.110.223 [11/Apr/2026:09:11:35] "GET /.git/config" 404
195.178.110.223 [11/Apr/2026:09:11:35] "GET /wp-config.php" 404
195.178.110.223 [11/Apr/2026:09:11:35] "GET /phpinfo.php" 404
195.178.110.223 [11/Apr/2026:09:11:36] "GET /.aws/credentials" 404
195.178.110.223 [11/Apr/2026:09:11:36] "GET /.s3cfg" 404
195.178.110.223 [11/Apr/2026:09:11:36] "GET /_debugbar/" 404
```

`nginx-botsearch` matchuje `wp-login.php` ali **ne** matchuje `/.env`, `/.git/config`, `/.aws/credentials`, `/_debugbar/`. To je cijela klasa "secret file hunter" napada koja je potpuno promašila naš filter.

### Rješenje: custom filter "nginx-secrets-hunter"

Napisali smo vlastiti fail2ban filter koji pokriva upravo te pattern-e:

```nix
environment.etc."fail2ban/filter.d/nginx-secrets-hunter.conf".text = ''
  [Definition]
  failregex = ^<HOST> \- \S+ \[\] "(GET|POST|HEAD) /+(\.(env|git|aws|s3cfg)|(backend|admin|api|app|web|config)/\.env|wp-config\.php|phpinfo\.php|info\.php|test\.php|_?debugbar/)
  ignoreregex =
'';

services.fail2ban.jails.nginx-secrets-hunter.settings = {
  enabled = true;
  backend = "auto";
  filter = "nginx-secrets-hunter";
  logpath = "/var/log/nginx/access.log";
  maxretry = 1;
  findtime = 600;
};
```

Primijetite:

- **`maxretry = 1`** — jedan hit je dovoljan za ban. Ne postoji legitiman razlog za bilo kakvog klijenta da zahtijeva `/.env` na našoj infrastrukturi, pa nam je ovdje agresivnost sigurna.
- **Status code se ne provjerava** — filter matchuje samo URL pattern. Razlog: jedan od naših upstream servisa je SPA aplikacija koja vraća `200 OK` za sve nepoznate rute (vraća index.html shell), pa bi zahtjev "GET 200" maskirao scanner hit ako bismo zahtijevali 404.
- **`/+\.git`** umjesto samo `\.git` — `/+` znači "jedan ili više slash-eva prije tačke". Ovim razlikujemo `/.git/config` (filesystem leak, loš) od `/repo.git/info/refs` (Forgejo git smart HTTP, legitiman). Ovo je bila ključna distinkcija — bez nje bismo bannovali sve git push/pull operacije preko HTTPS-a.

### Validacija custom filter-a protiv stvarnog log-a

Prije commit-a u produkciju, pokrenuli smo `fail2ban-regex` protiv cijelog access.log-a (64.789 linija, više dana historije) da vidimo koliko bi filter matchevao i — važnije — da li ima false positive-a:

```
Results
=======
Failregex: 1853 total
Lines: 64789 lines, 0 ignored, 1853 matched, 62936 missed
```

**1853 match-a** — 28 puta više nego built-in nginx-botsearch. To je stvarna mjera koliko je scanner saobraćaja filter propuštao.

Za provjeru false positive-a, filter-ovali smo access.log samo na zahtjeve sa našeg operator IP-a (3286 redova, uključujući legitimni git clone/push kroz Forgejo), i pokrenuli isti filter:

```
Lines: 3286 lines, 0 ignored, 0 matched, 3286 missed
```

**Nula matcha.** Filter precizno razlikuje scanner pattern-e od legitimnog saobraćaja. Posebno važno: `.git` segmenti u legitimnim git clone URL-ovima (npr. `/bringout/mojrepo.git/info/refs`) nisu matcheni, jer regex zahtijeva da tačka bude **direktno nakon slash-a** — a u legitimnom URL-u imamo `repo.git` gdje je `.git` prefixovan sa imenom repo-a.

## Ban u akciji

Nakon switch-a u produkciju, fail2ban je istog trena počeo detektovati i banovati napadače. Evo kako izgleda `fail2ban-client status` na oba host-a nakon sat vremena rada:

```
# hetzner-1:
Status for the jail: sshd
   Currently banned:  3
   Banned IP list:    186.96.145.241 195.178.110.30 45.148.10.183

# router-7:
Status for the jail: nginx-secrets-hunter
   Currently banned:  2

Status for the jail: nginx-botsearch
   Currently banned:  1
```

Svi banovi su od IP-ova čije probe smo već vidjeli u historijskom log-u. fail2ban efektivno "dočeka" napadača prvi put kad se vrati, a progressive bans garantuju da svaki sljedeći pokušaj bude eksponencijalno skuplji.

## Napomene o operacijama

Nekoliko korisnih komandi koje koristimo za monitoring i debugging:

```bash
# Live status jail-a
fail2ban-client status sshd
fail2ban-client status nginx-secrets-hunter

# Ko je trenutno banovan
fail2ban-client status sshd | grep 'Banned IP'

# Historija banova iz journal-a
journalctl -u fail2ban --since '24 hours ago' | grep -E 'Ban |Unban '

# Ručno otpustiti IP (ako je greška)
fail2ban-client set sshd unbanip 1.2.3.4

# Runtime whitelist (gubi se na restart)
fail2ban-client set sshd addignoreip 1.2.3.4

# Testiranje filter-a protiv stvarnog log-a bez banovanja
fail2ban-regex /var/log/nginx/access.log /etc/fail2ban/filter.d/nginx-secrets-hunter.conf
```

Zadnja komanda — `fail2ban-regex` — bila je ključna za razvoj custom filter-a. Omogućava da brzo testiraš regex protiv stvarnog log-a prije nego što nekog banuješ.

## Zaključak

fail2ban je jedan od rijetkih security alata koji je istovremeno jednostavan za konfigurisati i ima mjerljiv pozitivan uticaj na svaki javni server. Na našem setup-u nije trebao ni puni dan rada da se dobije potpuni two-layer setup sa custom filterom.

Pouke iz ove iteracije:

1. **Progressive bans su vrijedni** — jednostavan mehanizam koji pretvara 1-satni ban u 1-sedmični ban za napadače koji se vraćaju. `overalljails = true` osigurava da ne trebaju da skakaju između jail-ova da bi napadali iz iste IP adrese.

2. **Built-in filteri ne pokrivaju sve** — `nginx-botsearch` pokriva klasične pattern-e ali je bio dizajniran prije nego što je "secret file hunter" postao dominantna klasa napada. Custom filter dao je 28x više match-a.

3. **Testirajte regex protiv stvarnog log-a prije deploy-a** — `fail2ban-regex` je spasio od false positive-a koji bi blokirali naše vlastite git operacije. Bez testa protiv stvarnog 3286-red operator log-a, pogrešna regex bi blokirala legitime git push operacije.

4. **Whitelist je prvi red odbrane od samo-ban-a** — loopback, interna mreža, operator client. Bez ovoga, fail2ban je hazard umjesto obrane.

5. **Break-glass put mora biti pripremljen prije strožeg filter-a** — prije nego što smo postavili keys-only SSH na fizičkom serveru, pripremili smo pristup iz dvije nezavisne AWS lokacije. "Sama sebi zakljutčana vrata" je klasičan sysadmin anti-pattern koji se jednostavno izbjegava minimalnim planiranjem.

## Šta dalje

Za narednu iteraciju razmatramo:

- **Custom filter enhancement**: dodavanje SSRF probe pattern-a, Laravel-specifičnih leak-ova, i general path traversal pokušaja
- **Basic auth jail** ako ikada pokrenemo servis sa HTTP basic auth-om
- **Rate limiting jail** za Uptime Kuma SPA (da se masovni scan detektuje preko request rate umjesto URL pattern-a)
- **Tailscale-based whitelist** umjesto hardkodirane operator IP adrese — više robustan na ISP DHCP rotacije

## Napomena

Generisano od strane Claude 🤖

---

Ernad Husremović, hernad@bring.out.ba
