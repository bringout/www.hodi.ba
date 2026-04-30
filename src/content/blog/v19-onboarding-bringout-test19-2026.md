---
title: 'Odoo v19 onboarding na hodi.ba: integracija bringout-test19 u formalni hodi_onboard pipeline (uz auth_oidc, Authelia client, branch-aware skripte)'
description: 'bringout-test19 (Odoo v19 sandbox na hodi-2) je do sad postojao kao "polu-deployan" — DB na Patroni-u, service unit u nix-u, ali bez config/hodi/<instance>/ unosa, bez SSO-a, bez emaila. Ovaj post pokriva integraciju u formalni hodi_onboard pipeline: dodavanje odoo.branch u config schema, dinamičko prepoznavanje res.users m2m polja (groups_id → group_ids u v19), kreiranje 19.0 grane oca-server-auth fork-a sa auth_oidc/auth_oidc_environment wrapperima, novi authelia-client onboarding step koji idempotentno registruje OAuth client kroz infra-hodi. Krajnji rezultat: "Log in with Hodi SSO" radi.'
pubDate: '2026-04-30T14:00:00'
heroImage: '/odoo-v19-sso-login-hero.png'
---

## Postavka

`bringout-test19` je sandbox na Odoo v19 koji je preživio nekoliko dana kao orphan deployment: DB `hodi-bringout-test19` na Patroni klasteru, systemd unit `hodi-odoo-bringout-test19.service` aktivan, ali sve ručno — bez `config/hodi/bringout-test19/` unosa, bez Authelia client-a, bez OIDC postavke u Odoo, bez Stalwart mailbox-a, bez DNS MX/SPF/DMARC zapisa. Login je radio samo preko `admin/admin` web management UI-a.

Cilj: dovesti instancu u formalni `hodi_onboard.py` flow tako da je razlika v16 vs v19 stvar config polja, ne grane skripti. Onboarding chain mora raditi za oba.

## Bakerski recept za novu instancu

Trenutni `hodi_onboard.py` chain (jedan-na-jedan sa skriptama u `profile/hetzner/scripts/`):

```
prerequisites      → SSH konektivnost na ciljne hostove
credentials        → generiše config/hodi/<inst>/credentials.yaml
ldap-users         → kreira korisnike u LLDAP-u (node67)
stalwart-domain    → email domena u Stalwart-u (MX/SPF/DKIM share-uju
                     se sa hodi.ba)
stalwart-users     → mailbox-i za korisnike iz config-a
public-dns         → MX, SPF, DMARC, DKIM CNAME-ovi → infra-24/BIND
                     (master + slave; A je već wildcard *.hodi.ba)
odoo-modules       → rsync addon-a + odoo --init=<modules>
odoo-admin-pw      → preimenuje admin login u podrska@<inst>.hodi.ba,
                     postavlja API key
odoo-smtp          → ir.mail_server prema Stalwart-u
odoo-users         → kreira ostale korisnike preko XMLRPC-a
authelia-client    → registruje OAuth client u infra-hodi/services/
                     hetzner/sso, deploy na node67  (NOVO)
odoo-oidc          → wire-uje auth.oauth.provider u Odoo, link-uje
                     korisnike po LLDAP UUID-u
odoo-company       → company logo + name
```

Za v19 sandbox onboarding je iznio četiri konkretne razlike u odnosu na v16 koje su trebale biti popravljene u skriptama, a ne u individualnim "ifovima" na pozivnim mjestima.

## Razlika 1: `odoo.branch` u config schema

`hodi_resolve_dependencies.py` i `hodi_odoo_install_modules.py` su već imali `--branch 19.0` flag (kojeg sam morao pamtiti i prosljeđivati svaki put). Sada čitaju iz config-a:

```yaml
# config/hodi/bringout-test19/config.yaml
odoo:
  host: hodi-2
  http_port: 8130
  db_name: hodi-bringout-test19
  url: https://bringout-test19.hodi.ba
  branch: "19.0"        # ← novo polje
```

Branch resolution priority u skriptama:

```python
if branch is None:
    branch = (config.get("odoo") or {}).get("branch") or None
# branch == None → packages/      (default v16)
# branch == "19.0" → worktrees/19.0/packages/
```

Default kad polje fali: `None` (= v16 packages tree). Postojeći v16 config-i ne moraju ništa mijenjati.

## Razlika 2: `odoo.host` u config-u

`hodi_odoo_install_modules.py` je hard-codovao `ODOO_HOST = "hodi-1"`. To je preživjelo dok je svaka Odoo instanca živila na hodi-1. Sa premještenom `bringout-test19` na hodi-2, rsync je išao u krivu virtualku.

Fix: rebind module-globalnog `ODOO_HOST` iz `config.odoo.host` na startu `main()`-a:

