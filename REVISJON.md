# Revisjon av Fjern – runde 2 (v2.0.0)

**Dato:** 2026-09-26 · **Revidert versjon:** `27e18f3` (v2.0.0, etter redesign)
**Omfang:** Hele repoet: `server.mjs`, `lib/`, `public/`, `tests/`, CI, dokumentasjon.
**Forrige revisjon:** [`docs/revisjon/REVISJON-v1.md`](docs/revisjon/REVISJON-v1.md) (v1: 47/100, egenvurdert etter utbedring: 83/100).

## Metode

Samme rammeverk som i første runde, slik at skårene kan sammenlignes: ECC-skillsene `production-audit`, `security-review`, `error-handling`, `design-system` (10 dimensjoner + «AI slop»), `frontend-design-direction`, `make-interfaces-feel-better`, `frontend-a11y` og `verification-loop`.

Denne gangen ble koden lest med friske øyne og **uten å gi meg selv fordel av tvilen** for kode jeg skrev i forrige runde. Funn er verifisert der det lot seg gjøre:

- `npm run verify`: 15/15 filer, 34/34 tester. CI grønn på Node 20 og 22.
- Kontrastmåling av alle fargepar (WCAG 2.2).
- Prober mot `lib/` for nøkkellager, SSDP og TLS.
- Chromium-kjøring av grensesnittet gjennom broen (fra forrige runde, uendret kode).

---

## Sammendrag

### Totalskår: **79 / 100**

Forrige runde anslo 83 rett etter utbedringen. Med en strengere gjennomgang lander v2 på **79**. Forskjellen skyldes funn som ikke var synlige før koden var skrevet: Roku-pause som starter avspilling, en Roku-TV som alltid vises som tilkoblet, TLS uten sertifikatlåsing og en race i nøkkellageret.

| # | Område | Vekt | v1 | v2 | Kort begrunnelse |
| --- | --- | --- | --- | --- | --- |
| 1 | Funksjon og korrekthet | 15 % | 4 | 7,5 | Alt grunnleggende virker, men Roku-pause veksler, og det finnes ingen «slå på». |
| 2 | Sikkerhet | 10 % | 7,5 | 8,5 | Sterk lokal modell og CSP. LG-TLS godtar ethvert sertifikat (ingen låsing). |
| 3 | Robusthet | 10 % | 4,5 | 7,5 | Roku-helse sjekkes aldri, LG kobler ikke til igjen selv, race i nøkkellager. |
| 4 | Visuell kvalitet | 15 % | 5 | 8,5 | Stramt token-system og rolig uttrykk. |
| 5 | Egenart | 10 % | 3 | 8 | Ingen AI-mønstre igjen. Stort tomt felt øverst på høye telefoner. |
| 6 | UX | 15 % | 5 | 7,5 | Én skjerm og god tommelsone. Pause-feil, `confirm()`, tekst kan bare legges til. |
| 7 | Tilgjengelighet | 5 % | 6 | 7 | Navn og trykkflater er gode. Knappekanter har for lav kontrast (1,2–1,5:1). |
| 8 | PWA og ytelse | 5 % | 6,5 | 8,5 | 36 KB, virker uten bro, SVG-ikon og skjermbilder. |
| 9 | Kodekvalitet | 5 % | 4 | 8 | Lesbare moduler og testbar bro. `app.js` er én fil uten tester. |
| 10 | Test, CI og dokumentasjon | 10 % | 2,5 | 7,5 | 34 tester og CI. Ingen tester for grensesnittet, og TLS-stien er bare testet manuelt. |

**Production audit (ECC): 78/100, «launchable with caveats».** Ingen blokkerende funn. Taket er 84 inntil appen er testet ende til ende mot ekte Roku- og LG-TV-er.

| Alvorlighet | Antall |
| --- | --- |
| 🔴 Kritisk | 0 |
| 🟠 Høy | 3 |
| 🟡 Middels | 7 |
| 🔵 Lav | 9 |

---

## 🟠 Høy

### H1. Roku: «Pause» starter avspilling når videoen allerede står på pause
`lib/roku.mjs:9` mapper `Pause` til `Play`, fordi Roku ECP bare har én play/pause-tast. Grensesnittet viser likevel to knapper (▶ og ⏸). Trykker brukeren ⏸ på en video som allerede er pauset, starter den igjen. Det er det motsatte av det knappen lover.
**Tiltak:** Broen returnerer hvilke kommandoer TV-typen støtter (`capabilities`) i `/api/status`. For Roku viser grensesnittet én kombinert ⏯-knapp. LG beholder to knapper.

