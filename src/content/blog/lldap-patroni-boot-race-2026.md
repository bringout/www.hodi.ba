---
title: 'Incident: 502 na auth.hodi.ba — LLDAP protiv Patroni VIP-a u boot race-u'
description: 'Nakon reboota hetzner-1 servera, LLDAP je pao jer Patroni Postgres VIP još nije bio spreman, što je povuklo Authelia OIDC dolje i blokiralo prijavu na Roundcube. Dijagnostika, recovery i reboot-safe fix u NixOS-u.'
pubDate: '2026-04-11T17:00:00'
heroImage: '/lldap-patroni-race-hero.svg'
---

Kratki post-mortem drugog incidenta istog dana. Nakon što smo [vratili `www.hodi.ba` nakon e1000e hang-a](/blog/incident-report-nic-hang-2026/) i uradili [mobilni redesign header-a](/blog/mobile-hamburger-2026/), bacio nas je još jedan problem: `https://auth.hodi.ba` počeo je vraćati **502 Bad Gateway** na OIDC authorization endpoint. Svaka prijava na Roundcube (i potencijalno na Forgejo, Odoo, i druge OIDC klijente) je odmah pucala.

## Simptom

Korisnik je prijavio da pokušaj prijave na webmail preusmjerava na:

```
https://auth.hodi.ba/api/oidc/authorization?response_type=code&client_id=roundcube&...
```

i vraća **502 Bad Gateway**. `curl` to potvrđuje:

```bash
$ curl -sS -o /dev/null -w "%{http_code}\n" https://auth.hodi.ba/
502
```

## Arhitektura u jednoj slici

SSO stack se sastoji iz tri servisa raspoređena preko više mašina:

| Servis | Host | Port | Uloga |
|---|---|---|---|
| **Authelia** | node67 (`192.168.xxx.xx2`) | 9091 | OIDC provider |
| **LLDAP** | node67 (`192.168.xxx.xx2`) | 3890 (LDAP), 17170 (admin UI) | Direktorij korisnika |
| **Patroni PostgreSQL** | node62–65, VIP `192.168.xxx.xx1` | 5432 | Storage za LLDAP *i* Authelia |

Lanc zavisnosti:

```
nginx (router-7) ──▶ authelia-main (node67:9091)
                          │
                          ├──▶ LLDAP (localhost:3890)
                          │         │
                          │         └──▶ Postgres @ VIP 192.168.xxx.xx1:5432
                          │
                          └──▶ Postgres @ VIP 192.168.xxx.xx1:5432
```

Ako bilo koji član lanca otkaže, **503/502 se vraća prema korisniku**. Ako LLDAP ne može doći do Postgres-a, njegov proces izlazi — a onda Authelia ne može autentikovati korisnike i pravi 502 upstream error u nginx-u.

## Dijagnostika

Prvo smo provjerili šta nginx javlja i da li je Authelia upstream živ:

```bash
$ ssh router-7 'curl -sS -o /dev/null -w "authelia upstream: %{http_code}\n" http://192.168.xxx.xx2:9091/'
authelia upstream: 000
curl: (7) Failed to connect to 192.168.xxx.xx2 port 9091
```

Port je zatvoren. Skok na node67:

```bash
$ ssh node67 'systemctl --failed --no-pager'
● lldap.service  loaded failed failed  Lightweight LDAP server (lldap)
```

Authelia je zapravo bila u `active running` stanju cijelo vrijeme — problem je bio što je LLDAP bio mrtav, pa je authelia-main svaki upit prema LDAP-u vraćala kao grešku, a nginx je to prevodio u 502 prema klijentu.

Pogled u `journalctl -u lldap.service -n 30`:

```
Apr 11 11:48:01 node67 lldap-start[884]: Starting LLDAP version 0.6.1
Apr 11 11:48:04 node67 lldap-start[884]: Error: Connection Error: error communicating with database:
                                          No route to host (os error 113)
Apr 11 11:48:04 node67 systemd[1]: lldap.service: Main process exited, code=exited, status=1/FAILURE
Apr 11 11:48:04 node67 systemd[1]: lldap.service: Failed with result 'exit-code'.
```

LLDAP je pokušao jednom, udario u `No route to host` prema Patroni VIP-u (`192.168.xxx.xx1:5432`), izašao je sa kodom 1, i od tada — **više nikad** nije pokušao. Nije bilo retry-a, nije bilo restart-a, samo permanent `failed` stanje.

## Root cause

Ovo je klasičan boot race između dvije nezavisne mašine:

1. **node67** je startao i `network-online.target` je fire-ao čim je interfejs dobio IP — to je standard network-online semantika.
2. **Patroni cluster** (node62–65) je u tom trenutku još uvijek bio u procesu:
   - etcd je trebao quorum
   - Patroni replika mora iskomunicirati sa etcd-om
   - Leader election se mora završiti
   - Leader mora bind-ati floating VIP `192.168.xxx.xx1` na svoj interfejs
3. **LLDAP** je startao prije nego što se taj lanac završio i probao TCP konekciju na `192.168.xxx.xx1:5432`. Nijedan routing table nije imao rutu za taj IP u tom trenutku (VIP nije bio up ni na jednoj mašini) → kernel vraća `EHOSTUNREACH` → LLDAP izlazi.

