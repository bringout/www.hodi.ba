---
title: 'Kada Chromium tiho proguta print job: --disable-features=EnableOopPrintDrivers na Arch + Wayland'
description: 'Postmortem: korisnik prijavi "prvi PDF stampa, drugi ignorise" na Lexmark mreznom printeru. Kroz CUPS error_log lako se zalutati u false-flag tragove (TLS cert mismatch na auto-discovered IPPS queue, cups-browsed koji opet pravi "broken" queue). Pravi uzrok je sasvim drugdje: Chromium 146 OOP print backend salje job na praznu destinaciju, a CUPS-u nista ne stigne. Chromium pri tome veselo loguje "Printing completed via service". Fix: --disable-features=EnableOopPrintDrivers u ~/.config/chromium-flags.conf.'
pubDate: '2026-04-28T09:10:00'
heroImage: '/chromium-oop-print-hero.svg'
---

## Simptom

Korisnik na desktopu (Arch Linux + Hyprland + Chromium 146.0.7680.177) prijavi obican slucaj:

> "Pokrenem stampu PDF-a iz Chromiuma, prvi izadje. Posaljem drugi — nista. Treci — nista. Samo prvi posao odradi, sve poslije njega tiho ignorise."

Mrezni printer (Lexmark MB2400 na 192.168.168.146) je radio do juce. CUPS lokalno na masini, nista posebno.

Ovo izgleda kao standardna CUPS prica: queue se zaustavi nakon greske backend-a (`ErrorPolicy stop-printer`), pa drugi job stoji u redu i nikad ne ide. Pa krenemo da gledamo CUPS.

I tu pocnu **false-flag tragovi**.

## False flag #1: TLS cert mismatch na IPPS queue-u

`lpstat -p` pokazuje dva queue-a:

```
printer Lexmark-MB2400        is idle.  enabled       (socket://192.168.168.146:9100)
printer Lexmark_MB2442adwe_4  is idle.  enabled       (implicitclass://Lexmark_MB2442adwe_4/)
```

Drugi queue je auto-discovered IPPS varijanta istog fizickog uredjaja, kreiran preko `cups-browsed` + Avahi/mDNS. `tail` `/var/log/cups/error_log`:

```
[Job 193] cfFilterExternal (ipp): Credentials are invalid (New credentials are not valid for name.)
[Job 193] Printer credentials: lexmarkofficesa-3.sa.out.ba ... / 28 Dec 2035 / FF5C...
[Job 193] Stored credentials:  lexmarkofficesa-3.sa.out.ba ... / 22 Jul 2035 / 1EEA...
[Job 193] STATE: +cups-pki-invalid
[Job 193] Printer stopped due to backend errors
[Job 193] printer-state-reasons=cups-pki-invalid,paused
```

Self-signed certifikat na printeru se promijenio (Lexmark ga mijenja sam povremeno), CUPS jos drzi stari pinned, IPPS konekcija propadne, queue ode u `stopped` stanje. Sve se uklapa: prvi job prodje (queue je tada bio enabled), drugi "stoji" jer je queue paused.

Logican fix izgleda kao: ocistiti staru cert keseh, ili zaobici IPPS i koristiti `socket://` na port 9100. Drugi `Lexmark-MB2400` queue vec radi tako, fizicki isti uredjaj, isti IP — pa zasto i drugi queue ne tako.

**Trag je pogresan.** Da, `Lexmark_MB2442adwe_4` jeste broken. Ali to nije razlog zasto stampa propada — niko ne salje na njega, default je `Lexmark-MB2400`.

## False flag #2: cups-browsed pravi queue koji ne treba

Brisem broken queue:

```bash
sudo lpadmin -x Lexmark_MB2442adwe_4
```

Sekundu kasnije, `lpstat -p` ga pokaze nazad. `access_log`:

```
08:45:14  CUPS-Delete-Printer successful-ok
08:45:15  CUPS-Add-Modify-Printer successful-ok    ← cups-browsed ga vrati
```

