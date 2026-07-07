---
title: 'Šta se dešava u Odoo bazi?! Novi Odoo modul bout_master_data_ne_cackaj'
description: 'Jutarnji debug incident u Odoo bazi: PITR je pokazao kada je artikal vraćen na stare postavke, Forgejo je dao trag do skripte, a završno rješenje je modul koji štiti predefinisane master podatke od ručnih izmjena.'
pubDate: '2026-07-07T21:24:53'
heroImage: '/blog-heroes/odoo-master-data-ne-cackaj-hero.png'
---

Ujutro stigne prijava koja ne izgleda ni malo bezazleno: korisnik tvrdi da mu se artikal vratio na stare postavke. U ERP sistemu je to odmah crveni alarm, jer pitanje nije samo "ko je šta kliknuo", nego da li je baza nekontrolisano promijenila ključni podatak.

Ispostavilo se da problem nije bio u vikend migraciji, niti u nekom "misterioznom" side-efektu. Do uzroka smo došli tek kad smo spojili tri stvari: PITR analizu baze, Forgejo issue/PR memoriju i Odoo semantiku za podatke koji dolaze iz XML/CSV data modula.

## Početna prijava

Podrška prvo vidi simptom: artikal više ne izgleda kako je izgledao prije nekoliko dana.

![Prijava problema kroz interni chat](/debug-pitr/debug_01-1.png)

![Dodatni detalji prijave](/debug-pitr/debug_01-2.png)

![Provjera šta je tačno promijenjeno](/debug-pitr/debug_01-3.png)

![Poređenje sa ranijim stanjem](/debug-pitr/debug_01-4.png)

![Potvrda da je stanje vraćeno na starije vrijednosti](/debug-pitr/debug_01-5.png)

U ovoj fazi jedino znamo da je podatak vraćen unazad. To je najgora vrsta prijave: simptom je jasan, uzrok nije.

## Prvo pitanje: da li su vikend radovi napravili štetu?

Pošto je neposredno prije toga bilo rada na sistemu, prvo pitanje za AI agenta bilo je sasvim racionalno: da li je neka migracija ili servisna intervencija povukla neželjeni efekat?

![Prvo pitanje AI agentu](/debug-pitr/debug_04.png)

Pritom je odmah data i bitna instrukcija: koristiti PITR da ne nagađamo, nego da bazu pogledamo u vremenskoj ravni.

## PITR: iz priče prelazimo u vremensku liniju

Kad baza ima dobar PITR trag, više ne tražimo problem "po osjećaju". Tražimo ga po vremenu.

![Prvi PITR feedback](/debug-pitr/debug_05.png)

Vrlo brzo se vidi prva važna stvar: promjena nije nastala tokom vikend aktivnosti. To odmah sužava prostor i uklanja pogrešnu hipotezu.

![PITR locira stvarni trenutak promjene](/debug-pitr/debug_06.png)

To je ključni momenat. Umjesto široke sumnje nad cijelim sistemom, sada imamo precizan vremenski prozor u kojem se nešto desilo.

## Forgejo kao projektna memorija

Kad znamo vrijeme, sljedeći korak je povezati ga sa stvarnim aktivnostima: issue-ima, PR-ovima i pomoćnim skriptama. Tu Forgejo pokazuje zašto projektna disciplina nije administracija radi administracije, nego operativni alat.

![Uputa da se pregleda Forgejo memorija](/debug-pitr/debug_07.png)

U tom intervalu pronađen je relevantan ticket i skripta koja je bila pokrenuta.

![Pronađen ticket sa tragom do skripte](/debug-pitr/debug_13.png)

Nakon toga slagalica počinje da sjeda na mjesto.

![Prvi dio skripte koja je pokrenula problem](/debug-pitr/debug_14-1.png)

![Drugi dio iste skripte](/debug-pitr/debug_14-2.png)

AI agent je ispravno primijetio i širu pouku: bez Forgejo evidencije i discipline da se promjene vode kroz issue/PR tok, ovaj root-cause bi trajao znatno duže.

![Komentar o značaju Forgejo memorije](/debug-pitr/debug_08.png)

## Zašto je skripta uopšte mogla da vrati artikal?

Tu počinje drugi sloj problema. Sama skripta jeste napravila promjenu, ali ostaje pitanje zašto je baš taj artikal bio zahvaćen.

![Analiza skripte i sumnja na data module](/debug-pitr/debug_09.png)

Pregled vodi do `l10n_ba_data` i sličnih Odoo data modula koji kroz XML i CSV fajlove održavaju predefinisane zapise.