### H2. Roku vises alltid som tilkoblet
`server.mjs:73` svarer `ready: true` for Roku uten å sjekke TV-en. Er TV-en slått av ved strømbryteren eller har fått ny IP, lyser statusprikken grønt, og hvert trykk gir en feilmelding.
**Tiltak:** Lett helsesjekk (`/query/device-info`, 1,5 s tidsavbrudd), bufret i 10 s og brukt i `/api/status`. Ved feil: `ready: false` og en tydelig melding.

### H3. LG: TLS uten sertifikatlåsing
`lib/lg.mjs:102` åpner `wss://:3001` med `insecureTls: true`, fordi LG bruker selvsignerte sertifikater. Det er nødvendig, men betyr at en angriper på samme Wi‑Fi kan utgi seg for TV-en (ARP-spoofing) og få tak i klientnøkkelen. Nøkkelen gir full kontroll over TV-en.
**Tiltak:** Trust-on-first-use. Lagre SHA-256-fingeravtrykket til TV-ens sertifikat sammen med nøkkelen ved første paring. Senere tilkoblinger avvises hvis avtrykket er endret, med valget «Par på nytt» i grensesnittet.

---

## 🟡 Middels

| # | Hvor | Funn | Evidens | Tiltak |
| --- | --- | --- | --- | --- |
| M1 | `lib/lg.mjs` | LG kobler ikke til igjen av seg selv etter standby, Wi‑Fi-bytte eller når pekersocketen faller ut. Brukeren må åpne TV-listen og trykke på TV-en. | Kodelesing (`close`-lytteren setter bare tilstand) | Gjenoppkobling med økende ventetid (1, 2, 4, 8 s) når en tidligere klar forbindelse faller ut, og når appen blir synlig igjen. |
| M2 | `lib/lg.mjs:52` | Race i nøkkellageret: to samtidige lagringer bruker samme midlertidige filnavn. | **Verifisert:** én skriving feilet med `ENOENT`, og én nøkkel gikk tapt. | Skriv én om gangen (promise-kjede) og bruk unikt midlertidig filnavn. |
| M3 | `public/style.css` | Knappekanter og knappeflater har kontrast 1,5:1 og 1,2:1 mot bakgrunnen. WCAG 1.4.11 krever 3:1 for grensene til en komponent. | **Målt** (se tabell under) | `--line` til `#606166` (3,1:1). Behold den mørke flaten. |
| M4 | Hele appen | Ingen «slå på». LG støtter Wake-on-LAN når «Slå på via Wi‑Fi» er aktivert, og Roku-TV-er tar imot `PowerOn` i hvilemodus. | Funksjonshull | Lagre MAC-adressen ved LG-paring og send en magisk pakke. Roku: `keypress/PowerOn`. Strømknappen blir en av/på-bryter. |
| M5 | `public/style.css` (`.remote`) | Stort tomt felt øverst på høye telefoner: på 390×844 er omtrent 45 % av skjermen tom. Det er et bevisst valg for tommelsonen, men ser uferdig ut. | Skjermbilde `etter/01-kontroll.png` | Bruk feltet til noe nyttig uten å flytte kontrollene: raske valg for kilde og apper (Roku `query/apps`, LG `getInputList`), eller en stor «Tast inn»-flate. |
| M6 | `lib/ssdp.mjs`, `lib/roku.mjs` | Ubegrenset input fra lokalnettet: SSDP-søket har ingen grense for antall enheter, og `rokuProbe` leser hele svaret uten størrelsesgrense. | **Verifisert:** 300 falske svar ble godtatt. | Maks 32 enheter per søk og 64 KB per svar. |
| M7 | `tests/`, `public/app.js` | Grensesnittlogikken har ingen automatiske tester, og TLS-stien i WebSocket-klienten er bare testet manuelt. | Dekningsgjennomgang | Flytt ren logikk (IP-validering, tilstand til tekst, liste-sammenslåing) til en egen modul med `node:test`. Legg et test-sertifikat i `tests/fixtures/` og test `wss://` i CI. |

### Kontrastmåling (WCAG 2.2)

| Par | Kontrast | Krav | Status |
| --- | --- | --- | --- |
| Tekst på bakgrunn | 16,1:1 | 4,5:1 | ✅ |
| Dempet tekst på knapp | 6,2:1 | 4,5:1 | ✅ |
| OK-tekst på oransje | 6,7:1 | 4,5:1 | ✅ |
| Oransje på knapp (valgt TV-type) | 5,6:1 | 3:1 | ✅ |
| Knappekant mot bakgrunn | **1,5:1** | 3:1 | ❌ M3 |
| Knappeflate mot bakgrunn | **1,2:1** | 3:1 | ❌ M3 |