`cups-browsed` agresivno auto-kreira queue za sve sto vidi preko mDNS-a. Disable-am ga:

```bash
sudo systemctl disable --now cups-browsed
sudo lpadmin -x Lexmark_MB2442adwe_4
```

OK, sada ostaje samo zdravi `Lexmark-MB2400` queue. Korisnik salje stampu. **I dalje ne radi.**

To je trenutak gdje napustim CUPS hipotezu.

## Pravi trag: CUPS log je prazan

```bash
date                              # 09:01:15
sudo tail -10 /var/log/cups/access_log | grep "POST /printers/Lexmark"
```

Sve POST-ove na `/printers/Lexmark-MB2400` koje vidim — najnoviji je iz **8:54:22**. To je bio prvi (uspjesni) korisnikov pokusaj. Od tada — `cups-browsed` disable, novi pokusaji stampe — nista. Nijedan IPP zahtjev nije stigao do `cupsd`-a.

Drugim rijecima: stampa propada **prije** nego sto job napusti Chromium. CUPS je nevin. Svaki sat koji sam potrosio gledajuci `/var/log/cups/error_log` je bio izgubljen.

## Hvatanje Chromiuma na djelu

Ubijem sve Chromium procese, pokrenem ga sa logovanjem:

```bash
chromium --enable-logging=stderr --v=1 > /tmp/chromium-print.log 2>&1
```

Korisnik pokrene stampu. Filter loga na print/cups linije:

```
local_printer_handler_default.cc:184  Getting default printer via service
local_printer_handler_default.cc:293  Default Printer from service: Lexmark-MB2400
print_backend_cups.cc:138             CUPS: using cupsEnumDests to enumerate printers
print_backend_cups.cc:187             CUPS: Enumerated printers, # of printers: 1
print_backend_cups.cc:245             CUPS: Getting caps and defaults, printer name: Lexmark-MB2400
cups_helper.cc:873                    Paper list size - 19
print_preview_handler.cc:1015         Get printer capabilities finished
print_preview_handler.cc:690          Print preview request start
```

Do ovdje sve idealno: Chromium pita `cupsd` koji printeri postoje, dobije `Lexmark-MB2400`, ucita capabilities, prikaze preview. Sve OK.

Zatim korisnik pritisne **Print**:

```
printer_query_oop.cc:243              Updating print settings via service for Lexmark-MB2400
print_dialog_gtk.cc:367               Using listed paper size
printer_query_oop.cc:281              Update print settings via service complete for Lexmark-MB2400

print_job_worker_oop.cc:107           Start printing document 4 to                     ← prazno
print_job_worker_oop.cc:463           Starting printing via service for to `` for document 4
print_job_worker_oop.cc:302           Spooling job to print via service
print_job_worker_oop.cc:525           Sending document 4 to `` for printing            ← prazno
print_job_worker_oop.cc:197           Rendered printed document via service for document 4
print_job_worker_oop.cc:540           Sending document done for document 4
print_job_worker_oop.cc:214           Printing completed via service for document 4    ← uspjeh??
```

Pogledaj te tri kriticne linije:

```
Start printing document 4 to
Starting printing via service for to `` for document 4
Sending document 4 to `` for printing
```

**Destinacija je prazan string.** Ne `Lexmark-MB2400`. Dva backtick-a — `` `` `` — sve sto stoji izmedju je literalna prazna duzina. Job ode u OOP (out-of-process) print backend service Chromium-a, taj service ga "isporuci" u nista, i posto se nista konkretno nije sruisilo — Chromium loguje **"Printing completed via service"**.

Sa korisnikove strane: dialog se zatvori normalno. Bez crvene poruke, bez toast-a, bez stuck spinera. Ostavi utisak da je odstampano. A papir nikad ne izadje.

## Zasto OOP print backend?

Chromium poslednjih verzija razdvaja print logiku u zaseban proces (`OopPrintDrivers` feature flag) iz dva razloga:

1. **Sandboxing** — print drajveri (CUPS klijent, GTK print dialog) imaju svoj sigurnosni domen, bez direktnog pristupa renderer-u
2. **Stability** — pad u print backendu ne ubija tab/stranicu

Na Linuxu, OOP print backend komunicira sa GTK print dialogom (`print_dialog_gtk.cc`). Pod Wayland-om sa Hyprland kompozitorom + GTK4 + recent Chromium build (146) — komunikacija se prekine na pola: Chromium dobije capabilities preko CUPS-a, render-uje preview, ali kad treba **proslijediti destinaciju** iz GTK dialoga u OOP service, prosljedjuje prazan string.

Ovo je relativno cest bug i pojavljuje se samo na nekim kombinacijama (kompozitor + GTK verzija + Chromium build). Drugi `lp` iz shell-a radi savrseno kroz isti CUPS — sto i jeste znak da je problem **iznad** CUPS sloja.

## Fix

Ugasi OOP print backend, neka stampa ide u glavnom procesu kao u starijim verzijama Chromium-a:

```bash
# ~/.config/chromium-flags.conf
--ozone-platform=wayland
--ozone-platform-hint=wayland
--enable-features=TouchpadOverscrollHistoryNavigation
--load-extension=...
--disable-features=EnableOopPrintDrivers     # ← ovo
```

Restart Chromium-a. Test:

```
08:54:22  POST /printers/Lexmark-MB2400  Print-Job successful-ok    (prvi PDF — OK)
09:12:08  POST /printers/Lexmark-MB2400  Print-Job successful-ok    (drugi PDF — OK)
09:12:34  POST /printers/Lexmark-MB2400  Print-Job successful-ok    (treci PDF — OK)
```

`page_log` pokazuje sve tri stranice odstampane. CUPS je sada zapravo **vidi** poslove. Job destinacija u Chromium logu nije vise prazna.

## Sta naucili

1. **CUPS error_log nije prvi sumnjivac kad print propadne tiho.** Ako Chromium kaze "Printing completed" ali u `/var/log/cups/access_log` nema POST-a u istom prozoru vremena — job nije nikad napustio Chromium. CUPS ne moze odgovoriti za ono sto nije primio. Provjeri `access_log` za IPP saobracaj **prije** nego sto satima debate-ujes `error_log`.

2. **`tail -f /var/log/cups/access_log` je dragocjen alat.** Pokazuje da li klijent uopste razgovara sa cupsd-om. Bez njega bismo i dalje mijenjali queue-ove i resetovali certifikate.

3. **Chromium-ov OOP print backend ima narocito Linux-Wayland edge case-ove.** Pod GTK4 + recent kompozitorom prazna destinacija nije signalizirana kao greska — sigurnosno-orjentisana arhitektura ovdje radi protiv dijagnostike. `--disable-features=EnableOopPrintDrivers` vraca starije, predvidljivo ponasanje.

4. **`chromium --enable-logging=stderr --v=1` je rezervna provjera kad GUI nista ne kaze.** Linije iz `print_job_worker_oop.cc` direktno odaju da li destinacija stigne kompletno. Bez njih ne bismo znali sta da popravljamo.

5. **Auto-discovered IPPS queue-ovi (cups-browsed + mDNS Lexmark uredjaja) se isplate samo ako certifikat printera ne rotira sam.** Lexmark MB2442adwe ga rotira → preko `socket://...:9100` (raw AppSocket) je stabilnije od IPPS-a. Disable-uj `cups-browsed` da ne pravi paralelni queue koji ce se rusiti.

Persistencija fixa za sva buduca pokretanja:

```bash
echo '--disable-features=EnableOopPrintDrivers' >> ~/.config/chromium-flags.conf
```

Arch Chromium PKGBUILD pokupi taj fajl pri pokretanju (`/usr/bin/chromium` wrapper).

## Napomena

Generisano od strane Claude 🤖

---

Ernad Husremović, hernad@bring.out.ba