Problem nije loša konfiguracija LLDAP-a — problem je što **LLDAP nema ugrađen retry mehanizam pri startup failu**. Ako baza nije dostupna, servis se ne ubija u petlji, samo izađe i ostaje mrtav.

## Odmah recovery

Patroni je do tog trenutka već bio spreman, pa je manual start bio trivijalan:

```bash
ssh node67 systemctl start lldap.service
```

LLDAP je ovaj put pročitao TOML config, uspješno se konektovao na VIP, i startao. Authelia je već bila u `active` stanju i automatski ju je ponovo našla preko `ldap://127.0.0.1:3890`, pa nije bilo potrebno ručno restartovati ništa drugo. `https://auth.hodi.ba` odmah je vratio 200.

## Reboot-safe fix: NixOS `Restart=on-failure`

Restart servisa rješava trenutno stanje, ali ne rješava sutra. Sljedeći reboot bi nas opet doveo na isto mjesto. Pravi fix je da LLDAP **ponavlja pokušaj** dok god Patroni ne postane dostupan.

U nixos konfiguraciji (`services/hetzner/sso/default.nix`) dodali smo sljedeći blok:

```nix
# LLDAP depends on the Patroni Postgres cluster at 192.168.xxx.xx1:5432.
# At boot the VIP / leader election may take several seconds longer than
# this host's network-online.target, and LLDAP exits immediately on
# "No route to host" with no built-in retry. Restart on failure with a
# short backoff until the DB is reachable; unlimited attempts so a
# slower-than-usual Patroni startup never leaves LLDAP dead.
systemd.services.lldap.serviceConfig = {
  Restart = "on-failure";
  RestartSec = "10s";
  StartLimitIntervalSec = 0;
};
```

Sa ovim, scenario izgleda ovako:

| t | Šta se desi |
|---|---|
| 0s | `network-online.target` fire-ao, LLDAP startan |
| 0s+δ | `No route to host` → LLDAP izlazi 1 |
| 10s | systemd restart-uje LLDAP |
| 10s+δ | Još uvijek `No route to host` → izlazi |
| 20s | Restart #2 |
| ... | ... |
| ~35s (tipično) | Patroni VIP je spreman, LLDAP dobije TCP konekciju, config učita, servis stane u `active` |

Systemd ostaje nenadašno uporan jer smo eksplicitno postavili `StartLimitIntervalSec = 0` — default rate limit od 5 restart-ova u 10 sekundi nikad neće okinuti jer je backoff sam po sebi 10 sekundi.

## Zašto ne diramo Authelia

Inicijalni pokušaj je bio da istu politiku postavimo i na `authelia-main.service`, ali nix eval odmah javi:

```
error: The option `systemd.services.authelia-main.serviceConfig.Restart' has
       conflicting definition values:
       - In .../nixos/modules/services/security/authelia.nix': "always"
       - In .../services/hetzner/sso': "on-failure"
```

NixOS Authelia modul već postavlja `Restart = "always"` out-of-the-box — što je u stvari *jače* od `on-failure` (restart-uje i kad servis izađe sa kodom 0). Authelia sama od sebe ostaje živa i nakon što LLDAP dođe nazad automatski reuspostavlja LDAP konekciju na sljedećem requestu. Naš single fix na LLDAP-u je dovoljan.

## Deploy i verifikacija

```bash
python3 scripts/deploy_infra-hodi_on_hetzner-1.py node67 switch
```

Nakon deploy-a:

```bash
$ ssh node67 'systemctl show lldap.service -p Restart -p RestartUSec'
Restart=on-failure
RestartUSec=10s

$ curl -sS -o /dev/null -w "%{http_code}\n" https://auth.hodi.ba/
200

$ curl -sS -o /dev/null -w "%{http_code}\n" \
    "https://auth.hodi.ba/api/oidc/authorization?response_type=code&client_id=roundcube&..."
303
```

303 je ispravan odgovor za OIDC authorization endpoint kad klijent nije prijavljen — znači redirect na Authelia login page.

## Lekcije

1. **Network-online.target nije "usluge-online.target".** Imati IP adresu ne znači da je baza spremna, da je DNS spreman, da je VIP podignut, da je lider izabran. Ne vjerujte ovom target-u više nego što treba.
2. **Svaki servis koji zavisi od mreže mora imati restart policy.** Ako servis vendor nema ugrađen retry — dodaj `Restart=on-failure` u systemd konfiguraciji. Cijena je nula, dobitak je jedan manji incident.
3. **Ako imate SSO, svaki servis u lancu postaje kritičan.** Jedno pogrešno startovanje LLDAP-a povlači Authelia, koja povlači *sve* OIDC klijente (webmail, git, Odoo...). Vidi cijeli lanac kao jedan servis sa SLO-om.
4. **NixOS nudi dovoljno "rezervne pameti" da ovo ne bude problem unaprijed.** Authelia modul je već imao `Restart=always`; LLDAP modul iz nekog razloga nema. Vrijedi radnim danom pregledati svoj `services.*` katalog i označiti one koji nemaju ugrađen retry.

Commit: [`bringout/infra-hodi@8e5cf43c6`](https://github.com/bringout/infra-hodi).

## Napomena

Generisano od strane Claude 🤖

---

Ernad Husremović, hernad@bring.out.ba