```python
global ODOO_HOST
ODOO_HOST = (config.get("odoo") or {}).get("host") or ODOO_HOST
```

Default ostaje `"hodi-1"` ako polje fali — back-compat sa svim postojećim v16 config-ima.

## Razlika 3: `groups_id` → `group_ids` u Odoo v19 res.users

`hodi_odoo_create_users.py` je padao na:

```
ValueError: Invalid field 'groups_id' in 'res.users'
```

U Odoo v19 m2m polje na `res.users` je preimenovano iz `groups_id` u `group_ids` (zajedno sa `all_group_ids` computed varijantom). Tabela `res_groups_users_rel` u DB-u nije promijenjena — samo ORM polje.

Fix: probe-aj polje preko `fields_get` na startu, koristi koje god je prisutno:

```python
user_fields = models.execute_kw(
    db, uid, pw, "res.users", "fields_get", [],
    {"attributes": ["type"]},
)
if "group_ids" in user_fields:
    groups_field = "group_ids"      # v19+
elif "groups_id" in user_fields:
    groups_field = "groups_id"      # v16
else:
    sys.exit("ERROR: neither field present")
```

Ne moramo otvarati script za svaku novu Odoo verziju — dinamičko prepoznavanje pokriva sve buduće rename-ove dok god se odluka može donijeti iz `fields_get`-a.

## Razlika 4: oca-server-auth nije imao 19.0 granu

Bringout fork `bringout/oca-server-auth` ima `master` granu (sa `odoo-bringout-oca-server-auth-<addon>/<addon>/` wrap strukturom za svaki OCA addon — auth_oidc, auth_oidc_environment, auth_saml, vault, …). Za v19 — ne postoji.

OCA upstream `OCA/server-auth` IMA 19.0 granu (potvrđeno preko `git ls-remote`), pa je samo trebalo:

1. Napraviti orphan granu `19.0-clean` lokalno, copy upstream/19.0 tree-a u njoj.
2. Workflow fajlovi (`/.github/workflows/pre-commit.yml`) se moraju strip-ovati prije push-a — naš OAuth-app GitHub token nema `workflow` scope, push se odbija.
3. Push na `bringout/oca-server-auth:19.0`.
4. Drugi push: dodati `odoo-bringout-oca-server-auth-auth_oidc/` wrapper koji je nedostajao (ostali addon-i su završili u prvom push-u zbog cwd-relative checkout-a, ali auth_oidc je sletio na pogrešno mjesto).
5. Lokalni worktree: `git worktree add worktrees/19.0/packages/oca-server-auth/ origin/19.0`.

`hodi_odoo_install_modules.py` je sad mogao naći paket.

## Razlika 5: addons_path mora pokriti `addons/19.0`

`hodi-odoo` nix modul postavlja `addons_path` na:

```
<bundled odoo-addons>,/var/lib/<stateDir>/addons
```

Ali `install_modules` rsynca u `/var/lib/<stateDir>/addons/19.0/<addon>/` (matching v16 layout convention — gdje je rsync-ani `addons/16.0/` zapravo bio i ostao mrtav teret jer je v16 koristio `odoo-sso-addons` iz nix-store-a). Bez verzionog suffixa u `addons_path`, `auth_oidc` na disku nikad ne bi bio loadan.

Per-instance fix u `infra-hodi/hosts/hetzner/hodi-2/default.nix`:

```nix
bringout-test19 = {
  ...
  addonsPath = "${pkgs.odoo19.passthru.addonsPath},/var/lib/hodi-bringout-test19/addons/19.0";
};
```

Trailing fragment se appenda u `addons_path` u `odoo.conf`-u — sad rsync-ani addon biva discovered.

## NOVO: `authelia-client` korak

Prije ovog session-a, OIDC bring-up za novu instancu je padao na prvom klikom kroz "Log in with Hodi SSO" sa:

```
Error: invalid_client
Description: Client authentication failed (e.g., unknown client, no
client authentication included, or unsupported authentication method).

Hint: The requested OAuth 2.0 Client does not exist.
```

Razlog: Odoo strana je bila wired-up (auth.oauth.provider sa `client_id = "odoo-<instance>"`), ali Authelia strana (`identity_providers.oidc.clients` lista u `infra-hodi/services/hetzner/sso/default.nix`) nije imala odgovarajući entry. Ručno editovanje, commit, push, `colmena apply --on node67` nije bilo automatizovano.

`hodi_authelia_client.py` ovaj session radi:

1. Čita `config.yaml` (instance, odoo.url, sso.client_secret_suffix).
2. Idempotentno (regex check po `client_id = "odoo-<instance>"`) ubacuje client block u `infra-hodi/services/hetzner/sso/default.nix`:

```nix
{
  client_id = "odoo-bringout-test19";
  client_name = "Odoo Bringout (test19)";
  client_secret = "$plaintext$odoo-bringout-test19-client-secret";
  token_endpoint_auth_method = "client_secret_basic";
  redirect_uris = [
    "https://bringout-test19.hodi.ba/auth_oauth/signin"
  ];
  scopes = [ "openid" "email" "profile" ];
  authorization_policy = "one_factor";
}
```

3. Commit + push infra-hodi.
4. `colmena apply --on node67` da se Authelia restart-uje sa novim client-om.
5. Re-run je no-op (already-present check) — ali svejedno re-applya node67 osim ako se ne prosijedi `--no-deploy`.

Dodano kao novi step u `hodi_onboard.py` između `odoo-users` i `odoo-oidc`:

```python
"odoo-users":      ("hodi_odoo_create_users.py",     "Create Odoo users"),
"authelia-client": ("hodi_authelia_client.py",        "Register Authelia OAuth client (node67)"),
"odoo-oidc":       ("create_users_oidc_auth_xmlrpc.py", "Set up OIDC auth for Odoo users"),
```

Logički redoslijed: korisnici postoje u Odoo-u → Authelia client postoji → Odoo OIDC link-ovi se mogu provjeriti.

## Pokretanje za bringout-test19

Cijeli chain je odrađen step-by-step (umjesto `all` koji bi ekspolzivno provjerio svaku grešku istovremeno):

```bash
$ python3 scripts/hodi_onboard.py config/hodi/bringout-test19/config.yaml prerequisites
  hodi-2 ... OK; awslight-paris-1 ... OK; awslight-frankfurt-1 ... OK
$ ... ldap-users          # 4 LDAP users created
$ ... stalwart-domain     # MX/SPF/DKIM share with hodi.ba
$ ... stalwart-users      # 4 mailboxes created
$ ... public-dns          # MX, SPF, DMARC, DKIM CNAMEs verified live on master+slave
$ ... odoo-modules        # auth_oauth + auth_oidc → state=installed
$ ... odoo-admin-pw       # admin → podrska@bringout-test19.hodi.ba
$ ... odoo-smtp           # ir.mail_server #1 created
$ ... odoo-users          # Ernad (id=5), Jasmin (id=6), Admir (id=7) created
$ ... authelia-client     # Authelia OIDC client registered, node67 reloaded
$ ... odoo-oidc           # 4 users linked to OIDC by LLDAP UUID
$ ... odoo-company        # company logo + name
```

## Rezultat

Login screen na `https://bringout-test19.hodi.ba/web/login` (gornja slika): ispod standardnog Odoo email/password forme stoji **"Log in with Hodi SSO"** dugme. Klik vodi kroz Authelia → LLDAP → natrag u Odoo, već-registrovani korisnici se logiraju bez password-a.

| Provjera | Rezultat |
|----------|----------|
| `auth_oauth.state` | `installed` |
| `auth_oidc.state`  | `installed` |
| `auth.oauth.provider` "Hodi SSO (Authelia)" | enabled, `client_id = odoo-bringout-test19` |
| Authelia `identity_providers.oidc.clients[].client_id == "odoo-bringout-test19"` | ✓ |
| 4 res.users linked to OIDC (oauth_uid set) | ✓ |
| Stalwart bringout-test19.hodi.ba mailbox-i | 4 |
| BIND zone (MX, SPF, DMARC, DKIM CNAME) | live na oba DNS servera |
| `https://bringout-test19.hodi.ba/web/login` | HTTP 200 |

## Šta je naučeno

- **Schema-driven flow**: čim se `odoo.branch` i `odoo.host` čitaju iz config-a, isti `hodi_onboard.py` pokriva v16 (bringout, bringout-test, ...) i v19 (bringout-test19) bez per-instance grana u skriptama.
- **Dinamičko polje-name probe**: `fields_get` na startu skripte je jeftino i pokriva sve buduće Odoo rename-ove (auth_oauth's `oauth_uid`, res.partner-ov `child_ids`, etc.). Bolje od hardcode-ane verzije.
- **Authelia se mora vidjeti zajedno sa Odoo OIDC**: dva strane jednog handshake-a, oba moraju biti deklarisana zajedno. Skriptirani `authelia-client` step je nedostajao — preživljavalo se ručnim editom dok god je bilo "samo jedan instance po kvartalu". Sada je deo standardnog chain-a.
- **Fork i upstream se moraju koegzistirati**: bringout fork ima 16.0 wrap strukturu, OCA upstream ima flat 19.0 — port 19.0 grane u fork je copy + fix-up commit. Workflow-strip je obavezan preludij za OAuth-app token-e.

## Napomena

Generisano od strane Claude 🤖

---

Ernad Husremović, hernad@bring.out.ba
