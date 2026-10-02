# Fjern

Fjernkontroll for **Roku**, **LG webOS**, **Samsung** (Tizen) og **Android TV / Google TV** (for eksempel Telia-boksen) som kjører på din egen Android-telefon. Appen er en installerbar PWA, og en liten lokal bro i Node sender kommandoene til TV-en over Wi‑Fi. Ingen konto, sky eller npm-pakker.

## Installer på Android (APK, anbefalt)

Android-appen har broen innebygd, så du trenger verken Termux eller Node.

1. Last ned `Fjern-<versjon>.apk` til telefonen. Nyeste bygg ligger under **Actions → CI → siste kjøring → Artifacts** på GitHub.
2. Åpne filen. Android spør første gang om du vil tillate installasjon fra denne kilden (for eksempel Chrome eller Filer). Tillat, og trykk **Installer**.
3. Åpne **Fjern**. Telefon og TV må være på samme Wi‑Fi. Trykk **Søk etter TV**, eller legg til TV-en med IP-adresse.

Krever Android 8.0 eller nyere. Nye versjoner installeres over den gamle, og lagrede TV-er og paringer beholdes.

## Installer som PWA (med Termux)

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
- **YouTube:** trykk på «Søk på YouTube» øverst (eller 🎤 for talesøk), og se resultatene med bilder på mobilen. Treffene og forslag til søkeord kommer mens du skriver, uten å trykke Søk. Trykk på en video, så spilles den på TV-en, og «Spilles nå» viser hva som går. Søket leser YouTubes offentlige søkeside gjennom broen, og forslagene kommer fra Googles forslagstjeneste. Ingen konto eller API-nøkkel trengs. Talesøk bruker telefonens egen talegjenkjenning i Android-appen, og Chromes i nettversjonen.
- **Skriv på TV** (under **Mer**): skriv i tekstfeltet som er åpent på TV-en, for eksempel et passord, og slett tegn eller trykk Enter.
- **Automatisk gjenoppkobling** for LG når forbindelsen faller ut, og helsesjekk for Roku.

## Krav

| | |
| --- | --- |
| Node | 20 eller nyere |
| Roku | *Settings → System → Advanced system settings → Control by mobile apps* må være på |
| LG webOS | Godkjenn paringen på TV-en første gang. Strøm på via nettverket støttes ikke |
| Android TV / Google TV | For eksempel Telia-boksen. Første gang viser TV-en en sekstegnskode som du skriver inn i appen. Etter det kobler appen til uten kode |
| Samsung | Tizen, modeller fra 2016 og nyere. Trykk **Tillat** når TV-en spør første gang. Har du trykket **Avvis**: *Innstillinger → Generelt → Ekstern enhetsbehandling → Enhetstilkoblingsbehandling*. «Slå på» krever *Slå på med mobil* (*Innstillinger → Generelt → Nettverk → Ekspertinnstillinger*) |

Eldre Samsung-modeller (før 2016), Apple TV og rene IR-TV-er støttes ikke. Sony og Philips med Android TV / Google TV styres som Android TV.

På Samsung finnes ikke appikoner over nettet, så appene vises med merkefarge og kortnavn. Innganger er kildemenyen og HDMI 1–4.

På Android TV har protokollen ingen appliste. Appen viser snarveier til vanlige strømmetjenester med egne ikoner: Telia Play, NRK TV, TV 2 Play, Netflix, YouTube, Disney+, HBO Max, Prime Video, Viaplay, Spotify og Apple TV. Protokollen (den samme som Google TV-appen bruker) har ingen «start app»-kommando, bare lenker. Hver app har derfor flere lenker, som prøves i denne rekkefølgen:

1. appens egen lenke, for eksempel `nrktv://` eller nettadressen
2. en intent-lenke som starter TV-appen ut fra pakkenavnet
3. `market://launch?id=<pakke>`

**Lenker:**
- **Boksen melder hvilken app som er åpen:** Fjern ser selv om appen startet, og prøver neste lenke hvis den ikke gjorde det.
- **Boksen melder det ikke:** Fjern går videre når boksen avviser en lenke eller kobler fra. Startet appen likevel ikke, trykker du «Prøv en annen måte» i varselet.
- Lenken som virket, lagres per boks (`data/androidtv-apps.json`, eller i appens private lagring på Android). Neste gang åpnes appen med en gang.

