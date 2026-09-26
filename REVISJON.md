# Revisjon av Fjern PWA

**Dato:** 2026-09-26
**Omfang:** `server.mjs`, `app.js`, `sw.js`, `index.html`, `style.css`, `manifest.webmanifest`, `README.md`, `icons/`
**Metode:** Manuell gjennomgang av all kode, pluss kjøring av broen lokalt (Node 22) med probing av HTTP-API-et. Gjennomgangen dekker sikkerhet, korrekthet, robusthet, PWA, tilgjengelighet og drift/vedlikehold.

> **Om pluginen everything-claude-code:** Den var ikke tilgjengelig i denne skyøkten (ingen plugins lastet, ingen av skillsene i listen). Revisjonen følger derfor de samme fagområdene (security review, code review, PWA/frontend, docs) manuelt. Installer pluginen i miljøet ditt eller i en lokal Claude Code-økt hvis du vil kjøre skillsene direkte.

---

## Sammendrag

| Alvorlighet | Antall | Kort |
| --- | --- | --- |
| 🔴 Kritisk | 2 | Appen starter ikke fra repoet (`public/` mangler). Broen kan krasje ved nettverksfeil under søk. |
| 🟠 Høy | 3 | Roku-knappene Spol/Pause virker ikke. Nyere LG-firmware bruker `wss://:3001`. Ingen `.gitignore` for LG-nøkler. |
| 🟡 Middels | 7 | Feilmeldinger på engelsk, polling i bakgrunnen, mute-tilstand går ut av synk, og mer. |
| 🔵 Lav | 8 | Manifest/meta, tilgjengelighet, kodestil, mangel på tester og CI. |

**Helhetsvurdering:** Arkitekturen er god og gjennomtenkt: en lokal bro på `127.0.0.1`, Host- og Origin-sjekk mot DNS-rebinding, IP-hviteliste til private nett, beskyttelse mot path traversal, begrenset størrelse på forespørsler, ingen eksterne avhengigheter, og DOM bygges med `textContent`, så det er ingen XSS. Hovedproblemene er **pakking og drift**: repoet slik det ligger kjører ikke. I tillegg finnes noen **protokollfeil** mot Roku og LG. Sikkerhetsnivået er godt for en app som bare kjører lokalt.

---

## 🔴 Kritisk

### K1. Serveren finner ikke filene. `/` gir 404.
`server.mjs:8` serverer fra `public/`, men `index.html`, `app.js`, `sw.js`, `style.css`, `manifest.webmanifest` og `icons/` ligger i rotmappen. README-en beskriver også `public/` og `Fjern-PWA.zip`, og ingen av dem finnes i repoet.

Verifisert:
```
$ PORT=8799 node server.mjs
$ curl -H "Host: localhost:8799" http://127.0.0.1:8799/   →  404
```
**Tiltak:** Flytt de statiske filene til `public/` med `git mv`, slik README-en beskriver. Å peke `publicDir` mot rotmappen er feil løsning, fordi den da også ville servert `server.mjs` og `data/lg-keys.json`.

### K2. Ubehandlet `error` på UDP-socket kan krasje broen
`server.mjs:48–63`: Lytteren for `error` fjernes etter `bind`. Hvis `sock.send()` feiler asynkront (Wi-Fi av, `ENETUNREACH`, `EADDRNOTAVAIL` på Android), sender socketen ut et `error`-event uten lytter, og **Node-prosessen avslutter**. Brukeren må da starte broen i Termux på nytt.
**Tiltak:** Legg på `sock.on('error', …)` for hele levetiden, gi `send` en callback, og lukk socketen i `finally`.

---

## 🟠 Høy

### H1. Roku: `Rewind`, `FastForward` og `Pause` er ikke gyldige ECP-taster
`server.mjs:128` sender tastenavnet uendret til `/keypress/{key}`. Roku ECP bruker `Rev`, `Fwd` og `Play`, der `Play` fungerer som play/pause. `Pause` finnes ikke.
**Tiltak:** Legg inn en mapping for Roku: `{Rewind:'Rev', FastForward:'Fwd', Pause:'Play', Mute:'VolumeMute'}`.

### H2. LG: Nyere firmware har stengt `ws://:3000`
`server.mjs:81` kobler bare til `ws://host:3000/`. LG-TV-er med oppdatert webOS (fra ca. 2023) krever `wss://host:3001` med et selvsignert sertifikat. Da får brukeren «Kunne ikke koble til LG TV» uten å få vite hvorfor. Nodes innebygde `WebSocket` kan ikke slå av sertifikatsjekk for én enkelt tilkobling.
**Tiltak:** Prøv `wss://:3001` først og fall tilbake til `ws://:3000`. Det krever enten `ws`-pakken med `rejectUnauthorized:false` (brudd med «ingen npm») eller en egen TLS-klient. Dokumenter begrensningen i README-en. *Dette må testes på en ekte TV.*

### H3. Ingen `.gitignore`, og paringsnøkler kan havne i git
`data/lg-keys.json` inneholder LG-klientnøkler, som gir full kontroll over TV-en. README-en advarer mot å publisere mappen, men ingenting hindrer det.
**Tiltak:** Legg til en `.gitignore` med `data/` og `node_modules/`, og skriv nøkkelfilen med `mode: 0o600`.

