---
title: 'Mobilna naslovna strana www.hodi.ba — hamburger meni'
description: 'Kratka popravka: na telefonima se navigacija sada skriva iza hamburger dugmeta, a hero logo i pozdrav su bliže jedno drugom.'
pubDate: '2026-04-11T12:15:00'
heroImage: '/mobile-hamburger-hero.svg'
---

Mali, ali primjetan popravak na naslovnoj strani [www.hodi.ba](https://www.hodi.ba) — sada je ljepša na telefonu.

## Šta je bilo

Na malim ekranima se gornja navigacija (*Početna*, *O nama*, *Blog*, *KEP verifikator*, *Webmail*) prelamala u dva reda. Izgledalo je gusto, linkovi su bili tijesni za prst, a ispod logo-a je ostajalo puno praznog prostora prije pozdrava.

![Stara verzija — navigacija se prelama u dva reda](/mobile-prije-hamburger.png)

## Šta je promijenjeno

- Ispod 768 px širine ekrana, navigacija se **skriva iza hamburger dugmeta** u gornjem desnom uglu.
- Kad se dugme otvori, linkovi se prikazuju kao vertikalni *drawer* preko stranice, sa tap target-ima od oko 44 px — taman toliko da se lako pogode prstom.
- Cijeli toggle radi **bez JavaScript-a** — samo CSS, kroz `input[type=checkbox]:checked ~ .links` pattern. Jedno dugme, nula kilobajta JS-a.
- Hero dio je dobio tješnji padding i malo manji logo, tako da *"Dobrodošli!"* sada sjedi odmah ispod *hodi!* loga umjesto da lebdi u praznini.

![Nova verzija — hamburger dugme i tješnji hero](/mobile-poslije-hamburger.png)

## Zašto bez JS-a

Zato što nije ni potrebno. CSS checkbox pattern radi isti posao, ne traži nikakvo učitavanje skripti, ne kvari se ako je JavaScript onemogućen, i ne dodaje ni jedan bajt na bundle. Za par linkova u header-u to je taman toliko koliko treba — ništa više.

Izvorni kod: [github.com/bringout/www.hodi.ba](https://github.com/bringout/www.hodi.ba) (commit `929a587`).

## Napomena

Generisano od strane Claude 🤖

---

Ernad Husremović, hernad@bring.out.ba
