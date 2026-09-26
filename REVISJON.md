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

---

## Runde 5 (v2.5.0): kompakt, én spill/pause-knapp og ECC-agenter

**Brukerens ønsker:** én knapp for spill av og pause, en mer kompakt app og ikke noe «AI-design».

### Endringer
- **Én ⏯-knapp:** På LG spør broen TV-en om avspillingsstatus (`com.webos.media/getForegroundAppInfo`) og sender pause eller play etter det. Svarer ikke TV-en, veksler den lokalt. Roku har én play/pause-tast. Mellomrom og `k` på tastatur virker også.
- **Kompakt:** Alt er samlet i én blokk ved tommelen. Snarveier og knappegrupper har ikon og tekst på samme linje (40–48 px). Den synlige «Favoritter»-overskriften er fjernet, fordi ikonene sier det selv. Topplinjen er 56 px, og avspillingslinjen har tre knapper.
- **AI-mønstre** (ECC `design-system`): ingen gradienter, ingen «eyebrows» eller slagord, ingen kort i kort og ingen dekorative piler. Farger brukes bare der de betyr noe: OK, fargetastene og appikonene.

### ECC brukt i denne runden

| ECC | Funn | Tiltak |
| --- | --- | --- |
| `click-path-audit` (skill) | Gikk gjennom alle knapper: favoritter, stjerne, nytt navn, søk, skriv, kilde, strøm, par på nytt, ⏯. Funn: mellomrom på en fokusert knapp ville sendt ⏯ **i tillegg** til knappens egen handling. | Mellomrom og Enter på fokuserte knapper går bare til knappen. |
| `kotlin-reviewer` (agent) | **HIGH:** `catch (e: Throwable/Exception)` og `runCatching` i `suspend`-kode fanget opp `CancellationException`, så coroutines ikke kunne avbrytes (Bridge, LgSession). **MEDIUM:** `!!` i `Validate.device`. | `rethrowCancellation()` i alle catch-blokker. Våre egne `withTimeout` håndteres fortsatt som vanlige tidsavbrudd. Null-sjekk i stedet for `!!`. |
| `silent-failure-hunter` (agent) | Et ikon som ikke kunne hentes, ga 404 i appen uten spor. | Årsaken skrives i feilsøkingsloggen. |

### Verifisering
- `npm run verify`: **73/73**. Nye tester: ⏯ følger TV-ens status (spiller → pause, pauset → play), og veksler lokalt når TV-en ikke svarer. Roku: ⏯ → `Play`.
- `./gradlew testDebugUnitTest assembleRelease`: **15/15**, APK 2.5.0.
- Chromium, 412×915 og 360×800: ingen rulling, ingen kuttede etiketter, ingen konsollfeil.

| 412×915 | 360×800 |
| --- | --- |
| ![](docs/revisjon/runde5/01-lg-412x915.png) | ![](docs/revisjon/runde5/06-lg-360x800.png) |

---

## Runde 6 (v2.6.0): YouTube-modus som caster

**Brukerens tilbakemelding:** ⏯ virker. «Søk på YouTube» virket ikke. Adressen `youtube.com/tv#/search?q=` åpner ikke søket på LG. Brukeren ønsket YouTube-modusen fra før tilbake: søk på mobilen, se resultatene der, og spill valgt video på TV-en.

### Endringer
- **Søk på mobilen:** Broen leser YouTubes offentlige søkeside (`ytInitialData`) uten API-nøkkel, med tak på sidestørrelse (4 MB) og antall treff (20). Den sender informasjonskapselen `SOCS` for å hoppe over samtykkesiden i EØS. Resultatene har tittel, kanal, lengde («Direkte» for strømmer) og visninger.
- **Miniatyrbilder** leveres gjennom broen (`/api/ytthumb/<id>`). Video-id-en valideres (`^[\w-]{11}$`), og bare ekte bilder godtas. CSP-en `img-src 'self'` er beholdt.
- **Spill på TV-en:**
  - LG: `system.launcher/launch` med `youtube.leanback.v4` og `contentTarget: https://www.youtube.com/tv?v=<id>`, samme metode som homebridge-webos-tv.
  - Roku: `launch/837?contentID=<id>`.
- Det gamle søket (`#/search?q=` og Roku `search/browse`) er fjernet.