![Ključno pitanje o prirodi podatka](/debug-pitr/debug_10.png)

Drugim riječima: sistem nije proizvoljno izmislio staru vrijednost. Vratio je zapis na vrijednost definisanu u modulu koji ga smatra svojim master podatkom.

## Gdje je stvarni uzrok

Odoo data moduli su jedna od jačih strana platforme. Na isti način održavamo gradove, šifrarnike, početne klasifikacije i druge osnovne podatke. Problem nastaje kad korisnik uzme takav zapis i "reciklira" ga za neku sasvim drugu poslovnu svrhu.

To kratkoročno djeluje praktično, ali tehnički nije stabilno:

1. zapis i dalje ima XMLID i pripada data modulu
2. upgrade ili pomoćna sanaciona skripta mogu ga ponovo uskladiti sa XML/CSV definicijom
3. korisnik onda vidi da mu se "nešto samo vratilo"

Upravo se to ovdje desilo. Problem nije bio korupcija baze, nego sudar između korisničke improvizacije i mehanizma koji legitimno održava predefinisane podatke.

## Dugoročno rješenje: `bout_master_data_ne_cackaj`

Kad je uzrok postao jasan, fokus se prebacio sa istrage na prevenciju. Cilj nije bio samo objasniti incident, nego eliminisati cijelu klasu budućih grešaka.

![Uputa da se napravi novi modul](/debug-pitr/debug_11.png)

![Razrada smjera za novi modul](/debug-pitr/debug_12.png)

AI agent zatim generiše prve verzije modula za više Odoo serija.

![Prva verzija modula](/debug-pitr/debug_15.png)

Nisu svi prijedlozi bili dobri. Dio UX-a i dio implementacionih odluka je odbijen.

![Odbijeni prijedlozi AI agenta](/debug-pitr/debug_16.png)

Usput se vidi i realnost ovakvog rada: kad rješavaš jedan incident paralelno sa v16 -> v19 migracijama, dobiješ dodatni šum u ticketima i mailboxu.

![Sporedni efekti tokom paralelnih aktivnosti](/debug-pitr/debug_17.png)

Prva verzija forma takođe nije bila prihvatljiva bez dorade.

![Prva forma modula prije dorade](/debug-pitr/debug_18.png)

U međuvremenu je donesena i korekcija na strani starog ponašanja: `l10n_ba_data` je vraćen na raniju logiku za `no_update`, da se privremeno ne širi blast radius dok novi guard modul ne preuzme posao.

![Zahtjev za revert prethodne promjene](/debug-pitr/debug_19.png)

Završni rezultat je jednostavan i tačan: korisnik pri pokušaju izmjene dobije jasno upozorenje da radi sa predefinisanim zapisom, umjesto da nehotice proizvede problem koji će isplivati tek na narednom upgrade-u ili sanacionom skriptu.

![Završno ponašanje modula](/debug-pitr/debug_20.png)

## Šta je ovdje stvarno vrijedilo

Ovaj incident je trajao otprilike od 09:00 do 11:00. Većina vremena nije otišla na samo "popravljanje", nego na dokazivanje uzroka. To je normalno. U ovakvim situacijama root-cause je glavni posao.

Stvari koje su ovdje napravile razliku:

1. **PITR** je dao tačan vremenski prozor i izbacio pogrešnu hipotezu o vikend radovima.
2. **Forgejo issue/PR memorija** je spojila trenutak promjene sa konkretnom skriptom i ranijim aktivnostima.
3. **Domensko znanje o Odoo data modulima** je objasnilo zašto se baš taj artikal mogao "vratiti".
4. **Novi guard modul** pretvara jednokratnu istragu u trajnu zaštitu.

## Pouka za rad sa master podacima

Ako zapis dolazi iz Odoo data modula, ne treba ga "reciklirati" za druge namjene. Takav zapis nije običan korisnički unos; on je dio tehničkog ugovora između baze i modula koji ga održava.

Kada podrška i implementacija to tretiraju kao eksplicitno pravilo, ovakvi incidenti postaju rijetki. Kada se to pravilo prešuti, sistem prije ili kasnije vrati zapis na ono što modul smatra ispravnim stanjem.

Ovaj konkretan slučaj je, gledano unazad, više trivijalan nego dramatičan. Ali jutarnja prijava nije izgledala trivijalno, niti je do rješenja bilo moguće doći bez ozbiljne istrage. Upravo zato vrijedi dokumentovati ga.

## Napomena

---

Ernad Husremović, hernad@bring.out.ba