---

## 🔵 Lav

1. **Kanalknapper på Roku-spillere:** Roku Express og Ultra er ikke TV-er og avviser kanaltastene. `device-info` har `is-tv`. Skjul kanalvelgeren når verdien er `false`.
2. **`confirm()` ved sletting** (`public/app.js:153`) bruker nettleserens standarddialog og bryter med designet. Bruk arket som de andre dialogene, eller «angre» i en toast.
3. **Etiketten «Kan»** på kanalvelgeren er uklar (ligner det norske ordet «kan»). Skriv «Kanal».
4. **Skjermleser:** Når TV-en blir klar, skjules statuslinjen, og ingenting blir lest opp. Kunngjør «Tilkoblet til LG OLED Stue» i en skjult `aria-live`-region.
5. **CSP** tillater `img-src data:`, som ikke brukes. Stram inn til `'self'`.
6. **Manuell cacheversjon i service workeren:** `CACHE = 'fjern-v2'` må økes for hånd. Legg til en test som feiler hvis versjonen ikke samsvarer med `package.json`.
7. **iOS:** `-webkit-touch-callout: none` mangler, så langt trykk kan vise systemmeny. Android er ikke berørt.
8. **Tekst til TV:** Man kan bare legge til tekst. Roku har `Backspace` i ECP. Legg til en «Slett»-knapp i tekstarket.
9. **Ingen `.editorconfig`** eller felles formatregler. Lite prosjekt, men gjør bidrag enklere.

---

## Design: «AI slop»-sjekk på nytt

| Mønster fra v1 | Status i v2 |
| --- | --- |
| Heltoverskrift, eyebrows, slagord | ✅ Borte |
| Navy/gull, gradienter, glød | ✅ Borte. Grafitt + én funksjonell aksent. |
| Kort i kort, `↗` overalt | ✅ Borte |
| Unicode-ikoner, 3D-app-ikon | ✅ Erstattet av ett SVG-sett og et flatt ikon |
| Generisk font som aldri lastes | ✅ Ærlig systemfont |
| **Nytt:** Stort tomt felt øverst | ⚠️ M5 |

**Visuell audit (ECC `design-system`): 8,2/10.** Uendret fra forrige runde bortsett fra tilgjengelighet (8 → 6,5 etter kontrastmålingen). Snittet går dermed ned fra 8,3.

---

## Det som er bra ✅

- Streng lokal sikkerhetsmodell: `127.0.0.1`, Host/Origin-sjekk, hviteliste for IP og kommandoer, CSP, nøkkelfil 0600 og `data/` utenfor git.
- Alle feil når brukeren på norsk, og interne detaljer blir i loggen.
- Ingen npm-avhengigheter, også for WebSocket med TLS.
- Fjernkontrollen passer på én skjerm fra 360×640, med 48 px trykkflater, hold-for-å-gjenta og tilbakemelding per knapp.
- 12 farge-tokens, 3 radier og 5 skriftstørrelser. Ingen gradienter.
- 34 tester og CI på to Node-versjoner.

---

## Anbefalt plan og forventet skår

| Fase | Innhold | Funn | Innsats | Forventet |
| --- | --- | --- | --- | --- |
| **A. Raske rettelser** | Roku-pause og kanalvisning via capabilities, Roku-helsesjekk, nøkkellager-kø, grenser for SSDP og svarstørrelse, CSP, «Kanal» | H1, H2, M2, M6, L1, L3, L5 | Liten | ~84 |
| **B. Trygghet og tilgjengelighet** | TLS-låsing (TOFU), LG-gjenoppkobling, kantkontrast, skjermleserkunngjøring, touch-callout | H3, M1, M3, L4, L7 | Middels | ~87 |
| **C. Funksjon og design** | Slå på (WOL/PowerOn), bruk av toppfeltet (kilder/apper), slettedialog i arket, Slett-knapp for tekst | M4, M5, L2, L8 | Middels–stor | ~90 |
| **D. Kvalitetssikring** | Tester for grensesnittlogikk, TLS-test i CI, test av cacheversjon, `.editorconfig` | M7, L6, L9 | Liten | ~91 |
| **E. Ekte TV-er** | Ende-til-ende på Roku og LG, TalkBack | – | Krever deg og TV-ene | 92+ |

Fase A og B gir mest per time. Fase C er den største designendringen og bør avklares før den bygges: hva skal toppfeltet brukes til?