---

## 🟡 Middels

| # | Hvor | Funn | Tiltak |
| --- | --- | --- | --- |
| M1 | `server.mjs:156` | Interne feilmeldinger lekker til brukeren på engelsk, for eksempel `"The operation was aborted due to timeout"` og `"Expected property name…"` (verifisert). | Egne feilklasser for meldinger brukeren skal se. Map `AbortError`/`TimeoutError`/`SyntaxError` til norsk tekst, og logg resten. |
| M2 | `server.mjs:117` | LG Mute veksler en lokal boolsk verdi. Hvis noen demper med den vanlige fjernkontrollen, blir tilstanden feil. | Les `ssap://audio/getStatus` eller abonner på lydstatus, eller bruk `setMute` basert på faktisk tilstand. |
| M3 | `server.mjs:78–109` | LG-tilkoblingen har ingen timeout. Status blir stående på «Venter på paring» for alltid hvis TV-en ikke svarer. | Timeout på for eksempel 30 s, deretter en tydelig feilmelding. Vurder automatisk gjenoppkobling når pekeren lukkes. |
| M4 | `app.js:106` | `status()` spørres hvert 2,3 s også når appen ligger i bakgrunnen, og det tapper batteri. | Pause på `visibilitychange` og kjør `status()` umiddelbart når appen blir synlig igjen. |
| M5 | `server.mjs:137` | Roku-tekst sendes tegn for tegn, sekvensielt, med opptil 2,6 s timeout per tegn. 140 tegn kan ta flere minutter og blokkere forespørselen. | Kortere timeout per tegn, avbryt ved første feil, og vurder en lavere grense. |
| M6 | `server.mjs` generelt | Broen har ingen autentisering. Andre apper på samme telefon kan sende kommandoer til `127.0.0.1:8765`. Risikoen er lav, men reell på Android. | Valgfritt: token som genereres ved oppstart og settes i en `HttpOnly` SameSite-cookie når `index.html` leveres. |
| M7 | `app.js:4` | `localStorage.setItem` er ikke pakket i try/catch. Det kan kaste unntak i privat modus eller når lagringen er full. | Pakk inn i try/catch. |

---

## 🔵 Lav

1. **Krav til Node-versjon:** Den globale `WebSocket` krever Node ≥ 22. Dokumenter dette i README-en og sjekk versjonen ved oppstart.
2. **Manifest:** `"lang": "no"` bør være `"nb"`. Ikonene 48–384 mangler `purpose`, noe som er greit, men manifestet mangler `screenshots` og `categories` (Chrome viser et rikere installasjonsvindu med dem).
3. **Meta:** `apple-mobile-web-app-capable` er utdatert. Legg til `<meta name="mobile-web-app-capable" content="yes">`.
4. **Service worker:** Cachenavnet `fjern-pwa-v1` byttes aldri. Siden strategien er network-first, er det greit nå, men versjonen bør knyttes til releaser. Hvis `/` gir 404 (K1), feiler `install`, og appen blir ikke installerbar.
5. **Tastatur:** `Enter` på en fokusert knapp sender `Select` til TV-en i stedet for å trykke på knappen (`app.js:96–100`). Hopp over dette når `e.target` er en `button`.
6. **Race:** `connect()` ved oppstart og `status()`-polling går parallelt. Status kan kort vise gammel tilstand.
7. **Kodestil:** `server.mjs` og `app.js` er sterkt minifisert for hånd, med mange setninger per linje. Det gjør revisjon, diff og feilsøking vanskelig. Kjør Prettier eller skriv om til lesbar form.
8. **Kvalitetssikring:** Prosjektet har ingen `package.json`, tester, lint eller CI. Minimum er `node --check` og noen enhetstester med `node:test` for `validIp`, `validDevice`, path-sjekken og API-rutingen, i en GitHub Actions-jobb.

---

## Det som er bra ✅

- Binder kun til `127.0.0.1`, og Host- og Origin-sjekken blokkerer DNS-rebinding og CSRF fra nettsider.
- IP-hvitelisten (RFC 1918) begrenser SSRF til lokalnettet og faste porter.
- Beskyttelse mot path traversal med `path.resolve` og prefikssjekk.
- Forespørsler er begrenset til 16 KB, og kommandoer valideres mot en hviteliste.
- Frontenden bruker bare `textContent` og `createElement`, altså ingen `innerHTML`.
- Bekreftelsesdialog før strøm av, og god norsk mikrotekst i grensesnittet.
- `generation`-telleren håndterer at en ny tilkobling erstatter en gammel på en ryddig måte.

---

## Anbefalt rekkefølge (plan)

1. **Fase 1 – Få det til å kjøre:** K1 (flytt til `public/`), H3 (`.gitignore`), oppdater README-en.
2. **Fase 2 – Robusthet:** K2, M1, M3, M7.
3. **Fase 3 – Protokollkorrekthet:** H1 (Roku-mapping), M2, M5. Test på ekte TV.
4. **Fase 4 – LG-kompatibilitet:** H2 (`wss://:3001`). Krever en beslutning om npm-avhengighet.
5. **Fase 5 – Kvalitet:** Formatering, `package.json`, `node:test`, CI, pluss M4, M6 og funn på lav nivå.