**Automatisk læring:** Åpner du en app på TV-en med boksens egen fjernkontroll, og boksen melder det, legges appen til i «Alle apper». Slik lærer Fjern hvilke apper som er installert på boksen. Startskjerm, innstillinger og andre systemapper tas ikke med. «Skriv på TV» virker når skjermtastaturet er åpent på boksen, og «Slå på» bare mens appen er koblet til (boksen i hvilemodus).

## Hvorfor en lokal bro?

En nettleser kan ikke sende SSDP-søk (UDP) eller åpne ukrypterte forbindelser til TV-er på lokalnettet fra en HTTPS-side. Broen gjør det for appen, og appen lastes fra `localhost`, som nettleseren regner som en sikker opprinnelse.

## Skrift

Grensesnittet bruker [Manrope](https://github.com/sharanda/manrope), som ligger lokalt i `public/fonts/` (SIL Open Font License 1.1, se `public/fonts/OFL.txt`). Appen henter ingenting fra nettet.

## Sikkerhet

- Broen lytter bare på `127.0.0.1` og godtar bare forespørsler med egen `Host` og `Origin`. Det stopper DNS-rebinding og forespørsler fra andre nettsider.
- Den snakker bare med private IPv4-adresser (10/8, 172.16/12, 192.168/16), og bare med kommandoer fra en fast liste.
- Streng `Content-Security-Policy` og andre sikkerhetshoder på alle svar.
- LG-paringsnøkler og Samsung-tokens lagres i `data/lg-keys.json` med tilgang bare for eieren (0600). Mappen er utelatt fra git.
- Android TV: appen lager sitt eget klientsertifikat (RSA 2048, selvsignert) første gang, lagret i `data/androidtv-client.json` (0600) eller i appens private lagring på Android. Boksen husker sertifikatet etter paring med kode. Boksens eget sertifikat låses ved første tilkobling på samme måte som for LG og Samsung.
- LG webOS med nyere firmware bruker `wss://` på port 3001 med et selvsignert sertifikat. Sertifikatets avtrykk **låses ved første paring** (trust on first use). Endres det senere, stopper broen tilkoblingen og ber deg pare på nytt, og en låst TV nedgraderes aldri til ukryptert `ws://`. Eldre modeller uten `wss://` bruker `ws://` på port 3000.
- Samsung bruker samme prinsipp: `wss://` på port 8002 med token og låst sertifikat for TV-er som krever token (de fleste fra 2018), ellers `ws://` på port 8001. Tokenet sendes aldri over ukryptert forbindelse.
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
| `lib/` | Roku (ECP), LG (SSAP), Samsung (Tizen-fjernkontroll), Android TV (Remote v2 med protobuf og eget sertifikat), SSDP- og mDNS-søk, WebSocket-klient, validering og feilmeldinger |
| `public/` | Grensesnittet: HTML, CSS, JS, service worker, manifest og ikoner. Brukes av både PWA og APK |
| `android/` | Android-appen: WebView med grensesnittet og broen skrevet i Kotlin (`app/src/main/java/no/fjern/app/`) |
| `tests/` | Enhets- og integrasjonstester |
| `docs/revisjon/` | Tidligere revisjon og skjermbilder fra hver runde |

Bygg APK lokalt (krever JDK 17 og Android SDK):

```sh
cd android
./gradlew testDebugUnitTest assembleRelease   # APK: app/build/outputs/apk/release/app-release.apk
```

APK-en signeres med debug-nøkkelen i `android/app/debug.keystore`. Den er offentlig etter Android-konvensjon, og gjør at alle bygg kan installeres over hverandre. For distribusjon utenfor egen telefon: legg en egen nøkkel i repo-hemmelighetene `FJERN_KEYSTORE_BASE64`, `FJERN_KEYSTORE_PASSWORD`, `FJERN_KEY_ALIAS` og `FJERN_KEY_PASSWORD`, så bruker CI den. Byttes nøkkelen, må appen avinstalleres én gang.

API-et (`/api/status`, `/api/scan`, `/api/connect`, `/api/command`, `/api/text`) er bare ment for appen selv.

Endrer du filer i `public/`, øk `version` i `package.json` og `CACHE` i `public/sw.js` til samme verdi. En test feiler hvis de ikke stemmer overens.

**Oppgradering fra 2.0:** LG-TV-er kan be om godkjenning én gang til, fordi appen nå ber om tilgang til applisten og nettverksinformasjon (for «Slå på»).
