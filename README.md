# Fjern

Fjernkontroll for **Roku** og **LG webOS** som kjører på din egen Android-telefon. Appen er en installerbar PWA, og en liten lokal bro i Node sender kommandoene til TV-en over Wi‑Fi. Ingen konto, sky eller npm-pakker.

## Installer på Android

1. Installer [Termux fra F-Droid](https://f-droid.org/packages/com.termux/) og åpne den.
2. Kjør, én linje om gangen:

   ```sh
   pkg update
   pkg install nodejs git
   git clone https://github.com/kkas18/Fjernkontroll.git ~/fjern
   cd ~/fjern
   npm start
   ```

   Er repoet privat, kan du i stedet laste ned ZIP fra GitHub (**Code → Download ZIP**) og pakke den ut med `unzip -o ~/storage/downloads/Fjernkontroll-main.zip -d ~` etter `termux-setup-storage`.

3. Åpne **Chrome** på `http://localhost:8765`, trykk **⋮ → Installer app**.
4. Telefon og TV må være på samme Wi‑Fi. Trykk **Søk etter TV**, eller legg til TV-en med IP-adresse.

Neste gang: åpne Termux, kjør `cd ~/fjern && npm start`, og start Fjern fra hjemskjermen. Tillat Termux å kjøre i bakgrunnen i Androids batteriinnstillinger, ellers kan broen bli stoppet.

Oppdater med `cd ~/fjern && git pull`.

## Funksjoner

- Navigasjon, OK, Hjem, Tilbake, volum, kanal (skjules på Roku-spillere uten TV), lyd av og avspilling. Hold inne piler og volum for å gjenta.
- **Apper:** snarveier til appene på TV-en, hentet direkte fra TV-en.
- **Slå på og av:** Roku-TV-er slås på med `PowerOn`. LG slås på med Wake-on-LAN når TV-en har vært tilkoblet én gang og **Slå på via Wi‑Fi** er aktivert på TV-en (ofte under *Mobil TV på*; plasseringen varierer per modell).
- **Tekst:** send tekst til et aktivt tekstfelt, og slett tegn.
- **Automatisk gjenoppkobling** for LG når forbindelsen faller ut, og helsesjekk for Roku.

## Krav

| | |
| --- | --- |
| Node | 20 eller nyere |
| Roku | *Settings → System → Advanced system settings → Control by mobile apps* må være på |
| LG webOS | Godkjenn paringen på TV-en første gang. Strøm på via nettverket støttes ikke |

Samsung, Google TV, Sony og rene IR-TV-er støttes ikke.

## Hvorfor en lokal bro?

En nettleser kan ikke sende SSDP-søk (UDP) eller åpne ukrypterte forbindelser til TV-er på lokalnettet fra en HTTPS-side. Broen gjør det for appen, og appen lastes fra `localhost`, som nettleseren regner som en sikker opprinnelse.

## Sikkerhet

- Broen lytter bare på `127.0.0.1` og godtar bare forespørsler med egen `Host` og `Origin`. Det stopper DNS-rebinding og forespørsler fra andre nettsider.
- Den snakker bare med private IPv4-adresser (10/8, 172.16/12, 192.168/16), og bare med kommandoer fra en fast liste.
- Streng `Content-Security-Policy` og andre sikkerhetshoder på alle svar.
- LG-paringsnøkler lagres i `data/lg-keys.json` med tilgang bare for eieren (0600). Mappen er utelatt fra git.
- LG webOS med nyere firmware bruker `wss://` på port 3001 med et selvsignert sertifikat. Sertifikatets avtrykk **låses ved første paring** (trust on first use). Endres det senere, stopper broen tilkoblingen og ber deg pare på nytt, og en låst TV nedgraderes aldri til ukryptert `ws://`. Eldre modeller uten `wss://` bruker `ws://` på port 3000.
- Svar fra lokalnettet har tak: maks 32 enheter per søk og 64 KB per svar fra en Roku.
- Andre apper på samme telefon kan nå `127.0.0.1:8765`. Det kan ikke løses uten innlogging, og er en akseptert risiko for en app som bare styrer TV-en.

## Utvikling

```sh
npm start        # start broen på http://localhost:8765
npm test         # tester med node:test
npm run verify   # syntakssjekk + tester (kjøres også i CI)
```

| Mappe | Innhold |
| --- | --- |
| `server.mjs` | HTTP-broen: statiske filer, API og sikkerhetshoder |
| `lib/` | Roku (ECP), LG (SSAP), SSDP-søk, WebSocket-klient, validering og feilmeldinger |
| `public/` | PWA-en: HTML, CSS, JS, service worker, manifest og ikoner |
| `tests/` | Enhets- og integrasjonstester |
| `docs/revisjon/` | Tidligere revisjon og skjermbilder fra hver runde |

API-et (`/api/status`, `/api/scan`, `/api/connect`, `/api/command`, `/api/text`) er bare ment for appen selv.

Endrer du filer i `public/`, øk `version` i `package.json` og `CACHE` i `public/sw.js` til samme verdi. En test feiler hvis de ikke stemmer overens.

**Oppgradering fra 2.0:** LG-TV-er kan be om godkjenning én gang til, fordi appen nå ber om tilgang til applisten og nettverksinformasjon (for «Slå på»).
