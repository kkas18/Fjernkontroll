# Revisjon av Fjern – runde 4: full fjernkontroll og visuelt uttrykk (v2.4)

**Dato:** 2026-09-26 · **Revidert versjon:** 2.3.0 på brukerens LG webOS-TV
**Utløser:** Brukeren påpekte at appen ikke er en full fjernkontroll: den mangler talltaster, fargetaster (rød, grønn, gul, blå) og innstillinger, og tastaturet gjør ingenting. Brukeren ber om et profesjonelt, elegant og brukervennlig design.
**Tidligere revisjoner:** [runde 3](docs/revisjon/REVISJON-v3.md) · [runde 2](docs/revisjon/REVISJON-v2.md) · [runde 1](docs/revisjon/REVISJON-v1.md)

> **Status:** Alle funn er utbedret i versjon 2.4.0. Se [Etter utbedring](#etter-utbedring-v240).

## Metode

- ECC `design-system` (10 dimensjoner), `frontend-design-direction` og `make-interfaces-feel-better`.
- En ny dimensjon: **funksjonsdekning**, altså hvor mye av en fysisk LG- eller Roku-fjernkontroll appen dekker.
- LGs komplette liste over knappenavn er hentet fra homebridge-webos-tv (`REMOTE_COMMANDS`). Registrering og YouTube-oppstart er sjekket mot aiowebostv og homebridge-webos-tv.

---

## Før (2.3.0)

### Funksjonsdekning: **55 %**

| Funksjon på fysisk LG-fjernkontroll | 2.3.0 |
| --- | --- |
| Piler, OK, Tilbake, Hjem, volum, kanal, lyd av, av/på | ✅ |
| Avspilling | ✅ |
| Apper | ✅ |
| **Talltaster 0–9, «–», kanalliste** | ❌ |
| **Fargetaster rød, grønn, gul, blå** | ❌ |
| **Innstillinger** | ❌ |
| **Kilde / inngang (HDMI)** | ❌ |
| **Info, programguide, avslutt, teksting, tekst-TV, bildeformat** | ❌ |
| **Søk og tekst** | ⚠️ Tastaturet skrev bare i et felt som allerede var åpent på TV-en, og det var ikke forklart |

### Visuelle funn

| # | Funn | Alvorlighet |
| --- | --- | --- |
| V1 | Mangler halve fjernkontrollen (se over). Brukeren oppfatter appen som uferdig. | 🔴 |
| V2 | Tastaturet «gjør ingenting». LG tar bare imot tekst når skjermtastaturet vises, og appen ga ingen vei til det brukeren faktisk ville: søke på YouTube. | 🟠 |
| V3 | Tilbake, Hjem og Lyd av er tre løse bokser, og avspilling er fire løse bokser. Det ser mer ut som et skjema enn som en fjernkontroll. | 🟡 |
| V4 | Rekkefølgen Hjem–Tilbake–Lyd av er uvant. De fleste fjernkontroller har Tilbake til venstre. | 🔵 |
| V5 | Avspillingsknappene er like store og tunge som navigasjonen, selv om de brukes sjeldnere. | 🔵 |

**Designskår før: 70 / 100** (visuell kvalitet 8,3, men funksjonsdekning 55 % trekker kraftig ned).

---

## Etter utbedring (v2.4.0)

### Funksjonsdekning: **95 %**

| Funksjon | Hvor | LG | Roku |
| --- | --- | --- | --- |
| Talltaster 0–9, «–», kanalliste | **123** | ✅ pekerknapper `0`–`9`, `DASH`, `LIST` | ✅ tall (`Lit_0`–`9`) |
| Fargetaster rød, grønn, gul, blå | **123**, øverst | ✅ `RED` `GREEN` `YELLOW` `BLUE` | – (finnes ikke på Roku) |
| Innstillinger | **Oppsett** | ✅ `MENU` | – |
| Kilde / inngang | **Kilde** | ✅ `tv/getExternalInputList` og `tv/switchInput` | ✅ `tvinput.*` på Roku-TV |
| Info, programguide, kanalliste, teksting, tekst-TV, bildeformat, siste apper, avslutt | **Mer** | ✅ `INFO` `PROGRAM` `LIST` `CC` `TELETEXT` `ASPECT_RATIO` `RECENT` `EXIT` | ✅ Info, Søk, Spol tilbake |
| **Søk på YouTube** | ⌨ **Skriv og søk** | ✅ Starter `youtube.leanback.v4` med søket som `contentTarget` | ✅ ECP `search/browse` med YouTube (837) |
| Skriv i felt på TV, slett, Enter | ⌨ | ✅ IME `insertText`, `deleteCharacters`, `sendEnterKey` | ✅ `Lit_`, `Backspace`, `Enter` |

Knapper TV-en ikke har, skjules automatisk ut fra `capabilities.keys`, som broen sender. Tall- og fargetaster beholder plassen sin, så rutenettet ikke hopper. Det som mangler til 100 %, er taster uten nettverks-API (for eksempel opptak) og musepekeren på LG Magic Remote.

### Visuelle endringer

| Funn | Før | Etter |
| --- | --- | --- |
| V1 | Mangler taster | Snarveisrad: **Kilde · 123 · Oppsett · Mer**. Sjeldne taster ligger i ark, så hovedskjermen er like ren. |
| V2 | Tastaturet gjorde ingenting | **Skriv og søk**: stort felt og primærknappen **Søk på YouTube** (Enter i feltet søker også), i tillegg til «Skriv på TV», slett og Enter. En forklaring står under. |
| V3 | Løse bokser | Sammenhengende **knappegrupper** med skillelinjer (Tilbake · Hjem · Lyd av), slik en fysisk fjernkontroll er bygget. |
| V4 | Hjem først | **Tilbake · Hjem · Lyd av**. |
| V5 | Tung avspilling | Lav, rolig **avspillingslinje** i én gruppe. |

### Skår

| Dimensjon | 2.3.0 | 2.4.0 |
| --- | --- | --- |
| Funksjonsdekning | 5,5 | 9,5 |
| Komponentkonsistens | 9 | 9,5 |
| Informasjonstetthet | 9 | 8,5 (flere taster, men sjeldne ligger i ark) |
| Polish | 8,5 | 9 |
| Brukervennlighet (søk, tekst) | 5 | 9 |
| Øvrige (farge, typografi, rytme, responsivitet, mørk modus, animasjon, tilgjengelighet) | 8,1 | 8,2 |
| **Designskår** | **70** | **88** |

### Verifisering

- `npm run verify`: **71/71**. Nye tester dekker:
  - LG: pekerknapper for tall, farger, guide og innstillinger, Enter via IME.
  - YouTube-søk: `contentTarget` er trygt kodet, så søket ikke kan bryte ut av adressen.
  - Innganger: bare kjente id-er kan velges.
  - Roku: `search/browse` med `provider-id=837`. Roku avviser fargetaster.
  - Capabilities per TV-type.
- `./gradlew testDebugUnitTest assembleRelease`: **15/15**, APK 2.4.0.
- Chromium, 412×915 og 360×800:
  - LG sender `Red`, `Num7`, `Guide`, bytter kilde (`HDMI_2`), søker og åpner `Settings`.
  - Roku skjuler fargetaster, Kilde og Oppsett.
  - Ingen rulling og ingen konsollfeil.

### Gjenstår

1. **YouTube-søket på LG er ikke testet på brukerens TV.** Adressen `https://www.youtube.com/tv#/search?q=…` er YouTubes søkeside for TV. Oppstart med `contentTarget` er bekreftet i homebridge-webos-tv for videoer. Åpner YouTube uten søket, er reserven å skrive med «Skriv på TV» i YouTubes søkefelt.
2. Det tomme feltet øverst på høye telefoner. Kandidat: «Nå spilles» (app og kanal fra TV-en).

| Før (brukerens telefon) | Etter | 123 | Mer | Kilde | Skriv og søk | Roku |
| --- | --- | --- | --- | --- | --- | --- |
| ![](docs/revisjon/runde4/00-for-telefon.jpg) | ![](docs/revisjon/runde4/01-lg-412x915.png) | ![](docs/revisjon/runde4/02-taster.png) | ![](docs/revisjon/runde4/03-mer.png) | ![](docs/revisjon/runde4/04-kilde.png) | ![](docs/revisjon/runde4/05-skriv-og-sok.png) | ![](docs/revisjon/runde4/07-roku.png) |