### Verifisering
- `npm run verify`: **78/78**. Nye tester dekker tolking av søkesiden (også direkte, ugyldige id-er og tak), hoder og koding av søket, feil uten nett, validering av video-id og avspilling på LG og Roku.
- Kotlin: **15/15**. I tillegg ble Kotlin-tolkingen kjørt mot den ekte YouTube-siden. Den ga de samme 19 treffene som Node.
- Mot ekte YouTube fra broen: søk etter «lofi hip hop» og «nrk nyheter» ga riktige resultater og miniatyrbilder.
- Chromium: søk → 19 treff med bilder → trykk → `ytplay` sendes, arket lukkes, og «Spilles på TV-en» vises.

![](docs/revisjon/runde6/01-youtube-resultater.png)

---

## Runde 7 (v2.7.0): YouTube som egen, tydelig funksjon

**Brukerens tilbakemelding:** YouTube-modusen virker veldig bra, men den er gjemt bak tastaturknappen. Andre brukere forstår den ikke.

**Designprinsipp** (ECC `frontend-design-direction`): én knapp skal ha én jobb, og det viktigste skal være synlig uten forklaring. Mønsteret følger fjernkontroll-appene for Google TV og Roku.

| Før | Etter |
| --- | --- |
| YouTube-søket lå bak ⌨, i samme ark som «skriv tekst på TV» | Et **søkefelt «Søk på YouTube»** øverst på forsiden. Det bruker plassen som før sto tom |
| Resultatene i et ark som gled opp | **Eget YouTube-skjermbilde** med tilbakeknapp. Android-tilbakeknappen lukker det |
| Ingen oversikt over hva som spilles | **«Spilles nå»** med miniatyrbilde, tittel, ⏯ og skjul, både på forsiden og i YouTube-visningen |
| – | **Siste søk** som knapper (maks 8, uten duplikater, kan tømmes) |
| – | **🎤 Talesøk:** Android bruker `RecognizerIntent` (nb-NO) uten mikrofontillatelse, siden Google-appen tar lyden. Nettversjonen bruker Chromes talegjenkjenning |
| ⌨ hadde to jobber | ⌨ gjør bare **«Skriv på TV»**, for eksempel passord og Wi‑Fi-navn |
| – | **Engangshint** når YouTube åpnes fra favorittene: «Søk enklere fra mobilen» |

### Verifisering
- `npm run verify`: **79/79**. Ny test for siste søk: rekkefølge, duplikater, tak og ødelagt lagring.
- Kotlin **15/15**, APK 2.7.0. `<queries>` for `RECOGNIZE_SPEECH` er bekreftet i manifestet i APK-en.
- Chromium, 412×915 og 360×800:
  - søkefelt → YouTube → siste søk → resultater → spill → «Spilles nå» → talesøk («nrk nyheter») → tilbake → ⏯ fra forsiden
  - ingen rulling og ingen konsollfeil

| Forside | YouTube | Spilles nå |
| --- | --- | --- |
| ![](docs/revisjon/runde7/01-forside.png) | ![](docs/revisjon/runde7/03-youtube-resultater.png) | ![](docs/revisjon/runde7/04-forside-spilles-na.png) |

---

## Runde 8 (v2.8.0): Designrevisjon – hierarki, trykkflater og finish

**Utløser:** Designrevisjon av `public/` (index.html, style.css, app.js). Skår før: **7 / 10**. Brukeren godkjente planen og ba om at alle forslagene ble bygget.

**Metode:** Designprinsippene fra `frontend-design` / `design-superpowers` (hierarki, tokens, tilstander, trykkflater, rytme, identitet), anvendt manuelt fordi ECC-pluginen ikke var installert i økten. Alt er målt i Chromium med falske API-svar på 320×568, 360×640, 390×844 og 412×915.

### Funn og utbedring

| # | Funn | Alvor | Utbedring |
| --- | --- | --- | --- |
| 1 | Trykk og «sendt»-ramme på styrekorset ble firkanter inne i den runde platen, og rammen gikk over OK | 🔴 | Hver retning er en kakebit (`clip-path`) med treffflate som følger formen. Tilbakemeldingen er en farget bit, ikke en ramme. Tynne diagonaler viser inndelingen |
| 2 | Omtrent 220 px tomrom midt på skjermen | 🟠 | Mellomrom og knapper vokser med skjermhøyden (med tak). **Siste søk** vises som knapper under søkefeltet på høye skjermer. Tomrommet er omtrent halvert, og blokkene henger sammen |
| 3 | Fem like tunge bånd uten hierarki | 🟠 | Tydelig rekkefølge fra lett til tung: verktøylinje uten flate → **styrekors** → Tilbake/Hjem/Lyd av (hevet, flyttet under styrekorset som på en fysisk fjernkontroll) → avspilling (rolig flate) |
| 4 | Trykkflater på 40 px og etiketter på 11 px | 🟠 | Alt er minst 44 px (`--tap`), og alle etiketter er minst 12 px |
| 5 | To kantspråk (`--edge` og tunge `--line`) | 🟡 | `--line` brukes bare for inndatafelt (WCAG 1.4.11). Alt annet bruker `--edge`, `--hairline` og `--bevel` |
| 6 | ⌨ i toppen og «Søk på YouTube» lignet hverandre | 🟡 | «Skriv på TV» er flyttet inn i **Mer**. Toppen har bare TV-valg og strøm |
| 7 | Strøm så ut som en vanlig knapp | 🟡 | Rød tone og egen kant |
| 8 | Kanalpilene var like styrekorsets | 🟡 | Kanal har fylte trekanter (▲▼), og etikettene «VOL» og «CH» står tydeligere |
| 9 | Lite identitet, IP-adresse i toppen, og reserveikonet for YouTube var bare «Y» | 🔵 | Skriften **Manrope** (variabel, lokal, 25 kB, OFL). Toppen viser TV-type i stedet for IP. Reserveikoner har merkefarge og kortnavn (YT, NRK, TV2, D+ …), testet til minst 4,5:1 mot hvit |
| 10 | Ark uten håndtak og uten lukke-animasjon, og aksentfargen var brukt overalt | 🔵 | Arkene har dra-håndtak og kan dras ned, lukkes med trykk utenfor, og glir ned (Escape og Android-tilbake inkludert). Aksenten brukes bare til OK og primærknapper. «Opptatt» er gul, valgt TV og «Spilles nå» er grønne, og fokusringen er hvit |
| 11 | Skjermbildene i manifestet var utdatert | 🔵 | `public/screenshots/` er tatt på nytt fra 2.8.0 |

### Verifisering
- `npm run verify`: **80/80**. Ny test for reserveikoner: kortnavn, merkefarge, TV-ens egen farge vinner, og kontrast på minst 4,5:1 for alle merkene.
- Chromium, automatisert:
  - trykk på → høyre gir en farget bit
  - midten treffer OK
  - arket er fortsatt åpent 40 ms etter lukk (animasjonen) og er lukket etterpå
  - Escape, trykk utenfor, lang dragning og `__fjernBack` lukker. Kort dragning og trykk inne i arket lukker ikke
  - «Skriv på TV» fra Mer bytter ark
  - Siste søk åpner YouTube med søket
  - alt det samme med `prefers-reduced-motion`, da uten animasjon
- Ingen rulling på 320×568, 360×640, 390×844 og 412×915, også med lange søk. Ingen konsollfeil.
- Broen leverer `font/woff2`, og service workeren forhåndslagrer skriften.
- Ikke verifisert: APK-bygg og test på fysisk telefon og TV.

**Skår etter: 8,5 / 10.** Det som gjenstår: Etiketter kuttes på 320 px («Opps…», «Alle ap…»), og tomrommet på høye skjermer er mindre, men finnes fortsatt når det ikke er siste søk eller noe som spilles.

| Før (390×844) | Etter (390×844) | Etter, siste søk (412×915) |
| --- | --- | --- |
| ![](docs/revisjon/runde8/01-for-390.png) | ![](docs/revisjon/runde8/02-etter-390.png) | ![](docs/revisjon/runde8/03-etter-412-siste-sok.png) |

| Styrekors før | Styrekors etter |
| --- | --- |
| ![](docs/revisjon/runde8/04-styrekors-for.png) | ![](docs/revisjon/runde8/05-styrekors-etter.png) |

| Mer | TV-er | 320×568 |
| --- | --- | --- |
| ![](docs/revisjon/runde8/06-mer.png) | ![](docs/revisjon/runde8/07-tv-er.png) | ![](docs/revisjon/runde8/08-etter-320.png) |
